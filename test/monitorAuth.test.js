const test = require("node:test");
const assert = require("node:assert");

// Fake Discord's /users/@me so no real network calls are made
const fakeUsers = { "good-token": { username: "joshua667746" }, "other-token": { username: "someone_else" } };
let discordCalls = 0;
global.fetch = async (url, opts) => {
  assert.strictEqual(url, "https://discord.com/api/users/@me");
  discordCalls++;
  const token = (opts.headers.Authorization || "").replace("Bearer ", "");
  const user = fakeUsers[token];
  return { ok: !!user, json: async () => user };
};

delete process.env.MONITOR_USERNAMES;
const { isMonitorAuthorized } = require("../lib/monitorAuth");
const req = (headers) => ({ headers });

test("a spoofed username header alone is rejected", async () => {
  assert.strictEqual(await isMonitorAuthorized(req({ "x-discord-username": "joshua667746" })), false);
});

test("no credentials are rejected without calling Discord", async () => {
  const before = discordCalls;
  assert.strictEqual(await isMonitorAuthorized(req({})), false);
  assert.strictEqual(discordCalls, before);
});

test("a valid token for an authorized user is accepted", async () => {
  assert.strictEqual(await isMonitorAuthorized(req({ authorization: "Bearer good-token" })), true);
});

test("a valid token for an unauthorized user is rejected, even with a spoofed header", async () => {
  assert.strictEqual(await isMonitorAuthorized(req({ authorization: "Bearer other-token", "x-discord-username": "joshua667746" })), false);
});

test("an invalid token is rejected", async () => {
  assert.strictEqual(await isMonitorAuthorized(req({ authorization: "Bearer bogus" })), false);
});

test("token lookups are cached so Discord is not called repeatedly", async () => {
  await isMonitorAuthorized(req({ authorization: "Bearer good-token" }));
  const before = discordCalls;
  await isMonitorAuthorized(req({ authorization: "Bearer good-token" }));
  assert.strictEqual(discordCalls, before);
});
