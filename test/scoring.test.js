const test = require("node:test");
const assert = require("node:assert");
const { calculatePointsFromTime } = require("../game/scoring");
const { MAX_TIME, MAX_POINTS } = require("../config");

test("no time or invalid time scores nothing", () => {
  assert.strictEqual(calculatePointsFromTime(0), 0);
  assert.strictEqual(calculatePointsFromTime(-3), 0);
  assert.strictEqual(calculatePointsFromTime(undefined), 0);
  assert.strictEqual(calculatePointsFromTime(null), 0);
});

test("faster answers score more (quadratic falloff)", () => {
  assert.strictEqual(calculatePointsFromTime(1), 135);   // 150 * (19/20)^2 = 135.4
  assert.strictEqual(calculatePointsFromTime(10), 38);   // 150 * (10/20)^2 = 37.5
  assert.strictEqual(calculatePointsFromTime(15), 9);    // 150 * (5/20)^2  = 9.4
  assert.ok(calculatePointsFromTime(2) > calculatePointsFromTime(5));
});

test("answering at or after the time limit scores nothing", () => {
  assert.strictEqual(calculatePointsFromTime(MAX_TIME), 0);
  assert.strictEqual(calculatePointsFromTime(MAX_TIME + 5), 0);
});

test("score never exceeds MAX_POINTS", () => {
  for (let t = 0.01; t <= MAX_TIME; t += 0.5) {
    assert.ok(calculatePointsFromTime(t) <= MAX_POINTS);
  }
});
