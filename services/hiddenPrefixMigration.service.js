/**
 * One-time: stamp tak_portal_hidden on users/groups matching legacy hidden
 * prefixes, then blank USERS_HIDDEN_PREFIXES / GROUPS_HIDDEN_PREFIXES.
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
let _running = false;
let _complete = false;

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
    const userPrefixes = hiddenUserPrefixes();
    const groupPrefixes = hiddenGroupPrefixes();

    if (!userPrefixes.length && !groupPrefixes.length) {
      settingsSvc.updateSettings({ [MIGRATION_FLAG]: "1" });
      _complete = true;
      console.log(
        "[hidden-prefix-migration] prefixes already empty; marked complete"
      );
      return { done: true, stampedUsers: 0, stampedGroups: 0 };
    }

    // Wait until inbound has populated the directory at least once so we do not
    // blank prefixes before Authentik system accounts exist locally.
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
  runOnce,
  migrationDone,
};
