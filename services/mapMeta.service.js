/**
 * Map metadata: TAK Server group catalog + subscription index for marker enrichment.
 */
const dataSyncAccess = require("./dataSyncAccess.service");
const dataSyncSvc = require("./dataSync.service");
const groupsSvc = require("./groups.service");
const takMetrics = require("./takMetrics.service");
const { isTakBypassed, isTakConfigured, buildTakAxios } = require("./tak.service");

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

/** Connection UID (flow tag / subscription id) -> publish groups for that injector. */
let connectionGroupsByUid = new Map();
/** Data feed filtergroup targets keyed by uuid/name/id fragments. */
let dataFeedGroupsByKey = new Map();

let dataFeedCache = {
  fetchedAt: 0,
  error: null,
};

let refreshTimer = null;
/** @type {Set<() => void>} */
const subscriptionRefreshListeners = new Set();

function normalizeGroupName(name) {
  return String(name || "").trim();
}

/** Map channels list: Authentik-managed tak_* groups (Hamilton Co / HCSO channels). */
function isMapChannelGroupName(name) {
  const n = normalizeGroupName(name);
  if (!n || n.startsWith("_")) return false;
  if (!n.toLowerCase().startsWith("tak_")) return false;
  const display = stripChannelBehaviorSuffix(n).toLowerCase();
  if (display.startsWith("__")) return false;
  if (display.includes("authentik")) return false;
  if (display.startsWith("cn=")) return false;
  return true;
}

function isPortalChannelBaseKey(baseKey) {
  const key = String(baseKey || "").trim().toLowerCase();
  if (!key || key === UNASSIGNED_GROUP.toLowerCase()) return false;
  if (key.startsWith("__")) return false;
  if (key.includes("authentik")) return false;
  if (key.includes("cn=")) return false;
  return true;
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

function isTakChannelGroupName(name) {
  const n = normalizeGroupName(name);
  if (!n || n === UNASSIGNED_GROUP) return false;
  if (n.startsWith("_") || n.toLowerCase() === "__anon__") return false;
  if (/^cn=/i.test(n)) return false;
  if (/authentik/i.test(n)) return false;
  return true;
}

function subscriptionGroupName(entry) {
  return normalizeGroupName(
    entry?.name || entry?.groupName || entry?.group || entry?.cn || ""
  );
}

function dedupeGroupNames(names) {
  const seen = new Set();
  const out = [];
  for (const raw of names || []) {
    const name = normalizeGroupName(raw);
    if (!name || !isTakChannelGroupName(name)) continue;
    const key = channelBaseKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function normalizeDataFeedGroupList(raw) {
  const items = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[,;]/)
      : raw != null
        ? [raw]
        : [];
  const out = [];
  for (const item of items) {
    const n = normalizeGroupName(item);
    if (!n) continue;
    const withPrefix = isMapChannelGroupName(n) ? n : groupsSvc.ensureTakPrefix(stripChannelBehaviorSuffix(n));
    if (isTakChannelGroupName(withPrefix)) out.push(withPrefix);
  }
  return dedupeGroupNames(out);
}

function registerConnectionGroups(ids, groups) {
  const list = dedupeGroupNames(groups);
  if (!list.length) return;
  for (const rawId of ids || []) {
    const id = normalizeGroupName(rawId);
    if (!id) continue;
    connectionGroupsByUid.set(id.toLowerCase(), list);
    const bare = id.replace(/^TAK-Server-/i, "").toLowerCase();
    if (bare && bare !== id.toLowerCase()) {
      connectionGroupsByUid.set(bare, list);
    }
  }
}

function rebuildConnectionGroupIndex(subList) {
  connectionGroupsByUid = new Map();

  for (const sub of Array.isArray(subList) ? subList : []) {
    const groups = subscriptionPublishGroups(sub);
    if (!groups.length) continue;

    registerConnectionGroups(
      [sub.uid, sub.clientUid, sub.clientUuid, sub.connectionUid, sub.deviceUid],
      groups
    );
  }
}

function registerDataFeedGroups(feed) {
  if (!feed || typeof feed !== "object") return;
  const groups = normalizeDataFeedGroupList(
    feed.filtergroup || feed.filterGroup || feed.filterGroups || feed.groups
  );
  if (!groups.length) return;

  const keys = new Set();
  for (const field of [feed.uuid, feed.uid, feed.id, feed.name, feed.tag]) {
    const val = normalizeGroupName(field);
    if (!val) continue;
    keys.add(val.toLowerCase());
    const bare = val.replace(/^TAK-Server-/i, "").toLowerCase();
    if (bare) keys.add(bare);
  }

  for (const key of keys) {
    dataFeedGroupsByKey.set(key, groups);
    registerConnectionGroups([key], groups);
  }
}

async function refreshDataFeedIndex() {
  if (isTakBypassed() || !isTakConfigured()) {
    dataFeedGroupsByKey = new Map();
    dataFeedCache = {
      fetchedAt: Date.now(),
      error: isTakBypassed() ? "TAK bypass enabled" : "TAK not configured",
    };
    return dataFeedCache;
  }

  try {
    const client = buildTakAxios();
    const res = await client.get("/api/datafeeds", { headers: { Accept: "application/json" } });
    const payload = res?.data;
    const feeds = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload)
        ? payload
        : [];

    dataFeedGroupsByKey = new Map();
    for (const feed of feeds) {
      registerDataFeedGroups(feed);
    }

    dataFeedCache = {
      fetchedAt: Date.now(),
      error: null,
    };
    notifySubscriptionIndexRefreshed();
  } catch (err) {
    dataFeedCache = {
      fetchedAt: Date.now(),
      error: err?.message || String(err),
    };
  }

  return dataFeedCache;
}

function parseFlowTagUids(detail) {
  if (!detail || typeof detail !== "object") return [];
  const uids = new Set();

  const flowTags = detail.flow_tag;
  const flowList = Array.isArray(flowTags) ? flowTags : flowTags ? [flowTags] : [];
  for (const item of flowList) {
    const uid =
      item?._attributes?.uid ||
      item?._attributes?.id ||
      item?.uid ||
      item?.id;
    if (uid) uids.add(String(uid).trim());
  }

  for (const [key, val] of Object.entries(detail)) {
    if (/^TAK-Server-/i.test(key)) uids.add(key);
    if (/^flow/i.test(key) && val && typeof val === "object" && !Array.isArray(val)) {
      for (const subKey of Object.keys(val)) {
        if (/^TAK-Server-/i.test(subKey)) uids.add(subKey);
      }
    }
  }

  return Array.from(uids).filter(Boolean);
}

function lookupConnectionGroups(uid) {
  const id = normalizeGroupName(uid).toLowerCase();
  if (!id) return [];
  return (
    connectionGroupsByUid.get(id) ||
    connectionGroupsByUid.get(id.replace(/^tak-server-/, "")) ||
    dataFeedGroupsByKey.get(id) ||
    dataFeedGroupsByKey.get(id.replace(/^tak-server-/, "")) ||
    []
  );
}

function lookupGroupsByConnectionKey(key) {
  const k = String(key || "").trim().toLowerCase();
  if (!k) return [];
  const fromConnection = lookupConnectionGroups(k);
  if (fromConnection.length) return fromConnection;
  return lookupSubscriptionGroupsByKey(k);
}

function resolveGroupsFromFlowTags(source) {
  const uids = Array.isArray(source?.flowTagUids)
    ? source.flowTagUids
    : parseFlowTagUids(source);
  const out = [];
  for (const uid of uids) {
    out.push(...lookupConnectionGroups(uid));
  }
  return dedupeGroupNames(out);
}

function isGroupActive(entry) {
  if (!entry) return false;
  if (entry.active === false || String(entry.active).toLowerCase() === "false") return false;
  return true;
}

/**
 * TAK Server: IN = publish (send CoT to group). Use publish groups when inferring
 * which channel a marker is on from its sender's subscription.
 */
function subscriptionPublishGroups(sub) {
  const raw = Array.isArray(sub?.groups) ? sub.groups : [];
  const publish = new Set();
  const any = new Set();

  for (const g of raw) {
    if (!isGroupActive(g)) continue;
    const name = subscriptionGroupName(g);
    if (!name || !isTakChannelGroupName(name)) continue;
    any.add(name);
    const dir = String(g.direction || "").trim().toUpperCase();
    if (dir === "IN" || dir === "") publish.add(name);
  }

  const filterGroups = normalizeGroupName(sub.filterGroups || sub.filtergroups || "");
  if (filterGroups) {
    for (const part of filterGroups.split(/[,;]/)) {
      const name = normalizeGroupName(part);
      if (name && isTakChannelGroupName(name)) publish.add(name);
    }
  }

  if (publish.size) return Array.from(publish);
  return Array.from(any);
}

function appendFilterGroupNodes(node, names) {
  if (node == null) return;
  const list = Array.isArray(node) ? node : [node];
  for (const item of list) {
    if (typeof item === "string" || typeof item === "number") {
      const n = normalizeGroupName(item);
      if (n && isTakChannelGroupName(n)) names.add(n);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const attrs = item._attributes || item;
    const n =
      normalizeGroupName(attrs.name) ||
      normalizeGroupName(attrs.group) ||
      normalizeGroupName(attrs.value);
    if (n && isTakChannelGroupName(n)) names.add(n);
  }
}

function appendMartiDest(marti, names) {
  if (!marti) return;
  const dest = marti.dest;
  const destList = Array.isArray(dest) ? dest : dest ? [dest] : [];
  for (const d of destList) {
    if (typeof d === "string" || typeof d === "number") {
      const n = normalizeGroupName(d);
      if (n && isTakChannelGroupName(n)) names.add(n);
      continue;
    }
    const attrs = d?._attributes || d || {};
    const n =
      normalizeGroupName(attrs.callsign) ||
      normalizeGroupName(attrs.name) ||
      normalizeGroupName(attrs.group);
    if (n && isTakChannelGroupName(n)) names.add(n);
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
  for (const [key, val] of Object.entries(detail)) {
    if (/filtergroup/i.test(key)) appendFilterGroupNodes(val, names);
  }

  const flowTag =
    detail.flow_tag?._attributes?.group ||
    detail.flow_tag?._attributes?.name ||
    detail.flow_tag?._attributes?.value;
  if (flowTag && isTakChannelGroupName(flowTag)) names.add(normalizeGroupName(flowTag));

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

  const related = Array.isArray(marker?.relatedUids) ? marker.relatedUids : [];
  for (const rel of related) {
    const rk = String(rel || "").trim().toLowerCase();
    if (rk) keys.push(rk);
  }

  for (const key of keys) {
    const groups = lookupGroupsByConnectionKey(key);
    const out = dedupeGroupNames(groups);
    if (out.length) return out;
  }

  const callsign = normalizeGroupName(marker?.callsign);
  if (callsign) {
    const groups = lookupGroupsByConnectionKey(callsign.toLowerCase());
    const out = dedupeGroupNames(groups);
    if (out.length) return out;
  }

  return [UNASSIGNED_GROUP];
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
    rebuildConnectionGroupIndex(list);
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
  void refreshDataFeedIndex();
  refreshTimer = setInterval(() => {
    void refreshGroupCatalog();
    void refreshSubscriptionIndex();
    void refreshDataFeedIndex();
  }, SUBSCRIPTION_REFRESH_MS);
  if (typeof refreshTimer.unref === "function") refreshTimer.unref();
}

function resolveGroupsForMarker(marker, cotDetail) {
  const detail = cotDetail && typeof cotDetail === "object" ? cotDetail : null;

  const fromCot = detail
    ? parseGroupsFromCoTDetail(detail)
    : Array.isArray(marker?.cotRouteGroups)
      ? marker.cotRouteGroups
      : [];

  const fromFlow = resolveGroupsFromFlowTags(
    detail || { flowTagUids: marker?.flowTagUids || [] }
  );

  const routed = dedupeGroupNames([...fromCot, ...fromFlow]);
  if (routed.length) return routed;

  const fromSub = resolveGroupsFromSubscription(marker);
  if (fromSub[0] !== UNASSIGNED_GROUP) return fromSub;

  return [UNASSIGNED_GROUP];
}

/**
 * Diagnostic trace for why a marker landed in its assigned group(s).
 * Compare a working EUD vs a data-feed marker side by side.
 */
function explainGroupAssignment(marker) {
  const cotRouteGroups = Array.isArray(marker?.cotRouteGroups) ? marker.cotRouteGroups : [];
  const flowTagUids = Array.isArray(marker?.flowTagUids) ? marker.flowTagUids : [];
  const relatedUids = Array.isArray(marker?.relatedUids) ? marker.relatedUids : [];

  const flowTagLookups = flowTagUids.map((uid) => ({
    uid,
    connectionGroups: lookupConnectionGroups(uid),
    subscriptionGroups: lookupSubscriptionGroupsByKey(String(uid).toLowerCase()),
  }));

  const subscriptionKeys = [];
  const markerUid = String(marker?.uid || "").trim();
  if (markerUid) subscriptionKeys.push({ kind: "marker.uid", key: markerUid });
  for (const rel of relatedUids) {
    const rk = String(rel || "").trim();
    if (rk) subscriptionKeys.push({ kind: "relatedUid", key: rk });
  }
  const callsign = normalizeGroupName(marker?.callsign);
  if (callsign) subscriptionKeys.push({ kind: "callsign", key: callsign });

  const subscriptionLookups = subscriptionKeys.map(({ kind, key }) => ({
    kind,
    key,
    connectionGroups: lookupConnectionGroups(String(key).toLowerCase()),
    subscriptionGroups: lookupSubscriptionGroupsByKey(String(key).toLowerCase()),
  }));

  const recomputed = resolveGroupsForMarker(marker, null);

  return {
    marker: {
      uid: marker?.uid || null,
      callsign: marker?.callsign || null,
      type: marker?.type || null,
      how: marker?.how || null,
      storedGroups: Array.isArray(marker?.groups) ? marker.groups : [],
      cotRouteGroups,
      flowTagUids,
      relatedUids,
    },
    indexes: {
      subscription: getSubscriptionIndexSnapshot(),
      connectionUidCount: connectionGroupsByUid.size,
      dataFeedKeyCount: dataFeedGroupsByKey.size,
      dataFeedFetchedAt: dataFeedCache.fetchedAt || null,
      dataFeedError: dataFeedCache.error || null,
      catalogChannelCount: catalogCache.names.length,
    },
    trace: {
      step1_cotRouting: cotRouteGroups,
      step2_flowTagLookups: flowTagLookups,
      step2_flowGroups: resolveGroupsFromFlowTags({ flowTagUids }),
      step3_subscriptionLookups: subscriptionLookups,
      step3_subscriptionGroups: resolveGroupsFromSubscription(marker),
      recomputedGroups: recomputed,
    },
    notes: [
      "EUD clients usually match via step3 (subscription by uid/callsign).",
      "Data feeds usually need step1 (marti/filtergroup in CoT) or step2 (flow_tag UID -> feed connection groups).",
      "If step2 flowTagUids is empty, the streamed CoT may not include flow provenance.",
      "If flowTagLookups.connectionGroups is empty, the feed UUID is missing from subscriptions/datafeeds index.",
    ],
  };
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
    if (!isPortalChannelBaseKey(baseKey)) continue;
    const displayName = stripChannelBehaviorSuffix(groupsSvc.ensureTakPrefix(baseKey));
    if (!isMapChannelGroupName(channelCatalogName(displayName))) continue;
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
  toChannelGroupName,
  stripChannelBehaviorSuffix,
  ensureRefreshLoop,
  parseGroupsFromCoTDetail,
  parseFlowTagUids,
  parseRelatedUids,
  onSubscriptionIndexRefreshed,
  parseAffiliationFromType,
  parseTeamColor,
  normalizeTakColor,
  resolveGroupsForMarker,
  explainGroupAssignment,
  getTakGroupCatalog,
  refreshGroupCatalog,
  refreshSubscriptionIndex,
  refreshDataFeedIndex,
  getSubscriptionIndexSnapshot,
  buildGroupsCatalogWithCounts,
};
