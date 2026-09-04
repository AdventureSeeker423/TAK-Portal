const assert = require("assert");

const deleted = [];
const updates = [];

const repo = require("../services/directoryRepo.service");
repo.deleteLocalUser = async (id) => {
  deleted.push(id);
};
repo.deleteLocalGroup = async (id) => {
  deleted.push(`group:${id}`);
};

const db = require("../services/db");
db.query = async (sql, params) => {
  updates.push({ sql, params });
  return { rows: [] };
};

const { revertDeadLetter } = require("../services/directorySync.service");

(async () => {
  await revertDeadLetter({
    kind: "create_user",
    entity_id: "user-1",
    username: "badge.so",
    last_error: "Authentik 500",
  });
  assert.deepStrictEqual(deleted, ["user-1"]);

  await revertDeadLetter({
    kind: "delete_user",
    entity_id: "user-2",
    last_error: "gone",
  });
  assert.ok(
    updates.some(
      (u) =>
        /pending_delete = false/.test(u.sql) &&
        Array.isArray(u.params) &&
        u.params.includes("user-2")
    ),
    "delete_user dead letter should clear pending_delete"
  );

  console.log("directorySync.deadLetter.test.js: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
