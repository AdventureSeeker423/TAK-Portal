/**
 * Lightweight local is_active gate with a short in-memory TTL cache.
 * Avoids a DB round-trip on every request while still cutting off disabled
 * sessions within a few seconds (default 15s).
 */
const directoryRepo = require("./directoryRepo.service");
const { getInt } = require("./env");

const cache = new Map();

function ttlMs() {
  const n = getInt("PORTAL_ACTIVE_CHECK_TTL_MS", 15000);
  return Math.max(1000, Math.min(120000, Number.isFinite(n) ? n : 15000));
}

function cacheKey(username) {
  return String(username || "")
    .trim()
    .toLowerCase();
}

function invalidateActiveUser(username) {
  const key = cacheKey(username);
  if (key) cache.delete(key);
}

function invalidateAllActiveUsers() {
  cache.clear();
}

/**
 * @returns {Promise<boolean>} true = allow request; false = account disabled locally
 */
async function isLocalUserActive(username) {
  const key = cacheKey(username);
  if (!key || key === "bootstrap") return true;

  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.active;

  let active = true;
  try {
    const user = await directoryRepo.getUserById(key);
    // Only block when we know the portal directory says disabled.
    // Missing local row → defer to Authentik (fail open).
    active = !user || user.is_active !== false;
  } catch (err) {
    console.warn("[active-gate] lookup failed:", err?.message || err);
    active = true;
  }

  cache.set(key, { active, expiresAt: now + ttlMs() });
  if (cache.size > 4000) {
    for (const [k, v] of cache) {
      if (v.expiresAt <= now) cache.delete(k);
    }
    if (cache.size > 4000) {
      const first = cache.keys().next().value;
      if (first) cache.delete(first);
    }
  }
  return active;
}

module.exports = {
  isLocalUserActive,
  invalidateActiveUser,
  invalidateAllActiveUsers,
  ttlMs,
};
