/**
 * Users page status: portal role, with " - No Logins" when they have never
 * authenticated (no active TAK cert and no Authentik last_login).
 *
 * Role and status are stored on users so the Users page can list/search/sort
 * without recomputing from groups, TAK certs, or Authentik on every request.
 * Disabled accounts stay "Disabled".
 */

const db = require("./db");
const tak = require("./tak.service");
const accessSvc = require("./access.service");
const agenciesStore = require("./agencies.service");
const { getString } = require("./env");

const ROLE_LIST_TTL_MS = 5 * 60 * 1000;

const PERMISSION_SORT_INDEX = {
  User: 1,
  "Agency Admin": 2,
  "Multi-Agency Admin": 3,
  "Global Admin": 4,
};

let _roleNameCache = { at: 0, value: null };
let _statusRefreshRunning = false;

function parseAuthentikLastLogin(v) {
  if (v == null || v === "" || v === false) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime()) || d.getTime() <= 0) return null;
  return d.toISOString();
}

function hasStoredLastLogin(v) {
  return !!parseAuthentikLastLogin(v);
}

function hasNoLogins({
  hasActiveTakCert = false,
  hasAuthentikLogin = false,
  takCertsKnown = false,
} = {}) {
  return takCertsKnown === true && !hasActiveTakCert && !hasAuthentikLogin;
}

function loginStatusLabel({
  is_active,
  hasActiveTakCert = false,
  hasAuthentikLogin = false,
  takCertsKnown = false,
  permissionLabel = "User",
} = {}) {
  if (!is_active) return "Disabled";
  const role = String(permissionLabel || "User").trim() || "User";
  if (hasNoLogins({ hasActiveTakCert, hasAuthentikLogin, takCertsKnown })) {
    return `${role} - No Logins`;
  }
  return role;
}

/**
 * 0 Disabled, then User / Agency Admin / Multi-Agency Admin / Global Admin,
 * with each role's "- No Logins" variant immediately before the logged-in one.
 */
function statusSortRank(user) {
  if (!user?.is_active) return 0;
  const role = String(user.permissionLabel || user.portal_role || "User").trim() || "User";
  const idx = PERMISSION_SORT_INDEX[role] || 1;
  const noLogins = hasNoLogins({
    hasActiveTakCert: !!user.hasActiveTakCert,
    hasAuthentikLogin: !!user.hasAuthentikLogin,
    takCertsKnown: user.takCertsKnown === true,
  });
  return idx * 2 - (noLogins ? 1 : 0);
}

function compareUsersByStatus(a, b) {
  const d = statusSortRank(a) - statusSortRank(b);
  if (d) return d;
  return String(a?.username || "").localeCompare(String(b?.username || ""), undefined, {
    sensitivity: "base",
  });
}

function applyStoredStatusFields(user) {
  if (!user) return user;
  const permissionLabel =
    String(user.permissionLabel || user.portal_role || "").trim() || "User";
  const hasAuthentikLogin = hasStoredLastLogin(user.last_login) || !!user.hasAuthentikLogin;
  const hasActiveTakCert = !!user.hasActiveTakCert;
  const storedLabel = String(user.statusLabel || user.status_label || "").trim();
  return {
    ...user,
    permissionLabel,
    hasAuthentikLogin,
    hasActiveTakCert,
    statusLabel:
      storedLabel ||
      loginStatusLabel({
        is_active: !!user.is_active,
        hasActiveTakCert,
        hasAuthentikLogin,
        takCertsKnown: user.takCertsKnown === true,
        permissionLabel,
      }),
  };
}

function annotateUsersLoginStatus(users) {
  return (Array.isArray(users) ? users : []).map(applyStoredStatusFields);
}

function getPortalRoleNameLists() {
  const now = Date.now();
  if (_roleNameCache.value && now - _roleNameCache.at < ROLE_LIST_TTL_MS) {
    return _roleNameCache.value;
  }

  const globalNames = String(getString("PORTAL_AUTH_REQUIRED_GROUP", "") || "")
    .split(",")
    .map((g) => String(g || "").trim().toLowerCase())
    .filter(Boolean);

  const adminNames = [];
  const adminSuffixes = [];
  const agencies = agenciesStore.load() || [];
  for (const ag of agencies) {
    const sfx = String(ag?.suffix || "").trim().toLowerCase();
    if (!sfx) continue;
    const seen = new Set();
    for (const n of accessSvc.getAgencyAdminGroupNamesForAgency(ag) || []) {
      const key = String(n || "").trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      adminNames.push(key);
      adminSuffixes.push(sfx);
    }
  }

  const value = { globalNames, adminNames, adminSuffixes };
  _roleNameCache = { at: now, value };
  return value;
}

const STATUS_LABEL_SQL = `CASE
  WHEN COALESCE(u.is_active, false) = false THEN 'Disabled'
  WHEN COALESCE(d.tak_certs_known, false) = true
    AND u.last_login IS NULL
    AND COALESCE(u.has_active_tak_cert, false) = false
    THEN COALESCE(NULLIF(btrim(u.portal_role), ''), 'User') || ' - No Logins'
  ELSE COALESCE(NULLIF(btrim(u.portal_role), ''), 'User')
END`;

const STATUS_RANK_SQL = `CASE
  WHEN COALESCE(u.is_active, false) = false THEN 0
  ELSE (
    CASE COALESCE(NULLIF(btrim(u.portal_role), ''), 'User')
      WHEN 'Agency Admin' THEN 2
      WHEN 'Multi-Agency Admin' THEN 3
      WHEN 'Global Admin' THEN 4
      ELSE 1
    END
  ) * 2 - CASE
    WHEN COALESCE(d.tak_certs_known, false) = true
      AND u.last_login IS NULL
      AND COALESCE(u.has_active_tak_cert, false) = false
      THEN 1
    ELSE 0
  END
END`;

async function refreshPortalRoleColumns(userIds) {
  const { globalNames, adminNames, adminSuffixes } = getPortalRoleNameLists();
  const ids = (Array.isArray(userIds) ? userIds : [])
    .map((id) => String(id || "").trim())
    .filter(Boolean);
  const params = [globalNames, adminNames, adminSuffixes];
  let memberFilter = "";
  let userFilter = "";
  if (ids.length) {
    params.push(ids);
    memberFilter = `WHERE gm.user_id = ANY($4::uuid[])`;
    userFilter = `WHERE u2.id = ANY($4::uuid[])`;
  }
  await db.query(
    `UPDATE users u
     SET portal_role = v.portal_role
     FROM (
       SELECT
         u2.id,
         CASE
           WHEN COALESCE(mr.is_global, false) THEN 'Global Admin'
           WHEN COALESCE(mr.agency_admin_count, 0) > 1 THEN 'Multi-Agency Admin'
           WHEN COALESCE(mr.agency_admin_count, 0) >= 1 THEN 'Agency Admin'
           ELSE 'User'
         END AS portal_role
       FROM users u2
       LEFT JOIN (
         SELECT
           gm.user_id,
           BOOL_OR(lower(g.name) = ANY($1::text[])) AS is_global,
           COUNT(DISTINCT am.suffix) FILTER (WHERE am.suffix IS NOT NULL) AS agency_admin_count
         FROM group_members gm
         JOIN groups g ON g.id = gm.group_id
         LEFT JOIN unnest($2::text[], $3::text[]) AS am(name, suffix)
           ON lower(g.name) = am.name
         ${memberFilter}
         GROUP BY gm.user_id
       ) mr ON mr.user_id = u2.id
       ${userFilter}
     ) v
     WHERE u.id = v.id
       AND u.portal_role IS DISTINCT FROM v.portal_role`,
    params
  );
}

async function refreshTakCertFlags() {
  const takResult = await tak.getActiveCertUsernameSet().catch(() => ({
    ok: false,
    usernames: new Set(),
  }));
  if (!takResult || !takResult.ok) return false;

  const usernames = Array.from(takResult.usernames || []).map((s) =>
    String(s || "").trim().toLowerCase()
  );
  await db.query(
    `UPDATE users
     SET has_active_tak_cert = (lower(username) = ANY($1::text[]))
     WHERE pending_delete = false
       AND has_active_tak_cert IS DISTINCT FROM (lower(username) = ANY($1::text[]))`,
    [usernames]
  );
  await db.query(
    `UPDATE directory_sync
     SET tak_certs_known = true, tak_certs_checked_at = now()
     WHERE id = 1`
  );
  return true;
}

async function refreshStatusLabelColumns() {
  await db.query(
    `UPDATE users u
     SET
       status_label = v.status_label,
       status_sort_rank = v.status_sort_rank
     FROM (
       SELECT
         u.id,
         ${STATUS_LABEL_SQL} AS status_label,
         ${STATUS_RANK_SQL} AS status_sort_rank
       FROM users u
       CROSS JOIN directory_sync d
       WHERE d.id = 1
     ) v
     WHERE u.id = v.id
       AND (
         u.status_label IS DISTINCT FROM v.status_label
         OR u.status_sort_rank IS DISTINCT FROM v.status_sort_rank
       )`
  );
}

async function refreshStoredStatusForUserIds(userIds) {
  const ids = (Array.isArray(userIds) ? userIds : [])
    .map((id) => String(id || "").trim())
    .filter(Boolean);
  if (!ids.length) return;
  await refreshPortalRoleColumns(ids);
  await db.query(
    `UPDATE users u
     SET
       status_label = v.status_label,
       status_sort_rank = v.status_sort_rank
     FROM (
       SELECT
         u.id,
         ${STATUS_LABEL_SQL} AS status_label,
         ${STATUS_RANK_SQL} AS status_sort_rank
       FROM users u
       CROSS JOIN directory_sync d
       WHERE d.id = 1
         AND u.id = ANY($1::uuid[])
     ) v
     WHERE u.id = v.id
       AND (
         u.status_label IS DISTINCT FROM v.status_label
         OR u.status_sort_rank IS DISTINCT FROM v.status_sort_rank
       )`,
    [ids]
  );
}

/**
 * Worker/sync: write portal_role, TAK cert flags, and status_label in Postgres.
 * includeTakCerts=false still refreshes role + label from the last successful cert snapshot.
 */
async function refreshStoredUserStatus({ includeTakCerts = true } = {}) {
  if (_statusRefreshRunning) return;
  _statusRefreshRunning = true;
  try {
    await refreshPortalRoleColumns();
    if (includeTakCerts) await refreshTakCertFlags();
    await refreshStatusLabelColumns();
  } catch (e) {
    console.warn("[user-status] refresh failed:", e?.message || e);
  } finally {
    _statusRefreshRunning = false;
  }
}

module.exports = {
  parseAuthentikLastLogin,
  hasStoredLastLogin,
  hasNoLogins,
  loginStatusLabel,
  statusSortRank,
  compareUsersByStatus,
  applyStoredStatusFields,
  annotateUsersLoginStatus,
  getPortalRoleNameLists,
  refreshStoredUserStatus,
  refreshStoredStatusForUserIds,
};
