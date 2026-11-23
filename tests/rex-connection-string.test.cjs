const test = require('node:test');
const assert = require('node:assert/strict');

const { parseRexConnectionString } = require('../.test-build/app/apps/terminal/rex/connection-string.js');

test('https:// is the tailnet address, reached over wss', () => {
  assert.deepEqual(parseRexConnectionString('https://rex.tail1234.ts.net'), {
    scheme: 'https',
    displayHost: 'rex.tail1234.ts.net',
    connectionString: 'https://rex.tail1234.ts.net',
    controlUrl: 'wss://rex.tail1234.ts.net/api/control',
    dataUrl: 'wss://rex.tail1234.ts.net/api/data',
    httpBase: 'https://rex.tail1234.ts.net',
  });
  const custom = parseRexConnectionString('https://studio.tail1234.ts.net:7297/');
  assert.equal(custom.controlUrl, 'wss://studio.tail1234.ts.net:7297/api/control');
  assert.equal(custom.displayHost, 'studio.tail1234.ts.net:7297');
});

test('rex:// is the plain relay, reached over ws', () => {
  assert.deepEqual(parseRexConnectionString('rex://127.0.0.1:8792'), {
    scheme: 'rex',
    displayHost: '127.0.0.1:8792',
    connectionString: 'rex://127.0.0.1:8792',
    controlUrl: 'ws://127.0.0.1:8792/api/control',
    dataUrl: 'ws://127.0.0.1:8792/api/data',
    httpBase: 'http://127.0.0.1:8792',
  });
  assert.equal(parseRexConnectionString('rex://[::1]:8792').controlUrl, 'ws://[::1]:8792/api/control');
});

test('spellings of one server share one canonical connection string', () => {
  const spellings = [
    'https://rex.tail1234.ts.net',
    'https://rex.tail1234.ts.net/',
    'HTTPS://Rex.Tail1234.TS.net',
    'https://rex.tail1234.ts.net:443',
    'https://rex.tail1234.ts.net:443/',
    '  https://rex.tail1234.ts.net\n',
  ];
  for (const spelling of spellings) {
    assert.equal(parseRexConnectionString(spelling).connectionString, 'https://rex.tail1234.ts.net', spelling);
  }
  assert.equal(parseRexConnectionString('REX://LOCALHOST:8792/').connectionString, 'rex://localhost:8792');
});

test('malformed and unsupported strings are rejected', () => {
  const rejected = [
    '',
    'rex.tail1234.ts.net',
    'https://',
    'rex://127.0.0.1',
    'rex://127.0.0.1:0',
    'rex://127.0.0.1:65536',
    'https://rex.tail1234.ts.net:99999',
    'https://rex tail.ts.net',
    'http://rex.tail1234.ts.net:7297',
    'wss://rex.tail1234.ts.net/api/control',
    'ws://127.0.0.1:8792',
    'https://rex.tail1234.ts.net/api/control',
    'https://rex.tail1234.ts.net/?token=abc',
    'https://rex.tail1234.ts.net/#pair',
    'https://root@rex.tail1234.ts.net',
    'https://user:pass@rex.tail1234.ts.net',
    'ssh://jim@laptop',
    'g2mirror://tok@laptop',
  ];
  for (const input of rejected) {
    assert.equal(parseRexConnectionString(input), null, JSON.stringify(input));
  }
});
