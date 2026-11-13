const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseMenu,
  classifyMenu,
  isCodexApprovalScreen,
  answerChoices,
} = require('../.test-build/app/apps/herdr/prompt.js');
const { isAllowedKey } = require('../.test-build/app/apps/herdr/protocol.js');

// Screens captured from the real TUIs. The highlighted option carries the
// agent's selection marker: `❯` for Claude, `›` for Codex.

const claudeTrust = [
  ' Do you trust the files in this folder?',
  ' ❯ 1. Yes, proceed',
  '   2. No, exit',
].join('\n');

const claudeWrite = [
  ' Do you want to create note.txt?',
  ' ❯ 1. Yes',
  '   2. Yes, allow all edits during this session (shift+tab)',
  '   3. No',
].join('\n');

// Codex marks the highlighted option with `›`; before the marker was handled a
// 3-option approval mis-parsed into a 2-option "question".
const codexTrust = ['› 1. Yes, continue', '  2. No, quit'].join('\n');

const codexExec = [
  '  Would you like to run the following command?',
  '  $ touch approve-me.txt',
  '› 1. Yes, proceed (y)',
  "  2. Yes, and don't ask again for commands that start with `touch approve-me.txt` (p)",
  '  3. No, and tell Codex what to do differently (esc)',
].join('\n');

const codexPatch = [
  '  Would you like to make the following edits?',
  '› 1. Yes, proceed (y)',
  '  2. Yes, and don\'t ask again for these files (a)',
  '  3. No, and tell Codex what to do differently (esc)',
].join('\n');

const codexFooter = '  Press enter to confirm or esc to cancel';

// ------------------------------------------------------------------ parseMenu

test('parseMenu: Claude trust prompt is a 2-option menu', () => {
  const menu = parseMenu(claudeTrust);
  assert.equal(menu.options.length, 2);
  assert.deepEqual(menu.options[0], { digit: '1', label: 'Yes, proceed' });
  assert.equal(menu.marker, '❯');
});

test('parseMenu: Claude Write approval parses all 3 options with the ❯ marker', () => {
  const menu = parseMenu(claudeWrite);
  assert.equal(menu.options.length, 3);
  assert.deepEqual(
    menu.options.map((option) => option.digit),
    ['1', '2', '3'],
  );
  assert.equal(menu.marker, '❯');
});

test('parseMenu: Codex trust prompt keeps the ›-marked first option', () => {
  const menu = parseMenu(codexTrust);
  assert.equal(menu.options.length, 2);
  assert.equal(menu.options[0].digit, '1');
  assert.equal(menu.marker, '›');
});

test('parseMenu: Codex exec approval is 3 options, not 2', () => {
  const menu = parseMenu(codexExec);
  assert.equal(menu.options.length, 3);
  assert.equal(menu.marker, '›');
  assert.ok(menu.options[0].label.startsWith('Yes, proceed'));
});

test('parseMenu: Codex apply_patch approval is 3 options', () => {
  const menu = parseMenu(codexPatch);
  assert.equal(menu.options.length, 3);
  assert.deepEqual(
    menu.options.map((option) => option.digit),
    ['1', '2', '3'],
  );
});

test('parseMenu: title is the nearest content line above the first option', () => {
  assert.equal(parseMenu(claudeWrite).title, 'Do you want to create note.txt?');
  assert.equal(parseMenu(codexExec).title, '$ touch approve-me.txt');
  assert.equal(parseMenu(codexTrust).title, '');
});

test('parseMenu: a numbered prose list is not a menu', () => {
  // Non-sequential and not starting at 1: output, not a chooser.
  assert.equal(parseMenu(['1. alpha', 'unrelated line', 'unrelated line', '3. gamma'].join('\n')), null);
});

test('parseMenu: a prose list with no marker and no selection is still a menu only when contiguous', () => {
  assert.equal(parseMenu(['Steps:', '1. install', '2. run'].join('\n')).options.length, 2);
});

test('parseMenu: a lone `› N.` prompt echo is not a menu', () => {
  assert.equal(parseMenu(['› 1. do the thing I asked', '', 'some other output line'].join('\n')), null);
});

test('parseMenu: an echo above the live dialog loses to the real menu', () => {
  const screen = [
    '› 1. update the readme',
    '  2. add more tests',
    '',
    '  Would you like to run the following command?',
    '  $ touch x.txt',
    '› 1. Yes, proceed (y)',
    "  2. Yes, and don't ask again (p)",
    '  3. No, and tell Codex what to do differently (esc)',
  ].join('\n');
  const menu = parseMenu(screen);
  assert.equal(menu.options.length, 3);
  assert.ok(menu.options[0].label.startsWith('Yes, proceed'));
});

test('parseMenu: the last valid contiguous run wins', () => {
  const screen = ['1. stale', '2. stale', '', '1. first', '2. second'].join('\n');
  assert.deepEqual(
    parseMenu(screen).options.map((option) => option.label),
    ['first', 'second'],
  );
});

test('parseMenu: a run that does not start at 1 is not a menu', () => {
  assert.equal(parseMenu(['2. yes', '3. no'].join('\n')), null);
});

// -------------------------------------------------------------- classifyMenu

test('classifyMenu: Claude approval maps allow / allowAlways / deny', () => {
  const classified = classifyMenu(parseMenu(claudeWrite));
  assert.equal(classified.kind, 'permission');
  assert.equal(classified.allow.digit, '1');
  assert.equal(classified.allowAlways.digit, '2');
  assert.equal(classified.deny.digit, '3');
});

test('classifyMenu: Codex exec approval maps allow / allowAlways / deny', () => {
  const classified = classifyMenu(parseMenu(codexExec));
  assert.equal(classified.kind, 'permission');
  assert.equal(classified.allow.digit, '1');
  assert.equal(classified.allowAlways.digit, '2');
  assert.equal(classified.deny.digit, '3');
});

test('classifyMenu: a plain question form is not a permission', () => {
  const classified = classifyMenu(parseMenu(['Which database?', '  1. Postgres', '  2. SQLite'].join('\n')));
  assert.equal(classified.kind, 'question');
});

// -------------------------------------------------------- isCodexApprovalScreen

test('isCodexApprovalScreen: exec and patch dialogs are detected', () => {
  assert.equal(isCodexApprovalScreen(`${codexExec}\n${codexFooter}`), true);
  assert.equal(isCodexApprovalScreen(`${codexPatch}\n${codexFooter}`), true);
});

test('isCodexApprovalScreen: a stale › echo above the dialog does not hide it', () => {
  const screen = [
    '› 1. an earlier numbered prompt echo',
    '  2. still visible from before',
    '  ...more output...',
    codexExec,
    codexFooter,
  ].join('\n');
  assert.equal(isCodexApprovalScreen(screen), true);
});

test('isCodexApprovalScreen: working output is not a dialog', () => {
  assert.equal(isCodexApprovalScreen(['• Working (12s • esc to interrupt)', '› Run the shell command'].join('\n')), false);
});

test('isCodexApprovalScreen: prose with no footer is not a dialog', () => {
  assert.equal(isCodexApprovalScreen(['• I can do that. Would you like to run the tests first?', '› _'].join('\n')), false);
});

test('isCodexApprovalScreen: footer text with no menu is not a dialog', () => {
  const screen = ['• Edited docs/PERMISSIONS.md (+1 -0)', `    "${codexFooter.trim()}" is the anchor.`, '› _'].join('\n');
  assert.equal(isCodexApprovalScreen(screen), false);
});

test('isCodexApprovalScreen: footer plus an unmarked prose list is not a dialog', () => {
  const screen = [
    '• Options I considered (see: press enter to confirm or esc to cancel):',
    '  1. rewrite the parser',
    '  2. add a flag',
    '› _',
  ].join('\n');
  assert.equal(isCodexApprovalScreen(screen), false);
});

test('isCodexApprovalScreen: footer far above a marked echo is not a dialog', () => {
  const screen = [
    '  docs note: press enter to confirm or esc to cancel.',
    '  line',
    '  line',
    '  line',
    '  line',
    '  line',
    '  line',
    '  line',
    '  line',
    '› 1. my first idea',
    '  2. my second idea',
  ].join('\n');
  assert.equal(isCodexApprovalScreen(screen), false);
});

test('isCodexApprovalScreen: a Claude prompt alone (no footer) is not a Codex approval', () => {
  assert.equal(isCodexApprovalScreen(claudeWrite), false);
  assert.equal(isCodexApprovalScreen(claudeTrust), false);
});

// ------------------------------------------------------------- answerChoices

const assertValidKeys = (choices) => {
  for (const choice of choices) {
    assert.ok(choice.keys.length > 0, `empty keys for ${choice.label}`);
    for (const key of choice.keys) {
      assert.equal(key, key.toLowerCase());
      assert.ok(isAllowedKey(key), `invalid bridge key: ${key}`);
    }
  }
};

test('answerChoices: Claude permission uses the parsed digits', () => {
  const choices = answerChoices(claudeWrite);
  assert.deepEqual(choices, [
    { label: 'Allow', keys: ['1'] },
    { label: 'Allow always', keys: ['2'] },
    { label: 'Deny', keys: ['3'] },
  ]);
  assertValidKeys(choices);
});

test('answerChoices: Claude trust prompt uses its two digits', () => {
  const choices = answerChoices(claudeTrust);
  assert.deepEqual(
    choices.map((choice) => choice.keys),
    [['1'], ['2']],
  );
  assert.equal(choices[0].label, 'Allow');
  assert.equal(choices[1].label, 'Deny');
  assertValidKeys(choices);
});

test('answerChoices: Codex approvals never use digit keys', () => {
  for (const screen of [codexTrust, codexExec, codexPatch]) {
    const choices = answerChoices(screen);
    assert.ok(choices.length >= 2);
    for (const choice of choices) assert.ok(!/^\d+$/.test(choice.keys[0]), `digit key used: ${choice.keys}`);
    assertValidKeys(choices);
  }
});

test('answerChoices: Codex exec approval walks the enter / down+enter / esc ladder', () => {
  const choices = answerChoices(codexExec);
  assert.deepEqual(
    choices.map((choice) => choice.keys),
    [['enter'], ['down', 'enter'], ['esc']],
  );
  // Labels stay as parsed: they carry the (y)/(p)/(esc) hints.
  assert.ok(choices[0].label.startsWith('Yes, proceed'));
  assert.ok(choices[2].label.startsWith('No, and tell Codex'));
});

test('answerChoices: Codex trust prompt is enter / esc', () => {
  const choices = answerChoices(codexTrust);
  assert.deepEqual(
    choices.map((choice) => choice.keys),
    [['enter'], ['esc']],
  );
});

test('answerChoices: question menus are numeric option choices', () => {
  const choices = answerChoices(['Which database?', '❯ 1. Postgres', '  2. SQLite', '  3. DuckDB'].join('\n'));
  assert.deepEqual(choices, [
    { label: 'Postgres', keys: ['1'] },
    { label: 'SQLite', keys: ['2'] },
    { label: 'DuckDB', keys: ['3'] },
  ]);
});

test('answerChoices: a non-menu prompt yields no choices', () => {
  assert.deepEqual(answerChoices(''), []);
  assert.deepEqual(answerChoices('Allow this command? [y/n]'), []);
  assert.deepEqual(answerChoices(['› 1. do the thing I asked', 'more output'].join('\n')), []);
  assert.deepEqual(answerChoices(['1. alpha', 'unrelated', 'unrelated', '3. gamma'].join('\n')), []);
});
