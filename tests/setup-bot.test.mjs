import test from 'node:test';
import assert from 'node:assert/strict';
import { run, parseEnv, MENU_TEXT } from '../scripts/setup-bot.mjs';

// Built at runtime so the repo never contains a literal that matches the CI secret-scan regex.
const TOKEN = '123456789' + ':' + 'AA' + 'x'.repeat(35);
const URL_OK = 'https://user.github.io/btc-pulse-bot/';
const NO_FILE = 'D:/definitely/missing/.env';

function harness({ token = TOKEN, url = URL_OK, fail = null, menuUrl = url } = {}) {
  const calls = [];
  const lines = [];
  const fetchImpl = async (u, init) => {
    const method = u.split('/').pop();
    const payload = JSON.parse(init.body);
    calls.push({ u, method, payload });
    if (fail === method) return { ok: false, status: 400, json: async () => ({ ok: false, description: `bad ${TOKEN}` }) };
    const results = {
      getMe: { username: 'btc_pulse_bot' },
      getChatMenuButton: { type: 'web_app', text: MENU_TEXT, web_app: { url: menuUrl } },
    };
    return { ok: true, status: 200, json: async () => ({ ok: true, result: results[method] ?? true }) };
  };
  const opts = {
    envPath: NO_FILE,
    processEnv: { BOT_TOKEN: token, WEBAPP_URL: url },
    fetchImpl,
    log: (m) => lines.push(m),
    logError: (m) => lines.push(m),
  };
  return { calls, lines, opts };
}

test('parseEnv handles comments, quotes, blanks', () => {
  assert.deepEqual(parseEnv('# c\nA=1\n\nB="two"\nC = \'3\'\n'), { A: '1', B: 'two', C: '3' });
});

test('happy path: payloads, order, exit 0', async () => {
  const h = harness();
  assert.equal(await run(h.opts), 0);
  assert.deepEqual(h.calls.map((c) => c.method), [
    'getMe', 'setChatMenuButton', 'setMyDescription', 'setMyShortDescription', 'setMyCommands', 'getChatMenuButton',
  ]);
  assert.deepEqual(h.calls[1].payload, {
    menu_button: { type: 'web_app', text: MENU_TEXT, web_app: { url: URL_OK } },
  });
  assert.deepEqual(h.calls[4].payload, { commands: [] });
  assert.ok(h.calls[2].payload.description.length <= 512);
  assert.ok(h.calls[3].payload.short_description.length <= 120);
  assert.ok(h.calls.every((c) => c.u.startsWith('https://api.telegram.org/bot')));
});

test('idempotent: second run produces the same calls', async () => {
  const a = harness();
  const b = harness();
  await run(a.opts);
  await run(b.opts);
  assert.deepEqual(a.calls.map((c) => [c.method, c.payload]), b.calls.map((c) => [c.method, c.payload]));
});

test('rejects http:// and garbage URLs with exit 1, no API calls', async () => {
  for (const url of ['http://user.github.io/x/', 'not a url']) {
    const h = harness({ url });
    assert.equal(await run(h.opts), 1);
    assert.equal(h.calls.length, 0);
  }
});

test('missing or malformed config gives exit 1', async () => {
  assert.equal(await run(harness({ token: '' }).opts), 1);
  assert.equal(await run(harness({ url: '' }).opts), 1);
  assert.equal(await run(harness({ token: 'abc' }).opts), 1);
});

test('API failure gives exit 2', async () => {
  assert.equal(await run(harness({ fail: 'setChatMenuButton' }).opts), 2);
  assert.equal(await run(harness({ fail: 'getMe' }).opts), 2);
});

test('verification mismatch gives exit 2', async () => {
  assert.equal(await run(harness({ menuUrl: 'https://other.example/' }).opts), 2);
});

test('token never appears in output, even when the API echoes it', async () => {
  for (const fail of [null, 'setMyDescription']) {
    const h = harness({ fail });
    await run(h.opts);
    assert.ok(h.lines.length > 0);
    assert.ok(h.lines.every((l) => !l.includes(TOKEN)));
  }
});
