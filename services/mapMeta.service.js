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

/** Latest Marti payloads used to cross-link feed config with live connections. */
let subscriptionListCache = [];
let dataFeedListCache = [];

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

function isFlowProvenanceId(name) {
  return /^TAK-Server-/i.test(String(name || "").trim());
}

/** True when the name is a TAK channel/group, not a server flow-tag connection id. */
function isAssignableChannelGroupName(name) {
  if (!isTakChannelGroupName(name)) return false;
  if (isFlowProvenanceId(name)) return false;
  return true;
}

function filterAssignableChannelGroups(names) {
  const seen = new Set();
  const out = [];
  for (const raw of names || []) {
    const name = normalizeGroupName(raw);
    if (!isAssignableChannelGroupName(name)) continue;
    const key = channelBaseKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function dedupeGroupNames(names) {
  return filterAssignableChannelGroups(names);
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
    const lower = id.toLowerCase();
    connectionGroupsByUid.set(lower, list);
    const bare = lower.replace(/^tak-server-/, "");
    if (bare && bare !== lower) {
      connectionGroupsByUid.set(bare, list);
      connectionGroupsByUid.set(`tak-server-${bare}`, list);
    } else if (/^[0-9a-f-]{32,36}$/i.test(bare)) {
      connectionGroupsByUid.set(`tak-server-${bare}`, list);
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
  for (const field of [feed.uuid, feed.uid, feed.id, feed.name]) {
    const val = normalizeGroupName(field);
    if (!val) continue;
    keys.add(val.toLowerCase());
    const bare = val.replace(/^TAK-Server-/i, "").toLowerCase();
    if (bare) keys.add(bare);
  }

  const tags = feed.tag;
  const tagList = Array.isArray(tags) ? tags : tags ? [tags] : [];
  for (const tag of tagList) {
    const val = normalizeGroupName(tag);
    if (!val) continue;
    keys.add(val.toLowerCase());
  }

  if (feed.port != null && feed.port !== "") {
    keys.add(String(feed.port).trim());
  }

  for (const key of keys) {
    dataFeedGroupsByKey.set(key, groups);
    registerConnectionGroups([key], groups);
  }
}

function crossLinkFeedsAndSubscriptions(feeds, subList) {
  for (const feed of Array.isArray(feeds) ? feeds : []) {
    const feedName = normalizeGroupName(feed?.name).toLowerCase();
    const groups = normalizeDataFeedGroupList(
      feed?.filtergroup || feed?.filterGroup || feed?.filterGroups || feed?.groups
    );
    if (!feedName || !groups.length) continue;

    for (const sub of Array.isArray(subList) ? subList : []) {
      const callsign = normalizeGroupName(sub?.callsign).toLowerCase();
      const username = normalizeGroupName(sub?.username).toLowerCase();
      const matchesFeed =
        callsign === feedName ||
        username === feedName ||
        (callsign && callsign.includes(feedName)) ||
        (username && username.includes(feedName));
      if (!matchesFeed) continue;

      registerConnectionGroups(
        [sub.uid, sub.clientUid, sub.clientUuid, sub.connectionUid, sub.deviceUid],
        groups
      );
    }
  }
}

function mergeDataFeedConnectionIndex() {
  for (const feed of dataFeedListCache) {
    registerDataFeedGroups(feed);
  }
  crossLinkFeedsAndSubscriptions(dataFeedListCache, subscriptionListCache);
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
    dataFeedListCache = feeds;
    mergeDataFeedConnectionIndex();

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

  // MITRE _flow-tags_: each attribute name is a system id (e.g. TAK-Server-<connection-uuid>).
  const flowTagsNodes = [
    detail["_flow-tags_"],
    detail["flow-tags"],
    detail._flowTags,
    detail.flowTags,
  ].filter(Boolean);

  for (const node of flowTagsNodes) {
    const list = Array.isArray(node) ? node : [node];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const attrs = item._attributes || item;
      for (const [key, val] of Object.entries(attrs)) {
        if (key === "version" || val == null) continue;
        const k = String(key || "").trim();
        if (k) uids.add(k);
      }
    }
  }

  // Some parsers / variants use flow_tag element(s) with uid attr.
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
  const bare = id.replace(/^tak-server-/, "");
  return (
    connectionGroupsByUid.get(id) ||
    connectionGroupsByUid.get(bare) ||
    connectionGroupsByUid.get(`tak-server-${bare}`) ||
    dataFeedGroupsByKey.get(id) ||
    dataFeedGroupsByKey.get(bare) ||
    dataFeedGroupsByKey.get(`tak-server-${bare}`) ||
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
    const groups = lookupConnectionGroups(uid);
    if (!groups.length && isFlowProvenanceId(uid)) continue;
    out.push(...groups);
  }
  return dedupeGroupNames(out);
}

function extractConnectionIdsFromText(text) {
  const out = new Set();
  const s = String(text || "");
  if (!s.trim()) return [];

  const patterns = [
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    /TAK-Server-[0-9a-f]{32}/gi,
  ];
  for (const re of patterns) {
    for (const match of s.matchAll(re)) {
      const id = normalizeGroupName(match[0]);
      if (id) out.add(id);
    }
  }
  return Array.from(out);
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

function parseSourceHints(detail) {
  if (!detail || typeof detail !== "object") return [];
  const hints = [];

  function pushHint(raw) {
    const n = normalizeGroupName(raw);
    if (n) hints.push(n);
  }

  function pushFromAttrs(attrs) {
    if (!attrs || typeof attrs !== "object") return;
    for (const field of ["uid", "callsign", "name", "platform", "type", "version", "feed", "url"]) {
      pushHint(attrs[field]);
    }
    const urlText = attrs.url || attrs.href || attrs.link || "";
    for (const id of extractConnectionIdsFromText(urlText)) {
      pushHint(id);
    }
    const portMatch = String(urlText).match(/:(\d{2,5})(?:\/|$|\?)/);
    if (portMatch) pushHint(portMatch[1]);
  }

  const source = detail.source;
  const list = Array.isArray(source) ? source : source ? [source] : [];
  for (const item of list) {
    if (typeof item === "string" || typeof item === "number") {
      pushHint(item);
      for (const id of extractConnectionIdsFromText(item)) pushHint(id);
      continue;
    }
    pushFromAttrs(item?._attributes || item);
  }

  const links = detail.link;
  const linkList = Array.isArray(links) ? links : links ? [links] : [];
  for (const link of linkList) {
    if (typeof link === "string" || typeof link === "number") {
      pushHint(link);
      for (const id of extractConnectionIdsFromText(link)) pushHint(id);
      continue;
    }
    pushFromAttrs(link?._attributes || link);
  }

  return hints;
}

function resolveGroupsFromSourceHints(hints) {
  for (const hint of hints || []) {
    const groups = lookupGroupsByConnectionKey(String(hint).toLowerCase());
    const out = dedupeGroupNames(groups);
    if (out.length) return out;
  }
  return [];
}

function parseRelatedUids(detail) {
  if (!detail || typeof detail !== "object") return [];
  const uids = new Set();

  function addUid(raw) {
    const n = normalizeGroupName(raw);
    if (!n || n.length <= 4) return;
    if (/^https?:\/\//i.test(n) || /^tcp:\/\//i.test(n)) return;
    uids.add(n);
  }

  function addFromAttrs(attrs) {
    if (!attrs || typeof attrs !== "object") return;
    addUid(attrs.uid);
    addUid(attrs.callsign);
    addUid(attrs.name);
    for (const id of extractConnectionIdsFromText(attrs.url || attrs.href || attrs.link)) {
      addUid(id);
    }
  }

  const links = detail.link;
  const linkList = Array.isArray(links) ? links : links ? [links] : [];
  for (const link of linkList) {
    if (typeof link === "string" || typeof link === "number") {
      for (const id of extractConnectionIdsFromText(link)) addUid(id);
      continue;
    }
    addFromAttrs(link?._attributes || link);
    addUid(link?.uid);
  }

  const source = detail.source;
  const sourceList = Array.isArray(source) ? source : source ? [source] : [];
  for (const item of sourceList) {
    if (typeof item === "string" || typeof item === "number") {
      for (const id of extractConnectionIdsFromText(item)) addUid(id);
      continue;
    }
    addFromAttrs(item?._attributes || item);
  }

  const uidNode = detail.uid || detail._uid_;
  const uidNodes = Array.isArray(uidNode) ? uidNode : uidNode ? [uidNode] : [];
  for (const item of uidNodes) {
    const attrs = item?._attributes || item || {};
    for (const val of Object.values(attrs)) {
      addUid(val);
    }
  }

  const creator = detail.creator?._attributes || detail.creator;
  addUid(creator?.uid);

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
  if (flowTag && isAssignableChannelGroupName(flowTag)) names.add(normalizeGroupName(flowTag));

  return filterAssignableChannelGroups(Array.from(names));
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

  const related = Array.isArray(marker?.relatedUids) ? marker.relatedUids : [];
  for (const rel of related) {
    const rk = String(rel || "").trim().toLowerCase();
    if (rk) keys.push(rk);
  }

  const uid = String(marker?.uid || "").trim();
  if (uid) keys.push(uid.toLowerCase());

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

/** Standard ATAK team color names (matches portal dashboard / device prefs). */
const ATAK_TEAM_COLORS = {
  Blue: "#1e88e5",
  "Dark Blue": "#0d47a1",
  Brown: "#6d4c41",
  Cyan: "#00acc1",
  Green: "#43a047",
  "Dark Green": "#1b5e20",
  Magenta: "#d81b60",
  Maroon: "#800000",
  Orange: "#ff7b00",
  Purple: "#8e24aa",
  Red: "#e53935",
  Teal: "#00897b",
  White: "#ffffff",
  Yellow: "#fdd835",
};

const ATAK_TEAM_COLORS_LC = Object.fromEntries(
  Object.entries(ATAK_TEAM_COLORS).map(([name, hex]) => [name.toLowerCase(), hex])
);

const AFFILIATION_COLORS = {
  friend: "#22c55e",
  hostile: "#ef4444",
  neutral: "#eab308",
  unknown: "#f97316",
  other: "#38bdf8",
};

function parseTeamName(detail) {
  return normalizeGroupName(
    detail?.__group?._attributes?.name ||
      detail?.team?._attributes?.name ||
      detail?.__group?.name ||
      detail?.team?.name ||
      ""
  );
}

function parseTeamRole(detail) {
  const raw =
    detail?.__group?._attributes?.role ||
    detail?.team?._attributes?.role ||
    detail?.__group?.role ||
    detail?.team?.role ||
    "";
  const s = String(raw || "").trim();
  return s || null;
}

function parseRoundedTrackNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function cotNodeAttributes(node) {
  if (node == null || typeof node !== "object") return null;
  if (node._attributes && typeof node._attributes === "object") {
    return node._attributes;
  }
  const keys = Object.keys(node).filter(function (k) {
    return k !== "_text" && k !== "#text" && !k.startsWith("_");
  });
  if (!keys.length) return null;
  return node;
}

function firstRoundedFromNodes(nodes, field) {
  const list = Array.isArray(nodes) ? nodes : nodes != null ? [nodes] : [];
  for (let i = 0; i < list.length; i++) {
    const attrs = cotNodeAttributes(list[i]);
    if (!attrs) continue;
    const n = parseRoundedTrackNumber(attrs[field]);
    if (n != null) return n;
  }
  return null;
}

/** Pull Speed/Course/Heading/Bearing labels from free-text remarks (AVL / CAD feeds). */
function parseCourseSpeedFromText(text) {
  const s = String(text || "");
  if (!s.trim()) return { course: null, speed: null };

  let course = null;
  let speed = null;

  const courseMatch = s.match(
    /(?:^|[\n\r])[\s]*(?:Course|Heading|Bearing|COG|cog)[:\s=]+(-?\d+(?:\.\d+)?)/im
  );
  if (courseMatch) {
    course = parseRoundedTrackNumber(courseMatch[1]);
  }

  const speedMatch = s.match(
    /(?:^|[\n\r])[\s]*(?:Speed|SPD|spd|Velocity)[:\s=]+(-?\d+(?:\.\d+)?)/im
  );
  if (speedMatch) {
    speed = parseRoundedTrackNumber(speedMatch[1]);
  }

  return { course, speed };
}

function remarksTextForCourseSpeed(detail) {
  const parts = [];
  const remarksNode = detail?.remarks ?? detail?.remark;
  if (remarksNode != null) {
    const list = Array.isArray(remarksNode) ? remarksNode : [remarksNode];
    for (const item of list) {
      const text = extractRemarksText(item);
      if (text) parts.push(text);
    }
  }
  const contact = detail?.contact?._attributes || detail?.contact;
  if (contact && typeof contact.remarks === "string" && contact.remarks.trim()) {
    parts.push(contact.remarks.trim());
  }
  const link = detail?.link;
  const linkList = Array.isArray(link) ? link : link != null ? [link] : [];
  for (let i = 0; i < linkList.length; i++) {
    const attrs = cotNodeAttributes(linkList[i]);
    if (attrs && typeof attrs.remarks === "string" && attrs.remarks.trim()) {
      parts.push(attrs.remarks.trim());
    }
  }
  return parts.join("\n");
}

/**
 * Course (°) and speed from CoT — standard track/point attrs, then AVL/CAD remarks fallbacks.
 */
function parseCourseAndSpeed(detail, pointAttrs) {
  const d = detail || {};
  const point = pointAttrs || {};

  let course =
    firstRoundedFromNodes(d.track, "course") ??
    parseRoundedTrackNumber(point.course) ??
    firstRoundedFromNodes(d.status, "course") ??
    firstRoundedFromNodes(d.sensor, "course") ??
    firstRoundedFromNodes(d.link, "course");

  let speed =
    firstRoundedFromNodes(d.track, "speed") ??
    parseRoundedTrackNumber(point.speed) ??
    firstRoundedFromNodes(d.status, "speed") ??
    firstRoundedFromNodes(d.sensor, "speed") ??
    firstRoundedFromNodes(d.link, "speed");

  if (course == null || speed == null) {
    const fromRemarks = parseCourseSpeedFromText(remarksTextForCourseSpeed(d));
    if (course == null) course = fromRemarks.course;
    if (speed == null) speed = fromRemarks.speed;
  }

  return { course, speed };
}

function teamNameToColor(name) {
  const n = normalizeGroupName(name);
  if (!n) return null;
  if (ATAK_TEAM_COLORS[n]) return ATAK_TEAM_COLORS[n];
  return ATAK_TEAM_COLORS_LC[n.toLowerCase()] || null;
}

function clampColorByte(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(255, Math.round(n)));
}

function extractRemarksText(node) {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") {
    return String(node).trim();
  }
  if (typeof node !== "object") return "";
  if (typeof node._text === "string") return node._text.trim();
  for (const key of ["#text", "text", "value", "content"]) {
    if (typeof node[key] === "string" && node[key].trim()) {
      return node[key].trim();
    }
  }
  return "";
}

/** CoT detail.remarks — free-text notes on markers and incidents. */
function parseRemarks(detail) {
  const parts = [];
  const remarksNode = detail?.remarks ?? detail?.remark;
  if (remarksNode != null) {
    const list = Array.isArray(remarksNode) ? remarksNode : [remarksNode];
    for (const item of list) {
      const text = extractRemarksText(item);
      if (text) parts.push(text);
    }
  }
  const contact = detail?.contact?._attributes || detail?.contact;
  if (contact && typeof contact.remarks === "string" && contact.remarks.trim()) {
    parts.push(contact.remarks.trim());
  }
  const joined = parts.join("\n\n").trim();
  return joined || null;
}

/** CoT detail.color — common on data-feed / AVL injected markers (no __group). */
function parseDetailColor(detail) {
  const node = detail?.color;
  if (node == null) return null;

  const list = Array.isArray(node) ? node : [node];
  for (const item of list) {
    if (typeof item === "string" || typeof item === "number") {
      const parsed = normalizeTakColor(item);
      if (parsed) return parsed;
      continue;
    }
    if (!item || typeof item !== "object") continue;

    const attrs = item._attributes || item;
    for (const field of ["argb", "value", "color"]) {
      const parsed = normalizeTakColor(attrs[field]);
      if (parsed) return parsed;
    }

    const r = clampColorByte(attrs.red ?? attrs.r);
    const g = clampColorByte(attrs.green ?? attrs.g);
    const b = clampColorByte(attrs.blue ?? attrs.b);
    if (r == null && g == null && b == null) continue;
    const a = clampColorByte(attrs.alpha ?? attrs.a);
    if (a === 0) continue;
    return (
      "#" +
      (r ?? 0).toString(16).padStart(2, "0") +
      (g ?? 0).toString(16).padStart(2, "0") +
      (b ?? 0).toString(16).padStart(2, "0")
    );
  }

  return null;
}

function parseTeamColor(detail) {
  const fromGroup =
    detail?.__group?._attributes?.color ||
    detail?.team?._attributes?.color ||
    null;
  return normalizeTakColor(fromGroup) || parseDetailColor(detail);
}

/** Map marker fill: CoT color attrs, then ATAK team name, then affiliation. */
function resolveMarkerDisplayColor(marker) {
  const fromAttr = normalizeTakColor(marker?.teamColor);
  if (fromAttr) return fromAttr;

  const team = normalizeGroupName(marker?.team);
  const fromTeam = teamNameToColor(team);
  if (fromTeam) return fromTeam;

  const aff = String(marker?.affiliation || "other").trim();
  return AFFILIATION_COLORS[aff] || AFFILIATION_COLORS.other;
}

/** ATAK/TAK team colors are often signed 32-bit ARGB integers, not CSS hex. */
function normalizeTakColor(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  if (/^#[0-9a-f]{3,8}$/i.test(s)) {
    if (s.length === 4 || s.length === 7) {
      if (s.toLowerCase() === "#ffffff" || s.toLowerCase() === "#fff") return null;
      return s;
    }
    return s.slice(0, 7);
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (n === -1 || (n >>> 0) === 0xffffffff) return null;

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
    subscriptionListCache = list;
    rebuildConnectionGroupIndex(list);
    mergeDataFeedConnectionIndex();
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

function isDataFeedConnectionKey(key) {
  const k = String(key || "").trim().toLowerCase();
  if (!k) return false;
  const bare = k.replace(/^tak-server-/, "");
  return !!(
    dataFeedGroupsByKey.get(k) ||
    dataFeedGroupsByKey.get(bare) ||
    dataFeedGroupsByKey.get(`tak-server-${bare}`)
  );
}

function isLiveEudSubscription(marker) {
  const uid = String(marker?.uid || "").trim().toLowerCase();
  if (uid && subscriptionIndex.byUid.has(uid)) return true;

  const callsign = normalizeGroupName(marker?.callsign).toLowerCase();
  if (callsign && subscriptionIndex.byCallsign.has(callsign)) return true;
  if (callsign && subscriptionIndex.byUsername.has(callsign)) return true;

  return false;
}

function markerHasDataFeedProvenance(marker) {
  const keys = new Set();
  const uid = String(marker?.uid || "").trim();
  if (uid) keys.add(uid);
  const callsign = normalizeGroupName(marker?.callsign);
  if (callsign) keys.add(callsign);

  for (const rel of marker?.relatedUids || []) {
    const r = String(rel || "").trim();
    if (r) keys.add(r);
  }
  for (const hint of marker?.sourceHints || []) {
    const h = String(hint || "").trim();
    if (h) keys.add(h);
  }
  for (const ft of marker?.flowTagUids || []) {
    const f = String(ft || "").trim();
    if (f && !isFlowProvenanceId(f)) keys.add(f);
  }

  for (const raw of keys) {
    if (isDataFeedConnectionKey(raw)) return true;
  }
  return false;
}

/**
 * Classify marker provenance for map draw priority (EUD above data feeds).
 * @returns {"eud"|"feed"|"unknown"}
 */
function classifyMarkerOrigin(marker) {
  if (!marker) return "unknown";

  if (isLiveEudSubscription(marker)) return "eud";
  if (markerHasDataFeedProvenance(marker)) return "feed";

  const type = String(marker.type || "").trim();
  if (/^a-f-G-/i.test(type)) return "eud";
  if (/^a-[fnhu]-A-/i.test(type)) return "feed";
  if (/^a-f-[GUS]-/i.test(type)) return "eud";

  return "unknown";
}

function resolveGroupsForMarker(marker, cotDetail) {
  const detail = cotDetail && typeof cotDetail === "object" ? cotDetail : null;

  // EUD clients: marker uid matches a live subscription connection uid.
  const fromSub = resolveGroupsFromSubscription(marker);
  if (fromSub[0] !== UNASSIGNED_GROUP) return fromSub;

  const fromCot = filterAssignableChannelGroups(
    detail
      ? parseGroupsFromCoTDetail(detail)
      : Array.isArray(marker?.cotRouteGroups)
        ? marker.cotRouteGroups
        : []
  );

  const fromFlow = resolveGroupsFromFlowTags(
    detail || { flowTagUids: marker?.flowTagUids || [] }
  );

  const routed = dedupeGroupNames([...fromCot, ...fromFlow]);
  if (routed.length) return routed;

  const fromSource = resolveGroupsFromSourceHints(
    detail ? parseSourceHints(detail) : marker?.sourceHints || []
  );
  if (fromSource.length) return fromSource;

  return [UNASSIGNED_GROUP];
}

/**
 * Diagnostic trace for why a marker landed in its assigned group(s).
 * Compare a working EUD vs a data-feed marker side by side.
 */
function explainGroupAssignment(marker) {
  const cotRouteGroups = filterAssignableChannelGroups(
    Array.isArray(marker?.cotRouteGroups) ? marker.cotRouteGroups : []
  );
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
  const sourceHints = Array.isArray(marker?.sourceHints) ? marker.sourceHints : [];

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
      sourceHints,
      detailKeys: Array.isArray(marker?.detailKeys) ? marker.detailKeys : [],
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
      step4_sourceHints: sourceHints,
      step4_sourceGroups: resolveGroupsFromSourceHints(sourceHints),
      recomputedGroups: recomputed,
    },
    notes: [
      "EUD clients usually match via step3 (subscription by uid/callsign).",
      "TAK-Server-<uuid> in _flow-tags_ is the server instance fingerprint on every event, not a channel name.",
      "Data feeds match via CoT filtergroup/marti, feed connection uid in link/source, or feed name/tag in the datafeeds index.",
      "If step2 flowTagUids only contains TAK-Server-<uuid> with empty connectionGroups, that is expected — look at step4 sourceHints and relatedUids.",
      "If step4_sourceGroups is empty, paste sourceHints from the marker block so link/source attrs can be wired up.",
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

function getUserMemberChannelBaseKeys(userGroupNames) {
  const keys = new Set();
  for (const raw of userGroupNames || []) {
    const name = normalizeGroupName(raw);
    if (!name || !isMapChannelGroupName(name)) continue;
    const key = channelBaseKey(name);
    if (key) keys.add(key);
  }
  return keys;
}

function filterMapGroupsForUserMembership(groups, userGroupNames) {
  const memberKeys = getUserMemberChannelBaseKeys(userGroupNames);
  if (!memberKeys.size) return [];
  return (Array.isArray(groups) ? groups : []).filter((g) => {
    const key = g.baseKey || channelBaseKey(g.name);
    return key && memberKeys.has(key);
  });
}

async function getTakGroupCatalog(markers, options = {}) {
  await refreshGroupCatalog();
  let groups = buildGroupsCatalogWithCounts(markers);
  if (options.scopeMemberGroups) {
    groups = filterMapGroupsForUserMembership(groups, options.userGroupNames || []);
  }
  return {
    groups,
    channelScope: options.scopeMemberGroups ? "member" : "all",
    allowedChannelKeys: options.scopeMemberGroups
      ? Array.from(getUserMemberChannelBaseKeys(options.userGroupNames || []))
      : null,
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
  parseSourceHints,
  parseRelatedUids,
  onSubscriptionIndexRefreshed,
  parseAffiliationFromType,
  parseTeamName,
  parseTeamRole,
  parseCourseAndSpeed,
  parseTeamColor,
  parseRemarks,
  parseDetailColor,
  teamNameToColor,
  resolveMarkerDisplayColor,
  normalizeTakColor,
  resolveGroupsForMarker,
  classifyMarkerOrigin,
  filterAssignableChannelGroups,
  explainGroupAssignment,
  getTakGroupCatalog,
  getUserMemberChannelBaseKeys,
  filterMapGroupsForUserMembership,
  refreshGroupCatalog,
  refreshSubscriptionIndex,
  refreshDataFeedIndex,
  getSubscriptionIndexSnapshot,
  buildGroupsCatalogWithCounts,
};
