const api = require("./authentik");
const db = require("./db");
const cryptoSecrets = require("./cryptoSecrets");

const TOKEN_DESCRIPTION = "TAK Portal Enrollment";
const IDENT_PREFIX = "tak-portal-enroll-";
const CACHE_MIN_REMAINING_MS = 30 * 1000;

function toIso(dt) {
  return dt instanceof Date ? dt.toISOString() : new Date(dt).toISOString();
}

function parseExpires(tokenObj) {
  const raw = tokenObj && tokenObj.expires;
  if (!raw) return null;
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

async function getUserIdByUsername(username) {
  const u = String(username || "").trim();
  if (!u) throw new Error("Missing username");

  try {
    const directoryRepo = require("./directoryRepo.service");
    const local = await directoryRepo.getUserByUsername(u);
    if (local && local.authentik_pk != null) return local.authentik_pk;
  } catch (_) {
    // Fall through to Authentik if the directory is unavailable.
  }

  // Authentik can vary here; be resilient:
  // 1) try exact-style filter
  // 2) fallback to search
  const tries = [
    { username: u, page_size: 100 },
    { search: u, page_size: 100 },
  ];

  for (const params of tries) {
    const res = await api.get("/core/users/", { params });
    const results = Array.isArray(res?.data?.results) ? res.data.results : [];
    const exact = results.find((x) => String(x?.username || "") === u);
    if (exact) return exact.pk ?? exact.id;
  }

  throw new Error(`Unable to resolve Authentik user id for "${u}"`);
}

async function listUserAppPasswordsByUserId(resolvedUserId) {
  const res = await api.get("/core/tokens/", {
    params: {
      intent: "app_password",
      user: resolvedUserId, // ✅ FIX: use the argument
      ordering: "-expires",
      page_size: 200,
    },
  });

  // Some Authentik versions accept the `user=` filter but may still return
  // broader results depending on permissions. Always hard-filter client-side
  // to prevent leaking/reusing another user's token.
  const results = Array.isArray(res?.data?.results) ? res.data.results : [];
  const pk = String(resolvedUserId);
  return results.filter((t) => {
    // Token user can be a pk or an object depending on API version/serializer.
    const u = t?.user;
    const tokenUserPk = (u && typeof u === "object") ? (u.pk ?? u.id) : u;
    return String(tokenUserPk ?? "") === pk;
  });
}

async function viewTokenKey(identifier) {
  const ident = String(identifier || "").trim();
  if (!ident) throw new Error("Missing token identifier");

  const res = await api.get(`/core/tokens/${encodeURIComponent(ident)}/view_key/`);
  const key = res?.data?.key || res?.data?.token || res?.data?.value;
  if (!key) throw new Error("Authentik did not return a token key");
  return key;
}

async function createAppPasswordForUserId(userId, expiresAt) {
  const identifier = `${IDENT_PREFIX}${Date.now()}-${Math.random()
    .toString(16)
    .slice(2, 10)}`;

  const payload = {
    identifier,
    intent: "app_password",
    user: userId,
    description: TOKEN_DESCRIPTION,
    expiring: true,
    expires: toIso(expiresAt),
  };

  const res = await api.post("/core/tokens/", payload);
  const created = res?.data || {};
  return created.identifier || identifier;
}

async function readCachedEnrollment(authentikUserPk) {
  const pk = String(authentikUserPk || "").trim();
  if (!pk) return null;
  try {
    const r = await db.query(
      `SELECT identifier, key_enc, expires_at
         FROM enrollment_app_passwords
        WHERE authentik_user_pk = $1
          AND expires_at > now() + interval '30 seconds'`,
      [pk]
    );
    const row = r.rows[0];
    if (!row) return null;
    const key = cryptoSecrets.decryptSecret(row.key_enc);
    if (!key) return null;
    return {
      identifier: String(row.identifier || "").trim(),
      key,
      expiresAt: toIso(row.expires_at),
    };
  } catch (err) {
    console.warn(
      "[authentikTokens] enrollment cache read failed:",
      err?.message || err
    );
    return null;
  }
}

async function writeCachedEnrollment(authentikUserPk, payload) {
  const pk = String(authentikUserPk || "").trim();
  const identifier = String(payload?.identifier || "").trim();
  const key = String(payload?.key || "").trim();
  if (!pk || !identifier || !key) return;
  try {
    await db.query(
      `INSERT INTO enrollment_app_passwords
         (authentik_user_pk, identifier, key_enc, expires_at, updated_at)
       VALUES ($1, $2, $3, $4::timestamptz, now())
       ON CONFLICT (authentik_user_pk) DO UPDATE SET
         identifier = EXCLUDED.identifier,
         key_enc = EXCLUDED.key_enc,
         expires_at = EXCLUDED.expires_at,
         updated_at = now()`,
      [pk, identifier, cryptoSecrets.encryptSecret(key), payload.expiresAt]
    );
  } catch (err) {
    console.warn(
      "[authentikTokens] enrollment cache write failed:",
      err?.message || err
    );
  }
}

async function pruneExpiredEnrollmentCache() {
  try {
    await db.query(
      `DELETE FROM enrollment_app_passwords WHERE expires_at < now()`
    );
  } catch (err) {
    console.warn(
      "[authentikTokens] enrollment cache prune failed:",
      err?.message || err
    );
  }
}

/**
 * Return an existing (non-expired) enrollment token for this user, or create one.
 * Reuses within TTL window to avoid multiple active tokens per user.
 */
async function getOrCreateEnrollmentAppPassword(params, ttlMinutes = 15) {
  // Backwards-compatible signature:
  //   getOrCreateEnrollmentAppPassword(username, ttlMinutes)
  //   getOrCreateEnrollmentAppPassword({ username, userId, ttlMinutes })
  let username = params;
  let userId = null;

  if (params && typeof params === "object") {
    username = params.username;
    userId = params.userId || params.uid || null;
    if (typeof params.ttlMinutes === "number") ttlMinutes = params.ttlMinutes;
  }

  const u = String(username || "").trim();
  if (!u) throw new Error("Missing username");

  const now = new Date();
  const directoryRepo = require("./directoryRepo.service");
  const cleanedUserId = userId ? String(userId).trim() : "";
  let resolvedUserId = null;
  if (cleanedUserId) {
    const existing = await directoryRepo.getUserById(cleanedUserId).catch(() => null);
    if (existing && existing.authentik_pk != null) {
      resolvedUserId = String(existing.authentik_pk);
    } else if (/^\d+$/.test(cleanedUserId)) {
      resolvedUserId = cleanedUserId;
    }
  }
  if (!resolvedUserId) {
    try {
      resolvedUserId = String(await directoryRepo.waitForAuthentikPk(u, 15000));
    } catch (e) {
      if (e && e.code === "AUTHENTIK_SYNC_PENDING") throw e;
      throw new Error("Still syncing to Authentik — try again in a moment.");
    }
  }

  const cached = await readCachedEnrollment(resolvedUserId);
  if (cached && cached.identifier && cached.key) {
    const exp = new Date(cached.expiresAt).getTime();
    if (Number.isFinite(exp) && exp - now.getTime() > CACHE_MIN_REMAINING_MS) {
      return cached;
    }
  }

  const tokens = await listUserAppPasswordsByUserId(resolvedUserId);

  const candidate = tokens
    .filter((t) => {
      const d = String(t?.description || "");
      const ident = String(t?.identifier || "");
      return d === TOKEN_DESCRIPTION || ident.startsWith(IDENT_PREFIX);
    })
    .map((t) => ({ t, expires: parseExpires(t) }))
    .filter((x) => x.expires && x.expires.getTime() > now.getTime() + CACHE_MIN_REMAINING_MS)
    .sort((a, b) => b.expires.getTime() - a.expires.getTime())[0];

  const createdExpires = new Date(now.getTime() + ttlMinutes * 60 * 1000);
  const identifier = candidate
    ? String(candidate.t.identifier)
    : await createAppPasswordForUserId(resolvedUserId, createdExpires);

  const expires = candidate?.expires || createdExpires;
  const key = await viewTokenKey(identifier);
  const result = {
    identifier,
    key,
    expiresAt: toIso(expires),
  };
  await writeCachedEnrollment(resolvedUserId, result);
  return result;
}

module.exports = {
  getUserIdByUsername,
  getOrCreateEnrollmentAppPassword,
  pruneExpiredEnrollmentCache,
  TOKEN_DESCRIPTION,
  IDENT_PREFIX,
};
