const test = require('node:test');
const assert = require('node:assert/strict');
const { ProgramStatusTracker } = require('../.test-build/app/apps/terminal/rex/status.js');
const { parseProgramStatus, parseServerMessage } = require('../.test-build/app/apps/terminal/rex/protocol.js');

const BLOCK = 'block:a';
const NOT_VIEWING = false;
const VIEWING = true;
const AGENT_2_BLOCKED_MSG = 'Approve edit to naïve.ts? ✅ 日本語';

/** A block event as RexClient receives it: a server message through the protocol parser. */
function blockEvent(name, payload) {
  const raw = { type: 'event', seq: 1, payload: { type: 'session_event', payload: { session_id: 'session:a', event: { type: 'block_event', payload: { block_id: BLOCK, name, payload } } } } };
  const message = parseServerMessage(JSON.stringify(raw));
  assert.equal(message.type, 'event', message.reason);
  return message.event.event.event;
}

// Recorded from the live Rex server by scripts/rex-status-fixtures.mjs.
const reports = require('./fixtures/rex/status-reports.json');
const read = parseProgramStatus(require('./fixtures/rex/status-read.json'));
const reread = parseProgramStatus(require('./fixtures/rex/status-read-reconnect.json'));
const events = require('./fixtures/rex/status-events.json').map((e) => blockEvent(e.name, e.payload));
const alerts = events.filter((e) => e.name === 'desktop_notification' || e.name === 'bell');

function trackerAfterRead(records = read) {
  const tracker = new ProgramStatusTracker();
  tracker.read(BLOCK, records, NOT_VIEWING);
  return tracker;
}

function changed(id, state, extra = {}) {
  return blockEvent('program_status_changed', { id, record: { id, state, updated_at: '2026-01-01T00:00:00Z', ...extra }, reason: 'report' });
}

test('the program_status result parses to its records, root first and without an id', () => {
  assert.deepEqual(read.map((r) => [r.id, r.state, r.kind]), [
    [undefined, 'working', undefined],
    ['agent-1', 'working', undefined],
    ['agent-2', 'blocked', 'permission'],
    ['agent-2/check', 'working', undefined],
  ]);
  assert.deepEqual(parseProgramStatus({ records: null }), []);
  assert.throws(() => parseProgramStatus({ records: [{ id: 'x', state: 'working' }] }), /updated_at/);
});

test('a blocked child record outranks a working root', () => {
  assert.deepEqual(trackerAfterRead().rowStatus(BLOCK), { state: 'blocked', kind: 'permission', msg: AGENT_2_BLOCKED_MSG });
});

test('ranking runs blocked, error, done, working across nested records', () => {
  const tracker = new ProgramStatusTracker();
  tracker.apply(BLOCK, changed('', 'working', { msg: 'root' }), NOT_VIEWING);
  assert.equal(tracker.rowStatus(BLOCK).state, 'working');
  tracker.apply(BLOCK, changed('a/b', 'done', { msg: 'grandchild done' }), NOT_VIEWING);
  assert.deepEqual(tracker.rowStatus(BLOCK), { state: 'done', msg: 'grandchild done' });
  tracker.apply(BLOCK, changed('a', 'error', { msg: 'child failed' }), NOT_VIEWING);
  assert.deepEqual(tracker.rowStatus(BLOCK), { state: 'error', msg: 'child failed' });
  tracker.apply(BLOCK, changed('a/c', 'blocked', { kind: 'question', msg: 'Which branch?' }), NOT_VIEWING);
  assert.deepEqual(tracker.rowStatus(BLOCK), { state: 'blocked', kind: 'question', msg: 'Which branch?' });
});

test('the live event sequence ends with error, then nothing after clear', () => {
  const tracker = trackerAfterRead();
  const clearAll = events.findIndex((e) => e.name === 'program_status_removed' && e.ids.includes(''));
  for (const event of events.slice(0, clearAll)) tracker.apply(BLOCK, event, NOT_VIEWING);
  assert.deepEqual(tracker.rowStatus(BLOCK), { state: 'error', msg: 'Tests failed' });
  tracker.apply(BLOCK, events[clearAll], NOT_VIEWING);
  assert.equal(tracker.rowStatus(BLOCK), null);
});

test('an unknown state shows no mark and raises nothing, and an unknown kind is left out', () => {
  const paused = new ProgramStatusTracker();
  assert.equal(paused.read(BLOCK, read.map((r) => ({ ...r, state: 'paused' })), NOT_VIEWING), false);
  assert.equal(paused.rowStatus(BLOCK), null);
  const oddKind = read.map((r) => (r.state === 'blocked' ? { ...r, kind: 'telepathy' } : r));
  assert.deepEqual(trackerAfterRead(oddKind).rowStatus(BLOCK), { state: 'blocked', msg: AGENT_2_BLOCKED_MSG });
  const tracker = new ProgramStatusTracker();
  assert.equal(tracker.apply(BLOCK, changed('x', 'someday'), NOT_VIEWING), false);
  assert.equal(tracker.rowStatus(BLOCK), null);
});

test('msg arrives as the UTF-8 text the program base64-encoded', () => {
  const sent = (index) => Buffer.from(/msg=([A-Za-z0-9+/=]+)/.exec(reports[index])[1], 'base64').toString('utf8');
  assert.equal(trackerAfterRead(read.slice(0, 1)).rowStatus(BLOCK).msg, sent(0));
  assert.equal(sent(0), 'Working on café ☕');
  assert.equal(trackerAfterRead().rowStatus(BLOCK).msg, sent(2));
  assert.equal(sent(2), AGENT_2_BLOCKED_MSG);
  const tracker = new ProgramStatusTracker();
  tracker.apply(BLOCK, events[2], NOT_VIEWING);
  assert.equal(tracker.rowStatus(BLOCK).msg, AGENT_2_BLOCKED_MSG);
});

test('a removal lists the removed record and its children', () => {
  const removed = events.find((e) => e.name === 'program_status_removed');
  assert.deepEqual(removed.ids, ['agent-2', 'agent-2/check']);
  const tracker = trackerAfterRead();
  tracker.apply(BLOCK, removed, NOT_VIEWING);
  assert.deepEqual(tracker.rowStatus(BLOCK), { state: 'working', msg: 'Working on café ☕' });
});

test('a first read raises attention for a pane that is already blocked, and a reconnect re-read does not', () => {
  const tracker = new ProgramStatusTracker();
  assert.equal(tracker.read(BLOCK, read, NOT_VIEWING), true);
  assert.equal(tracker.read(BLOCK, reread, NOT_VIEWING), false);
  assert.deepEqual(tracker.rowStatus(BLOCK), { state: 'blocked', kind: 'permission', msg: AGENT_2_BLOCKED_MSG });
});

test('a repeated blocked report does not raise attention again', () => {
  const tracker = trackerAfterRead();
  const repeat = events[4];
  assert.equal(repeat.record.state, 'blocked');
  assert.equal(tracker.apply(BLOCK, repeat, NOT_VIEWING), false);
});

test('a blocked record that clears and blocks again raises again', () => {
  const tracker = trackerAfterRead();
  const raised = events.slice(4).map((event) => ({ name: event.name, state: event.record?.state, raise: tracker.apply(BLOCK, event, NOT_VIEWING) }));
  assert.deepEqual(raised.slice(0, 5), [
    { name: 'program_status_changed', state: 'blocked', raise: false },
    { name: 'program_status_changed', state: 'working', raise: false },
    { name: 'program_status_changed', state: 'blocked', raise: true },
    { name: 'program_status_removed', state: undefined, raise: false },
    { name: 'program_status_changed', state: 'blocked', raise: true },
  ]);
});

test('nothing raises attention while the block is viewed, and leaving does not replay it', () => {
  const tracker = new ProgramStatusTracker();
  assert.equal(tracker.read(BLOCK, read, VIEWING), false);
  assert.equal(tracker.read(BLOCK, reread, NOT_VIEWING), false);
  for (const event of alerts) assert.equal(tracker.apply(BLOCK, event, VIEWING), false);
});

test('a desktop notification and a bell raise attention on an unviewed block', () => {
  const tracker = new ProgramStatusTracker();
  assert.deepEqual(alerts.map((e) => e.name), ['desktop_notification', 'bell']);
  for (const event of alerts) assert.equal(tracker.apply(BLOCK, event, NOT_VIEWING), true);
  assert.equal(tracker.rowStatus(BLOCK), null);
});

test('events that carry no status change nothing', () => {
  const tracker = trackerAfterRead();
  assert.equal(tracker.apply(BLOCK, blockEvent('title_changed', { title: 'x' }), NOT_VIEWING), false);
  assert.equal(tracker.rowStatus(BLOCK).state, 'blocked');
});

test('blocks are tracked separately and a block no longer retained shows nothing', () => {
  const tracker = trackerAfterRead();
  assert.equal(tracker.rowStatus('block:b'), null);
  assert.equal(tracker.apply('block:b', changed('agent-2', 'blocked'), NOT_VIEWING), true);
  tracker.retain(new Set(['block:b']));
  assert.equal(tracker.rowStatus(BLOCK), null);
  assert.equal(tracker.rowStatus('block:b').state, 'blocked');
});
