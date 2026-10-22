const assert = require("assert");

const settingsState = {
  USERS_HIDDEN_PREFIXES: "ak-,nodered-",
  GROUPS_HIDDEN_PREFIXES: "authentik, MA -",
  HIDDEN_PREFIX_ATTR_MIGRATION: "0",
};

const settingsSvc = require("../services/settings.service");
settingsSvc.getSettings = () => ({ ...settingsState });
settingsSvc.updateSettings = (patch) => {
  Object.assign(settingsState, patch || {});
};

const db = require("../services/db");
const calls = { users: [], groups: [], stampedUsers: 0, stampedGroups: 0 };

db.query = async (sql, params) => {
  if (/FROM directory_sync/.test(sql)) {
    return { rows: [{ last_success_at: new Date(), completed: true }] };
  }
  if (/FROM users/.test(sql) && /COUNT\(\*\)/.test(sql)) {
    return { rows: [{ n: calls.users.length ? 0 : 0 }] };
  }
  if (/FROM groups/.test(sql) && /COUNT\(\*\)/.test(sql)) {
    return { rows: [{ n: 0 }] };
  }
  if (/FROM users/.test(sql) && /tak_portal_hidden = false/.test(sql) && /LIMIT/.test(sql)) {
    const rows = calls.users.splice(0, calls.users.length);
    return { rows };
  }
  if (/FROM groups/.test(sql) && /tak_portal_hidden = false/.test(sql) && /LIMIT/.test(sql)) {
    const rows = calls.groups.splice(0, calls.groups.length);
    return { rows };
  }
  return { rows: [] };
};

db.withTransaction = async (fn) => fn({});

const directoryRepo = require("../services/directoryRepo.service");
directoryRepo.updateLocalUser = async () => {
  calls.stampedUsers += 1;
};
directoryRepo.updateLocalGroup = async () => {
  calls.stampedGroups += 1;
};

const authentikOutbox = require("../services/authentikOutbox.service");
authentikOutbox.enqueue = async () => 1;

// Fresh module with mocks already applied
delete require.cache[require.resolve("../services/hiddenPrefixMigration.service")];
const migration = require("../services/hiddenPrefixMigration.service");

(async () => {
  calls.users = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      authentik_pk: "1",
      username: "ak-admin",
      attributes: {},
    },
  ];
  calls.groups = [
    {
      id: "22222222-2222-4222-8222-222222222222",
      authentik_pk: "2",
      name: "authentik Admins",
      attributes: {},
    },
  ];

  const first = await migration.runOnce();
  assert.ok(first.stampedUsers >= 1 || first.done || first.pending);
  assert.ok(calls.stampedUsers >= 1);
  assert.ok(calls.stampedGroups >= 1);

  // Remaining counts are 0 → should clear prefixes
  const second = await migration.runOnce();
  assert.strictEqual(settingsState.USERS_HIDDEN_PREFIXES, "");
  assert.strictEqual(settingsState.GROUPS_HIDDEN_PREFIXES, "");
  assert.strictEqual(settingsState.HIDDEN_PREFIX_ATTR_MIGRATION, "1");
  assert.ok(second.done || second.skipped);

  const third = await migration.runOnce();
  assert.ok(third.skipped);

  console.log("hiddenPrefixMigration.test.js: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
