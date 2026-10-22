/**
 * One-time: stamp tak_portal_hidden on users/groups matching legacy hide
 * patterns (and any remaining settings prefixes), then blank prefix settings.
 *
 * Fresh installs no longer seed USERS_/GROUPS_HIDDEN_PREFIXES, so this always
 * uses the built-in legacy lists below so Authentik/system/MA/integration
 * accounts still get the attribute after the first inbound sync.
 */
const db = require("./db");
const settingsSvc = require("./settings.service");
const authentikOutbox = require("./authentikOutbox.service");
const directoryRepo = require("./directoryRepo.service");
const {
  ATTR_KEY,
  markHiddenAttributes,
  hiddenUserPrefixes,
  hiddenGroupPrefixes,
} = require("./portalHidden.util");

const MIGRATION_FLAG = "HIDDEN_PREFIX_ATTR_MIGRATION";

/** Former settings.example defaults — always stamped regardless of settings. */
const LEGACY_USER_HIDDEN_PREFIXES = ["ak-", "akadmin", "adm_", "nodered-", "ma-"];
const LEGACY_GROUP_HIDDEN_PREFIXES = ["authentik", "ma -"];

let _running = false;
let _complete = false;

function normalizePrefixList(list) {
  return [
    ...new Set(
      (Array.isArray(list) ? list : [])
        .map((p) => String(p || "").trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
}

/** Union of hardcoded legacy prefixes and any still-configured settings prefixes. */
function stampUserPrefixes() {
  return normalizePrefixList([
    ...LEGACY_USER_HIDDEN_PREFIXES,
    ...hiddenUserPrefixes(),
  ]);
}

function stampGroupPrefixes() {
  return normalizePrefixList([
    ...LEGACY_GROUP_HIDDEN_PREFIXES,
    ...hiddenGroupPrefixes(),
  ]);
}

function migrationDone() {
  if (_complete) return true;
  const settings = settingsSvc.getSettings() || {};
  return String(settings[MIGRATION_FLAG] || "") === "1";
}

async function directoryInboundReady() {
  try {
    const r = await db.query(
      `SELECT last_success_at, completed FROM directory_sync WHERE id = 1`
    );
    const row = r.rows[0];
    if (!row) return false;
    return !!(row.last_success_at || row.completed === true);
  } catch (_) {
    return false;
  }
}

async function listUsersNeedingStamp(prefixes) {
  if (!prefixes.length) return [];
  const r = await db.query(
    `SELECT id, authentik_pk, username, attributes
     FROM users
     WHERE pending_delete = false
       AND tak_portal_hidden = false
       AND EXISTS (
         SELECT 1 FROM unnest($1::text[]) AS p
         WHERE lower(username) LIKE p || '%'
       )
     ORDER BY username
     LIMIT 500`,
    [prefixes]
  );
  return r.rows;
}

async function listGroupsNeedingStamp(prefixes) {
  if (!prefixes.length) return [];
  const r = await db.query(
    `SELECT id, authentik_pk, name, attributes
     FROM groups
     WHERE pending_delete = false
       AND tak_portal_hidden = false
       AND EXISTS (
         SELECT 1 FROM unnest($1::text[]) AS p
         WHERE lower(name) LIKE p || '%'
            OR lower(regexp_replace(name, '^tak_', '', 'i')) LIKE p || '%'
       )
     ORDER BY name
     LIMIT 500`,
    [prefixes]
  );
  return r.rows;
}

async function countUsersStillNeedingStamp(prefixes) {
  if (!prefixes.length) return 0;
  const r = await db.query(
    `SELECT COUNT(*)::int AS n
     FROM users
     WHERE pending_delete = false
       AND tak_portal_hidden = false
       AND EXISTS (
         SELECT 1 FROM unnest($1::text[]) AS p
         WHERE lower(username) LIKE p || '%'
       )`,
    [prefixes]
  );
  return r.rows[0]?.n || 0;
}

async function countGroupsStillNeedingStamp(prefixes) {
  if (!prefixes.length) return 0;
  const r = await db.query(
    `SELECT COUNT(*)::int AS n
     FROM groups
     WHERE pending_delete = false
       AND tak_portal_hidden = false
       AND EXISTS (
         SELECT 1 FROM unnest($1::text[]) AS p
         WHERE lower(name) LIKE p || '%'
            OR lower(regexp_replace(name, '^tak_', '', 'i')) LIKE p || '%'
       )`,
    [prefixes]
  );
  return r.rows[0]?.n || 0;
}

async function stampUser(row) {
  const attrs = markHiddenAttributes(
    row.attributes && typeof row.attributes === "object" ? row.attributes : {}
  );
  await db.withTransaction(async (c) => {
    await directoryRepo.updateLocalUser(row.id, { attributes: attrs }, c);
    if (row.authentik_pk != null) {
      await authentikOutbox.enqueue(
        {
          kind: "patch_user",
          entityType: "user",
          entityId: row.id,
          authentikPk: row.authentik_pk,
          username: row.username,
          payload: {
            authentikPk: row.authentik_pk,
            patch: { attributes: attrs },
          },
        },
        c
      );
    }
  });
}

async function stampGroup(row) {
  const attrs = markHiddenAttributes(
    row.attributes && typeof row.attributes === "object" ? row.attributes : {}
  );
  await db.withTransaction(async (c) => {
    await directoryRepo.updateLocalGroup(row.id, { attributes: attrs }, c);
    if (row.authentik_pk != null) {
      await authentikOutbox.enqueue(
        {
          kind: "patch_group",
          entityType: "group",
          entityId: row.id,
          authentikPk: row.authentik_pk,
          payload: {
            authentikPk: row.authentik_pk,
            patch: { attributes: attrs },
          },
        },
        c
      );
    }
  });
}

function markCompleteAndClearPrefixes() {
  settingsSvc.updateSettings({
    USERS_HIDDEN_PREFIXES: "",
    GROUPS_HIDDEN_PREFIXES: "",
    [MIGRATION_FLAG]: "1",
  });
  _complete = true;
  console.log(
    "[hidden-prefix-migration] complete; cleared prefix settings"
  );
}

/**
 * Re-entrant tick: stamp batches until confirmed, then clear prefix settings.
 */
async function runOnce() {
  if (_running || migrationDone()) return { skipped: true };

  _running = true;
  try {
    const userPrefixes = stampUserPrefixes();
    const groupPrefixes = stampGroupPrefixes();

    // Wait until inbound has populated the directory at least once so Authentik
    // system accounts (ak-*, authentik*) exist locally before we mark complete.
    if (!(await directoryInboundReady())) {
      return { waiting: "directory_sync" };
    }

    const users = await listUsersNeedingStamp(userPrefixes);
    const groups = await listGroupsNeedingStamp(groupPrefixes);

    let stampedUsers = 0;
    for (const row of users) {
      try {
        await stampUser(row);
        stampedUsers += 1;
      } catch (e) {
        console.warn(
          `[hidden-prefix-migration] user ${row.username}:`,
          e?.message || e
        );
      }
    }

    let stampedGroups = 0;
    for (const row of groups) {
      try {
        await stampGroup(row);
        stampedGroups += 1;
      } catch (e) {
        console.warn(
          `[hidden-prefix-migration] group ${row.name}:`,
          e?.message || e
        );
      }
    }

    if (stampedUsers || stampedGroups) {
      console.log(
        `[hidden-prefix-migration] stamped ${stampedUsers} users, ${stampedGroups} groups`
      );
    }

    const remainingUsers = await countUsersStillNeedingStamp(userPrefixes);
    const remainingGroups = await countGroupsStillNeedingStamp(groupPrefixes);

    if (remainingUsers > 0 || remainingGroups > 0) {
      return {
        pending: true,
        remainingUsers,
        remainingGroups,
        stampedUsers,
        stampedGroups,
      };
    }

    markCompleteAndClearPrefixes();
    return { done: true, stampedUsers, stampedGroups };
  } finally {
    _running = false;
  }
}

module.exports = {
  MIGRATION_FLAG,
  ATTR_KEY,
  LEGACY_USER_HIDDEN_PREFIXES,
  LEGACY_GROUP_HIDDEN_PREFIXES,
  stampUserPrefixes,
  stampGroupPrefixes,
  runOnce,
  migrationDone,
};
