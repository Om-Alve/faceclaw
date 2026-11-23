const test = require('node:test');
const assert = require('node:assert/strict');

const { RexMethod, parseDataTicket } = require('../.test-build/app/apps/terminal/rex/protocol.js');

test('data.connect returns its ticket', () => {
  assert.equal(RexMethod.dataConnect, 'data.connect');
  assert.equal(parseDataTicket({ ticket: 'AAECAwQFBgcICQoLDA0ODw', expires_in_ms: 60000 }), 'AAECAwQFBgcICQoLDA0ODw');
});

test('a data.connect result without a string ticket is rejected', () => {
  assert.throws(() => parseDataTicket({ expires_in_ms: 60000 }));
  assert.throws(() => parseDataTicket({ ticket: 16 }));
  assert.throws(() => parseDataTicket(null));
  assert.throws(() => parseDataTicket([]));
});
