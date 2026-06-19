/**
 * Map metadata: TAK Server group catalog + subscription index for marker enrichment.
 */
const dataSyncAccess = require("./dataSyncAccess.service");
const groupsSvc = require("./groups.service");
const takMetrics = require("./takMetrics.service");
const { isTakBypassed, isTakConfigured } = require("./tak.service");

const SUBSCRIPTION_REFRESH_MS = 30000;
const UNASSIGNED_GROUP = "Unassigned";

let catalogCache = {
  names: [],
  fetchedAt: 0,
  error: null,
};

let subscriptionIndex = {
  byCallsign: new Map(),
  byUsername: new Map(),
  byUid: new Map(),
  fetchedAt: 0,
  error: null,
};

let refreshTimer = null;
/** @type {Set<() => void>} */
const subscriptionRefreshListeners = new Set();

function normalizeGroupName(name) {
  return String(name || "").trim();
}

/** Map channels list: LDAP groups managed in Authentik with tak_ prefix. */
function isMapChannelGroupName(name) {
  const n = normalizeGroupName(name);
  if (!n || n.startsWith("_")) return false;
  return n.toLowerCase().startsWith("tak_");
}

function channelGroupKey(name) {
  const n = normalizeGroupName(name).toLowerCase();
  if (!n || n === UNASSIGNED_GROUP.toLowerCase()) return "";
  return channelBaseKey(name);
}

/** Strip tak_ prefix and _READ/_WRITE behavior suffix for one logical channel. */
function stripChannelBehaviorSuffix(name) {
  let n = dataSyncAccess.takDisplayName(name);
  const lower = n.toLowerCase();
  if (lower.endsWith("_read")) return n.slice(0, -5).trim();
  if (lower.endsWith("_write")) return n.slice(0, -6).trim();
  return n;
}

function channelBaseKey(name) {
  const base = stripChannelBehaviorSuffix(name);
  if (!base || base.toLowerCase() === UNASSIGNED_GROUP.toLowerCase()) return "";
  return base.toLowerCase().replace(/\s+/g, " ").trim();
}

function channelCatalogName(baseDisplay) {
  const label = String(baseDisplay || "").trim();
  if (!label) return "";
  return groupsSvc.ensureTakPrefix(label);
}

function consolidateChannelCatalog(ldapNames) {
  /** @type {Map<string, { baseKey: string, displayName: string, name: string, ldapNames: string[] }>} */
  const byBase = new Map();

  for (const raw of ldapNames) {
    const ldapName = normalizeGroupName(raw);
    if (!isMapChannelGroupName(ldapName)) continue;

    const baseKey = channelBaseKey(ldapName);
    if (!baseKey) continue;

    const displayName = stripChannelBehaviorSuffix(ldapName);
    let entry = byBase.get(baseKey);
    if (!entry) {
      entry = {
        baseKey,
        displayName,
        name: channelCatalogName(displayName),
        ldapNames: [ldapName],
      };
      byBase.set(baseKey, entry);
      continue;
    }

    entry.ldapNames.push(ldapName);
    const lower = displayName.toLowerCase();
    const currentLower = entry.displayName.toLowerCase();
    const entryHasSuffix =
      currentLower.endsWith("_read") || currentLower.endsWith("_write");
    const nextHasSuffix = lower.endsWith("_read") || lower.endsWith("_write");
    if (entryHasSuffix && !nextHasSuffix) {
      entry.displayName = displayName;
      entry.name = channelCatalogName(displayName);
    } else if (!entryHasSuffix && !nextHasSuffix) {
      const entryAllLower = entry.displayName === currentLower;
      const nextAllLower = displayName === lower;
      if (entryAllLower && !nextAllLower) {
        entry.displayName = displayName;
        entry.name = channelCatalogName(displayName);
      } else if (!entryAllLower && !nextAllLower && displayName.length > entry.displayName.length) {
        entry.displayName = displayName;
        entry.name = channelCatalogName(displayName);
      }
    } else if (displayName.length > entry.displayName.length && !nextHasSuffix) {
      entry.displayName = displayName;
      entry.name = channelCatalogName(displayName);
    }
  }

  return Array.from(byBase.values()).sort((a, b) =>
    a.displayName.localeCompare(b.displayName)
  );
}

function toChannelGroupName(name) {
  const n = normalizeGroupName(name);
  if (!n || n === UNASSIGNED_GROUP) return null;
  const display = stripChannelBehaviorSuffix(isMapChannelGroupName(n) ? n : groupsSvc.ensureTakPrefix(n));
  return channelCatalogName(display);
}

/**
 * TAK Server / OpenTAKServer: IN = publish (send CoT to group), OUT = receive only.
 * Map channel filters should reflect where traffic is published, not receive-only groups.
 */
function subscriptionPublishGroups(sub) {
  const raw = Array.isArray(sub?.groups) ? sub.groups : [];
  const names = new Set();
  for (const g of raw) {
    if (!g || g.active === false) continue;
    const dir = String(g.direction || "").trim().toUpperCase();
    if (dir === "OUT") continue;
    const name = normalizeGroupName(g.name);
    if (name) names.add(name);
  }
  return Array.from(names);
}

function parseGroupsFromCoTDetail(detail) {
  if (!detail || typeof detail !== "object") return [];
  const names = new Set();

  const marti = detail.marti;
  if (marti) {
    const dest = marti.dest;
    const destList = Array.isArray(dest) ? dest : dest ? [dest] : [];
    for (const d of destList) {
      const attrs = d?._attributes || d || {};
      const n =
        normalizeGroupName(attrs.callsign) ||
        normalizeGroupName(attrs.name) ||
        normalizeGroupName(attrs.group);
      if (n) names.add(n);
    }
  }

  const flowTag = detail.flow_tag?._attributes?.group || detail.flow_tag?._attributes?.name;
  if (flowTag) names.add(normalizeGroupName(flowTag));

  return Array.from(names).filter(Boolean);
}

function resolveGroupsFromSubscription(marker) {
  const idx = subscriptionIndex;
  const uidKey = String(marker?.uid || "").trim().toLowerCase();
  const callsignKey = normalizeGroupName(marker?.callsign).toLowerCase();

  if (uidKey) {
    const byUid = idx.byUid.get(uidKey);
    if (byUid?.length) return byUid;
  }

  if (callsignKey) {
    const byCs = idx.byCallsign.get(callsignKey);
    if (byCs?.length) return byCs;
  }

  if (uidKey) {
    const byUser = idx.byUsername.get(uidKey);
    if (byUser?.length) return byUser;
  }

  return [UNASSIGNED_GROUP];
}

function parseAffiliationFromType(type) {
  const t = String(type || "").trim();
  if (t.startsWith("a-f-")) return "friend";
  if (t.startsWith("a-h-")) return "hostile";
  if (t.startsWith("a-n-")) return "neutral";
  if (t.startsWith("a-u-")) return "unknown";
  return "other";
}

function parseTeamColor(detail) {
  const color =
    detail?.__group?._attributes?.color ||
    detail?.team?._attributes?.color ||
    null;
  return normalizeTakColor(color);
}

/** ATAK/TAK team colors are often signed 32-bit ARGB integers, not CSS hex. */
function normalizeTakColor(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  if (/^#[0-9a-f]{3,8}$/i.test(s)) {
    if (s.length === 4 || s.length === 7) return s;
    return s.slice(0, 7);
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return null;

  const argb = n >>> 0;
  const a = (argb >>> 24) & 0xff;
  if (a === 0) return null;
  const r = (argb >>> 16) & 0xff;
  const g = (argb >>> 8) & 0xff;
  const b = argb & 0xff;
  return (
    "#" +
    r.toString(16).padStart(2, "0") +
    g.toString(16).padStart(2, "0") +
    b.toString(16).padStart(2, "0")
  );
}

async function refreshSubscriptionIndex() {
  if (isTakBypassed() || !isTakConfigured()) {
    subscriptionIndex = {
      byCallsign: new Map(),
      byUsername: new Map(),
      byUid: new Map(),
      fetchedAt: Date.now(),
      error: isTakBypassed() ? "TAK bypass enabled" : "TAK not configured",
    };
    notifySubscriptionIndexRefreshed();
    return subscriptionIndex;
  }

  try {
    const result = await takMetrics.getSubscriptionsAll();
    const list = Array.isArray(result?.data) ? result.data : [];
    const byCallsign = new Map();
    const byUsername = new Map();
    const byUid = new Map();

    for (const sub of list) {
      const groups = subscriptionPublishGroups(sub);
      if (!groups.length) continue;

      const callsign = normalizeGroupName(sub.callsign);
      const username = normalizeGroupName(sub.username);
      const uid = normalizeGroupName(sub.uid || sub.clientUid || sub.clientUuid);
      if (callsign) byCallsign.set(callsign.toLowerCase(), groups);
      if (username) byUsername.set(username.toLowerCase(), groups);
      if (uid) byUid.set(uid.toLowerCase(), groups);
    }

    subscriptionIndex = {
      byCallsign,
      byUsername,
      byUid,
      fetchedAt: Date.now(),
      error: null,
    };
    notifySubscriptionIndexRefreshed();
  } catch (err) {
    subscriptionIndex = {
      ...subscriptionIndex,
      fetchedAt: Date.now(),
      error: err?.message || String(err),
    };
  }

  return subscriptionIndex;
}

async function refreshGroupCatalog() {
  if (isTakBypassed() || !isTakConfigured()) {
    catalogCache = {
      names: [],
      fetchedAt: Date.now(),
      error: isTakBypassed() ? "TAK bypass enabled" : "TAK not configured",
    };
    return catalogCache;
  }

  try {
    const all = await groupsSvc.getAllGroups({ forceRefresh: false });
    const names = (Array.isArray(all) ? all : [])
      .map((g) => normalizeGroupName(g?.name))
      .filter(isMapChannelGroupName);
    catalogCache = {
      names: Array.from(new Set(names)).sort((a, b) =>
        dataSyncAccess.takDisplayName(a).localeCompare(dataSyncAccess.takDisplayName(b))
      ),
      fetchedAt: Date.now(),
      error: null,
    };
  } catch (err) {
    catalogCache = {
      ...catalogCache,
      fetchedAt: Date.now(),
      error: err?.message || String(err),
    };
  }

  return catalogCache;
}

function ensureRefreshLoop() {
  if (refreshTimer) return;
  void refreshGroupCatalog();
  void refreshSubscriptionIndex();
  refreshTimer = setInterval(() => {
    void refreshGroupCatalog();
    void refreshSubscriptionIndex();
  }, SUBSCRIPTION_REFRESH_MS);
  if (typeof refreshTimer.unref === "function") refreshTimer.unref();
}

function notifySubscriptionIndexRefreshed() {
  for (const fn of subscriptionRefreshListeners) {
    try {
      fn();
    } catch (err) {
      console.warn("[map-meta] subscription refresh listener failed:", err?.message || err);
    }
  }
}

function onSubscriptionIndexRefreshed(fn) {
  if (typeof fn !== "function") return () => {};
  subscriptionRefreshListeners.add(fn);
  return () => subscriptionRefreshListeners.delete(fn);
}

function resolveGroupsForMarker(marker, cotDetail) {
  const fromCot = cotDetail
    ? parseGroupsFromCoTDetail(cotDetail)
    : Array.isArray(marker?.cotRouteGroups)
      ? marker.cotRouteGroups
      : [];
  if (fromCot.length) return fromCot;
  return resolveGroupsFromSubscription(marker);
}

function buildGroupsCatalogWithCounts(markers) {
  ensureRefreshLoop();
  const counts = new Map();
  const markerList = Array.isArray(markers) ? markers : [];

  for (const m of markerList) {
    const groups = Array.isArray(m.groups) && m.groups.length ? m.groups : [UNASSIGNED_GROUP];
    for (const g of groups) {
      const channelName = toChannelGroupName(g);
      if (!channelName) continue;
      const key = channelBaseKey(channelName);
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  const seen = new Set();
  const groups = [];

  for (const entry of consolidateChannelCatalog(catalogCache.names)) {
    seen.add(entry.baseKey);
    groups.push({
      name: entry.name,
      displayName: entry.displayName,
      baseKey: entry.baseKey,
      markerCount: counts.get(entry.baseKey) || 0,
    });
  }

  for (const [baseKey, count] of counts.entries()) {
    if (seen.has(baseKey)) continue;
    const displayName = stripChannelBehaviorSuffix(groupsSvc.ensureTakPrefix(baseKey));
    groups.push({
      name: channelCatalogName(displayName),
      displayName,
      baseKey,
      markerCount: count,
    });
  }

  groups.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return groups;
}

async function getTakGroupCatalog(markers) {
  await refreshGroupCatalog();
  return {
    groups: buildGroupsCatalogWithCounts(markers),
    error: catalogCache.error,
    updatedAt: new Date().toISOString(),
  };
}

function getSubscriptionIndexSnapshot() {
  return {
    callsignCount: subscriptionIndex.byCallsign.size,
    usernameCount: subscriptionIndex.byUsername.size,
    uidCount: subscriptionIndex.byUid.size,
    fetchedAt: subscriptionIndex.fetchedAt,
    error: subscriptionIndex.error,
  };
}

module.exports = {
  UNASSIGNED_GROUP,
  isMapChannelGroupName,
  channelGroupKey,
  channelBaseKey,
  stripChannelBehaviorSuffix,
  ensureRefreshLoop,
  parseGroupsFromCoTDetail,
  parseAffiliationFromType,
  parseTeamColor,
  normalizeTakColor,
  resolveGroupsForMarker,
  resolveGroupsFromSubscription,
  onSubscriptionIndexRefreshed,
  getTakGroupCatalog,
  refreshGroupCatalog,
  refreshSubscriptionIndex,
  getSubscriptionIndexSnapshot,
  buildGroupsCatalogWithCounts,
};
