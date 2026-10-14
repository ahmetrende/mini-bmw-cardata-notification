// The files in deploy/, install.sh and the guides must agree on the log clean-up.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const service = read('deploy/mini-watch-log-clean.service');
const days = service.match(/--vacuum-time=(\d+)d\b/)?.[1];

test('log clean-up: the journal and the syslog files use the same number of days', () => {
  assert.ok(days, 'the service has --vacuum-time=<N>d');
  assert.equal(service.match(/-mtime \+(\d+)\b/)?.[1], days);
});

test('log clean-up: the timer runs at 05:00 and catches a missed run', () => {
  const timer = read('deploy/mini-watch-log-clean.timer');
  assert.match(timer, /^OnCalendar=\*-\*-\* 05:00:00$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);
});

test('log clean-up: install.sh installs both files and starts the timer', () => {
  const script = read('deploy/install.sh');
  assert.match(script, /deploy\/mini-watch-log-clean\.service/);
  assert.match(script, /deploy\/mini-watch-log-clean\.timer/);
  assert.match(script, /systemctl --quiet enable --now mini-watch-log-clean\.timer/);
});

test('log clean-up: the guides name the same number of days', () => {
  assert.match(read('docs/en/05-operations.md'), new RegExp(`log of the last ${days} days`));
  assert.match(read('docs/tr/05-isletim.md'), new RegExp(`son ${days} günün log`));
  assert.match(read('docs/en/04-server-setup.md'), new RegExp(`log of the last ${days} days`));
  assert.match(read('docs/tr/04-sunucu-kurulumu.md'), new RegExp(`Son ${days} günün log`));
});
