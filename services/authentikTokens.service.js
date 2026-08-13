const api = require("./authentik");
const { toSafeApiError } = require("./apiErrorPayload.service");

const TOKEN_DESCRIPTION = "TAK Portal Enrollment";
const IDENT_PREFIX = "tak-portal-enroll-";

const DATA_PACKAGE_TOKEN_DESCRIPTION = "TAK Portal Data Package";
const DATA_PACKAGE_IDENT_PREFIX = "tak-portal-dp-";
const DATA_PACKAGE_TTL_MINUTES = 30 * 24 * 60; // 30 days (when Authentik allows it)

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

/** Only expiring tokens with a future expires timestamp are reusable. */
function isTokenStillValid(tokenObj, now = new Date()) {
  if (!tokenObj) return false;
  if (tokenObj.expiring === false) return false;
  const expires = parseExpires(tokenObj);
  return !!(expires && expires.getTime() > now.getTime());
}

function authentikError(err, fallback) {
  const msg = toSafeApiError(err) || fallback || err?.message || "Authentik request failed";
  const e = new Error(msg);
  e.status = Number(err?.response?.status || err?.status) || 500;
  return e;
}

function isExpiresTooFarError(err) {
  const msg = String(err?.message || toSafeApiError(err) || "").toLowerCase();
  return msg.includes("expires") && (msg.includes("maximum") || msg.includes("lifetime") || msg.includes("too far"));
}

/**
 * Authentik returns e.g. "Token expires exceeds maximum lifetime (2026-08-12 23:09:00+00:00 UTC)."
 * Parse that ceiling so we can create an expiring token within policy.
 */
function parseAuthentikMaxLifetimeFromError(err) {
  const msg = String(err?.message || toSafeApiError(err) || "");
  const match = msg.match(
    /maximum lifetime\s*\(\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9:.+-]+)\s*UTC\s*\)/i
  );
  if (!match) return null;
  const raw = String(match[1] || "").trim().replace(" ", "T");
  const dt = new Date(raw.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

async function getUserIdByUsername(username) {
  const u = String(username || "").trim();
  if (!u) throw new Error("Missing username");

  // Authentik can vary here; be resilient:
  // 1) try exact-style filter
  // 2) fallback to search
  const tries = [
    { username: u, page_size: 100 },
    { search: u, page_size: 100 },
  ];

  try {
    for (const params of tries) {
      const res = await api.get("/core/users/", { params });
      const results = Array.isArray(res?.data?.results) ? res.data.results : [];
      const exact = results.find((x) => String(x?.username || "") === u);
      if (exact) return exact.pk ?? exact.id;
    }
  } catch (err) {
    throw authentikError(err, `Failed to resolve Authentik user for "${u}"`);
  }

  throw new Error(`Unable to resolve Authentik user id for "${u}"`);
}

async function listUserAppPasswordsByUserId(resolvedUserId) {
  try {
    const res = await api.get("/core/tokens/", {
      params: {
        intent: "app_password",
        user: resolvedUserId,
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
  } catch (err) {
    throw authentikError(err, "Failed to list Authentik app passwords");
  }
}

async function viewTokenKey(identifier) {
  const ident = String(identifier || "").trim();
  if (!ident) throw new Error("Missing token identifier");

  try {
    const res = await api.get(`/core/tokens/${encodeURIComponent(ident)}/view_key/`);
    const key = res?.data?.key || res?.data?.token || res?.data?.value;
    if (!key) throw new Error("Authentik did not return a token key");
    return key;
  } catch (err) {
    throw authentikError(err, "Failed to read Authentik token key");
  }
}

function normalizeUserIdForApi(userId) {
  const raw = String(userId ?? "").trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

async function createAppPasswordForUserId(userId, {
  description,
  identPrefix,
  expiresAt,
} = {}) {
  if (!expiresAt || !(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
    throw new Error("An expiration date is required for Authentik app passwords.");
  }

  const desc = String(description || TOKEN_DESCRIPTION).trim() || TOKEN_DESCRIPTION;
  const prefix = String(identPrefix || IDENT_PREFIX).trim() || IDENT_PREFIX;
  const identifier = `${prefix}${Date.now()}-${Math.random()
    .toString(16)
    .slice(2, 10)}`;

  const payload = {
    identifier,
    intent: "app_password",
    user: normalizeUserIdForApi(userId),
    description: desc,
    expiring: true,
    expires: toIso(expiresAt),
  };

  try {
    const res = await api.post("/core/tokens/", payload);
    const created = res?.data || {};
    return created.identifier || identifier;
  } catch (err) {
    throw authentikError(err, "Failed to create Authentik app password");
  }
}

function resolveAppPasswordParams(params, defaultTtlMinutes) {
  let username = params;
  let userId = null;
  let ttlMinutes = defaultTtlMinutes;

  if (params && typeof params === "object") {
    username = params.username;
    userId = params.userId || params.uid || null;
    if (typeof params.ttlMinutes === "number") ttlMinutes = params.ttlMinutes;
  }

  const u = String(username || "").trim();
  if (!u) throw new Error("Missing username");

  return { username: u, userId, ttlMinutes };
}

/**
 * Create an expiring app password. Never creates non-expiring tokens.
 * If Authentik rejects the requested TTL as beyond max lifetime, retry once
 * clamped to Authentik's reported maximum (still expiring).
 */
async function createExpiringAppPassword(userId, {
  description,
  identPrefix,
  ttlMinutes,
  now = new Date(),
} = {}) {
  const desiredExpires = new Date(now.getTime() + ttlMinutes * 60 * 1000);
  try {
    return await createAppPasswordForUserId(userId, {
      description,
      identPrefix,
      expiresAt: desiredExpires,
    });
  } catch (err) {
    if (!isExpiresTooFarError(err)) throw err;

    const maxLifetime = parseAuthentikMaxLifetimeFromError(err);
    if (!maxLifetime) {
      const e = new Error(
        `${err.message} Set Authentik attribute goauthentik.io/user/token-maximum-lifetime ` +
          `(e.g. days=30) on the user or their groups to allow longer data-package tokens.`
      );
      e.status = err.status || 400;
      throw e;
    }

    // Stay slightly under Authentik's ceiling to avoid boundary rejection.
    const clamped = new Date(Math.min(desiredExpires.getTime(), maxLifetime.getTime() - 5000));
    if (clamped.getTime() <= now.getTime() + 60 * 1000) {
      const e = new Error(
        `Authentik app-password maximum lifetime is too short for data packages ` +
          `(max ${toIso(maxLifetime)}). Set goauthentik.io/user/token-maximum-lifetime ` +
          `(e.g. days=30) on the user or their groups.`
      );
      e.status = 400;
      throw e;
    }

    return createAppPasswordForUserId(userId, {
      description,
      identPrefix,
      expiresAt: clamped,
    });
  }
}

/**
 * Return an existing (non-expired, expiring) app password matching description/prefix, or create one.
 */
async function getOrCreateAppPassword(params, {
  description,
  identPrefix,
  ttlMinutes: defaultTtlMinutes,
} = {}) {
  const { username, userId, ttlMinutes } = resolveAppPasswordParams(
    params,
    defaultTtlMinutes
  );
  const desc = String(description || "").trim();
  const prefix = String(identPrefix || "").trim();
  if (!desc || !prefix) {
    throw new Error("Token description and identifier prefix are required");
  }

  const now = new Date();
  const cleanedUserId = userId ? String(userId).trim() : "";
  const resolvedUserId = (/^\d+$/.test(cleanedUserId))
    ? cleanedUserId
    : await getUserIdByUsername(username);

  const tokens = await listUserAppPasswordsByUserId(resolvedUserId);

  const candidate = tokens
    .filter((t) => {
      const d = String(t?.description || "");
      const ident = String(t?.identifier || "");
      return d === desc || ident.startsWith(prefix);
    })
    .filter((t) => isTokenStillValid(t, now))
    .map((t) => ({ t, expires: parseExpires(t) }))
    .sort((a, b) => (b.expires?.getTime() || 0) - (a.expires?.getTime() || 0))[0];

  const identifier = candidate
    ? String(candidate.t.identifier)
    : await createExpiringAppPassword(resolvedUserId, {
        description: desc,
        identPrefix: prefix,
        ttlMinutes,
        now,
      });

  // Refresh token details (expires may not be present in create response)
  const freshList = await listUserAppPasswordsByUserId(resolvedUserId);
  const tokenObj =
    freshList.find((t) => String(t?.identifier || "") === identifier) || candidate?.t;

  if (!isTokenStillValid(tokenObj, now)) {
    throw new Error(
      "Authentik returned a data-package token that is missing a future expiration."
    );
  }

  const expires = parseExpires(tokenObj);
  const key = await viewTokenKey(identifier);

  return {
    identifier,
    key,
    expiresAt: toIso(expires),
    expiring: true,
    reused: !!candidate,
  };
}

/**
 * Return an existing (non-expired) enrollment token for this user, or create one.
 * Reuses within TTL window to avoid multiple active tokens per user.
 */
async function getOrCreateEnrollmentAppPassword(params, ttlMinutes = 15) {
  // Backwards-compatible signature:
  //   getOrCreateEnrollmentAppPassword(username, ttlMinutes)
  //   getOrCreateEnrollmentAppPassword({ username, userId, ttlMinutes })
  let nextParams = params;
  if (params && typeof params === "object") {
    nextParams = { ...params };
    if (typeof params.ttlMinutes !== "number" && typeof ttlMinutes === "number") {
      nextParams.ttlMinutes = ttlMinutes;
    }
  } else if (typeof ttlMinutes === "number") {
    nextParams = { username: params, ttlMinutes };
  }

  return getOrCreateAppPassword(nextParams, {
    description: TOKEN_DESCRIPTION,
    identPrefix: IDENT_PREFIX,
    ttlMinutes: 15,
  });
}

/**
 * Authentik app password for enrollment data packages (targets 30 days).
 * Reuses an existing non-expired data-package token for the user when present.
 * Always expiring — never creates or reuses non-expiring tokens.
 */
async function getOrCreateDataPackageAppPassword(params) {
  return getOrCreateAppPassword(params, {
    description: DATA_PACKAGE_TOKEN_DESCRIPTION,
    identPrefix: DATA_PACKAGE_IDENT_PREFIX,
    ttlMinutes: DATA_PACKAGE_TTL_MINUTES,
  });
}

module.exports = {
  getUserIdByUsername,
  getOrCreateEnrollmentAppPassword,
  getOrCreateDataPackageAppPassword,
  TOKEN_DESCRIPTION,
  IDENT_PREFIX,
  DATA_PACKAGE_TOKEN_DESCRIPTION,
  DATA_PACKAGE_IDENT_PREFIX,
  DATA_PACKAGE_TTL_MINUTES,
};
