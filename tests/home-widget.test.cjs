const test = require("node:test");
const assert = require("node:assert/strict");

const {
  HOME_WIDGET_LOW_PERCENT,
  homeWidgetLevel,
  homeWidgetSnapshot,
} = require("../.test-build/app/native/home-widget-model.js");

function input(overrides = {}) {
  return {
    paired: true,
    connected: true,
    docked: false,
    glasses: 86,
    glassesCharging: false,
    caseBattery: 74,
    caseCharging: false,
    frame: "b",
    ...overrides,
  };
}

test("a live reading is white with %, red under 15%, and shows the bolt while charging", () => {
  assert.deepEqual(homeWidgetLevel(86, false, true), { percent: 86, tone: "normal", suffix: "percent" });
  assert.deepEqual(homeWidgetLevel(86, true, true), { percent: 86, tone: "normal", suffix: "bolt" });
  assert.equal(HOME_WIDGET_LOW_PERCENT, 15);
  assert.deepEqual(homeWidgetLevel(14, false, true), { percent: 14, tone: "low", suffix: "percent" });
  assert.deepEqual(homeWidgetLevel(15, false, true), { percent: 15, tone: "normal", suffix: "percent" });
  // Low and charging: still red, and the bolt says it is on its way up.
  assert.deepEqual(homeWidgetLevel(9, true, true), { percent: 9, tone: "low", suffix: "bolt" });
});

test("a reading that is not live is grey with a plain %, even if it was low or charging", () => {
  assert.deepEqual(homeWidgetLevel(9, true, false), { percent: 9, tone: "stale", suffix: "percent" });
  assert.deepEqual(homeWidgetLevel(74, null, false), { percent: 74, tone: "stale", suffix: "percent" });
});

test("no reading, or a bad one, is a dash with nothing after it", () => {
  const none = { percent: null, tone: "unknown", suffix: "none" };
  assert.deepEqual(homeWidgetLevel(null, false, true), none);
  assert.deepEqual(homeWidgetLevel(101, false, true), none);
  assert.deepEqual(homeWidgetLevel(-1, false, true), none);
  assert.deepEqual(homeWidgetLevel(Number.NaN, false, true), none);
  assert.equal(homeWidgetLevel(86.4, false, true).percent, 86);
});

test("worn: the glasses are live and the case is the reading from the last dock", () => {
  const snapshot = homeWidgetSnapshot(input({ caseCharging: true }));
  assert.deepEqual(snapshot, {
    paired: true,
    connected: true,
    frame: "b",
    glasses: { percent: 86, tone: "normal", suffix: "percent" },
    case: { percent: 74, tone: "stale", suffix: "percent" },
  });
});

test("docked: the case is live, so its charging shows", () => {
  const snapshot = homeWidgetSnapshot(input({ docked: true, glassesCharging: true, caseCharging: true }));
  assert.deepEqual(snapshot.glasses, { percent: 86, tone: "normal", suffix: "bolt" });
  assert.deepEqual(snapshot.case, { percent: 74, tone: "normal", suffix: "bolt" });
});

test("offline: everything is the last reading, and docking no longer makes the case live", () => {
  const snapshot = homeWidgetSnapshot(input({ connected: false, docked: true, glassesCharging: true }));
  assert.equal(snapshot.connected, false);
  assert.equal(snapshot.glasses.tone, "stale");
  assert.equal(snapshot.case.tone, "stale");
  assert.equal(snapshot.glasses.suffix, "percent");
});

test("not paired: nothing to show, whatever the shell remembers", () => {
  assert.deepEqual(homeWidgetSnapshot(input({ paired: false })), {
    paired: false,
    connected: false,
    frame: null,
    glasses: { percent: null, tone: "unknown", suffix: "none" },
    case: { percent: null, tone: "unknown", suffix: "none" },
  });
});

test("only frames A and B have a render; C and unknown serials fall back to the generic G2", () => {
  assert.equal(homeWidgetSnapshot(input({ frame: "a" })).frame, "a");
  assert.equal(homeWidgetSnapshot(input({ frame: "b" })).frame, "b");
  assert.equal(homeWidgetSnapshot(input({ frame: "c" })).frame, null);
  assert.equal(homeWidgetSnapshot(input({ frame: null })).frame, null);
});
