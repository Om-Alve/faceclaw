const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../.test-build/app/apps/herdr/model.js');

function pane(overrides = {}) {
  return {
    id: 'default/w1:p1',
    session: 'default',
    paneId: 'w1:p1',
    workspace: 'faceclaw',
    tab: 'main',
    agent: 'claude',
    status: 'idle',
    title: 'claude',
    chat: 'transcript',
    subagents: 0,
    stateSeq: 10,
    ...overrides,
  };
}

function ref(machineId, machine, overrides = {}) {
  return { machineId, machine, pane: pane(overrides) };
}

test('paneKey, refKey and fullPaneKey include what identifies the view', () => {
  assert.equal(model.paneKey('m1', 'default/w1:p1'), 'm1|default/w1:p1');
  const base = ref('m1', 'mac');
  assert.equal(model.refKey(base), 'm1|default/w1:p1');
  assert.equal(model.fullPaneKey(base), 'm1|default/w1:p1||');
  const identified = ref('m1', 'mac', { terminalId: 'term-1', agentSession: { kind: 'claude', value: 'session-9' } });
  assert.equal(model.fullPaneKey(identified), 'm1|default/w1:p1|term-1|session-9');
  // A reused pane id behind a new terminal is a different full identity.
  assert.notEqual(model.fullPaneKey(identified), model.fullPaneKey(ref('m1', 'mac', { terminalId: 'term-2' })));
});

test('completionIdentity prefers protocol 3 completionSeq over stateSeq', () => {
  assert.equal(model.completionIdentity(pane({ stateSeq: 4 })), 4);
  assert.equal(model.completionIdentity(pane({ stateSeq: 4, completionSeq: 9 })), 9);
});

test('urgency: blocked, done-unseen, working, idle agent, shell', () => {
  const markers = {};
  const blocked = ref('m1', 'mac', { id: 'blocked', workspace: 'a', status: 'blocked' });
  const doneUnseen = ref('m1', 'mac', { id: 'done', workspace: 'b', status: 'done', stateSeq: 5 });
  const working = ref('m1', 'mac', { id: 'working', workspace: 'c', status: 'working' });
  const idleAgent = ref('m1', 'mac', { id: 'idle', workspace: 'd', status: 'idle' });
  const shell = ref('m1', 'mac', { id: 'shell', workspace: 'e', agent: null, status: 'unknown' });

  assert.equal(model.urgency(blocked, markers), 0);
  assert.equal(model.urgency(doneUnseen, markers), 1);
  assert.equal(model.urgency(working, markers), 2);
  assert.equal(model.urgency(idleAgent, markers), 3);
  assert.equal(model.urgency(shell, markers), 4);

  // A seen done agent falls back to the idle-agent tier.
  const seen = { [model.refKey(doneUnseen)]: 5 };
  assert.equal(model.isDoneUnseen(doneUnseen, seen), false);
  assert.equal(model.urgency(doneUnseen, seen), 3);

  const sorted = model.sortPanes([shell, idleAgent, working, doneUnseen, blocked], markers);
  assert.deepEqual(sorted.map((item) => item.pane.id), ['blocked', 'done', 'working', 'idle', 'shell']);
});

test('sortPanes is stable and deterministic across machines and workspaces', () => {
  const refs = [
    ref('m2', 'mini', { id: 'b2', workspace: 'beta', status: 'working' }),
    ref('m1', 'mac', { id: 'a2', workspace: 'beta', status: 'working' }),
    ref('m1', 'mac', { id: 'a1', workspace: 'alpha', status: 'working' }),
    ref('m1', 'mac', { id: 'a10', workspace: 'alpha', status: 'working', tab: 'z' }),
    ref('m1', 'mac', { id: 'a3', workspace: 'alpha', status: 'working', tab: 'a' }),
  ];
  const sorted = model.sortPanes(refs, {});
  assert.deepEqual(sorted.map((item) => item.pane.id), ['a3', 'a1', 'a10', 'a2', 'b2']);
});

test('groupWorkspaces rolls up its most urgent pane and counts working and subagents', () => {
  const refs = [
    ref('m1', 'mac', { id: 'default/w1:p1', workspace: 'faceclaw', status: 'working', subagents: 2 }),
    ref('m1', 'mac', { id: 'default/w1:p2', workspace: 'faceclaw', status: 'blocked', subagents: 1, tab: 'other' }),
    ref('m1', 'mac', { id: 'default/w2:p1', workspace: 'website', status: 'working', stateSeq: 2 }),
  ];
  const groups = model.groupWorkspaces(refs, {});
  assert.equal(groups.length, 2);
  const [first, second] = groups;
  assert.equal(first.workspace, 'faceclaw');
  assert.equal(first.key, 'm1|default|faceclaw');
  assert.equal(first.session, 'default');
  assert.equal(first.refs.length, 2);
  assert.equal(first.top.pane.id, 'default/w1:p2');
  assert.equal(first.urgency, 0);
  assert.equal(first.subagents, 3);
  assert.equal(second.workspace, 'website');
  assert.equal(second.urgency, 2);
  assert.equal(second.subagents, 0);
});

test('row labels: pane, workspace and workspace-pane rows', () => {
  const working = ref('m1', 'mac', { workspace: 'faceclaw', agent: 'claude', status: 'working', subagents: 2 });
  assert.equal(model.rowLabel(working, false), 'faceclaw · claude · WORKING · 2 sub');
  assert.equal(model.rowLabel(working, true), 'mac/faceclaw · claude · WORKING · 2 sub');
  assert.equal(model.rowLabel(working, true, false), 'mac/faceclaw · claude');

  const shell = ref('m1', 'mac', { workspace: 'scratch', agent: null, title: 'zsh', status: 'unknown' });
  assert.equal(model.rowLabel(shell, false), 'scratch · zsh');
  assert.equal(model.paneRowLabel(shell), 'zsh');

  const group = model.groupWorkspaces([
    ref('m1', 'mac', { id: 'default/w1:p1', workspace: 'faceclaw', status: 'working' }),
    ref('m1', 'mac', { id: 'default/w1:p2', workspace: 'faceclaw', status: 'idle', subagents: 2 }),
  ], {})[0];
  assert.equal(model.workspaceRowLabel(group, false), 'faceclaw · WORKING · 2 panes · 1 working · 2 sub');
  assert.equal(model.workspaceRowLabel(group, true), 'mac/faceclaw · WORKING · 2 panes · 1 working · 2 sub');
  assert.equal(model.rollupLabel(group), 'WORKING');

  const single = model.groupWorkspaces([ref('m1', 'mac', { workspace: 'solo', agent: null, status: 'unknown' })], {})[0];
  assert.equal(model.workspaceRowLabel(single, false), 'solo · 1 pane');
});

test('buildHub puts needs-you panes before workspaces and keeps both', () => {
  const refs = [
    ref('m1', 'mac', { id: 'default/w1:p1', workspace: 'faceclaw', status: 'blocked' }),
    ref('m1', 'mac', { id: 'default/w1:p2', workspace: 'faceclaw', status: 'working' }),
    ref('m1', 'mac', { id: 'default/w2:p1', workspace: 'website', status: 'done', stateSeq: 3 }),
    ref('m1', 'mac', { id: 'default/w3:p1', workspace: 'scratch', status: 'idle' }),
  ];
  const hub = model.buildHub(refs, {}, false);
  assert.equal(model.needingCount(hub), 2);
  assert.deepEqual(hub.needsYou.map((item) => item.pane.id), ['default/w1:p1', 'default/w2:p1']);

  const kinds = hub.rows.map((row) => row.kind);
  assert.deepEqual(kinds, ['heading', 'pane', 'pane', 'heading', 'workspace', 'workspace', 'workspace']);
  assert.equal(hub.rows[0].label, 'Needs you');
  assert.equal(hub.rows[1].key, 'needs:m1|default/w1:p1');
  assert.equal(hub.rows[3].label, 'Workspaces');
  assert.equal(hub.rows[4].key, `ws:${hub.groups[0].key}`);
  assert.equal(hub.groups.length, 3, 'need-you panes also appear under their workspace');
  // Every needs-you pane is a member of a group too.
  for (const need of hub.needsYou) {
    assert.ok(hub.groups.some((group) => group.refs.includes(need)));
  }

  const empty = model.buildHub([], {}, false);
  assert.deepEqual(empty.rows, [{ kind: 'tag', key: 'empty', label: 'No panes yet' }]);
  assert.deepEqual(empty.needsYou, []);

  const onlyNeedsYou = model.buildHub([ref('m1', 'mac', { status: 'blocked' })], {}, false);
  assert.deepEqual(onlyNeedsYou.rows.map((row) => row.kind), ['heading', 'pane', 'heading', 'workspace']);
});

test('markRead clears only the matching completion identity', () => {
  const a = ref('m1', 'mac', { id: 'a', status: 'done', stateSeq: 3, completionSeq: 7 });
  const b = ref('m2', 'mini', { id: 'b', status: 'done', stateSeq: 4 });
  const markers = { [model.refKey(a)]: 1, [model.refKey(b)]: 4 };
  const next = model.markRead(markers, a);
  assert.equal(next[model.refKey(a)], 7);
  assert.equal(next[model.refKey(b)], 4, 'the other machine pane is untouched');
  assert.equal(markers[model.refKey(a)], 1, 'the input map is not mutated');
  assert.equal(model.isDoneUnseen(a, next), false);
  // Marking an already-read pane returns the same map.
  assert.equal(model.markRead(next, a), next);
});

test('pruneReadMarkers drops gone panes and keeps the newest bounded slice', () => {
  const live = [ref('m1', 'mac', { id: 'a' }), ref('m1', 'mac', { id: 'b' })];
  const markers = {
    'm1|gone': 9,
    [model.refKey(live[0])]: 1,
    [model.refKey(live[1])]: 2,
  };
  const pruned = model.pruneReadMarkers(markers, live);
  assert.deepEqual(pruned, { [model.refKey(live[0])]: 1, [model.refKey(live[1])]: 2 });

  const many = {};
  for (let index = 0; index < 10; index++) many[`m1|p${index}`] = index;
  const refs = Object.keys(many).map((key) => ref('m1', 'mac', { id: key.slice(3) }));
  const bounded = model.pruneReadMarkers(many, refs, 3);
  assert.deepEqual(Object.keys(bounded), ['m1|p7', 'm1|p8', 'm1|p9']);
  assert.deepEqual(Object.values(bounded), [7, 8, 9]);
});

test('draftTarget captures the pane, terminal, session and prompt revision', () => {
  const targetRef = ref('m1', 'mac', {
    id: 'default/w1:p1',
    terminalId: 'term-1',
    agentSession: { kind: 'claude', value: 'session-1' },
  });
  assert.deepEqual(model.draftTarget(targetRef), {
    machineId: 'm1',
    machine: 'mac',
    paneId: 'default/w1:p1',
    terminalId: 'term-1',
    agentSession: { kind: 'claude', value: 'session-1' },
    promptRevision: undefined,
    promptText: undefined,
  });
  assert.deepEqual(model.draftTarget(targetRef, { text: 'Allow?', revision: 'abc123' }), {
    machineId: 'm1',
    machine: 'mac',
    paneId: 'default/w1:p1',
    terminalId: 'term-1',
    agentSession: { kind: 'claude', value: 'session-1' },
    promptRevision: 'abc123',
    promptText: 'Allow?',
  });
  // A ref without protocol 3 identity still works.
  const plain = model.draftTarget(ref('m1', 'mac'));
  assert.equal(plain.terminalId, undefined);
  assert.equal(plain.agentSession, null);
});

test('validateDraft reports every reason the send can no longer be trusted', () => {
  const current = ref('m1', 'mac', {
    terminalId: 'term-1',
    agentSession: { kind: 'claude', value: 'session-1' },
  });
  const draft = { target: model.draftTarget(current, { text: 'Allow?', revision: 'rev-1' }), text: 'yes' };

  assert.equal(model.validateDraft(draft, current, false), 'offline');
  assert.equal(model.validateDraft(draft, undefined, true), 'pane_gone');
  assert.equal(model.validateDraft(draft, ref('m2', 'mini', { terminalId: 'term-1', agentSession: { kind: 'claude', value: 'session-1' } }), true), 'pane_gone');
  assert.equal(model.validateDraft(draft, ref('m1', 'mac', { id: 'default/w9:p9', terminalId: 'term-1' }), true), 'pane_gone');
  assert.equal(model.validateDraft(draft, ref('m1', 'mac', { terminalId: 'term-2', agentSession: { kind: 'claude', value: 'session-1' } }), true), 'terminal_changed');
  assert.equal(model.validateDraft(draft, ref('m1', 'mac', { terminalId: 'term-1', agentSession: { kind: 'claude', value: 'session-2' } }), true), 'session_changed');

  // Prompt revision is checked only when a live prompt text is supplied.
  assert.equal(model.validateDraft(draft, current, true, 'Deny?'), 'prompt_changed');
  assert.equal(model.validateDraft(draft, current, true, 'Allow?'), null);
  assert.equal(model.validateDraft(draft, current, true, 'Allow?\r\n  '), null, 'whitespace-only differences are not a change');
  assert.equal(model.validateDraft(draft, current, true), null);
  assert.equal(model.validateDraft(draft, current, true, null), null);

  // Protocol 2 drafts carry no terminal or prompt revision: only liveness and identity apply.
  const v2Ref = ref('m1', 'mac');
  const v2Draft = { target: model.draftTarget(v2Ref), text: 'hello' };
  assert.equal(model.validateDraft(v2Draft, v2Ref, true), null);
  assert.equal(model.validateDraft(v2Draft, v2Ref, true, 'anything'), null);
});

test('primaryAction, writeMode, canQueue and sendNowLabel', () => {
  const blocked = pane({ status: 'blocked' });
  const agentIdle = pane({ status: 'idle' });
  const agentWorking = pane({ status: 'working' });
  const shell = pane({ agent: null, title: 'zsh', status: 'unknown' });

  assert.equal(model.primaryAction(undefined, false), 'read');
  assert.equal(model.primaryAction(blocked, true), 'read');
  assert.equal(model.primaryAction(blocked, false), 'answer');
  assert.equal(model.primaryAction(agentIdle, false), 'compose');
  assert.equal(model.primaryAction(shell, false), 'command');

  assert.equal(model.writeMode(agentIdle, 'type'), 'literal');
  assert.equal(model.writeMode(agentIdle, 'command'), 'input');
  assert.equal(model.writeMode(agentIdle, 'message'), 'prompt');
  assert.equal(model.writeMode(shell, 'message'), 'input');
  assert.equal(model.writeMode(undefined, 'message'), 'input');

  assert.equal(model.canQueue(agentWorking, false), true);
  assert.equal(model.canQueue(agentIdle, false), true);
  assert.equal(model.canQueue(blocked, false), false);
  assert.equal(model.canQueue(shell, false), false);
  assert.equal(model.canQueue(agentWorking, true), false);
  assert.equal(model.canQueue(undefined, false), false);

  assert.equal(model.sendNowLabel(shell), 'Run now');
  assert.equal(model.sendNowLabel(undefined), 'Run now');
  assert.equal(model.sendNowLabel(agentWorking), 'Send now (mid-turn)');
  assert.equal(model.sendNowLabel(agentIdle), 'Send message');
  assert.equal(model.sendNowLabel(blocked), 'Send message');
});

test('parseBridgeUrl normalizes every suggested URL form', () => {
  const expected = (baseUrl, wsUrl, host) => ({ baseUrl, wsUrl, host });
  assert.deepEqual(
    model.parseBridgeUrl('https://mac.tailnet.ts.net'),
    expected('https://mac.tailnet.ts.net', 'wss://mac.tailnet.ts.net/ws', 'mac.tailnet.ts.net'),
  );
  assert.deepEqual(
    model.parseBridgeUrl('https://mac.tailnet.ts.net/'),
    expected('https://mac.tailnet.ts.net', 'wss://mac.tailnet.ts.net/ws', 'mac.tailnet.ts.net'),
  );
  assert.deepEqual(
    model.parseBridgeUrl('  https://mac.tailnet.ts.net/ws  '),
    expected('https://mac.tailnet.ts.net', 'wss://mac.tailnet.ts.net/ws', 'mac.tailnet.ts.net'),
  );
  assert.deepEqual(
    model.parseBridgeUrl('wss://mac.tailnet.ts.net/ws'),
    expected('https://mac.tailnet.ts.net', 'wss://mac.tailnet.ts.net/ws', 'mac.tailnet.ts.net'),
  );
  assert.deepEqual(
    model.parseBridgeUrl('ws://mac.tailnet.ts.net/ws'),
    expected('http://mac.tailnet.ts.net', 'ws://mac.tailnet.ts.net/ws', 'mac.tailnet.ts.net'),
  );
  assert.deepEqual(model.parseBridgeUrl('mac.tailnet.ts.net'), expected('https://mac.tailnet.ts.net', 'wss://mac.tailnet.ts.net/ws', 'mac.tailnet.ts.net'));
  assert.deepEqual(model.parseBridgeUrl('http://localhost:8787'), expected('http://localhost:8787', 'ws://localhost:8787/ws', 'localhost:8787'));
  assert.deepEqual(model.parseBridgeUrl('herdr://mini'), expected('https://mini', 'wss://mini/ws', 'mini'));
  assert.deepEqual(model.parseBridgeUrl('HTTPS://Mac.Tailnet.ts.net'), expected('https://mac.tailnet.ts.net', 'wss://mac.tailnet.ts.net/ws', 'mac.tailnet.ts.net'));
});

test('parseBridgeUrl rejects credentials, spaces, bad ports and unknown paths', () => {
  for (const input of [
    '',
    '   ',
    'https://user:pass@mac.tailnet.ts.net',
    'https://user@mac.tailnet.ts.net',
    'https://mac tailnet.ts.net',
    'https://mac.tailnet.ts.net:99999',
    'https://mac.tailnet.ts.net:0',
    'https://mac.tailnet.ts.net:abc',
    'https://mac.tailnet.ts.net/api',
    'https://mac.tailnet.ts.net/api/ws',
    'ftp://mac.tailnet.ts.net',
    'mailto:someone@example.com',
    'https://',
  ]) {
    assert.equal(model.parseBridgeUrl(input), null, `rejects ${JSON.stringify(input)}`);
  }
});

test('machineIdForUrl is a stable URL-derived id', () => {
  const id = (url) => model.machineIdForUrl(model.parseBridgeUrl(url));
  assert.equal(id('https://mac.tailnet.ts.net'), 'herdr-mac-tailnet-ts-net');
  assert.equal(id('wss://mac.tailnet.ts.net/ws'), 'herdr-mac-tailnet-ts-net');
  assert.equal(id('http://localhost:8787'), 'herdr-localhost-8787');
  assert.equal(id('https://192.168.1.20'), 'herdr-192-168-1-20');
});

test('urlFromQrPayload reads a plain URL or a JSON envelope', () => {
  assert.equal(model.urlFromQrPayload('https://mac.tailnet.ts.net'), 'https://mac.tailnet.ts.net');
  assert.equal(model.urlFromQrPayload('  https://mac.tailnet.ts.net  '), 'https://mac.tailnet.ts.net');
  assert.equal(model.urlFromQrPayload('host:8787'), 'host:8787');
  assert.equal(model.urlFromQrPayload('{"url":"https://mac.tailnet.ts.net"}'), 'https://mac.tailnet.ts.net');
  assert.equal(model.urlFromQrPayload('{"bridge":"https://mini.tailnet.ts.net"}'), 'https://mini.tailnet.ts.net');
  assert.equal(model.urlFromQrPayload('{"ws":"wss://mini/ws"}'), 'wss://mini/ws');
  assert.equal(model.urlFromQrPayload('{"origin":"https://mini"}'), 'https://mini');
  // The first known field that parses wins; bad values fall through.
  assert.equal(model.urlFromQrPayload('{"url":"not a url","ws":"wss://mini/ws"}'), 'wss://mini/ws');
  assert.equal(model.urlFromQrPayload('{"url":"not a url"}'), null);
  assert.equal(model.urlFromQrPayload('{"nope":1}'), null);
  assert.equal(model.urlFromQrPayload('{oops'), null);
  assert.equal(model.urlFromQrPayload(''), null);
  assert.equal(model.urlFromQrPayload('not a url'), null);
});

test('duplicateMachineIds keeps the first record per reported machine', () => {
  const reported = new Map([
    ['a', 'mac'],
    ['b', 'mac'],
    ['c', 'mini'],
    ['d', 'mini'],
    ['e', 'other'],
  ]);
  assert.deepEqual(model.duplicateMachineIds(['a', 'b', 'c', 'd', 'e'], reported), ['b', 'd']);
  assert.deepEqual(model.duplicateMachineIds(['b', 'a'], reported), ['a'], 'first in order wins');
  assert.deepEqual(model.duplicateMachineIds(['a', 'c', 'e'], reported), []);
  assert.deepEqual(model.duplicateMachineIds(['x', 'y'], new Map()), [], 'unknown ids are not duplicates');
});

test('cleanEntries drops empty and Happy-skipped records and normalizes text', () => {
  const entries = [
    { kind: 'assistant', id: '1', text: 'ok' },
    { kind: 'assistant', id: '2', text: '   ' },
    { kind: 'system', id: '3', text: '{"type":"file-history-snapshot"}' },
    { kind: 'system', id: '4', text: '{"type":"change","x":1}' },
    { kind: 'system', id: '5', text: '{"type":"queue-operation"}' },
    { kind: 'system', id: '6', text: '{"type":"summary","text":"kept"}' },
    { kind: 'assistant', id: '7', text: 'line\r\nnext  ' },
    // Only system records are checked against the skip list.
    { kind: 'assistant', id: '8', text: '{"type":"change"}' },
  ];
  const cleaned = model.cleanEntries(entries);
  assert.deepEqual(cleaned.map((item) => item.id), ['1', '6', '7', '8']);
  assert.equal(cleaned[2].text, 'line\nnext');
  assert.equal(cleaned[0], entries[0], 'unchanged entries keep their identity');
  assert.notEqual(cleaned[2], entries[6], 'changed text is a new object');
});

test('mergeUpdatedEntries replaces known ids, appends new ones and preserves order', () => {
  const entries = [
    { id: 'a', text: 'old a' },
    { id: 'b', text: 'b' },
  ];
  const merged = model.mergeUpdatedEntries(entries, [
    { id: 'a', text: 'new a' },
    { id: 'c', text: 'c' },
  ]);
  assert.deepEqual(merged, [
    { id: 'a', text: 'new a' },
    { id: 'b', text: 'b' },
    { id: 'c', text: 'c' },
  ]);
  assert.deepEqual(entries, [{ id: 'a', text: 'old a' }, { id: 'b', text: 'b' }], 'input is not mutated');

  // No matching updates returns an equal copy, not the same array.
  const unchanged = model.mergeUpdatedEntries(entries, []);
  assert.deepEqual(unchanged, entries);
  assert.notEqual(unchanged, entries);
});

test('queueSummaryText names only what is there', () => {
  assert.equal(model.queueSummaryText(undefined), '');
  assert.equal(model.queueSummaryText({ pane: 'p', pending: 0, undelivered: 0 }), '');
  assert.equal(model.queueSummaryText({ pane: 'p', pending: 2, undelivered: 1 }), '2 queued · 1 undelivered');
  assert.equal(model.queueSummaryText({ pane: 'p', pending: 0, undelivered: 3 }), '3 undelivered');
  assert.equal(model.queueSummaryText({ pane: 'p', pending: 1, undelivered: 0 }), '1 queued');
});

test('formatAge rounds to the units the glasses show', () => {
  const now = Date.parse('2026-11-02T12:00:00.000Z');
  assert.equal(model.formatAge(undefined, now), '');
  assert.equal(model.formatAge(0, now), '');
  assert.equal(model.formatAge(now - 20_000, now), 'now');
  assert.equal(model.formatAge(now - 44_000, now), 'now');
  assert.equal(model.formatAge(now - 45_000, now), '1m');
  assert.equal(model.formatAge(now - 5 * 60_000, now), '5m');
  assert.equal(model.formatAge(now - 3 * 3_600_000, now), '3h');
  assert.equal(model.formatAge(now - 2 * 86_400_000, now), '2d');
  assert.equal(model.formatAge(now + 60_000, now), 'now', 'clock skew clamps to now');
});

test('tailLines keeps the newest lines', () => {
  assert.deepEqual(model.tailLines('a\nb\nc', 5), ['a', 'b', 'c']);
  assert.deepEqual(model.tailLines('a\nb\nc', 3), ['a', 'b', 'c']);
  assert.deepEqual(model.tailLines('a\nb\nc\nd', 2), ['c', 'd']);
  assert.deepEqual(model.tailLines('only', 1), ['only']);
});

test('read markers follow the terminal, not the reused pane slot', () => {
  const first = ref('m1', 'mac', { status: 'done', stateSeq: 11, terminalId: 'term-1' });
  const marked = model.markRead({}, first);
  assert.equal(model.isDoneUnseen(first, marked), false);
  const replaced = ref('m1', 'mac', { status: 'done', stateSeq: 11, terminalId: 'term-2' });
  assert.equal(model.isDoneUnseen(replaced, marked), true, 'a replaced terminal starts unread');
  assert.equal(model.readKey(first), 'm1|default/w1:p1|term-1');
  assert.equal(model.readKey(ref('m1', 'mac')), 'm1|default/w1:p1', 'protocol 2 keeps the old key shape');
});

test('question choices are offered only when one question is on screen', () => {
  const question = (questions, answered = false) => ({ id: 'q1', kind: 'question', text: '', questions, answered, reply: 'message' });
  assert.deepEqual(
    model.questionChoices([question([{ prompt: 'db', options: ['Postgres', 'MySQL'] }])]),
    [{ label: 'Postgres', keys: ['1'] }, { label: 'MySQL', keys: ['2'] }],
  );
  assert.deepEqual(
    model.questionChoices([question([{ prompt: 'db', options: ['Postgres'] }, { prompt: 'schema', options: ['Existing', 'Fresh'] }])]),
    [],
    'two questions would make the same numbers answer the first one',
  );
  assert.deepEqual(model.questionChoices([question([{ prompt: 'db', options: ['Postgres'] }], true)]), [], 'answered questions are skipped');
});
