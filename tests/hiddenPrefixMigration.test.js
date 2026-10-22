const assert = require("assert");

const settingsState = {
  // Fresh install: no prefix settings seeded
  USERS_HIDDEN_PREFIXES: "",
  GROUPS_HIDDEN_PREFIXES: "",
  HIDDEN_PREFIX_ATTR_MIGRATION: "0",
};

const settingsSvc = require("../services/settings.service");
settingsSvc.getSettings = () => ({ ...settingsState });
settingsSvc.updateSettings = (patch) => {
  Object.assign(settingsState, patch || {});
};

const db = require("../services/db");
const calls = { users: [], groups: [], stampedUsers: 0, stampedGroups: 0, lastUserPrefixes: null, lastGroupPrefixes: null };

db.query = async (sql, params) => {
  if (/FROM directory_sync/.test(sql)) {
    return { rows: [{ last_success_at: new Date(), completed: true }] };
  }
  if (/FROM users/.test(sql) && /COUNT\(\*\)/.test(sql)) {
    return { rows: [{ n: 0 }] };
  }
  if (/FROM groups/.test(sql) && /COUNT\(\*\)/.test(sql)) {
    return { rows: [{ n: 0 }] };
  }
  if (/FROM users/.test(sql) && /tak_portal_hidden = false/.test(sql) && /LIMIT/.test(sql)) {
    calls.lastUserPrefixes = params && params[0];
    const rows = calls.users.splice(0, calls.users.length);
    return { rows };
  }
  if (/FROM groups/.test(sql) && /tak_portal_hidden = false/.test(sql) && /LIMIT/.test(sql)) {
    calls.lastGroupPrefixes = params && params[0];
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

delete require.cache[require.resolve("../services/hiddenPrefixMigration.service")];
const migration = require("../services/hiddenPrefixMigration.service");

assert.deepStrictEqual(
  migration.stampUserPrefixes().sort(),
  ["ak-", "adm_", "ma-", "nodered-"].sort()
);
assert.deepStrictEqual(
  migration.stampGroupPrefixes().sort(),
  ["authentik", "ma -"].sort()
);

(async () => {
  calls.users = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      authentik_pk: "1",
      username: "ak-admin",
      attributes: {},
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      authentik_pk: "3",
      username: "nodered-legacy-wx",
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
    {
      id: "44444444-4444-4444-8444-444444444444",
      authentik_pk: "4",
      name: "MA - Drill",
      attributes: {},
    },
  ];

  const first = await migration.runOnce();
  assert.ok(first.stampedUsers >= 1 || first.done || first.pending);
  assert.ok(calls.stampedUsers >= 2, "should stamp legacy user prefixes on fresh install");
  assert.ok(calls.stampedGroups >= 2, "should stamp legacy group prefixes on fresh install");
  assert.ok(
    Array.isArray(calls.lastUserPrefixes) &&
      calls.lastUserPrefixes.includes("ak-") &&
      calls.lastUserPrefixes.includes("nodered-"),
    "fresh install must query built-in user prefixes"
  );
  assert.ok(
    Array.isArray(calls.lastGroupPrefixes) &&
      calls.lastGroupPrefixes.includes("authentik") &&
      calls.lastGroupPrefixes.includes("ma -"),
    "fresh install must query built-in group prefixes"
  );

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
