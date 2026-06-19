/**
 * Map metadata: TAK Server group catalog + subscription index for marker enrichment.
 */
const dataSyncAccess = require("./dataSyncAccess.service");
const groupsSvc = require("./groups.service");
const takMetrics = require("./takMetrics.service");
const dataSyncSvc = require("./dataSync.service");
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

function isGroupActive(entry) {
  if (!entry) return false;
  if (entry.active === false || String(entry.active).toLowerCase() === "false") return false;
  return true;
}

/**
 * TAK Server subscription groups: IN = publish, OUT = receive (OpenTAKServer / dashboard).
 * Prefer IN (publish) groups; fall back to any active group when direction is omitted.
 */
function subscriptionChannelGroups(sub) {
  const raw = Array.isArray(sub?.groups) ? sub.groups : [];
  const names = new Set();

  for (const g of raw) {
    if (!isGroupActive(g)) continue;
    const name = normalizeGroupName(g.name);
    if (name) names.add(name);
  }

  const filterGroups = normalizeGroupName(sub.filterGroups || sub.filtergroups || "");
  if (filterGroups) {
    for (const part of filterGroups.split(/[,;]/)) {
      const name = normalizeGroupName(part);
      if (name) names.add(name);
    }
  }

  return Array.from(names);
}

function appendFilterGroupNodes(node, names) {
  if (node == null) return;
  const list = Array.isArray(node) ? node : [node];
  for (const item of list) {
    if (typeof item === "string" || typeof item === "number") {
      const n = normalizeGroupName(item);
      if (n) names.add(n);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const attrs = item._attributes || item;
    const n =
      normalizeGroupName(attrs.name) ||
      normalizeGroupName(attrs.group) ||
      normalizeGroupName(attrs.value) ||
      normalizeGroupName(attrs.v);
    if (n) names.add(n);
    if (typeof item._text === "string") {
      const t = normalizeGroupName(item._text);
      if (t) names.add(t);
    }
  }
}

function appendMartiDest(marti, names) {
  if (!marti) return;
  const dest = marti.dest;
  const destList = Array.isArray(dest) ? dest : dest ? [dest] : [];
  for (const d of destList) {
    if (typeof d === "string" || typeof d === "number") {
      const n = normalizeGroupName(d);
      if (n) names.add(n);
      continue;
    }
    const attrs = d?._attributes || d || {};
    const n =
      normalizeGroupName(attrs.callsign) ||
      normalizeGroupName(attrs.name) ||
      normalizeGroupName(attrs.group);
    if (n) names.add(n);
  }
}

function parseRelatedUids(detail) {
  if (!detail || typeof detail !== "object") return [];
  const uids = new Set();

  const links = detail.link;
  const linkList = Array.isArray(links) ? links : links ? [links] : [];
  for (const link of linkList) {
    const uid = normalizeGroupName(link?._attributes?.uid || link?.uid);
    if (uid) uids.add(uid);
  }

  const creator = detail.creator?._attributes || detail.creator;
  const creatorUid = normalizeGroupName(creator?.uid);
  if (creatorUid) uids.add(creatorUid);

  const endpoint = detail.contact?._attributes?.endpoint || "";
  const endpointParts = String(endpoint).split(":");
  const machineId = endpointParts[endpointParts.length - 1];
  if (machineId && machineId.length > 4) uids.add(machineId);

  return Array.from(uids);
}

function parseGroupsFromCoTDetail(detail) {
  if (!detail || typeof detail !== "object") return [];
  const names = new Set();

  appendMartiDest(detail.marti, names);
  appendFilterGroupNodes(detail.filtergroup, names);
  appendFilterGroupNodes(detail.FilterGroup, names);
  appendFilterGroupNodes(detail.filterGroup, names);
  appendFilterGroupNodes(detail.group, names);

  const flowTag =
    detail.flow_tag?._attributes?.group ||
    detail.flow_tag?._attributes?.name ||
    detail.flow_tag?._attributes?.value;
  if (flowTag) names.add(normalizeGroupName(flowTag));

  return Array.from(names).filter(Boolean);
}

function lookupSubscriptionGroupsByKey(key) {
  const k = String(key || "").trim().toLowerCase();
  if (!k) return [];
  const idx = subscriptionIndex;
  return (
    idx.byUid.get(k) ||
    idx.byCallsign.get(k) ||
    idx.byUsername.get(k) ||
    []
  );
}

function resolveGroupsFromSubscription(marker) {
  const keys = [];
  const uid = String(marker?.uid || "").trim();
  if (uid) keys.push(uid.toLowerCase());

  const callsign = normalizeGroupName(marker?.callsign);
  if (callsign) keys.push(callsign.toLowerCase());

  const related = Array.isArray(marker?.relatedUids) ? marker.relatedUids : [];
  for (const rel of related) {
    const rk = String(rel || "").trim().toLowerCase();
    if (rk) keys.push(rk);
  }

  const seen = new Set();
  for (const key of keys) {
    const groups = lookupSubscriptionGroupsByKey(key);
    if (!groups.length) continue;
    const out = [];
    for (const g of groups) {
      const name = normalizeGroupName(g);
      const ck = channelBaseKey(name);
      if (!name || seen.has(ck)) continue;
      seen.add(ck);
      out.push(name);
    }
    if (out.length) return out;
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
      const groups = subscriptionChannelGroups(sub);
      if (!groups.length) continue;

      const callsign = normalizeGroupName(sub.callsign);
      const username = normalizeGroupName(sub.username);
      const uidFields = [
        sub.uid,
        sub.clientUid,
        sub.clientUuid,
        sub.connectionUid,
        sub.deviceUid,
      ];
      if (callsign) byCallsign.set(callsign.toLowerCase(), groups);
      if (username) byUsername.set(username.toLowerCase(), groups);
      for (const rawUid of uidFields) {
        const uid = normalizeGroupName(rawUid);
        if (uid) byUid.set(uid.toLowerCase(), groups);
      }
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
    const ldapNames = (Array.isArray(all) ? all : [])
      .map((g) => normalizeGroupName(g?.name))
      .filter(isMapChannelGroupName);

    let takNames = [];
    try {
      const takPayload = await dataSyncSvc.listGroupsAll();
      takNames = dataSyncAccess
        .extractTakGroupNameList(takPayload)
        .map((n) => groupsSvc.ensureTakPrefix(n))
        .filter(isMapChannelGroupName);
    } catch (_) {}

    const names = Array.from(new Set([...ldapNames, ...takNames])).sort((a, b) =>
      dataSyncAccess.takDisplayName(a).localeCompare(dataSyncAccess.takDisplayName(b))
    );
    catalogCache = {
      names,
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
  parseRelatedUids,
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
