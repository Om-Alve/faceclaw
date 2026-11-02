const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGlanceSnapshot, glanceSummary, wakeCandidates } = require('../.test-build/app/apps/herdr/glance.js');
const { refKey } = require('../.test-build/app/apps/herdr/model.js');

function pane(id, overrides = {}) {
  return {
    id,
    session: 'default',
    paneId: id.split('/')[1] ?? id,
    workspace: 'faceclaw',
    tab: 'main',
    agent: 'claude',
    status: 'idle',
    title: 'claude',
    chat: 'transcript',
    subagents: 0,
    stateSeq: 1,
    ...overrides,
  };
}

function ref(machineId, machine, overrides = {}) {
  return { machineId, machine, pane: pane(overrides.id ?? `default/${machineId}:p1`, overrides) };
}

function machine(id, label, phase, panes = [], enabled = true) {
  return { id, label, enabled, phase, panes };
}

const NOW = Date.parse('2026-11-02T12:00:00.000Z');

test('rows: connected panes only, needs-you first, with counts and marks', () => {
  const blocked = ref('m1', 'mac', { id: 'default/w1:p1', workspace: 'faceclaw', status: 'blocked' });
  const doneUnseen = ref('m1', 'mac', { id: 'default/w1:p2', workspace: 'api', status: 'done', stateSeq: 4, completionSeq: 9 });
  const working = ref('m1', 'mac', { id: 'default/w1:p3', workspace: 'web', status: 'working' });
  const doneSeen = ref('m1', 'mac', { id: 'default/w1:p4', workspace: 'web', status: 'done', completionSeq: 7 });
  const idleAgent = ref('m1', 'mac', { id: 'default/w1:p5', workspace: 'zzz', status: 'idle' });
  const shell = ref('m1', 'mac', { id: 'default/w1:p6', workspace: 'scratch', status: 'unknown', agent: null, title: 'zsh', focused: true });
  const miniWorking = ref('m2', 'mini', { id: 'default/w2:p1', workspace: 'other', status: 'working' });

  const markers = { [refKey(doneSeen)]: 7 };
  const queueCounts = new Map([[refKey(blocked), 2]]);
  const snapshot = buildGlanceSnapshot(
    [machine('m1', 'mac', 'connected', [blocked, doneUnseen, working, doneSeen, idleAgent, shell]),
     machine('m2', 'mini', 'connected', [miniWorking])],
    markers,
    queueCounts,
  );

  assert.deepEqual(snapshot.rows.map((row) => row.key), [
    refKey(blocked),
    refKey(doneUnseen),
    refKey(working),
    refKey(miniWorking),
    refKey(doneSeen),
    refKey(idleAgent),
    refKey(shell),
  ]);
  assert.deepEqual(snapshot.rows.map((row) => row.status), ['blocked', 'done', 'working', 'working', 'done', 'idle', 'unknown']);
  assert.equal(snapshot.needsYou, 2, 'blocked plus done-unseen');
  assert.equal(snapshot.working, 2);
  assert.equal(snapshot.more, 0);
  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.status, '');

  const row = (key) => snapshot.rows.find((item) => item.key === key);
  assert.equal(row(refKey(blocked)).queued, 2);
  assert.equal(row(refKey(doneUnseen)).queued, 0);
  assert.equal(row(refKey(doneUnseen)).unread, true);
  assert.equal(row(refKey(doneSeen)).unread, false);
  assert.equal(row(refKey(shell)).focused, true);
  assert.equal(row(refKey(blocked)).focused, false);
  assert.equal(row(refKey(blocked)).title, 'mac/faceclaw · claude');
  assert.equal(row(refKey(shell)).title, 'mac/scratch · zsh');
  assert.equal(row(refKey(miniWorking)).title, 'mini/other · claude');

  // It crosses postMessage: plain JSON only.
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
});

test('disconnected machines contribute no rows or counts', () => {
  const connected = ref('m1', 'mac', { id: 'default/w1:p1', status: 'working' });
  const hidden = ref('m2', 'mini', { id: 'default/w2:p1', status: 'blocked' });
  const snapshot = buildGlanceSnapshot(
    [machine('m1', 'mac', 'connected', [connected]), machine('m2', 'mini', 'connecting', [hidden])],
    {},
  );
  assert.deepEqual(snapshot.rows.map((row) => row.key), [refKey(connected)]);
  assert.equal(snapshot.needsYou, 0);
  assert.equal(snapshot.working, 1);
  assert.equal(snapshot.status, '', 'one connected machine is enough');
  // The machine count still drives the multi-machine title prefix.
  assert.equal(snapshot.rows[0].title, 'mac/faceclaw · claude');
});

test('caps rows and counts the rest', () => {
  const panes = Array.from({ length: 30 }, (_, index) => ref('m1', 'mac', {
    id: `default/w${index}:p1`,
    workspace: `ws-${String(index).padStart(2, '0')}`,
    status: 'idle',
  }));
  const snapshot = buildGlanceSnapshot([machine('m1', 'mac', 'connected', panes)], {});
  assert.equal(snapshot.rows.length, 24);
  assert.equal(snapshot.more, 6);
  assert.equal(snapshot.needsYou, 0);
  assert.equal(snapshot.working, 0);
});

test('configured and status for every machine state', () => {
  assert.deepEqual(buildGlanceSnapshot([], {}), {
    configured: false,
    status: '',
    needsYou: 0,
    working: 0,
    rows: [],
    more: 0,
  });
  assert.deepEqual(buildGlanceSnapshot([], {}, new Map()), buildGlanceSnapshot([], {}));

  const status = (machines) => buildGlanceSnapshot(machines, {}).status;
  assert.equal(status([machine('m1', 'mac', 'idle', [], false)]), 'Disconnected');
  assert.equal(status([machine('m1', 'mac', 'forbidden', [], false)]), 'Disconnected', 'disabled wins over phase');
  assert.equal(status([machine('m1', 'mac', 'connecting')]), 'Connecting…');
  assert.equal(status([machine('m1', 'mac', 'retrying')]), 'Connecting…');
  assert.equal(status([machine('m1', 'mac', 'forbidden')]), 'Bridge refused this phone');
  assert.equal(status([machine('m1', 'mac', 'forbidden'), machine('m2', 'mini', 'forbidden')]), 'Bridge refused this phone');
  assert.equal(status([machine('m1', 'mac', 'idle')]), "Can't reach the bridge");
  assert.equal(status([machine('m1', 'mac', 'unreachable')]), "Can't reach the bridge");
  assert.equal(status([machine('m1', 'mac', 'forbidden'), machine('m2', 'mini', 'retrying')]), 'Connecting…', 'one retrying machine means connecting');
  assert.equal(status([machine('m1', 'mac', 'retrying'), machine('m2', 'mini', 'connected')]), '');
  assert.equal(buildGlanceSnapshot([machine('m1', 'mac', 'connecting')], {}).configured, true);
});

test('glanceSummary is empty or names needs-you and working', () => {
  assert.equal(glanceSummary({ needsYou: 0, working: 0 }), '');
  assert.equal(glanceSummary({ needsYou: 1, working: 1 }), '1 needs you · 1 working');
  assert.equal(glanceSummary({ needsYou: 2, working: 3 }), '2 need you · 3 working');
  assert.equal(glanceSummary({ needsYou: 0, working: 2 }), '2 working');
  assert.equal(glanceSummary({ needsYou: 3, working: 0 }), '3 need you');
});

test('wakeCandidates excludes focused panes and sorts deterministically', () => {
  const focused = ref('m1', 'mac', { id: 'default/w1:p1', workspace: 'alpha', status: 'blocked', focused: true });
  const working = ref('m1', 'mac', { id: 'default/w1:p3', workspace: 'alpha', status: 'working' });
  const blocked2 = ref('m1', 'mac', { id: 'default/w1:p2', workspace: 'alpha', status: 'blocked' });
  const blocked10 = ref('m1', 'mac', { id: 'default/w1:p10', workspace: 'alpha', status: 'blocked' });
  const beta = ref('m1', 'mac', { id: 'default/w1:p2', workspace: 'beta', status: 'blocked' });
  const mini = ref('m2', 'mini', { id: 'default/w2:p10', workspace: 'beta', status: 'blocked' });

  const input = [mini, beta, focused, working, blocked10, blocked2];
  const wakes = wakeCandidates(input);
  assert.deepEqual(
    wakes.map((item) => `${item.machineId}|${item.pane.workspace}|${item.pane.id}`),
    ['m1|alpha|default/w1:p2', 'm1|alpha|default/w1:p10', 'm1|beta|default/w1:p2', 'm2|beta|default/w2:p10'],
  );
  assert.equal(wakes.some((item) => item === focused), false);
  assert.equal(input.length, 6, 'the input is not mutated');
});
