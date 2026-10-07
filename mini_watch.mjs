#!/usr/bin/env node
// Listens to the BMW/MINI CarData stream. Sends a phone notification through ntfy
// when a door, window, sunroof, trunk or hood stays open after you park.
//
//   node mini_watch.mjs login      # once: get a device code, approve it in the browser
//   node mini_watch.mjs run        # listen to the stream (runs forever)
//   node mini_watch.mjs ntfy-test  # send a test notification to the phone
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mqtt from 'mqtt';

const HERE = dirname(fileURLToPath(import.meta.url));
// Settings and data. The systemd service sets STATE_DIRECTORY (/var/lib/mini-watch).
// The "mini-watch" command sets MINI_WATCH_DATA. Without both, the files are next to this program.
const DATA_DIR = process.env.MINI_WATCH_DATA || process.env.STATE_DIRECTORY || HERE;
const CONFIG = join(DATA_DIR, 'config.json');
const TOKENS = join(DATA_DIR, 'tokens.json');
const MESSAGES = join(DATA_DIR, 'messages.jsonl');
const STATE = join(DATA_DIR, 'state.json'); // Notification state. A restart must not repeat an alert.

const OAUTH = 'https://customer.bmwgroup.com/gcdm/oauth';
const SCOPE = 'authenticate_user openid cardata:streaming:read cardata:api:read';
const MQTT_HOST = 'customer.streaming-cardata.bmwgroup.com';
const MQTT_PORT = 9000;
const TOKEN_MARGIN_S = 300; // Refresh the token 5 minutes before it expires.
const HEALTHY_CONNECTION_S = 120;
const RECONNECT_MIN_S = 5;
const RECONNECT_MAX_S = 60;
const REPLAY_HOURS = 24;
const HTTP_TIMEOUT_MS = 15_000;
const NOTIFY_RETRY_MIN_S = 30; // After a failed notification, try again after 30, 60, 120 ... seconds.
const NOTIFY_RETRY_MAX_S = 600;
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
const DRIVING_STALE_S = 2 * 3600;

// Text that the user sees on the phone. Log lines are always in English.
const TEXT = {
  en: {
    positions: { 'row1.driver': 'front left', 'row1.passenger': 'front right', 'row2.driver': 'rear left', 'row2.passenger': 'rear right' },
    window: 'window',
    door: 'door',
    sunroof: 'sunroof',
    sunroofTilt: 'sunroof (tilted)',
    trunk: 'trunk',
    hood: 'hood',
    openTitle: 'MINI left open',
    stillOpenTitle: 'MINI still open',
    since: (time) => `since ${time}`,
    openBody: (items) => `Open: ${items}`,
    closedTitle: 'MINI',
    closedBody: 'Everything is closed.',
    testTitle: 'MINI test',
    testBody: 'Notifications work.',
  },
  tr: {
    positions: { 'row1.driver': 'sol ön', 'row1.passenger': 'sağ ön', 'row2.driver': 'sol arka', 'row2.passenger': 'sağ arka' },
    window: 'cam',
    door: 'kapı',
    sunroof: 'cam tavan',
    sunroofTilt: 'cam tavan (aralık)',
    trunk: 'bagaj',
    hood: 'kaput',
    openTitle: 'MINI açık kaldı',
    stillOpenTitle: 'MINI hâlâ açık',
    since: (time) => `${time}'${turkishFromSuffix(time)} beri`,
    openBody: (items) => `Açık: ${items}`,
    closedTitle: 'MINI',
    closedBody: 'Her şey kapandı.',
    testTitle: 'MINI deneme',
    testBody: 'Bildirim çalışıyor.',
  },
};
const textFor = (cfg) => TEXT[cfg.language] ?? TEXT.en;

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
  remind_every_min: 60,
  remind_max_min: 480,
  park_after_idle_min: 30,
  ntfy_server: 'https://ntfy.sh',
  ntfy_topic: '',
};

// Minutes settings: a number from 1 minute to 7 days. alert_after_min can also be 0 (no wait).
const MINUTE_SETTINGS = { alert_after_min: 0, remind_every_min: 1, remind_max_min: 1, park_after_idle_min: 1 };
const MAX_MINUTES = 7 * 24 * 60;

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

async function postForm(url, data) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(data),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await resp.text();
  try {
    return { ...JSON.parse(text), _status: resp.status };
  } catch {
    return { error: text.slice(0, 200), _status: resp.status };
  }
}

function saveTokens(resp) {
  const tokens = {
    access_token: resp.access_token,
    refresh_token: resp.refresh_token,
    id_token: resp.id_token,
    gcid: resp.gcid,
    id_expires_at: now() + Number(resp.expires_in ?? 3600),
  };
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
  return saveTokens(resp);
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

const parseBool = (value) => {
  const text = String(value ?? '').toUpperCase();
  if (text === 'TRUE') return true;
  if (text === 'FALSE') return false;
  return null; // unknown
};

export class Watcher {
  // clock: a function that returns the current time in seconds. Tests and replays pass their own clock.
  constructor(cfg, { persist = false, clock = now } = {}) {
    this.cfg = cfg;
    this.persist = persist; // Tests do not write to disk.
    this.clock = clock;
    this.openSince = new Map(); // attribute -> time it was first seen open
    this.notified = new Set();
    this.alerted = false; // Did at least one "left open" notification go out?
    this.sawClose = false; // Did the program see a part close? Missing data does not count as closed.
    this.lastNotify = 0;
    this.reminders = 0; // reminders sent since the last "left open" notification
    this.ignition = null; // true / false / null (unknown)
    this.moving = null;
    this.parkedSince = null; // time the car was first known to be parked
    this.drivingSeen = 0; // time of the last driving signal
    this.lastKm = null;
    this.kmChangedAt = 0; // time the odometer last increased
    this.lastDriverDoorAt = 0; // time the driver door last opened (to get in or to get out)
    this.notifyFailures = 0; // failed notifications in a row
    this.retryAt = 0; // after a failed notification, the next try waits until this time
    this.unknownSeen = new Set(); // unknown values that are already in the log
  }

  // Some cars (the tested Countryman E, U25) send no ignition or motion data.
  // The car sends the odometer about every 3 minutes while it moves, in whole kilometres.
  // driving = the odometer rose after the last driver door opening, and in the last park_after_idle_min.
  // The idle limit is long (30 minutes) because a traffic jam can stop the odometer for more than 10 minutes.
  // Ignition and motion data are used too when the car sends them. They count as stale after 2 hours.
  isDriving() {
    const ignitionDriving = this.ignition === true || this.moving === true;
    if (ignitionDriving && this.clock() - this.drivingSeen < DRIVING_STALE_S) return true;
    const idleLimit = this.cfg.park_after_idle_min * 60;
    return this.kmChangedAt > this.lastDriverDoorAt && this.clock() - this.kmChangedAt < idleLimit;
  }

  saveState() {
    if (!this.persist) return;
    const state = {
      notified: [...this.notified],
      lastNotify: this.lastNotify,
      reminders: this.reminders,
      alerted: this.alerted,
      savedAt: this.clock(),
    };
    writeFileAtomic(STATE, JSON.stringify(state));
  }

  // Ignore a saved state that is older than the last odometer increase (the car drove since)
  // or older than the replayed history (REPLAY_HOURS).
  loadState() {
    try {
      const state = JSON.parse(readFileSync(STATE, 'utf8'));
      if (state.savedAt < this.kmChangedAt || this.clock() - state.savedAt > REPLAY_HOURS * 3600) return false;
      this.notified = new Set(state.notified);
      this.lastNotify = state.lastNotify;
      this.reminders = state.reminders ?? 0;
      this.alerted = state.alerted;
      return true;
    } catch {
      return false;
    }
  }

  // The wait time starts at the later of: the last driver door opening, the last odometer increase.
  // The driver door also opens when the driver gets in. The car sends the first odometer value
  // 3 to 7 minutes after that. So the wait (alert_after_min, 10 minutes) must be longer than that.
  parkStart() {
    return Math.max(this.parkedSince ?? 0, this.lastDriverDoorAt, this.kmChangedAt);
  }

  // "at" is the time of the message. A replay at startup passes the original time.
  onData(data, at = this.clock()) {
    for (const [name, item] of Object.entries(data)) {
      if (name === IGNITION) this.ignition = parseBool(item?.value);
      else if (name === MOVING) this.moving = parseBool(item?.value);
      else if (name === ODOMETER) {
        const km = Number(item?.value);
        if (Number.isFinite(km)) {
          if (this.lastKm !== null && km > this.lastKm) {
            this.kmChangedAt = at;
            this.notified = new Set(); // A new park, a new notification.
            this.alerted = false;
            this.reminders = 0;
          }
          this.lastKm = km;
        }
      } else if (name === DRIVER_DOOR && parseBool(item?.value) === true) {
        this.lastDriverDoorAt = Math.max(this.lastDriverDoorAt, at);
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

  // A failed notification does not change the state. The next check sends it again,
  // after a wait that doubles each time: 30 seconds up to 10 minutes.
  notifyResult(ok) {
    if (ok) {
      this.notifyFailures = 0;
      this.retryAt = 0;
      return true;
    }
    const wait = Math.min(NOTIFY_RETRY_MIN_S * 2 ** this.notifyFailures, NOTIFY_RETRY_MAX_S);
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
    // The timer starts when the part opened or when the car parked, whichever is later.
    const current = new Set(
      [...this.openSince]
        .filter(([, since]) => this.clock() - Math.max(since, this.parkStart()) >= wait)
        .map(([name]) => name),
    );
    this.notified = new Set([...this.notified].filter((name) => this.openSince.has(name))); // Forget closed parts.
    if (this.openSince.size === 0) {
      // Send "everything is closed" only after the program saw a part close.
      // After a restart, an empty list can mean "no data yet", not "closed".
      if (this.alerted && this.sawClose) {
        const sent = await ntfy(this.cfg, t.closedTitle, t.closedBody, 'default', 'white_check_mark');
        if (!this.notifyResult(sent)) return;
        this.alerted = false;
        this.sawClose = false;
        this.saveState();
      }
      return;
    }
    if (current.size === 0) return; // A part is open but the wait time is not over.
    this.sawClose = false;
    const added = [...current].some((name) => !this.notified.has(name));
    // Each reminder waits twice as long as the one before: 60, 120, 240 minutes, up to remind_max_min.
    const interval = Math.min(this.cfg.remind_every_min * 2 ** this.reminders, this.cfg.remind_max_min) * 60;
    const remind = this.clock() - this.lastNotify >= interval;
    if (added || remind) {
      // The oldest open part comes first. Each part shows the time the program first saw it open.
      const items = [...current]
        .sort((a, b) => this.openSince.get(a) - this.openSince.get(b))
        .map((name) => `${label(name, this.cfg)} ${t.since(formatTime(this.openSince.get(name), this.cfg))}`)
        .join(', ');
      const sent = await ntfy(this.cfg, added ? t.openTitle : t.stillOpenTitle, t.openBody(items));
      if (!this.notifyResult(sent)) return;
      this.alerted = true;
      this.reminders = added ? 0 : this.reminders + 1;
      this.notified = current;
      this.lastNotify = this.clock();
      this.saveState();
    }
  }
}

// A restart must not lose the odometer and door history. Replay the messages of the last 24 hours.
// A broken line (for example the last line after a crash) is skipped. The other lines still count.
export function replayRecent(watcher, file = MESSAGES) {
  let count = 0;
  let broken = 0;
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // No file yet. Start with an empty state.
  }
  const cutoff = watcher.clock() - REPLAY_HOURS * 3600;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let msg;
    let data;
    try {
      msg = JSON.parse(line);
      data = JSON.parse(msg.payload).data ?? {};
    } catch {
      broken += 1;
      continue;
    }
    if (!(msg.t >= cutoff)) continue;
    watcher.onData(data, msg.t);
    count += 1;
  }
  const lastKm = watcher.kmChangedAt ? new Date(watcher.kmChangedAt * 1000).toTimeString().slice(0, 8) : 'none';
  log(`History loaded: ${count} messages${broken ? `, ${broken} broken lines skipped` : ''}. Last odometer increase: ${lastKm}.`);
  return { count, broken };
}

async function run(cfg) {
  const watcher = new Watcher(cfg, { persist: true });
  replayRecent(watcher);
  if (watcher.loadState()) {
    log(`Notification state loaded: ${[...watcher.notified].map((name) => label(name, cfg)).join(', ') || 'empty'}.`);
  }
  let failures = 0; // Count of short connections in a row
  for (;;) {
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
    client.on('message', (_topic, payload) => {
      const raw = payload.toString();
      appendFileSync(MESSAGES, `${JSON.stringify({ t: now(), payload: raw })}\n`, { mode: 0o600 });
      let data;
      try {
        data = JSON.parse(raw).data ?? {};
      } catch {
        return;
      }
      log(`Message: ${Object.keys(data).sort().join(', ').slice(0, 200)}`);
      watcher.onData(data);
    });
    client.on('error', (err) => log(`MQTT error: ${err.message}`));
    client.on('close', () => {
      closed = true;
      log('Connection closed.');
      onClosed();
    });

    while (!closed && tokens.id_expires_at - now() > TOKEN_MARGIN_S) {
      await Promise.race([sleep(15_000), closedSignal]); // On a close, do not wait the full 15 seconds.
      if (!closed) await watcher.check();
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

async function main() {
  const command = process.argv[2];
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
      await ntfy(cfg, t.testTitle, t.testBody, 'default', 'car');
    } else {
      console.error('Usage: node mini_watch.mjs login | run | ntfy-test');
      process.exit(2);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

// A test that imports this file does not start main().
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
