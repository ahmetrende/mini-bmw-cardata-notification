#!/usr/bin/env node
// Listens to the BMW/MINI CarData stream. Sends a phone notification through ntfy (default) or Pushover
// (notify_service) when a door, window, sunroof, trunk or hood stays open after you park.
//
//   node mini_watch.mjs login             # once: get a device code, approve it in the browser
//   node mini_watch.mjs run               # listen to the stream (runs forever)
//   node mini_watch.mjs ntfy-test         # send a test notification to the phone
//   node mini_watch.mjs ntfy-check <id>   # ask ntfy if its cache still has the message with this id. Sends nothing.
//   node mini_watch.mjs pushover-test     # send a test notification through Pushover, also when notify_service is "ntfy"
//   node mini_watch.mjs doctor [--offline] # check the settings, files and connections. Sends nothing.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import mqtt from 'mqtt';

const HERE = dirname(fileURLToPath(import.meta.url));
// Settings and data. The systemd service sets STATE_DIRECTORY (/var/lib/mini-watch).
// The "mini-watch" command sets MINI_WATCH_DATA. Without both, the files are next to this program.
const DATA_DIR = process.env.MINI_WATCH_DATA || process.env.STATE_DIRECTORY || HERE;
const CONFIG = join(DATA_DIR, 'config.json');
const TOKENS = join(DATA_DIR, 'tokens.json');
const MESSAGES = join(DATA_DIR, 'messages.jsonl');
const STATE = join(DATA_DIR, 'state.json'); // Open parts and notification memory. A restart must not repeat an alert.

const OAUTH = 'https://customer.bmwgroup.com/gcdm/oauth';
// BMW's integration guide asks for both CarData scopes. The program uses only the stream.
// A login with only the stream scope is not tested.
const SCOPE = 'authenticate_user openid cardata:streaming:read cardata:api:read';
const MQTT_HOST = 'customer.streaming-cardata.bmwgroup.com';
const MQTT_PORT = 9000;
const TOKEN_MARGIN_S = 300; // Refresh the token 5 minutes before it expires.
const HEALTHY_CONNECTION_S = 120;
const RECONNECT_MIN_S = 5;
const RECONNECT_MAX_S = 60;
const REPLAY_HOURS = 24;
const HTTP_TIMEOUT_MS = 15_000;
const MAX_HTTP_BODY_BYTES = 64 * 1024;
const MAX_PAYLOAD_BYTES = 64 * 1024; // A stream message has about 300 bytes. A larger one is not stored.
const HISTORY_MAX_BYTES = 10 * 1024 * 1024; // At this size messages.jsonl becomes messages.jsonl.1. Two files at most.
// After a failed notification, the base wait is 30 seconds. It doubles with each failure in a row
// (30, 60, 120, 240, 480 seconds) and stops at NOTIFY_RETRY_MAX_S (10 minutes). notifyResult multiplies
// it by a random factor from 0.8 to 1.2, so the longest wait is about 12 minutes.
const NOTIFY_RETRY_MIN_S = 30;
// The longest base wait. The notification about missing car data (silence) waits this fixed time after a failure.
const NOTIFY_RETRY_MAX_S = 600;
const STATE_VERSION = 2;
const SAVE_EVERY_S = 60; // Save the open parts at most once a minute. Save at once after a notification.
const PROGRESS_LIMIT_S = 600; // The watchdog ping stops when the main loop did not run for 10 minutes.
const EXAMPLE_TOPIC = 'mini-your-long-random-name'; // The example topic of older versions. Everybody knows it.
const MIN_TOPIC_LENGTH = 16;
// The notification services. One of them sends all notifications (notify_service). ntfy is the default.
const NOTIFY_SERVICES = ['ntfy', 'pushover'];
// Pushover. The addresses are fixed: they are not settings. A token and a user key have 30 letters and digits.
const PUSHOVER_MESSAGES_URL = 'https://api.pushover.net/1/messages.json';
const PUSHOVER_VALIDATE_URL = 'https://api.pushover.net/1/users/validate.json';
const PUSHOVER_KEY = /^[A-Za-z0-9]{30}$/;
// A request id that the log can show. Another value shows as "(not printable)": an answer can contain an address.
const PUSHOVER_REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;
const PUSHOVER_TITLE_MAX = 250; // characters
const PUSHOVER_MESSAGE_MAX = 1024; // characters

// Attributes that carry an open or closed state. The charge flap, the trunk lock and the
// door lock (vehicle.cabin.door.status) are not included.
const WATCHED = [
  /^vehicle\.cabin\.window\.row\d\.(driver|passenger)\.status$/,
  /^vehicle\.cabin\.door\.row\d\.(driver|passenger)\.isOpen$/,
  /^vehicle\.cabin\.sunroof\.(status|tiltStatus)$/,
  /^vehicle\.body\.trunk\.(isOpen|door\.isOpen)$/,
  /^vehicle\.body\.hood\.isOpen$/,
];
const OPEN_VALUES = new Set(['OPEN', 'INTERMEDIATE', 'TRUE']);
// Only these values close a part. An unknown or empty value keeps the last known state.
const CLOSED_VALUES = new Set(['CLOSED', 'FALSE']);
const IGNITION = 'vehicle.drivetrain.engine.isIgnitionOn';
const MOVING = 'vehicle.isMoving';
const ODOMETER = 'vehicle.vehicle.travelledDistance';
const DRIVER_DOOR = 'vehicle.cabin.door.row1.driver.isOpen';
const ANY_DOOR = /^vehicle\.cabin\.door\.row\d\.(driver|passenger)\.isOpen$/;
// Central lock. The tested car (U25) sends UNLOCKED, LOCKED (the car locks itself when it starts to
// drive) and SECURED (locked from outside with the key or the app).
const LOCK = 'vehicle.cabin.door.status';
const DRIVING_STALE_S = 2 * 3600;
// The lock time is the start of the park only when the lock came soon after the driver got out.
// A lock hours later (for example with the app) does not move the time in the text.
const PARK_LOCK_WINDOW_S = 600;
// Back at the car without a drive, then a new lock: wait until the car stays locked for 2 minutes.
// A walk around the car with many locks and unlocks gives one notification, not one for each lock.
const RELOCK_WAIT_S = 120;
// A lock confirmation ("locked, everything is closed") only comes within 10 minutes of the lock.
// A later check, for example after a restart, does not send an old confirmation.
const CONFIRM_WINDOW_S = 600;
// "Everything is closed" waits until every part stays closed for this time. While you unload the car, the doors
// open one after the other. A check between two doors must not send the message too early.
const CLOSED_SETTLE_S = 15;
// The length of the last drive: from the moment the car locks itself (LOCKED) to the unlock at the end.
// The LOCKED state must start at most 20 minutes before the first odometer value of the drive.
// A stop shorter than 10 minutes belongs to the same drive.
const TRIP_START_WINDOW_S = 1200;
const TRIP_GAP_S = 600;
const MAX_TRIP_S = 12 * 3600;
// Battery level (percent) and range. The first attribute that the car sends is used.
const PERCENT_ATTRS = ['vehicle.powertrain.electric.battery.stateOfCharge.displayed', 'vehicle.drivetrain.batteryManagement.header'];
const RANGE_ATTRS = [
  'vehicle.drivetrain.electricEngine.kombiRemainingElectricRange',
  'vehicle.drivetrain.electricEngine.remainingElectricRange',
  'vehicle.drivetrain.lastRemainingRange',
];
const MILE_IN_KM = 1.609344;
// Charging. The plug (CONNECTED / DISCONNECTED) and the charging status of the car.
const CHARGING_PORT = 'vehicle.body.chargingPort.status';
const CHARGING_STATUS = 'vehicle.drivetrain.electricEngine.charging.status';
const CHARGE_KINDS = { CHARGINGACTIVE: 'active', INITIALIZATION: 'starting', CHARGINGPAUSED: 'paused', CHARGINGENDED: 'ended', CHARGINGERROR: 'error' };
// While the car prepares to charge (plug connected, status INITIALIZATION), a notification with details waits for the
// result. At most this long from the first time it was due. Then it shows the status of that moment.
const CHARGE_WAIT_S = 30;

// Text that the user sees on the phone. Log lines are always in English.
const TEXT = {
  en: {
    positions: { 'row1.driver': 'front left', 'row1.passenger': 'front right', 'row2.driver': 'rear left', 'row2.passenger': 'rear right' },
    window: 'window',
    door: 'door',
    windows: 'windows',
    doors: 'doors',
    allWindows: 'all windows',
    allDoors: 'all doors',
    rowPair: { row1: 'left and right front', row2: 'left and right rear' },
    windowStates: { full: 'fully open', partial: 'partly open' },
    sunroof: 'sunroof',
    sunroofTilt: 'sunroof (tilted)',
    trunk: 'trunk',
    hood: 'hood',
    // The title tells the lock state: locked, known but not locked, or no lock data.
    openTitle: { locked: 'MINI locked, but a part is open', unlocked: 'MINI not locked, a part is open', unknown: 'MINI: a part is open' },
    stillOpenTitle: {
      locked: 'MINI locked, but a part is still open',
      unlocked: 'MINI not locked, a part is still open',
      unknown: 'MINI: a part is still open',
    },
    since: (time) => `since ${time}`,
    and: 'and',
    openBody: (items) => upperFirst(items, 'en'),
    closedTitle: 'MINI',
    closedBody: 'Everything is closed.',
    lockedTitle: 'MINI locked',
    lockedBody: 'Everything is closed.',
    trip: (duration) => `drive ${duration}`,
    duration: (hours, minutes) => (hours ? `${hours} h ${minutes} min` : `${minutes} min`),
    battery: (percent) => `battery ${percent}%`,
    range: (km) => `range ${km} km`,
    percentOf: (percent) => `${percent}%`,
    charge: {
      active: 'charging',
      starting: 'charging is starting',
      paused: 'charging paused',
      ended: 'charging ended',
      error: 'charging error',
      idle: 'plugged in but not charging',
    },
    silenceTitle: 'MINI no data',
    silenceBody: (hours) => `No data from the car for ${hours} hours. Check the server and the CarData portal.`,
    testTitle: 'MINI test',
    testBody: 'Notifications work.',
  },
  tr: {
    positions: { 'row1.driver': 'sol ön', 'row1.passenger': 'sağ ön', 'row2.driver': 'sol arka', 'row2.passenger': 'sağ arka' },
    window: 'cam',
    door: 'kapı',
    windows: 'cam',
    doors: 'kapı',
    allWindows: 'tüm camlar',
    allDoors: 'tüm kapılar',
    rowPair: { row1: 'sol ve sağ ön', row2: 'sol ve sağ arka' },
    windowStates: { full: 'tam açık', partial: 'kısmen açık' },
    sunroof: 'cam tavan',
    sunroofTilt: 'cam tavan (aralık)',
    trunk: 'bagaj',
    hood: 'kaput',
    openTitle: { locked: 'MINI kilitlendi ama açık parça var', unlocked: 'MINI kilitli değil, açık parça var', unknown: "MINI'de açık parça var" },
    stillOpenTitle: {
      locked: 'MINI kilitli ama hala açık parça var',
      unlocked: 'MINI kilitli değil, hala açık parça var',
      unknown: "MINI'de hala açık parça var",
    },
    since: (time) => `${time}'${turkishFromSuffix(time)} beri`,
    and: 've',
    openBody: (items) => upperFirst(items, 'tr'),
    closedTitle: 'MINI',
    closedBody: 'Her şey kapandı.',
    lockedTitle: 'MINI kilitlendi',
    lockedBody: 'Her şey kapalı.',
    trip: (duration) => `sürüş ${duration}`,
    duration: (hours, minutes) => (hours ? `${hours} sa ${minutes} dk` : `${minutes} dk`),
    battery: (percent) => `batarya %${percent}`,
    range: (km) => `menzil ${km} km`,
    percentOf: (percent) => `%${percent}`,
    charge: {
      active: 'şarj oluyor',
      starting: 'şarj başlatılıyor',
      paused: 'şarj duraklatıldı',
      ended: 'şarj tamamlandı',
      error: 'şarj hatası',
      idle: 'fiş takılı ama şarj olmuyor',
    },
    silenceTitle: "MINI'den veri gelmiyor",
    silenceBody: (hours) => `Araçtan ${hours} saattir veri gelmiyor. Sunucuyu ve CarData portalını kontrol et.`,
    testTitle: 'MINI deneme bildirimi',
    testBody: 'Bildirim çalışıyor.',
  },
};
const textFor = (cfg) => TEXT[cfg.language] ?? TEXT.en;
export const textsFor = (language) => TEXT[language] ?? TEXT.en; // for the tests
// "a", "a and b", "a, b and c"
const joinList = (items, word) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`);
// With more than one car, the title names the car: "MINI left open (Countryman)".
const withName = (title, name) => (name ? `${title} (${name})` : title);
// The first letter in upper case, with the rules of the language (Turkish: i becomes İ).
const upperFirst = (text, language) => (text ? text.charAt(0).toLocaleUpperCase(language) + text.slice(1) : text);

// Turkish adds -den, -dan, -ten or -tan to a time, for example "13:50'den". The suffix follows the
// last spoken word of the time: the minute, or the hour when the minute is 00.
const TR_ONES = ['sıfır', 'bir', 'iki', 'üç', 'dört', 'beş', 'altı', 'yedi', 'sekiz', 'dokuz'];
const TR_TENS = { 1: 'on', 2: 'yirmi', 3: 'otuz', 4: 'kırk', 5: 'elli' };
const TR_FROM = { sıfır: 'dan', bir: 'den', iki: 'den', üç: 'ten', dört: 'ten', beş: 'ten', altı: 'dan', yedi: 'den', sekiz: 'den', dokuz: 'dan', on: 'dan', yirmi: 'den', otuz: 'dan', kırk: 'tan', elli: 'den' };
const trLastWord = (n) => (n % 10 === 0 && n > 0 ? TR_TENS[n / 10] : TR_ONES[n % 10]);

export function turkishFromSuffix(time) {
  const [hour, minute] = time.slice(-5).split(':').map(Number);
  return TR_FROM[trLastWord(minute === 0 ? hour : minute)];
}

// Intl.DateTimeFormat keeps native (ICU) memory outside the JavaScript heap. The garbage collector
// sees this memory late. A new formatter for each call made memory grow to more than 600 MB in a
// replay. So the program makes each formatter once and keeps it.
const formatters = new Map();
function formatter(locale, options) {
  const key = `${locale}|${JSON.stringify(options)}`;
  if (!formatters.has(key)) formatters.set(key, new Intl.DateTimeFormat(locale, options));
  return formatters.get(key);
}

// "13:50" for today. "6 Oct 13:50" (or "6 Eki 13:50") for an earlier day. The time zone comes from config.timezone.
export function formatTime(seconds, cfg, nowSeconds = Date.now() / 1000) {
  const timeZone = cfg.timezone || undefined;
  const locale = cfg.language === 'tr' ? 'tr-TR' : 'en-GB';
  const date = new Date(seconds * 1000);
  const hm = formatter('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(date);
  const day = (value) => formatter('en-CA', { timeZone }).format(value);
  if (day(date) === day(new Date(nowSeconds * 1000))) return hm;
  return `${formatter(locale, { day: 'numeric', month: 'short', timeZone }).format(date)} ${hm}`;
}

const log = (msg) => console.log(new Date().toTimeString().slice(0, 8), msg);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => Date.now() / 1000;

// Writes a file so that a crash leaves the old file or the new file, never a half file.
// The temporary file gets mode 0600 when it is made, so nobody else can read it at any time.
function writeFileAtomic(path, text) {
  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true });
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export const DEFAULT_CONFIG = {
  language: 'en',
  timezone: '', // Empty means the time zone of the server. Example: "Europe/Istanbul"
  alert_after_min: 10,
  alert_after_lock_min: 0, // Wait after the car is locked from outside, for a part that was open at that time. 0 = at once.
  remind_after_min: [30, 90], // Reminders: minutes after the first notification. [] = no reminder.
  park_after_idle_min: 30,
  lock_confirm: false, // true = a notification "locked, everything is closed" when you lock the car with all parts closed.
  notify_trip: false, // true = the length of the last drive at the end of the first notifications (not the reminders), in parentheses.
  notify_battery: false, // true = the battery level and the range at the end of the first notifications (not the reminders), in parentheses.
  notify_battery_below_pct: 100, // 1 to 100. The battery level and the range show only when the level is below this percent. 100 = always.
  silence_alert_hours: 0, // 0 = off. Otherwise one notification when the car sends no data for this time.
  vehicle_names: {}, // {"VIN": "name"}. Only needed for an account with more than one car.
  ntfy_server: 'https://ntfy.sh',
  ntfy_topic: '',
  // The emoji at the start of the title. An ntfy tag name for each kind of notification. A comma gives more
  // than one tag. The list of names: https://docs.ntfy.sh/emojis/. A missing key keeps its default.
  ntfy_tags: { open: 'warning', still_open: 'warning', closed: 'white_check_mark', locked: 'lock', silence: 'grey_question', test: 'car' },
  // The service that sends the notifications: "ntfy" or "pushover". See docs/en/06-pushover.md.
  notify_service: 'ntfy',
  // Pushover: the API token of the application and the user key (or a delivery group key). Secrets.
  // The program checks and uses them only when notify_service is "pushover", and in the command "pushover-test".
  pushover_token: '',
  pushover_user: '',
};

// Minutes settings: a number from 1 minute to 7 days. alert_after_min can also be 0 (no wait).
const MINUTE_SETTINGS = { alert_after_min: 0, alert_after_lock_min: 0, park_after_idle_min: 1 };
const MAX_REMINDERS = 10;
const MAX_MINUTES = 7 * 24 * 60;
const MAX_SILENCE_HOURS = 30 * 24;

export function checkConfig(cfg) {
  if (!TEXT[cfg.language]) throw new Error(`Unknown language "${cfg.language}". Use "en" or "tr".`);
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: cfg.timezone || undefined });
  } catch {
    throw new Error(`Unknown timezone "${cfg.timezone}". Use a name like "Europe/Istanbul".`);
  }
  for (const [key, min] of Object.entries(MINUTE_SETTINGS)) {
    const value = cfg[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > MAX_MINUTES) {
      throw new Error(`"${key}" must be a number of minutes from ${min} to ${MAX_MINUTES}. Now it is ${JSON.stringify(value)}.`);
    }
  }
  const remind = cfg.remind_after_min;
  const remindOk =
    Array.isArray(remind) &&
    remind.length <= MAX_REMINDERS &&
    remind.every((m, i) => typeof m === 'number' && Number.isFinite(m) && m >= 1 && m <= MAX_MINUTES && (i === 0 || m > remind[i - 1]));
  if (!remindOk) {
    throw new Error(
      `"remind_after_min" must be a list of up to ${MAX_REMINDERS} rising minutes, for example [30, 90]. [] means no reminder. Now it is ${JSON.stringify(remind)}.`,
    );
  }
  const tags = cfg.ntfy_tags;
  const tagKinds = Object.keys(DEFAULT_CONFIG.ntfy_tags);
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) {
    throw new Error(`"ntfy_tags" must look like {"open": "rotating_light"}. The kinds: ${tagKinds.join(', ')}.`);
  }
  for (const [kind, value] of Object.entries(tags)) {
    if (!tagKinds.includes(kind)) throw new Error(`"ntfy_tags" has an unknown kind "${kind}". The kinds: ${tagKinds.join(', ')}.`);
    if (typeof value !== 'string' || !/^[a-z0-9_+-]+(,[a-z0-9_+-]+)*$/i.test(value)) {
      throw new Error(`"ntfy_tags.${kind}" must be an ntfy tag name like "rotating_light". A comma gives more than one. Now it is ${JSON.stringify(value)}.`);
    }
  }
  for (const key of ['lock_confirm', 'notify_trip', 'notify_battery']) {
    if (typeof cfg[key] !== 'boolean') throw new Error(`"${key}" must be true or false. Now it is ${JSON.stringify(cfg[key])}.`);
  }
  const below = cfg.notify_battery_below_pct;
  if (typeof below !== 'number' || !Number.isFinite(below) || below < 1 || below > 100) {
    throw new Error(`"notify_battery_below_pct" must be a number from 1 to 100 (100 = always). Now it is ${JSON.stringify(below)}.`);
  }
  const hours = cfg.silence_alert_hours;
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0 || hours > MAX_SILENCE_HOURS) {
    throw new Error(`"silence_alert_hours" must be a number from 0 (off) to ${MAX_SILENCE_HOURS}. Now it is ${JSON.stringify(hours)}.`);
  }
  const names = cfg.vehicle_names;
  if (!names || typeof names !== 'object' || Array.isArray(names) || Object.values(names).some((name) => typeof name !== 'string')) {
    throw new Error('"vehicle_names" must look like {"VIN": "name"}.');
  }
  if (!/^https?:\/\/[^\s/]+/.test(String(cfg.ntfy_server))) {
    // The text does not show the value: it can contain a user name and a password.
    throw new Error('"ntfy_server" must be an address like "https://ntfy.sh". Now it is not valid.');
  }
  // fetch cannot use an address with a user name or a password, and its error text would show it in the log.
  let serverUrl = null;
  try {
    serverUrl = new URL(String(cfg.ntfy_server));
  } catch {
    // The check above accepted the start of the value. The next line refuses it when the value is not an address.
  }
  if (!serverUrl) throw new Error('"ntfy_server" must be an address like "https://ntfy.sh". Now it is not valid.');
  if (serverUrl.username || serverUrl.password) throw new Error('"ntfy_server" must not have a user name or a password. The program does not use them.');
  // The text does not show the value: a token or a key can be in the wrong field.
  if (!NOTIFY_SERVICES.includes(cfg.notify_service)) throw new Error('"notify_service" must be "ntfy" or "pushover". Now it is not valid.');
  // With "ntfy" the Pushover settings are not used, so they are not checked.
  if (cfg.notify_service === 'pushover') checkPushover(cfg);
  const known = new Set([...Object.keys(DEFAULT_CONFIG), 'client_id']);
  const unknown = Object.keys(cfg).filter((key) => !known.has(key));
  if (unknown.length) log(`Warning: config.json has unknown settings: ${unknown.join(', ')}. The program ignores them.`);
  return cfg;
}

function loadConfig() {
  let saved;
  try {
    saved = JSON.parse(readFileSync(CONFIG, 'utf8'));
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    // The error text of JSON.parse can show a part of the file, for example the topic name. Show only the place.
    const place = err.message.match(/\(line \d+ column \d+\)/)?.[0];
    throw new Error(`${CONFIG} is not valid JSON${place ? ` ${place}` : ''}. Check the quotes and the commas.`);
  }
  return checkConfig({ ...DEFAULT_CONFIG, ...saved });
}

function requireClientId(cfg) {
  if (!cfg.client_id || String(cfg.client_id).startsWith('YOUR-')) {
    throw new Error(`Set "client_id" in ${CONFIG} first. Use the Client ID from the MINI portal.`);
  }
}

// Anybody who knows the topic name can read the notifications. An example name or a short name is not safe.
export function checkTopic(cfg) {
  const topic = String(cfg.ntfy_topic ?? '');
  if (!topic || topic.startsWith('YOUR-') || topic === EXAMPLE_TOPIC || topic.length < MIN_TOPIC_LENGTH) {
    throw new Error(
      `Set "ntfy_topic" in config.json to a long random name (${MIN_TOPIC_LENGTH} characters or more). ` +
        'Make one with: echo "mini-$(openssl rand -hex 9)". See docs/en/03-ntfy.md.',
    );
  }
}

// The Pushover token and user key must have the form of a Pushover key. The texts never show the values.
export function checkPushover(cfg) {
  const fields = [
    ['pushover_token', 'the API token of your application'],
    ['pushover_user', 'your user key or a delivery group key'],
  ];
  for (const [key, what] of fields) {
    const value = cfg[key] ?? '';
    if (value === '') throw new Error(`Set "${key}" in config.json to ${what} from pushover.net. See docs/en/06-pushover.md.`);
    if (typeof value !== 'string' || !PUSHOVER_KEY.test(value)) {
      throw new Error(`"${key}" must have 30 letters and digits (A-Z, a-z, 0-9), with no space. Now it is not valid. See docs/en/06-pushover.md.`);
    }
  }
}

// Reads an HTTP answer, but not more than `limit` bytes. A larger answer is an error with the code BODY_TOO_LARGE.
const BODY_TOO_LARGE = 'BODY_TOO_LARGE';
export async function readBody(resp, limit = MAX_HTTP_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of resp.body ?? []) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error(`The answer is larger than ${limit} bytes.`), { code: BODY_TOO_LARGE });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function postForm(url, data) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(data),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await readBody(resp);
  try {
    return { ...JSON.parse(text), _status: resp.status };
  } catch {
    return { error: text.slice(0, 200), _status: resp.status };
  }
}

// The fields of tokens.json. The access token is not kept: the program does not use it.
// A refresh answer without a new refresh token or GCID keeps the old values.
export function tokenRecord(resp, old = {}, at = now()) {
  return {
    refresh_token: resp.refresh_token ?? old.refresh_token,
    id_token: resp.id_token,
    gcid: resp.gcid ?? old.gcid,
    id_expires_at: at + Number(resp.expires_in ?? 3600),
  };
}

function saveTokens(resp, old = {}) {
  const tokens = tokenRecord(resp, old);
  writeFileAtomic(TOKENS, JSON.stringify(tokens));
  return tokens;
}

async function login(cfg) {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const resp = await postForm(`${OAUTH}/device/code`, {
    client_id: cfg.client_id,
    response_type: 'device_code',
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  if (!resp.device_code) throw new Error(`Could not get a device code: ${JSON.stringify(resp)}`);
  console.log(`USER_CODE=${resp.user_code}`);
  console.log(`VERIFICATION_URI=${resp.verification_uri_complete ?? resp.verification_uri}`);
  log(`Enter the code in the browser within ${resp.expires_in} seconds.`);

  let interval = Number(resp.interval ?? 5);
  const deadline = now() + Number(resp.expires_in);
  while (now() < deadline) {
    await sleep(interval * 1000);
    let tok;
    try {
      tok = await postForm(`${OAUTH}/token`, {
        client_id: cfg.client_id,
        device_code: resp.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        code_verifier: verifier,
      });
    } catch (err) {
      if (err.name !== 'TimeoutError') throw err;
      log('The login server did not answer in time. Trying again.');
      continue;
    }
    if (tok.id_token) {
      saveTokens(tok);
      log(`Login done. Granted scope: ${tok.scope}`);
      return;
    }
    if (tok.error === 'authorization_pending') continue;
    if (tok.error === 'slow_down') {
      interval += 5;
      continue;
    }
    throw new Error(`Could not get a token: ${JSON.stringify(tok)}`);
  }
  throw new Error('The code expired. Run the command again.');
}

async function getTokens(cfg) {
  const tokens = JSON.parse(readFileSync(TOKENS, 'utf8'));
  if (tokens.id_expires_at - now() >= TOKEN_MARGIN_S) return tokens;
  log('The token expires soon. Refreshing it.');
  const resp = await postForm(`${OAUTH}/token`, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: cfg.client_id,
  });
  if (!resp.id_token) {
    throw new Error(`Could not refresh the token: ${JSON.stringify(resp)}. Run the "login" command again.`);
  }
  return saveTokens(resp, tokens);
}

const NTFY_PRIORITY = { default: 3, high: 4 };

// The tag (emoji) of a kind of notification: open, still_open, closed, locked, silence or test.
export const tagFor = (cfg, kind) => cfg.ntfy_tags?.[kind] ?? DEFAULT_CONFIG.ntfy_tags[kind];

// An ntfy time (seconds since 1970) as ISO text in UTC, or '' when the value is not a usable number.
function ntfyTime(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '';
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

// A message of ntfy: a JSON object with a non-empty string id. Other values give null.
function ntfyMessage(value) {
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  return isObject && typeof value.id === 'string' && value.id !== '' ? value : null;
}

// Text from an answer of ntfy for one log line: control characters (also line breaks) become `replacement`.
// A line break in a value cannot split the log line.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const oneLine = (text, replacement = '') => String(text).replace(CONTROL_CHARS, replacement).trim();

// Sends one notification. A title in an HTTP header fails for letters outside Latin-1. A JSON body carries UTF-8.
// Returns true only when ntfy accepted the message: HTTP 2xx and an answer with a message id. Then the program
// counts the notification as sent. ntfy gives no delivery confirmation: the program cannot see if a phone got it.
// A 2xx answer without a message id is not a confirmation. It returns false, so the retry runs. A second
// notification on the phone is a smaller risk than a lost one. An empty topic prints the text and returns true.
// The log never shows the topic name.
export async function ntfy(cfg, title, text, priority = 'high', tags = 'warning') {
  if (!cfg.ntfy_topic) {
    log(`[ntfy off] ${title}: ${text}`);
    return true;
  }
  try {
    const resp = await fetch(cfg.ntfy_server, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: cfg.ntfy_topic,
        title,
        message: text,
        priority: NTFY_PRIORITY[priority] ?? 3,
        tags: tags.split(','),
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!resp.ok) {
      await resp.body?.cancel?.();
      log(`Notification failed: HTTP ${resp.status}`);
      return false;
    }
    // The answer of ntfy is the stored message: id, time and expires (seconds since 1970). The log keeps the id,
    // so "ntfy-check <id>" can find the message in the cache of ntfy.
    let message = null;
    try {
      message = ntfyMessage(JSON.parse(await readBody(resp)));
    } catch {
      message = null; // The answer cannot be read, is too large or is not JSON.
    }
    if (!message) {
      log(`Notification not confirmed: HTTP ${resp.status}, the answer of ntfy has no message id`);
      return false;
    }
    const time = ntfyTime(message.time);
    const expires = ntfyTime(message.expires);
    // Any non-empty id counts as accepted. Only the log text drops control characters from it.
    const shownId = oneLine(message.id) || '(not printable)';
    const fields = [`ntfy id ${shownId}`, `HTTP ${resp.status}`, ...(time ? [`time ${time}`] : []), ...(expires ? [`expires ${expires}`] : [])];
    log(`Notification accepted by ntfy: ${title}: ${text} (${fields.join(', ')})`);
    return true;
  } catch (err) {
    log(`Notification failed: ${err.message}`);
    return false;
  }
}

// The id of an ntfy message, as the log line "Notification accepted by ntfy" shows it.
const NTFY_ID = /^[A-Za-z0-9_-]{6,64}$/;

// Replaces the topic name in a text with "<topic>".
function hideTopic(cfg, text) {
  const topic = String(cfg.ntfy_topic ?? '');
  return [topic, encodeURIComponent(topic)].filter(Boolean).reduce((result, secret) => result.split(secret).join('<topic>'), String(text));
}

// Asks ntfy one time if its cache still has the message with this id. It sends no notification.
// Returns { status, detail, message }. status: 'found' (ntfy has the message now), 'missing' (ntfy answered,
// but it does not have the message now) or 'unknown' (no conclusion is possible). An invalid id gives 'unknown'
// without a request. The detail never has the address, the topic name, the server path or an error text.
export async function checkNtfyMessage(cfg, id) {
  if (typeof id !== 'string' || !NTFY_ID.test(id)) {
    return {
      status: 'unknown',
      detail: 'The message id is not valid. Use the id from the log line "Notification accepted by ntfy" (6 to 64 letters, digits, "_" or "-").',
    };
  }
  const topic = String(cfg.ntfy_topic ?? '');
  let url;
  try {
    url = new URL(`${String(cfg.ntfy_server).replace(/\/+$/, '')}/${encodeURIComponent(topic)}/json?poll=1&id=${id}`);
  } catch {
    return { status: 'unknown', detail: 'The check did not start: "ntfy_server" in config.json is not a valid address.' };
  }
  let resp;
  let body;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (resp.status !== 200) await resp.body?.cancel?.();
    else body = await readBody(resp);
  } catch (err) {
    // An error text can contain the address with a user name and a password, and the topic. So the detail
    // has only a fixed text and the error code, a name with letters, digits and "_" only.
    let reason;
    if (err?.name === 'TimeoutError') reason = `no answer in ${HTTP_TIMEOUT_MS / 1000} seconds`;
    else if (err?.code === BODY_TOO_LARGE) reason = `the answer of ntfy is larger than ${MAX_HTTP_BODY_BYTES / 1024} KB`;
    else {
      // A real code is a fixed name like ENOTFOUND or TypeError. Anything else shows as "Error".
      const raw = hideTopic(cfg, String(err?.cause?.code ?? err?.name ?? ''));
      reason = `no answer from ntfy (${/^[A-Za-z][A-Za-z0-9_]{1,39}$/.test(raw) ? raw : 'Error'})`;
    }
    return { status: 'unknown', detail: `The check did not finish: ${reason}.` };
  }
  if (resp.status === 401 || resp.status === 403) {
    return { status: 'unknown', detail: `ntfy refused the check: HTTP ${resp.status}. The program has no permission to read the topic.` };
  }
  if (resp.status === 429) {
    return { status: 'unknown', detail: 'ntfy refused the check: HTTP 429. Too many requests. Try again later.' };
  }
  if (resp.status !== 200) {
    return { status: 'unknown', detail: `The check did not finish: ntfy answered HTTP ${resp.status}.` };
  }
  // The answer has one JSON object on each line. An empty answer means: no message. A line that is not
  // a JSON object is not an answer of ntfy, so no conclusion is possible.
  const lines = body.split('\n').filter((text) => text.trim() !== '');
  const values = [];
  for (const text of lines) {
    try {
      values.push(JSON.parse(text));
    } catch {
      values.push(null);
    }
  }
  if (values.some((value) => value === null || typeof value !== 'object' || Array.isArray(value))) {
    return { status: 'unknown', detail: 'The check did not finish: the answer of ntfy is not one JSON object on each line.' };
  }
  // An older ntfy can ignore the id filter. So look for the id in each message.
  const message = values.find((value) => value.event === 'message' && value.id === id);
  if (message) return { status: 'found', detail: `ntfy has the message ${id}.`, message };
  return {
    status: 'missing',
    detail: 'ntfy does not have this message now. The cache keeps messages for 12 hours by default. A message that is older is gone.',
  };
}

// The command "ntfy-check <id>". Prints the result and returns the exit code: 0 found, 1 missing, 2 unknown.
export async function ntfyCheck(cfg, id) {
  const result = await checkNtfyMessage(cfg, id);
  log(`Result: ${result.status}. ${result.detail}`);
  if (result.status === 'found') {
    const { message } = result;
    // The title and the text come from the answer of ntfy: one line each, and without the topic name.
    const shown = (value) => {
      const text = typeof value === 'string' ? oneLine(value, ' ') : '';
      return text ? hideTopic(cfg, text) : '(none)';
    };
    log(`Title: ${shown(message.title)}`);
    log(`Text: ${shown(message.message)}`);
    log(`Time: ${ntfyTime(message.time) || 'unknown'}`);
    log(`Expires: ${ntfyTime(message.expires) || 'unknown'}`);
    log('ntfy kept the message. ntfy gives no delivery confirmation, so this does not show that a phone got it.');
    return 0;
  }
  if (result.status === 'missing') return 1;
  log('No conclusion about the message is possible.');
  return 2;
}

// ---- Pushover: the other notification service (notify_service "pushover"). ntfy() above does not change. ----

// The emoji of an ntfy tag name. Pushover has no tags, so the title starts with the emoji. An unknown tag gives none.
const PUSHOVER_EMOJI = new Map([
  ['warning', '⚠️'],
  ['rotating_light', '🚨'],
  ['white_check_mark', '✅'],
  ['lock', '🔒'],
  ['grey_question', '❔'],
  ['blue_car', '🚙'],
  ['car', '🚗'],
]);

// A text with at most `max` characters (Unicode code points). A longer text ends with "…".
function cutText(text, max) {
  const chars = Array.from(String(text));
  return chars.length <= max ? String(text) : `${chars.slice(0, max - 1).join('')}…`;
}

// The title for Pushover: the emoji of each known tag, in the order of the tags (as the ntfy app shows them), then the title.
// No space at the start or at the end, also with an empty title.
export function pushoverTitle(title, tags) {
  const emoji = String(tags ?? '')
    .split(',')
    .map((tag) => PUSHOVER_EMOJI.get(tag) ?? '')
    .join('');
  return cutText([emoji, String(title ?? '').trim()].filter(Boolean).join(' '), PUSHOVER_TITLE_MAX);
}

// Replaces the Pushover token and user key in a text with "<token>" and "<user>".
function hidePushoverKeys(cfg, text) {
  return [
    [cfg.pushover_token, '<token>'],
    [cfg.pushover_user, '<user>'],
  ]
    .filter(([secret]) => typeof secret === 'string' && secret !== '')
    .reduce((result, [secret, name]) => result.split(secret).join(name), String(text));
}

// Why a request to Pushover got no answer, for a log line: "in 15 seconds" or the error code, for example "(ENOTFOUND)".
// Never the error text: it can contain the address. A code that is not a plain name shows as "(Error)".
function pushoverNoAnswer(cfg, err) {
  if (err?.name === 'TimeoutError') return `in ${HTTP_TIMEOUT_MS / 1000} seconds`;
  const raw = hidePushoverKeys(cfg, String(err?.cause?.code ?? err?.name ?? ''));
  return `(${/^[A-Za-z][A-Za-z0-9_]{1,39}$/.test(raw) ? raw : 'Error'})`;
}

// The request id of an answer of Pushover: a JSON object with status 1 and a non-empty string request. Else null.
function pushoverRequest(value) {
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  return isObject && value.status === 1 && typeof value.request === 'string' && value.request !== '' ? value.request : null;
}

// A form POST to Pushover. The body has the token, so the request must not follow a redirect to another address.
// "manual": fetch does not follow a redirect. It returns the 3xx answer, and the caller treats it as a failure.
function pushoverPost(url, fields) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams(fields),
    redirect: 'manual',
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
}

const isRedirect = (status) => status >= 300 && status < 400;
const REDIRECT_TEXT = 'a redirect. The program does not follow it.';

// Sends one notification through Pushover. The arguments are the same as for ntfy(). Priority "high" becomes
// Pushover priority 1, all others 0. Returns true only when Pushover accepted the message: HTTP 2xx and an answer
// with status 1 and a request id. These priorities give no delivery confirmation either. A 2xx answer without a
// request id returns false, so the retry runs, as with ntfy. An empty token or user key prints the text and
// returns true (tools/replay.mjs). The log never shows the token, the user key or the address.
export async function pushover(cfg, title, text, priority = 'high', tags = 'warning') {
  if (!cfg.pushover_token || !cfg.pushover_user) {
    log(`[ntfy off] ${title}: ${text}`);
    return true;
  }
  try {
    const resp = await pushoverPost(PUSHOVER_MESSAGES_URL, {
      token: cfg.pushover_token,
      user: cfg.pushover_user,
      title: pushoverTitle(title, tags),
      message: cutText(text, PUSHOVER_MESSAGE_MAX),
      priority: priority === 'high' ? '1' : '0',
    });
    if (!resp.ok) {
      await resp.body?.cancel?.();
      log(isRedirect(resp.status) ? `Notification failed: HTTP ${resp.status}, ${REDIRECT_TEXT}` : `Notification failed: HTTP ${resp.status}`);
      return false;
    }
    let request = null;
    try {
      request = pushoverRequest(JSON.parse(await readBody(resp)));
    } catch {
      request = null; // The answer cannot be read, is too large or is not JSON.
    }
    if (!request) {
      log(`Notification not confirmed by Pushover: HTTP ${resp.status}, the answer has no request id`);
      return false;
    }
    // Any non-empty request id counts as accepted. The log shows it only when it has the form of an id and no key.
    const printable = PUSHOVER_REQUEST_ID.test(request) && hidePushoverKeys(cfg, request) === request;
    log(`Notification accepted by Pushover: ${title}: ${text} (request ${printable ? request : '(not printable)'}, HTTP ${resp.status})`);
    return true;
  } catch (err) {
    log(`Notification failed: no answer from Pushover ${pushoverNoAnswer(cfg, err)}`);
    return false;
  }
}

// Sends one notification through the service of notify_service: ntfy (the default) or Pushover. The arguments
// go unchanged to ntfy() or pushover(). Each value other than "pushover" uses ntfy, as before this setting.
export function notify(cfg, title, text, priority, tags) {
  if (cfg.notify_service === 'pushover') return pushover(cfg, title, text, priority, tags);
  return ntfy(cfg, title, text, priority, tags);
}

// Asks Pushover if the token and the user key are valid (doctor). It sends no notification. Returns { ok, text }.
// The text never has the token, the user key, the address or an error text.
export async function validatePushover(cfg) {
  let resp;
  try {
    resp = await pushoverPost(PUSHOVER_VALIDATE_URL, { token: String(cfg.pushover_token ?? ''), user: String(cfg.pushover_user ?? '') });
  } catch (err) {
    return { ok: false, text: `Pushover cannot be reached: no answer ${pushoverNoAnswer(cfg, err)}.` };
  }
  let answer = null;
  try {
    answer = JSON.parse(await readBody(resp));
  } catch {
    answer = null; // The answer cannot be read, is too large or is not JSON.
  }
  const isObject = answer !== null && typeof answer === 'object' && !Array.isArray(answer);
  if (resp.ok && isObject && answer.status === 1) {
    return { ok: true, text: `Pushover accepted the token and the user key: HTTP ${resp.status}. The check sent no notification.` };
  }
  if (resp.ok) return { ok: false, text: `The Pushover check is not confirmed: HTTP ${resp.status}, the answer has no status 1.` };
  if (isRedirect(resp.status)) return { ok: false, text: `The Pushover check failed: HTTP ${resp.status}, ${REDIRECT_TEXT}` };
  if (resp.status === 429) return { ok: false, text: 'Pushover refused the check: HTTP 429. Too many requests. Try again later.' };
  if (resp.status >= 500) return { ok: false, text: `The Pushover check failed: HTTP ${resp.status}. Try again later.` };
  // Pushover names the wrong field with the value "invalid". The text uses fixed words only.
  const wrong = [
    ...(isObject && answer.token === 'invalid' ? ['the token is not valid'] : []),
    ...(isObject && answer.user === 'invalid' ? ['the user key is not valid'] : []),
  ];
  return { ok: false, text: `Pushover refused the check: HTTP ${resp.status}${wrong.length ? `, ${wrong.join(' and ')}` : ''}.` };
}

export function label(name, cfg = {}) {
  const t = textFor(cfg);
  if (name.includes('sunroof')) return name.includes('tilt') ? t.sunroofTilt : t.sunroof;
  if (name.includes('trunk')) return t.trunk;
  if (name.includes('hood')) return t.hood;
  const kind = name.includes('.window.') ? t.window : t.door;
  const pos = Object.keys(t.positions).find((key) => name.includes(key));
  return pos ? `${t.positions[pos]} ${kind}` : name;
}

const POSITION_ORDER = ['row1.driver', 'row1.passenger', 'row2.driver', 'row2.passenger'];

// The windows (or the doors) of a group, with the name once: "left and right front windows",
// "front left, front right and rear left windows", "all windows".
function positionalPhrase(kind, keys, t) {
  const sorted = POSITION_ORDER.filter((key) => keys.has(key));
  const noun = kind === 'window' ? t.window : t.door;
  const plural = kind === 'window' ? t.windows : t.doors;
  if (sorted.length === 4) return kind === 'window' ? t.allWindows : t.allDoors;
  if (sorted.length === 1) return `${t.positions[sorted[0]]} ${noun}`;
  const sameRow = sorted.length === 2 && sorted[0].slice(0, 4) === sorted[1].slice(0, 4);
  if (sameRow) return `${t.rowPair[sorted[0].slice(0, 4)]} ${plural}`;
  return `${joinList(sorted.map((key) => t.positions[key]), t.and)} ${plural}`;
}

// The names of the parts in one group: windows together, doors together, then the other parts.
// Order: the first part of each kind decides. "openValues" (name -> OPEN, INTERMEDIATE, ...) is optional: with it,
// the windows of one state are named together and show the state: "left and right front windows (partly open)".
export function describeParts(names, cfg = {}, openValues = null) {
  const t = textFor(cfg);
  const entries = [];
  const positional = {};
  const seen = new Set();
  for (const name of names) {
    const found = /^vehicle\.cabin\.(window|door)\.(row\d\.(?:driver|passenger))\./.exec(name);
    if (found && t.positions[found[2]]) {
      const [, kind, key] = found;
      const value = kind === 'window' ? String(openValues?.get(name) ?? '').toUpperCase() : '';
      const state = value === 'OPEN' ? 'full' : value === 'INTERMEDIATE' ? 'partial' : '';
      const group = `${kind}:${state}`;
      if (!positional[group]) {
        positional[group] = new Set();
        entries.push({ kind, state, group });
      }
      positional[group].add(key);
    } else {
      const text = label(name, cfg);
      if (!seen.has(text)) {
        seen.add(text);
        entries.push({ text });
      }
    }
  }
  const phrase = (entry) => {
    if (entry.text) return entry.text;
    const text = positionalPhrase(entry.kind, positional[entry.group], t);
    return entry.state ? `${text} (${t.windowStates[entry.state]})` : text;
  };
  return joinList(entries.map(phrase), t.and);
}

const parseBool = (value) => {
  const text = String(value ?? '').toUpperCase();
  if (text === 'TRUE') return true;
  if (text === 'FALSE') return false;
  return null; // unknown
};

// The car of a message: the "vin" field, or the last part of the MQTT topic (<GCID>/<VIN>).
export function vinOf(payload, topic = '') {
  return String(payload?.vin || String(topic).split('/')[1] || 'unknown');
}

// Checks one MQTT message. Returns { raw, vin, data }, or { error } for a message that the program skips.
export function parseStreamMessage(topic, payload) {
  if (payload.length > MAX_PAYLOAD_BYTES) return { error: `${payload.length} bytes, the limit is ${MAX_PAYLOAD_BYTES}` };
  const raw = payload.toString();
  try {
    const parsed = JSON.parse(raw);
    return { raw, vin: vinOf(parsed, topic), data: parsed.data ?? {} };
  } catch {
    return { raw, error: 'not JSON' };
  }
}

// The state of one car.
export class Watcher {
  // clock: a function that returns the current time in seconds. Tests and replays pass their own clock.
  // random: a number from 0 to 1 for the retry jitter. Tests pass a fixed value.
  // name: a function that returns the name of the car for the title, or '' for one car.
  constructor(cfg, { clock = now, random = Math.random, name = () => '' } = {}) {
    this.cfg = cfg;
    this.clock = clock;
    this.random = random;
    this.name = name;
    this.openSince = new Map(); // attribute -> time it was first seen open
    this.openValue = new Map(); // attribute -> the last open value (OPEN, INTERMEDIATE, ...)
    this.notified = new Set();
    this.alerted = false; // Did at least one "left open" notification go out?
    this.sawClose = false; // Did the program see a part close? Missing data does not count as closed.
    this.lastNotify = 0;
    this.reminders = 0; // reminders sent since the last "left open" notification
    this.firstNotifyAt = 0; // time of the last "left open" notification. The reminders count from it.
    this.ignition = null; // true / false / null (unknown)
    this.moving = null;
    this.parkedSince = null; // time the car was first known to be parked
    this.drivingSeen = 0; // time of the last driving signal
    this.lastKm = null;
    this.kmChangedAt = 0; // time the odometer last increased
    this.lastDriverDoorAt = 0; // time the driver door last opened (to get in or to get out)
    this.lastDoorAt = 0; // time any door last opened
    this.lastUnlockAt = 0; // time the lock last changed to UNLOCKED
    this.confirmedAt = 0; // time of the last "everything is closed" message or lock confirmation
    this.lastSentAt = 0; // time of the last notification that can have details (not a reminder). The details show only after the odometer rose since then.
    this.allClosedSince = 0; // time the last open part closed (0 = unknown, counts as long ago)
    this.returnedAt = 0; // someone came back to the car after a notification (0 after a drive)
    this.doorOpen = new Map(); // door attribute -> last value. The car repeats an open door in each message.
    this.lockStatus = null; // the last value of vehicle.cabin.door.status, or null
    this.chargingStatus = null; // the last value of the charging status (for example CHARGINGACTIVE), or null
    this.plugStatus = null; // the last value of the plug (CONNECTED / DISCONNECTED), or null
    this.chargeWaitSince = 0; // the time a notification first waited for the end of the charging preparation, 0 = no wait
    this.lockChangedAt = 0;
    this.driveEndAt = 0; // time the lock left LOCKED (the car unlocks itself when you park)
    this.lockedSince = 0; // time the lock last changed to LOCKED
    this.tripActive = false; // a drive runs (set at the first odometer value, ends when the lock leaves LOCKED)
    this.tripStartAt = 0; // the start of the last drive, 0 = unknown
    this.tripEndAt = 0; // the end of the last drive
    this.readings = new Map(); // attribute -> { value, unit } for the battery level and the range
    // The start of the park after the last drive, for the time in the text. It does not move until the next drive.
    this.parkLockAt = 0; // the first SECURED after the last drive
    this.parkDoorAt = 0; // the first driver door opening after the last drive (the driver gets out)
    this.notifyFailures = 0; // failed notifications in a row
    this.retryAt = 0; // after a failed notification, the next try waits until this time
    this.unknownSeen = new Set(); // unknown values that are already in the log
    this.dirty = false; // The state changed since the last save.
    this.urgent = false; // The notification memory changed. Save it at once.
  }

  // Some cars (the tested Countryman E, U25) send no ignition or motion data.
  // The car sends the odometer about every 3 minutes while it moves, in whole kilometres.
  // driving = the odometer rose after the last driver door opening, and in the last park_after_idle_min.
  // The idle limit is long (30 minutes) because a traffic jam can stop the odometer for more than 10 minutes.
  // Ignition and motion data are used too when the car sends them. They count as stale after 2 hours.
  // Locked from outside (SECURED) after the last door opening and the last odometer increase:
  // the car is parked and the people left it.
  isSecured() {
    return this.lockStatus === 'SECURED' && this.lockChangedAt >= Math.max(this.lastDoorAt, this.kmChangedAt);
  }

  // The car locks itself (LOCKED) when it starts to drive. No door opened after that: the car drives,
  // also before the first odometer value and in a traffic jam. Stale after 2 hours, then the odometer decides.
  isLockedForDriving() {
    return this.lockStatus === 'LOCKED' && this.lockChangedAt > this.lastDoorAt && this.clock() - this.lockChangedAt < DRIVING_STALE_S;
  }

  isDriving() {
    if (this.isSecured()) return false;
    if (this.isLockedForDriving()) return true;
    const ignitionDriving = this.ignition === true || this.moving === true;
    if (ignitionDriving && this.clock() - this.drivingSeen < DRIVING_STALE_S) return true;
    const idleLimit = this.cfg.park_after_idle_min * 60;
    return this.kmChangedAt > this.lastDriverDoorAt && this.clock() - this.kmChangedAt < idleLimit;
  }

  // Everything that a restart needs: the open parts, the odometer and the notification memory.
  snapshot() {
    return {
      openSince: [...this.openSince],
      openValue: [...this.openValue],
      lastKm: this.lastKm,
      kmChangedAt: this.kmChangedAt,
      lastDriverDoorAt: this.lastDriverDoorAt,
      lastDoorAt: this.lastDoorAt,
      lastUnlockAt: this.lastUnlockAt,
      confirmedAt: this.confirmedAt,
      lastSentAt: this.lastSentAt,
      lockedSince: this.lockedSince,
      tripActive: this.tripActive,
      tripStartAt: this.tripStartAt,
      tripEndAt: this.tripEndAt,
      readings: [...this.readings],
      returnedAt: this.returnedAt,
      lockStatus: this.lockStatus,
      chargingStatus: this.chargingStatus,
      plugStatus: this.plugStatus,
      lockChangedAt: this.lockChangedAt,
      driveEndAt: this.driveEndAt,
      parkLockAt: this.parkLockAt,
      parkDoorAt: this.parkDoorAt,
      notified: [...this.notified],
      lastNotify: this.lastNotify,
      reminders: this.reminders,
      firstNotifyAt: this.firstNotifyAt,
      alerted: this.alerted,
      sawClose: this.sawClose,
    };
  }

  // Before the history replay. The replay then applies the newer messages on top.
  // A part that is open for more than 24 hours keeps its time this way.
  restoreWatch(snap) {
    this.openSince = new Map(snap.openSince ?? []);
    this.openValue = new Map(snap.openValue ?? []);
    this.lastKm = snap.lastKm ?? null;
    this.kmChangedAt = snap.kmChangedAt ?? 0;
    this.lastDriverDoorAt = snap.lastDriverDoorAt ?? 0;
    this.lastDoorAt = snap.lastDoorAt ?? 0;
    this.lastUnlockAt = snap.lastUnlockAt ?? 0;
    // A state from an older version: count the park now as confirmed, so the update sends no extra message.
    this.confirmedAt = snap.confirmedAt ?? this.clock();
    // A state from an older version: count the restore as the last notification, so the old drive shows no details.
    this.lastSentAt = snap.lastSentAt ?? this.clock();
    this.lockedSince = snap.lockedSince ?? 0;
    this.tripActive = Boolean(snap.tripActive);
    this.tripStartAt = snap.tripStartAt ?? 0;
    this.tripEndAt = snap.tripEndAt ?? 0;
    this.readings = new Map(snap.readings ?? []);
    this.returnedAt = snap.returnedAt ?? 0;
    this.lockStatus = snap.lockStatus ?? null;
    this.chargingStatus = snap.chargingStatus ?? null;
    this.plugStatus = snap.plugStatus ?? null;
    this.lockChangedAt = snap.lockChangedAt ?? 0;
    this.driveEndAt = snap.driveEndAt ?? 0;
    this.parkLockAt = snap.parkLockAt ?? 0;
    this.parkDoorAt = snap.parkDoorAt ?? 0;
  }

  // After the history replay. Ignore a notification memory that is older than the last odometer
  // increase (the car drove since).
  restoreNotify(snap, savedAt) {
    if (savedAt < this.kmChangedAt) return false;
    this.notified = new Set(snap.notified ?? []);
    this.lastNotify = snap.lastNotify ?? 0;
    this.reminders = snap.reminders ?? 0;
    this.firstNotifyAt = snap.firstNotifyAt ?? snap.lastNotify ?? 0; // Older versions: the last notification.
    this.alerted = Boolean(snap.alerted);
    this.sawClose = Boolean(snap.sawClose);
    return true;
  }

  // The wait time starts at the latest of: the last door opening, the last unlock, the last odometer
  // increase, the end of a drive by the lock (LOCKED to UNLOCKED). The driver door also opens when the
  // driver gets in. The car sends the first odometer value 3 to 7 minutes after that. So the wait
  // (alert_after_min, 10 minutes) must be longer than that.
  parkStart() {
    return Math.max(this.parkedSince ?? 0, this.lastDoorAt, this.lastUnlockAt, this.kmChangedAt, this.driveEndAt);
  }

  // The start of the park after the last drive: the first lock from outside, if it came in 10 minutes
  // after the driver got out. Else the time the driver got out. 0 when the program saw no drive
  // (then the text shows the time the part opened).
  parkBegin() {
    if (!this.kmChangedAt && !this.driveEndAt) return 0;
    const lockSoon = this.parkLockAt && (!this.parkDoorAt || this.parkLockAt - this.parkDoorAt <= PARK_LOCK_WINDOW_S);
    return lockSoon ? this.parkLockAt : this.parkDoorAt || this.parkLockAt;
  }

  // The first odometer value of a drive. The drive started when the lock became LOCKED (the car locks itself).
  // A stop shorter than TRIP_GAP_S after the last unlock belongs to the same drive, unless a notification
  // went out during the stop (the first drive was announced already).
  startTrip() {
    // The car still moves after the lock left LOCKED (for example a stop with SELECTIVELOCKED): the drive goes on.
    if (!this.tripActive && this.tripStartAt && this.tripEndAt && this.lockStatus !== 'LOCKED' && this.kmChangedAt - this.tripEndAt <= TRIP_GAP_S) {
      this.tripEndAt = this.kmChangedAt;
      return;
    }
    if (this.tripActive || this.lockStatus !== 'LOCKED' || !this.lockedSince) return;
    if (this.kmChangedAt - this.lockedSince > TRIP_START_WINDOW_S) return;
    this.tripActive = true;
    // A notification after the end of the last drive announced it. The next drive is a new one.
    const announced = this.lastSentAt > this.tripEndAt;
    const sameTrip = this.tripStartAt && this.tripEndAt && !announced && this.lockedSince - this.tripEndAt <= TRIP_GAP_S;
    if (!sameTrip) this.tripStartAt = this.lockedSince;
  }

  // The length of the last drive in seconds, or 0 when it is unknown.
  tripSeconds() {
    if (!this.tripStartAt) return 0;
    const end = this.tripEndAt >= this.tripStartAt ? this.tripEndAt : this.kmChangedAt;
    const seconds = end - this.tripStartAt;
    return seconds >= 60 && seconds <= MAX_TRIP_S ? seconds : 0;
  }

  batteryPercent() {
    for (const attribute of PERCENT_ATTRS) {
      const reading = this.readings.get(attribute);
      if (reading && reading.value >= 0 && reading.value <= 100) return Math.round(reading.value);
    }
    return null;
  }

  rangeKm() {
    for (const attribute of RANGE_ATTRS) {
      const reading = this.readings.get(attribute);
      if (reading && reading.value >= 0) return Math.round(/^mi/i.test(reading.unit) ? reading.value * MILE_IN_KM : reading.value);
    }
    return null;
  }

  // " (drive 23 min, battery 64%, range 187 km)" at the end of a notification. Not for a reminder. Only what the settings ask for
  // and what the program knows. An empty text when nothing is known. With notify_battery_below_pct under 100, the battery level
  // and the range show only when the level is known and below that percent.
  // The drive length, the battery level and the range belong to a drive: they show only when the odometer rose since the last
  // notification. A car without any odometer value shows what it has.
  // The charging state (notify_battery) is the state of the car now. It shows always, with the battery level, and it replaces
  // the battery level and the range.
  detailsText(t) {
    const afterDrive = this.lastKm === null || this.kmChangedAt > this.lastSentAt;
    const parts = [];
    if (afterDrive && this.cfg.notify_trip) {
      const minutes = Math.round(this.tripSeconds() / 60);
      if (minutes > 0) parts.push(t.trip(t.duration(Math.floor(minutes / 60), minutes % 60)));
    }
    if (this.cfg.notify_battery) {
      const percent = this.batteryPercent();
      const charge = this.chargeKind();
      if (charge) {
        parts.push(t.charge[charge] + (percent !== null ? ` ${t.percentOf(percent)}` : ''));
      } else if (afterDrive) {
        const limit = this.cfg.notify_battery_below_pct;
        if (limit >= 100 || (percent !== null && percent < limit)) {
          if (percent !== null) parts.push(t.battery(percent));
          const km = this.rangeKm();
          if (km !== null) parts.push(t.range(km));
        }
      }
    }
    return parts.length ? ` (${parts.join(', ')})` : '';
  }

  // For the title of a notification about open parts: 'locked', 'unlocked' (the car sends the lock state and it is not locked),
  // or 'unknown' (no lock data).
  lockKind() {
    if (this.lockStatus === null) return 'unknown';
    return this.lockStatus === 'SECURED' || this.lockStatus === 'LOCKED' ? 'locked' : 'unlocked';
  }

  // What the car does about charging: 'active', 'starting', 'paused', 'ended', 'error', 'idle' (the plug is connected and the
  // car does not charge), or null (not plugged in, or not known).
  chargeKind() {
    const kind = CHARGE_KINDS[this.chargingStatus];
    if (kind) return kind;
    return this.plugStatus === 'CONNECTED' && this.chargingStatus === 'NOCHARGING' ? 'idle' : null;
  }

  // True while a notification with details must wait: the plug is connected and the car prepares to charge. The wait ends when
  // the status changes, or CHARGE_WAIT_S after the first time the notification was due.
  holdForCharge() {
    if (!this.cfg.notify_battery || this.plugStatus !== 'CONNECTED' || this.chargingStatus !== 'INITIALIZATION') {
      this.chargeWaitSince = 0;
      return false;
    }
    if (!this.chargeWaitSince) this.chargeWaitSince = this.clock();
    return this.clock() - this.chargeWaitSince < CHARGE_WAIT_S;
  }

  // "at" is the time of the message. A replay at startup passes the original time.
  onData(data, at = this.clock()) {
    this.dirty = true;
    for (const [name, item] of Object.entries(data)) {
      if (name === IGNITION) this.ignition = parseBool(item?.value);
      else if (name === MOVING) this.moving = parseBool(item?.value);
      else if (name === ODOMETER) {
        const km = Number(item?.value);
        if (Number.isFinite(km)) {
          if (this.lastKm !== null && km > this.lastKm) {
            this.kmChangedAt = at;
            this.parkLockAt = this.parkDoorAt = 0; // The car drives. The next park starts later.
            this.returnedAt = 0;
            this.startTrip();
            this.notified = new Set(); // A new park, a new notification.
            // An alert stays open while a part is still open or a close waits for its message. Then
            // "everything is closed" also comes after a drive, when you park. Else forget the alert,
            // so an old alert cannot give a wrong "closed" days later.
            if (this.openSince.size === 0 && !this.sawClose) this.alerted = false;
            this.reminders = 0;
          }
          this.lastKm = km;
        }
      } else if (name === LOCK) {
        const status = String(item?.value ?? '').toUpperCase();
        if (status && status !== this.lockStatus) {
          if (this.lockStatus === 'LOCKED') {
            this.driveEndAt = at;
            if (this.tripActive) {
              this.tripEndAt = at; // The car unlocks itself at the end of a drive.
              this.tripActive = false;
            }
          }
          if (status === 'LOCKED') {
            this.parkLockAt = this.parkDoorAt = this.returnedAt = 0; // A drive starts.
            this.lockedSince = at;
          }
          if (status === 'UNLOCKED') {
            this.lastUnlockAt = at;
            // The unlock at the end of a drive after a stop with SELECTIVELOCKED is the end of the drive.
            if (this.lockStatus === 'SELECTIVELOCKED' && this.tripStartAt && this.tripEndAt && at - this.tripEndAt <= TRIP_GAP_S) this.tripEndAt = at;
          }
          if (status === 'SECURED' && !this.parkLockAt) this.parkLockAt = at;
          this.lockStatus = status;
          this.lockChangedAt = at;
        }
      }
      // A door opening counts once, when the value changes to true. The car repeats an open door in each message.
      const opened = ANY_DOOR.test(name) && parseBool(item?.value) === true && this.doorOpen.get(name) !== true;
      if (ANY_DOOR.test(name)) this.doorOpen.set(name, parseBool(item?.value));
      if (opened) {
        this.lastDoorAt = Math.max(this.lastDoorAt, at);
        if (name === DRIVER_DOOR) {
          this.lastDriverDoorAt = Math.max(this.lastDriverDoorAt, at);
          if (!this.parkDoorAt) this.parkDoorAt = at;
        }
      }
      if (name === CHARGING_STATUS || name === CHARGING_PORT) {
        const value = String(item?.value ?? '').toUpperCase();
        if (value) {
          if (name === CHARGING_STATUS) this.chargingStatus = value;
          else this.plugStatus = value;
        }
        continue;
      }
      if (PERCENT_ATTRS.includes(name) || RANGE_ATTRS.includes(name)) {
        const number = Number(item?.value);
        if (Number.isFinite(number)) this.readings.set(name, { value: number, unit: String(item?.unit ?? '') });
      }
      if (!WATCHED.some((pattern) => pattern.test(name))) continue;
      const value = String(item?.value ?? '').toUpperCase();
      if (OPEN_VALUES.has(value)) {
        if (!this.openSince.has(name)) this.openSince.set(name, at);
        this.openValue.set(name, value);
      } else if (CLOSED_VALUES.has(value)) {
        this.openValue.delete(name);
        if (this.openSince.delete(name)) {
          this.sawClose = true;
          if (this.openSince.size === 0) this.allClosedSince = at;
        }
      } else if (!this.unknownSeen.has(`${name}=${value}`)) {
        this.unknownSeen.add(`${name}=${value}`);
        log(`Unknown value "${value}" for ${name}. The last known state stays.`);
      }
    }
    if (this.ignition === true || this.moving === true) {
      this.drivingSeen = at;
      this.parkedSince = null;
    } else if (this.parkedSince === null && (this.ignition === false || this.moving === false)) {
      this.parkedSince = at;
    }
  }

  // A failed notification (ntfy or Pushover not reachable, an HTTP error, or a 2xx answer without a message id
  // or a request id) does not change the state. The first check after the wait decides again if the notification is still needed: a part
  // that closed needs no alert, and a lock confirmation is only sent within 10 minutes of the lock.
  // The base wait is 30 seconds. It doubles with each failure in a row and stops at 10 minutes. A random factor
  // from 0.8 to 1.2 spreads the tries, so the longest wait is about 12 minutes.
  notifyResult(ok) {
    if (ok) {
      this.notifyFailures = 0;
      this.retryAt = 0;
      this.urgent = true;
      this.chargeWaitSince = 0;
      return true;
    }
    const base = Math.min(NOTIFY_RETRY_MIN_S * 2 ** this.notifyFailures, NOTIFY_RETRY_MAX_S);
    const wait = Math.round(base * (0.8 + 0.4 * this.random()));
    this.notifyFailures += 1;
    this.retryAt = this.clock() + wait;
    log(`The program tries the notification again in ${wait} seconds.`);
    return false;
  }

  // Optional (lock_confirm). The car is locked from outside and every part is closed: say it at once.
  // It shows that the notification system works. Rules:
  // - Only after a door opened or the car drove since the last confirmation. A key near the car (a valet)
  //   can lock and unlock the car many times without a door. Those cycles give nothing.
  // - A lock less than 2 minutes after the last confirmation gives nothing (a walk around the car).
  // - Only within 10 minutes of the lock, so a restart does not send an old confirmation.
  async confirmLock(t) {
    if (!this.isSecured()) return;
    const now = this.clock();
    if (now - this.lockChangedAt < this.cfg.alert_after_lock_min * 60) return;
    if (now - this.lockChangedAt > CONFIRM_WINDOW_S) return;
    if (this.confirmedAt >= Math.max(this.lastDoorAt, this.kmChangedAt)) return;
    if (this.lockChangedAt - this.confirmedAt < RELOCK_WAIT_S) {
      this.confirmedAt = now; // This lock is handled. A later lock without a door must not count the old door openings.
      return;
    }
    if (this.holdForCharge()) return; // The next check asks again.
    const sent = await notify(this.cfg, withName(t.lockedTitle, this.name()), t.lockedBody + this.detailsText(t), 'default', tagFor(this.cfg, 'locked'));
    if (!this.notifyResult(sent)) return;
    this.confirmedAt = now;
    this.lastSentAt = now;
  }

  async check() {
    if (this.isDriving()) return; // No notification while driving.
    if (this.clock() < this.retryAt) return; // Wait after a failed notification.
    const t = textFor(this.cfg);
    const wait = this.cfg.alert_after_min * 60;
    // A part that was open when the car was locked from outside: notify after alert_after_lock_min
    // (0 = at the next check, at most 15 seconds). With 1 minute, the windows and the sunroof can close
    // first (comfort close while you hold the lock button).
    const lockWait = this.cfg.alert_after_lock_min * 60;
    const secured = this.isSecured();
    // After a return to the car without a drive, a new lock must stay for RELOCK_WAIT_S (2 minutes).
    const securedWait = this.returnedAt ? Math.max(lockWait, RELOCK_WAIT_S) : lockWait;
    const due = (since) =>
      this.clock() - Math.max(since, this.parkStart()) >= wait ||
      (secured && since <= this.lockChangedAt && this.clock() - this.lockChangedAt >= securedWait);
    // The timer starts when the part opened or when the car parked, whichever is later.
    const current = new Set(
      [...this.openSince]
        .filter(([, since]) => due(since))
        .map(([name]) => name),
    );
    this.notified = new Set([...this.notified].filter((name) => this.openSince.has(name))); // Forget closed parts.
    // Back at the car: a door opened after the first notification of the series. The remaining
    // reminders stop. A part that is still open gives a new series: 2 minutes after the car is locked
    // again (RELOCK_WAIT_S), else after the normal wait. An unlock and a lock without a door opening
    // change nothing: a key button or a key near the car (for example at a valet) can do this many times.
    if (this.notified.size && this.lastDoorAt > this.firstNotifyAt) {
      this.notified = new Set();
      this.returnedAt = this.lastDoorAt;
      this.urgent = true;
    }
    if (this.openSince.size === 0) {
      // Someone came back to the car: a door opened after the "left open" notification. That person knows that the part is
      // closed. With lock_confirm, the next lock says "everything is closed", so this message is not needed.
      // The notification memory ends here without a message. A part that closed without a door (comfort close) still gets it.
      if (this.alerted && this.sawClose && this.cfg.lock_confirm && this.lastDoorAt > this.firstNotifyAt) {
        this.alerted = false;
        this.sawClose = false;
      }
      // Send "everything is closed" only after the program saw a part close.
      // After a restart, an empty list can mean "no data yet", not "closed".
      if (this.alerted && this.sawClose) {
        if (this.clock() - this.allClosedSince < CLOSED_SETTLE_S) return; // A door may open next. The next check asks again.
        if (this.holdForCharge()) return;
        const sent = await notify(this.cfg, withName(t.closedTitle, this.name()), t.closedBody + this.detailsText(t), 'default', tagFor(this.cfg, 'closed'));
        if (!this.notifyResult(sent)) return;
        this.alerted = false;
        this.sawClose = false;
        this.confirmedAt = this.clock(); // This message says it already. No lock confirmation right after it.
        this.lastSentAt = this.clock();
      } else if (this.cfg.lock_confirm) {
        await this.confirmLock(t);
      }
      return;
    }
    if (current.size === 0) return; // A part is open but the wait time is not over.
    this.sawClose = false;
    const added = [...current].some((name) => !this.notified.has(name));
    // Reminders at fixed times after the first notification (remind_after_min, default 30 and 90 minutes).
    // After the last one, no more reminders. A new open part starts a new series.
    const nextReminder = this.cfg.remind_after_min[this.reminders];
    const remind = nextReminder !== undefined && this.clock() - this.firstNotifyAt >= nextReminder * 60;
    if (added || remind) {
      if (added && this.holdForCharge()) return;
      // The oldest open part comes first. Each part shows the time the program first saw it open,
      // or the start of this park if the part was already open before it (open during the drive or
      // since an earlier day). The start of the park is the first lock after the drive (see parkBegin).
      const parkBegin = this.parkBegin();
      const shownSince = (name) => Math.max(this.openSince.get(name), parkBegin);
      // Parts with the same time share it, and the windows (or the doors) of a group share their name:
      // "left and right front windows since 16:54". A part shows once, with its earliest time
      // (the trunk has two attributes).
      const groups = new Map(); // time text -> attribute names
      const shown = new Set();
      for (const name of [...current].sort((a, b) => shownSince(a) - shownSince(b) || this.openSince.get(a) - this.openSince.get(b))) {
        const text = label(name, this.cfg);
        if (shown.has(text)) continue;
        shown.add(text);
        const when = t.since(formatTime(shownSince(name), this.cfg, this.clock()));
        groups.set(when, [...(groups.get(when) ?? []), name]);
      }
      const items = [...groups].map(([when, names]) => `${describeParts(names, this.cfg, this.openValue)} ${when}`).join(', ');
      const title = withName((added ? t.openTitle : t.stillOpenTitle)[this.lockKind()], this.name());
      const sent = await notify(this.cfg, title, t.openBody(items) + (added ? this.detailsText(t) : ''), 'high', tagFor(this.cfg, added ? 'open' : 'still_open'));
      if (!this.notifyResult(sent)) return;
      this.alerted = true;
      this.reminders = added ? 0 : this.reminders + 1;
      if (added) {
        this.firstNotifyAt = this.clock();
        this.lastSentAt = this.clock(); // A reminder has no details, so it does not count.
      }
      this.notified = current;
      this.lastNotify = this.clock();
    }
  }
}

// All cars of the account. The stream topic <GCID>/+ carries the messages of every car.
// Each car has its own Watcher, so the parts of two cars do not mix.
export class Fleet {
  constructor(cfg, { clock = now, random = Math.random, stateFile = null } = {}) {
    this.cfg = cfg;
    this.clock = clock;
    this.random = random;
    this.stateFile = stateFile; // null: do not save (tests and replays)
    this.watchers = new Map(); // VIN -> Watcher
    this.startedAt = clock();
    this.lastMessageAt = 0;
    this.silenceAlerted = false;
    this.silenceRetryAt = 0;
    this.lastSave = 0;
    this.dirty = false;
    this.saved = null; // the state file as it was at the start
  }

  // While a "closed" message waits for its settle time, check more often. The message then comes
  // about 15 to 20 seconds after the last part closed (a check every 15 seconds would give 15 to 30).
  nextCheckDelayMs() {
    const pending = [...this.watchers.values()].some(
      (watcher) => (watcher.alerted && watcher.sawClose && watcher.openSince.size === 0) || watcher.chargeWaitSince > 0,
    );
    return pending ? 5_000 : 15_000;
  }

  watcher(vin) {
    if (!this.watchers.has(vin)) {
      this.watchers.set(vin, new Watcher(this.cfg, { clock: this.clock, random: this.random, name: () => this.displayName(vin) }));
    }
    return this.watchers.get(vin);
  }

  // A name from vehicle_names, or the last 4 characters of the VIN when the account has more than one car.
  displayName(vin) {
    const named = this.cfg.vehicle_names?.[vin];
    if (named) return named;
    return this.watchers.size > 1 ? `…${String(vin).slice(-4)}` : '';
  }

  onMessage(vin, data, at = this.clock()) {
    this.lastMessageAt = Math.max(this.lastMessageAt, at);
    this.silenceAlerted = false;
    this.dirty = true;
    this.watcher(vin).onData(data, at);
  }

  async check() {
    for (const watcher of this.watchers.values()) await watcher.check();
    await this.checkSilence();
    this.save();
  }

  // Optional (silence_alert_hours). One notification when no message came for that time.
  // The car sends nothing while it sleeps, so a long parked time also gives this notification.
  async checkSilence() {
    const hours = this.cfg.silence_alert_hours;
    if (!hours || this.silenceAlerted || this.clock() < this.silenceRetryAt) return;
    if (this.clock() - (this.lastMessageAt || this.startedAt) < hours * 3600) return;
    const t = textFor(this.cfg);
    if (await notify(this.cfg, t.silenceTitle, t.silenceBody(hours), 'default', tagFor(this.cfg, 'silence'))) {
      this.silenceAlerted = true;
      this.dirty = true;
    } else {
      this.silenceRetryAt = this.clock() + NOTIFY_RETRY_MAX_S; // A fixed wait of 10 minutes, without doubling or random change.
    }
  }

  // Saves at once after a notification, else at most once a minute. force: save now (at shutdown).
  save(force = false) {
    if (!this.stateFile) return;
    const watchers = [...this.watchers.values()];
    const urgent = watchers.some((watcher) => watcher.urgent);
    const dirty = this.dirty || watchers.some((watcher) => watcher.dirty);
    if (!force && !urgent && !(dirty && this.clock() - this.lastSave >= SAVE_EVERY_S)) return;
    const state = {
      version: STATE_VERSION,
      savedAt: this.clock(),
      lastMessageAt: this.lastMessageAt,
      silenceAlerted: this.silenceAlerted,
      vehicles: Object.fromEntries([...this.watchers].map(([vin, watcher]) => [vin, watcher.snapshot()])),
    };
    // With one car, also write the fields of version 1. After a rollback, an older release still
    // finds its notification memory and does not repeat an alert.
    if (watchers.length === 1) {
      const { notified, lastNotify, reminders, alerted } = watchers[0].snapshot();
      Object.assign(state, { notified, lastNotify, reminders, alerted });
    }
    writeFileAtomic(this.stateFile, JSON.stringify(state));
    for (const watcher of watchers) watcher.dirty = watcher.urgent = false;
    this.dirty = false;
    this.lastSave = this.clock();
  }

  // Step 1 of a start, before the history replay: restore the open parts and the odometer.
  loadSnapshot() {
    try {
      this.saved = JSON.parse(readFileSync(this.stateFile, 'utf8'));
    } catch {
      this.saved = null;
    }
    const saved = this.saved;
    if (saved?.version !== STATE_VERSION || this.clock() - saved.savedAt > REPLAY_HOURS * 3600) return false;
    for (const [vin, snap] of Object.entries(saved.vehicles ?? {})) this.watcher(vin).restoreWatch(snap);
    return true;
  }

  // Step 2, after the replay: restore the notification memory. Returns the VINs that got it back.
  loadNotifyState() {
    const saved = this.saved;
    if (!saved || !(this.clock() - saved.savedAt <= REPLAY_HOURS * 3600)) return [];
    if (saved.version === STATE_VERSION) {
      this.silenceAlerted = Boolean(saved.silenceAlerted) && (saved.lastMessageAt ?? 0) >= this.lastMessageAt;
      this.lastMessageAt = Math.max(this.lastMessageAt, saved.lastMessageAt ?? 0);
      return Object.entries(saved.vehicles ?? {})
        .filter(([vin, snap]) => this.watcher(vin).restoreNotify(snap, saved.savedAt))
        .map(([vin]) => vin);
    }
    // The state file of an older version has no VIN. It belongs to the only car.
    if (this.watchers.size === 1) {
      const [vin, watcher] = [...this.watchers][0];
      if (watcher.restoreNotify({ ...saved, sawClose: false }, saved.savedAt)) return [vin];
    }
    return [];
  }
}

// Saves the raw stream messages for the replay at a restart and for tools/replay.mjs.
// At HISTORY_MAX_BYTES the file becomes messages.jsonl.1 (the older .1 file is deleted).
export class History {
  constructor(file = MESSAGES, maxBytes = HISTORY_MAX_BYTES) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.size = existsSync(file) ? statSync(file).size : 0;
  }

  append(raw, at = now()) {
    const line = `${JSON.stringify({ t: at, payload: raw })}\n`;
    const bytes = Buffer.byteLength(line);
    if (this.size > 0 && this.size + bytes > this.maxBytes) {
      renameSync(this.file, `${this.file}.1`);
      this.size = 0;
      log(`The history file is full. It is now ${this.file}.1.`);
    }
    appendFileSync(this.file, line, { mode: 0o600 });
    this.size += bytes;
  }
}

// A restart must not lose the odometer and door history. Replay the messages of the last 24 hours.
// The files are read line by line, so a large file does not fill the memory.
// A broken line (for example the last line after a crash) is skipped. The other lines still count.
export async function replayRecent(fleet, files = [`${MESSAGES}.1`, MESSAGES]) {
  let count = 0;
  let broken = 0;
  const cutoff = fleet.clock() - REPLAY_HOURS * 3600;
  for (const file of files) {
    if (!existsSync(file)) continue;
    const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      let payload;
      try {
        msg = JSON.parse(line);
        payload = JSON.parse(msg.payload);
      } catch {
        broken += 1;
        continue;
      }
      if (!(msg.t >= cutoff)) continue;
      fleet.onMessage(vinOf(payload), payload.data ?? {}, msg.t);
      count += 1;
    }
  }
  const lastKm = Math.max(0, ...[...fleet.watchers.values()].map((watcher) => watcher.kmChangedAt));
  const lastKmText = lastKm ? new Date(lastKm * 1000).toTimeString().slice(0, 8) : 'none';
  log(`History loaded: ${count} messages${broken ? `, ${broken} broken lines skipped` : ''}. Last odometer increase: ${lastKmText}.`);
  return { count, broken };
}

// systemd watchdog (WatchdogSec in deploy/mini-watch.service). The program sends "WATCHDOG=1" while
// the main loop runs. If the loop stops for PROGRESS_LIMIT_S, the pings stop and systemd restarts the service.
let lastProgress = Date.now();
const heartbeat = () => {
  lastProgress = Date.now();
};

function startWatchdog() {
  const usec = Number(process.env.WATCHDOG_USEC);
  if (!process.env.NOTIFY_SOCKET || !usec) return;
  let failedOnce = false;
  const timer = setInterval(() => {
    if (Date.now() - lastProgress > PROGRESS_LIMIT_S * 1000) return;
    execFile('systemd-notify', ['WATCHDOG=1'], (err) => {
      if (err && !failedOnce) log(`Watchdog ping failed: ${err.message}`);
      failedOnce ||= Boolean(err);
    });
  }, Math.max(1000, usec / 1000 / 3));
  timer.unref();
}

async function run(cfg) {
  // With the default service (ntfy) the log does not change. With Pushover it says so once at the start.
  if (cfg.notify_service === 'pushover') log('Notification service: Pushover.');
  const fleet = new Fleet(cfg, { stateFile: STATE });
  fleet.loadSnapshot();
  await replayRecent(fleet);
  const loaded = fleet.loadNotifyState();
  if (loaded.length) {
    const parts = loaded.map((vin) => [...fleet.watcher(vin).notified].map((name) => label(name, cfg)).join(', ') || 'empty');
    log(`Notification state loaded: ${parts.join(' | ')}.`);
  }
  const history = new History();
  startWatchdog();
  const stop = () => {
    fleet.save(true); // Keep the open parts for the next start.
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  let failures = 0; // Count of short connections in a row
  for (;;) {
    heartbeat();
    let tokens;
    try {
      tokens = await getTokens(cfg);
    } catch (err) {
      log(`Token error: ${err.message}`);
      await sleep(300_000);
      continue;
    }
    const { gcid } = tokens;
    const client = mqtt.connect({
      protocol: 'mqtts',
      host: MQTT_HOST,
      port: MQTT_PORT,
      username: gcid,
      password: tokens.id_token,
      clientId: `cardata-notification-${randomBytes(4).toString('hex')}`,
      keepalive: 30, // The broker closes a connection with a 60 second keepalive.
      reconnectPeriod: 0, // The outer loop reconnects.
      rejectUnauthorized: true,
    });
    const startedAt = now();
    let subscribed = false; // A connection without a subscription gets no data. It does not count as healthy.
    let closed = false;
    let onClosed;
    const closedSignal = new Promise((resolve) => {
      onClosed = resolve;
    });
    client.on('connect', () => {
      log('Connected to the stream.');
      client.subscribe(`${gcid}/+`, { qos: 0 }, (err, granted) => {
        if (err || !granted?.length) {
          // Without a subscription no message comes. Close the connection. The outer loop connects again.
          log(`Subscribe error: ${err?.message ?? 'no topic granted'}. Reconnecting.`);
          client.end(true);
          return;
        }
        subscribed = true;
        log(`Subscribed: ${granted.map((g) => `qos${g.qos}`).join(',')}`);
      });
    });
    client.on('message', (topic, payload) => {
      const msg = parseStreamMessage(topic, payload);
      if (msg.error && !msg.raw) {
        log(`A stream message was skipped: ${msg.error}.`);
        return;
      }
      history.append(msg.raw);
      if (msg.error) return;
      log(`Message: ${Object.keys(msg.data).sort().join(', ').slice(0, 200)}`);
      fleet.onMessage(msg.vin, msg.data);
    });
    client.on('error', (err) => log(`MQTT error: ${err.message}`));
    client.on('close', () => {
      closed = true;
      log('Connection closed.');
      onClosed();
    });

    while (!closed && tokens.id_expires_at - now() > TOKEN_MARGIN_S) {
      await Promise.race([sleep(fleet.nextCheckDelayMs()), closedSignal]); // On a close, do not wait the full time.
      heartbeat();
      if (!closed) await fleet.check();
    }
    client.end(true);

    // After a healthy connection (2 minutes or more) reconnect fast. After repeated short connections
    // the wait doubles from 5 to 60 seconds. BMW limits many connection attempts in a short time.
    const healthy = subscribed && now() - startedAt >= HEALTHY_CONNECTION_S;
    failures = healthy ? 0 : failures + 1;
    const delay = Math.min(RECONNECT_MIN_S * 2 ** failures, RECONNECT_MAX_S);
    log(`Reconnecting in ${delay} seconds.`);
    await sleep(delay * 1000);
  }
}

// ---- doctor: checks the setup and prints one line for each check. It sends no notification. ----

const modeText = (path) => (statSync(path).mode & 0o777).toString(8).padStart(3, '0');
const timeText = (seconds) => new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

function lastLineTime(file) {
  const size = statSync(file).size;
  if (size === 0) return null;
  const length = Math.min(size, 8192);
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  const lines = buffer.toString('utf8').trim().split('\n').reverse();
  for (const line of lines) {
    try {
      return JSON.parse(line).t;
    } catch {
      // Look at the line before.
    }
  }
  return null;
}

function tlsCheck(host, port) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, timeout: HTTP_TIMEOUT_MS }, () => {
      const protocol = socket.getProtocol();
      socket.end();
      resolve(protocol);
    });
    socket.on('timeout', () => socket.destroy(new Error('timeout')));
    socket.on('error', reject);
  });
}

async function doctor({ offline = false } = {}) {
  let failed = false;
  const report = (level, text) => {
    console.log(`${level.padEnd(4)} ${text}`);
    if (level === 'FAIL') failed = true;
  };
  const privateFile = (path) => {
    if (existsSync(path) && Number.parseInt(modeText(path), 8) & 0o077) report('WARN', `${path} has mode ${modeText(path)}. Use 600.`);
  };

  const major = Number(process.versions.node.split('.')[0]);
  report(major >= 22 ? 'OK' : 'FAIL', `Node ${process.versions.node}, OpenSSL ${process.versions.openssl} (Node 22 or newer is needed)`);

  report('OK', `Data folder: ${DATA_DIR}`);
  if (Number.parseInt(modeText(DATA_DIR), 8) & 0o077 && DATA_DIR !== HERE) {
    report('WARN', `The data folder has mode ${modeText(DATA_DIR)}. Use 700.`);
  }

  let cfg = null;
  try {
    cfg = loadConfig();
    report('OK', 'config.json is valid.');
    requireClientId(cfg);
    if (cfg.notify_service === 'pushover') {
      // loadConfig() checked the form of the Pushover keys. The lines do not show the keys.
      report('OK', 'client_id is set.');
      report('OK', 'Notification service: Pushover. pushover_token and pushover_user have the right form.');
      // Pushover does not need the topic. A release before Pushover (install.sh --rollback) and ntfy-test need it.
      try {
        checkTopic(cfg);
      } catch {
        report('WARN', 'ntfy_topic is empty or not valid. Keep a valid ntfy_topic in config.json: ntfy-test and a rollback to a release before Pushover need it.');
      }
    } else {
      checkTopic(cfg);
      report('OK', 'client_id and ntfy_topic are set.');
    }
  } catch (err) {
    report('FAIL', err.message);
  }
  privateFile(CONFIG);

  if (!existsSync(TOKENS)) {
    report('FAIL', `${TOKENS} not found. Log in first (docs/en/04-server-setup.md, part 7).`);
  } else {
    try {
      const tokens = JSON.parse(readFileSync(TOKENS, 'utf8'));
      if (!tokens.refresh_token || !tokens.gcid) report('FAIL', 'tokens.json has no refresh token or GCID. Log in again.');
      else report('OK', `tokens.json is complete. The ID token is valid until ${timeText(tokens.id_expires_at)}. The service refreshes it.`);
    } catch (err) {
      report('FAIL', `tokens.json cannot be read: ${err.message}`);
    }
    privateFile(TOKENS);
  }

  if (existsSync(STATE)) {
    try {
      const state = JSON.parse(readFileSync(STATE, 'utf8'));
      const cars = state.vehicles ? Object.keys(state.vehicles).length : 1;
      report('OK', `state.json (version ${state.version ?? 1}) saved at ${timeText(state.savedAt)}, ${cars} car(s).`);
    } catch (err) {
      report('WARN', `state.json cannot be read: ${err.message}. The program starts without it.`);
    }
  } else {
    report('OK', 'No state.json yet. The service makes it.');
  }

  const files = [`${MESSAGES}.1`, MESSAGES].filter(existsSync);
  if (files.length === 0) {
    report('WARN', 'No car message yet. Open and close a door to wake the car.');
  } else {
    const megabytes = files.reduce((sum, file) => sum + statSync(file).size, 0) / 1e6;
    const last = lastLineTime(files[files.length - 1]);
    const hours = last ? (now() - last) / 3600 : null;
    report('OK', `History: ${megabytes.toFixed(1)} MB. Last car message: ${last ? `${timeText(last)} (${hours.toFixed(1)} hours ago)` : 'none'}.`);
    files.forEach(privateFile);
  }

  try {
    const disk = statfsSync(DATA_DIR);
    const freeMb = (disk.bavail * disk.bsize) / 1e6;
    report(freeMb > 500 ? 'OK' : 'WARN', `Free disk space: ${Math.round(freeMb)} MB.`);
  } catch (err) {
    report('WARN', `Free disk space unknown: ${err.message}`);
  }

  if (offline) return failed ? 1 : 0;

  if (cfg) {
    // With Pushover the service does not use ntfy, so an ntfy problem is a warning. With ntfy nothing changes.
    const pushoverOn = cfg.notify_service === 'pushover';
    const ntfyProblem = pushoverOn ? 'WARN' : 'FAIL';
    const ntfyNote = pushoverOn ? ' The service uses Pushover now, so this is a warning only.' : '';
    try {
      const resp = await fetch(new URL('/v1/health', cfg.ntfy_server), { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      await resp.body?.cancel();
      report(resp.ok ? 'OK' : ntfyProblem, `ntfy server ${cfg.ntfy_server}: HTTP ${resp.status}.${resp.ok ? '' : ntfyNote}`);
    } catch (err) {
      // With Pushover the error text gets a period before the note. With ntfy the line stays as before.
      const reason = pushoverOn ? `${String(err.message).replace(/\.+$/, '')}.` : err.message;
      report(ntfyProblem, `ntfy server ${cfg.ntfy_server} cannot be reached: ${reason}${ntfyNote}`);
    }
    // Only with notify_service "pushover". Pushover checks the token and the user key and sends no notification.
    if (cfg.notify_service === 'pushover') {
      const result = await validatePushover(cfg);
      report(result.ok ? 'OK' : 'FAIL', result.text);
    }
  }
  try {
    const protocol = await tlsCheck(MQTT_HOST, MQTT_PORT);
    report(protocol === 'TLSv1.3' ? 'OK' : 'FAIL', `BMW stream server: ${protocol}.`);
  } catch (err) {
    report('FAIL', `BMW stream server cannot be reached: ${err.message}`);
  }
  return failed ? 1 : 0;
}

async function main() {
  const command = process.argv[2];
  if (command === 'doctor') process.exit(await doctor({ offline: process.argv.includes('--offline') }));
  try {
    const cfg = loadConfig();
    if (command === 'login' || command === 'run') requireClientId(cfg);
    // With Pushover, "run" needs no ntfy topic. ntfy-test and ntfy-check always need it.
    if ((command === 'run' && cfg.notify_service !== 'pushover') || command === 'ntfy-test' || command === 'ntfy-check') checkTopic(cfg);
    // pushover-test works with each notify_service, so it checks the Pushover keys itself.
    if (command === 'pushover-test') checkPushover(cfg);
    if (command === 'run' && !existsSync(TOKENS)) {
      throw new Error(`${TOKENS} not found. Run the "login" command first (docs/en/04-server-setup.md, part 7).`);
    }
    if (command === 'login') await login(cfg);
    else if (command === 'run') await run(cfg);
    else if (command === 'ntfy-test') {
      const t = textFor(cfg);
      process.exit((await ntfy(cfg, t.testTitle, t.testBody, 'default', tagFor(cfg, 'test'))) ? 0 : 1);
    } else if (command === 'ntfy-check') {
      process.exit(await ntfyCheck(cfg, process.argv[3]));
    } else if (command === 'pushover-test') {
      // The same texts as ntfy-test. It sends a real notification through Pushover, whatever notify_service is.
      const t = textFor(cfg);
      const accepted = await pushover(cfg, t.testTitle, t.testBody, 'default', tagFor(cfg, 'test'));
      log(accepted ? 'Result: Pushover accepted the test notification. Check the phone.' : 'Result: Pushover did not accept the test notification. See the line above.');
      process.exit(accepted ? 0 : 1);
    } else {
      console.error('Usage: node mini_watch.mjs login | run | ntfy-test | ntfy-check <id> | pushover-test | doctor [--offline]');
      process.exit(2);
    }
  } catch (err) {
    console.error(err.message);
    // For ntfy-check, exit code 1 means "missing". An error there gives no conclusion: exit code 2.
    process.exit(command === 'ntfy-check' ? 2 : 1);
  }
}

// A test that imports this file does not start main(). The service starts the program through the
// symbolic link /opt/mini-watch/current, so compare the real paths.
const startedDirectly = () => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (startedDirectly()) await main();
