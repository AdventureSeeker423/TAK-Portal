const api = require("./authentik");

const TOKEN_DESCRIPTION = "TAK Portal Enrollment";
const IDENT_PREFIX = "tak-portal-enroll-";

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
  const cleanedUserId = userId ? String(userId).trim() : "";
  const resolvedUserId = (/^\d+$/.test(cleanedUserId)) ? cleanedUserId : await getUserIdByUsername(u);

  const tokens = await listUserAppPasswordsByUserId(resolvedUserId);

  const candidate = tokens
    .filter((t) => {
      const d = String(t?.description || "");
      const ident = String(t?.identifier || "");
      return d === TOKEN_DESCRIPTION || ident.startsWith(IDENT_PREFIX);
    })
    .map((t) => ({ t, expires: parseExpires(t) }))
    .filter((x) => x.expires && x.expires.getTime() > now.getTime())
    .sort((a, b) => b.expires.getTime() - a.expires.getTime())[0];

  const identifier = candidate
    ? String(candidate.t.identifier)
    : await createAppPasswordForUserId(
        resolvedUserId,
        new Date(now.getTime() + ttlMinutes * 60 * 1000)
      );

  // Refresh token details (expires may not be present in create response)
  const freshList = await listUserAppPasswordsByUserId(resolvedUserId);
  const tokenObj =
    freshList.find((t) => String(t?.identifier || "") === identifier) || candidate?.t;

  const expires =
    parseExpires(tokenObj) || new Date(now.getTime() + ttlMinutes * 60 * 1000);

  const key = await viewTokenKey(identifier);

  return {
    identifier,
    key,
    expiresAt: toIso(expires),
  };
}

module.exports = {
  getUserIdByUsername,
  getOrCreateEnrollmentAppPassword,
  TOKEN_DESCRIPTION,
  IDENT_PREFIX,
};
