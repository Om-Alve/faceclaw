const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const protocol = require('../.test-build/app/apps/terminal/rex/protocol.js');
const fixtures = require(path.join(__dirname, 'fixtures', 'rex', 'control-messages.json'));

const parse = (message) => protocol.parseServerMessage(typeof message === 'string' ? message : JSON.stringify(message));

test('every recorded fixture parses', () => {
  for (const [key, message] of Object.entries(fixtures)) {
    const parsed = parse(message);
    assert.notEqual(parsed.type, 'invalid', `${key}: ${parsed.reason}`);
    assert.notEqual(parsed.type, 'skip', key);
  }
});

test('the recorded welcome speaks rex.control.v1 at revision 18', () => {
  const parsed = parse(fixtures.welcome);
  assert.equal(parsed.type, 'welcome');
  assert.equal(parsed.welcome.protocol, protocol.REX_CONTROL_SUBPROTOCOL);
  assert.equal(parsed.welcome.apiRevision, protocol.REX_API_REVISION);
  assert.equal(parsed.welcome.maxMessageBytes, 1048576);
  assert.equal(parsed.welcome.client.id, fixtures.welcome.client.id);
  assert.equal(parsed.welcome.client.resumed, false);
});

test('recorded bootstrap and view results parse into the session model', () => {
  const bootstrap = protocol.parseBootstrap(parse(fixtures.response_bootstrap).outcome.payload);
  assert.deepEqual(bootstrap.sessions, [{ sessionId: fixtures.response_bootstrap.payload.attach_all.sessions[0].session_id, label: 'lane-r1-fixtures' }]);

  const view = protocol.parseSessionView(parse(fixtures.response_view).outcome.payload);
  const wire = fixtures.response_view.payload;
  assert.equal(view.sessionId, wire.session_id);
  assert.equal(view.revision, wire.revision);
  assert.equal(view.label, 'lane-r1-fixtures');
  assert.equal(view.windows.length, 1);
  assert.deepEqual(
    view.windows[0].blocks.map((block) => [block.blockId, block.creatorName]),
    [[wire.windows[0].layers[0].blocks[0].block_id, 'com.superlogical.terminal']],
  );
});

test('recorded format and program_status results carry the pane content', () => {
  assert.match(parse(fixtures.response_format_text).outcome.payload.content, /^rex-fixture-ok$/m);
  assert.match(parse(fixtures.response_format_vt).outcome.payload.content, /\x1b\[\d+;\d+H$/);
  const [record] = parse(fixtures.response_program_status).outcome.payload.records.map(protocol.parseProgramStatusRecord);
  assert.equal(record.state, 'blocked');
  assert.equal(record.kind, 'permission');
  assert.equal(record.msg, 'Approve?');
});

test('recorded error responses carry their codes', () => {
  for (const [key, code, status] of [
    ['response_error_method_not_found', 'method_not_found', 404],
    ['response_error_bad_request', 'bad_request', 400],
  ]) {
    const parsed = parse(fixtures[key]);
    assert.equal(parsed.type, 'response');
    assert.equal(parsed.outcome.status, 'error');
    assert.equal(parsed.outcome.error.code, code);
    assert.equal(parsed.outcome.error.status, status);
  }
});

test('recorded session and block events parse into typed events', () => {
  const sessionId = fixtures.event_session_created.payload.payload.session.session_id;
  const created = parse(fixtures.event_session_created).event;
  assert.deepEqual(created, { name: 'session_created', sessionId, label: 'lane-r1-fixtures' });
  assert.deepEqual(parse(fixtures.event_session_destroyed).event, { name: 'session_destroyed', sessionId });
  assert.deepEqual(parse(fixtures.event_session_view_changed).event.event, { name: 'session_view_changed', revision: 2 });

  const blockOf = (key) => {
    const event = parse(fixtures[key]).event;
    assert.equal(event.name, 'session_event');
    assert.equal(event.event.name, 'block');
    return event.event.event;
  };
  for (const key of Object.keys(fixtures).filter((name) => name.startsWith('event_block_'))) {
    const expected = key === 'event_block_owner_changed' ? 'block_owner_changed' : key.slice('event_block_'.length);
    assert.equal(blockOf(key).name, expected);
  }
  assert.equal(blockOf('event_block_title_changed').title, 'rex-fixture-title');
  assert.equal(blockOf('event_block_desktop_notification').body, 'rex fixture');
  assert.equal(blockOf('event_block_program_status_changed').record.state, 'blocked');
  assert.deepEqual(blockOf('event_block_program_status_removed').ids, ['']);
  assert.equal(blockOf('event_block_process_changed').foreground.name, 'sleep');
  assert.equal(blockOf('event_block_size_changed').columns, 100);
  assert.equal(blockOf('event_block_child_exited').exitCode, 0);
  assert.equal(blockOf('event_block_progress_report').progress, 40);
  assert.equal(blockOf('event_block_owner_changed').reason, 'take');
});

test('an unknown message type is skipped', () => {
  assert.deepEqual(parse({ type: 'telemetry', payload: {} }), { type: 'skip', wireType: 'telemetry' });
});

test('unknown events parse as generic events at every level', () => {
  assert.deepEqual(parse({ type: 'event', seq: 4, payload: { type: 'galaxy_formed', payload: { stars: 3 } } }).event, { name: 'other', wireName: 'galaxy_formed' });
  const session = (event) => ({ type: 'event', seq: 5, payload: { type: 'session_event', payload: { session_id: 'session:a', event } } });
  assert.deepEqual(parse(session({ type: 'layer_folded', payload: {} })).event.event, { name: 'other', wireName: 'layer_folded' });
  const block = parse(session({ type: 'block_event', payload: { block_id: 'block:b', name: 'pwd_changed', payload: { pwd: '/tmp' } } })).event.event;
  assert.deepEqual(block, { name: 'block', blockId: 'block:b', event: { name: 'other', wireName: 'pwd_changed' } });
});

test('a response with no id is rejected', () => {
  assert.equal(parse({ type: 'response', seq: 0, payload: {} }).type, 'invalid');
  assert.equal(parse({ type: 'response', id: '', seq: 0, payload: {} }).type, 'invalid');
  assert.equal(parse('not json').type, 'invalid');
});

test('hello carries revision 18 and the reconnect token only when there is one', () => {
  const client = { kind: 'app', name: 'faceclaw', version: '1' };
  assert.deepEqual(protocol.buildHello(client, null), { type: 'hello', api_revision: 18, api_min_revision: 18, client });
  assert.equal(protocol.buildHello(client, 'token-1').reconnect_token, 'token-1');
  assert.deepEqual(protocol.buildRequest('7', 'session.view', { session_id: 's' }), { type: 'request', id: '7', method: 'session.view', payload: { session_id: 's' } });
});
