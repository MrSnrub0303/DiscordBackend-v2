const test = require("node:test");
const assert = require("node:assert");

// Load only the app and the game routes (no bot, Steam, or socket timers)
const { app, server, io } = require("../app");
require("../game/routes");

let base;
test.before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => {
  io.close();
  await new Promise((resolve) => server.close(resolve));
});

const post = async (path, body) => {
  const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return [r.status, await r.json()];
};
const get = async (path) => { const r = await fetch(base + path); return [r.status, await r.json()]; };

for (const prefix of ["", "/api"]) {
  test(`full round works at ${prefix || "/"} (Discord strips /api, local dev keeps it)`, async () => {
    const room = `route-test${prefix.replace("/", "-")}`;

    const [s1, join] = await post(`${prefix}/player-join`, { roomId: room, playerId: "A", playerName: "Alice" });
    assert.strictEqual(s1, 200);
    assert.strictEqual(join.isNewPlayer, true);

    const [s2, start] = await post(`${prefix}/start_question`, { roomId: room, playerId: "A" });
    assert.strictEqual(s2, 200);
    assert.ok(start.question, "a question is returned");

    // a second start while the question is active returns the same question
    const [, again] = await post(`${prefix}/start_question`, { roomId: room, playerId: "B" });
    assert.strictEqual(again.question.id, start.question.id);

    const [s3, sel] = await post(`${prefix}/game-event`, { event: "select_option", data: { roomId: room, playerId: "A", playerName: "Alice", optionIndex: 0, timeTaken: 3 } });
    assert.strictEqual(s3, 200);
    assert.strictEqual(sel.success, true);

    const [s4, state] = await get(`${prefix}/game-state/${room}?playerId=A`);
    assert.strictEqual(s4, 200);
    assert.strictEqual(state.currentQuestion.id, start.question.id);
    assert.ok(state.selections.A, "the selection is recorded");

    const [s5, end] = await post(`${prefix}/game-event`, { event: "end_round", data: { roomId: room } });
    assert.strictEqual(s5, 200);
    assert.strictEqual(end.action, "round_complete");

    const [, after] = await get(`${prefix}/game-state/${room}`);
    assert.strictEqual(after.roundEnded, true);
    assert.strictEqual(after.showResult, true);
  });
}

test("bad requests are rejected", async () => {
  const [status, body] = await post("/start_question", {});
  assert.strictEqual(status, 400);
  assert.strictEqual(body.success, false);
  const [joinStatus] = await post("/player-join", { roomId: "x" });
  assert.strictEqual(joinStatus, 400);
});
