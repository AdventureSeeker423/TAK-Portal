/**
 * Map metadata: portal group catalog + subscription index for marker enrichment.
 */
const dataSyncAccess = require("./dataSyncAccess.service");
const groupsSvc = require("./groups.service");
const takMetrics = require("./takMetrics.service");
const { isTakBypassed, isTakConfigured, buildTakAxios } = require("./tak.service");

const SUBSCRIPTION_REFRESH_MS = 30000;
const DATAFEED_DETAIL_CACHE_MS = 5 * 60 * 1000;
const INTEGRATION_LINK_REFRESH_MS = 60000;
const UNASSIGNED_GROUP = "Unassigned";
/** Stable channel key for Unassigned so channel/member filters can show those markers. */
const UNASSIGNED_CHANNEL_KEY = "__unassigned__";

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
/**
 * Union of publish groups from live federation-token subscriptions.
 * Used when multi-hop TAK-Server flow tags do not resolve to a single connection.
 */
let federationSubscriptionGroups = [];

let dataFeedCache = {
  fetchedAt: 0,
  error: null,
};

/** Latest Marti payloads used to cross-link feed config with live connections. */
let subscriptionListCache = [];
let dataFeedListCache = [];
let integrationFeedLinkCache = {
  entries: [],
  fetchedAt: 0,
  error: null,
};
/** name -> { groups, fetchedAt } — avoids per-feed Marti GET on every refresh */
let dataFeedDetailGroupsCache = new Map();

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

function channelGroupKey(name) {
  const n = normalizeGroupName(name).toLowerCase();
  if (!n) return "";
  if (n === UNASSIGNED_GROUP.toLowerCase() || n === UNASSIGNED_CHANNEL_KEY) {
    return UNASSIGNED_CHANNEL_KEY;
  }
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
  const raw = normalizeGroupName(name);
  if (!raw) return "";
  if (
    raw.toLowerCase() === UNASSIGNED_GROUP.toLowerCase() ||
    raw.toLowerCase() === UNASSIGNED_CHANNEL_KEY
  ) {
    return UNASSIGNED_CHANNEL_KEY;
  }
  const base = stripChannelBehaviorSuffix(raw);
  if (!base || base.toLowerCase() === UNASSIGNED_GROUP.toLowerCase()) {
    return UNASSIGNED_CHANNEL_KEY;
  }
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
  const n = stripLdapDnGroupName(name);
  if (!n || n === UNASSIGNED_GROUP) return null;
  const display = stripChannelBehaviorSuffix(isMapChannelGroupName(n) ? n : groupsSvc.ensureTakPrefix(n));
  return channelCatalogName(display);
}

/**
 * Marti sometimes returns LDAP DNs (cn=tak_Foo) instead of bare group names.
 * Extract the CN value; leave non-DN names unchanged.
 */
function stripLdapDnGroupName(name) {
  const n = normalizeGroupName(name);
  if (!n) return "";
  const cn = n.match(/^cn\s*=\s*([^,]+)/i);
  if (cn && cn[1]) return normalizeGroupName(cn[1]);
  return n;
}

function isTakChannelGroupName(name) {
  const n = stripLdapDnGroupName(name);
  if (!n || n === UNASSIGNED_GROUP) return false;
  if (n.startsWith("_") || n.toLowerCase() === "__anon__") return false;
  if (/^cn=/i.test(n)) return false;
  if (/authentik/i.test(n)) return false;
  return true;
}

function subscriptionGroupName(entry) {
  return stripLdapDnGroupName(
    entry?.name || entry?.groupName || entry?.group || entry?.cn || ""
  );
}

function isFlowProvenanceId(name) {
  return /^TAK-Server-/i.test(String(name || "").trim());
}

/**
 * Expand a connection / flow-tag id into lookup keys.
 * Flow tags use TAK-Server-<32hex>; Marti subscriptions often use hyphenated UUIDs.
 */
function connectionUidLookupKeys(raw) {
  const keys = new Set();
  const val = normalizeGroupName(raw);
  if (!val) return [];

  const lower = val.toLowerCase();
  keys.add(lower);

  const bare = lower.replace(/^tak-server-/, "");
  if (bare) {
    keys.add(bare);
    keys.add(`tak-server-${bare}`);
  }

  const compact = bare.replace(/-/g, "");
  if (compact) {
    keys.add(compact);
    keys.add(`tak-server-${compact}`);
    if (/^[0-9a-f]{32}$/i.test(compact)) {
      const hyphenated = compact.replace(
        /^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/i,
        "$1-$2-$3-$4-$5"
      );
      keys.add(hyphenated);
      keys.add(`tak-server-${hyphenated}`);
    }
  }

  return Array.from(keys);
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
    const name = stripLdapDnGroupName(raw);
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
    const n = stripLdapDnGroupName(item);
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
    for (const key of connectionUidLookupKeys(rawId)) {
      connectionGroupsByUid.set(key, list);
    }
  }
}

function federationProtocolIds(protocol) {
  const s = String(protocol || "").trim();
  if (!s) return [];
  const ids = [];
  // e.g. FIGFed_FedHub_<32hex>
  const m = s.match(/([0-9a-f]{32})$/i) || s.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (m && m[1]) ids.push(m[1]);
  ids.push(s);
  return ids;
}

function subscriptionIdentityIds(sub) {
  return [
    sub?.uid,
    sub?.clientUid,
    sub?.clientUuid,
    sub?.connectionUid,
    sub?.deviceUid,
    sub?.serverId,
    sub?.federateId,
    sub?.remoteServerId,
    ...federationProtocolIds(sub?.protocol),
  ];
}

function isLikelyFederationSubscription(sub) {
  if (!sub || typeof sub !== "object") return false;
  if (takMetrics.isFederationTokenUsername(sub.username)) return true;
  const callsign = String(sub.callsign || "").toLowerCase();
  const username = String(sub.username || "").toLowerCase();
  const protocol = String(sub.protocol || "").toLowerCase();
  const handler = String(sub.handler || "").toLowerCase();
  if (callsign.includes("federat") || username.includes("federat")) return true;
  if (protocol.includes("federat") || handler.includes("federat")) return true;
  if (callsign.includes("fedhub") || protocol.includes("fedhub") || protocol.includes("figfed")) {
    return true;
  }
  return false;
}

function rebuildConnectionGroupIndex(subList) {
  connectionGroupsByUid = new Map();
  const fedGroups = [];

  for (const sub of Array.isArray(subList) ? subList : []) {
    const groups = subscriptionPublishGroups(sub);
    if (!groups.length) continue;

    registerConnectionGroups(subscriptionIdentityIds(sub), groups);

    if (isLikelyFederationSubscription(sub)) {
      fedGroups.push(...groups);
      registerConnectionGroups([sub.callsign, sub.username], groups);
    }
  }

  federationSubscriptionGroups = dedupeGroupNames(fedGroups);
}

/** Letters/digits only — matches integration title slugs to hyphenated marker uid prefixes. */
function normalizeFeedIdentityKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const FEED_IDENTITY_MIN_OVERLAP = 5;

function feedIdentityOverlaps(a, b) {
  const na = normalizeFeedIdentityKey(a);
  const nb = normalizeFeedIdentityKey(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= FEED_IDENTITY_MIN_OVERLAP && nb.includes(na)) return true;
  if (nb.length >= FEED_IDENTITY_MIN_OVERLAP && na.includes(nb)) return true;
  return false;
}

/** Non-numeric uid segments joined, e.g. lightbug-swat-40002573 -> lightbugswat */
function markerUidTokenSlug(marker) {
  const parts = String(marker?.uid || "")
    .trim()
    .toLowerCase()
    .split(/[-_]+/)
    .filter((part) => part && !/^\d+$/.test(part));
  return parts.length ? parts.join("") : "";
}

function markerUidNameTokens(marker) {
  return String(marker?.uid || "")
    .trim()
    .toLowerCase()
    .split(/[-_]+/)
    .filter((part) => part && !/^\d+$/.test(part) && part.length >= 3);
}

function subscriptionTlsPort(sub) {
  if (sub?.port != null && sub.port !== "") return String(sub.port).trim();
  const callsign = String(sub?.callsign || "");
  const match = callsign.match(/:(\d{2,5})$/);
  return match ? match[1] : "";
}

function dataFeedPublishGroups(feed) {
  return normalizeDataFeedGroupList(
    feed?.filtergroup || feed?.filterGroup || feed?.filterGroups || feed?.groups
  );
}

function dataFeedIdentityFields(feed) {
  const fields = [];
  for (const field of [feed?.name, feed?.uuid, feed?.uid, feed?.id]) {
    const val = normalizeGroupName(field);
    if (val) fields.push(val);
  }
  const tags = feed?.tag;
  const tagList = Array.isArray(tags) ? tags : tags ? [tags] : [];
  for (const tag of tagList) {
    const val = normalizeGroupName(tag);
    if (val) fields.push(val);
  }
  return fields;
}

function feedMatchesSubscriptionIdentity(feed, sub) {
  const feedName = normalizeGroupName(feed?.name).toLowerCase();
  const callsign = normalizeGroupName(sub?.callsign).toLowerCase();
  const username = normalizeGroupName(sub?.username).toLowerCase();
  const feedFields = dataFeedIdentityFields(feed);
  const subFields = [callsign, username].filter(Boolean);

  for (const feedField of feedFields) {
    for (const subField of subFields) {
      if (subField === feedName) return true;
      if (feedField && subField.includes(feedField.toLowerCase())) return true;
      if (subField && feedField.toLowerCase().includes(subField)) return true;
      if (feedIdentityOverlaps(feedField, subField)) return true;
    }
  }

  const feedPort = feed?.port != null && feed?.port !== "" ? String(feed.port).trim() : "";
  const subPort = subscriptionTlsPort(sub);
  return !!(feedPort && subPort && feedPort === subPort);
}

function registerDataFeedLookupKeys(rawKey, groups) {
  const list = dedupeGroupNames(groups);
  if (!list.length) return;

  const keys = new Set(connectionUidLookupKeys(rawKey));
  const val = normalizeGroupName(rawKey);
  if (val) {
    keys.add(val.toLowerCase());
    const identity = normalizeFeedIdentityKey(val);
    if (identity) keys.add(identity);
  }

  for (const key of keys) {
    dataFeedGroupsByKey.set(key, list);
    registerConnectionGroups([key], list);
  }
}

function registerDataFeedGroups(feed) {
  if (!feed || typeof feed !== "object") return;
  const groups = dataFeedPublishGroups(feed);
  if (!groups.length) return;

  for (const field of dataFeedIdentityFields(feed)) {
    registerDataFeedLookupKeys(field, groups);
  }

  if (feed.port != null && feed.port !== "") {
    registerDataFeedLookupKeys(String(feed.port).trim(), groups);
  }
}

function buildDataFeedIdentityCandidates(marker) {
  const out = [];
  const seen = new Set();

  function add(raw) {
    const s = String(raw || "").trim().toLowerCase();
    if (!s || s.length < 3 || seen.has(s)) return;
    seen.add(s);
    out.push(s);

    const identity = normalizeFeedIdentityKey(s);
    if (identity && identity.length >= 3 && !seen.has(identity)) {
      seen.add(identity);
      out.push(identity);
    }
  }

  add(marker?.uid);

  let cur = String(marker?.uid || "").trim().toLowerCase();
  while (cur) {
    const next = cur.replace(/[-_]\d+$/, "");
    if (!next || next === cur || next.length < 3) break;
    cur = next;
    add(cur);
  }

  for (const rel of marker?.relatedUids || []) {
    add(rel);
  }

  const tokenSlug = markerUidTokenSlug(marker);
  if (tokenSlug) add(tokenSlug);

  for (const token of markerUidNameTokens(marker)) {
    add(token);
  }

  return out;
}

function resolveGroupsFromDataFeedIndex(marker) {
  for (const key of buildDataFeedIdentityCandidates(marker)) {
    const groups = lookupConnectionGroups(key);
    const out = dedupeGroupNames(groups);
    if (out.length) return out;
  }
  return [];
}

function integrationUsernameTitleSlug(username) {
  const u = String(username || "").trim().toLowerCase();
  if (!u.startsWith("nodered-")) return "";
  const parts = u.split("-").filter(Boolean);
  if (parts.length < 3) return "";
  if (parts[1] === "global") return parts.slice(2).join("");
  return parts.slice(3).join("");
}

function integrationPortalGroups(user, groupByPk) {
  const groups = [];
  const attrGroup = normalizeGroupName(user?.attributes?.tak_integration_group);
  if (attrGroup) groups.push(...normalizeDataFeedGroupList([attrGroup]));

  for (const item of Array.isArray(user?.groups) ? user.groups : []) {
    let name = null;
    if (item && typeof item === "object") {
      name =
        normalizeGroupName(item.name) ||
        normalizeGroupName(groupByPk.get(String(item.pk ?? item.id))?.name);
    } else {
      name = normalizeGroupName(groupByPk.get(String(item))?.name);
    }
    if (name) groups.push(...normalizeDataFeedGroupList([name]));
  }
  return dedupeGroupNames(groups);
}

async function resolveIntegrationPortalGroups(user, groupByPk) {
  let groups = integrationPortalGroups(user, groupByPk);
  if (groups.length) return groups;

  const pk = user?.pk ?? user?.id;
  if (!pk) return [];

  try {
    const usersSvc = require("./users.service");
    const full = await usersSvc.getUserById(pk);
    if (full) groups = integrationPortalGroups(full, groupByPk);
  } catch {
    return [];
  }

  return groups;
}

function integrationTitleWordKeys(title) {
  const keys = new Set();
  for (const word of String(title || "").toLowerCase().split(/[^a-z0-9]+/)) {
    const norm = normalizeFeedIdentityKey(word);
    if (norm && norm.length >= 4) keys.add(norm);
  }
  return Array.from(keys);
}

function registerIntegrationLinkKeys(entry) {
  const groups = entry?.groups;
  if (!Array.isArray(groups) || !groups.length) return;

  const linkKeys = new Set();
  for (const field of [entry.dataFeedName, entry.username]) {
    const val = normalizeGroupName(field);
    if (val) linkKeys.add(val);
  }

  const usernameSlug = integrationUsernameTitleSlug(entry.username);
  if (usernameSlug) linkKeys.add(usernameSlug);

  for (const word of entry.titleWordKeys || integrationTitleWordKeys(entry.title)) {
    linkKeys.add(word);
  }

  for (const key of linkKeys) {
    registerDataFeedLookupKeys(key, groups);
  }
}

function crossLinkIntegrationsAndSubscriptions(subList) {
  for (const entry of integrationFeedLinkCache.entries || []) {
    if (!entry?.groups?.length || !entry?.username) continue;
    const entryUser = String(entry.username).trim().toLowerCase();
    if (!entryUser) continue;

    for (const sub of Array.isArray(subList) ? subList : []) {
      const username = normalizeGroupName(sub?.username).toLowerCase();
      if (!username || username !== entryUser) continue;

      registerConnectionGroups(subscriptionIdentityIds(sub), entry.groups);
    }
  }
}

function applyCachedIntegrationFeedLinks() {
  for (const entry of integrationFeedLinkCache.entries || []) {
    registerIntegrationLinkKeys(entry);
  }
  crossLinkIntegrationsAndSubscriptions(subscriptionListCache);
}

async function fetchDataFeedPublishGroupsByName(dataFeedName) {
  const name = normalizeGroupName(dataFeedName);
  if (!name || isTakBypassed() || !isTakConfigured()) return [];

  const cached = dataFeedListCache.find(
    (feed) => normalizeGroupName(feed?.name).toLowerCase() === name.toLowerCase()
  );
  const fromList = cached ? dataFeedPublishGroups(cached) : [];
  if (fromList.length) return fromList;

  // Listed on Marti without filtergroup — use portal integration group; skip per-feed GET.
  if (cached) return [];

  const cacheKey = name.toLowerCase();
  const hit = dataFeedDetailGroupsCache.get(cacheKey);
  if (hit && Date.now() - hit.fetchedAt < DATAFEED_DETAIL_CACHE_MS) {
    return hit.groups;
  }

  try {
    const client = buildTakAxios();
    const res = await client.get(`/api/datafeeds/${encodeURIComponent(name)}`, {
      headers: { Accept: "application/json" },
    });
    const payload = res?.data?.data || res?.data;
    const groups = dataFeedPublishGroups(payload);
    dataFeedDetailGroupsCache.set(cacheKey, { groups, fetchedAt: Date.now() });
    return groups;
  } catch {
    return [];
  }
}

async function refreshIntegrationFeedLinks(options = {}) {
  const force = !!options.force;
  if (
    !force &&
    integrationFeedLinkCache.fetchedAt &&
    Date.now() - integrationFeedLinkCache.fetchedAt < INTEGRATION_LINK_REFRESH_MS
  ) {
    applyCachedIntegrationFeedLinks();
    return integrationFeedLinkCache;
  }
  if (isTakBypassed()) {
    integrationFeedLinkCache = {
      entries: [],
      fetchedAt: Date.now(),
      error: "TAK bypass enabled",
    };
    return integrationFeedLinkCache;
  }

  try {
    const usersSvc = require("./users.service");
    const groupsSvc = require("./groups.service");
    const integrations = await usersSvc.findIntegrationUsers();
    const allGroups = await groupsSvc.getAllGroups({ includeHidden: true });
    const groupByPk = new Map(
      (Array.isArray(allGroups) ? allGroups : []).map((g) => [String(g.pk), g])
    );

    const entries = [];
    for (const user of integrations) {
      const dataFeedName = normalizeGroupName(user?.attributes?.tak_data_feed_name);
      const title = String(user?.attributes?.integration_title || "").trim();
      const username = normalizeGroupName(user?.username);

      let groups = dataFeedName ? await fetchDataFeedPublishGroupsByName(dataFeedName) : [];
      if (!groups.length) groups = await resolveIntegrationPortalGroups(user, groupByPk);
      if (!groups.length) continue;

      const titleWordKeys = integrationTitleWordKeys(title);

      const entry = {
        username: username || null,
        dataFeedName: dataFeedName || null,
        title: title || null,
        titleWordKeys,
        groups,
      };
      registerIntegrationLinkKeys(entry);
      entries.push(entry);
    }

    integrationFeedLinkCache = {
      entries,
      fetchedAt: Date.now(),
      error: null,
    };
    applyCachedIntegrationFeedLinks();
  } catch (err) {
    integrationFeedLinkCache = {
      ...integrationFeedLinkCache,
      fetchedAt: Date.now(),
      error: err?.message || String(err),
    };
  }

  return integrationFeedLinkCache;
}

function crossLinkFeedsAndSubscriptions(feeds, subList) {
  for (const feed of Array.isArray(feeds) ? feeds : []) {
    const groups = dataFeedPublishGroups(feed);
    if (!groups.length) continue;

    for (const sub of Array.isArray(subList) ? subList : []) {
      if (!feedMatchesSubscriptionIdentity(feed, sub)) continue;

      registerConnectionGroups(subscriptionIdentityIds(sub), groups);
    }
  }
}

function mergeDataFeedConnectionIndex() {
  for (const feed of dataFeedListCache) {
    registerDataFeedGroups(feed);
  }
  crossLinkFeedsAndSubscriptions(dataFeedListCache, subscriptionListCache);
  applyCachedIntegrationFeedLinks();
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
    await refreshIntegrationFeedLinks();

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
  for (const key of connectionUidLookupKeys(uid)) {
    const hit =
      connectionGroupsByUid.get(key) ||
      dataFeedGroupsByKey.get(key);
    if (Array.isArray(hit) && hit.length) return hit;
  }
  return [];
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
  let flowProvenanceCount = 0;

  for (const uid of uids) {
    if (isFlowProvenanceId(uid)) flowProvenanceCount += 1;
    const groups = lookupConnectionGroups(uid);
    if (!groups.length && isFlowProvenanceId(uid)) continue;
    out.push(...groups);
  }

  const resolved = dedupeGroupNames(out);
  if (resolved.length) return resolved;

  // Multi-hop TAK-Server flow tags = federated provenance. When no hop maps to a
  // known local connection id, fall back to groups published by live federation
  // subscriptions (the channels federation is feeding into).
  if (flowProvenanceCount >= 2 && federationSubscriptionGroups.length) {
    return federationSubscriptionGroups.slice();
  }

  return [];
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

/** CoT detail.takv platform (e.g. ATAK-CIV, TAKAware-CIV). */
function parseTakPlatform(detail) {
  const takv = detail?.takv;
  if (!takv) return null;
  const list = Array.isArray(takv) ? takv : [takv];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const attrs = item._attributes || item;
    const platform = String(attrs?.platform || "").trim();
    if (platform) return platform;
  }
  return null;
}

/** CoT detail.status battery percentage when present. */
function parseBatteryPercent(detail) {
  const status = detail?.status;
  if (!status) return null;
  const list = Array.isArray(status) ? status : [status];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const attrs = item._attributes || item;
    const raw = attrs?.battery;
    if (raw == null || raw === "") continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.round(Math.max(0, Math.min(100, n)));
    const s = String(raw).trim();
    if (s) return s;
  }
  return null;
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

function isHttpDetailUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

/** CoT detail.link — external URLs (maps, resources) on markers. */
function parseDetailLinks(detail) {
  if (!detail || typeof detail !== "object") return [];
  const linksNode = detail.link;
  const list = Array.isArray(linksNode) ? linksNode : linksNode ? [linksNode] : [];
  const out = [];
  const seen = new Set();

  for (const item of list) {
    let url = "";
    let label = "";
    if (typeof item === "string" || typeof item === "number") {
      url = String(item).trim();
    } else if (item && typeof item === "object") {
      const attrs = item._attributes || item;
      url = String(attrs.url || attrs.href || attrs.link || "").trim();
      label = String(attrs.remarks || attrs.title || attrs.name || "").trim();
    }
    if (!isHttpDetailUrl(url)) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, label: label || url });
  }

  return out;
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

/** Portal-managed channels only (Authentik). TAK-only orphans are excluded. */
async function refreshGroupCatalog() {
  try {
    const all = await groupsSvc.getAllGroups({ forceRefresh: false });
    const names = (Array.isArray(all) ? all : [])
      .map((g) => normalizeGroupName(g?.name))
      .filter(isMapChannelGroupName)
      .sort((a, b) =>
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
  for (const k of connectionUidLookupKeys(key)) {
    if (dataFeedGroupsByKey.get(k)) return true;
  }
  return false;
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

function markerResolvedViaFeedIndex(marker) {
  if (!marker || isLiveEudSubscription(marker)) return false;
  return resolveGroupsFromDataFeedIndex(marker).length > 0;
}

/**
 * Classify marker provenance for map draw priority (EUD above data feeds).
 * @returns {"eud"|"feed"|"federation"|"spi"|"unknown"}
 */
function classifyMarkerOrigin(marker) {
  if (!marker) return "unknown";

  if (isLiveEudSubscription(marker)) return "eud";
  if (markerHasDataFeedProvenance(marker)) return "feed";
  if (markerResolvedViaFeedIndex(marker)) return "feed";

  const type = String(marker.type || "").trim();
  if (/^b-m-p-s-p-/i.test(type)) return "spi";

  const flowTags = Array.isArray(marker.flowTagUids) ? marker.flowTagUids : [];
  const flowProvenanceCount = flowTags.filter(isFlowProvenanceId).length;
  if (flowProvenanceCount >= 2) return "federation";

  if (/^a-f-G-/i.test(type)) return "eud";
  if (/^a-[fnhu]-A-/i.test(type)) return "feed";
  if (/^a-f-[GUS]-/i.test(type)) return "eud";

  return "unknown";
}

/**
 * Channel-patch rebroadcast stamps __takportal_patch with the destination catalog name.
 * Merge those into map attribution so patched channel counts reflect delivery.
 */
function parsePortalPatchDestGroups(detail) {
  if (!detail || typeof detail !== "object") return [];
  const tag = detail.__takportal_patch;
  if (!tag || typeof tag !== "object") return [];
  const attrs = tag._attributes || tag;
  const toRaw = normalizeGroupName(attrs.to || attrs.toGroup || "");
  if (!toRaw) return [];
  const channelName = toChannelGroupName(toRaw) || toRaw;
  return filterAssignableChannelGroups([channelName]);
}

/** Optional hook registered by channelPatch.engine (avoids circular require). */
let patchDestAugmenter = null;

function setPatchDestAugmenter(fn) {
  patchDestAugmenter = typeof fn === "function" ? fn : null;
}

function resolveGroupsForMarker(marker, cotDetail) {
  const detail = cotDetail && typeof cotDetail === "object" ? cotDetail : null;
  const patchDests = parsePortalPatchDestGroups(detail);

  // EUD clients: marker uid matches a live subscription connection uid.
  const fromSub = resolveGroupsFromSubscription(marker);
  if (fromSub[0] !== UNASSIGNED_GROUP) {
    const livePatchDests = patchDestAugmenter
      ? patchDestAugmenter(fromSub) || []
      : [];
    return dedupeGroupNames([...fromSub, ...patchDests, ...livePatchDests]);
  }

  const fromFeed = resolveGroupsFromDataFeedIndex(marker);
  if (fromFeed.length) {
    return patchDests.length
      ? dedupeGroupNames([...fromFeed, ...patchDests])
      : fromFeed;
  }

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

  const routed = dedupeGroupNames([...fromCot, ...fromFlow, ...patchDests]);
  if (routed.length) return routed;

  const fromSource = resolveGroupsFromSourceHints(
    detail ? parseSourceHints(detail) : marker?.sourceHints || []
  );
  if (fromSource.length) {
    return patchDests.length
      ? dedupeGroupNames([...fromSource, ...patchDests])
      : fromSource;
  }

  if (patchDests.length) return patchDests;

  return [UNASSIGNED_GROUP];
}

function buildGroupsCatalogWithCounts(markers) {
  ensureRefreshLoop();
  const counts = new Map();
  const markerList = Array.isArray(markers) ? markers : [];
  let unassignedCount = 0;

  for (const m of markerList) {
    const groups = Array.isArray(m.groups) && m.groups.length ? m.groups : [UNASSIGNED_GROUP];
    let assigned = false;
    for (const g of groups) {
      if (normalizeGroupName(g) === UNASSIGNED_GROUP) {
        unassignedCount += 1;
        assigned = true;
        continue;
      }
      const channelName = toChannelGroupName(g);
      if (!channelName) continue;
      const key = channelBaseKey(channelName);
      if (!key || key === UNASSIGNED_CHANNEL_KEY) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
      assigned = true;
    }
    if (!assigned) unassignedCount += 1;
  }

  const groups = [];

  for (const entry of consolidateChannelCatalog(catalogCache.names)) {
    groups.push({
      name: entry.name,
      displayName: entry.displayName,
      baseKey: entry.baseKey,
      markerCount: counts.get(entry.baseKey) || 0,
    });
  }

  if (unassignedCount > 0) {
    groups.push({
      name: UNASSIGNED_GROUP,
      displayName: UNASSIGNED_GROUP,
      baseKey: UNASSIGNED_CHANNEL_KEY,
      markerCount: unassignedCount,
    });
  }

  groups.sort((a, b) => {
    if (a.baseKey === UNASSIGNED_CHANNEL_KEY) return 1;
    if (b.baseKey === UNASSIGNED_CHANNEL_KEY) return -1;
    return a.displayName.localeCompare(b.displayName);
  });
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

module.exports = {
  UNASSIGNED_GROUP,
  UNASSIGNED_CHANNEL_KEY,
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
  parseTakPlatform,
  parseBatteryPercent,
  parseCourseAndSpeed,
  parseTeamColor,
  parseRemarks,
  parseDetailLinks,
  parseDetailColor,
  teamNameToColor,
  resolveMarkerDisplayColor,
  normalizeTakColor,
  resolveGroupsForMarker,
  setPatchDestAugmenter,
  classifyMarkerOrigin,
  filterAssignableChannelGroups,
  connectionUidLookupKeys,
  registerConnectionGroups,
  rebuildConnectionGroupIndex,
  lookupConnectionGroups,
  resolveGroupsFromFlowTags,
  getFederationSubscriptionGroups: () => federationSubscriptionGroups.slice(),
  getTakGroupCatalog,
  getUserMemberChannelBaseKeys,
  filterMapGroupsForUserMembership,
  refreshGroupCatalog,
  refreshSubscriptionIndex,
  refreshDataFeedIndex,
  buildGroupsCatalogWithCounts,
};
