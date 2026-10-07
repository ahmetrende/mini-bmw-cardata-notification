// Run with: npm test
// These tests use fake car data. They do not call BMW or ntfy.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG, Watcher, formatTime, label, turkishFromSuffix } from '../mini_watch.mjs';

const KM = 'vehicle.vehicle.travelledDistance';
const TILT = 'vehicle.cabin.sunroof.tiltStatus';
const WIN = 'vehicle.cabin.window.row1.passenger.status';
const DRIVER_DOOR = 'vehicle.cabin.door.row1.driver.isOpen';
const IGNITION = 'vehicle.drivetrain.engine.isIgnitionOn';

const msg = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }]));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Short times so the tests run fast. ntfy_topic is empty, so a notification goes to the log.
const baseConfig = { ...DEFAULT_CONFIG, language: 'en', timezone: 'UTC', alert_after_min: 0.002, remind_every_min: 30, park_after_idle_min: 0.005, ntfy_topic: '' };

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

test('no notification while driving, one combined notification after the driver leaves', async () => {
  const watcher = new Watcher(baseConfig);
  watcher.onData(msg({ [KM]: 100, [TILT]: 'OPEN' }));
  watcher.onData(msg({ [WIN]: 'INTERMEDIATE' }));
  watcher.onData(msg({ [KM]: 101 }));
  await wait(200);
  assert.deepEqual(await logsDuring(() => watcher.check()), [], 'driving: silent');

  watcher.onData(msg({ [DRIVER_DOOR]: true })); // the driver leaves the car
  await wait(200);
  const lines = await logsDuring(() => watcher.check());
  assert.equal(lines.length, 1, 'one combined notification');
  // The driver door is still open, so it is in the list too. The oldest open part comes first.
  assert.match(
    lines[0],
    /MINI left open: Open: sunroof \(tilted\) since \d\d:\d\d, front right window since \d\d:\d\d, front left door since \d\d:\d\d/,
  );
});

test('a new drive resets the notification memory', async () => {
  const watcher = new Watcher(baseConfig);
  watcher.onData(msg({ [KM]: 100, [TILT]: 'OPEN' }));
  watcher.onData(msg({ [KM]: 101 }));
  watcher.onData(msg({ [DRIVER_DOOR]: true }));
  await wait(200);
  assert.equal((await logsDuring(() => watcher.check())).length, 1);
  assert.equal((await logsDuring(() => watcher.check())).length, 0, 'no repeat');
  watcher.onData(msg({ [KM]: 102 })); // the car drives again
  watcher.onData(msg({ [DRIVER_DOOR]: true }));
  await wait(200);
  assert.equal((await logsDuring(() => watcher.check())).length, 1, 'new park, new notification');
});

test('the car counts as parked when the odometer stays still', async () => {
  const watcher = new Watcher(baseConfig);
  watcher.onData(msg({ [KM]: 100, [WIN]: 'OPEN' }));
  watcher.onData(msg({ [KM]: 101 }));
  await wait(150);
  assert.equal((await logsDuring(() => watcher.check())).length, 0, 'the odometer rose a moment ago');
  await wait(250);
  assert.equal((await logsDuring(() => watcher.check())).length, 1, 'idle time is over');
});

test('without odometer data a part that stays open triggers a notification', async () => {
  const watcher = new Watcher(baseConfig);
  watcher.onData(msg({ [WIN]: 'OPEN' }));
  await wait(200);
  assert.equal((await logsDuring(() => watcher.check())).length, 1);
});

test('ignition data stops notifications while the ignition is on', async () => {
  const watcher = new Watcher(baseConfig);
  watcher.onData(msg({ [WIN]: 'OPEN', [IGNITION]: true }));
  await wait(200);
  assert.equal((await logsDuring(() => watcher.check())).length, 0);
});

test('"everything is closed" goes out once after an alert', async () => {
  const watcher = new Watcher(baseConfig);
  watcher.onData(msg({ [WIN]: 'OPEN' }));
  await wait(200);
  await logsDuring(() => watcher.check());
  watcher.onData(msg({ [WIN]: 'CLOSED' }));
  const lines = await logsDuring(() => watcher.check());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /MINI: Everything is closed\./);
  assert.equal((await logsDuring(() => watcher.check())).length, 0, 'only once');
});

test('missing data after a restart does not count as closed', async () => {
  const watcher = new Watcher(baseConfig);
  watcher.alerted = true; // state loaded from disk: an alert went out before the restart
  assert.equal((await logsDuring(() => watcher.check())).length, 0, 'no data yet, no "closed" message');
  watcher.onData(msg({ [WIN]: 'OPEN' }));
  watcher.onData(msg({ [WIN]: 'CLOSED' })); // now the program sees a real close
  const lines = await logsDuring(() => watcher.check());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Everything is closed\./);
});

test('Turkish text with language "tr"', async () => {
  const watcher = new Watcher({ ...baseConfig, language: 'tr' });
  watcher.onData(msg({ [WIN]: 'OPEN', [TILT]: 'OPEN' }));
  await wait(200);
  const lines = await logsDuring(() => watcher.check());
  assert.match(lines[0], /MINI açık kaldı: Açık: sağ ön cam \d\d:\d\d'(den|dan|ten|tan) beri, cam tavan \(aralık\) \d\d:\d\d'(den|dan|ten|tan) beri/);
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
