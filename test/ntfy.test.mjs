// Run with: npm test
// The answer of ntfy to a notification, and the command "ntfy-check <id>".
// These tests replace fetch with a fake ntfy server. They do not call ntfy.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, checkConfig, checkNtfyMessage, ntfy, ntfyCheck } from '../mini_watch.mjs';

const TOPIC = 'mini-0123456789abcdef01';
const cfg = { ...DEFAULT_CONFIG, ntfy_topic: TOPIC, ntfy_server: 'https://ntfy.invalid' };
const ID = 'abc123def456';
const STORED = { id: ID, time: 1790000000, expires: 1790043200, event: 'message', topic: TOPIC, title: 'MINI', message: 'Everything is closed.' };

// Replaces fetch for one call of fn. `answer` is a function (url, options) -> Response, or it throws.
// Returns the requests and the log lines (without the time).
async function withFetch(answer, fn) {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const requests = [];
  const lines = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method ?? 'GET', body: options.body });
    return answer(url, options);
  };
  console.log = (...args) => lines.push(args.slice(1).join(' '));
  let result;
  try {
    result = await fn();
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
  return { result, requests, lines };
}

const reply = (body, status = 200) => () => new Response(body, { status });

// The output of ntfy-check must not show the server address, a user name and password, or the topic name.
function assertNoSecret(text, what) {
  for (const [secret, name] of [
    ['ntfy.invalid', 'the server'],
    ['user:pw', 'the user name and password'],
    [TOPIC, 'the topic'],
  ]) {
    assert.ok(!text.includes(secret), `${what}: the output shows ${name}`);
  }
}

// ---- ntfy(): only a 2xx answer with a message id counts as sent ----

test('ntfy: HTTP 200 with a message id is accepted, the log has the id, the status, the time and the expiry', async () => {
  const { result, requests, lines } = await withFetch(reply(JSON.stringify(STORED)), () => ntfy(cfg, 'MINI locked', 'Everything is closed.', 'default', 'lock'));
  assert.equal(result, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(lines, [
    `Notification accepted by ntfy: MINI locked: Everything is closed. (ntfy id ${ID}, HTTP 200, time 2026-09-21T14:13:20.000Z, expires 2026-09-22T02:13:20.000Z)`,
  ]);
  assert.ok(!lines.join('\n').includes(TOPIC), 'the log does not show the topic');
});

test('ntfy: another 2xx status with a message id is accepted too', async () => {
  const { result, lines } = await withFetch(reply(JSON.stringify({ id: ID }), 201), () => ntfy(cfg, 't', 'm'));
  assert.equal(result, true);
  assert.deepEqual(lines, [`Notification accepted by ntfy: t: m (ntfy id ${ID}, HTTP 201)`], 'no time and no expiry without the fields');
});

test('ntfy: time and expires show only when they are finite numbers', async () => {
  for (const extra of [{ time: '1790000000', expires: null }, { time: 1e300, expires: Number.NaN }, { time: [1] }]) {
    const { result, lines } = await withFetch(reply(JSON.stringify({ id: ID, ...extra })), () => ntfy(cfg, 't', 'm'));
    assert.equal(result, true, JSON.stringify(extra));
    assert.deepEqual(lines, [`Notification accepted by ntfy: t: m (ntfy id ${ID}, HTTP 200)`], JSON.stringify(extra));
  }
});

test('ntfy: an id with control characters is accepted, but it cannot split the log line', async () => {
  for (const [id, shown] of [
    ['abc\ndef\r\u2028x\u0007', 'abcdefx'],
    [' \n ', '(not printable)'],
  ]) {
    const { result, lines } = await withFetch(reply(JSON.stringify({ id })), () => ntfy(cfg, 't', 'm'));
    assert.equal(result, true, 'the message is accepted: a strict id check would send it again');
    assert.deepEqual(lines, [`Notification accepted by ntfy: t: m (ntfy id ${shown}, HTTP 200)`]);
    assert.ok(!/[\n\r\u2028\u2029]/.test(lines[0]), 'one log line');
  }
});

for (const [name, body] of [
  ['a body that is not JSON', 'not-json'],
  ['an empty object', '{}'],
  ['an empty body', ''],
  ['a JSON array', JSON.stringify([STORED])],
  ['an empty id', '{"id":""}'],
  ['an id that is not a string', '{"id":123456}'],
  ['JSON null', 'null'],
  ['a body larger than the limit', JSON.stringify({ id: ID, pad: 'x'.repeat(70 * 1024) })],
]) {
  test(`ntfy: HTTP 200 with ${name} is not confirmed and returns false`, async () => {
    const { result, lines } = await withFetch(reply(body), () => ntfy(cfg, 't', 'm'));
    assert.equal(result, false);
    assert.deepEqual(lines, ['Notification not confirmed: HTTP 200, the answer of ntfy has no message id']);
  });
}

test('ntfy: HTTP 503 fails and returns false', async () => {
  const { result, lines } = await withFetch(reply('server error', 503), () => ntfy(cfg, 't', 'm'));
  assert.equal(result, false);
  assert.deepEqual(lines, ['Notification failed: HTTP 503']);
});

test('ntfy: a network error fails and returns false', async () => {
  const { result, lines } = await withFetch(
    () => {
      throw new Error('connection refused');
    },
    () => ntfy(cfg, 't', 'm'),
  );
  assert.equal(result, false);
  assert.deepEqual(lines, ['Notification failed: connection refused']);
});

test('ntfy: without a topic the text goes to the log and nothing is sent', async () => {
  const { result, requests, lines } = await withFetch(reply(JSON.stringify(STORED)), () => ntfy({ ...cfg, ntfy_topic: '' }, 't', 'm'));
  assert.equal(result, true);
  assert.equal(requests.length, 0);
  assert.deepEqual(lines, ['[ntfy off] t: m']);
});

// ---- checkNtfyMessage() and the command "ntfy-check <id>" ----

test('ntfy-check: found, with one GET request to the cache of the topic', async () => {
  const { result, requests } = await withFetch(reply(`${JSON.stringify(STORED)}\n`), () => checkNtfyMessage(cfg, ID));
  assert.equal(result.status, 'found');
  assert.equal(result.message.title, 'MINI');
  assert.deepEqual(requests, [{ url: `https://ntfy.invalid/${TOPIC}/json?poll=1&id=${ID}`, method: 'GET', body: undefined }]);
});

test('ntfy-check: found prints the id, the title, the text, the time and the expiry, exit code 0, no topic', async () => {
  const { result, lines } = await withFetch(reply(`${JSON.stringify(STORED)}\n`), () => ntfyCheck(cfg, ID));
  assert.equal(result, 0);
  assert.deepEqual(lines.slice(0, 5), [
    `Result: found. ntfy has the message ${ID}.`,
    'Title: MINI',
    'Text: Everything is closed.',
    'Time: 2026-09-21T14:13:20.000Z',
    'Expires: 2026-09-22T02:13:20.000Z',
  ]);
  assert.ok(!lines.join('\n').includes(TOPIC), 'the output does not show the topic');
  assert.ok(!lines.join('\n').includes('ntfy.invalid'), 'the output does not show the server');
});

test('ntfy-check: found prints the title and the text on one line each, without the topic', async () => {
  const stored = { ...STORED, title: `MINI\nfake line ${TOPIC}`, message: '' };
  const { result, lines } = await withFetch(reply(`${JSON.stringify(stored)}\n`), () => ntfyCheck(cfg, ID));
  assert.equal(result, 0);
  assert.deepEqual(lines.slice(1, 3), ['Title: MINI fake line <topic>', 'Text: (none)']);
  assertNoSecret(lines.join('\n'), 'found');
});

test('ntfy-check: a server address with a slash at the end gives the right request URL', async () => {
  for (const [server, expected] of [
    ['https://ntfy.invalid/', `https://ntfy.invalid/${TOPIC}/json?poll=1&id=${ID}`],
    ['https://ntfy.invalid//', `https://ntfy.invalid/${TOPIC}/json?poll=1&id=${ID}`],
    ['https://user:pw@ntfy.invalid/base/', `https://user:pw@ntfy.invalid/base/${TOPIC}/json?poll=1&id=${ID}`],
  ]) {
    const { result, requests, lines } = await withFetch(reply(`${JSON.stringify(STORED)}\n`), () => ntfyCheck({ ...cfg, ntfy_server: server }, ID));
    assert.equal(result, 0, server);
    assert.deepEqual(
      requests.map((request) => request.url),
      [expected],
      server,
    );
    assertNoSecret(lines.join('\n'), server);
  }
});

test('ntfy-check: an invalid ntfy_server gives no conclusion, makes no request and does not show the value', async () => {
  for (const server of ['https://[ntfy.invalid', `https://user:pw@[ntfy.invalid/${TOPIC}`, 'not an address']) {
    const { result, requests, lines } = await withFetch(reply(''), () => ntfyCheck({ ...cfg, ntfy_server: server }, ID));
    assert.equal(result, 2, server);
    assert.equal(requests.length, 0, server);
    assert.deepEqual(lines, [
      'Result: unknown. The check did not start: "ntfy_server" in config.json is not a valid address.',
      'No conclusion about the message is possible.',
    ]);
  }
});

test('ntfy-check: a server that ignores the id filter still gives the right message', async () => {
  const other = { ...STORED, id: 'zzz999zzz999', title: 'Other' };
  const body = [JSON.stringify(other), JSON.stringify({ ...STORED, event: 'keepalive', id: 'kkk111kkk111' }), JSON.stringify(STORED), ''].join('\n');
  const { result } = await withFetch(reply(body), () => checkNtfyMessage(cfg, ID));
  assert.equal(result.status, 'found');
  assert.equal(result.message.title, 'MINI');
});

test('ntfy-check: missing when ntfy answers HTTP 200 without the message, exit code 1', async () => {
  for (const body of ['', `${JSON.stringify({ ...STORED, id: 'zzz999zzz999' })}\n`]) {
    const { result, lines } = await withFetch(reply(body), () => ntfyCheck(cfg, ID));
    assert.equal(result, 1, JSON.stringify(body));
    assert.deepEqual(lines, [
      'Result: missing. ntfy does not have this message now. The cache keeps messages for 12 hours by default. A message that is older is gone.',
    ]);
  }
});

for (const [status, pattern] of [
  [401, /no permission/],
  [403, /no permission/],
  [429, /Too many requests/],
  [500, /did not finish: ntfy answered HTTP 500/],
  [404, /did not finish: ntfy answered HTTP 404/],
]) {
  test(`ntfy-check: HTTP ${status} gives no conclusion, exit code 2`, async () => {
    const { result, lines } = await withFetch(reply('error', status), () => ntfyCheck(cfg, ID));
    assert.equal(result, 2);
    assert.match(lines[0], /^Result: unknown\. /);
    assert.match(lines[0], pattern);
    assert.equal(lines.at(-1), 'No conclusion about the message is possible.');
  });
}

test('ntfy-check: a network error prints a fixed text and the error code, never the error text with the address', async () => {
  const withPassword = { ...cfg, ntfy_server: 'https://user:pw@ntfy.invalid' };
  const cases = [
    // fetch of Node: "fetch failed" with the system error as the cause.
    [(url) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${url}`), { code: 'ENOTFOUND' }) }), 'ENOTFOUND'],
    // fetch refuses an address with a user name and a password. The error text has the full URL.
    [(url) => new TypeError(`Request cannot be constructed from a URL that includes credentials: ${url}`), 'TypeError'],
    // A code that is not a plain name shows as "Error". Nothing of its text stays.
    [(url) => Object.assign(new Error(String(url)), { cause: { code: `E:BAD/user:pw@ntfy.invalid/${TOPIC}\n.` } }), 'Error'],
    [() => ({}), 'Error'],
  ];
  for (const [makeError, code] of cases) {
    const { result, requests, lines } = await withFetch(
      (url) => {
        throw makeError(url);
      },
      () => ntfyCheck(withPassword, ID),
    );
    assert.equal(result, 2, code);
    assert.deepEqual(requests.map((request) => request.url), [`https://user:pw@ntfy.invalid/${TOPIC}/json?poll=1&id=${ID}`]);
    assert.deepEqual(lines, [`Result: unknown. The check did not finish: no answer from ntfy (${code}).`, 'No conclusion about the message is possible.']);
    assertNoSecret(lines.join('\n'), code);
  }
});

test('ntfy-check: a timeout gives no conclusion and names the 15 seconds', async () => {
  const { result, lines } = await withFetch(
    () => {
      throw new DOMException(`The operation was aborted due to timeout: ${TOPIC}`, 'TimeoutError');
    },
    () => ntfyCheck(cfg, ID),
  );
  assert.equal(result, 2);
  assert.deepEqual(lines, ['Result: unknown. The check did not finish: no answer in 15 seconds.', 'No conclusion about the message is possible.']);
});

test('ntfy-check: an answer larger than 64 KB gives no conclusion, with one period at the end', async () => {
  // Many messages, about 70 KB: a server that ignores the id filter.
  const line = `${JSON.stringify(STORED)}\n`;
  const body = line.repeat(Math.ceil((70 * 1024) / line.length));
  assert.ok(body.length > 64 * 1024);
  const { result, lines } = await withFetch(reply(body), () => ntfyCheck(cfg, ID));
  assert.equal(result, 2);
  assert.deepEqual(lines, ['Result: unknown. The check did not finish: the answer of ntfy is larger than 64 KB.', 'No conclusion about the message is possible.']);
  assert.ok(!lines[0].includes('..'), 'no double period');
});

test('ntfy-check: an answer that is not one JSON object on each line gives no conclusion', async () => {
  for (const body of ['<html>login</html>', 'null\n', '[]\n', `${JSON.stringify([STORED])}\n`, `${JSON.stringify(STORED)}\nnull\n`, '42\n', '"text"\n']) {
    const { result } = await withFetch(reply(body), () => checkNtfyMessage(cfg, ID));
    assert.equal(result.status, 'unknown', JSON.stringify(body));
    assert.equal(result.detail, 'The check did not finish: the answer of ntfy is not one JSON object on each line.', JSON.stringify(body));
  }
});

test('ntfy-check: an invalid id gives no conclusion and makes no request', async () => {
  for (const id of [undefined, '', 'abc12', 'x'.repeat(65), 'abc/def123', 'abc123def456?since=all', '../abcdef', 'abc 123def', 'abcdéf123']) {
    const { result, requests, lines } = await withFetch(reply(JSON.stringify(STORED)), () => ntfyCheck(cfg, id));
    assert.equal(result, 2, String(id));
    assert.equal(requests.length, 0, String(id));
    assert.match(lines[0], /^Result: unknown\. The message id is not valid\./, String(id));
  }
});

test('ntfy-check: the command line refuses an invalid id or an invalid config.json with exit code 2, sends no request and shows no secret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mini-watch-test-'));
  try {
    const script = fileURLToPath(new URL('../mini_watch.mjs', import.meta.url));
    const config = (text) => writeFileSync(join(dir, 'config.json'), text, { mode: 0o600 });
    const run = (...args) => spawnSync(process.execPath, [script, 'ntfy-check', ...args], { env: { ...process.env, MINI_WATCH_DATA: dir }, encoding: 'utf8' });
    // A server address that cannot be reached: a request would fail, but the id check comes first.
    config(JSON.stringify({ ntfy_topic: TOPIC, ntfy_server: 'http://127.0.0.1:9' }));
    for (const args of [[], ['bad'], ['abc/def123']]) {
      const out = run(...args);
      assert.equal(out.status, 2, out.stdout + out.stderr);
      assert.match(out.stdout, /Result: unknown\. The message id is not valid\./);
      assertNoSecret(out.stdout + out.stderr, args.join(' '));
    }
    // Each config error comes before a request.
    for (const [text, pattern] of [
      [JSON.stringify({ ntfy_topic: 'short' }), /ntfy_topic/],
      [JSON.stringify({ ntfy_topic: TOPIC, ntfy_server: 'ftp://user:pw@ntfy.invalid' }), /"ntfy_server" must be an address like "https:\/\/ntfy\.sh"\. Now it is not valid\./],
      [JSON.stringify({ ntfy_topic: TOPIC, ntfy_server: `user:pw@ntfy.invalid/${TOPIC}` }), /"ntfy_server" must be an address/],
      [`{"ntfy_topic": ${TOPIC}, "ntfy_server": "https://user:pw@ntfy.invalid"}`, /config\.json is not valid JSON\. Check the quotes and the commas\./],
      [`{"ntfy_server": "https://user:pw@ntfy.invalid" "ntfy_topic": "${TOPIC}"}`, /config\.json is not valid JSON( \(line \d+ column \d+\))?\. Check/],
    ]) {
      config(text);
      const out = run(ID);
      assert.equal(out.status, 2, `a config error gives no conclusion: ${out.stderr}`);
      assert.match(out.stderr, pattern);
      assertNoSecret(out.stdout + out.stderr, text);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkConfig: an ntfy_server with a user name or a password is refused and not shown', () => {
  for (const server of ['https://user:pw@ntfy.invalid', 'https://user@ntfy.invalid', 'http://:pw@ntfy.invalid/base']) {
    assert.throws(() => checkConfig({ ...cfg, ntfy_server: server }), {
      message: '"ntfy_server" must not have a user name or a password. The program does not use them.',
    });
  }
  checkConfig({ ...cfg, ntfy_server: 'https://ntfy.invalid/base/' }); // a plain address still passes
});
