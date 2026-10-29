// Run with: npm test
// These tests use fake car data. They do not call BMW or ntfy.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
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
  ntfy,
  textsFor,
  tagFor,
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

// A value, or a whole item like { value: 187, unit: 'km' }.
const msg = (values) =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value !== null && typeof value === 'object' && 'value' in value ? value : { value }]));
// Fake VINs. They do not match a real VIN pattern.
const VIN_A = 'TESTVIN0000000001';
const VIN_B = 'TESTVIN0000000002';
// One line of messages.jsonl, as the program writes it.
const line = (t, values, vin = VIN_A) => JSON.stringify({ t, payload: JSON.stringify({ vin, data: msg(values) }) });
// Temporary folders. They are deleted after the last test of this file.
const tempDirs = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mini-watch-test-'));
  tempDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

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
  assert.match(lines[0], /MINI: a part is open: Sunroof \(tilted\), front right window \(partly open\) and front left door since 00:15$/);
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
  assert.equal((await logsDuring(() => watcher.check())).length, 0, 'it waits 15 seconds');
  const lines = await logsDuring(() => {
    at(11.25);
    return watcher.check();
  });
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
  at(2.25);
  const lines = await logsDuring(() => watcher.check());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Everything is closed\./);
});

test('Turkish text with language "tr"', async () => {
  const { watcher, at } = virtualWatcher({ language: 'tr' });
  watcher.onData(msg({ [WIN]: 'OPEN', [TILT]: 'OPEN' }), at(0));
  at(10);
  const lines = await logsDuring(() => watcher.check());
  assert.match(lines[0], /MINI'de açık parça var: Sağ ön cam \(tam açık\) ve cam tavan \(aralık\) 00:00'dan beri$/);
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
  assert.match(lines[0], /MINI: a part is open: Sunroof \(tilted\) since 6 Jan 13:48, front right window \(fully open\) since 6 Jan 13:50/);
});

test('Turkish notification has the time with the right suffix', async () => {
  const watcher = new Watcher({ ...baseConfig, language: 'tr' });
  watcher.onData(msg({ [WIN]: 'OPEN' }), at(13, 50));
  watcher.onData(msg({ [TILT]: 'OPEN' }), at(13, 48));
  const lines = await logsDuring(() => watcher.check());
  assert.match(lines[0], /Cam tavan \(aralık\) .*13:48'den beri, sağ ön cam .*13:50'den beri/);
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
  assert.match(sent[0][1], /MINI: a part is open: Sunroof \(tilted\)/);
});

test('reminders 30 and 90 minutes after the first notification, then no more', async () => {
  const events = [[0, { [KM]: 100, [TILT]: 'OPEN' }], [1, DOOR_OPEN], [1.1, DOOR_CLOSED]];
  const sent = await simulate(events, 0, 16 * 60);
  assert.deepEqual(
    sent.map(([minute]) => minute),
    [11, 41, 101],
  );
  assert.match(sent[0][1], /MINI: a part is open/);
  for (const [, text] of sent.slice(1)) assert.match(text, /MINI: a part is still open/);
});

// ---- Failed notifications, unknown values, settings and history (static analysis findings F-01, F-03, F-04, F-06, F-13) ----

// The answer of ntfy to an accepted message.
const NTFY_ANSWER = JSON.stringify({ id: 'abc123def456', time: 1790000000, expires: 1790043200, event: 'message', topic: 'x' });

// Replaces fetch with a fake ntfy server. `answers` is a list of HTTP status codes, 'throw', or { status, body }
// for a special answer. A 2xx code answers with a valid ntfy message (with an id). The last answer repeats.
async function withFakeNtfy(answers, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const answer = answers[Math.min(calls.length, answers.length - 1)];
    calls.push(JSON.parse(options.body));
    if (answer === 'throw') throw new Error('connection refused');
    if (typeof answer === 'object') return new Response(answer.body, { status: answer.status });
    return new Response(answer >= 200 && answer < 300 ? NTFY_ANSWER : 'error', { status: answer });
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
  assert.equal(calls[2].title, 'MINI: a part is open', 'the retry is the first alert, not a reminder');
  assert.equal(watcher.alerted, true);
  assert.equal(watcher.notifyFailures, 0);
});

test('no "everything is closed" when the first alert failed with a network error (fetch threw) and the part closed', async () => {
  let clock = 1000;
  const watcher = new Watcher(ntfyConfig, { clock: () => clock, random: () => 0.5 });
  watcher.onData(msg({ [WIN]: 'OPEN' }), clock);
  const calls = await withFakeNtfy(['throw', 200], async () => {
    await watcher.check(); // fetch throws: the alert is not sent
    watcher.onData(msg({ [WIN]: 'CLOSED' }), clock + 5);
    clock += 600;
    await watcher.check(); // everything is closed, but no alert went out
  });
  assert.equal(calls.length, 1, 'only the failed alert');
});

test('no "everything is closed" when the first alert got a 2xx answer without a message id and the part closed', async () => {
  let clock = 1000;
  const watcher = new Watcher(ntfyConfig, { clock: () => clock, random: () => 0.5 });
  watcher.onData(msg({ [WIN]: 'OPEN' }), clock);
  const calls = await withFakeNtfy([{ status: 200, body: '{}' }, 200], async () => {
    await watcher.check(); // HTTP 200 without a message id: the alert is not confirmed
    watcher.onData(msg({ [WIN]: 'CLOSED' }), clock + 5);
    clock += 600;
    await watcher.check(); // everything is closed, but ntfy accepted no alert
  });
  assert.equal(calls.length, 1, 'only the alert that was not confirmed');
  assert.equal(watcher.alerted, false);
});

test('silence alert: after a failed send and after a 2xx answer without a message id, the next try comes after a fixed 600 seconds', async () => {
  let clock = 0;
  const fleet = new Fleet({ ...ntfyConfig, silence_alert_hours: 48 }, { clock: () => clock, random: () => 0.5 });
  fleet.onMessage(VIN_A, msg({ [WIN]: 'CLOSED' }), 0);
  const start = 49 * 3600;
  const calls = await withFakeNtfy(['throw', { status: 200, body: '{}' }, 200], async () => {
    clock = start;
    await fleet.check(); // fetch throws
    assert.equal(fleet.silenceAlerted, false);
    assert.equal(fleet.silenceRetryAt, start + 600);
    clock = start + 599;
    await fleet.check(); // still in the wait: no try
    clock = start + 600;
    await fleet.check(); // HTTP 200 without a message id
    assert.equal(fleet.silenceAlerted, false, 'not confirmed');
    assert.equal(fleet.silenceRetryAt, start + 1200, 'the same fixed wait: no doubling and no random factor');
    clock = start + 1199;
    await fleet.check(); // still in the wait: no try
    clock = start + 1200;
    await fleet.check(); // HTTP 200 with a message id
    clock = start + 3 * 3600;
    await fleet.check(); // sent once: no more
  });
  assert.equal(calls.length, 3);
  assert.ok(
    calls.every((call) => call.title === 'MINI no data'),
    calls.map((call) => call.title).join(', '),
  );
  assert.equal(fleet.silenceAlerted, true);
});

test('a 2xx answer without a message id does not count as sent: the state waits and the alert comes again after the retry wait', async () => {
  let clock = 1000;
  const watcher = new Watcher(ntfyConfig, { clock: () => clock, random: () => 0.5 });
  watcher.onData(msg({ [WIN]: 'OPEN' }), clock);
  const calls = await withFakeNtfy([{ status: 200, body: '{}' }, 200], async () => {
    await watcher.check(); // HTTP 200, but no message id
    assert.equal(watcher.alerted, false, 'no alert is recorded');
    assert.equal(watcher.notified.size, 0);
    assert.equal(watcher.firstNotifyAt, 0);
    assert.equal(watcher.lastNotify, 0);
    assert.equal(watcher.notifyFailures, 1);
    assert.equal(watcher.retryAt, 1030, 'the first wait is 30 seconds (random factor 1.0)');
    clock += 29;
    await watcher.check(); // still in the wait: no try
    clock += 1;
    await watcher.check(); // HTTP 200 with a message id
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].title, 'MINI: a part is open', 'the retry is the first alert, not a reminder');
  assert.equal(watcher.alerted, true);
  assert.equal(watcher.notifyFailures, 0);
  assert.deepEqual([...watcher.notified], [WIN]);
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
  assert.deepEqual(calls.map((call) => call.title), ['MINI: a part is open', 'MINI', 'MINI']);
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
  const file = join(tempDir(), 'messages.jsonl');
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
  assert.match(lines[0], /MINI: a part is open \(Countryman\): Front right window/);
  clock = 40 * 60; // car B is parked now (car A's first reminder comes at 41)
  const later = await logsDuring(() => fleet.check());
  assert.equal(later.length, 1);
  assert.match(later[0], /MINI: a part is open \(…0002\): Sunroof \(tilted\)/);
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
  assert.match(sent[0][1], /MINI locked, but a part is open: Sunroof \(tilted\) since 00:24$/);
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
  assert.match(sent[1][1], /MINI locked, but a part is open: Sunroof \(tilted\) since 00:23$/, 'not "since yesterday 00:00"');
});

test('the text keeps the own time of a part that opened after the park', async () => {
  const events = lockedTrip([[23.5, { [TILT]: 'CLOSED' }], [30, { [TRUNK]: true }]]);
  const sent = await simulate(events, 0, 60);
  assert.match(sent[0][1], /Trunk since 00:30$/);
});

test('lock: a part that opens after the lock follows the normal wait', async () => {
  const events = lockedTrip([[23.5, { [TILT]: 'CLOSED' }], [30, { [TRUNK]: true }]]);
  const sent = await simulate(events, 0, 60);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 40, 'trunk opened at 30 + 10 minutes');
  assert.match(sent[0][1], /Trunk/);
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
  assert.match(sent[0][1], /Sunroof \(tilted\) since 00:22$/);
});

test('reminders: a custom list, an empty list, and a new part starts a new series', async () => {
  const base = [[0, { [KM]: 100, [TILT]: 'OPEN' }], [1, DOOR_OPEN], [1.1, DOOR_CLOSED]];
  assert.deepEqual((await simulate(base, 0, 300, { remind_after_min: [] })).map(([m]) => m), [11]);
  assert.deepEqual((await simulate(base, 0, 300, { remind_after_min: [15, 60, 120] })).map(([m]) => m), [11, 26, 71, 131]);
  const withNewPart = [...base, [50, { [WIN]: 'OPEN' }]];
  const sent = await simulate(withNewPart, 0, 300);
  assert.deepEqual(sent.map(([m]) => m), [11, 41, 60, 90, 150], 'the window at 50: a new alert at 60, then 30 and 90 minutes after it');
  assert.match(sent[2][1], /MINI: a part is open/);
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
  assert.match(sent[1][1], /MINI locked, but a part is open/, 'a new series, not a reminder');
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
  assert.match(sent[0][1], /Front left door/);
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
  // The driver door is a part too. The message comes 15 seconds after it closes again (42.2).
  assert.deepEqual(sent.map(([m]) => m), [11, 42.5]);
  assert.match(sent[1][1], /MINI: Everything is closed\./);
});

test('closed after a drive: the sunroof closes during the drive, the message waits for the park', async () => {
  const sent = await simulate(driveAfterAlert([[30, { [TILT]: 'CLOSED' }]]), 0, 120);
  assert.deepEqual(sent.map(([m]) => m), [11, 42.5], 'nothing while driving, also not after the later odometer values');
  assert.match(sent[1][1], /Everything is closed\./);
});

test('closed after a drive: a part that is still open gives a new "left open", not "closed"', async () => {
  const sent = await simulate(driveAfterAlert([]), 0, 120);
  assert.deepEqual(sent.map(([m]) => m), [11, 52, 82], 'a new series: 10 minutes after the park, then 30 minutes later');
  assert.match(sent[1][1], /MINI: a part is open/);
  assert.match(sent[2][1], /MINI: a part is still open/);
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
  assert.deepEqual(sent.map(([m]) => m), [11, 12.25]);
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
  assert.match(lines[0], /^\[ntfy off\] MINI: a part is open: Sunroof \(tilted\) since 00:00, front left and rear right doors and front right window \(fully open\) since 01:00$/);
});

test('Turkish: parts with the same time are grouped with "ve"', async () => {
  const { watcher, at } = virtualWatcher({ language: 'tr' });
  const t0 = at(0);
  watcher.onData(msg({ [TILT]: 'OPEN' }), t0);
  watcher.onData(msg({ [DRIVER_DOOR]: true, [REAR_RIGHT_DOOR]: true }), t0 + 3600);
  at(120);
  const lines = await logsDuring(() => watcher.check());
  assert.match(lines[0], /Cam tavan \(aralık\) 00:00'dan beri, sol ön ve sağ arka kapı 01:00'den beri$/);
});

test('a name shows once: the trunk has two attributes', async () => {
  const { watcher, at } = virtualWatcher();
  const t0 = at(0);
  watcher.onData(msg({ [TRUNK]: true }), t0);
  watcher.onData(msg({ [TRUNK_DOOR]: true }), t0 + 600);
  at(60);
  const lines = await logsDuring(() => watcher.check());
  assert.match(lines[0], /Trunk since 00:00$/);
});

test('one part: no list word', async () => {
  const { watcher, at } = virtualWatcher();
  watcher.onData(msg({ [TILT]: 'OPEN' }), at(0));
  at(20);
  assert.match((await logsDuring(() => watcher.check()))[0], /Sunroof \(tilted\) since 00:00$/);
});

// ---- The windows and the doors of a group share their name ----

const W = (row, side) => `vehicle.cabin.window.${row}.${side}.status`;
const D = (row, side) => `vehicle.cabin.door.${row}.${side}.isOpen`;
const en = { language: 'en' };
const tr = { language: 'tr' };

// ---- A window shows if it is fully open or partly open ----

const values = (entries) => new Map(entries);

test('window state: the windows of one state share the name and show the state', () => {
  const state = values([[W('row1', 'driver'), 'OPEN'], [W('row1', 'passenger'), 'OPEN'], [W('row2', 'driver'), 'INTERMEDIATE']]);
  const names = [W('row1', 'driver'), W('row2', 'driver'), W('row1', 'passenger')];
  assert.equal(describeParts(names, en, state), 'left and right front windows (fully open) and rear left window (partly open)');
  assert.equal(describeParts(names, tr, state), 'sol ve sağ ön cam (tam açık) ve sol arka cam (kısmen açık)');
});

test('window state: all four windows in the same state', () => {
  const names = ['row1.driver', 'row1.passenger', 'row2.driver', 'row2.passenger'].map((key) => `vehicle.cabin.window.${key}.status`);
  const state = values(names.map((name) => [name, 'INTERMEDIATE']));
  assert.equal(describeParts(names, en, state), 'all windows (partly open)');
  assert.equal(describeParts(names, tr, state), 'tüm camlar (kısmen açık)');
});

test('window state: without a known value the name has no state, the doors and the other parts never have one', () => {
  assert.equal(describeParts([W('row1', 'driver')], en), 'front left window');
  assert.equal(describeParts([W('row1', 'driver')], en, values([[W('row1', 'driver'), 'WEIRD']])), 'front left window');
  assert.equal(describeParts([D('row1', 'driver'), 'vehicle.cabin.sunroof.status'], en, values([[D('row1', 'driver'), 'TRUE']])), 'front left door and sunroof');
});

test('window state: the state follows the window while it stays open', async () => {
  const { watcher, at } = virtualWatcher();
  watcher.onData(msg({ [KM]: 100, [WIN]: 'INTERMEDIATE' }), at(0));
  watcher.onData(msg({ [WIN]: 'OPEN' }), at(5)); // opened further, the time stays 00:00
  at(15);
  const [line] = await logsDuring(() => watcher.check());
  assert.match(line, /Front right window \(fully open\) since 00:00$/);
});

test('window state: the state is saved for a restart', () => {
  const { watcher, at } = virtualWatcher();
  watcher.onData(msg({ [WIN]: 'INTERMEDIATE' }), at(1));
  const snap = JSON.parse(JSON.stringify(watcher.snapshot()));
  const restored = virtualWatcher().watcher;
  restored.restoreWatch(snap);
  assert.equal(restored.openValue.get(WIN), 'INTERMEDIATE');
  const old = { ...snap };
  delete old.openValue; // a state from an older version
  const older = virtualWatcher().watcher;
  older.restoreWatch(old);
  assert.equal(describeParts([WIN], en, older.openValue), 'front right window');
});

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
  assert.match(lines[0], /Sol ve sağ ön cam \(tam açık\) ve sol ön kapı 00:00'dan beri$/);
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
  assert.match(sent[0][1], /MINI locked, but a part is open/);
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
  assert.deepEqual(sent.map(([m]) => m), [24, 40.25]);
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
  assert.deepEqual(sent.map(([m]) => m), [24, 40.25, 45.5]);
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

// ---- The emoji of each notification (ntfy_tags) ----

// Runs a day: an alert, a reminder after 30 minutes, "everything is closed", then a lock with every part closed.
async function tagsOfADay(extra) {
  let clock = 1000;
  const watcher = new Watcher({ ...ntfyConfig, lock_confirm: true, ...extra }, { clock: () => clock, random: () => 0.5 });
  const calls = await withFakeNtfy([200], async () => {
    watcher.onData(msg({ [KM]: 100, [WIN]: 'OPEN' }), clock - 5000);
    await watcher.check(); // alert
    clock += 1800;
    await watcher.check(); // reminder
    watcher.onData(msg({ [WIN]: 'CLOSED' }), clock);
    clock += 15;
    await watcher.check(); // everything is closed (after 15 seconds)
    clock += 600;
    watcher.onData(msg({ [DRIVER_DOOR]: true }), clock);
    watcher.onData(msg({ [DRIVER_DOOR]: false }), clock + 5);
    watcher.onData(msg({ [LOCK]: 'SECURED' }), clock + 10);
    clock += 20;
    await watcher.check(); // lock confirmation
  });
  return calls.map((call) => call.tags);
}

test('ntfy_tags: the defaults are the emoji of before', async () => {
  assert.deepEqual(await tagsOfADay({}), [['warning'], ['warning'], ['white_check_mark'], ['lock']]);
  assert.deepEqual(Object.keys(DEFAULT_CONFIG.ntfy_tags).sort(), ['closed', 'locked', 'open', 'silence', 'still_open', 'test']);
});

test('ntfy_tags: a kind that is set changes, the other kinds keep their default', async () => {
  const tags = await tagsOfADay({ ntfy_tags: { open: 'rotating_light', locked: 'key,lock' } });
  assert.deepEqual(tags, [['rotating_light'], ['warning'], ['white_check_mark'], ['key', 'lock']]);
  assert.equal(tagFor({ ntfy_tags: { test: 'blue_car' } }, 'test'), 'blue_car');
  assert.equal(tagFor({ ntfy_tags: { test: 'blue_car' } }, 'silence'), 'grey_question');
  assert.equal(tagFor({}, 'closed'), 'white_check_mark');
});

test('ntfy_tags: a wrong setting stops the program with a clear message', () => {
  checkConfig({ ...DEFAULT_CONFIG, ntfy_tags: { open: 'rotating_light', test: 'blue_car' } });
  checkConfig({ ...DEFAULT_CONFIG, ntfy_tags: {} });
  for (const [bad, pattern] of [
    [{ opne: 'warning' }, /unknown kind "opne"/],
    [{ open: '' }, /ntfy_tags\.open/],
    [{ open: 5 }, /ntfy_tags\.open/],
    [{ open: '🚨' }, /ntfy_tags\.open/],
    [{ open: 'a b' }, /ntfy_tags\.open/],
    [['warning'], /must look like/],
  ]) {
    assert.throws(() => checkConfig({ ...DEFAULT_CONFIG, ntfy_tags: bad }), pattern, JSON.stringify(bad));
  }
});

// ---- Drive length, battery level and range at the end of a notification ----

const SOC = 'vehicle.powertrain.electric.battery.stateOfCharge.displayed';
const SOC_HEADER = 'vehicle.drivetrain.batteryManagement.header';
const RANGE_KOMBI = 'vehicle.drivetrain.electricEngine.kombiRemainingElectricRange';
const RANGE_LAST = 'vehicle.drivetrain.lastRemainingRange';
const DETAILS = { notify_trip: true, notify_battery: true };
// lockedTrip: the car locks itself at minute 2 (LOCKED), the odometer rises from minute 6, it unlocks at 22.
const tripWith = (extra = []) => lockedTrip([[7, { [SOC]: 63.6, [RANGE_KOMBI]: { value: 187, unit: 'km' } }], ...extra]);

test('details: drive length, battery level and range after the text of an alert', async () => {
  const sent = await simulate(tripWith(), 0, 40, DETAILS);
  assert.match(sent[0][1], /MINI locked, but a part is open: Sunroof \(tilted\) since 00:24 \(drive 20 min, battery 64%, range 187 km\)$/);
});

test('details: the reminders have no details', async () => {
  const sent = await simulate(tripWith(), 0, 70, DETAILS);
  assert.deepEqual(sent.map(([m]) => m), [24, 54]);
  assert.match(sent[0][1], /\(drive 20 min, battery 64%, range 187 km\)$/);
  assert.match(sent[1][1], /MINI locked, but a part is still open: Sunroof \(tilted\) since 00:24$/);
});

test('details: Turkish text', async () => {
  const sent = await simulate(tripWith(), 0, 40, { ...DETAILS, language: 'tr' });
  assert.match(sent[0][1], /\(sürüş 20 dk, batarya %64, menzil 187 km\)$/);
});

test('details: a lock confirmation after a drive has them, "everything is closed" right after the alert has none', async () => {
  const closed = await simulate(tripWith([[40, { [TILT]: 'CLOSED' }]]), 0, 80, DETAILS);
  assert.match(closed[0][1], /\(drive 20 min, battery 64%, range 187 km\)$/, 'the alert after the drive');
  assert.match(closed[1][1], /MINI: Everything is closed\.$/, 'the odometer did not rise since the alert');
  const locked = await simulate(tripWith([[23.5, { [TILT]: 'CLOSED' }]]), 0, 80, { ...DETAILS, lock_confirm: true });
  assert.match(locked[0][1], /MINI locked: Everything is closed\. \(drive 20 min, battery 64%, range 187 km\)$/);
});

test('details: "everything is closed" has them when the car drove since the alert', async () => {
  const events = tripWith([
    [30, { [LOCK]: 'UNLOCKED' }], // back at the car, the sunroof is still open
    [31, DOOR_OPEN],
    [31.2, DOOR_CLOSED],
    [36, { [LOCK]: 'LOCKED' }],
    ...drive(39, 52, 130),
    [48, { [TILT]: 'CLOSED' }], // the sunroof closes during the drive
    [56, { [LOCK]: 'UNLOCKED' }],
    [57, DOOR_OPEN],
    [57.2, DOOR_CLOSED],
    [58, { [LOCK]: 'SECURED' }],
  ]);
  const sent = await simulate(events, 0, 100, DETAILS);
  assert.equal(sent.length, 2);
  assert.match(sent[0][1], /MINI locked, but a part is open: .*\(drive 20 min, battery 64%, range 187 km\)$/);
  assert.match(sent[1][1], /MINI: Everything is closed\. \(drive 20 min, battery 64%, range 187 km\)$/);
});

// ---- The title of an open-part notification tells the lock state ----

// The car is parked and unlocked, the sunroof tilts. The alert comes 10 minutes after the driver door opened.
const unlockedPark = (extra = []) => [
  [0, { [KM]: 100, [LOCK]: 'UNLOCKED', [TILT]: 'OPEN' }],
  [1, DOOR_OPEN],
  [1.2, DOOR_CLOSED],
  ...extra,
];

test('title: locked, not locked and no lock data, for the alert and the reminder', async () => {
  const locked = await simulate(lockedTrip(), 0, 70);
  assert.match(locked[0][1], /^\[ntfy off\] MINI locked, but a part is open: Sunroof \(tilted\) since 00:24$/);
  assert.match(locked[1][1], /^\[ntfy off\] MINI locked, but a part is still open: Sunroof \(tilted\) since 00:24$/);
  const unlocked = await simulate(unlockedPark(), 0, 70);
  assert.match(unlocked[0][1], /^\[ntfy off\] MINI not locked, a part is open: Sunroof \(tilted\) since 00:00$/);
  assert.match(unlocked[1][1], /^\[ntfy off\] MINI not locked, a part is still open: Sunroof \(tilted\) since 00:00$/);
  const unknown = await simulate([[0, { [KM]: 100, [TILT]: 'OPEN' }], [1, DOOR_OPEN], [1.2, DOOR_CLOSED]], 0, 70);
  assert.match(unknown[0][1], /^\[ntfy off\] MINI: a part is open: Sunroof \(tilted\) since 00:00$/);
  assert.match(unknown[1][1], /^\[ntfy off\] MINI: a part is still open: Sunroof \(tilted\) since 00:00$/);
});

test('title: Turkish, with the body starting in upper case', async () => {
  const tr = { language: 'tr' };
  const locked = await simulate(lockedTrip(), 0, 70, tr);
  assert.match(locked[0][1], /^\[ntfy off\] MINI kilitlendi ama açık parça var: Cam tavan \(aralık\) 00:24'ten beri$/);
  assert.match(locked[1][1], /^\[ntfy off\] MINI kilitli ama hala açık parça var: Cam tavan \(aralık\) 00:24'ten beri$/);
  const unlocked = await simulate(unlockedPark(), 0, 70, tr);
  assert.match(unlocked[0][1], /^\[ntfy off\] MINI kilitli değil, açık parça var: Cam tavan \(aralık\) 00:00'dan beri$/);
  assert.match(unlocked[1][1], /^\[ntfy off\] MINI kilitli değil, hala açık parça var: Cam tavan \(aralık\) 00:00'dan beri$/);
  const unknown = await simulate([[0, { [KM]: 100, [TILT]: 'OPEN' }], [1, DOOR_OPEN], [1.2, DOOR_CLOSED]], 0, 70, tr);
  assert.match(unknown[0][1], /^\[ntfy off\] MINI'de açık parça var: Cam tavan \(aralık\) 00:00'dan beri$/);
  assert.match(unknown[1][1], /^\[ntfy off\] MINI'de hala açık parça var: Cam tavan \(aralık\) 00:00'dan beri$/);
});

test('title: the texts of every kind of notification', () => {
  const en = textsFor('en');
  const tr = textsFor('tr');
  assert.deepEqual(en.openTitle, { locked: 'MINI locked, but a part is open', unlocked: 'MINI not locked, a part is open', unknown: 'MINI: a part is open' });
  assert.deepEqual(tr.openTitle, { locked: 'MINI kilitlendi ama açık parça var', unlocked: 'MINI kilitli değil, açık parça var', unknown: "MINI'de açık parça var" });
  assert.deepEqual(tr.stillOpenTitle, {
    locked: 'MINI kilitli ama hala açık parça var',
    unlocked: 'MINI kilitli değil, hala açık parça var',
    unknown: "MINI'de hala açık parça var",
  });
  assert.equal(tr.silenceTitle, "MINI'den veri gelmiyor");
  assert.equal(tr.testTitle, 'MINI deneme bildirimi');
  assert.equal(tr.openBody('i kapı'), 'İ kapı', 'Turkish upper case: i becomes İ');
  assert.equal(en.openBody('sunroof since 10:00'), 'Sunroof since 10:00');
});

// ---- No "everything is closed" when you came back to the car (with lock_confirm) ----

// An alert at minute 24 (the sunroof is open when the car locks). Then somebody opens a door and closes the sunroof.
// (Before minute 54: the first reminder is due 30 minutes after the alert.)
const returnAndClose = (closeAt = 42) => [
  [40, { [LOCK]: 'UNLOCKED' }],
  [41, DOOR_OPEN],
  [41.2, DOOR_CLOSED],
  [closeAt, { [TILT]: 'CLOSED' }],
];

test('closed: a door opened after the alert, then the part closes: no "everything is closed" with lock_confirm', async () => {
  const events = tripWith([...returnAndClose(42), [46, { [LOCK]: 'SECURED' }]]);
  const sent = await simulate(events, 0, 120, { lock_confirm: true });
  assert.equal(sent.length, 2, sent.map(([, text]) => text).join(' | '));
  assert.match(sent[0][1], /MINI locked, but a part is open: Sunroof \(tilted\)/);
  assert.match(sent[1][1], /MINI locked: Everything is closed\.$/, 'the lock says it');
});

test('closed: without lock_confirm the message "everything is closed" stays', async () => {
  const events = tripWith([...returnAndClose(42), [46, { [LOCK]: 'SECURED' }]]);
  const sent = await simulate(events, 0, 120);
  assert.equal(sent.length, 2);
  assert.match(sent[1][1], /MINI: Everything is closed\.$/);
});

test('closed: no door opened after the alert (comfort close, a part that closes alone): the message stays', async () => {
  const events = tripWith([[40, { [TILT]: 'CLOSED' }]]);
  const sent = await simulate(events, 0, 80, { lock_confirm: true });
  assert.equal(sent.length, 2);
  assert.match(sent[1][1], /MINI: Everything is closed\.$/);
});

test('closed: a part that closes during the next drive gives the lock confirmation at the park, not "everything is closed"', async () => {
  const events = tripWith([
    [30, { [LOCK]: 'UNLOCKED' }], // back at the car, the sunroof is still open
    [31, DOOR_OPEN],
    [31.2, DOOR_CLOSED],
    [36, { [LOCK]: 'LOCKED' }],
    ...drive(39, 52, 130),
    [48, { [TILT]: 'CLOSED' }], // the sunroof closes during the drive
    [56, { [LOCK]: 'UNLOCKED' }],
    [57, DOOR_OPEN],
    [57.2, DOOR_CLOSED],
    [58, { [LOCK]: 'SECURED' }],
  ]);
  const sent = await simulate(events, 0, 100, { ...DETAILS, lock_confirm: true });
  assert.equal(sent.length, 2, sent.map(([, text]) => text).join(' | '));
  assert.match(sent[0][1], /MINI locked, but a part is open: /);
  assert.match(sent[1][1], /MINI locked: Everything is closed\. \(drive 20 min, battery 64%, range 187 km\)$/);
});

test('details: no drive since the last notification, no details (opening the doors and locking again)', async () => {
  const events = tripWith([
    [23.5, { [TILT]: 'CLOSED' }],
    [140, { [LOCK]: 'UNLOCKED' }], // 2 hours later: a door opens, the car locks again, the car did not drive
    [141, DOOR_OPEN],
    [141.2, DOOR_CLOSED],
    [142, { [LOCK]: 'SECURED' }],
  ]);
  const sent = await simulate(events, 0, 200, { ...DETAILS, lock_confirm: true });
  assert.equal(sent.length, 2);
  assert.match(sent[0][1], /MINI locked: Everything is closed\. \(drive 20 min, battery 64%, range 187 km\)$/, 'after the drive');
  assert.match(sent[1][1], /MINI locked: Everything is closed\.$/, 'no drive since');
});

test('details: the next drive brings them back', async () => {
  const events = tripWith([
    [23.5, { [TILT]: 'CLOSED' }],
    [140, { [LOCK]: 'UNLOCKED' }],
    [141, DOOR_OPEN],
    [141.2, DOOR_CLOSED],
    [142, { [LOCK]: 'SECURED' }],
    [200, { [LOCK]: 'UNLOCKED' }], // the second drive: 9 minutes
    [201, DOOR_OPEN],
    [201.2, DOOR_CLOSED],
    [202, { [LOCK]: 'LOCKED' }],
    ...drive(205, 211, 300),
    [211, { [LOCK]: 'UNLOCKED' }],
    [212, DOOR_OPEN],
    [212.2, DOOR_CLOSED],
    [213, { [LOCK]: 'SECURED' }],
  ]);
  const sent = await simulate(events, 0, 260, { ...DETAILS, lock_confirm: true });
  assert.equal(sent.length, 3);
  assert.match(sent[1][1], /MINI locked: Everything is closed\.$/);
  assert.match(sent[2][1], /MINI locked: Everything is closed\. \(drive 9 min, battery 64%, range 187 km\)$/);
});

test('details: a car without an odometer value shows what it has', async () => {
  const events = [
    [0, { [TILT]: 'OPEN', [SOC]: 80 }],
    [1, DOOR_OPEN],
    [1.2, DOOR_CLOSED],
    [22, DOOR_OPEN],
    [22.2, DOOR_CLOSED],
  ];
  const sent = await simulate(events, 0, 60, DETAILS);
  assert.match(sent[0][1], /\(battery 80%\)$/);
});

// ---- Charging state at the end of a notification ----

const CHARGING_PORT = 'vehicle.body.chargingPort.status';
const CHARGING_STATUS = 'vehicle.drivetrain.electricEngine.charging.status';
const CHARGE_ON = { [CHARGING_PORT]: 'CONNECTED', [CHARGING_STATUS]: 'CHARGINGACTIVE' };
const CHARGE_CFG = { notify_trip: true, notify_battery: true, lock_confirm: true };
// The first drive ends at minute 22, the car is locked at minute 24 with every part closed (a lock confirmation).
const parkedTrip = (extra = []) => tripWith([[23.5, { [TILT]: 'CLOSED' }], ...extra]);

test('charging: the state with the battery level after the drive length, instead of the battery and the range', async () => {
  const sent = await simulate(parkedTrip([[23.6, CHARGE_ON]]), 0, 40, CHARGE_CFG);
  assert.equal(sent.length, 1);
  assert.match(sent[0][1], /MINI locked: Everything is closed\. \(drive 20 min, charging 64%\)$/);
});

test('charging: without a drive since the last notification the charging state still shows (alone)', async () => {
  const events = parkedTrip([
    [23.6, CHARGE_ON],
    [140, { [LOCK]: 'UNLOCKED' }], // 2 hours later: a door opens, the car locks again, no drive
    [141, DOOR_OPEN],
    [141.2, DOOR_CLOSED],
    [142, { [LOCK]: 'SECURED' }],
  ]);
  const sent = await simulate(events, 0, 200, CHARGE_CFG);
  assert.equal(sent.length, 2);
  assert.match(sent[0][1], /\(drive 20 min, charging 64%\)$/);
  assert.match(sent[1][1], /MINI locked: Everything is closed\. \(charging 64%\)$/);
});

test('charging: the notification waits while the car prepares to charge, then shows the result', async () => {
  const events = parkedTrip([
    [23.6, { [CHARGING_PORT]: 'CONNECTED', [CHARGING_STATUS]: 'INITIALIZATION' }],
    [24.2, { [CHARGING_STATUS]: 'CHARGINGACTIVE' }],
  ]);
  const sent = await simulate(events, 0, 40, CHARGE_CFG);
  assert.equal(sent.length, 1);
  assert.ok(sent[0][0] > 24 && sent[0][0] <= 24.5, `after the status changed, not at the lock (minute ${sent[0][0]})`);
  assert.match(sent[0][1], /\(drive 20 min, charging 64%\)$/);
});

test('charging: after 30 seconds the notification shows the status of that moment', async () => {
  const events = parkedTrip([[23.6, { [CHARGING_PORT]: 'CONNECTED', [CHARGING_STATUS]: 'INITIALIZATION' }]]);
  const sent = await simulate(events, 0, 40, CHARGE_CFG);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 24.5, '30 seconds after the lock');
  assert.match(sent[0][1], /\(drive 20 min, charging is starting 64%\)$/);
});

test('charging: no wait without notify_battery or without a plug', async () => {
  const events = parkedTrip([[23.6, { [CHARGING_PORT]: 'CONNECTED', [CHARGING_STATUS]: 'INITIALIZATION' }]]);
  const off = await simulate(events, 0, 40, { ...CHARGE_CFG, notify_battery: false });
  assert.equal(off[0][0], 24, 'at the lock');
  assert.match(off[0][1], /\(drive 20 min\)$/);
  const unplugged = parkedTrip([[23.6, { [CHARGING_PORT]: 'DISCONNECTED', [CHARGING_STATUS]: 'INITIALIZATION' }]]);
  assert.equal((await simulate(unplugged, 0, 40, CHARGE_CFG))[0][0], 24);
});

test('charging: an alert "left open" waits for the result too', async () => {
  const events = tripWith([
    [23.6, { [CHARGING_PORT]: 'CONNECTED', [CHARGING_STATUS]: 'INITIALIZATION' }],
    [24.2, { [CHARGING_STATUS]: 'CHARGINGACTIVE' }],
  ]);
  const sent = await simulate(events, 0, 40, CHARGE_CFG);
  assert.equal(sent.length, 1);
  assert.match(sent[0][1], /MINI locked, but a part is open: Sunroof \(tilted\) since 00:24 \(drive 20 min, charging 64%\)$/);
});

test('charging: plugged in without charging shows, a car that is not plugged in shows nothing', async () => {
  const idle = await simulate(parkedTrip([[23.6, { [CHARGING_PORT]: 'CONNECTED', [CHARGING_STATUS]: 'NOCHARGING' }]]), 0, 40, CHARGE_CFG);
  assert.match(idle[0][1], /\(drive 20 min, plugged in but not charging 64%\)$/);
  const away = await simulate(
    parkedTrip([[23.6, { [CHARGING_PORT]: 'DISCONNECTED', [CHARGING_STATUS]: 'NOCHARGING' }]]),
    0,
    40,
    { ...CHARGE_CFG, notify_battery_below_pct: 30 },
  );
  assert.match(away[0][1], /\(drive 20 min\)$/, 'no plug: the battery rule of the level applies (64% is not below 30%)');
});

test('charging: the level limit does not apply while charging, and a low level shows without the range', async () => {
  const events = lockedTrip([
    [7, { [SOC]: 25, [RANGE_KOMBI]: 80 }],
    [23.5, { [TILT]: 'CLOSED' }],
    [23.6, CHARGE_ON],
  ]);
  const sent = await simulate(events, 0, 40, { ...CHARGE_CFG, notify_battery_below_pct: 30 });
  assert.match(sent[0][1], /\(drive 20 min, charging 25%\)$/);
  const high = await simulate(parkedTrip([[23.6, CHARGE_ON]]), 0, 40, { ...CHARGE_CFG, notify_battery_below_pct: 30 });
  assert.match(high[0][1], /\(drive 20 min, charging 64%\)$/, 'charging 64% shows although the limit is 30%');
});

test('charging: without a battery level only the state shows, and the other states', async () => {
  const noLevel = await simulate(lockedTrip([[23.5, { [TILT]: 'CLOSED' }], [23.6, CHARGE_ON]]), 0, 40, CHARGE_CFG);
  assert.match(noLevel[0][1], /\(drive 20 min, charging\)$/);
  for (const [status, text] of [
    ['CHARGINGPAUSED', 'charging paused'],
    ['CHARGINGENDED', 'charging ended'],
    ['CHARGINGERROR', 'charging error'],
  ]) {
    const sent = await simulate(parkedTrip([[23.6, { [CHARGING_PORT]: 'CONNECTED', [CHARGING_STATUS]: status }]]), 0, 40, CHARGE_CFG);
    assert.match(sent[0][1], new RegExp(`\\(drive 20 min, ${text} 64%\\)$`), status);
  }
});

test('charging: Turkish texts', async () => {
  const cfg = { ...CHARGE_CFG, language: 'tr' };
  const active = await simulate(parkedTrip([[23.6, CHARGE_ON]]), 0, 40, cfg);
  assert.match(active[0][1], /\(sürüş 20 dk, şarj oluyor %64\)$/);
  const texts = textsFor('tr').charge;
  assert.deepEqual(texts, {
    active: 'şarj oluyor',
    starting: 'şarj başlatılıyor',
    paused: 'şarj duraklatıldı',
    ended: 'şarj tamamlandı',
    error: 'şarj hatası',
    idle: 'fiş takılı ama şarj olmuyor',
  });
});

test('charging: off without notify_battery', async () => {
  const sent = await simulate(parkedTrip([[23.6, CHARGE_ON]]), 0, 40, { ...CHARGE_CFG, notify_battery: false });
  assert.match(sent[0][1], /\(drive 20 min\)$/);
});

test('charging: the state keeps the plug and the charging status for a restart', () => {
  const { watcher, at } = virtualWatcher(DETAILS);
  watcher.onData(msg({ [SOC]: 71, ...CHARGE_ON }), at(5));
  const snap = JSON.parse(JSON.stringify(watcher.snapshot()));
  const restored = virtualWatcher(DETAILS);
  restored.at(10);
  restored.watcher.restoreWatch(snap);
  assert.equal(restored.watcher.chargeKind(), 'active');
  assert.equal(restored.watcher.detailsText(textsFor('en')), ' (charging 71%)');
});

test('details: a state from an older version (no lastSentAt) shows no details for the old drive', () => {
  const { watcher, at } = virtualWatcher(DETAILS);
  watcher.onData(msg({ [KM]: 100, [LOCK]: 'LOCKED' }), at(2));
  watcher.onData(msg({ [KM]: 101, [SOC]: 71 }), at(6));
  watcher.onData(msg({ [LOCK]: 'UNLOCKED' }), at(22));
  const snap = JSON.parse(JSON.stringify(watcher.snapshot()));
  assert.equal(watcher.detailsText(textsFor('en')), ' (drive 20 min, battery 71%)', 'a new state: the drive is not announced yet');
  delete snap.lastSentAt;
  const restored = virtualWatcher(DETAILS);
  restored.at(30);
  restored.watcher.restoreWatch(snap);
  assert.equal(restored.watcher.detailsText(textsFor('en')), '');
});

test('details: off by default, and each part has its own setting', async () => {
  assert.doesNotMatch((await simulate(tripWith(), 0, 40))[0][1], /\(drive/);
  assert.match((await simulate(tripWith(), 0, 40, { notify_trip: true }))[0][1], /\(drive 20 min\)$/);
  assert.match((await simulate(tripWith(), 0, 40, { notify_battery: true }))[0][1], /\(battery 64%, range 187 km\)$/);
});

test('details: a range in miles is shown in kilometres, the first battery attribute wins', async () => {
  const miles = await simulate(lockedTrip([[7, { [RANGE_KOMBI]: { value: 100, unit: 'mi' } }]]), 0, 40, { notify_battery: true });
  assert.match(miles[0][1], /\(range 161 km\)$/);
  const both = await simulate(lockedTrip([[7, { [SOC_HEADER]: 50, [SOC]: 64.4, [RANGE_LAST]: 300, [RANGE_KOMBI]: 200 }]]), 0, 40, { notify_battery: true });
  assert.match(both[0][1], /\(battery 64%, range 200 km\)$/);
  const second = await simulate(lockedTrip([[7, { [SOC_HEADER]: 50, [RANGE_LAST]: 300 }]]), 0, 40, { notify_battery: true });
  assert.match(second[0][1], /\(battery 50%, range 300 km\)$/);
});

test('details: a value outside the range or not a number is ignored', async () => {
  const sent = await simulate(lockedTrip([[7, { [SOC]: 140, [RANGE_KOMBI]: 'n/a' }]]), 0, 40, { notify_battery: true });
  assert.doesNotMatch(sent[0][1], /\((drive|battery|range)/);
});

test('details: with notify_battery_below_pct the battery level and the range show only below that level', async () => {
  const limited = { ...DETAILS, notify_battery_below_pct: 30 };
  const low = await simulate(lockedTrip([[7, { [SOC]: 24.6, [RANGE_KOMBI]: { value: 80, unit: 'km' } }]]), 0, 40, limited);
  assert.match(low[0][1], /\(drive 20 min, battery 25%, range 80 km\)$/);
  const high = await simulate(tripWith(), 0, 40, limited);
  assert.match(high[0][1], /\(drive 20 min\)$/, 'only the drive length above the limit');
  const exact = await simulate(lockedTrip([[7, { [SOC]: 30, [RANGE_KOMBI]: 100 }]]), 0, 40, limited);
  assert.match(exact[0][1], /\(drive 20 min\)$/, 'exactly 30% is not below 30%');
  const rounded = await simulate(lockedTrip([[7, { [SOC]: 29.6, [RANGE_KOMBI]: 100 }]]), 0, 40, limited);
  assert.match(rounded[0][1], /\(drive 20 min\)$/, 'the rounded level 30% is not below 30%');
  const noBattery = await simulate(lockedTrip([[7, { [RANGE_KOMBI]: 80 }]]), 0, 40, limited);
  assert.match(noBattery[0][1], /\(drive 20 min\)$/, 'without the level the program cannot know that it is low');
});

test('details: without notify_trip a low level shows alone, a high level adds nothing', async () => {
  const sent = await simulate(lockedTrip([[7, { [SOC]: 12, [RANGE_KOMBI]: 40 }]]), 0, 40, { notify_battery: true, notify_battery_below_pct: 30 });
  assert.match(sent[0][1], /\(battery 12%, range 40 km\)$/);
  const high = await simulate(tripWith(), 0, 40, { notify_battery: true, notify_battery_below_pct: 30 });
  assert.doesNotMatch(high[0][1], /\((drive|battery|range)/, 'nothing to add');
});

test('details: the level of 100% shows by default (no limit)', async () => {
  const full = await simulate(lockedTrip([[7, { [SOC]: 100, [RANGE_KOMBI]: 300 }]]), 0, 40, DETAILS);
  assert.match(full[0][1], /\(drive 20 min, battery 100%, range 300 km\)$/);
  assert.equal(DEFAULT_CONFIG.notify_battery_below_pct, 100);
});

test('details: notify_battery_below_pct must be a number from 1 to 100', () => {
  for (const ok of [1, 30, 100]) checkConfig({ ...DEFAULT_CONFIG, notify_battery_below_pct: ok });
  for (const bad of [0, 101, -5, '30', null, NaN]) {
    assert.throws(() => checkConfig({ ...DEFAULT_CONFIG, notify_battery_below_pct: bad }), /notify_battery_below_pct/);
  }
});

test('details: a stop shorter than 10 minutes belongs to the same drive, a longer stop does not', async () => {
  const leg = (from) => [[from, { [LOCK]: 'LOCKED' }], ...drive(from + 3, from + 10, 200 + from)];
  const trip = (stop) => [
    [0, { [KM]: 100, [TILT]: 'OPEN' }],
    ...leg(2),
    [14, { [LOCK]: 'UNLOCKED' }], // a stop
    ...leg(14 + stop),
    [14 + stop + 14, { [LOCK]: 'UNLOCKED' }], // the end
    [14 + stop + 15, DOOR_OPEN],
    [14 + stop + 15.2, DOOR_CLOSED],
    [14 + stop + 16, { [LOCK]: 'SECURED' }],
  ];
  const short = await simulate(trip(5), 0, 120, { notify_trip: true });
  assert.match(short[0][1], /\(drive 31 min\)$/, 'from minute 2 to minute 33, the stop of 5 minutes included');
  const long = await simulate(trip(15), 0, 120, { notify_trip: true });
  assert.match(long[0][1], /\(drive 14 min\)$/, 'only the last leg');
});

test('details: a drive after a notification is a new drive, also after a stop shorter than 10 minutes', async () => {
  const events = [
    [0, { [KM]: 100, [LOCK]: 'SECURED' }],
    [1, { [LOCK]: 'UNLOCKED' }],
    [1.5, DOOR_OPEN],
    [1.8, DOOR_CLOSED],
    [2, { [LOCK]: 'LOCKED' }],
    ...drive(6, 21, 101),
    [22, { [LOCK]: 'UNLOCKED' }], // the first drive: 20 minutes
    [23, DOOR_OPEN],
    [23.2, DOOR_CLOSED],
    [24, { [LOCK]: 'SECURED' }], // the notification of the first drive
    [26, { [LOCK]: 'UNLOCKED' }], // a stop of 5 minutes (a cash machine)
    [26.5, DOOR_OPEN],
    [26.7, DOOR_CLOSED],
    [27, { [LOCK]: 'LOCKED' }],
    ...drive(30, 36, 300),
    [37, { [LOCK]: 'UNLOCKED' }], // the second drive: 10 minutes
    [38, DOOR_OPEN],
    [38.2, DOOR_CLOSED],
    [39, { [LOCK]: 'SECURED' }],
  ];
  const sent = await simulate(events, 0, 80, { notify_trip: true, lock_confirm: true });
  assert.equal(sent.length, 2);
  assert.match(sent[0][1], /\(drive 20 min\)$/);
  assert.match(sent[1][1], /\(drive 10 min\)$/, 'not 35 minutes: the first drive was announced already');
});

test('details: the lock after parking (LOCKED, then SECURED) does not change the drive length', async () => {
  const events = tripWith([
    [23.2, { [LOCK]: 'LOCKED' }], // the car locks itself when you walk away
    [23.4, { [TILT]: 'CLOSED' }],
  ]);
  const sent = await simulate(events, 0, 80, { ...DETAILS, lock_confirm: true });
  assert.match(sent[0][1], /\(drive 20 min, battery 64%, range 187 km\)$/);
});

test('details: a car without lock data shows no drive length, but the battery', async () => {
  const events = [
    [0, { [KM]: 100, [TILT]: 'OPEN', [SOC]: 80 }],
    [1, DOOR_OPEN],
    [1.2, DOOR_CLOSED],
    ...drive(5, 20, 101),
    [22, DOOR_OPEN],
    [22.2, DOOR_CLOSED],
  ];
  const sent = await simulate(events, 0, 60, DETAILS);
  assert.match(sent[0][1], /\(battery 80%\)$/);
});

test('details: the state keeps the drive and the readings for a restart', () => {
  const { watcher, at } = virtualWatcher(DETAILS);
  watcher.onData(msg({ [KM]: 100, [LOCK]: 'LOCKED' }), at(2));
  watcher.onData(msg({ [KM]: 101, [SOC]: 71, [RANGE_KOMBI]: { value: 150, unit: 'km' } }), at(6));
  watcher.onData(msg({ [LOCK]: 'UNLOCKED' }), at(22));
  const snap = JSON.parse(JSON.stringify(watcher.snapshot()));
  const restored = virtualWatcher(DETAILS).watcher;
  restored.restoreWatch(snap);
  assert.equal(restored.detailsText(textsFor('en')), ' (drive 20 min, battery 71%, range 150 km)');
});

test('details: the settings must be true or false', () => {
  checkConfig({ ...DEFAULT_CONFIG, notify_trip: true, notify_battery: true });
  for (const key of ['notify_trip', 'notify_battery']) {
    assert.throws(() => checkConfig({ ...DEFAULT_CONFIG, [key]: 'yes' }), new RegExp(key));
  }
});

test('details: a stop with SELECTIVELOCKED does not end the drive (the unlock at the arrival is the end)', async () => {
  const events = [
    [0, { [KM]: 100, [TILT]: 'OPEN' }],
    [2, { [LOCK]: 'LOCKED' }],
    ...drive(5, 11, 101),
    [12, { [LOCK]: 'SELECTIVELOCKED' }], // a rear door opens while the car still rolls
    [14, { [KM]: 200, [LOCK]: 'UNLOCKED' }], // the arrival
    [15, DOOR_OPEN],
    [15.2, DOOR_CLOSED],
    [16, { [LOCK]: 'SECURED' }],
  ];
  const sent = await simulate(events, 0, 60, { notify_trip: true });
  assert.match(sent[0][1], /\(drive 12 min\)$/, 'from minute 2 to minute 14, not to minute 12');
});

test('details: the odometer after the lock left LOCKED extends the drive', async () => {
  const events = [
    [0, { [KM]: 100, [TILT]: 'OPEN' }],
    [2, { [LOCK]: 'LOCKED' }],
    ...drive(5, 11, 101),
    [12, { [LOCK]: 'SELECTIVELOCKED' }],
    [15, { [KM]: 300 }],
    [16, { [LOCK]: 'UNLOCKED' }],
    [17, DOOR_OPEN],
    [17.2, DOOR_CLOSED],
    [18, { [LOCK]: 'SECURED' }],
  ];
  const sent = await simulate(events, 0, 60, { notify_trip: true });
  assert.match(sent[0][1], /\(drive 14 min\)$/, 'from minute 2 to the unlock at minute 16');
});

test('log: the line of an accepted notification has the title, the text, the ntfy id and the HTTP status', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ id: 'abc123XYZ', time: 1, event: 'message', topic: 'x' }), { status: 200 });
  let lines;
  try {
    lines = await logsDuring(async () => {
      assert.equal(await ntfy(ntfyConfig, 'MINI kilitlendi', 'Her şey kapalı.', 'default', 'lock'), true);
    });
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(lines, ['Notification accepted by ntfy: MINI kilitlendi: Her şey kapalı. (ntfy id abc123XYZ, HTTP 200, time 1970-01-01T00:00:01.000Z)']);
});

test('log: a failed notification names the reason', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('server error', { status: 503 });
  let lines;
  try {
    lines = await logsDuring(async () => {
      assert.equal(await ntfy(ntfyConfig, 't', 'm'), false);
    });
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(lines, ['Notification failed: HTTP 503']);
});

test('lock confirmation: a suppressed lock counts as handled, a later lock without a door gives nothing', async () => {
  const events = lockedTrip([
    [40, { [TILT]: 'CLOSED' }], // "left open" at 24, "everything is closed" at 40
    [40.2, { [LOCK]: 'UNLOCKED' }],
    [40.4, DOOR_OPEN],
    [40.6, DOOR_CLOSED],
    [40.8, { [LOCK]: 'SECURED' }], // less than 2 minutes after the closed message: nothing, but handled
    [100, { [LOCK]: 'UNLOCKED' }], // hours later: a key near the car, no door
    [100.25, { [LOCK]: 'SECURED' }],
  ]);
  const sent = await simulate(events, 0, 160, CONFIRM);
  assert.deepEqual(sent.map(([m]) => m), [24, 40.25]);
});

// ---- "Everything is closed" waits 15 seconds ----

test('closed: a check between two doors does not send the message, the message comes 15 seconds after the last door', async () => {
  const events = [
    [0, { [KM]: 100, [TILT]: 'OPEN' }],
    [1, DOOR_OPEN],
    [1.2, DOOR_CLOSED],
    [12, { [LOCK]: 'UNLOCKED' }], // back at the car after the "left open" alert at minute 11
    [12.5, DOOR_OPEN],
    [12.6, DOOR_CLOSED],
    [13, { [TILT]: 'CLOSED' }], // everything is closed from here, but a door opens 6 seconds later
    [13.1, { [REAR_DOOR]: true }],
    [14, { [REAR_DOOR]: false }],
  ];
  const sent = await simulate(events, 0, 40);
  assert.deepEqual(sent.map(([m]) => m), [11, 14.25], 'not at 13.25 between the two doors, but 15 seconds after the last door at 14');
  assert.match(sent[1][1], /Everything is closed\./);
});

test('closed: the message waits for the 15 seconds, also with a direct check', async () => {
  const { watcher, at } = virtualWatcher();
  watcher.onData(msg({ [WIN]: 'OPEN' }), at(0));
  at(10);
  await logsDuring(() => watcher.check());
  watcher.onData(msg({ [WIN]: 'CLOSED' }), at(11));
  for (const seconds of [0, 5, 14]) {
    at(11 + seconds / 60);
    assert.equal((await logsDuring(() => watcher.check())).length, 0, `${seconds} s`);
  }
  at(11 + 15 / 60);
  assert.equal((await logsDuring(() => watcher.check())).length, 1, '15 s');
});

test('closed: the main loop checks every 5 seconds while a closed message waits, else every 15', async () => {
  const fleet = new Fleet(baseConfig, { clock: () => 0 });
  assert.equal(fleet.nextCheckDelayMs(), 15_000);
  const watcher = fleet.watcher(VIN_A);
  watcher.alerted = true;
  watcher.sawClose = true;
  assert.equal(fleet.nextCheckDelayMs(), 5_000);
  watcher.openSince.set(WIN, 0);
  assert.equal(fleet.nextCheckDelayMs(), 15_000, 'a part is open: nothing waits');
});
