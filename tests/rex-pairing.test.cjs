const test = require('node:test');
const assert = require('node:assert/strict');

const { parseRexConnectionString } = require('../.test-build/app/apps/terminal/rex/connection-string.js');
const { probeRex, rexFailureNotice, parseRexPairingQr } = require('../.test-build/app/apps/terminal/rex/pairing.js');

const FAILURE_MESSAGE_BUDGET_MS = 5000;

const tailnet = parseRexConnectionString('https://rex.tail1234.ts.net');
const relay = parseRexConnectionString('rex://127.0.0.1:8792');

function headAnswering(answer) {
  const calls = [];
  const head = async (url, timeoutMs) => {
    calls.push({ url, timeoutMs });
    return answer();
  };
  return { head, calls };
}

test('a 200 from HEAD /llms.txt means reachable', async () => {
  const { head, calls } = headAnswering(() => 200);
  assert.equal(await probeRex(tailnet, head), 'reachable');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://rex.tail1234.ts.net/llms.txt');
  assert.ok(calls[0].timeoutMs > 0 && calls[0].timeoutMs < FAILURE_MESSAGE_BUDGET_MS);
});

test('a 403 means Rex refused this device', async () => {
  const { head } = headAnswering(() => 403);
  assert.equal(await probeRex(tailnet, head), 'refused');
  assert.deepEqual(rexFailureNotice(tailnet, 'refused'), {
    line: 'Rex refused this device',
    hint: 'Sign the phone into the same tailnet account',
  });
});

test('a network error means unreachable, named by host', async () => {
  const { head } = headAnswering(() => {
    throw new TypeError('fetch failed');
  });
  assert.equal(await probeRex(tailnet, head), 'unreachable');
  assert.deepEqual(rexFailureNotice(tailnet, 'unreachable'), {
    line: "Can't reach rex.tail1234.ts.net",
    hint: 'Check that Tailscale is on',
  });
  assert.deepEqual(rexFailureNotice(relay, 'unreachable'), {
    line: "Can't reach 127.0.0.1:8792",
    hint: 'Check that the relay is running',
  });
});

test('any other status means unreachable', async () => {
  for (const status of [301, 404, 426, 502]) {
    const { head } = headAnswering(() => status);
    assert.equal(await probeRex(tailnet, head), 'unreachable', String(status));
  }
});

test('the relay is probed over plain http', async () => {
  const { head, calls } = headAnswering(() => 200);
  await probeRex(relay, head);
  assert.equal(calls[0].url, 'http://127.0.0.1:8792/llms.txt');
});

test('a Rex pairing QR gives its address, with or without a trailing slash', () => {
  for (const payload of ['https://rex.tail1234.ts.net', 'https://rex.tail1234.ts.net/']) {
    assert.deepEqual(parseRexPairingQr(payload), { ok: true, connectionString: 'https://rex.tail1234.ts.net' }, payload);
  }
});

test('a non-Rex QR is rejected with a message and no address', () => {
  for (const payload of ['WIFI:T:WPA;S:home;P:secret;;', 'https://example.com/menu?table=4', 'rex://127.0.0.1:8792', '']) {
    assert.deepEqual(parseRexPairingQr(payload), { ok: false, message: 'Not a Rex pairing code' }, payload);
  }
});
