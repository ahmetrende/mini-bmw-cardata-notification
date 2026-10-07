#!/usr/bin/env node
// Replays saved car messages through the notification logic with a virtual clock.
// It sends nothing. It prints the notifications that the program would send.
// Use it before you restart a running server, or to check a change of the logic.
//
//   node tools/replay.mjs /opt/mini-watch/messages.jsonl [config.json] [--hours 24]
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG, Watcher, formatTime } from '../mini_watch.mjs';

const args = process.argv.slice(2);
const hoursFlag = args.indexOf('--hours');
const hours = hoursFlag >= 0 ? Number(args.splice(hoursFlag, 2)[1]) : 24;
const [messagesFile, configFile] = args;
if (!messagesFile) {
  console.error('Usage: node tools/replay.mjs <messages.jsonl> [config.json] [--hours 24]');
  process.exit(2);
}

const fileConfig = configFile ? JSON.parse(readFileSync(configFile, 'utf8')) : {};
const cfg = { ...DEFAULT_CONFIG, ...fileConfig, ntfy_topic: '' }; // empty topic: print, do not send
const end = Date.now() / 1000;
const start = end - hours * 3600;

const messages = readFileSync(messagesFile, 'utf8')
  .trim()
  .split('\n')
  .map((line) => {
    try {
      const msg = JSON.parse(line);
      return { t: msg.t, data: JSON.parse(msg.payload).data ?? {} };
    } catch {
      return null;
    }
  })
  .filter((msg) => msg && msg.t >= start)
  .sort((a, b) => a.t - b.t);

let clock = start;
const watcher = new Watcher(cfg, { clock: () => clock });
const realLog = console.log;
let count = 0;
// Notification lines start with "[ntfy off]". Other log lines show with "(log)" and do not count.
console.log = (...parts) => {
  const text = parts.slice(1).join(' ');
  const notification = text.startsWith('[ntfy off] ');
  if (notification) count += 1;
  realLog(formatTime(clock, cfg, end), notification ? text.slice('[ntfy off] '.length) : `(log) ${text}`);
};

let next = 0;
for (clock = start; clock <= end; clock += 15) {
  while (next < messages.length && messages[next].t <= clock) {
    watcher.onData(messages[next].data, messages[next].t);
    next += 1;
  }
  await watcher.check();
}
console.log = realLog;
console.log(`Replayed ${messages.length} messages of the last ${hours} hours. Notifications: ${count}.`);
