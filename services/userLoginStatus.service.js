/**
 * Users page status: Enabled / Enabled - No Logins / Disabled.
 *
 * "No Logins" = enabled, TAK cert catalog is known, no active (unrevoked,
 * unexpired) cert for creatorDn == username, and Authentik has no last_login.
 * A successful Authentik login flips the row back to Enabled.
 */

const api = require("./authentik");
const db = require("./db");
const tak = require("./tak.service");

const AUTHENTIK_LOGIN_CONCURRENCY = 8;

function parseAuthentikLastLogin(v) {
  if (v == null || v === "" || v === false) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime()) || d.getTime() <= 0) return null;
  return d.toISOString();
}

function hasStoredLastLogin(v) {
  return !!parseAuthentikLastLogin(v);
}

function loginStatusLabel({
  is_active,
  hasActiveTakCert = false,
  hasAuthentikLogin = false,
  takCertsKnown = false,
} = {}) {
  if (!is_active) return "Disabled";
  if (hasActiveTakCert || hasAuthentikLogin) return "Enabled";
  if (takCertsKnown) return "Enabled - No Logins";
  return "Enabled";
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

async function annotateUsersLoginStatus(users) {
  const list = Array.isArray(users) ? users : [];
  if (!list.length) return list;

  const anyEnabled = list.some((u) => u && u.is_active);
  let takCertsKnown = false;
  let certUsernames = new Set();
  if (anyEnabled) {
    const takResult = await tak.getActiveCertUsernameSet().catch(() => ({
      ok: false,
      usernames: new Set(),
    }));
    takCertsKnown = !!takResult.ok;
    certUsernames = takResult.usernames instanceof Set ? takResult.usernames : new Set();
  }

  const liveLogins = anyEnabled
    ? await fetchLiveAuthentikLogins(list, certUsernames, takCertsKnown)
    : new Map();

  return list.map((u) => {
    const uname = String(u?.username || "").trim().toLowerCase();
    const hasActiveTakCert = !!(takCertsKnown && uname && certUsernames.has(uname));
    const liveIso = u?.pk != null ? liveLogins.get(String(u.pk)) : null;
    const hasAuthentikLogin = hasStoredLastLogin(u?.last_login) || !!liveIso;
    const statusLabel = loginStatusLabel({
      is_active: !!u?.is_active,
      hasActiveTakCert,
      hasAuthentikLogin,
      takCertsKnown,
    });
    return {
      ...u,
      last_login: liveIso || u?.last_login || null,
      hasActiveTakCert,
      hasAuthentikLogin,
      takCertsKnown,
      statusLabel,
    };
  });
}

module.exports = {
  parseAuthentikLastLogin,
  hasStoredLastLogin,
  loginStatusLabel,
  annotateUsersLoginStatus,
};
