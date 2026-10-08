// Run with: npm test
// These tests use fake car data. They do not call BMW or ntfy.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  DEFAULT_CONFIG,
  Fleet,
  History,
  Watcher,
  checkConfig,
  checkTopic,
  formatTime,
  label,
  parseStreamMessage,
  readBody,
  replayRecent,
  tokenRecord,
  turkishFromSuffix,
} from '../mini_watch.mjs';

const KM = 'vehicle.vehicle.travelledDistance';
const TILT = 'vehicle.cabin.sunroof.tiltStatus';
const WIN = 'vehicle.cabin.window.row1.passenger.status';
const DRIVER_DOOR = 'vehicle.cabin.door.row1.driver.isOpen';
const IGNITION = 'vehicle.drivetrain.engine.isIgnitionOn';

const msg = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }]));
// Fake VINs. They do not match a real VIN pattern.
const VIN_A = 'TESTVIN0000000001';
const VIN_B = 'TESTVIN0000000002';
// One line of messages.jsonl, as the program writes it.
const line = (t, values, vin = VIN_A) => JSON.stringify({ t, payload: JSON.stringify({ vin, data: msg(values) }) });
const tempDir = () => mkdtempSync(join(tmpdir(), 'mini-watch-test-'));

// ntfy_topic is empty, so a notification goes to the log.
const baseConfig = { ...DEFAULT_CONFIG, language: 'en', timezone: 'UTC', ntfy_topic: '' };

async function logsDuring(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.slice(1).join(' '));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

// A watcher with a virtual clock. Times in these tests are in minutes.
function virtualWatcher(cfg = {}) {
  const box = { clock: 0 };
  const watcher = new Watcher({ ...DEFAULT_CONFIG, timezone: 'UTC', ...cfg }, { clock: () => box.clock, random: () => 0.5 });
  const at = (minute) => {
    box.clock = minute * 60;
    return box.clock;
  };
  return { watcher, at };
}

test('no notification while driving, one combined notification after the driver leaves', async () => {
  const { watcher, at } = virtualWatcher();
  watcher.onData(msg({ [KM]: 100, [TILT]: 'OPEN' }), at(0));
  watcher.onData(msg({ [WIN]: 'INTERMEDIATE' }), at(1));
  watcher.onData(msg({ [KM]: 101 }), at(3));
  at(14);
  assert.deepEqual(await logsDuring(() => watcher.check()), [], 'driving: silent');

  watcher.onData(msg({ [DRIVER_DOOR]: true }), at(15)); // the driver leaves the car
  at(25);
  const lines = await logsDuring(() => watcher.check());
  assert.equal(lines.length, 1, 'one combined notification');
  // The driver door is still open, so it is in the list too. The oldest open part comes first.
  assert.match(lines[0], /MINI left open: Open: sunroof \(tilted\) since 00:00, front right window since 00:01, front left door since 00:15/);
});

test('a new drive resets the notification memory', async () => {
  const { watcher, at } = virtualWatcher();
  watcher.onData(msg({ [KM]: 100, [TILT]: 'OPEN' }), at(0));
  watcher.onData(msg({ [KM]: 101 }), at(3));
  watcher.onData(msg({ [DRIVER_DOOR]: true }), at(4));
  at(14);
  assert.equal((await logsDuring(() => watcher.check())).length, 1);
  assert.equal((await logsDuring(() => watcher.check())).length, 0, 'no repeat');
  watcher.onData(msg({ [KM]: 102 }), at(20)); // the car drives again
  watcher.onData(msg({ [DRIVER_DOOR]: true }), at(21));
  at(31);
  assert.equal((await logsDuring(() => watcher.check())).length, 1, 'new park, new notification');
});

test('the car counts as parked when the odometer stays still', async () => {
  const { watcher, at } = virtualWatcher();
  watcher.onData(msg({ [KM]: 100, [WIN]: 'OPEN' }), at(0));
  watcher.onData(msg({ [KM]: 101 }), at(3));
  at(32);
  assert.equal((await logsDuring(() => watcher.check())).length, 0, 'the odometer rose 29 minutes ago');
  at(34);
  assert.equal((await logsDuring(() => watcher.check())).length, 1, 'idle time is over');
});

test('without odometer data a part that stays open triggers a notification', async () => {
  const { watcher, at } = virtualWatcher();
  watcher.onData(msg({ [WIN]: 'OPEN' }), at(0));
  at(10);
  assert.equal((await logsDuring(() => watcher.check())).length, 1);
});

test('ignition data stops notifications while the ignition is on', async () => {
  const { watcher, at } = virtualWatcher();
  watcher.onData(msg({ [WIN]: 'OPEN', [IGNITION]: true }), at(0));
  at(30);
  assert.equal((await logsDuring(() => watcher.check())).length, 0);
});

test('"everything is closed" goes out once after an alert', async () => {
  const { watcher, at } = virtualWatcher();
  watcher.onData(msg({ [WIN]: 'OPEN' }), at(0));
  at(10);
  await logsDuring(() => watcher.check());
  watcher.onData(msg({ [WIN]: 'CLOSED' }), at(11));
  const lines = await logsDuring(() => watcher.check());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /MINI: Everything is closed\./);
  assert.equal((await logsDuring(() => watcher.check())).length, 0, 'only once');
});

test('missing data after a restart does not count as closed', async () => {
  const { watcher, at } = virtualWatcher();
  watcher.alerted = true; // state loaded from disk: an alert went out before the restart
  assert.equal((await logsDuring(() => watcher.check())).length, 0, 'no data yet, no "closed" message');
  watcher.onData(msg({ [WIN]: 'OPEN' }), at(1));
  watcher.onData(msg({ [WIN]: 'CLOSED' }), at(2)); // now the program sees a real close
  const lines = await logsDuring(() => watcher.check());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Everything is closed\./);
});

test('Turkish text with language "tr"', async () => {
  const { watcher, at } = virtualWatcher({ language: 'tr' });
  watcher.onData(msg({ [WIN]: 'OPEN', [TILT]: 'OPEN' }), at(0));
  at(10);
  const lines = await logsDuring(() => watcher.check());
  assert.match(lines[0], /MINI açık kaldı: Açık: sağ ön cam 00:00'dan beri, cam tavan \(aralık\) 00:00'dan beri/);
});

test('label names the part in both languages', () => {
  assert.equal(label('vehicle.cabin.door.row2.driver.isOpen'), 'rear left door');
  assert.equal(label('vehicle.cabin.door.row2.driver.isOpen', { language: 'tr' }), 'sol arka kapı');
  assert.equal(label('vehicle.body.trunk.isOpen'), 'trunk');
  assert.equal(label('vehicle.body.hood.isOpen'), 'hood');
});

const at = (hour, minute) => Date.UTC(2020, 0, 6, hour, minute) / 1000;

test('the notification names the time each part opened, oldest first', async () => {
  const watcher = new Watcher(baseConfig);
  watcher.onData(msg({ [WIN]: 'OPEN' }), at(13, 50));
  watcher.onData(msg({ [TILT]: 'OPEN' }), at(13, 48));
  const lines = await logsDuring(() => watcher.check());
  assert.match(lines[0], /MINI left open: Open: sunroof \(tilted\) since 6 Jan 13:48, front right window since 6 Jan 13:50/);
});

test('Turkish notification has the time with the right suffix', async () => {
  const watcher = new Watcher({ ...baseConfig, language: 'tr' });
  watcher.onData(msg({ [WIN]: 'OPEN' }), at(13, 50));
  watcher.onData(msg({ [TILT]: 'OPEN' }), at(13, 48));
  const lines = await logsDuring(() => watcher.check());
  assert.match(lines[0], /cam tavan \(aralık\) .*13:48'den beri, sağ ön cam .*13:50'den beri/);
});

test('formatTime shows only the time for today and a date for an earlier day', () => {
  const cfg = { timezone: 'UTC', language: 'en' };
  assert.equal(formatTime(at(13, 50), cfg, at(15, 0)), '13:50');
  assert.equal(formatTime(at(13, 50), cfg, at(15, 0) + 86400), '6 Jan 13:50');
});

test('formatTime uses the time zone of the config', () => {
  assert.equal(formatTime(at(13, 50), { timezone: 'Europe/Istanbul', language: 'en' }, at(14, 0)), '16:50');
});

test('Turkish time suffix follows the last spoken word', () => {
  const cases = {
    '13:50': 'den', // elli
    '13:40': 'tan', // kırk
    '13:30': 'dan', // otuz
    '13:20': 'den', // yirmi
    '13:10': 'dan', // on
    '13:01': 'den', // bir
    '13:02': 'den', // iki
    '13:03': 'ten', // üç
    '13:04': 'ten', // dört
    '13:05': 'ten', // beş
    '13:06': 'dan', // altı
    '13:07': 'den', // yedi
    '13:08': 'den', // sekiz
    '13:09': 'dan', // dokuz
    '13:00': 'ten', // on üç (hour)
    '10:00': 'dan', // on (hour)
    '06:00': 'dan', // altı (hour)
  };
  for (const [time, suffix] of Object.entries(cases)) assert.equal(turkishFromSuffix(time), suffix, time);
  assert.equal(turkishFromSuffix('6 Eki 13:50'), 'den', 'a date before the time does not matter');
});

// ---- Scenarios from real drives, with a virtual clock. Times are in minutes. ----
// The default config applies: wait 10 minutes after parking, idle limit 30 minutes, reminders 60 to 480 minutes.

const DOOR_OPEN = { [DRIVER_DOOR]: true };
const DOOR_CLOSED = { [DRIVER_DOOR]: false };

// Runs the watcher from minute `from` to minute `to`. `events` is a list of [minute, values].
// Returns the notifications as [minute, text].
async function simulate(events, from, to, cfg = {}) {
  let clock = 0;
  const watcher = new Watcher({ ...DEFAULT_CONFIG, timezone: 'UTC', ...cfg }, { clock: () => clock });
  const sent = [];
  const original = console.log;
  console.log = (...args) => sent.push([Math.round((clock / 60) * 4) / 4, args.slice(1).join(' ')]);
  try {
    const queue = [...events].sort((a, b) => a[0] - b[0]);
    for (let minute = from; minute <= to; minute += 0.25) {
      clock = minute * 60;
      while (queue.length && queue[0][0] <= minute) {
        const [at, values] = queue.shift();
        watcher.onData(msg(values), at * 60);
      }
      await watcher.check();
    }
  } finally {
    console.log = original;
  }
  return sent;
}

// The odometer value at each minute of a drive: +1 every 3 minutes.
const drive = (fromMinute, toMinute, startKm) => {
  const events = [];
  for (let m = fromMinute, km = startKm; m <= toMinute; m += 3, km += 1) events.push([m, { [KM]: km }]);
  return events;
};

test('trip start: a part that opens before the first odometer value sends nothing', async () => {
  // Earlier park: last km at minute 0, driver left at minute 1. The driver gets in at minute 100.
  // The sunroof tilts at minute 100.5. The first new odometer value comes at minute 104.
  const events = [
    [0, { [KM]: 100 }],
    [1, DOOR_OPEN],
    [1.1, DOOR_CLOSED],
    [100, DOOR_OPEN],
    [100.1, DOOR_CLOSED],
    [100.5, { [TILT]: 'OPEN' }],
    ...drive(104, 130, 101),
  ];
  assert.deepEqual(await simulate(events, 99, 130), []);
});

test('traffic jam: the odometer stops for 13 minutes, no notification', async () => {
  const events = [
    [0, { [KM]: 100, [WIN]: 'OPEN' }],
    [0.5, DOOR_OPEN],
    [0.6, DOOR_CLOSED],
    ...drive(4, 10, 101), // km 101 to 103
    ...drive(23, 40, 104), // 13 minutes without a new value, then the drive goes on
  ];
  assert.deepEqual(await simulate(events, 0, 40), []);
});

test('sitting in the car: window opened and closed before leaving, no notification', async () => {
  const events = [
    [0, { [KM]: 100 }],
    [10, DOOR_OPEN],
    [10.1, DOOR_CLOSED],
    [11, { [WIN]: 'OPEN' }],
    [15, DOOR_OPEN], // the driver leaves
    [15.2, DOOR_CLOSED],
    [16, { [WIN]: 'CLOSED' }],
  ];
  assert.deepEqual(await simulate(events, 0, 60), []);
});

test('real park: one notification 10 minutes after the driver door opens', async () => {
  const events = [
    [0, { [KM]: 100, [TILT]: 'OPEN' }],
    [0.5, DOOR_OPEN],
    [0.6, DOOR_CLOSED],
    ...drive(4, 22, 101),
    [23, DOOR_OPEN], // park and leave
    [23.2, DOOR_CLOSED],
  ];
  const sent = await simulate(events, 0, 60);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 33);
  assert.match(sent[0][1], /MINI left open: Open: sunroof \(tilted\)/);
});

test('reminders wait longer each time: 60, 120, 240, 480 minutes', async () => {
  const events = [[0, { [KM]: 100, [TILT]: 'OPEN' }], [1, DOOR_OPEN], [1.1, DOOR_CLOSED]];
  const sent = await simulate(events, 0, 16 * 60);
  assert.deepEqual(
    sent.map(([minute]) => minute),
    [11, 71, 191, 431, 911],
  );
  assert.match(sent[0][1], /MINI left open/);
  for (const [, text] of sent.slice(1)) assert.match(text, /MINI still open/);
});

// ---- Failed notifications, unknown values, settings and history (static analysis findings F-01, F-03, F-04, F-06, F-13) ----

// Replaces fetch with a fake ntfy server. `answers` is a list of HTTP status codes or 'throw'. The last answer repeats.
async function withFakeNtfy(answers, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const answer = answers[Math.min(calls.length, answers.length - 1)];
    calls.push(JSON.parse(options.body));
    if (answer === 'throw') throw new Error('connection refused');
    return { ok: answer >= 200 && answer < 300, status: answer };
  };
  try {
    await logsDuring(fn);
  } finally {
    globalThis.fetch = original;
  }
  return calls;
}

const ntfyConfig = { ...DEFAULT_CONFIG, timezone: 'UTC', alert_after_min: 0, ntfy_topic: 'mini-0123456789abcdef01', ntfy_server: 'https://ntfy.invalid' };

test('a failed notification is sent again later and the state waits for success', async () => {
  let clock = 1000;
  const watcher = new Watcher(ntfyConfig, { clock: () => clock, random: () => 0.5 });
  watcher.onData(msg({ [WIN]: 'OPEN' }), clock);
  const calls = await withFakeNtfy([500, 'throw', 200], async () => {
    await watcher.check(); // HTTP 500
    assert.equal(watcher.alerted, false, 'no alert is recorded after a failure');
    assert.equal(watcher.notified.size, 0);
    clock += 10;
    await watcher.check(); // still in the 30 second wait: no try
    clock += 30;
    await watcher.check(); // connection error, the next wait is 60 seconds
    clock += 59;
    await watcher.check(); // still waiting
    clock += 2;
    await watcher.check(); // HTTP 200
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].title, 'MINI left open', 'the retry is the first alert, not a reminder');
  assert.equal(watcher.alerted, true);
  assert.equal(watcher.notifyFailures, 0);
});

test('no "everything is closed" when the alert never reached the phone', async () => {
  let clock = 1000;
  const watcher = new Watcher(ntfyConfig, { clock: () => clock, random: () => 0.5 });
  watcher.onData(msg({ [WIN]: 'OPEN' }), clock);
  const calls = await withFakeNtfy(['throw', 200], async () => {
    await watcher.check(); // the alert fails
    watcher.onData(msg({ [WIN]: 'CLOSED' }), clock + 5);
    clock += 600;
    await watcher.check(); // everything is closed, but no alert went out
  });
  assert.equal(calls.length, 1, 'only the failed alert');
});

test('"everything is closed" is sent again when it fails', async () => {
  let clock = 1000;
  const watcher = new Watcher(ntfyConfig, { clock: () => clock, random: () => 0.5 });
  watcher.onData(msg({ [WIN]: 'OPEN' }), clock);
  const calls = await withFakeNtfy([200, 503, 200], async () => {
    await watcher.check(); // alert sent
    watcher.onData(msg({ [WIN]: 'CLOSED' }), clock + 5);
    clock += 10;
    await watcher.check(); // "closed" fails
    clock += 31;
    await watcher.check(); // "closed" sent
    clock += 31;
    await watcher.check(); // nothing more
  });
  assert.deepEqual(calls.map((call) => call.title), ['MINI left open', 'MINI', 'MINI']);
  assert.equal(watcher.alerted, false);
});

test('an unknown or empty value does not close an open part', async () => {
  const watcher = new Watcher(baseConfig);
  const lines = await logsDuring(async () => {
    watcher.onData(msg({ [WIN]: 'OPEN' }));
    watcher.onData(msg({ [WIN]: 'UNKNOWN' }));
    watcher.onData(msg({ [WIN]: null }));
    watcher.onData({ [WIN]: {} });
    watcher.onData(msg({ [WIN]: 'UNKNOWN' })); // a second time: no new log line
  });
  assert.equal(watcher.openSince.has(WIN), true);
  assert.equal(watcher.sawClose, false);
  assert.equal(lines.filter((line) => line.startsWith('Unknown value')).length, 2, 'one log line for each new value');
  watcher.onData(msg({ [WIN]: 'CLOSED' }));
  assert.equal(watcher.openSince.has(WIN), false, 'CLOSED still closes');
});

test('the door lock status is not an open part', async () => {
  const watcher = new Watcher(baseConfig);
  const lines = await logsDuring(async () => {
    watcher.onData(msg({ 'vehicle.cabin.door.status': 'UNLOCKED' }));
    watcher.onData(msg({ 'vehicle.cabin.door.status': 'SECURED' }));
  });
  assert.equal(watcher.openSince.size, 0);
  assert.deepEqual(lines, [], 'no "unknown value" log line');
});

test('checkTopic refuses an empty, example or short topic', () => {
  for (const topic of ['', 'YOUR-RANDOM-TOPIC-NAME', 'mini-your-long-random-name', 'mini-abc123']) {
    assert.throws(() => checkTopic({ ntfy_topic: topic }), /ntfy_topic/, topic);
  }
  checkTopic({ ntfy_topic: 'mini-3f9a1c7e2b5d8e0a4c' }); // the format from docs/en/03-ntfy.md
});

test('checkConfig refuses a bad number of minutes', () => {
  checkConfig({ ...DEFAULT_CONFIG });
  checkConfig({ ...DEFAULT_CONFIG, alert_after_min: 0 });
  for (const [key, value] of [
    ['alert_after_min', -1],
    ['remind_every_min', 0],
    ['remind_every_min', '60'],
    ['park_after_idle_min', Number.NaN],
    ['remind_max_min', 99999],
  ]) {
    assert.throws(() => checkConfig({ ...DEFAULT_CONFIG, [key]: value }), new RegExp(key), `${key}=${value}`);
  }
});

test('the history replay skips broken lines and keeps the others', async () => {
  const clock = 100_000;
  const file = join(mkdtempSync(join(tmpdir(), 'mini-watch-test-')), 'messages.jsonl');
  writeFileSync(
    file,
    [
      line(clock - 30 * 3600, { [TILT]: 'OPEN' }), // older than 24 hours: not used
      line(clock - 3600, { [WIN]: 'OPEN' }),
      '{"t": 99000, "payload": "{broken',
      line(clock - 1800, { [KM]: 100 }),
      '{"t": 99',
    ].join('\n'),
  );
  const fleet = new Fleet(baseConfig, { clock: () => clock });
  let result;
  await logsDuring(async () => {
    result = await replayRecent(fleet, [file]);
  });
  assert.deepEqual(result, { count: 2, broken: 2 });
  const watcher = fleet.watcher(VIN_A);
  assert.equal(watcher.openSince.has(WIN), true);
  assert.equal(watcher.openSince.has(TILT), false);
  assert.equal(watcher.lastKm, 100);
});

// ---- More cars, restarts, history files, tokens, silence and doctor (findings F-02, F-05, F-06, F-07, F-08, F-13, F-14) ----

test('two cars: the parts do not mix and the title names the car', async () => {
  let clock = 0;
  const fleet = new Fleet({ ...baseConfig, vehicle_names: { [VIN_A]: 'Countryman' } }, { clock: () => clock, random: () => 0.5 });
  fleet.onMessage(VIN_A, msg({ [WIN]: 'OPEN' }), 0);
  fleet.onMessage(VIN_B, msg({ [WIN]: 'CLOSED', [TILT]: 'OPEN' }), 60);
  assert.equal(fleet.watcher(VIN_A).openSince.has(WIN), true, 'a close of car B does not close car A');
  fleet.onMessage(VIN_B, msg({ [KM]: 5 }), 61);
  fleet.onMessage(VIN_B, msg({ [KM]: 6 }), 120); // car B drives
  clock = 11 * 60;
  const lines = await logsDuring(() => fleet.check());
  assert.equal(lines.length, 1, 'car B drives: only car A sends');
  assert.match(lines[0], /MINI left open \(Countryman\): Open: front right window/);
  clock = 60 * 60; // car B is parked now
  const later = await logsDuring(() => fleet.check());
  assert.equal(later.length, 1);
  assert.match(later[0], /MINI left open \(…0002\): Open: sunroof \(tilted\)/);
});

test('a restart keeps a part that is open for more than 24 hours, without a new alert', async () => {
  const dir = tempDir();
  const stateFile = join(dir, 'state.json');
  const historyFile = join(dir, 'messages.jsonl');
  const opened = 1_000_000;
  let clock = opened;
  const first = new Fleet(baseConfig, { clock: () => clock, stateFile, random: () => 0.5 });
  first.onMessage(VIN_A, msg({ [TILT]: 'OPEN' }), opened);
  writeFileSync(historyFile, `${line(opened, { [TILT]: 'OPEN' })}\n`);
  clock = opened + 30 * 3600; // the open message is now older than the 24 hour replay
  assert.equal((await logsDuring(() => first.check())).length, 1, 'the alert');
  clock += 60; // restart one minute later
  const second = new Fleet(baseConfig, { clock: () => clock, stateFile });
  assert.equal(second.loadSnapshot(), true);
  await logsDuring(() => replayRecent(second, [historyFile]));
  assert.deepEqual(second.loadNotifyState(), [VIN_A]);
  assert.equal(second.watcher(VIN_A).openSince.get(TILT), opened, 'the original time stays');
  assert.equal((await logsDuring(() => second.check())).length, 0, 'no repeated alert');
});

test('a saved state older than 24 hours is not used', () => {
  const dir = tempDir();
  const stateFile = join(dir, 'state.json');
  const clock = 1_000_000;
  const snap = { openSince: [[TILT, 1]], notified: [TILT], lastNotify: 1, reminders: 0, alerted: true, sawClose: false };
  writeFileSync(stateFile, JSON.stringify({ version: 2, savedAt: clock - 25 * 3600, vehicles: { [VIN_A]: snap } }));
  const fleet = new Fleet(baseConfig, { clock: () => clock, stateFile });
  assert.equal(fleet.loadSnapshot(), false);
  assert.deepEqual(fleet.loadNotifyState(), []);
  assert.equal(fleet.watchers.size, 0);
});

test('"everything is closed" survives a restart when ntfy failed before the restart', async () => {
  const dir = tempDir();
  const stateFile = join(dir, 'state.json');
  let clock = 0;
  const first = new Fleet(ntfyConfig, { clock: () => clock, stateFile, random: () => 0.5 });
  first.onMessage(VIN_A, msg({ [WIN]: 'OPEN' }), 0);
  clock = 600;
  await withFakeNtfy([200, 500], async () => {
    await first.check(); // the alert is sent
    first.onMessage(VIN_A, msg({ [WIN]: 'CLOSED' }), 610);
    clock = 620;
    await first.check(); // "closed" fails
  });
  first.save(true); // the service stops
  clock = 700;
  const second = new Fleet(ntfyConfig, { clock: () => clock, stateFile, random: () => 0.5 });
  second.loadSnapshot();
  await logsDuring(() => replayRecent(second, []));
  second.loadNotifyState();
  const calls = await withFakeNtfy([200], () => second.check());
  assert.deepEqual(calls.map((call) => call.title), ['MINI']);
});

test('the state file of an older version loads for the only car', async () => {
  const dir = tempDir();
  const stateFile = join(dir, 'state.json');
  const historyFile = join(dir, 'messages.jsonl');
  const clock = 1_000_000;
  writeFileSync(stateFile, JSON.stringify({ notified: [TILT], lastNotify: clock - 60, reminders: 1, alerted: true, savedAt: clock - 60 }));
  writeFileSync(historyFile, `${line(clock - 3600, { [TILT]: 'OPEN' })}\n`);
  const fleet = new Fleet(baseConfig, { clock: () => clock, stateFile });
  assert.equal(fleet.loadSnapshot(), false, 'no snapshot in version 1');
  await logsDuring(() => replayRecent(fleet, [historyFile]));
  assert.deepEqual(fleet.loadNotifyState(), [VIN_A]);
  assert.deepEqual([...fleet.watcher(VIN_A).notified], [TILT]);
  assert.equal(fleet.watcher(VIN_A).reminders, 1);
});

test('the history file moves to .1 when it is full, and the replay reads both files', async () => {
  const file = join(tempDir(), 'messages.jsonl');
  const clock = 100_000;
  const raw = (km) => JSON.stringify({ vin: VIN_A, data: msg({ [KM]: km }) });
  const lineBytes = Buffer.byteLength(`${JSON.stringify({ t: clock, payload: raw(100) })}\n`);
  const history = new History(file, Math.floor(lineBytes * 2.5));
  await logsDuring(() => {
    for (let i = 0; i < 4; i += 1) history.append(raw(100 + i), clock - 100 + i);
  });
  assert.equal(existsSync(`${file}.1`), true);
  assert.equal(readFileSync(`${file}.1`, 'utf8').trim().split('\n').length, 2);
  assert.ok(statSync(file).size <= lineBytes * 2.5);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const fleet = new Fleet(baseConfig, { clock: () => clock });
  let result;
  await logsDuring(async () => {
    result = await replayRecent(fleet, [`${file}.1`, file]);
  });
  assert.equal(result.count, 4);
  assert.equal(fleet.watcher(VIN_A).lastKm, 103);
});

test('a stream message: VIN from the payload or the topic, size limit, broken JSON', () => {
  const fromTopic = parseStreamMessage(`gcid/${VIN_B}`, Buffer.from(JSON.stringify({ data: msg({ [WIN]: 'OPEN' }) })));
  assert.equal(fromTopic.vin, VIN_B);
  assert.deepEqual(fromTopic.data, msg({ [WIN]: 'OPEN' }));
  assert.equal(parseStreamMessage('gcid/x', Buffer.from(JSON.stringify({ vin: VIN_A, data: {} }))).vin, VIN_A);
  const big = parseStreamMessage('gcid/x', Buffer.alloc(70 * 1024, 32));
  assert.ok(big.error && !big.raw, 'too large: not stored');
  const broken = parseStreamMessage('gcid/x', Buffer.from('{oops'));
  assert.equal(broken.error, 'not JSON');
  assert.equal(broken.raw, '{oops', 'broken JSON is stored for analysis');
});

test('tokens: a refresh without a new refresh token keeps the old one, the access token is not kept', () => {
  const old = { refresh_token: 'old-refresh', gcid: 'old-gcid' };
  const refreshed = tokenRecord({ id_token: 'new-id', access_token: 'not-used', expires_in: 3600 }, old, 1000);
  assert.deepEqual(refreshed, { refresh_token: 'old-refresh', id_token: 'new-id', gcid: 'old-gcid', id_expires_at: 4600 });
  const login = tokenRecord({ id_token: 'a', refresh_token: 'b', gcid: 'c' }, {}, 0);
  assert.deepEqual(login, { refresh_token: 'b', id_token: 'a', gcid: 'c', id_expires_at: 3600 });
});

test('readBody refuses an answer larger than the limit', async () => {
  assert.equal(await readBody(new Response('small'), 10), 'small');
  await assert.rejects(readBody(new Response('x'.repeat(100)), 10), /larger than 10 bytes/);
});

test('silence alert: one notification after the set time without data, again only after new data', async () => {
  let clock = 0;
  const fleet = new Fleet({ ...baseConfig, silence_alert_hours: 48 }, { clock: () => clock });
  fleet.onMessage(VIN_A, msg({ [WIN]: 'CLOSED' }), 0);
  clock = 47 * 3600;
  assert.equal((await logsDuring(() => fleet.check())).length, 0);
  clock = 49 * 3600;
  const lines = await logsDuring(() => fleet.check());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /MINI no data: No data from the car for 48 hours/);
  clock = 60 * 3600;
  assert.equal((await logsDuring(() => fleet.check())).length, 0, 'only once');
  fleet.onMessage(VIN_A, msg({ [WIN]: 'CLOSED' }), clock);
  clock += 49 * 3600;
  assert.equal((await logsDuring(() => fleet.check())).length, 1, 'again after new data and a new silence');

  const off = new Fleet(baseConfig, { clock: () => clock });
  off.onMessage(VIN_A, msg({ [WIN]: 'CLOSED' }), 0);
  assert.equal((await logsDuring(() => off.check())).length, 0, 'off by default');
});

test('checkConfig checks silence_alert_hours, vehicle_names and ntfy_server', () => {
  checkConfig({ ...DEFAULT_CONFIG, silence_alert_hours: 48, vehicle_names: { [VIN_A]: 'Countryman' } });
  for (const [key, value] of [
    ['silence_alert_hours', -1],
    ['silence_alert_hours', '48'],
    ['vehicle_names', []],
    ['vehicle_names', { [VIN_A]: 1 }],
    ['ntfy_server', 'ntfy.sh'],
  ]) {
    assert.throws(() => checkConfig({ ...DEFAULT_CONFIG, [key]: value }), new RegExp(key), `${key}=${JSON.stringify(value)}`);
  }
});

test('doctor --offline checks the files and finds a missing login', () => {
  const dir = tempDir();
  const script = fileURLToPath(new URL('../mini_watch.mjs', import.meta.url));
  const doctor = () => spawnSync(process.execPath, [script, 'doctor', '--offline'], { env: { ...process.env, MINI_WATCH_DATA: dir }, encoding: 'utf8' });
  const config = { client_id: '1a2b3c4d-1111-2222-3333-444455556666', ntfy_topic: 'mini-0123456789abcdef01' };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  const first = doctor();
  assert.equal(first.status, 1, first.stdout);
  assert.match(first.stdout, /^OK {3}config\.json is valid\./m);
  assert.match(first.stdout, /^FAIL .*tokens\.json not found/m);
  writeFileSync(join(dir, 'tokens.json'), JSON.stringify({ refresh_token: 'r', id_token: 'i', gcid: 'g', id_expires_at: 0 }), { mode: 0o600 });
  const second = doctor();
  assert.equal(second.status, 0, second.stdout);
  assert.match(second.stdout, /^OK {3}tokens\.json is complete/m);
});

test('with one car, state.json also has the fields of version 1 (for a rollback)', async () => {
  const stateFile = join(tempDir(), 'state.json');
  let clock = 0;
  const fleet = new Fleet(baseConfig, { clock: () => clock, stateFile });
  fleet.onMessage(VIN_A, msg({ [WIN]: 'OPEN' }), 0);
  clock = 600;
  await logsDuring(() => fleet.check());
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(state.version, 2);
  assert.deepEqual(state.notified, [WIN]);
  assert.equal(state.lastNotify, 600);
  assert.equal(state.alerted, true);
  assert.equal(state.reminders, 0);
  assert.equal(state.savedAt, 600);
});

// ---- Central lock (vehicle.cabin.door.status). Values from the tested car: UNLOCKED, LOCKED, SECURED. ----

const LOCK = 'vehicle.cabin.door.status';
const PASSENGER_DOOR = 'vehicle.cabin.door.row1.passenger.isOpen';
const TRUNK = 'vehicle.body.trunk.isOpen';
// A real drive of the tested car: unlock, get in, the car locks itself, drive, it unlocks at the end, get out, lock.
const lockedTrip = (extra = []) => [
  [0, { [KM]: 100, [TILT]: 'OPEN', [LOCK]: 'SECURED' }],
  [1, { [LOCK]: 'UNLOCKED' }],
  [1.5, DOOR_OPEN],
  [1.8, DOOR_CLOSED],
  [2, { [LOCK]: 'LOCKED' }],
  ...drive(6, 21, 101),
  [22, { [LOCK]: 'UNLOCKED' }],
  [23, DOOR_OPEN],
  [23.2, DOOR_CLOSED],
  [24, { [LOCK]: 'SECURED' }],
  ...extra,
];

test('lock: a part that is open when you lock the car gives a notification 2 minutes later', async () => {
  const sent = await simulate(lockedTrip(), 0, 40);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 26, 'SECURED at 24 + 2 minutes (without the lock: 23 + 10 = 33)');
  assert.match(sent[0][1], /MINI left open: Open: sunroof \(tilted\)/);
});

test('lock: the sunroof closes within 2 minutes after the lock (comfort close), no notification', async () => {
  assert.deepEqual(await simulate(lockedTrip([[25, { [TILT]: 'CLOSED' }]]), 0, 60), []);
});

test('lock: a part that opens after the lock follows the normal wait', async () => {
  const events = lockedTrip([[24.5, { [TILT]: 'CLOSED' }], [30, { [TRUNK]: true }]]);
  const sent = await simulate(events, 0, 60);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 40, 'trunk opened at 30 + 10 minutes');
  assert.match(sent[0][1], /trunk/);
});

test('lock: LOCKED while driving stops notifications, also without odometer data', async () => {
  const events = [
    [0, { [KM]: 100 }],
    [1, DOOR_OPEN],
    [1.1, DOOR_CLOSED],
    [1.3, { [LOCK]: 'LOCKED' }],
    [2, { [WIN]: 'OPEN' }], // no odometer value for an hour
    [61, { [LOCK]: 'UNLOCKED' }],
    [62, DOOR_OPEN],
    [62.2, DOOR_CLOSED],
  ];
  const sent = await simulate(events, 0, 80);
  assert.deepEqual(sent.map(([minute]) => minute), [72], 'only after the driver leaves (without the lock: minute 12)');
});

test('lock: LOCKED and then a passenger door opens, the car does not count as driving', async () => {
  const events = [
    [0, { [KM]: 100 }],
    [1, DOOR_OPEN],
    [1.1, DOOR_CLOSED],
    [1.3, { [LOCK]: 'LOCKED' }],
    [2, { [WIN]: 'OPEN' }],
    [5, { [PASSENGER_DOOR]: true }],
    [5.2, { [PASSENGER_DOOR]: false }],
  ];
  const sent = await simulate(events, 0, 30);
  assert.deepEqual(sent.map(([minute]) => minute), [12]);
});

test('lock: alert_after_lock_min must be a number of minutes', () => {
  checkConfig({ ...DEFAULT_CONFIG, alert_after_lock_min: 0 });
  assert.throws(() => checkConfig({ ...DEFAULT_CONFIG, alert_after_lock_min: -1 }), /alert_after_lock_min/);
});
