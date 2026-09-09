const assert = require("assert");
const directoryRepo = require("../services/directoryRepo.service");
const gate = require("../services/activeUserGate.service");

gate.invalidateAllActiveUsers();

let lookups = 0;
const users = {
  alice: { username: "alice", is_active: true },
  bob: { username: "bob", is_active: false },
};

directoryRepo.getUserById = async (id) => {
  lookups += 1;
  const key = String(id || "").trim().toLowerCase();
  return users[key] || null;
};

(async () => {
  assert.strictEqual(await gate.isLocalUserActive("alice"), true);
  assert.strictEqual(await gate.isLocalUserActive("alice"), true);
  assert.strictEqual(lookups, 1, "active result should be cached");

  assert.strictEqual(await gate.isLocalUserActive("bob"), false);
  assert.strictEqual(await gate.isLocalUserActive("bob"), false);
  assert.strictEqual(lookups, 2, "disabled result should be cached");

  // Missing local user → fail open (Authentik still authenticates them).
  assert.strictEqual(await gate.isLocalUserActive("ghost"), true);
  assert.strictEqual(lookups, 3);

  users.bob.is_active = true;
  assert.strictEqual(await gate.isLocalUserActive("bob"), false, "stale cache until invalidate");
  gate.invalidateActiveUser("bob");
  assert.strictEqual(await gate.isLocalUserActive("bob"), true);
  assert.strictEqual(lookups, 4);

  assert.strictEqual(await gate.isLocalUserActive("bootstrap"), true);
  assert.strictEqual(lookups, 4, "bootstrap skips DB");

  console.log("activeUserGate tests passed");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
