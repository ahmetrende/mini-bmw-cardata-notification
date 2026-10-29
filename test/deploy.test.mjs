// The files in deploy/, install.sh and the guides must agree on the log clean-up.
// The wrapper deploy/mini-watch must accept the commands of the guides.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const wrapper = read('deploy/mini-watch');

test('wrapper: ntfy-check and pushover-test are allowed commands, and all arguments go to the program', () => {
  assert.match(wrapper, /^ {2}login \| ntfy-test \| ntfy-check \| pushover-test \| doctor\) ;;$/m);
  assert.match(wrapper, /^exec runuser -u miniwatch -- .*\/mini_watch\.mjs "\$@"$/m);
  assert.match(wrapper, /Usage: sudo mini-watch login \| ntfy-test \| ntfy-check <id> \| pushover-test \| doctor"/);
  const usage = wrapper.split('\n').filter((text) => text.startsWith('#   sudo mini-watch '));
  assert.deepEqual(
    usage.map((text) => text.split(/\s+/)[3]),
    ['login', 'ntfy-test', 'ntfy-check', 'pushover-test', 'doctor'],
  );
  assert.equal(new Set(usage.map((text) => text.indexOf(' # '))).size, 1, 'the comments start in the same column');
});

test('wrapper: each "sudo mini-watch <command>" in the guides is an allowed command, and the program knows it', () => {
  const allowed = wrapper.match(/^ {2}(login \|[^)]*)\) ;;$/m)[1].split(' | ');
  const files = ['README.md', 'README.tr.md', 'AGENTS.md', ...readdirSync(new URL('docs/en/', root)).map((file) => `docs/en/${file}`), ...readdirSync(new URL('docs/tr/', root)).map((file) => `docs/tr/${file}`)];
  const used = new Set(files.flatMap((file) => [...read(file).matchAll(/sudo mini-watch ([a-z-]+)/g)].map((match) => match[1])));
  assert.ok(used.has('pushover-test') && used.has('ntfy-test'), [...used].join(', '));
  for (const command of used) assert.ok(allowed.includes(command), `${command} is used in a guide but the wrapper refuses it`);
  const usage = read('mini_watch.mjs').match(/Usage: node mini_watch\.mjs ([^']+)'/)[1];
  for (const command of allowed) assert.ok(usage.includes(command), `${command} is missing in the usage text of the program`);
});

test('wrapper: without sudo, ntfy-check exits with 2 (no conclusion), the other commands with 1', () => {
  assert.match(wrapper, /if \[ "\$\{1:-\}" = ntfy-check \]; then exit 2; fi\n {2}exit 1\nfi/);
});

// Runs the wrapper as a normal user. It stops before it reads a file or runs the program.
test('wrapper: the exit codes without sudo', { skip: process.getuid?.() === 0 ? 'the test user is root' : false }, () => {
  const script = fileURLToPath(new URL('deploy/mini-watch', root));
  for (const [args, status] of [
    [['ntfy-check', 'abc123def456'], 2],
    [['ntfy-check'], 2],
    [['ntfy-test'], 1],
    [['pushover-test'], 1],
    [['doctor'], 1],
    [[], 1],
  ]) {
    const out = spawnSync('sh', [script, ...args], { encoding: 'utf8' });
    assert.equal(out.status, status, `${args.join(' ')}: ${out.stderr}`);
    assert.match(out.stderr, /^Run it with sudo: sudo mini-watch /);
  }
});

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
