const test = require('node:test');
const assert = require('node:assert/strict');
const { parseProgramStatus, parseStatusEvent, ProgramStatusTracker } = require('../.test-build/app/apps/terminal/rex/status.js');

// Recorded from the live Rex server by scripts/rex-status-fixtures.mjs.
const reports = require('./fixtures/rex/status-reports.json');
const read = require('./fixtures/rex/status-read.json');
const reread = require('./fixtures/rex/status-read-reconnect.json');
const events = require('./fixtures/rex/status-events.json').map((e) => ({ name: e.name, event: parseStatusEvent(e.name, e.payload) }));

const BLOCK = 'block:a';
const NOT_VIEWING = false;
const VIEWING = true;
const AGENT_2_BLOCKED_MSG = 'Approve edit to naïve.ts? ✅ 日本語';

function trackerAfterRead(result = read) {
  const tracker = new ProgramStatusTracker();
  tracker.read(BLOCK, parseProgramStatus(result), NOT_VIEWING);
  return tracker;
}

function changed(id, state, extra = {}) {
  return { type: 'changed', record: { id, state, ...extra } };
}

test('a blocked child record outranks a working root', () => {
  const tracker = trackerAfterRead();
  assert.deepEqual(tracker.rowStatus(BLOCK), { state: 'blocked', kind: 'permission', msg: AGENT_2_BLOCKED_MSG });
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
  const clearAll = events.findIndex((e) => e.name === 'program_status_removed' && e.event.ids.includes(''));
  for (const { event } of events.slice(0, clearAll)) tracker.apply(BLOCK, event, NOT_VIEWING);
  assert.deepEqual(tracker.rowStatus(BLOCK), { state: 'error', msg: 'Tests failed' });
  tracker.apply(BLOCK, events[clearAll].event, NOT_VIEWING);
  assert.equal(tracker.rowStatus(BLOCK), null);
});

test('an unknown state reads as idle and an unknown kind as absent', () => {
  const result = structuredClone(read);
  for (const record of result.records) record.state = 'paused';
  result.records[2].kind = 'telepathy';
  const records = parseProgramStatus(result);
  assert.deepEqual(records.map((r) => r.state), ['idle', 'idle', 'idle', 'idle']);
  assert.equal(records[2].kind, undefined);
  assert.equal(trackerAfterRead(result).rowStatus(BLOCK), null);
  const event = parseStatusEvent('program_status_changed', { id: 'x', record: { state: 'someday', updated_at: '' }, reason: 'report' });
  assert.equal(event.record.state, 'idle');
});

test('msg arrives as the UTF-8 text the program base64-encoded', () => {
  const records = parseProgramStatus(read);
  const sent = (index) => Buffer.from(/msg=([A-Za-z0-9+/=]+)/.exec(reports[index])[1], 'base64').toString('utf8');
  assert.equal(records[0].msg, sent(0));
  assert.equal(records[0].msg, 'Working on café ☕');
  assert.equal(records[2].msg, sent(2));
  assert.equal(records[2].msg, AGENT_2_BLOCKED_MSG);
  assert.equal(events[2].event.record.msg, AGENT_2_BLOCKED_MSG);
});

test('records keep their nested ids, with the root as ""', () => {
  assert.deepEqual(parseProgramStatus(read).map((r) => r.id), ['', 'agent-1', 'agent-2', 'agent-2/check']);
  const removed = events.find((e) => e.name === 'program_status_removed').event;
  assert.deepEqual(removed, { type: 'removed', ids: ['agent-2', 'agent-2/check'] });
});

test('a new blocked record raises attention, a reconnect re-read does not', () => {
  const tracker = new ProgramStatusTracker();
  assert.equal(tracker.read(BLOCK, parseProgramStatus(read), NOT_VIEWING), true);
  assert.equal(tracker.read(BLOCK, parseProgramStatus(reread), NOT_VIEWING), false);
  assert.deepEqual(tracker.rowStatus(BLOCK), { state: 'blocked', kind: 'permission', msg: AGENT_2_BLOCKED_MSG });
});

test('a repeated blocked report does not raise attention again', () => {
  const tracker = trackerAfterRead();
  const repeat = events[4];
  assert.equal(repeat.event.record.state, 'blocked');
  assert.equal(tracker.apply(BLOCK, repeat.event, NOT_VIEWING), false);
});

test('a blocked record that clears and blocks again raises again', () => {
  const tracker = trackerAfterRead();
  const raised = events.slice(4).map(({ name, event }) => ({ name, state: event.record?.state, raise: tracker.apply(BLOCK, event, NOT_VIEWING) }));
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
  assert.equal(tracker.read(BLOCK, parseProgramStatus(read), VIEWING), false);
  assert.equal(tracker.read(BLOCK, parseProgramStatus(reread), NOT_VIEWING), false);
  for (const { event } of events.filter((e) => e.name === 'desktop_notification' || e.name === 'bell')) {
    assert.equal(tracker.apply(BLOCK, event, VIEWING), false);
  }
});

test('a desktop notification and a bell raise attention on an unviewed block', () => {
  const tracker = new ProgramStatusTracker();
  const alerts = events.filter((e) => e.name === 'desktop_notification' || e.name === 'bell');
  assert.equal(alerts.length, 2);
  for (const { event } of alerts) assert.equal(tracker.apply(BLOCK, event, NOT_VIEWING), true);
  assert.equal(tracker.rowStatus(BLOCK), null);
});

test('blocks are tracked separately and a forgotten block shows nothing', () => {
  const tracker = trackerAfterRead();
  assert.equal(tracker.rowStatus('block:b'), null);
  assert.equal(tracker.apply('block:b', changed('agent-2', 'blocked'), NOT_VIEWING), true);
  tracker.forget(BLOCK);
  assert.equal(tracker.rowStatus(BLOCK), null);
  assert.equal(tracker.rowStatus('block:b').state, 'blocked');
});

test('events that carry no status parse to null', () => {
  assert.equal(parseStatusEvent('title_changed', { title: 'x' }), null);
  assert.equal(parseStatusEvent('program_status_changed', { record: { state: 'working' } }), null);
});
