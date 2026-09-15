/**
 * Users page status: portal role, with " - No Logins" when they have never
 * authenticated (no active TAK cert and no Authentik last_login).
 *
 * Disabled accounts stay "Disabled".
 */

const api = require("./authentik");
const db = require("./db");
const tak = require("./tak.service");
const directoryRepo = require("./directoryRepo.service");
const authzRoles = require("./authzRoles.service");
const accessSvc = require("./access.service");
const agenciesStore = require("./agencies.service");
const { getString } = require("./env");

const AUTHENTIK_LOGIN_CONCURRENCY = 8;
const ROLE_SORT_TTL_MS = 5 * 60 * 1000;

const PERMISSION_SORT_INDEX = {
  User: 1,
  "Agency Admin": 2,
  "Multi-Agency Admin": 3,
  "Global Admin": 4,
};

let _roleSortCache = { at: 0, value: null };

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
  const role = String(user.permissionLabel || "User").trim() || "User";
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

async function getPortalRoleSortContext() {
  const now = Date.now();
  if (_roleSortCache.value && now - _roleSortCache.at < ROLE_SORT_TTL_MS) {
    return _roleSortCache.value;
  }

  const globalNames = String(getString("PORTAL_AUTH_REQUIRED_GROUP", "") || "")
    .split(",")
    .map((g) => String(g || "").trim())
    .filter(Boolean);
  const globalGroups = globalNames.length
    ? await directoryRepo.getGroupsByNames(globalNames)
    : [];
  const globalAdminGroupPks = (Array.isArray(globalGroups) ? globalGroups : [])
    .map((g) => (g?.pk != null ? String(g.pk) : ""))
    .filter(Boolean);

  const agencies = agenciesStore.load() || [];
  const names = [];
  const nameToSuffix = new Map();
  for (const ag of agencies) {
    const sfx = String(ag?.suffix || "").trim().toLowerCase();
    if (!sfx) continue;
    for (const n of accessSvc.getAgencyAdminGroupNamesForAgency(ag) || []) {
      const key = String(n || "").trim().toLowerCase();
      if (!key) continue;
      names.push(n);
      nameToSuffix.set(key, sfx);
    }
  }
  const adminGroups = names.length ? await directoryRepo.getGroupsByNames(names) : [];
  const agencyAdminGroupPks = [];
  const agencyAdminGroupSuffixes = [];
  for (const g of Array.isArray(adminGroups) ? adminGroups : []) {
    const sfx = nameToSuffix.get(String(g?.name || "").trim().toLowerCase());
    const pk = g?.pk != null ? String(g.pk) : "";
    const id = g?.id != null ? String(g.id) : "";
    if (!sfx) continue;
    if (pk) {
      agencyAdminGroupPks.push(pk);
      agencyAdminGroupSuffixes.push(sfx);
    }
    if (id && id !== pk) {
      agencyAdminGroupPks.push(id);
      agencyAdminGroupSuffixes.push(sfx);
    }
  }

  const value = {
    globalAdminGroupPks,
    agencyAdminGroupPks,
    agencyAdminGroupSuffixes,
  };
  _roleSortCache = { at: now, value };
  return value;
}

function groupNameMapFromGroups(groups) {
  const map = new Map();
  for (const g of Array.isArray(groups) ? groups : []) {
    const name = String(g?.name || "").trim();
    if (!name) continue;
    if (g.pk != null) map.set(String(g.pk), name);
    if (g.id != null) map.set(String(g.id), name);
    if (g.authentik_pk != null) map.set(String(g.authentik_pk), name);
  }
  return map;
}

async function groupNameByPkForUsers(users, existing) {
  if (existing instanceof Map) return existing;
  const pks = [];
  for (const u of Array.isArray(users) ? users : []) {
    for (const g of Array.isArray(u?.groups) ? u.groups : []) {
      const pk = String(g || "").trim();
      if (pk) pks.push(pk);
    }
  }
  if (!pks.length) return new Map();
  const named = await directoryRepo.getGroupsByPks(pks);
  return groupNameMapFromGroups(named);
}

function permissionLabelForUser(user, groupNameByPk) {
  const names = (Array.isArray(user?.groups) ? user.groups : [])
    .map((gid) => String(groupNameByPk.get(String(gid)) || "").trim())
    .filter(Boolean);
  return authzRoles.portalPermissionLabelFromGroupNames(names);
}

async function mapLimit(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  const results = new Array(list.length);
  let next = 0;
  const n = Math.max(1, Math.min(limit, list.length));
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= list.length) return;
      results[i] = await fn(list[i], i);
    }
  }
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

async function persistLastLogin(authentikPk, iso) {
  const pk = String(authentikPk || "").trim();
  if (!pk || !iso) return;
  try {
    await db.query(
      `UPDATE users
       SET last_login = $2::timestamptz, updated_at = now()
       WHERE authentik_pk = $1
         AND (last_login IS NULL OR last_login < $2::timestamptz)`,
      [pk, iso]
    );
  } catch {
    // Listing still works if the column is missing or the write fails.
  }
}

async function fetchAuthentikLastLogin(user) {
  const pk = user?.pk != null ? String(user.pk).trim() : "";
  if (!pk) return null;
  try {
    const res = await api.get(`/core/users/${encodeURIComponent(pk)}/`, { timeout: 5000 });
    return parseAuthentikLastLogin(res?.data?.last_login);
  } catch {
    return null;
  }
}

/**
 * For enabled users on this page with no stored last_login and no active TAK
 * cert, ask Authentik whether they have ever authenticated.
 */
async function fetchLiveAuthentikLogins(users, certUsernames, takCertsKnown) {
  const found = new Map();
  const candidates = (Array.isArray(users) ? users : []).filter((u) => {
    if (!u?.is_active) return false;
    if (hasStoredLastLogin(u.last_login)) return false;
    const uname = String(u.username || "").trim().toLowerCase();
    if (takCertsKnown && uname && certUsernames.has(uname)) return false;
    return !!(u.pk != null && String(u.pk).trim());
  });
  if (!candidates.length) return found;

  const deadline = Date.now() + 8000;
  await mapLimit(candidates, AUTHENTIK_LOGIN_CONCURRENCY, async (u) => {
    if (Date.now() > deadline) return;
    const iso = await fetchAuthentikLastLogin(u);
    if (!iso) return;
    found.set(String(u.pk), iso);
    void persistLastLogin(u.pk, iso);
  });
  return found;
}

async function annotateUsersLoginStatus(users, opts = {}) {
  const list = Array.isArray(users) ? users : [];
  if (!list.length) return list;

  const anyEnabled = list.some((u) => u && u.is_active);
  let takCertsKnown = false;
  let certUsernames = new Set();
  if (opts.takResult) {
    takCertsKnown = !!opts.takResult.ok;
    certUsernames =
      opts.takResult.usernames instanceof Set
        ? opts.takResult.usernames
        : new Set(opts.takResult.usernames || []);
  } else if (anyEnabled) {
    const takResult = await tak.getActiveCertUsernameSet().catch(() => ({
      ok: false,
      usernames: new Set(),
    }));
    takCertsKnown = !!takResult.ok;
    certUsernames = takResult.usernames instanceof Set ? takResult.usernames : new Set();
  }

  const groupNameByPk = await groupNameByPkForUsers(list, opts.groupNameByPk);

  const liveLogins = anyEnabled
    ? await fetchLiveAuthentikLogins(list, certUsernames, takCertsKnown)
    : new Map();

  return list.map((u) => {
    const uname = String(u?.username || "").trim().toLowerCase();
    const hasActiveTakCert = !!(takCertsKnown && uname && certUsernames.has(uname));
    const liveIso = u?.pk != null ? liveLogins.get(String(u.pk)) : null;
    const hasAuthentikLogin = hasStoredLastLogin(u?.last_login) || !!liveIso;
    const permissionLabel = permissionLabelForUser(u, groupNameByPk);
    const statusLabel = loginStatusLabel({
      is_active: !!u?.is_active,
      hasActiveTakCert,
      hasAuthentikLogin,
      takCertsKnown,
      permissionLabel,
    });
    return {
      ...u,
      last_login: liveIso || u?.last_login || null,
      hasActiveTakCert,
      hasAuthentikLogin,
      takCertsKnown,
      permissionLabel,
      statusLabel,
    };
  });
}

module.exports = {
  parseAuthentikLastLogin,
  hasStoredLastLogin,
  hasNoLogins,
  loginStatusLabel,
  statusSortRank,
  compareUsersByStatus,
  getPortalRoleSortContext,
  annotateUsersLoginStatus,
};
