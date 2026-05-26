const USER_AGREEMENT_SESSION_COOKIE = "mou_user_agreement_session";

function getCookieValue(req, cookieName) {
  const pair = String(req.headers.cookie || "")
    .split(/;\s*/)
    .map((entry) => entry.split("="))
    .find(([key]) => String(key || "").trim() === cookieName);
  if (!pair) return "";
  const rawValue = String(pair[1] || "").trim();
  try {
    return decodeURIComponent(rawValue);
  } catch {
    return rawValue;
  }
}

function getAuthentikJwt(req) {
  const rawHeader = req?.headers?.["x-authentik-jwt"];
  const rawValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const token = String(rawValue || "").trim();
  if (!token) return "";
  const parts = token.split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : token;
}

function decodeBase64UrlJson(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function getAuthentikJwtPayload(req) {
  const token = getAuthentikJwt(req);
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  return decodeBase64UrlJson(parts[1]);
}

function getAgreementLoginMarker(req) {
  const payload = getAuthentikJwtPayload(req);
  if (!payload || typeof payload !== "object") return "";
  const markerCandidates = [
    ["sid", payload.sid],
    ["session", payload.session_id || payload.sessionId || payload.session],
    ["auth", payload.auth_time],
    ["iat", payload.iat],
  ];
  for (const [prefix, value] of markerCandidates) {
    if (value === undefined || value === null || value === "") continue;
    return `${prefix}:${String(value).trim()}`;
  }
  return "";
}

function buildAgreementSessionValue(req, user, agreement) {
  const userKey = String(user?.uid || user?.username || "").trim().toLowerCase();
  const version = Number(agreement?.version || 0) || 0;
  if (!userKey || !version) return "";
  const loginMarker = getAgreementLoginMarker(req);
  return loginMarker
    ? `${userKey}:${version}:${loginMarker}`
    : `${userKey}:${version}`;
}

function hasAcceptedAgreementForSession(req, user, agreement) {
  return (
    getCookieValue(req, USER_AGREEMENT_SESSION_COOKIE) ===
    buildAgreementSessionValue(req, user, agreement)
  );
}

module.exports = {
  USER_AGREEMENT_SESSION_COOKIE,
  buildAgreementSessionValue,
  getCookieValue,
  hasAcceptedAgreementForSession,
};
