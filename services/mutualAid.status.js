/**
 * Mutual aid activity derived from unrevoked TAK client certificates.
 * A failed cert listing must not be treated as "no certificates".
 */

function countsMap(counts) {
  if (counts instanceof Map) return counts;
  const map = new Map();
  if (counts && typeof counts === "object") {
    for (const [key, value] of Object.entries(counts)) {
      map.set(String(key || "").trim().toLowerCase(), Number(value) || 0);
    }
  }
  return map;
}

function activeCertCountForUsername(username, counts) {
  const key = String(username || "").trim().toLowerCase();
  if (!key) return 0;
  const n = Number(countsMap(counts).get(key) || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function certStatusForUsername(username, snapshot) {
  if (!snapshot || snapshot.ok !== true) {
    return {
      certStatusKnown: false,
      activeUserCount: 0,
      certStatus: "unknown",
      certStatusLabel: "",
    };
  }
  const n = activeCertCountForUsername(username, snapshot.counts);
  if (n <= 0) {
    return {
      certStatusKnown: true,
      activeUserCount: 0,
      certStatus: "inactive",
      certStatusLabel: "Inactive",
    };
  }
  return {
    certStatusKnown: true,
    activeUserCount: n,
    certStatus: "active",
    certStatusLabel: `Active - ${n} Users`,
  };
}

function isMutualAidExpired(item, nowMs = Date.now()) {
  const enabled = !!item?.expireEnabled;
  const atMs = item?.expireAt ? new Date(item.expireAt).getTime() : NaN;
  return enabled && Number.isFinite(atMs) && atMs <= nowMs;
}

/**
 * Dashboard banners include incidents and events that are Active (at least one
 * unrevoked client certificate). User totals are the sum of those certificates.
 */
function summarizeMutualAidBanners(items, nowMs = Date.now()) {
  let activeIncidents = 0;
  let incidentUsers = 0;
  let activeEvents = 0;
  let eventUsers = 0;

  for (const item of Array.isArray(items) ? items : []) {
    if (isMutualAidExpired(item, nowMs)) continue;
    if (item?.certStatusKnown !== true) continue;
    const n = Number(item.activeUserCount) || 0;
    if (n < 1) continue;
    const type = String(item.type || "").trim().toUpperCase();
    if (type === "INCIDENT") {
      activeIncidents += 1;
      incidentUsers += n;
    } else if (type === "EVENT") {
      activeEvents += 1;
      eventUsers += n;
    }
  }

  return { activeIncidents, incidentUsers, activeEvents, eventUsers };
}

/** Standby deployments whose own username has at least one active certificate. */
function standbysToPromote(items, counts) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (String(item?.type || "").trim().toUpperCase() !== "STANDBY") continue;
    const n = activeCertCountForUsername(item?.username, counts);
    if (n >= 1) out.push(item);
  }
  return out;
}

module.exports = {
  activeCertCountForUsername,
  certStatusForUsername,
  isMutualAidExpired,
  summarizeMutualAidBanners,
  standbysToPromote,
};
