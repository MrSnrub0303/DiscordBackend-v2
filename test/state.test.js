const test = require("node:test");
const assert = require("node:assert");
const {
  rooms, playerLastSeen, PLAYER_SESSION_TIMEOUT,
  ensureRoom, updatePlayerLastSeen, checkPlayerSessionTimeout,
} = require("../game/state");

test("ensureRoom creates a room once and reuses it", () => {
  const room = ensureRoom("state-test-room");
  assert.ok(room);
  assert.deepStrictEqual(room.scores, {});
  assert.strictEqual(ensureRoom("state-test-room"), room);
  assert.strictEqual(rooms["state-test-room"], room);
});

test("a player never seen before is new, not timed out", () => {
  assert.deepStrictEqual(checkPlayerSessionTimeout("state-room-a", "p1"), { timedOut: false, isNewPlayer: true });
});

test("a player seen just now has not timed out", () => {
  updatePlayerLastSeen("state-room-b", "p1");
  const result = checkPlayerSessionTimeout("state-room-b", "p1");
  assert.strictEqual(result.timedOut, false);
  assert.strictEqual(result.isNewPlayer, false);
});

test("a player away longer than the session timeout has timed out", () => {
  updatePlayerLastSeen("state-room-c", "p1");
  playerLastSeen["state-room-c"]["p1"] = Date.now() - PLAYER_SESSION_TIMEOUT - 1000;
  assert.strictEqual(checkPlayerSessionTimeout("state-room-c", "p1").timedOut, true);
});

test("missing ids are handled safely", () => {
  assert.deepStrictEqual(checkPlayerSessionTimeout(null, "p1"), { timedOut: false });
  assert.doesNotThrow(() => updatePlayerLastSeen(null, null));
});
