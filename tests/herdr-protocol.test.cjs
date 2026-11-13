const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseServerMessage,
  parsePaneSummary,
  parseHealth,
  isAllowedKey,
  promptRevision,
  normalizePromptText,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_3,
} = require('../.test-build/app/apps/herdr/protocol.js');

const parse = (message) => parseServerMessage(JSON.stringify(message));

function pane(overrides = {}) {
  return {
    id: 'default/w1:p1',
    session: 'default',
    paneId: 'w1:p1',
    workspace: 'faceclaw',
    tab: 'main',
    agent: 'claude',
    status: 'working',
    title: 'claude',
    chat: 'transcript',
    subagents: 0,
    stateSeq: 42,
    ...overrides,
  };
}

function entry(overrides = {}) {
  return { id: 'e1', kind: 'assistant', text: 'hello', ...overrides };
}

test('hello: protocol 2 snapshot with snippets', () => {
  const message = parse({
    t: 'hello',
    protocol: 2,
    machine: 'mac',
    herdrVersion: '0.4.1',
    user: 'om@example.com',
    snippets: [
      { label: 'yes', keys: ['y'] },
      { label: 'compact', text: '/compact', enter: true },
      { label: 'bad', keys: ['ctrl++'] },
    ],
  });
  assert.equal(message.t, 'hello');
  assert.equal(message.protocol, 2);
  assert.equal(message.machine, 'mac');
  assert.equal(message.herdrVersion, '0.4.1');
  assert.equal(message.user, 'om@example.com');
  // Disallowed key combos are dropped from a snippet; the snippet stays with its label.
  assert.deepEqual(message.snippets, [
    { label: 'yes', keys: ['y'] },
    { label: 'compact', text: '/compact', enter: true },
    { label: 'bad' },
  ]);
});

test('hello: optional version and user default to null; snippets default to empty', () => {
  const message = parse({ t: 'hello', protocol: 3, machine: 'mini' });
  assert.equal(message.herdrVersion, null);
  assert.equal(message.user, null);
  assert.deepEqual(message.snippets, []);
  // Explicit nulls are preserved.
  assert.equal(parse({ t: 'hello', protocol: 3, machine: 'mini', herdrVersion: null, user: null }).herdrVersion, null);
});

test('panes: protocol 2 and protocol 3 fields', () => {
  const v2 = parse({ t: 'panes', panes: [pane()] });
  assert.equal(v2.t, 'panes');
  assert.deepEqual(v2.panes, [pane()]);

  const v3Fields = pane({
    id: 'default/w1:p2',
    paneId: 'w1:p2',
    status: 'blocked',
    stateSeq: 51,
    terminalId: 'term-9',
    agentSession: { kind: 'claude', value: 'session-abc' },
    completionSeq: 17,
    focused: true,
  });
  const v3 = parse({ t: 'panes', panes: [v3Fields] });
  assert.deepEqual(v3.panes, [v3Fields]);

  // A null agent session survives as null; an empty terminal id is omitted.
  const nullSession = parsePaneSummary(pane({ terminalId: '', agentSession: null, completionSeq: 0, focused: false }));
  assert.deepEqual(nullSession, { ...pane(), agentSession: null, completionSeq: 0, focused: false });
});

test('parsePaneSummary ignores unknown well-formed props and floors counts', () => {
  const parsed = parsePaneSummary(pane({ extra: 'ignored', another: { deep: true }, subagents: 2.9 }));
  assert.equal('extra' in parsed, false);
  assert.equal('another' in parsed, false);
  assert.equal(parsed.subagents, 2);
  assert.equal(parsePaneSummary(pane({ subagents: -3 })).subagents, 0);
});

test('chat, append, update and older windows', () => {
  const snapshot = parse({
    t: 'chat',
    id: 'r1',
    pane: 'default/w1:p1',
    source: 'transcript',
    entries: [
      entry({ id: 'u1', kind: 'user', text: 'fix it', ts: 1000 }),
      entry({ id: 'a1', text: 'on it', subagent: 'sub-1' }),
      entry({ id: 't1', kind: 'tool', text: 'npm test\nmore output' }),
      entry({ id: 'q1', kind: 'question', text: 'Which database?', questions: [{ prompt: 'Which database?', options: ['postgres', 'sqlite'] }], answered: false, reply: 'keys' }),
    ],
    hasOlder: true,
  });
  assert.equal(snapshot.t, 'chat');
  assert.equal(snapshot.id, 'r1');
  assert.equal(snapshot.source, 'transcript');
  assert.equal(snapshot.hasOlder, true);
  assert.deepEqual(snapshot.entries.map((item) => item.kind), ['user', 'assistant', 'tool', 'question']);
  assert.equal(snapshot.entries[0].ts, 1000);
  assert.equal(snapshot.entries[1].subagent, 'sub-1');
  assert.equal(snapshot.entries[3].questions[0].options[1], 'sqlite');
  assert.equal(snapshot.entries[3].answered, false);
  assert.equal(snapshot.entries[3].reply, 'keys');

  const append = parse({ t: 'chat.append', pane: 'default/w1:p1', subagent: 'sub-1', entries: [entry()] });
  assert.deepEqual(append, { t: 'chat.append', pane: 'default/w1:p1', subagent: 'sub-1', entries: [entry()] });

  const update = parse({ t: 'chat.update', pane: 'default/w1:p1', entries: [entry({ text: 'changed' })] });
  assert.deepEqual(update, { t: 'chat.update', pane: 'default/w1:p1', entries: [entry({ text: 'changed' })] });

  const older = parse({ t: 'chat.older', id: 'r2', pane: 'default/w1:p1', entries: [entry({ id: 'old' })], hasOlder: false });
  assert.equal(older.id, 'r2');
  assert.equal(older.hasOlder, false);
  assert.deepEqual(older.entries.map((item) => item.id), ['old']);
});

test('queue, queue.summary, queue.outcomes and subagents', () => {
  const queue = parse({ t: 'queue', pane: 'default/w1:p1', items: [{ id: 'i1', text: 'later', ts: 5 }] });
  assert.deepEqual(queue, { t: 'queue', pane: 'default/w1:p1', items: [{ id: 'i1', text: 'later', ts: 5 }] });

  const summary = parse({ t: 'queue.summary', panes: [{ pane: 'default/w1:p1', pending: 2.8, undelivered: -1 }] });
  assert.deepEqual(summary.panes, [{ pane: 'default/w1:p1', pending: 2, undelivered: 0 }]);

  const outcomes = parse({
    t: 'queue.outcomes',
    pane: 'default/w1:p1',
    items: [
      { id: 'i1', text: 'later', ts: 5, outcome: 'undelivered', reason: 'agent session changed' },
      { id: 'i2', text: 'old', ts: 4, outcome: 'accepted' },
      { id: 'i3', text: 'gone', ts: 3, outcome: 'bogus' },
    ],
  });
  assert.equal(outcomes.items.length, 2, 'unknown outcomes are dropped');
  assert.equal(outcomes.items[0].reason, 'agent session changed');

  const subs = parse({
    t: 'subagents',
    pane: 'default/w1:p1',
    subagents: [
      { id: 's1', label: 'Explore', description: 'find it', status: 'working', lastActivity: 10 },
      { id: 's2', label: 'Bad', description: 'x', status: 'sleeping' },
    ],
  });
  assert.equal(subs.subagents.length, 1, 'unknown subagent statuses are dropped');
  assert.equal(subs.subagents[0].lastActivity, 10);
});

test('prompt, ok, pong and error', () => {
  assert.deepEqual(parse({ t: 'prompt', pane: 'default/w1:p1', text: 'Allow npm test?' }), {
    t: 'prompt',
    pane: 'default/w1:p1',
    text: 'Allow npm test?',
  });
  assert.deepEqual(parse({ t: 'prompt', pane: 'default/w1:p1', text: null }), {
    t: 'prompt',
    pane: 'default/w1:p1',
    text: null,
  });
  assert.deepEqual(parse({ t: 'ok', id: 'h7' }), { t: 'ok', id: 'h7' });
  assert.deepEqual(parse({ t: 'pong', id: 'h8' }), { t: 'pong', id: 'h8' });
  assert.deepEqual(parse({ t: 'error', id: 'h9', code: 'unknown_pane', message: 'gone' }), {
    t: 'error',
    id: 'h9',
    code: 'unknown_pane',
    message: 'gone',
  });
  // An unsolicited error has no id.
  const unsolicited = parse({ t: 'error', code: 'herdr_unavailable', message: 'socket down' });
  assert.equal(unsolicited.id, undefined);
  // key_not_allowed is a real code and is accepted.
  assert.equal(parse({ t: 'error', code: 'key_not_allowed', message: 'nope' }).code, 'key_not_allowed');
});

test('malformed JSON, unknown types and bad shapes are rejected', () => {
  for (const text of ['', 'not json', '{oops', 'null', '[]', '"hello"', '17']) {
    assert.equal(parseServerMessage(text), null, `rejects ${JSON.stringify(text)}`);
  }
  assert.equal(parseServerMessage('{}'), null);
  assert.equal(parse({ t: 'nope' }), null);
  assert.equal(parse({ t: 7 }), null);

  // hello missing required fields
  assert.equal(parse({ t: 'hello', protocol: 2 }), null);
  assert.equal(parse({ t: 'hello', machine: 'mac' }), null);
  assert.equal(parse({ t: 'hello', protocol: '2', machine: 'mac' }), null);

  // panes: not an array is fatal; bad entries are filtered
  assert.equal(parse({ t: 'panes' }), null);
  assert.equal(parse({ t: 'panes', panes: 'x' }), null);
  assert.equal(parsePaneSummary(pane({ status: 'sleeping' })), null);
  assert.equal(parsePaneSummary(pane({ chat: 'email' })), null);
  assert.equal(parsePaneSummary(pane({ id: 3 })), null);
  assert.deepEqual(parse({ t: 'panes', panes: [pane({ status: 'bogus' }), pane()] }).panes, [pane()]);

  // chat: source and entries are required; a bad entry kind is filtered
  assert.equal(parse({ t: 'chat', pane: 'default/w1:p1', entries: [] }), null);
  assert.equal(parse({ t: 'chat', pane: 'default/w1:p1', source: 'video', entries: [] }), null);
  assert.equal(parse({ t: 'chat', source: 'screen', entries: [] }), null);
  assert.equal(parse({ t: 'chat', pane: 'default/w1:p1', source: 'screen' }), null);
  assert.deepEqual(parse({ t: 'chat', pane: 'default/w1:p1', source: 'screen', entries: [entry({ kind: 'telepathy' }), entry()] }).entries, [entry()]);

  // append/update/older
  assert.equal(parse({ t: 'chat.append', pane: 'default/w1:p1' }), null);
  assert.equal(parse({ t: 'chat.update', entries: [] }), null);
  assert.equal(parse({ t: 'chat.older', pane: 'default/w1:p1', entries: [] }), null);
  assert.equal(parse({ t: 'chat.older', id: 'r1', entries: [] }), null);

  // queue / summaries / subagents / prompt
  assert.equal(parse({ t: 'queue', pane: 'default/w1:p1' }), null);
  assert.equal(parse({ t: 'queue', items: [] }), null);
  assert.equal(parse({ t: 'queue.summary', panes: [{ pane: 'p', pending: 'two', undelivered: 0 }] }).panes.length, 0);
  assert.equal(parse({ t: 'queue.outcomes', pane: 'p' }), null);
  assert.equal(parse({ t: 'subagents', subagents: [] }), null);
  assert.equal(parse({ t: 'prompt', text: 'hi' }), null);
  assert.equal(parse({ t: 'prompt', pane: 'p', text: 12 }), null);

  // replies
  assert.equal(parse({ t: 'pong' }), null);
  assert.equal(parse({ t: 'ok', id: 4 }), null);
  assert.equal(parse({ t: 'error', message: 'x' }), null);
  assert.equal(parse({ t: 'error', code: 'key_not_allowed' }), null);
  assert.equal(parse({ t: 'error', code: 'bad_key', message: 'x' }), null, 'unknown error codes are rejected');
});

test('KEY_RE accepts bridge key combos and rejects unsafe ones', () => {
  for (const key of ['enter', 'ctrl+c', 'shift+tab', 'alt+enter', 'ctrl+shift+up', 'f12', 'f1', 'up', 'esc', 'pageup', 'space', 'y', '7']) {
    assert.equal(isAllowedKey(key), true, `accepts ${key}`);
  }
  for (const key of ['ctrl++', 'y z', 'Y', 'Ctrl+C', '', 'ctrl+meta+x', 'f13', 'arrow up', 'ctrl+c ']) {
    assert.equal(isAllowedKey(key), false, `rejects ${JSON.stringify(key)}`);
  }
});

test('normalizePromptText strips CR, trailing spaces and trailing blank lines', () => {
  assert.equal(normalizePromptText('line one\r\nline two  \r\n\r\n'), 'line one\nline two');
  assert.equal(normalizePromptText('a\t \n b \n\n\n'), 'a\n b');
  assert.equal(normalizePromptText('  leading kept\n'), '  leading kept');
  assert.equal(normalizePromptText(''), '');
});

test('promptRevision is stable across whitespace and bound to terminal, sequence and text', () => {
  const base = promptRevision('term-1', 12, 'Do you want to run this?\n\n  y/n');
  assert.match(base, /^[0-9a-f]{16}$/);
  assert.equal(promptRevision('term-1', 12, 'Do you want to run this?\r\n\r\n  y/n  \r\n\r\n'), base);
  assert.equal(promptRevision('term-1', 12, 'Do you want to run this?\n\n  y/n'), base);
  assert.notEqual(promptRevision('term-2', 12, 'Do you want to run this?\n\n  y/n'), base);
  assert.notEqual(promptRevision('term-1', 13, 'Do you want to run this?\n\n  y/n'), base);
  assert.notEqual(promptRevision('term-1', 12, 'Do you want to run this?\n\n  y/m'), base);
  // Changing only trailing whitespace is not a change.
  assert.equal(promptRevision('term-1', 12, 'x'), promptRevision('term-1', 12, 'x \t \n\n'));
});

test('parseHealth accepts the health body and rejects anything else', () => {
  assert.deepEqual(parseHealth({ ok: true, protocol: PROTOCOL_VERSION, machine: 'mac' }), {
    ok: true,
    protocol: PROTOCOL_VERSION,
    machine: 'mac',
  });
  assert.equal(PROTOCOL_VERSION, 2);
  assert.equal(PROTOCOL_VERSION_3, 3);
  assert.equal(parseHealth({ ok: false, protocol: 2, machine: 'mac' }), null);
  assert.equal(parseHealth({ ok: true, protocol: 2 }), null);
  assert.equal(parseHealth({ ok: true, machine: 'mac' }), null);
  assert.equal(parseHealth({ ok: true, protocol: '2', machine: 'mac' }), null);
  assert.equal(parseHealth(null), null);
  assert.equal(parseHealth([]), null);
  assert.equal(parseHealth('ok'), null);
});

test('promptRevision matches the pinned fixture the bridge must agree with', () => {
  const revision = promptRevision('term_abc', 7, 'Allow Bash?\r\n\r\n❯ 1. Yes\r\n  2. No\r\n\r\n');
  assert.equal(revision, '8f0032dd8be28750');
  assert.equal(promptRevision('term_abc', 8, 'Allow Bash?\n\n❯ 1. Yes\n  2. No'), '80001b408be28750', 'a new change sequence changes the revision');
  assert.equal(promptRevision('term_abd', 7, 'Allow Bash?\n\n❯ 1. Yes\n  2. No'), '794f68a0ab96d0fd', 'a replaced terminal changes the revision');
});
