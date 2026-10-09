#!/usr/bin/env node
// Listens to the BMW/MINI CarData stream. Sends a phone notification through ntfy
// when a door, window, sunroof, trunk or hood stays open after you park.
//
//   node mini_watch.mjs login             # once: get a device code, approve it in the browser
//   node mini_watch.mjs run               # listen to the stream (runs forever)
//   node mini_watch.mjs ntfy-test         # send a test notification to the phone
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
const NOTIFY_RETRY_MIN_S = 30; // After a failed notification, try again after about 30, 60, 120 ... seconds.
const NOTIFY_RETRY_MAX_S = 600;
const STATE_VERSION = 2;
const SAVE_EVERY_S = 60; // Save the open parts at most once a minute. Save at once after a notification.
const PROGRESS_LIMIT_S = 600; // The watchdog ping stops when the main loop did not run for 10 minutes.
const EXAMPLE_TOPIC = 'mini-your-long-random-name'; // The example topic of older versions. Everybody knows it.
const MIN_TOPIC_LENGTH = 16;

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
    sunroof: 'sunroof',
    sunroofTilt: 'sunroof (tilted)',
    trunk: 'trunk',
    hood: 'hood',
    openTitle: 'MINI left open',
    stillOpenTitle: 'MINI still open',
    since: (time) => `since ${time}`,
    and: 'and',
    openBody: (items) => `Open: ${items}`,
    closedTitle: 'MINI',
    closedBody: 'Everything is closed.',
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
    sunroof: 'cam tavan',
    sunroofTilt: 'cam tavan (aralık)',
    trunk: 'bagaj',
    hood: 'kaput',
    openTitle: 'MINI açık kaldı',
    stillOpenTitle: 'MINI hâlâ açık',
    since: (time) => `${time}'${turkishFromSuffix(time)} beri`,
    and: 've',
    openBody: (items) => `Açık: ${items}`,
    closedTitle: 'MINI',
    closedBody: 'Her şey kapandı.',
    silenceTitle: 'MINI veri yok',
    silenceBody: (hours) => `Araçtan ${hours} saattir veri gelmiyor. Sunucuyu ve CarData portalını kontrol et.`,
    testTitle: 'MINI deneme',
    testBody: 'Bildirim çalışıyor.',
  },
};
const textFor = (cfg) => TEXT[cfg.language] ?? TEXT.en;
// "a", "a and b", "a, b and c"
const joinList = (items, word) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`);
// With more than one car, the title names the car: "MINI left open (Countryman)".
const withName = (title, name) => (name ? `${title} (${name})` : title);

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
  silence_alert_hours: 0, // 0 = off. Otherwise one notification when the car sends no data for this time.
  vehicle_names: {}, // {"VIN": "name"}. Only needed for an account with more than one car.
  ntfy_server: 'https://ntfy.sh',
  ntfy_topic: '',
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
  const hours = cfg.silence_alert_hours;
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0 || hours > MAX_SILENCE_HOURS) {
    throw new Error(`"silence_alert_hours" must be a number from 0 (off) to ${MAX_SILENCE_HOURS}. Now it is ${JSON.stringify(hours)}.`);
  }
  const names = cfg.vehicle_names;
  if (!names || typeof names !== 'object' || Array.isArray(names) || Object.values(names).some((name) => typeof name !== 'string')) {
    throw new Error('"vehicle_names" must look like {"VIN": "name"}.');
  }
  if (!/^https?:\/\/[^\s/]+/.test(String(cfg.ntfy_server))) {
    throw new Error(`"ntfy_server" must be an address like "https://ntfy.sh". Now it is ${JSON.stringify(cfg.ntfy_server)}.`);
  }
  const known = new Set([...Object.keys(DEFAULT_CONFIG), 'client_id']);
  const unknown = Object.keys(cfg).filter((key) => !known.has(key));
  if (unknown.length) log(`Warning: config.json has unknown settings: ${unknown.join(', ')}. The program ignores them.`);
  return cfg;
}

function loadConfig() {
  return checkConfig({ ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG, 'utf8')) });
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

// Reads an HTTP answer, but not more than `limit` bytes. A larger answer is an error.
export async function readBody(resp, limit = MAX_HTTP_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of resp.body ?? []) {
    size += chunk.length;
    if (size > limit) throw new Error(`The answer is larger than ${limit} bytes.`);
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

// A title in an HTTP header fails for letters outside Latin-1. A JSON body carries UTF-8.
// Returns true only when ntfy accepted the message (HTTP 2xx). An empty topic prints the text and returns true.
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
    await resp.body?.cancel(); // The program does not read the answer.
    log(resp.ok ? `Notification sent: ${text}` : `Notification failed: HTTP ${resp.status}`);
    return resp.ok;
  } catch (err) {
    log(`Notification failed: ${err.message}`);
    return false;
  }
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
// Order: the first part of each kind decides.
export function describeParts(names, cfg = {}) {
  const t = textFor(cfg);
  const entries = [];
  const positional = {};
  const seen = new Set();
  for (const name of names) {
    const found = /^vehicle\.cabin\.(window|door)\.(row\d\.(?:driver|passenger))\./.exec(name);
    if (found && t.positions[found[2]]) {
      const [, kind, key] = found;
      if (!positional[kind]) {
        positional[kind] = new Set();
        entries.push({ kind });
      }
      positional[kind].add(key);
    } else {
      const text = label(name, cfg);
      if (!seen.has(text)) {
        seen.add(text);
        entries.push({ text });
      }
    }
  }
  return joinList(entries.map((entry) => entry.text ?? positionalPhrase(entry.kind, positional[entry.kind], t)), t.and);
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
    this.returnedAt = 0; // someone came back to the car after a notification (0 after a drive)
    this.doorOpen = new Map(); // door attribute -> last value. The car repeats an open door in each message.
    this.lockStatus = null; // the last value of vehicle.cabin.door.status, or null
    this.lockChangedAt = 0;
    this.driveEndAt = 0; // time the lock left LOCKED (the car unlocks itself when you park)
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
      lastKm: this.lastKm,
      kmChangedAt: this.kmChangedAt,
      lastDriverDoorAt: this.lastDriverDoorAt,
      lastDoorAt: this.lastDoorAt,
      lastUnlockAt: this.lastUnlockAt,
      returnedAt: this.returnedAt,
      lockStatus: this.lockStatus,
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
    this.lastKm = snap.lastKm ?? null;
    this.kmChangedAt = snap.kmChangedAt ?? 0;
    this.lastDriverDoorAt = snap.lastDriverDoorAt ?? 0;
    this.lastDoorAt = snap.lastDoorAt ?? 0;
    this.lastUnlockAt = snap.lastUnlockAt ?? 0;
    this.returnedAt = snap.returnedAt ?? 0;
    this.lockStatus = snap.lockStatus ?? null;
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
          if (this.lockStatus === 'LOCKED') this.driveEndAt = at;
          if (status === 'LOCKED') this.parkLockAt = this.parkDoorAt = this.returnedAt = 0; // A drive starts.
          if (status === 'UNLOCKED') this.lastUnlockAt = at;
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
      if (!WATCHED.some((pattern) => pattern.test(name))) continue;
      const value = String(item?.value ?? '').toUpperCase();
      if (OPEN_VALUES.has(value)) {
        if (!this.openSince.has(name)) this.openSince.set(name, at);
      } else if (CLOSED_VALUES.has(value)) {
        if (this.openSince.delete(name)) this.sawClose = true;
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

  // A failed notification does not change the state. The next check sends it again, after a wait
  // that doubles each time: about 30 seconds up to 10 minutes. A random part of +-20 % spreads the tries.
  notifyResult(ok) {
    if (ok) {
      this.notifyFailures = 0;
      this.retryAt = 0;
      this.urgent = true;
      return true;
    }
    const base = Math.min(NOTIFY_RETRY_MIN_S * 2 ** this.notifyFailures, NOTIFY_RETRY_MAX_S);
    const wait = Math.round(base * (0.8 + 0.4 * this.random()));
    this.notifyFailures += 1;
    this.retryAt = this.clock() + wait;
    log(`The program tries the notification again in ${wait} seconds.`);
    return false;
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
      // Send "everything is closed" only after the program saw a part close.
      // After a restart, an empty list can mean "no data yet", not "closed".
      if (this.alerted && this.sawClose) {
        const sent = await ntfy(this.cfg, withName(t.closedTitle, this.name()), t.closedBody, 'default', 'white_check_mark');
        if (!this.notifyResult(sent)) return;
        this.alerted = false;
        this.sawClose = false;
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
      const items = [...groups].map(([when, names]) => `${describeParts(names, this.cfg)} ${when}`).join(', ');
      const title = withName(added ? t.openTitle : t.stillOpenTitle, this.name());
      const sent = await ntfy(this.cfg, title, t.openBody(items));
      if (!this.notifyResult(sent)) return;
      this.alerted = true;
      this.reminders = added ? 0 : this.reminders + 1;
      if (added) this.firstNotifyAt = this.clock();
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
    if (await ntfy(this.cfg, t.silenceTitle, t.silenceBody(hours), 'default', 'grey_question')) {
      this.silenceAlerted = true;
      this.dirty = true;
    } else {
      this.silenceRetryAt = this.clock() + NOTIFY_RETRY_MAX_S;
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
      await Promise.race([sleep(15_000), closedSignal]); // On a close, do not wait the full 15 seconds.
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
    checkTopic(cfg);
    report('OK', 'client_id and ntfy_topic are set.');
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
    try {
      const resp = await fetch(new URL('/v1/health', cfg.ntfy_server), { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      await resp.body?.cancel();
      report(resp.ok ? 'OK' : 'FAIL', `ntfy server ${cfg.ntfy_server}: HTTP ${resp.status}.`);
    } catch (err) {
      report('FAIL', `ntfy server ${cfg.ntfy_server} cannot be reached: ${err.message}`);
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
    if (command === 'run' || command === 'ntfy-test') checkTopic(cfg);
    if (command === 'run' && !existsSync(TOKENS)) {
      throw new Error(`${TOKENS} not found. Run the "login" command first (docs/en/04-server-setup.md, part 7).`);
    }
    if (command === 'login') await login(cfg);
    else if (command === 'run') await run(cfg);
    else if (command === 'ntfy-test') {
      const t = textFor(cfg);
      process.exit((await ntfy(cfg, t.testTitle, t.testBody, 'default', 'car')) ? 0 : 1);
    } else {
      console.error('Usage: node mini_watch.mjs login | run | ntfy-test | doctor [--offline]');
      process.exit(2);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
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
