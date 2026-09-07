/**
 * Live-map SA stale policy.
 * TAK Server / TAK Aware emit t-x-d-d (and sometimes a last-gasp SA) when a
 * client disconnects. Presence tracks should stay until the last CoT stale time.
 */

const STALE_GRACE_MS = 30000;

function parseStaleMs(stale) {
  if (stale == null || stale === "") return NaN;
  const t = Date.parse(String(stale));
  return Number.isFinite(t) ? t : NaN;
}

function isPortalLocatorUid(uid) {
  return /^takportal\.locator\./i.test(String(uid || ""));
}

/** Self-SA / PLI (ground EUD a-*-G-U-C and air a-*-A-*). */
function isLiveSaPresenceType(type) {
  const t = String(type || "")
    .trim()
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-")
    .toLowerCase();
  if (/^a-[a-z0-9]+-g-u-c(?:-|$)/.test(t)) return true;
  const parts = t.split("-").filter(Boolean);
  return parts.length >= 3 && parts[2] === "a";
}

function isMarkerExpired(marker, now = Date.now()) {
  const t = parseStaleMs(marker?.stale);
  return Number.isFinite(t) && now > t + STALE_GRACE_MS;
}

/**
 * Keep last-known SA on the map despite disconnect deletes.
 * Portal locator UIDs still honor explicit t-x-d-d (operator stop).
 */
function shouldKeepUntilStale(marker, now = Date.now()) {
  if (!marker) return false;
  if (isPortalLocatorUid(marker.uid)) return false;
  if (!isLiveSaPresenceType(marker.type)) return false;
  const t = parseStaleMs(marker.stale);
  if (!Number.isFinite(t)) return false;
  return now <= t + STALE_GRACE_MS;
}

/**
 * Ignore a last-gasp SA whose stale is already elapsed when a fresher
 * last-known position is still inside its stale window.
 */
function shouldIgnoreIncomingSa(existing, incoming, now = Date.now()) {
  if (!existing || !incoming) return false;
  if (!shouldKeepUntilStale(existing, now)) return false;
  const incomingStale = parseStaleMs(incoming.stale);
  if (!Number.isFinite(incomingStale)) return false;
  return incomingStale <= now;
}

module.exports = {
  STALE_GRACE_MS,
  parseStaleMs,
  isPortalLocatorUid,
  isLiveSaPresenceType,
  isMarkerExpired,
  shouldKeepUntilStale,
  shouldIgnoreIncomingSa,
};
