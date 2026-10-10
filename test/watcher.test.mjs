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
  describeParts,
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
  // The driver door is still open, so it is in the list too. Parts that were open during the drive
  // show the start of the park (the driver door at 00:15). The oldest open part still comes first.
  assert.match(lines[0], /MINI left open: Open: sunroof \(tilted\), front right window and front left door since 00:15$/);
});

test('a new drive resets the notification memory', async () => {
  const { watcher, at } = virtualWatcher();
  watcher.onData(msg({ [KM]: 100, [TILT]: 'OPEN' }), at(0));
  watcher.onData(msg({ [KM]: 101 }), at(3));
  watcher.onData(msg({ [DRIVER_DOOR]: true }), at(4));
  watcher.onData(msg({ [DRIVER_DOOR]: false }), at(4.5));
  at(14);
  assert.equal((await logsDuring(() => watcher.check())).length, 1);
  assert.equal((await logsDuring(() => watcher.check())).length, 0, 'no repeat');
  watcher.onData(msg({ [KM]: 102 }), at(20)); // the car drives again
  watcher.onData(msg({ [DRIVER_DOOR]: true }), at(21));
  watcher.onData(msg({ [DRIVER_DOOR]: false }), at(21.5));
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
  assert.match(lines[0], /MINI açık kaldı: Açık: sağ ön cam ve cam tavan \(aralık\) 00:00'dan beri$/);
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
// The default config applies: wait 10 minutes after parking, idle limit 30 minutes, reminders after 30 and 90 minutes.

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

test('reminders 30 and 90 minutes after the first notification, then no more', async () => {
  const events = [[0, { [KM]: 100, [TILT]: 'OPEN' }], [1, DOOR_OPEN], [1.1, DOOR_CLOSED]];
  const sent = await simulate(events, 0, 16 * 60);
  assert.deepEqual(
    sent.map(([minute]) => minute),
    [11, 41, 101],
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
    ['park_after_idle_min', Number.NaN],
    ['remind_after_min', 60],
    ['remind_after_min', [90, 30]],
    ['remind_after_min', [0]],
    ['remind_after_min', ['30']],
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
  clock = 40 * 60; // car B is parked now (car A's first reminder comes at 41)
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
// The sunroof opens after the driver gets in.
const lockedTrip = (extra = []) => [
  [0, { [KM]: 100, [LOCK]: 'SECURED' }],
  [1, { [LOCK]: 'UNLOCKED' }],
  [1.5, DOOR_OPEN],
  [1.8, { [DRIVER_DOOR]: false, [TILT]: 'OPEN' }],
  [2, { [LOCK]: 'LOCKED' }],
  ...drive(6, 21, 101),
  [22, { [LOCK]: 'UNLOCKED' }],
  [23, DOOR_OPEN],
  [23.2, DOOR_CLOSED],
  [24, { [LOCK]: 'SECURED' }],
  ...extra,
];

test('lock: a part that is open when you lock the car gives a notification at once', async () => {
  const sent = await simulate(lockedTrip(), 0, 40);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 24, 'at the lock (without the lock: 23 + 10 = 33)');
  // The sunroof was open since minute 1.8, during the drive. The text shows the lock time.
  assert.match(sent[0][1], /MINI left open: Open: sunroof \(tilted\) since 00:24$/);
});

test('lock: with alert_after_lock_min 2, a comfort close after the lock gives no notification', async () => {
  const events = lockedTrip([[25, { [TILT]: 'CLOSED' }]]);
  assert.deepEqual(await simulate(events, 0, 60, { alert_after_lock_min: 2 }), []);
  const sent = await simulate(lockedTrip(), 0, 40, { alert_after_lock_min: 2 });
  assert.equal(sent[0][0], 26);
});

test('the text shows the start of the park for a part that was open since an earlier day', async () => {
  const day = 24 * 60;
  const events = [
    [0, { [KM]: 100, [TILT]: 'OPEN' }], // left open yesterday
    [1, DOOR_OPEN],
    [1.2, DOOR_CLOSED],
    [day, { [LOCK]: 'UNLOCKED' }], // next day: a drive
    [day + 1, DOOR_OPEN],
    [day + 1.2, DOOR_CLOSED],
    [day + 2, { [LOCK]: 'LOCKED' }],
    ...drive(day + 5, day + 20, 101),
    [day + 21, { [LOCK]: 'UNLOCKED' }],
    [day + 22, DOOR_OPEN],
    [day + 22.2, DOOR_CLOSED],
    [day + 23, { [LOCK]: 'SECURED' }],
  ];
  const sent = await simulate(events, day - 1, day + 30, { remind_after_min: [] });
  assert.equal(sent.length, 2, 'the alert of yesterday, then the alert of today');
  assert.match(sent[1][1], /MINI left open: Open: sunroof \(tilted\) since 00:23$/, 'not "since yesterday 00:00"');
});

test('the text keeps the own time of a part that opened after the park', async () => {
  const events = lockedTrip([[23.5, { [TILT]: 'CLOSED' }], [30, { [TRUNK]: true }]]);
  const sent = await simulate(events, 0, 60);
  assert.match(sent[0][1], /trunk since 00:30$/);
});

test('lock: a part that opens after the lock follows the normal wait', async () => {
  const events = lockedTrip([[23.5, { [TILT]: 'CLOSED' }], [30, { [TRUNK]: true }]]);
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
  // Not driving. The passenger door at 5 starts the wait again (each door opening does): 5 + 10.
  assert.deepEqual(sent.map(([minute]) => minute), [15]);
});

test('lock: alert_after_lock_min must be a number of minutes', () => {
  checkConfig({ ...DEFAULT_CONFIG, alert_after_lock_min: 0 });
  assert.throws(() => checkConfig({ ...DEFAULT_CONFIG, alert_after_lock_min: -1 }), /alert_after_lock_min/);
});

test('the text uses the time the driver got out when the lock comes hours later', async () => {
  const events = [
    [0, { [KM]: 100 }],
    [1, DOOR_OPEN],
    [1.2, { [DRIVER_DOOR]: false, [TILT]: 'OPEN' }],
    ...drive(5, 20, 101),
    [22, DOOR_OPEN], // the driver gets out, no lock
    [22.2, DOOR_CLOSED],
    [180, { [LOCK]: 'SECURED' }], // a lock with the app, hours later
  ];
  const sent = await simulate(events, 0, 200, { remind_after_min: [] });
  assert.equal(sent.length, 1);
  assert.match(sent[0][1], /sunroof \(tilted\) since 00:22$/);
});

test('reminders: a custom list, an empty list, and a new part starts a new series', async () => {
  const base = [[0, { [KM]: 100, [TILT]: 'OPEN' }], [1, DOOR_OPEN], [1.1, DOOR_CLOSED]];
  assert.deepEqual((await simulate(base, 0, 300, { remind_after_min: [] })).map(([m]) => m), [11]);
  assert.deepEqual((await simulate(base, 0, 300, { remind_after_min: [15, 60, 120] })).map(([m]) => m), [11, 26, 71, 131]);
  const withNewPart = [...base, [50, { [WIN]: 'OPEN' }]];
  const sent = await simulate(withNewPart, 0, 300);
  assert.deepEqual(sent.map(([m]) => m), [11, 41, 60, 90, 150], 'the window at 50: a new alert at 60, then 30 and 90 minutes after it');
  assert.match(sent[2][1], /MINI left open/);
});

test('reminders after a restart from an older state count from the last notification', () => {
  const watcher = new Watcher({ ...DEFAULT_CONFIG });
  watcher.restoreNotify({ notified: [TILT], lastNotify: 5000, reminders: 1, alerted: true }, 6000);
  assert.equal(watcher.firstNotifyAt, 5000);
});

// ---- Back at the car: reminders stop, a new lock starts a new series ----

const REAR_DOOR = 'vehicle.cabin.door.row2.passenger.isOpen';

test('back at the car: unlocking stops the reminders, a new lock starts a new series after 2 minutes', async () => {
  const events = lockedTrip([
    [40, { [LOCK]: 'UNLOCKED' }], // back at the car before the 30 minute reminder (54)
    [40.5, { [REAR_DOOR]: true }],
    [41, { [REAR_DOOR]: false }],
    [42, { [LOCK]: 'SECURED' }], // locked again, the sunroof is still open
  ]);
  const sent = await simulate(events, 0, 300);
  assert.deepEqual(sent.map(([m]) => m), [24, 44, 74, 134]);
  assert.match(sent[1][1], /MINI left open/, 'a new series, not a reminder');
});

test('back at the car without a new lock: a new series after the normal wait', async () => {
  const events = lockedTrip([
    [40, { [LOCK]: 'UNLOCKED' }],
    [40.5, DOOR_OPEN],
    [41, DOOR_CLOSED], // leaves without a lock
  ]);
  const sent = await simulate(events, 0, 300);
  assert.deepEqual(sent.map(([m]) => m), [24, 50.5, 80.5, 140.5]);
});

test('back at the car after the last reminder: a door and a new lock start a new series', async () => {
  const events = lockedTrip([[200, { [LOCK]: 'UNLOCKED' }], [200.5, DOOR_OPEN], [200.75, DOOR_CLOSED], [201, { [LOCK]: 'SECURED' }]]);
  const sent = await simulate(events, 0, 400);
  assert.deepEqual(sent.map(([m]) => m), [24, 54, 114, 203, 233, 293]);
});

test('unlock and lock without a door opening change nothing (a key at a valet)', async () => {
  const cycles = [];
  for (const m of [30, 33, 40, 70, 100, 130]) cycles.push([m, { [LOCK]: 'UNLOCKED' }], [m + 0.25, { [LOCK]: 'SECURED' }]);
  const sent = await simulate(lockedTrip(cycles), 0, 400);
  assert.deepEqual(sent.map(([m]) => m), [24, 54, 114], 'only the first notification and the two reminders');
});

test('a door that stays open counts once, also when the car repeats it in each message', async () => {
  const events = [
    [0, { [KM]: 100 }],
    [1, { [DRIVER_DOOR]: true }],
    [5, { [DRIVER_DOOR]: true, [WIN]: 'CLOSED' }], // the car repeats the open door
    [8, { [DRIVER_DOOR]: true }],
  ];
  const sent = await simulate(events, 0, 60);
  assert.equal(sent[0][0], 11, 'not moved to 18 by the repeated value');
  assert.match(sent[0][1], /front left door/);
  assert.deepEqual(sent.map(([m]) => m), [11, 41], 'the repeated value is no return to the car');
});

test('a walk around the car with many locks and unlocks gives one notification', async () => {
  const events = lockedTrip([
    [40, { [LOCK]: 'UNLOCKED' }],
    [40.25, DOOR_OPEN],
    [40.5, DOOR_CLOSED],
    [41, { [LOCK]: 'SECURED' }],
    [41.5, { [LOCK]: 'UNLOCKED' }],
    [42, { [LOCK]: 'SECURED' }],
    [42.25, { [LOCK]: 'UNLOCKED' }],
    [42.5, { [LOCK]: 'SECURED' }], // the last lock
  ]);
  const sent = await simulate(events, 0, 300);
  assert.deepEqual(sent.map(([m]) => m), [24, 44.5, 74.5, 134.5]);
});

test('after a drive the first lock still notifies at once', async () => {
  const events = lockedTrip([
    [40, { [LOCK]: 'UNLOCKED' }], // back at the car
    [40.5, DOOR_OPEN],
    [41, DOOR_CLOSED],
    [41.5, { [LOCK]: 'LOCKED' }], // drives again
    ...drive(45, 60, 110),
    [61, { [LOCK]: 'UNLOCKED' }],
    [62, DOOR_OPEN],
    [62.5, DOOR_CLOSED],
    [63, { [LOCK]: 'SECURED' }],
  ]);
  const sent = await simulate(events, 0, 70);
  assert.deepEqual(sent.map(([m]) => m), [24, 63]);
});

// ---- "Everything is closed" after a drive ----

// Alert at minute 11 (sunroof open since the start). At 20 someone comes back, a drive follows (km at 24 to 39).
// The driver gets out at 42. `during` and `after` are the events that close or open parts.
const driveAfterAlert = (extra) => [
  [0, { [KM]: 100, [TILT]: 'OPEN' }],
  [1, DOOR_OPEN],
  [1.2, DOOR_CLOSED],
  [20, DOOR_OPEN],
  [20.2, DOOR_CLOSED],
  ...drive(24, 40, 101),
  ...extra,
  [42, DOOR_OPEN],
  [42.2, DOOR_CLOSED],
];

test('closed after a drive: the sunroof closes right after the drive, one "closed" message at the park', async () => {
  const sent = await simulate(driveAfterAlert([[41, { [TILT]: 'CLOSED' }]]), 0, 120);
  // The driver door is a part too. The message comes when it closes again (42.2).
  assert.deepEqual(sent.map(([m]) => m), [11, 42.25]);
  assert.match(sent[1][1], /MINI: Everything is closed\./);
});

test('closed after a drive: the sunroof closes during the drive, the message waits for the park', async () => {
  const sent = await simulate(driveAfterAlert([[30, { [TILT]: 'CLOSED' }]]), 0, 120);
  assert.deepEqual(sent.map(([m]) => m), [11, 42.25], 'nothing while driving, also not after the later odometer values');
  assert.match(sent[1][1], /Everything is closed\./);
});

test('closed after a drive: a part that is still open gives a new "left open", not "closed"', async () => {
  const sent = await simulate(driveAfterAlert([]), 0, 120);
  assert.deepEqual(sent.map(([m]) => m), [11, 52, 82], 'a new series: 10 minutes after the park, then 30 minutes later');
  assert.match(sent[1][1], /MINI left open/);
  assert.match(sent[2][1], /MINI still open/);
});

test('closed after a drive: an old alert does not give a wrong "closed" later', async () => {
  const events = [
    [0, { [KM]: 100, [TILT]: 'OPEN' }],
    [1, DOOR_OPEN],
    [1.2, DOOR_CLOSED],
    [12, { [TILT]: 'CLOSED' }], // alert at 11, "closed" at 12
    ...drive(20, 40, 101),
    [41, DOOR_OPEN],
    [41.2, DOOR_CLOSED],
    [100, { [WIN]: 'OPEN' }], // a short window opening days later
    [101, { [WIN]: 'CLOSED' }],
  ];
  const sent = await simulate(events, 0, 300);
  assert.deepEqual(sent.map(([m]) => m), [11, 12]);
});

test('closed after a drive: an alert is forgotten at an odometer increase when nothing is open and no close waits', () => {
  const { watcher, at } = virtualWatcher();
  watcher.onData(msg({ [KM]: 100 }), at(0));
  watcher.alerted = true; // restored from disk, but no part is open and no close was seen
  watcher.onData(msg({ [KM]: 101 }), at(1));
  assert.equal(watcher.alerted, false);
  watcher.onData(msg({ [TILT]: 'OPEN' }), at(2));
  watcher.alerted = true;
  watcher.onData(msg({ [KM]: 102 }), at(3));
  assert.equal(watcher.alerted, true, 'a part is open: the alert stays');
});

// ---- One time for parts that share it ----

const REAR_RIGHT_DOOR = 'vehicle.cabin.door.row2.passenger.isOpen';
const TRUNK_DOOR = 'vehicle.body.trunk.door.isOpen';

test('parts with the same time are grouped, groups are separated by a comma', async () => {
  const { watcher, at } = virtualWatcher();
  const t0 = at(0);
  watcher.onData(msg({ [TILT]: 'OPEN' }), t0);
  watcher.onData(msg({ [DRIVER_DOOR]: true, [REAR_RIGHT_DOOR]: true }), t0 + 3600);
  watcher.onData(msg({ [WIN]: 'OPEN' }), t0 + 3600 + 20); // 20 seconds later: the same minute
  at(120);
  const lines = await logsDuring(() => watcher.check());
  assert.match(lines[0], /^\[ntfy off\] MINI left open: Open: sunroof \(tilted\) since 00:00, front left and rear right doors and front right window since 01:00$/);
});

test('Turkish: parts with the same time are grouped with "ve"', async () => {
  const { watcher, at } = virtualWatcher({ language: 'tr' });
  const t0 = at(0);
  watcher.onData(msg({ [TILT]: 'OPEN' }), t0);
  watcher.onData(msg({ [DRIVER_DOOR]: true, [REAR_RIGHT_DOOR]: true }), t0 + 3600);
  at(120);
  const lines = await logsDuring(() => watcher.check());
  assert.match(lines[0], /Açık: cam tavan \(aralık\) 00:00'dan beri, sol ön ve sağ arka kapı 01:00'den beri$/);
});

test('a name shows once: the trunk has two attributes', async () => {
  const { watcher, at } = virtualWatcher();
  const t0 = at(0);
  watcher.onData(msg({ [TRUNK]: true }), t0);
  watcher.onData(msg({ [TRUNK_DOOR]: true }), t0 + 600);
  at(60);
  const lines = await logsDuring(() => watcher.check());
  assert.match(lines[0], /Open: trunk since 00:00$/);
});

test('one part: no list word', async () => {
  const { watcher, at } = virtualWatcher();
  watcher.onData(msg({ [TILT]: 'OPEN' }), at(0));
  at(20);
  assert.match((await logsDuring(() => watcher.check()))[0], /Open: sunroof \(tilted\) since 00:00$/);
});

// ---- The windows and the doors of a group share their name ----

const W = (row, side) => `vehicle.cabin.window.${row}.${side}.status`;
const D = (row, side) => `vehicle.cabin.door.${row}.${side}.isOpen`;
const en = { language: 'en' };
const tr = { language: 'tr' };

test('describeParts: left and right of one row share the name (Turkish)', () => {
  assert.equal(describeParts([W('row1', 'driver'), W('row1', 'passenger')], tr), 'sol ve sağ ön cam');
  assert.equal(describeParts([D('row2', 'passenger'), D('row2', 'driver')], tr), 'sol ve sağ arka kapı');
});

test('describeParts: left and right of one row share the name (English)', () => {
  assert.equal(describeParts([W('row1', 'driver'), W('row1', 'passenger')], en), 'left and right front windows');
  assert.equal(describeParts([D('row2', 'driver'), D('row2', 'passenger')], en), 'left and right rear doors');
});

test('describeParts: other combinations list the positions and name the kind once', () => {
  assert.equal(describeParts([W('row1', 'driver'), W('row2', 'driver')], tr), 'sol ön ve sol arka cam');
  assert.equal(describeParts([W('row1', 'passenger'), W('row1', 'driver'), W('row2', 'driver')], tr), 'sol ön, sağ ön ve sol arka cam');
  assert.equal(describeParts([W('row1', 'passenger'), W('row1', 'driver'), W('row2', 'driver')], en), 'front left, front right and rear left windows');
  assert.equal(describeParts([D('row1', 'driver')], tr), 'sol ön kapı');
  assert.equal(describeParts([D('row1', 'driver')], en), 'front left door');
});

test('describeParts: all four', () => {
  const four = (f) => [f('row1', 'driver'), f('row1', 'passenger'), f('row2', 'driver'), f('row2', 'passenger')];
  assert.equal(describeParts(four(W), tr), 'tüm camlar');
  assert.equal(describeParts(four(D), en), 'all doors');
});

test('describeParts: kinds together, the first part decides the order, other parts keep their name', () => {
  const sunroofTilt = 'vehicle.cabin.sunroof.tiltStatus';
  assert.equal(describeParts([D('row1', 'driver'), W('row1', 'passenger'), W('row1', 'driver')], tr), 'sol ön kapı ve sol ve sağ ön cam');
  assert.equal(describeParts([sunroofTilt, W('row1', 'driver'), W('row1', 'passenger'), TRUNK], tr), 'cam tavan (aralık), sol ve sağ ön cam ve bagaj');
  assert.equal(describeParts([TRUNK, 'vehicle.body.trunk.door.isOpen'], en), 'trunk');
});

test('a notification: the two front windows and the driver door, one time', async () => {
  const { watcher, at } = virtualWatcher({ language: 'tr' });
  const t0 = at(0);
  watcher.onData(msg({ [W('row1', 'driver')]: 'OPEN', [W('row1', 'passenger')]: 'OPEN', [DRIVER_DOOR]: true }), t0);
  at(20);
  const lines = await logsDuring(() => watcher.check());
  assert.match(lines[0], /Açık: sol ve sağ ön cam ve sol ön kapı 00:00'dan beri$/);
});

// ---- Lock confirmation (lock_confirm): "locked, everything is closed" ----

const CONFIRM = { lock_confirm: true };
// A drive and a park with the sunroof closed before the lock at minute 24.
const parkedClosed = (extra = []) => lockedTrip([[23.5, { [TILT]: 'CLOSED' }], ...extra]);

test('lock confirmation: you lock the car and everything is closed, the message comes at once', async () => {
  const sent = await simulate(parkedClosed(), 0, 60, CONFIRM);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 24);
  assert.match(sent[0][1], /MINI locked: Everything is closed\.$/);
});

test('lock confirmation: Turkish text', async () => {
  const sent = await simulate(parkedClosed(), 0, 60, { ...CONFIRM, language: 'tr' });
  assert.match(sent[0][1], /MINI kilitlendi: Her şey kapalı\.$/);
});

test('lock confirmation: off by default', async () => {
  assert.deepEqual(await simulate(parkedClosed(), 0, 60), []);
});

test('lock confirmation: a part that is open at the lock gives "left open", not a confirmation', async () => {
  const sent = await simulate(lockedTrip(), 0, 40, CONFIRM);
  assert.deepEqual(sent.map(([m]) => m), [24]);
  assert.match(sent[0][1], /MINI left open/);
});

test('lock confirmation: unlock and lock without a door (a valet key) give nothing more', async () => {
  const cycles = [];
  for (const m of [30, 40, 70, 100]) cycles.push([m, { [LOCK]: 'UNLOCKED' }], [m + 0.25, { [LOCK]: 'SECURED' }]);
  const sent = await simulate(parkedClosed(cycles), 0, 200, CONFIRM);
  assert.deepEqual(sent.map(([m]) => m), [24]);
});

test('lock confirmation: a walk around the car (a lock less than 2 minutes after the last one) gives one message', async () => {
  const events = parkedClosed([
    [24.5, { [LOCK]: 'UNLOCKED' }],
    [24.75, DOOR_OPEN],
    [25, DOOR_CLOSED],
    [25.25, { [LOCK]: 'SECURED' }],
  ]);
  const sent = await simulate(events, 0, 60, CONFIRM);
  assert.deepEqual(sent.map(([m]) => m), [24]);
});

test('lock confirmation: a later stop with a door and a lock gives a new message', async () => {
  const events = parkedClosed([
    [40, { [LOCK]: 'UNLOCKED' }],
    [40.5, DOOR_OPEN],
    [41, DOOR_CLOSED],
    [41.5, { [LOCK]: 'SECURED' }],
  ]);
  const sent = await simulate(events, 0, 60, CONFIRM);
  assert.deepEqual(sent.map(([m]) => m), [24, 41.5]);
});

test('lock confirmation: no second message right after "everything is closed"', async () => {
  const events = lockedTrip([
    [40, { [TILT]: 'CLOSED' }], // "left open" at 24, "everything is closed" at 40
    [40.2, { [LOCK]: 'UNLOCKED' }],
    [40.4, DOOR_OPEN],
    [40.6, DOOR_CLOSED],
    [40.8, { [LOCK]: 'SECURED' }], // locked less than 2 minutes after the closed message
  ]);
  const sent = await simulate(events, 0, 80, CONFIRM);
  assert.deepEqual(sent.map(([m]) => m), [24, 40]);
  assert.match(sent[1][1], /Everything is closed\./);
});

test('lock confirmation: it comes after "everything is closed" when you lock the car later', async () => {
  const events = lockedTrip([
    [40, { [TILT]: 'CLOSED' }],
    [44, { [LOCK]: 'UNLOCKED' }],
    [44.5, DOOR_OPEN],
    [45, DOOR_CLOSED],
    [45.5, { [LOCK]: 'SECURED' }],
  ]);
  const sent = await simulate(events, 0, 80, CONFIRM);
  assert.deepEqual(sent.map(([m]) => m), [24, 40, 45.5]);
  assert.match(sent[2][1], /MINI locked/);
});

test('lock confirmation: an old lock gives no message (a check 10 minutes later, for example after a restart)', async () => {
  const { watcher, at } = virtualWatcher(CONFIRM);
  watcher.onData(msg({ [KM]: 100 }), at(0));
  watcher.onData(msg({ [DRIVER_DOOR]: true }), at(1));
  watcher.onData(msg({ [DRIVER_DOOR]: false }), at(1.2));
  watcher.onData(msg({ [LOCK]: 'SECURED' }), at(2));
  at(20);
  assert.deepEqual(await logsDuring(() => watcher.check()), []);
});

test('lock confirmation: a failed message is sent again, the state waits for the success', async () => {
  let clock = 1000;
  const watcher = new Watcher({ ...ntfyConfig, lock_confirm: true }, { clock: () => clock, random: () => 0.5 });
  watcher.onData(msg({ [KM]: 100 }), clock - 300);
  watcher.onData(msg({ [DRIVER_DOOR]: true }), clock - 200);
  watcher.onData(msg({ [DRIVER_DOOR]: false }), clock - 190);
  watcher.onData(msg({ [LOCK]: 'SECURED' }), clock - 100);
  const calls = await withFakeNtfy([500, 200], async () => {
    await watcher.check();
    assert.equal(watcher.confirmedAt, 0);
    clock += 31;
    await watcher.check();
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].title, 'MINI locked');
  assert.equal(watcher.confirmedAt, clock);
});

test('lock confirmation: the setting must be true or false, the state keeps the time', () => {
  checkConfig({ ...DEFAULT_CONFIG, lock_confirm: true });
  assert.throws(() => checkConfig({ ...DEFAULT_CONFIG, lock_confirm: 'yes' }), /lock_confirm/);
  const { watcher } = virtualWatcher(CONFIRM);
  watcher.confirmedAt = 777;
  assert.equal(watcher.snapshot().confirmedAt, 777);
  const older = virtualWatcher(CONFIRM);
  older.watcher.restoreWatch({}); // a state of an older version has no confirmedAt
  assert.equal(older.watcher.confirmedAt, 0, 'the virtual clock is at 0');
});
