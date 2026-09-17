const assert = require("assert");
const fs = require("fs");
const path = require("path");

function sliceAsyncFn(src, name, nextName) {
  const start = src.indexOf(`async function ${name}`);
  const end = src.indexOf(`async function ${nextName}`);
  assert.ok(start >= 0 && end > start, `${name} not found`);
  return src.slice(start, end);
}

const usersSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "users.service.js"),
  "utf8"
);

assert.ok(
  !usersSrc.includes('require("./authentik")'),
  "users.service must not live-call Authentik; the worker outbox is the write path"
);

const bulkDisable = sliceAsyncFn(
  usersSrc,
  "bulkDisableUsersForAgency",
  "bulkEnableUsersForAgency"
);
assert.ok(
  bulkDisable.includes("toggleUserActive"),
  "agency bulk disable must use toggleUserActive (Postgres + patch_user outbox)"
);
assert.ok(
  !/api\.patch/.test(bulkDisable),
  "agency bulk disable must not live-patch Authentik"
);

const bulkEnable = sliceAsyncFn(
  usersSrc,
  "bulkEnableUsersForAgency",
  "bulkDeleteUsersForAgency"
);
assert.ok(
  bulkEnable.includes("toggleUserActive"),
  "agency bulk enable must use toggleUserActive (Postgres + patch_user outbox)"
);
assert.ok(
  !/api\.patch/.test(bulkEnable),
  "agency bulk enable must not live-patch Authentik"
);
assert.ok(
  !bulkEnable.includes("if (user.is_active) return"),
  "agency bulk enable must not skip when Postgres still says active"
);

const bulkDelete = sliceAsyncFn(
  usersSrc,
  "bulkDeleteUsersForAgency",
  "countUsersByAgencyName"
);
assert.ok(
  bulkDelete.includes("deleteUser"),
  "agency bulk delete must use deleteUser (pending_delete + delete_user outbox)"
);
assert.ok(
  !/api\.delete/.test(bulkDelete),
  "agency bulk delete must not live-delete Authentik users"
);

const toggleFn = sliceAsyncFn(usersSrc, "toggleUserActive", "deleteUser");
assert.ok(
  toggleFn.includes("skipTakCertRevoke") && toggleFn.includes("waitForOutbox"),
  "toggleUserActive must support bulk skip-wait / skip TAK revoke"
);
assert.ok(
  toggleFn.includes("updateLocalUser") && toggleFn.includes('kind: "patch_user"'),
  "toggleUserActive must write Postgres is_active and enqueue patch_user"
);

const deleteFn = sliceAsyncFn(usersSrc, "deleteUser", "updateName");
assert.ok(
  deleteFn.includes("waitForOutbox") && deleteFn.includes("pending_delete"),
  "deleteUser must honor waitForOutbox and mark pending_delete locally"
);

const backfillFn = sliceAsyncFn(
  usersSrc,
  "backfillMissingUserRoles",
  "getMissingUserRoleStats"
);
assert.ok(
  backfillFn.includes("enqueueLocalUserAttributePatch"),
  "role backfill must write Postgres attributes + patch_user outbox"
);
assert.ok(
  !/api\.patch/.test(backfillFn),
  "role backfill must not live-patch Authentik attributes"
);

const createDirFn = usersSrc.slice(
  usersSrc.indexOf("async function createDirectoryUser"),
  usersSrc.indexOf("const INTEGRATION_PREFIX")
);
assert.ok(
  createDirFn.includes("insertLocalUser") && createDirFn.includes('kind: "create_user"'),
  "createDirectoryUser must insert locally and enqueue create_user"
);
assert.ok(
  createDirFn.includes("setUserMemberships"),
  "createDirectoryUser must write group_members locally"
);

const maSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "mutualAid.service.js"),
  "utf8"
);
assert.ok(
  maSrc.includes("createDirectoryUser"),
  "mutual aid create must use createDirectoryUser (Postgres + create_user outbox)"
);
assert.ok(
  !maSrc.includes('api.post("/core/users/")') && !maSrc.includes("/core/users/"),
  "mutual aid must not live-create or live-patch Authentik users"
);
assert.ok(
  maSrc.includes("updateName") && maSrc.includes("enqueueLocalUserAttributePatch"),
  "mutual aid edit must patch local name/attributes and enqueue the worker"
);

console.log("directoryWritePath tests passed");
