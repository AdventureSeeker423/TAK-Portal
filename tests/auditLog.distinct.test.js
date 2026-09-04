const assert = require("assert");

const store = require("../services/auditLog.store");
store.listDistinct = async (field) => {
  if (field === "actions") return ["USER_CREATED", "SETTINGS_SAVED"];
  if (field === "targetTypes") return ["user", "settings"];
  return [];
};
store.listDistinctActors = async () => [
  { username: "admin", displayName: "Admin User" },
  { username: "bob", displayName: null },
];

const auditSvc = require("../services/auditLog.service");

(async () => {
  const actions = await auditSvc.listDistinctValues({ field: "actions" });
  assert.ok(Array.isArray(actions), "action options must be an array, not a Promise");
  assert.ok(typeof actions.forEach === "function");
  assert.ok(actions.includes("USER_CREATED"));

  const actors = await auditSvc.listDistinctActors();
  assert.ok(Array.isArray(actors), "actor options must be an array");
  assert.strictEqual(actors.length, 2);
  assert.strictEqual(actors[0].username, "admin");
  assert.strictEqual(actors[0].displayName, "Admin User");

  console.log("auditLog.distinct.test.js: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
