const test = require('node:test');
const assert = require('node:assert/strict');
const { GrayImage } = require('../.test-build/app/graphics/image.js');
const { drawSessionRow, sessionLabelX } = require('../.test-build/app/apps/terminal/session-list.js');

const CHAR_WIDTH = 6;
const LINE_HEIGHT = 12;
const ROW = { x: 2, y: 4, width: 300, openGlyph: null, active: false, phase: 0, value: 200 };
const ROW_RIGHT = ROW.x + ROW.width;
const MARK_SIZE = 7;
const STATES = ['blocked', 'error', 'done', 'working'];

/** A monospace font that records the text it draws. */
function fakeFont() {
  const drawn = [];
  return {
    drawn,
    lineHeight: LINE_HEIGHT,
    descent: 2,
    measureText: (text) => [...text].length * CHAR_WIDTH,
    drawText: (_image, x, y, text, value) => drawn.push({ x, y, text, value }),
  };
}

function draw(options) {
  const font = fakeFont();
  const image = new GrayImage(ROW_RIGHT + 10, 30);
  drawSessionRow(image, font, { ...ROW, ...options });
  const lit = [];
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) if (image.getPixel(x, y)) lit.push([x, y, image.getPixel(x, y)]);
  return { drawn: font.drawn, lit, labelX: sessionLabelX(font, ROW.x) };
}

test('a row without a status draws its label to the row end and nothing else', () => {
  const long = 'x'.repeat(100);
  const { drawn, lit, labelX } = draw({ label: long });
  const fits = Math.floor((ROW_RIGHT - labelX) / CHAR_WIDTH) - 3;
  assert.deepEqual(drawn, [{ x: labelX, y: ROW.y, text: `${'x'.repeat(fits)}...`, value: ROW.value }]);
  assert.deepEqual(lit, []);
});

test('each status draws its own mark at the row end, and only blocked shows its message', () => {
  const marks = new Map();
  for (const state of STATES) {
    const { drawn, lit, labelX } = draw({ label: 'work', status: { state, msg: 'Approve edit?' } });
    assert.ok(lit.length > 0, `${state} draws a mark`);
    assert.ok(lit.every(([x]) => x >= ROW_RIGHT - MARK_SIZE && x < ROW_RIGHT), `${state} mark sits in the last ${MARK_SIZE} columns`);
    marks.set(state, JSON.stringify(lit.map(([x, y]) => [x, y])));
    assert.deepEqual(drawn[0], { x: labelX, y: ROW.y, text: 'work', value: ROW.value });
    assert.equal(drawn.length, state === 'blocked' ? 2 : 1);
  }
  assert.equal(new Set(marks.values()).size, STATES.length, 'every state has a different mark');
});

test('the blocked mark is at full brightness and its message follows the label, dimmer', () => {
  const { drawn, lit, labelX } = draw({ label: 'work', value: 200, status: { state: 'blocked', kind: 'permission', msg: 'Approve edit?' } });
  assert.ok(lit.every(([, , value]) => value === 255));
  assert.equal(drawn[1].text, 'Approve edit?');
  assert.ok(drawn[1].x > labelX + 'work'.length * CHAR_WIDTH);
  assert.ok(drawn[1].value < ROW.value);
});

test('the label keeps its room: a long label leaves the mark clear and drops the message', () => {
  const { drawn } = draw({ label: 'y'.repeat(100), status: { state: 'blocked', msg: 'Approve edit?' } });
  assert.equal(drawn.length, 1);
  const end = drawn[0].x + drawn[0].text.length * CHAR_WIDTH;
  assert.ok(end <= ROW_RIGHT - MARK_SIZE, 'the label ends before the mark');
});

test('a long message is cut to the room left before the mark', () => {
  const { drawn } = draw({ label: 'work', status: { state: 'blocked', msg: 'z'.repeat(100) } });
  const msg = drawn[1];
  assert.ok(msg.text.endsWith('...'));
  assert.ok(msg.x + msg.text.length * CHAR_WIDTH <= ROW_RIGHT - MARK_SIZE);
});

test('however narrow the row, the mark never overlaps the label', () => {
  const labelX = sessionLabelX(fakeFont(), ROW.x);
  const narrowest = labelX - ROW.x;
  const wideEnough = narrowest + 'work'.length * CHAR_WIDTH + 2 * MARK_SIZE;
  for (let width = narrowest; width <= wideEnough; width++) {
    for (const state of STATES) {
      const { drawn, lit } = draw({ width, label: 'work', status: { state } });
      const labelRight = labelX + drawn[0].text.length * CHAR_WIDTH;
      assert.ok(lit.every(([x]) => x >= labelRight), `${state} mark clear of "${drawn[0].text}" at width ${width}`);
      if (width === wideEnough) assert.ok(lit.length > 0, `${state} mark drawn at width ${width}`);
    }
  }
});
