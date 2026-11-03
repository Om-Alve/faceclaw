const test = require('node:test');
const assert = require('node:assert/strict');
const { reflowTables, stripBoxBorders, renderForGlasses } = require('../.test-build/app/apps/herdr/render.js');
const { layoutReader } = require('../.test-build/app/apps/herdr/reader.js');

// --------------------------------------------------------------- reflowTables

test('reflowTables: header, separator and rows become a vertical list', () => {
  const table = ['| Name | Age | City |', '|------|-----|------|', '| Alice | 30 | NYC |', '| Bob | 25 | LA |'].join('\n');
  assert.equal(reflowTables(table), ['• Alice', '  Age: 30', '  City: NYC', '• Bob', '  Age: 25', '  City: LA'].join('\n'));
});

test('reflowTables: prose around the table is preserved', () => {
  assert.equal(reflowTables(['Here:', '| A | B |', '|---|---|', '| 1 | 2 |', 'Done.'].join('\n')), ['Here:', '• 1', '  B: 2', 'Done.'].join('\n'));
});

test('reflowTables: two tables in one message reflow independently', () => {
  const text = [
    'First:',
    '| K | V |',
    '|---|---|',
    '| a | 1 |',
    '',
    'Second:',
    '| K | V |',
    '|---|---|',
    '| b | 2 |',
  ].join('\n');
  assert.equal(reflowTables(text), ['First:', '• a', '  V: 1', '', 'Second:', '• b', '  V: 2'].join('\n'));
});

test('reflowTables: non-table text passes through untouched', () => {
  const text = ['just a line', 'with | a pipe but no table', '| only one column |', '|-----------------|'].join('\n');
  assert.equal(reflowTables(text), text);
});

test('reflowTables: empty cells are skipped', () => {
  assert.equal(reflowTables(['| K | V | X |', '|---|---|---|', '| a | | z |'].join('\n')), ['• a', '  X: z'].join('\n'));
});

test('reflowTables: a header with no data row is not a table', () => {
  const text = ['| A | B |', '|---|---|'].join('\n');
  assert.equal(reflowTables(text), text);
});

// ------------------------------------------------------------- stripBoxBorders

test('stripBoxBorders: borders go, cell text stays', () => {
  const box = ['╭────────┬────────╮', '│ Name   │ Age    │', '├────────┼────────┤', '│ Alice  │ 30     │', '╰────────┴────────╯'].join('\n');
  assert.equal(stripBoxBorders(box), ['  Name  Age', '  Alice  30'].join('\n'));
});

test('stripBoxBorders: text mixed with a rule keeps the text', () => {
  const text = ['Output:', '─────────', '  all good', '─────────', 'done'].join('\n');
  assert.equal(stripBoxBorders(text), ['Output:', '  all good', 'done'].join('\n'));
});

test('stripBoxBorders: plain text is unchanged', () => {
  const text = ['plain', '  indented', 'a | b'].join('\n');
  assert.equal(stripBoxBorders(text), text);
});

// ----------------------------------------------------------- renderForGlasses

test('renderForGlasses: reflows a table ahead of box stripping', () => {
  assert.equal(renderForGlasses(['| Metric | Value |', '|--------|-------|', '| Latency | 42ms |'].join('\n')), ['• Latency', '  Value: 42ms'].join('\n'));
});

test('renderForGlasses: strips a boxed tool dump', () => {
  const text = ['╭───────╮', '│ ok    │', '│ 200   │', '╰───────╯'].join('\n');
  assert.equal(renderForGlasses(text), ['  ok', '  200'].join('\n'));
});

test('renderForGlasses: is idempotent on reflowed output', () => {
  const once = renderForGlasses(['| Name | Age |', '|------|-----|', '| Alice | 30 |'].join('\n'));
  assert.equal(renderForGlasses(once), once);
});

test('renderForGlasses: prose without tables or boxes is unchanged', () => {
  const text = ['Here is the answer.', '', 'Second paragraph.', '  - a list item'].join('\n');
  assert.equal(renderForGlasses(text), text);
});

// -------------------------------------------------------------------- reader

test('reader: an assistant markdown table lays out as vertical lines', () => {
  const wrap = (text) => text.split('\n');
  const entry = {
    id: 'a1',
    kind: 'assistant',
    text: ['| Name | Age |', '|------|-----|', '| Alice | 30 |'].join('\n'),
  };
  const lines = layoutReader({ entries: [entry], prompt: null, queue: [], wrap });
  assert.deepEqual(
    lines.map((line) => line.text),
    ['• Alice', '  Age: 30'],
  );
  assert.deepEqual(
    lines.map((line) => ({ kind: line.kind, entryId: line.entryId, entryLine: line.entryLine })),
    [
      { kind: 'entry', entryId: 'a1', entryLine: 0 },
      { kind: 'entry', entryId: 'a1', entryLine: 1 },
    ],
  );
});

test('reader: box-drawing output is cleaned for screen entries but tool entries stay one line', () => {
  const wrap = (text) => text.split('\n');
  const lines = layoutReader({
    entries: [
      { id: 'sc1', kind: 'screen', text: ['╭─────╮', '│ ok  │', '╰─────╯'].join('\n') },
      { id: 't1', kind: 'tool', text: ['● boxy │ header', 'second line'].join('\n') },
    ],
    prompt: null,
    queue: [],
    wrap,
  });
  assert.deepEqual(
    lines.map((line) => line.text),
    ['  ok', '', '● ● boxy │ header'],
  );
});

test('reader: the blocked prompt and queue lines are rendered verbatim', () => {
  const wrap = (text) => text.split('\n');
  const lines = layoutReader({
    entries: [],
    prompt: '| A | B |\n|---|---|\n| 1 | 2 |',
    queue: [{ id: 'q1', text: '| C | D |' }],
    wrap,
  });
  assert.deepEqual(
    lines.map((line) => line.text),
    ['PROMPT', '| A | B |', '|---|---|', '| 1 | 2 |', '', '⧗ queued: | C | D |'],
  );
});
