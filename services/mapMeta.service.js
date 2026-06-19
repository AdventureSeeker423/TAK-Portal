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
  fetchedAt: 0,
  error: null,
};

let refreshTimer = null;

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

function subscriptionGroupsToNames(sub) {
  const raw = Array.isArray(sub?.groups) ? sub.groups : [];
  const names = new Set();
  for (const g of raw) {
    if (!g || g.active === false) continue;
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
    const martiAttrs = marti._attributes || {};
    const martiGroup = normalizeGroupName(martiAttrs.group || martiAttrs.name);
    if (martiGroup) names.add(martiGroup);
  }

  const flowTag = detail.flow_tag?._attributes?.group || detail.flow_tag?._attributes?.name;
  if (flowTag) names.add(normalizeGroupName(flowTag));

  return Array.from(names).filter(Boolean);
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
  return color ? String(color).trim() : null;
}

async function refreshSubscriptionIndex() {
  if (isTakBypassed() || !isTakConfigured()) {
    subscriptionIndex = {
      byCallsign: new Map(),
      byUsername: new Map(),
      fetchedAt: Date.now(),
      error: isTakBypassed() ? "TAK bypass enabled" : "TAK not configured",
    };
    return subscriptionIndex;
  }

  try {
    const result = await takMetrics.getSubscriptionsAll();
    const list = Array.isArray(result?.data) ? result.data : [];
    const byCallsign = new Map();
    const byUsername = new Map();

    for (const sub of list) {
      const groups = subscriptionGroupsToNames(sub);
      if (!groups.length) continue;

      const callsign = normalizeGroupName(sub.callsign);
      const username = normalizeGroupName(sub.username);
      if (callsign) byCallsign.set(callsign.toLowerCase(), groups);
      if (username) byUsername.set(username.toLowerCase(), groups);
    }

    subscriptionIndex = {
      byCallsign,
      byUsername,
      fetchedAt: Date.now(),
      error: null,
    };
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

function resolveGroupsForMarker(marker, cotDetail) {
  const fromCot = parseGroupsFromCoTDetail(cotDetail);
  if (fromCot.length) return fromCot;

  const callsign = normalizeGroupName(marker?.callsign);
  const uid = String(marker?.uid || "");
  const idx = subscriptionIndex;

  if (callsign) {
    const byCs = idx.byCallsign.get(callsign.toLowerCase());
    if (byCs?.length) return byCs;
  }

  const uidLower = uid.toLowerCase();
  for (const [username, groups] of idx.byUsername.entries()) {
    if (uidLower.includes(username) || username.includes(uidLower.split("-")[0])) {
      return groups;
    }
  }

  if (callsign) {
    for (const [username, groups] of idx.byUsername.entries()) {
      if (callsign.toLowerCase().includes(username) || username.includes(callsign.toLowerCase())) {
        return groups;
      }
    }
  }

  return [UNASSIGNED_GROUP];
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
  resolveGroupsForMarker,
  getTakGroupCatalog,
  refreshGroupCatalog,
  refreshSubscriptionIndex,
  getSubscriptionIndexSnapshot,
  buildGroupsCatalogWithCounts,
};
