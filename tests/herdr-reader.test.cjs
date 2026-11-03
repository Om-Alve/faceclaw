const test = require('node:test');
const assert = require('node:assert/strict');
const {
  layoutReader,
  anchorAt,
  lineForAnchor,
  resolveScroll,
  scrollFromFirstLine,
  firstUnreadEntryId,
  trimEntries,
  newOutputCount,
  latestActivity,
} = require('../.test-build/app/apps/herdr/reader.js');

const identity = (text) => [text];
const layout = (overrides = {}) => layoutReader({ entries: [], prompt: null, queue: [], wrap: identity, ...overrides });
const texts = (lines) => lines.map((line) => line.text);

const user = (id, text) => ({ id, kind: 'user', text });
const assistant = (id, text) => ({ id, kind: 'assistant', text });
const tool = (id, text) => ({ id, kind: 'tool', text });
const subagent = (id, text) => ({ id, kind: 'subagent', text });

test('layoutReader adds prefixes, indents tools and separates messages', () => {
  const lines = layout({
    hasOlder: true,
    entries: [
      user('u1', 'fix the bug'),
      assistant('a1', 'working'),
      tool('t1', 'npm test -- --watch\nmore output'),
      tool('t2', 'git status'),
      subagent('s1', 'Explore find it'),
      { id: 'q1', kind: 'question', text: 'Which db?', questions: [{ prompt: 'Which database?', options: ['pg'] }], answered: false, reply: 'message' },
      { id: 'sc1', kind: 'screen', text: '  raw screen text  ' },
    ],
  });

  assert.deepEqual(texts(lines), [
    '(scroll up for earlier output)',
    '',
    '',
    '▸ fix the bug',
    '',
    'working',
    '',
    '● npm test -- --watch',
    '● git status',
    '',
    '↳ Explore find it',
    '',
    '? Which database?',
    '',
    'raw screen text',
  ]);

  const byText = (text) => lines.find((line) => line.text === text);
  assert.deepEqual(
    { kind: byText('▸ fix the bug').kind, value: byText('▸ fix the bug').value, entryId: byText('▸ fix the bug').entryId, entryLine: byText('▸ fix the bug').entryLine },
    { kind: 'entry', value: 235, entryId: 'u1', entryLine: 0 },
  );
  const toolLine = byText('● npm test -- --watch');
  assert.equal(toolLine.kind, 'entry');
  assert.equal(toolLine.value, 165);
  assert.equal(toolLine.indent, 6);
  assert.equal(toolLine.entryId, 't1');
  assert.equal(byText('● git status').indent, 6);
  assert.equal(byText('↳ Explore find it').value, 195);
  assert.equal(byText('raw screen text').value, 185);
  assert.equal(byText('(scroll up for earlier output)').kind, 'spacer');
});

test('a wrapped entry keeps one entryId per display line', () => {
  const lines = layout({
    entries: [assistant('a1', 'one two three')],
    wrap: (text) => text.split(' '),
  });
  assert.deepEqual(texts(lines), ['one', 'two', 'three']);
  assert.deepEqual(lines.map((line) => line.entryId), ['a1', 'a1', 'a1']);
  assert.deepEqual(lines.map((line) => line.entryLine), [0, 1, 2]);
});

test('consecutive tool entries collapse into one block without a blank line', () => {
  const lines = layout({
    entries: [assistant('a1', 'start'), tool('t1', 'one'), tool('t2', 'two'), tool('t3', 'three'), assistant('a2', 'end')],
  });
  assert.deepEqual(texts(lines), ['start', '', '● one', '● two', '● three', '', 'end']);
});

test('prompt, queue, durable outcomes and the new marker', () => {
  const lines = layout({
    entries: [assistant('a1', 'done'), assistant('a2', 'more')],
    firstUnreadEntryId: 'a2',
    prompt: 'Allow npm test?',
    queue: [{ id: 'i1', text: 'run it later', ts: 1 }],
    outcomes: [
      { id: 'o1', text: 'was here', ts: 1, outcome: 'undelivered', reason: 'agent session changed' },
      { id: 'o2', text: 'skip me', ts: 2, outcome: 'accepted' },
      { id: 'o3', text: 'not needed', ts: 3, outcome: 'canceled' },
    ],
  });

  assert.deepEqual(texts(lines), [
    'done',
    '',
    '— new —',
    '',
    'more',
    '',
    'PROMPT',
    'Allow npm test?',
    '',
    '⧗ queued: run it later',
    '',
    '✕ not sent: agent session changed — was here',
    '',
    'canceled — not needed',
  ]);

  const marker = lines.find((line) => line.kind === 'marker' && line.text === '— new —');
  assert.ok(marker, 'the new marker is marked for the value');
  assert.equal(marker.value, 220);

  const prompt = lines.find((line) => line.text === 'PROMPT');
  assert.equal(prompt.kind, 'marker');
  assert.equal(prompt.value, 240);

  const promptLine = lines.find((line) => line.text === 'Allow npm test?');
  assert.equal(promptLine.kind, 'prompt');
  assert.equal(promptLine.value, 240);

  const queued = lines.find((line) => line.text === '⧗ queued: run it later');
  assert.equal(queued.kind, 'queue');
  assert.equal(queued.entryId, 'queue:i1');

  const undelivered = lines.find((line) => line.text.startsWith('✕'));
  assert.equal(undelivered.kind, 'outcome');
  assert.equal(undelivered.entryId, 'outcome:o1');
  const canceled = lines.find((line) => line.text.startsWith('canceled'));
  assert.equal(canceled.entryId, 'outcome:o3');
  assert.equal(lines.some((line) => line.text.includes('skip me')), false, 'accepted outcomes are not shown');
});

test('an empty window renders nothing', () => {
  assert.deepEqual(layout(), []);
});

test('anchors keep the same text when entries are appended', () => {
  const entries = [assistant('a', 'first'), assistant('b', 'second'), assistant('c', 'third')];
  const before = layout({ entries });
  const index = before.findIndex((line) => line.entryId === 'b' && line.entryLine === 0);
  assert.ok(index > 0);
  const anchor = anchorAt(before, index);
  assert.deepEqual(anchor, { entryId: 'b', lineOffset: 0 });
  const textBefore = before[resolveScroll(before, anchor, 2)].text;

  const after = layout({ entries: [...entries, assistant('d', 'fourth')] });
  assert.equal(lineForAnchor(after, anchor), index, 'the entry keeps its line index');
  const scrollAfter = resolveScroll(after, anchor, 2);
  assert.equal(after[scrollAfter].text, textBefore);
  assert.equal(after[scrollAfter].text, 'second');
});

test('an anchor on a spacer resolves back to the preceding entry', () => {
  const lines = layout({ entries: [assistant('a', 'first'), assistant('b', 'second')] });
  // Line 1 is the blank line between the two entries.
  const anchor = anchorAt(lines, 1);
  assert.deepEqual(anchor, { entryId: 'a', lineOffset: 1 });
  assert.equal(resolveScroll(lines, anchor, 2), 1);
  assert.equal(lines[1].text, '');
});

test('a missing anchored entry resolves to null', () => {
  const lines = layout({ entries: [assistant('a', 'first')] });
  assert.equal(lineForAnchor(lines, { entryId: 'gone', lineOffset: 0 }), null);
  assert.equal(resolveScroll(lines, { entryId: 'gone', lineOffset: 3 }, 2), null);
  assert.equal(resolveScroll(lines, null, 2), null);
});

test('scrollFromFirstLine returns the live tail at the bottom', () => {
  const lines = layout({ entries: [assistant('a', 'first'), assistant('b', 'second'), assistant('c', 'third')] });
  assert.equal(lines.length, 5);
  // Bottom (firstLine = line count - visible lines) means "follow live".
  assert.deepEqual(scrollFromFirstLine(lines, 3, 2), { anchor: null, firstLine: null });
  assert.deepEqual(scrollFromFirstLine(lines, 4, 2), { anchor: null, firstLine: null });
  // Above the bottom keeps the anchor of the first visible line.
  const kept = scrollFromFirstLine(lines, 2, 2);
  assert.equal(kept.firstLine, 2);
  assert.equal(kept.anchor.entryId, 'b');
  assert.equal(kept.anchor.lineOffset, 0);
});

test('firstUnreadEntryId starts after the last message the wearer sent', () => {
  assert.equal(firstUnreadEntryId([]), null);
  assert.equal(firstUnreadEntryId([assistant('a', 'only')]), 'a');
  assert.equal(firstUnreadEntryId([user('u1', 'one'), assistant('a1', 'two'), user('u2', 'three'), assistant('a2', 'four')]), 'a2');
  assert.equal(firstUnreadEntryId([user('u1', 'one'), assistant('a1', 'two')]), 'a1');
  // A trailing user message has no response yet.
  assert.equal(firstUnreadEntryId([user('u1', 'one'), assistant('a1', 'two'), user('u2', 'three')]), null);
});

test('trimEntries bounds retained history from the oldest end', () => {
  const entries = [assistant('a', '1'), assistant('b', '2'), assistant('c', '3')];
  assert.deepEqual(trimEntries(entries, 2).map((item) => item.id), ['b', 'c']);
  assert.deepEqual(trimEntries(entries, 5).map((item) => item.id), ['a', 'b', 'c']);
  const copy = trimEntries(entries, 5);
  assert.notEqual(copy, entries, 'a copy is returned so callers cannot mutate the window');
  assert.deepEqual(entries.map((item) => item.id), ['a', 'b', 'c']);
});

test('newOutputCount counts lines below an anchor', () => {
  const lines = layout({ entries: [assistant('a', 'first'), assistant('b', 'second'), assistant('c', 'third')] });
  const anchor = { entryId: 'b', lineOffset: 0 };
  assert.equal(newOutputCount(lines, anchor, 1), 2);
  assert.equal(newOutputCount(lines, anchor, 0), 2, 'at least one line is counted as visible');
  assert.equal(newOutputCount(lines, anchor, 3), 0);
  assert.equal(newOutputCount(lines, null, 1), 0);
  assert.equal(newOutputCount(lines, { entryId: 'gone', lineOffset: 0 }, 1), 0);
});

test('latestActivity prefers the newest entry and truncates', () => {
  assert.equal(latestActivity([]), '');
  assert.equal(latestActivity([assistant('a', 'old news'), tool('t', 'npm test\nmore output')]), 'tool: npm test');
  assert.equal(latestActivity([assistant('a', 'kept'), assistant('b', '   ')]), 'kept', 'empty entries are skipped');
  assert.equal(latestActivity([{ id: 'q', kind: 'question', text: 'fallback', questions: [{ prompt: 'Which db?', options: [] }], answered: false, reply: 'message' }]), 'Which db?');
  const long = 'x'.repeat(40);
  const short = latestActivity([assistant('a', long)], 10);
  assert.equal(short.length, 10);
  assert.equal(short, `${'x'.repeat(9)}…`);
  // The prefix counts toward the limit for tool lines.
  assert.equal(latestActivity([tool('t', long)], 10), `tool: ${'x'.repeat(3)}…`);
});

test('scrolling to the very first line keeps a scroll anchor instead of jumping live', () => {
  const lines = layout({ entries: [assistant('a', 'one'), assistant('b', 'two'), assistant('c', 'three')] });
  const anchor = anchorAt(lines, 0);
  assert.ok(anchor, 'line zero anchors to the first entry');
  assert.equal(anchor.entryId, 'a');
  const kept = scrollFromFirstLine(lines, 0, 1);
  assert.equal(kept.firstLine, 0);
  assert.ok(kept.anchor, 'the top of the transcript is a frozen position, not live');
});

test('trimEntries keeps an older anchored entry that scrolled back to', () => {
  const entries = Array.from({ length: 30 }, (_, index) => assistant(`e${index}`, `line ${index}`));
  const trimmed = trimEntries(entries, 10, 'e2');
  assert.ok(trimmed.some((entry) => entry.id === 'e2'), 'the anchored entry and the context above it stay');
  assert.equal(trimmed.at(-1).id, 'e29');
  assert.deepEqual(trimEntries(entries, 10).map((item) => item.id)[0], 'e20');
});
