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
  BUILTIN_USER_HIDDEN_PREFIXES,
  BUILTIN_GROUP_HIDDEN_PREFIXES,
  markHiddenAttributes,
  normalizePrefixList,
  hiddenUserPrefixes,
  hiddenGroupPrefixes,
  usernameMatchesHiddenPrefix,
  isInternalPortalGroupName,
  portalAuthRequiredGroupNames,
} = require("./portalHidden.util");

const MIGRATION_FLAG = "HIDDEN_PREFIX_ATTR_MIGRATION";

/** @deprecated Prefer BUILTIN_* from portalHidden.util — kept for test/export stability. */
const LEGACY_USER_HIDDEN_PREFIXES = BUILTIN_USER_HIDDEN_PREFIXES;
const LEGACY_GROUP_HIDDEN_PREFIXES = BUILTIN_GROUP_HIDDEN_PREFIXES;

let _running = false;
let _complete = false;

/** Builtin + settings prefixes (hiddenUserPrefixes already includes builtins). */
function stampUserPrefixes() {
  return normalizePrefixList(hiddenUserPrefixes());
}

function stampGroupPrefixes() {
  return normalizePrefixList(hiddenGroupPrefixes());
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

/**
 * Groups whose name equals a configured PORTAL_AUTH_REQUIRED_GROUP entry
 * (case-insensitive; optional leading tak_ on either side).
 */
async function listGroupsNeedingStampByExactNames(names) {
  const list = (Array.isArray(names) ? names : [])
    .map((n) => String(n || "").trim())
    .filter(Boolean);
  if (!list.length) return [];
  const r = await db.query(
    `SELECT id, authentik_pk, name, attributes
     FROM groups
     WHERE pending_delete = false
       AND tak_portal_hidden = false
       AND EXISTS (
         SELECT 1 FROM unnest($1::text[]) AS n
         WHERE lower(name) = lower(n)
            OR lower(regexp_replace(name, '^tak_', '', 'i')) = lower(n)
            OR lower(name) = lower(regexp_replace(n, '^tak_', '', 'i'))
            OR lower(regexp_replace(name, '^tak_', '', 'i')) =
               lower(regexp_replace(n, '^tak_', '', 'i'))
       )
     ORDER BY name
     LIMIT 500`,
    [list]
  );
  return r.rows;
}

async function countGroupsStillNeedingStampByExactNames(names) {
  const list = (Array.isArray(names) ? names : [])
    .map((n) => String(n || "").trim())
    .filter(Boolean);
  if (!list.length) return 0;
  const r = await db.query(
    `SELECT COUNT(*)::int AS n
     FROM groups
     WHERE pending_delete = false
       AND tak_portal_hidden = false
       AND EXISTS (
         SELECT 1 FROM unnest($1::text[]) AS n
         WHERE lower(name) = lower(n)
            OR lower(regexp_replace(name, '^tak_', '', 'i')) = lower(n)
            OR lower(name) = lower(regexp_replace(n, '^tak_', '', 'i'))
            OR lower(regexp_replace(name, '^tak_', '', 'i')) =
               lower(regexp_replace(n, '^tak_', '', 'i'))
       )`,
    [list]
  );
  return r.rows[0]?.n || 0;
}

/** AgencyAdmin groups that never got (or lost) tak_portal_hidden after Authentik sync. */
async function listAgencyAdminGroupsNeedingStamp() {
  const r = await db.query(
    `SELECT id, authentik_pk, name, attributes
     FROM groups
     WHERE pending_delete = false
       AND tak_portal_hidden = false
       AND (
         lower(name) LIKE '%agencyadmin%'
         OR lower(regexp_replace(name, '^tak_', '', 'i')) LIKE '%agencyadmin%'
       )
     ORDER BY name
     LIMIT 500`
  );
  return r.rows;
}

/** Re-entrant: stamp global-admin + AgencyAdmin groups even after prefix migration completed. */
async function stampPortalAuthRequiredGroups() {
  const names = portalAuthRequiredGroupNames();
  const byId = new Map();
  for (const row of await listGroupsNeedingStampByExactNames(names)) {
    byId.set(String(row.id), row);
  }
  for (const row of await listAgencyAdminGroupsNeedingStamp()) {
    byId.set(String(row.id), row);
  }
  let stampedGlobalAdminGroups = 0;
  for (const row of byId.values()) {
    try {
      await stampGroup(row);
      stampedGlobalAdminGroups += 1;
    } catch (e) {
      console.warn(
        `[hidden-prefix-migration] admin group ${row.name}:`,
        e?.message || e
      );
    }
  }
  if (stampedGlobalAdminGroups) {
    console.log(
      `[hidden-prefix-migration] stamped ${stampedGlobalAdminGroups} admin/AgencyAdmin group(s)`
    );
  }
  return { stampedGlobalAdminGroups };
}

/** Re-entrant: local-stamp builtin-prefix users (ak-outpost-*, etc.) after migration. */
async function stampBuiltinPrefixUsers() {
  const prefixes = stampUserPrefixes();
  const users = await listUsersNeedingStamp(prefixes);
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
  if (stampedUsers) {
    console.log(
      `[hidden-prefix-migration] stamped ${stampedUsers} builtin-prefix user(s)`
    );
  }
  return { stampedBuiltinUsers: stampedUsers };
}

/** Re-entrant: local-stamp authentik* / ma - groups that lost tak_portal_hidden. */
async function stampBuiltinPrefixGroups() {
  const prefixes = stampGroupPrefixes();
  const groups = await listGroupsNeedingStamp(prefixes);
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
  if (stampedGroups) {
    console.log(
      `[hidden-prefix-migration] stamped ${stampedGroups} builtin-prefix group(s)`
    );
  }
  return { stampedBuiltinGroups: stampedGroups };
}

async function stampUser(row) {
  const attrs = markHiddenAttributes(
    row.attributes && typeof row.attributes === "object" ? row.attributes : {}
  );
  // Authentik internal service accounts (ak-outpost-*, etc.) reject attribute writes.
  // Keep the portal column/attrs local-only; inbound sync force-hides by prefix.
  const skipAuthentikPatch = usernameMatchesHiddenPrefix(row.username);
  await db.withTransaction(async (c) => {
    await directoryRepo.updateLocalUser(row.id, { attributes: attrs }, c);
    if (!skipAuthentikPatch && row.authentik_pk != null) {
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
  // AgencyAdmin / authentik* / global-admin: keep local; sync force-hides by name.
  const skipAuthentikPatch = isInternalPortalGroupName(row.name);
  await db.withTransaction(async (c) => {
    await directoryRepo.updateLocalGroup(row.id, { attributes: attrs }, c);
    if (!skipAuthentikPatch && row.authentik_pk != null) {
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
 * After complete, keeps re-stamping AgencyAdmin / global-admin groups and
 * builtin-prefix users (ak-outpost-*) locally — Authentik often omits the attr.
 */
async function runOnce() {
  if (_running) return { skipped: true };

  _running = true;
  try {
    // Always re-check on every tick / process start — Authentik inbound often
    // omits tak_portal_hidden, which would otherwise resurface ak-outpost-* and
    // AgencyAdmin in the UI after migration completed.
    const globalAdminResult = await stampPortalAuthRequiredGroups();
    const builtinUserResult = await stampBuiltinPrefixUsers();
    const builtinGroupResult = await stampBuiltinPrefixGroups();

    if (migrationDone()) {
      return {
        skipped: true,
        ...globalAdminResult,
        ...builtinUserResult,
        ...builtinGroupResult,
      };
    }

    const userPrefixes = stampUserPrefixes();
    const groupPrefixes = stampGroupPrefixes();
    const globalAdminNames = portalAuthRequiredGroupNames();

    // Wait until inbound has populated the directory at least once so Authentik
    // system accounts (ak-*, authentik*) exist locally before we mark complete.
    if (!(await directoryInboundReady())) {
      return { waiting: "directory_sync", ...globalAdminResult };
    }

    const users = await listUsersNeedingStamp(userPrefixes);
    const groups = await listGroupsNeedingStamp(groupPrefixes);
    // Also stamp exact global-admin names during the prefix pass (idempotent).
    const exactGroups = await listGroupsNeedingStampByExactNames(globalAdminNames);
    const groupRowsById = new Map();
    for (const row of [...groups, ...exactGroups]) {
      groupRowsById.set(String(row.id), row);
    }

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
    for (const row of groupRowsById.values()) {
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
    const remainingGroups =
      (await countGroupsStillNeedingStamp(groupPrefixes)) +
      (await countGroupsStillNeedingStampByExactNames(globalAdminNames));

    if (remainingUsers > 0 || remainingGroups > 0) {
      return {
        pending: true,
        remainingUsers,
        remainingGroups,
        stampedUsers,
        stampedGroups,
        ...globalAdminResult,
      };
    }

    markCompleteAndClearPrefixes();
    return { done: true, stampedUsers, stampedGroups, ...globalAdminResult };
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
  portalAuthRequiredGroupNames,
  stampPortalAuthRequiredGroups,
  runOnce,
  migrationDone,
};
