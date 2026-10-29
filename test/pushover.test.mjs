// Run with: npm test
// The notification service switch (notify_service) and Pushover. These tests replace fetch with a fake.
// They do not call Pushover, ntfy or BMW. The keys below are fake: they only have the form of Pushover keys.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_CONFIG, Fleet, Watcher, checkConfig, checkPushover, notify, ntfy, pushover, pushoverTitle, validatePushover } from '../mini_watch.mjs';

const TOKEN = 'faketoken0123456789ABCDEFGHIJK';
const USER = 'fakeuserkey0123456789abcdefghi';
const TOPIC = 'mini-0123456789abcdef01';
const REQUEST = '1a2b3c4d-1111-2222-3333-444455556666'; // the placeholder of AGENTS.md
const MESSAGES_URL = 'https://api.pushover.net/1/messages.json';
const VALIDATE_URL = 'https://api.pushover.net/1/users/validate.json';
const ACCEPTED = JSON.stringify({ status: 1, request: REQUEST });
const NTFY_ANSWER = JSON.stringify({ id: 'abc123def456', time: 1790000000, expires: 1790043200, event: 'message', topic: 'x' });

const ntfyCfg = { ...DEFAULT_CONFIG, ntfy_topic: TOPIC, ntfy_server: 'https://ntfy.invalid' };
const pushCfg = { ...ntfyCfg, notify_service: 'pushover', pushover_token: TOKEN, pushover_user: USER };

const script = fileURLToPath(new URL('../mini_watch.mjs', import.meta.url));
const replayTool = fileURLToPath(new URL('../tools/replay.mjs', import.meta.url));

// Replaces fetch and console.log for one call of fn. `answer` is a function (url, options) -> Response, or it throws.
// Returns the result, the requests (the body as text) and the log lines (without the time).
async function withFetch(answer, fn) {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const requests = [];
  const lines = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options, body: options.body === undefined ? undefined : String(options.body) });
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
const fields = (request) => [...new URLSearchParams(request.body)];
const form = (request) => Object.fromEntries(new URLSearchParams(request.body));

// The token, the user key and the address of Pushover never show in a log line, an error text or an output.
function assertNoSecret(text, what = '') {
  for (const [secret, name] of [
    [TOKEN, 'the token'],
    [USER, 'the user key'],
    ['api.pushover.net', 'the address'],
    ['/1/messages', 'the address'],
    ['/1/users', 'the address'],
  ]) {
    assert.ok(!String(text).includes(secret), `${what}: the text shows ${name}`);
  }
}

// ---- notify(): the switch ----

test('notify: the default service makes exactly the same request as ntfy(), with the same result and log', async () => {
  const cases = [
    ['MINI: a part is open', 'Front right window since 13:50', 'high', 'warning'],
    ['MINI', 'Everything is closed.', 'default', 'white_check_mark'],
    ['MINI locked', 'Everything is closed.', 'default', 'lock,car'],
    ['t', 'm', undefined, undefined], // the defaults of ntfy()
  ];
  for (const args of cases) {
    const direct = await withFetch(reply(NTFY_ANSWER), () => ntfy(ntfyCfg, ...args));
    const switched = await withFetch(reply(NTFY_ANSWER), () => notify(ntfyCfg, ...args));
    const withoutKey = { ...ntfyCfg };
    delete withoutKey.notify_service;
    const noSetting = await withFetch(reply(NTFY_ANSWER), () => notify(withoutKey, ...args));
    for (const run of [switched, noSetting]) {
      assert.equal(run.result, direct.result);
      assert.deepEqual(run.lines, direct.lines);
      assert.equal(run.requests.length, 1);
      const [a, b] = [run.requests[0], direct.requests[0]];
      assert.equal(a.url, b.url);
      assert.equal(a.options.method, b.options.method);
      assert.deepEqual(a.options.headers, b.options.headers);
      assert.equal(a.body, b.body);
      assert.deepEqual(Object.keys(a.options).sort(), Object.keys(b.options).sort());
      assert.ok(a.options.signal instanceof AbortSignal);
    }
  }
});

test('notify: the default request is the ntfy request of today (address, headers, body)', async () => {
  const { result, requests } = await withFetch(reply(NTFY_ANSWER), () => notify(ntfyCfg, 'MINI', 'Everything is closed.', 'default', 'lock'));
  assert.equal(result, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://ntfy.invalid');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(requests[0].options.headers, { 'Content-Type': 'application/json' });
  assert.equal(requests[0].body, JSON.stringify({ topic: TOPIC, title: 'MINI', message: 'Everything is closed.', priority: 3, tags: ['lock'] }));
});

test('notify: the default service without a topic prints the text and sends nothing, as before', async () => {
  const { result, requests, lines } = await withFetch(reply(NTFY_ANSWER), () => notify({ ...ntfyCfg, ntfy_topic: '' }, 't', 'm'));
  assert.equal(result, true);
  assert.equal(requests.length, 0);
  assert.deepEqual(lines, ['[ntfy off] t: m']);
});

test('notify: "pushover" calls only Pushover, never ntfy', async () => {
  const { result, requests } = await withFetch(reply(ACCEPTED), () => notify(pushCfg, 'MINI', 'Everything is closed.', 'default', 'closed'));
  assert.equal(result, true);
  assert.deepEqual(
    requests.map((request) => request.url),
    [MESSAGES_URL],
  );
});

// ---- pushover() ----

test('pushover: an accepted message returns true, the log has the title, the text, the request id and the status', async () => {
  const { result, requests, lines } = await withFetch(reply(ACCEPTED), () => pushover(pushCfg, 'MINI locked', 'Everything is closed.', 'default', 'lock'));
  assert.equal(result, true);
  assert.deepEqual(lines, [`Notification accepted by Pushover: MINI locked: Everything is closed. (request ${REQUEST}, HTTP 200)`]);
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.url, MESSAGES_URL);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.redirect, 'manual', 'the token must not follow a redirect');
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.ok(request.options.body instanceof URLSearchParams);
  assert.deepEqual(request.options.headers, { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' });
  assert.deepEqual(fields(request), [
    ['token', TOKEN],
    ['user', USER],
    ['title', '🔒 MINI locked'],
    ['message', 'Everything is closed.'],
    ['priority', '0'],
  ]);
  assertNoSecret(lines.join('\n'));
});

test('pushover: another 2xx status with a valid answer is accepted too', async () => {
  const { result, lines } = await withFetch(reply(JSON.stringify({ status: 1, request: 'abc', extra: [1] }), 202), () => pushover(pushCfg, 't', 'm'));
  assert.equal(result, true);
  assert.deepEqual(lines, ['Notification accepted by Pushover: t: m (request abc, HTTP 202)']);
});

test('pushover: priority "high" is 1, every other priority is 0, the default is "high" as in ntfy()', async () => {
  for (const [priority, expected] of [
    ['high', '1'],
    ['default', '0'],
    ['low', '0'],
    ['constructor', '0'],
    [undefined, '1'],
  ]) {
    const { requests } = await withFetch(reply(ACCEPTED), () => pushover(pushCfg, 't', 'm', priority, 'warning'));
    assert.equal(form(requests[0]).priority, expected, String(priority));
  }
});

test('pushover: the title starts with the emoji of each known tag, an unknown tag gives no emoji', async () => {
  for (const [tags, title] of [
    ['warning', '⚠️ MINI'],
    ['rotating_light', '🚨 MINI'],
    ['white_check_mark', '✅ MINI'],
    ['lock', '🔒 MINI'],
    ['grey_question', '❔ MINI'],
    ['blue_car', '🚙 MINI'],
    ['car', '🚗 MINI'],
    ['rotating_light,car', '🚨🚗 MINI'],
    ['tada,lock', '🔒 MINI'],
    ['tada', 'MINI'],
    ['WARNING', 'MINI'],
    ['constructor', 'MINI'],
    ['__proto__,toString', 'MINI'],
    ['', 'MINI'],
    [undefined, '⚠️ MINI'], // the default tag of ntfy()
  ]) {
    const { requests } = await withFetch(reply(ACCEPTED), () => pushover(pushCfg, 'MINI', 'm', 'default', tags));
    assert.equal(form(requests[0]).title, title, String(tags));
  }
  assert.equal(pushoverTitle('MINI', 'warning'), '⚠️ MINI');
});

test('pushover: the title has at most 250 and the text at most 1024 characters, a longer one ends with "…"', async () => {
  const send = async (title, text, tags = 'tada') => form((await withFetch(reply(ACCEPTED), () => pushover(pushCfg, title, text, 'default', tags))).requests[0]);
  let sent = await send('a'.repeat(250), 'b'.repeat(1024));
  assert.equal(sent.title, 'a'.repeat(250));
  assert.equal(sent.message, 'b'.repeat(1024));
  sent = await send('a'.repeat(251), 'b'.repeat(1025));
  assert.equal(sent.title, `${'a'.repeat(249)}…`);
  assert.equal(sent.message, `${'b'.repeat(1023)}…`);
  // The emoji counts too: "⚠️" is two characters, then a space.
  sent = await send('a'.repeat(247), 'm', 'warning');
  assert.equal(sent.title, `⚠️ ${'a'.repeat(247)}`);
  assert.equal(Array.from(sent.title).length, 250);
  sent = await send('a'.repeat(248), 'm', 'warning');
  assert.equal(sent.title, `⚠️ ${'a'.repeat(246)}…`);
  // A cut never splits a character outside the BMP.
  sent = await send('🚗'.repeat(300), '🚗'.repeat(2000));
  assert.equal(Array.from(sent.title).length, 250);
  assert.equal(Array.from(sent.message).length, 1024);
  assert.equal(sent.message, `${'🚗'.repeat(1023)}…`);
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.ok(!loneSurrogate.test(sent.title) && !loneSurrogate.test(sent.message));
});

for (const [name, body, status] of [
  ['a body that is not JSON', 'not-json', 200],
  ['an empty object', '{}', 200],
  ['an empty body', '', 200],
  ['JSON null', 'null', 200],
  ['a JSON array', JSON.stringify([{ status: 1, request: REQUEST }]), 200],
  ['status 0', JSON.stringify({ status: 0, request: REQUEST }), 200],
  ['status "1" as text', JSON.stringify({ status: '1', request: REQUEST }), 200],
  ['status true', JSON.stringify({ status: true, request: REQUEST }), 200],
  ['no request id', JSON.stringify({ status: 1 }), 200],
  ['an empty request id', JSON.stringify({ status: 1, request: '' }), 200],
  ['a request id that is not a string', JSON.stringify({ status: 1, request: 123 }), 200],
  ['a body larger than the limit', JSON.stringify({ status: 1, request: REQUEST, pad: 'x'.repeat(70 * 1024) }), 200],
  ['HTTP 204 without a body', null, 204],
]) {
  test(`pushover: HTTP ${status} with ${name} is not confirmed and returns false`, async () => {
    const { result, lines } = await withFetch(reply(body, status), () => pushover(pushCfg, 't', 'm'));
    assert.equal(result, false);
    assert.deepEqual(lines, [`Notification not confirmed by Pushover: HTTP ${status}, the answer has no request id`]);
  });
}

for (const status of [400, 401, 403, 429, 500, 503]) {
  test(`pushover: HTTP ${status} fails, returns false and does not print the answer`, async () => {
    // A server that sends the token back: the log must not show it.
    const body = JSON.stringify({ status: 0, errors: [`token ${TOKEN} user ${USER} is invalid`], request: REQUEST });
    const { result, lines } = await withFetch(reply(body, status), () => pushover(pushCfg, 't', 'm'));
    assert.equal(result, false);
    assert.deepEqual(lines, [`Notification failed: HTTP ${status}`]);
  });
}

test('pushover: a network error or a timeout fails with a fixed text and the error code, never the error text', async () => {
  const fetchFailed = (code) =>
    Object.assign(new TypeError(`fetch failed ${MESSAGES_URL}?token=${TOKEN}&user=${USER}`), {
      cause: Object.assign(new Error(`getaddrinfo ${code} api.pushover.net ${TOKEN}`), { code }),
    });
  for (const [makeError, shown] of [
    [() => fetchFailed('ENOTFOUND'), '(ENOTFOUND)'],
    [() => fetchFailed('ECONNREFUSED'), '(ECONNREFUSED)'],
    [() => new TypeError(`fetch failed ${MESSAGES_URL} ${TOKEN}`), '(TypeError)'],
    [() => new DOMException(`The operation was aborted due to timeout ${TOKEN}`, 'TimeoutError'), 'in 15 seconds'],
    [() => Object.assign(new Error(TOKEN), { cause: { code: TOKEN } }), '(Error)'],
    [() => Object.assign(new Error(USER), { cause: { code: USER } }), '(Error)'],
    [() => Object.assign(new Error('x'), { cause: { code: `E:${MESSAGES_URL}\n${TOKEN}` } }), '(Error)'],
    [() => Object.assign(new Error('x'), { name: TOKEN }), '(Error)'],
    [() => null, '(Error)'],
    [() => ({}), '(Error)'],
  ]) {
    const { result, lines } = await withFetch(
      () => {
        throw makeError();
      },
      () => pushover(pushCfg, 't', 'm'),
    );
    assert.equal(result, false, shown);
    assert.deepEqual(lines, [`Notification failed: no answer from Pushover ${shown}`]);
    assertNoSecret(lines.join('\n'), shown);
  }
});

test('pushover: the log shows a request id only when it has the form of an id and has no key', async () => {
  for (const [request, shown] of [
    [REQUEST, REQUEST],
    ['abc', 'abc'],
    ['a'.repeat(64), 'a'.repeat(64)],
    ['a'.repeat(65), '(not printable)'],
    ['abc\ndef\r\u2028x\u0007', '(not printable)'],
    [' \n ', '(not printable)'],
    ['abc def', '(not printable)'],
    ['abc_def', '(not printable)'],
    ['https://evil.invalid/x', '(not printable)'],
    ['evil.invalid', '(not printable)'],
    ['%2F%2Fevil', '(not printable)'],
    ['abcdé', '(not printable)'],
    [TOKEN, '(not printable)'],
    [USER, '(not printable)'],
    [`${USER}-x`, '(not printable)'],
    [`x-${TOKEN}`, '(not printable)'],
  ]) {
    const { result, lines } = await withFetch(reply(JSON.stringify({ status: 1, request })), () => pushover(pushCfg, 't', 'm'));
    assert.equal(result, true, 'any non-empty request id counts as accepted');
    assert.deepEqual(lines, [`Notification accepted by Pushover: t: m (request ${shown}, HTTP 200)`]);
    assertNoSecret(lines.join('\n'), JSON.stringify(request));
    assert.ok(!lines.join('\n').includes('evil'), 'no address from the answer');
    assert.ok(!/[\n\r\u2028\u2029]/.test(lines[0]), 'one log line');
  }
});

test('pushover: a redirect is not followed, it fails with a fixed text and a retry', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const { result, requests, lines } = await withFetch(
      () => new Response(`moved to https://evil.invalid/?token=${TOKEN}`, { status, headers: { Location: `https://evil.invalid/${TOKEN}` } }),
      () => pushover(pushCfg, 't', 'm'),
    );
    assert.equal(result, false, String(status));
    assert.equal(requests.length, 1, 'one request only');
    assert.equal(requests[0].options.redirect, 'manual', 'fetch must not follow the redirect');
    assert.deepEqual(lines, [`Notification failed: HTTP ${status}, a redirect. The program does not follow it.`]);
    assertNoSecret(lines.join('\n'), String(status));
    assert.ok(!lines.join('\n').includes('evil'));
  }
});

test('pushoverTitle: no space at the start or at the end, also with an empty title', () => {
  assert.equal(pushoverTitle('', 'warning'), '⚠️');
  assert.equal(pushoverTitle('', 'rotating_light,car'), '🚨🚗');
  assert.equal(pushoverTitle('', 'tada'), '');
  assert.equal(pushoverTitle(undefined, 'lock'), '🔒');
  assert.equal(pushoverTitle(' MINI ', 'lock'), '🔒 MINI');
  assert.equal(pushoverTitle('MINI', ''), 'MINI');
});

test('pushover: without a token or a user key the text goes to the log and nothing is sent', async () => {
  for (const cfg of [
    { ...pushCfg, pushover_token: '' },
    { ...pushCfg, pushover_user: '' },
    { ...pushCfg, pushover_token: '', pushover_user: '' },
    { ...DEFAULT_CONFIG, notify_service: 'pushover' },
  ]) {
    const { result, requests, lines } = await withFetch(reply(ACCEPTED), () => pushover(cfg, 't', 'm'));
    assert.equal(result, true);
    assert.equal(requests.length, 0);
    assert.deepEqual(lines, ['[ntfy off] t: m']);
  }
});

test('pushover: the fake keys have the form of Pushover keys', () => {
  for (const key of [TOKEN, USER]) assert.match(key, /^[A-Za-z0-9]{30}$/);
});

// ---- checkConfig() and checkPushover() ----

const SERVICE_ERROR = '"notify_service" must be "ntfy" or "pushover". Now it is not valid.';

test('checkConfig: notify_service is "ntfy" or "pushover", another value is refused and not shown', () => {
  checkConfig({ ...DEFAULT_CONFIG });
  checkConfig({ ...DEFAULT_CONFIG, notify_service: 'ntfy' });
  checkConfig({ ...pushCfg });
  for (const value of ['Pushover', 'NTFY', 'pushover ', '', null, undefined, 1, true, ['ntfy'], { pushover: 1 }, TOKEN, 'email']) {
    assert.throws(
      () => checkConfig({ ...pushCfg, notify_service: value }),
      (err) => {
        assert.equal(err.message, SERVICE_ERROR, JSON.stringify(value));
        return true;
      },
    );
  }
});

test('checkConfig: with "ntfy" the Pushover settings are not checked and give no warning', async () => {
  const { lines } = await withFetch(reply(''), async () => {
    for (const [token, user] of [
      ['', ''],
      ['short', 'x'],
      [123, null],
      [{ a: 1 }, [USER]],
      [`${TOKEN} `, `${USER}!`],
    ]) {
      checkConfig({ ...DEFAULT_CONFIG, pushover_token: token, pushover_user: user });
    }
  });
  assert.deepEqual(lines, [], 'no warning about unknown settings');
});

test('checkConfig: with "pushover" a missing token or user key is refused, the token first', () => {
  for (const [patch, key] of [
    [{ pushover_token: '' }, 'pushover_token'],
    [{ pushover_token: undefined }, 'pushover_token'],
    [{ pushover_token: null }, 'pushover_token'],
    [{ pushover_token: '', pushover_user: '' }, 'pushover_token'],
    [{ pushover_user: '' }, 'pushover_user'],
    [{ pushover_user: undefined }, 'pushover_user'],
  ]) {
    assert.throws(() => checkConfig({ ...pushCfg, ...patch }), {
      message: `Set "${key}" in config.json to ${key === 'pushover_token' ? 'the API token of your application' : 'your user key or a delivery group key'} from pushover.net. See docs/en/06-pushover.md.`,
    });
  }
});

test('checkConfig: with "pushover" a key with the wrong form is refused, the text does not show the value', () => {
  const wrongValues = (key) => {
    const good = key === 'pushover_token' ? TOKEN : USER;
    return [
      good.slice(0, 29),
      `${good}a`,
      `${good.slice(0, 29)}-`,
      `${good.slice(0, 29)}_`,
      `${good.slice(0, 29)} `,
      ` ${good.slice(0, 29)}`,
      `${good.slice(0, 29)}é`,
      `${good}\n`,
      'YOUR-PUSHOVER-API-TOKEN',
      123456789012345678901234567890,
      [good],
      { value: good },
      true,
    ];
  };
  for (const key of ['pushover_token', 'pushover_user']) {
    for (const value of wrongValues(key)) {
      assert.throws(
        () => checkConfig({ ...pushCfg, [key]: value }),
        (err) => {
          assert.equal(err.message, `"${key}" must have 30 letters and digits (A-Z, a-z, 0-9), with no space. Now it is not valid. See docs/en/06-pushover.md.`);
          assertNoSecret(err.message, `${key}=${JSON.stringify(value)}`);
          if (typeof value === 'string') assert.ok(!err.message.includes(value.trim()), 'the value is not shown');
          return true;
        },
      );
    }
  }
});

test('checkConfig: with "pushover" an empty ntfy topic is allowed, ntfy_server is still checked', () => {
  checkConfig({ ...pushCfg, ntfy_topic: '' });
  checkConfig({ ...DEFAULT_CONFIG, notify_service: 'pushover', pushover_token: TOKEN, pushover_user: USER });
  assert.throws(() => checkConfig({ ...pushCfg, ntfy_server: 'ntfy.sh' }), /"ntfy_server" must be an address/);
});

test('checkPushover: the same checks for the command pushover-test, whatever notify_service is', () => {
  checkPushover({ ...ntfyCfg, pushover_token: TOKEN, pushover_user: USER });
  assert.throws(() => checkPushover({ ...ntfyCfg }), /^Error: Set "pushover_token" in config\.json/);
  assert.throws(() => checkPushover({ ...ntfyCfg, pushover_token: TOKEN }), /^Error: Set "pushover_user" in config\.json/);
  assert.throws(() => checkPushover({ ...ntfyCfg, pushover_token: TOKEN, pushover_user: 'x' }), /^Error: "pushover_user" must have 30 letters/);
});

// ---- validatePushover() (doctor) ----

test('validatePushover: status 1 is OK, the request has only the token and the user key, it sends no message', async () => {
  const { result, requests } = await withFetch(reply(JSON.stringify({ status: 1, group: 0, devices: ['phone'], request: REQUEST })), () => validatePushover(pushCfg));
  assert.deepEqual(result, { ok: true, text: 'Pushover accepted the token and the user key: HTTP 200. The check sent no notification.' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, VALIDATE_URL);
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.redirect, 'manual');
  assert.deepEqual(fields(requests[0]), [
    ['token', TOKEN],
    ['user', USER],
  ]);
  assert.ok(!result.text.includes('phone'), 'the device names are not shown');
});

test('validatePushover: each failure gives a fixed text without the keys', async () => {
  const cases = [
    [reply(JSON.stringify({ user: 'invalid', errors: [`user ${USER} is invalid`], status: 0, request: REQUEST }), 400), 'Pushover refused the check: HTTP 400, the user key is not valid.'],
    [reply(JSON.stringify({ token: 'invalid', errors: [`token ${TOKEN} is invalid`], status: 0, request: REQUEST }), 400), 'Pushover refused the check: HTTP 400, the token is not valid.'],
    [reply(JSON.stringify({ token: 'invalid', user: 'invalid', status: 0 }), 400), 'Pushover refused the check: HTTP 400, the token is not valid and the user key is not valid.'],
    [reply(`<html>${TOKEN}</html>`, 401), 'Pushover refused the check: HTTP 401.'],
    [reply('{}', 500), 'The Pushover check failed: HTTP 500. Try again later.'],
    [reply(`${TOKEN}`, 503), 'The Pushover check failed: HTTP 503. Try again later.'],
    [reply('{}', 404), 'Pushover refused the check: HTTP 404.'],
    [() => new Response(`moved ${TOKEN}`, { status: 307, headers: { Location: `https://evil.invalid/${TOKEN}` } }), 'The Pushover check failed: HTTP 307, a redirect. The program does not follow it.'],
    [reply(JSON.stringify({ status: 1 }), 302), 'The Pushover check failed: HTTP 302, a redirect. The program does not follow it.'],
    [reply('{}', 429), 'Pushover refused the check: HTTP 429. Too many requests. Try again later.'],
    [reply(JSON.stringify({ status: 0, request: REQUEST }), 200), 'The Pushover check is not confirmed: HTTP 200, the answer has no status 1.'],
    [reply('not-json', 200), 'The Pushover check is not confirmed: HTTP 200, the answer has no status 1.'],
    [reply(JSON.stringify({ status: 1, pad: 'x'.repeat(70 * 1024) }), 200), 'The Pushover check is not confirmed: HTTP 200, the answer has no status 1.'],
    [
      () => {
        throw Object.assign(new TypeError(`fetch failed ${VALIDATE_URL} ${TOKEN}`), { cause: { code: 'ENOTFOUND' } });
      },
      'Pushover cannot be reached: no answer (ENOTFOUND).',
    ],
    [
      () => {
        throw new DOMException(`aborted ${TOKEN}`, 'TimeoutError');
      },
      'Pushover cannot be reached: no answer in 15 seconds.',
    ],
    [
      () => {
        throw Object.assign(new Error(USER), { cause: { code: USER } });
      },
      'Pushover cannot be reached: no answer (Error).',
    ],
  ];
  for (const [answer, text] of cases) {
    const { result, lines } = await withFetch(answer, () => validatePushover(pushCfg));
    assert.deepEqual(result, { ok: false, text });
    assert.deepEqual(lines, []);
    assertNoSecret(result.text, text);
  }
});

// ---- The Watcher and the Fleet with Pushover ----

// A fake server for both services. `answers` is a list of HTTP status codes, 'throw', or { status, body }.
// A 2xx code gives a valid answer of the service. The last answer repeats. Returns each call with the
// virtual time, the service, the title, the text and the priority.
async function withFakeServices(answers, clock, fn) {
  const calls = [];
  const { lines } = await withFetch(
    (url, options) => {
      const answer = answers[Math.min(calls.length, answers.length - 1)];
      const isPushover = String(url) === MESSAGES_URL;
      if (isPushover) {
        const sent = Object.fromEntries(new URLSearchParams(String(options.body)));
        calls.push({ at: clock(), service: 'pushover', title: sent.title, message: sent.message, priority: sent.priority, keys: Object.keys(sent) });
      } else {
        const sent = JSON.parse(options.body);
        calls.push({ at: clock(), service: 'ntfy', url: String(url), title: sent.title, message: sent.message, priority: sent.priority, tags: sent.tags });
      }
      if (answer === 'throw') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      if (typeof answer === 'object') return new Response(answer.body, { status: answer.status });
      return new Response(answer >= 200 && answer < 300 ? (isPushover ? ACCEPTED : NTFY_ANSWER) : 'error', { status: answer });
    },
    fn,
  );
  return { calls, lines };
}

const KM = 'vehicle.vehicle.travelledDistance';
const WIN = 'vehicle.cabin.window.row1.passenger.status';
const DRIVER_DOOR = 'vehicle.cabin.door.row1.driver.isOpen';
const LOCK = 'vehicle.cabin.door.status';
const msg = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }]));

// A day: the first alert fails (HTTP 500), then a 2xx answer without an id, the retries send it. A reminder,
// "everything is closed", then a lock with every part closed (lock confirmation). Returns the calls and the watcher.
async function aDay(cfg) {
  let clock = 1000;
  const watcher = new Watcher({ ...cfg, timezone: 'UTC', alert_after_min: 0, lock_confirm: true }, { clock: () => clock, random: () => 0.5 });
  const { calls, lines } = await withFakeServices([500, { status: 200, body: '{}' }, 200], () => clock, async () => {
    watcher.onData(msg({ [KM]: 100, [WIN]: 'OPEN' }), clock - 5000);
    await watcher.check(); // HTTP 500: retry after 30 seconds
    assert.equal(watcher.alerted, false);
    assert.equal(watcher.retryAt, 1030);
    clock += 29;
    await watcher.check(); // still in the wait
    clock += 1;
    await watcher.check(); // 2xx without an id: retry after 60 seconds
    assert.equal(watcher.alerted, false);
    assert.equal(watcher.retryAt, 1090);
    clock += 60;
    await watcher.check(); // accepted
    assert.equal(watcher.alerted, true);
    assert.equal(watcher.notifyFailures, 0);
    clock += 1800;
    await watcher.check(); // reminder
    watcher.onData(msg({ [WIN]: 'CLOSED' }), clock);
    clock += 15;
    await watcher.check(); // everything is closed
    clock += 600;
    watcher.onData(msg({ [DRIVER_DOOR]: true }), clock);
    watcher.onData(msg({ [DRIVER_DOOR]: false }), clock + 5);
    clock += 200;
    watcher.onData(msg({ [LOCK]: 'SECURED' }), clock);
    await watcher.check(); // lock confirmation
    clock += 3600;
    await watcher.check(); // nothing more
  });
  return { calls, lines, watcher };
}

test('watcher: with "pushover" a full day goes through Pushover only and retries like ntfy', async () => {
  const { calls, lines, watcher } = await aDay(pushCfg);
  assert.ok(
    calls.every((call) => call.service === 'pushover'),
    'never ntfy',
  );
  assert.deepEqual(
    calls.map(({ at, title, priority }) => [at, title, priority]),
    [
      [1000, '⚠️ MINI: a part is open', '1'],
      [1030, '⚠️ MINI: a part is open', '1'],
      [1090, '⚠️ MINI: a part is open', '1'],
      [2890, '⚠️ MINI: a part is still open', '1'],
      [2905, '✅ MINI', '0'],
      [3705, '🔒 MINI locked', '0'],
    ],
  );
  for (const call of calls) assert.deepEqual(call.keys, ['token', 'user', 'title', 'message', 'priority']);
  assert.equal(watcher.alerted, false);
  assert.equal(watcher.notifyFailures, 0);
  assert.ok(lines.includes('Notification failed: HTTP 500'));
  assert.ok(lines.includes('Notification not confirmed by Pushover: HTTP 200, the answer has no request id'));
  assert.equal(lines.filter((text) => text.startsWith('Notification accepted by Pushover: ')).length, 4);
  assertNoSecret(lines.join('\n'));
});

test('watcher: Pushover and ntfy send the same texts at the same times', async () => {
  const viaPushover = await aDay(pushCfg);
  const viaNtfy = await aDay(ntfyCfg);
  assert.ok(viaNtfy.calls.every((call) => call.service === 'ntfy' && call.url === 'https://ntfy.invalid'));
  const ntfyPriority = { 4: '1', 3: '0' };
  assert.deepEqual(
    viaPushover.calls.map(({ at, title, message, priority }) => [at, title, message, priority]),
    viaNtfy.calls.map(({ at, title, message, priority, tags }) => [at, pushoverTitle(title, tags.join(',')), message, ntfyPriority[priority]]),
  );
  assert.deepEqual(viaPushover.watcher.snapshot(), viaNtfy.watcher.snapshot());
  // The log lines that do not name the service are the same.
  const neutral = (lines) => lines.filter((text) => !/^Notification (accepted|not confirmed)/.test(text));
  assert.deepEqual(neutral(viaPushover.lines), neutral(viaNtfy.lines));
});

test('fleet: with "pushover" the silence alert waits a fixed 600 seconds after a failure, as with ntfy', async () => {
  let clock = 0;
  const fleet = new Fleet({ ...pushCfg, timezone: 'UTC', silence_alert_hours: 48 }, { clock: () => clock, random: () => 0.5 });
  fleet.onMessage('TESTVIN0000000001', msg({ [WIN]: 'CLOSED' }), 0);
  const start = 49 * 3600;
  const { calls } = await withFakeServices(['throw', 200], () => clock, async () => {
    clock = start;
    await fleet.check(); // fetch throws
    assert.equal(fleet.silenceRetryAt, start + 600);
    clock = start + 599;
    await fleet.check(); // still in the wait
    clock = start + 600;
    await fleet.check(); // accepted
    clock = start + 3 * 3600;
    await fleet.check(); // sent once
  });
  assert.deepEqual(
    calls.map(({ at, service, title, priority }) => [at, service, title, priority]),
    [
      [start, 'pushover', '❔ MINI no data', '0'],
      [start + 600, 'pushover', '❔ MINI no data', '0'],
    ],
  );
  assert.equal(fleet.silenceAlerted, true);
});

// ---- The command line (pushover-test, doctor, run) and tools/replay.mjs ----

// A module that the child process loads first. It replaces fetch with a fake and blocks TLS connections.
// Each request goes to the file FAKE_NET_LOG. FAKE_NET_PLAN gives the answers for each host:
// {"host": [{"status": 200, "body": ...}, "throw", "throw-with-period", ...]}. The last answer repeats. No plan: the request throws.
const PRELOAD = `
import { appendFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import tls from 'node:tls';
const record = (entry) => appendFileSync(process.env.FAKE_NET_LOG, JSON.stringify(entry) + '\\n');
const plan = JSON.parse(process.env.FAKE_NET_PLAN || '{}');
const used = {};
globalThis.fetch = async (url, options = {}) => {
  const host = new URL(String(url)).host;
  record({ url: String(url), method: options.method ?? 'GET', body: options.body === undefined ? null : String(options.body) });
  used[host] = (used[host] ?? -1) + 1;
  const answers = plan[host] ?? [];
  const answer = answers[Math.min(used[host], answers.length - 1)];
  if (answer === 'throw-with-period') throw new Error('connection refused.');
  if (!answer || answer === 'throw') {
    throw Object.assign(new TypeError('fetch failed ' + url), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND ' + url), { code: 'ENOTFOUND' }) });
  }
  return new Response(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body), { status: answer.status });
};
tls.connect = () => {
  record({ tls: true });
  const socket = new EventEmitter();
  socket.end = () => {};
  socket.destroy = () => {};
  process.nextTick(() => socket.emit('error', Object.assign(new Error('blocked by the test'), { code: 'ENETUNREACH' })));
  return socket;
};
`;

// Runs fn with a new data folder and deletes it at the end. `run(args, { plan, config })` starts the program
// (or another script) with the fake network and returns { status, out, requests }.
async function withProgram(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mini-watch-test-'));
  try {
    const preload = join(dir, 'fake-net.mjs');
    writeFileSync(preload, PRELOAD);
    const netLog = join(dir, 'net.jsonl');
    const writeConfig = (config) => writeFileSync(join(dir, 'config.json'), JSON.stringify(config), { mode: 0o600 });
    const run = (args, { plan = {}, file = script } = {}) => {
      rmSync(netLog, { force: true });
      const out = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, file, ...args], {
        env: { ...process.env, MINI_WATCH_DATA: dir, FAKE_NET_LOG: netLog, FAKE_NET_PLAN: JSON.stringify(plan) },
        encoding: 'utf8',
      });
      const requests = existsSync(netLog)
        ? readFileSync(netLog, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((text) => JSON.parse(text))
        : [];
      return { status: out.status, out: out.stdout + out.stderr, stdout: out.stdout, stderr: out.stderr, requests };
    };
    await fn({ dir, run, writeConfig });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CLIENT_ID = '1a2b3c4d-1111-2222-3333-444455556666';
const PUSHOVER_OK = { 'api.pushover.net': [{ status: 200, body: { status: 1, request: REQUEST } }] };

test('pushover-test: sends the test texts through Pushover also when notify_service is "ntfy", exit code 0', async () => {
  await withProgram(({ run, writeConfig }) => {
    writeConfig({ client_id: CLIENT_ID, ntfy_topic: TOPIC, pushover_token: TOKEN, pushover_user: USER });
    const result = run(['pushover-test'], { plan: PUSHOVER_OK });
    assert.equal(result.status, 0, result.out);
    assert.match(result.stdout, new RegExp(`Notification accepted by Pushover: MINI test: Notifications work\\. \\(request ${REQUEST}, HTTP 200\\)`));
    assert.match(result.stdout, /Result: Pushover accepted the test notification\. Check the phone\./);
    assert.equal(result.requests.length, 1, 'one request, never ntfy');
    assert.equal(result.requests[0].url, MESSAGES_URL);
    assert.deepEqual([...new URLSearchParams(result.requests[0].body)], [
      ['token', TOKEN],
      ['user', USER],
      ['title', '🚗 MINI test'],
      ['message', 'Notifications work.'],
      ['priority', '0'],
    ]);
    assertNoSecret(result.out);
  });
});

test('pushover-test: works without an ntfy topic, Turkish text with language "tr"', async () => {
  await withProgram(({ run, writeConfig }) => {
    writeConfig({ language: 'tr', notify_service: 'pushover', pushover_token: TOKEN, pushover_user: USER });
    const result = run(['pushover-test'], { plan: PUSHOVER_OK });
    assert.equal(result.status, 0, result.out);
    assert.equal(new URLSearchParams(result.requests[0].body).get('title'), '🚗 MINI deneme bildirimi');
    assertNoSecret(result.out);
  });
});

test('pushover-test: a refused or failed message gives exit code 1 and a clear result', async () => {
  await withProgram(({ run, writeConfig }) => {
    writeConfig({ ntfy_topic: TOPIC, pushover_token: TOKEN, pushover_user: USER });
    for (const [plan, line] of [
      [{ 'api.pushover.net': [{ status: 400, body: { user: 'invalid', status: 0, errors: [`user ${USER} is invalid`] } }] }, 'Notification failed: HTTP 400'],
      [{ 'api.pushover.net': [{ status: 200, body: {} }] }, 'Notification not confirmed by Pushover: HTTP 200, the answer has no request id'],
      [{}, 'Notification failed: no answer from Pushover (ENOTFOUND)'],
    ]) {
      const result = run(['pushover-test'], { plan });
      assert.equal(result.status, 1, result.out);
      assert.ok(result.stdout.includes(line), result.out);
      assert.match(result.stdout, /Result: Pushover did not accept the test notification\. See the line above\./);
      assert.equal(result.requests.length, 1);
      assertNoSecret(result.out, line);
    }
  });
});

test('pushover-test: missing or wrong settings give exit code 1, a clear error without the values and no request', async () => {
  await withProgram(({ run, writeConfig }) => {
    for (const [config, pattern] of [
      [{ ntfy_topic: TOPIC }, /^Set "pushover_token" in config\.json/m],
      [{ ntfy_topic: TOPIC, pushover_token: TOKEN }, /^Set "pushover_user" in config\.json/m],
      [{ ntfy_topic: TOPIC, pushover_token: `${TOKEN.slice(0, 29)}-`, pushover_user: USER }, /^"pushover_token" must have 30 letters and digits/m],
      [{ ntfy_topic: TOPIC, pushover_token: TOKEN, pushover_user: `${USER} ` }, /^"pushover_user" must have 30 letters and digits/m],
      [{ notify_service: 'pushover', pushover_token: TOKEN, pushover_user: USER.slice(0, 20) }, /^"pushover_user" must have 30 letters and digits/m],
      [{ notify_service: 'Pushover', pushover_token: TOKEN, pushover_user: USER }, /^"notify_service" must be "ntfy" or "pushover"\. Now it is not valid\./m],
    ]) {
      writeConfig(config);
      const result = run(['pushover-test'], { plan: PUSHOVER_OK });
      assert.equal(result.status, 1, result.out);
      assert.match(result.stderr, pattern);
      assert.deepEqual(result.requests, []);
      assertNoSecret(result.out, JSON.stringify(Object.keys(config)));
      assert.ok(!result.out.includes(TOKEN.slice(0, 20)) && !result.out.includes(USER.slice(0, 20)), 'no part of a key');
    }
  });
});

test('run: with "pushover" the ntfy topic is not needed, with "ntfy" it still is', async () => {
  await withProgram(({ run, writeConfig }) => {
    // Without tokens.json the command stops before any connection.
    writeConfig({ client_id: CLIENT_ID, notify_service: 'pushover', pushover_token: TOKEN, pushover_user: USER });
    let result = run(['run']);
    assert.equal(result.status, 1, result.out);
    assert.match(result.stderr, /tokens\.json not found/);
    assert.deepEqual(result.requests, []);
    writeConfig({ client_id: CLIENT_ID, pushover_token: TOKEN, pushover_user: USER });
    result = run(['run']);
    assert.equal(result.status, 1, result.out);
    assert.match(result.stderr, /^Set "ntfy_topic" in config\.json/m);
    assertNoSecret(result.out);
  });
});

test('ntfy-test: with "pushover" it still needs the topic and still uses ntfy', async () => {
  await withProgram(({ run, writeConfig }) => {
    writeConfig({ notify_service: 'pushover', pushover_token: TOKEN, pushover_user: USER });
    let result = run(['ntfy-test']);
    assert.equal(result.status, 1, result.out);
    assert.match(result.stderr, /^Set "ntfy_topic" in config\.json/m);
    writeConfig({ notify_service: 'pushover', ntfy_topic: TOPIC, ntfy_server: 'https://ntfy.invalid', pushover_token: TOKEN, pushover_user: USER });
    result = run(['ntfy-test'], { plan: { 'ntfy.invalid': [{ status: 200, body: { id: 'abc123def456' } }] } });
    assert.equal(result.status, 0, result.out);
    assert.deepEqual(
      result.requests.map((request) => request.url),
      ['https://ntfy.invalid'],
    );
  });
});

const TOKENS_FILE = JSON.stringify({ refresh_token: 'r', id_token: 'i', gcid: 'g', id_expires_at: 0 });

test('doctor --offline: the default config without the new settings passes and does not name Pushover', async () => {
  await withProgram(({ dir, run, writeConfig }) => {
    writeConfig({ client_id: CLIENT_ID, ntfy_topic: TOPIC });
    writeFileSync(join(dir, 'tokens.json'), TOKENS_FILE, { mode: 0o600 });
    const result = run(['doctor', '--offline']);
    assert.equal(result.status, 0, result.out);
    assert.match(result.stdout, /^OK {3}config\.json is valid\.\nOK {3}client_id and ntfy_topic are set\.$/m);
    assert.ok(!/pushover/i.test(result.out), result.out);
    assert.deepEqual(result.requests, [], 'offline: no request');
  });
});

const TOPIC_WARN = 'WARN ntfy_topic is empty or not valid. Keep a valid ntfy_topic in config.json: ntfy-test and a rollback to a release before Pushover need it.';

test('doctor --offline: with "pushover" the keys are checked offline, the keys are not shown, a missing topic is a warning', async () => {
  await withProgram(({ dir, run, writeConfig }) => {
    writeFileSync(join(dir, 'tokens.json'), TOKENS_FILE, { mode: 0o600 });
    writeConfig({ client_id: CLIENT_ID, notify_service: 'pushover', ntfy_topic: TOPIC, pushover_token: TOKEN, pushover_user: USER });
    let result = run(['doctor', '--offline']);
    assert.equal(result.status, 0, result.out);
    assert.match(result.stdout, /^OK {3}client_id is set\.\nOK {3}Notification service: Pushover\. pushover_token and pushover_user have the right form\.\n(?!WARN)/m);
    assert.ok(!result.stdout.includes('ntfy_topic'), 'a valid topic gives no warning');
    assert.ok(!result.stdout.includes('FAIL'), result.stdout);
    assert.deepEqual(result.requests, []);
    assertNoSecret(result.out);
    // Without a valid topic: a warning (a rollback needs the topic), not a failure, so install.sh still accepts the release.
    for (const topic of [undefined, '', 'short', 'YOUR-RANDOM-TOPIC-NAME']) {
      writeConfig({ client_id: CLIENT_ID, notify_service: 'pushover', ...(topic === undefined ? {} : { ntfy_topic: topic }), pushover_token: TOKEN, pushover_user: USER });
      result = run(['doctor', '--offline']);
      assert.equal(result.status, 0, `${topic}: ${result.out}`);
      assert.deepEqual(
        result.stdout.split('\n').filter((text) => text.includes('ntfy_topic')),
        [TOPIC_WARN],
        String(topic),
      );
      assert.ok(!result.stdout.includes('FAIL'), result.stdout);
      if (topic) assert.ok(!result.stdout.includes(topic), 'the topic is not shown');
    }
    writeConfig({ client_id: CLIENT_ID, notify_service: 'pushover', pushover_token: TOKEN.toLowerCase().slice(0, 25), pushover_user: USER });
    result = run(['doctor', '--offline']);
    assert.equal(result.status, 1, result.out);
    assert.match(result.stdout, /^FAIL "pushover_token" must have 30 letters and digits/m);
    assert.deepEqual(result.requests, []);
    assertNoSecret(result.out);
    assert.ok(!result.out.includes(TOKEN.toLowerCase().slice(0, 25)));
  });
});

test('doctor: online with "pushover" it asks Pushover to check the keys, it sends no message', async () => {
  await withProgram(({ dir, run, writeConfig }) => {
    writeFileSync(join(dir, 'tokens.json'), TOKENS_FILE, { mode: 0o600 });
    writeConfig({ client_id: CLIENT_ID, ntfy_server: 'https://ntfy.invalid', notify_service: 'pushover', pushover_token: TOKEN, pushover_user: USER });
    const ntfyHealth = { 'ntfy.invalid': [{ status: 200, body: { healthy: true } }] };
    let result = run(['doctor'], { plan: { ...ntfyHealth, ...PUSHOVER_OK } });
    // The fake network blocks the BMW stream server, so that line fails. The other lines pass.
    assert.equal(result.status, 1, result.out);
    assert.match(result.stdout, /^OK {3}Pushover accepted the token and the user key: HTTP 200\. The check sent no notification\.$/m);
    assert.match(result.stdout, /^FAIL BMW stream server cannot be reached: blocked by the test$/m);
    assert.deepEqual(
      result.stdout.split('\n').filter((text) => text.startsWith('FAIL')),
      ['FAIL BMW stream server cannot be reached: blocked by the test'],
    );
    const pushoverRequests = result.requests.filter((request) => request.url?.includes('pushover'));
    assert.deepEqual(
      pushoverRequests.map((request) => [request.url, request.method, [...new URLSearchParams(request.body)].map(([key]) => key)]),
      [[VALIDATE_URL, 'POST', ['token', 'user']]],
      'only the check, no message',
    );
    assert.ok(result.requests.some((request) => request.tls), 'the TLS check was blocked by the fake');
    assertNoSecret(result.out);

    result = run(['doctor'], { plan: { ...ntfyHealth, 'api.pushover.net': [{ status: 400, body: { user: 'invalid', status: 0, errors: [`user ${USER} is invalid`] } }] } });
    assert.match(result.stdout, /^FAIL Pushover refused the check: HTTP 400, the user key is not valid\.$/m);
    assertNoSecret(result.out);

    result = run(['doctor'], { plan: ntfyHealth });
    assert.match(result.stdout, /^FAIL Pushover cannot be reached: no answer \(ENOTFOUND\)\.$/m);
    assertNoSecret(result.out);
  });
});

test('doctor: online with "pushover" an ntfy server problem is a warning, with the default service it stays a failure', async () => {
  await withProgram(({ dir, run, writeConfig }) => {
    writeFileSync(join(dir, 'tokens.json'), TOKENS_FILE, { mode: 0o600 });
    const note = ' The service uses Pushover now, so this is a warning only.';
    const base = { client_id: CLIENT_ID, ntfy_topic: TOPIC, ntfy_server: 'https://ntfy.invalid', pushover_token: TOKEN, pushover_user: USER };
    for (const [plan, pushoverLine, defaultLine] of [
      [
        { 'ntfy.invalid': [{ status: 503, body: 'down' }] },
        `WARN ntfy server https://ntfy.invalid: HTTP 503.${note}`,
        'FAIL ntfy server https://ntfy.invalid: HTTP 503.',
      ],
      [
        {}, // the fake ntfy server cannot be reached
        `WARN ntfy server https://ntfy.invalid cannot be reached: fetch failed https://ntfy.invalid/v1/health.${note}`,
        'FAIL ntfy server https://ntfy.invalid cannot be reached: fetch failed https://ntfy.invalid/v1/health',
      ],
      [
        { 'ntfy.invalid': ['throw-with-period'] }, // an error text that ends with a period: one period only
        `WARN ntfy server https://ntfy.invalid cannot be reached: connection refused.${note}`,
        'FAIL ntfy server https://ntfy.invalid cannot be reached: connection refused.',
      ],
    ]) {
      writeConfig({ ...base, notify_service: 'pushover' });
      let result = run(['doctor'], { plan: { ...plan, ...PUSHOVER_OK } });
      assert.deepEqual(
        result.stdout.split('\n').filter((text) => text.includes('ntfy server')),
        [pushoverLine],
      );
      assert.deepEqual(
        result.stdout.split('\n').filter((text) => text.startsWith('FAIL')),
        ['FAIL BMW stream server cannot be reached: blocked by the test'],
        'only the blocked BMW check fails',
      );
      assertNoSecret(result.out);
      writeConfig(base); // the default service: the same line as before Pushover
      result = run(['doctor'], { plan });
      assert.deepEqual(
        result.stdout.split('\n').filter((text) => text.includes('ntfy server')),
        [defaultLine],
      );
      assert.ok(!/pushover/i.test(result.out), result.out);
    }
  });
});

test('doctor: online with the default service it does not call Pushover, also with Pushover keys in config.json', async () => {
  await withProgram(({ dir, run, writeConfig }) => {
    writeFileSync(join(dir, 'tokens.json'), TOKENS_FILE, { mode: 0o600 });
    writeConfig({ client_id: CLIENT_ID, ntfy_topic: TOPIC, ntfy_server: 'https://ntfy.invalid', pushover_token: TOKEN, pushover_user: USER });
    const result = run(['doctor'], { plan: { 'ntfy.invalid': [{ status: 200, body: { healthy: true } }], ...PUSHOVER_OK } });
    assert.match(result.stdout, /^OK {3}ntfy server https:\/\/ntfy\.invalid: HTTP 200\.$/m);
    assert.deepEqual(
      result.requests.filter((request) => request.url).map((request) => request.url),
      ['https://ntfy.invalid/v1/health'],
    );
    assert.ok(!/pushover/i.test(result.out), result.out);
  });
});

test('replay: no request with notify_service "pushover" and real-looking keys, the same notifications as with ntfy', async () => {
  await withProgram(({ dir, run }) => {
    const now = Date.now() / 1000;
    const line = (t, data) => JSON.stringify({ t, payload: JSON.stringify({ vin: 'TESTVIN0000000001', data: msg(data) }) });
    const messages = join(dir, 'messages.jsonl');
    writeFileSync(messages, `${[line(now - 4 * 3600, { [KM]: 100 }), line(now - 3 * 3600, { [WIN]: 'OPEN' })].join('\n')}\n`);
    const outputs = {};
    for (const service of ['pushover', 'ntfy']) {
      const config = join(dir, `${service}.json`);
      writeFileSync(config, JSON.stringify({ timezone: 'UTC', notify_service: service, ntfy_topic: TOPIC, pushover_token: TOKEN, pushover_user: USER }));
      // A plan that would accept every request: the tool must still send nothing.
      const result = run([messages, config, '--hours', '24'], { file: replayTool, plan: { ...PUSHOVER_OK, 'ntfy.sh': [{ status: 200, body: { id: 'abc123def456' } }] } });
      assert.equal(result.status, 0, result.out);
      assert.deepEqual(result.requests, [], `${service}: no request`);
      assert.match(result.stdout, /Replayed 2 messages of the last 24 hours \(1 car\)\. Notifications: 3\./);
      assert.match(result.stdout, /MINI: a part is open: Front right window/);
      assertNoSecret(result.out, service);
      assert.ok(!result.out.includes(TOPIC), 'no topic');
      outputs[service] = result.stdout.split('\n').filter((text) => /MINI/.test(text)).length;
    }
    assert.equal(outputs.pushover, outputs.ntfy);
  });
});
