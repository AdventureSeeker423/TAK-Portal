/**
 * Server-side bridge from TAK streaming CoT (TLS) to portal clients (SSE).
 */
const { getString, getInt } = require("./env");
const {
  getTakTlsAuth,
  isTakConfigured,
  isTakBypassed,
} = require("./tak.service");
const mapMeta = require("./mapMeta.service");
const mapIcon = require("./mapIcon.service");
const mapRender = require("./mapRender.service");
const shapeDecor = require("../public/shapeDecorFilter.js");

const STALE_SWEEP_MS = 5000;
/** Keep markers on the map this long after their CoT stale time before removing. */
const STALE_GRACE_MS = 30000;
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const SSE_BATCH_MS = 400;

/** @type {Map<string, object>} */
const markers = new Map();
/** @type {Set<(line: string) => void>} */
const subscribers = new Set();

const bridgeState = {
  connected: false,
  connecting: false,
  lastError: null,
  lastConnectAt: null,
  host: null,
  port: null,
};

let takConn = null;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_MIN_MS;
let staleTimer = null;
let started = false;
let batchTimer = null;
let markerRevision = 1;
/** @type {Map<string, object>} uid -> GeoJSON feature for live shape overlays */
const liveShapeFeatures = new Map();
/** @type {Promise<typeof import("@tak-ps/node-cot")>|null} */
let nodeCotPromise = null;

function loadNodeCot() {
  if (!nodeCotPromise) nodeCotPromise = import("@tak-ps/node-cot");
  return nodeCotPromise;
}

function hasShapeDetail(cot) {
  const detail = cot?.raw?.event?.detail;
  return !!(detail && detail.shape);
}

function isShapeDrawingCotType(type) {
  const t = String(type || "").toLowerCase();
  return t.startsWith("u-d-") || t.startsWith("u-r-") || t.startsWith("b-m-r");
}

function isShapeChildUid(uid, shapeUids) {
  const id = String(uid || "");
  if (!id) return false;
  for (const shapeUid of shapeUids) {
    if (!shapeUid || id === shapeUid) continue;
    if (id.startsWith(shapeUid + ".") || id.startsWith(shapeUid + "-")) return true;
  }
  return false;
}

function buildLiveDecorIndex() {
  return shapeDecor.buildShapeDecorIndex(Array.from(liveShapeFeatures.values()));
}

function markerToDecorFeature(marker) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [marker.lon, marker.lat] },
    properties: {
      type: marker.type,
      cotType: marker.type,
      how: marker.how,
      icon: marker.iconsetpath,
      iconsetpath: marker.iconsetpath,
    },
  };
}

function markerIsShapeDecor(marker) {
  if (!marker) return false;
  if (shapeDecor.shouldSkipLiveStreamMarker(marker)) return true;

  const uid = String(marker.uid || "");
  const shapeUids = new Set(liveShapeFeatures.keys());
  if (shapeUids.size && isShapeChildUid(uid, shapeUids)) return true;

  const index = buildLiveDecorIndex();
  if (index.hasShapes || index.ringProfiles.length || index.segments.length) {
    return shapeDecor.shouldDropShapeDecorPoint(markerToDecorFeature(marker), index);
  }
  return false;
}

function purgeShapeDecorMarkers(notify = true) {
  let removed = false;
  for (const uid of Array.from(markers.keys())) {
    const marker = markers.get(uid);
    if (!marker || !markerIsShapeDecor(marker)) continue;
    markers.delete(uid);
    removed = true;
    if (notify) queueMarkerRemove(uid);
    else bumpMarkerRevision();
  }
  if (removed && !notify) bumpMarkerRevision();
}

async function trackLiveShapeFeature(cot, marker) {
  if (!cot || !marker) return;
  const type = String(marker.type || "").toLowerCase();
  if (!isShapeDrawingCotType(type) || !hasShapeDetail(cot)) return;
  try {
    const mod = await loadNodeCot();
    const feat = await mod.CoTParser.to_geojson(cot);
    const uid = String(feat?.id || marker.uid || "");
    const geomType = String(feat?.geometry?.type || "");
    if (!uid || (geomType !== "Polygon" && geomType !== "LineString")) return;
    liveShapeFeatures.set(uid, feat);
    purgeShapeDecorMarkers(true);
  } catch (_) {}
}

function forgetLiveShape(uid) {
  const id = String(uid || "").trim();
  if (!id) return;
  liveShapeFeatures.delete(id);
}

const pendingBroadcast = {
  updates: new Map(),
  removes: new Set(),
  groupsCatalog: false,
};

function bumpMarkerRevision() {
  markerRevision += 1;
}

function getMarkerRevision() {
  return markerRevision;
}

function scheduleBatchFlush() {
  if (batchTimer) return;
  batchTimer = setTimeout(flushBroadcastBatch, SSE_BATCH_MS);
  if (typeof batchTimer.unref === "function") batchTimer.unref();
}

function flushBroadcastBatch() {
  batchTimer = null;
  const updates = Array.from(pendingBroadcast.updates.values());
  const removes = Array.from(pendingBroadcast.removes);
  const includeGroups = pendingBroadcast.groupsCatalog;
  pendingBroadcast.updates.clear();
  pendingBroadcast.removes.clear();
  pendingBroadcast.groupsCatalog = false;

  if (!updates.length && !removes.length && !includeGroups) return;

  const payload = {
    type: "batch",
    at: new Date().toISOString(),
    revision: markerRevision,
    updates,
    removes,
  };
  if (includeGroups) {
    payload.groupsCatalog = mapMeta.buildGroupsCatalogWithCounts(getMarkerList());
  }
  broadcast(payload);
}

function queueMarkerUpdate(marker) {
  if (!marker?.uid) return;
  bumpMarkerRevision();
  pendingBroadcast.removes.delete(marker.uid);
  pendingBroadcast.updates.set(marker.uid, mapRender.toSlimMarker(marker));
  scheduleBatchFlush();
}

function queueMarkerRemove(uid) {
  const id = String(uid || "").trim();
  if (!id) return;
  bumpMarkerRevision();
  pendingBroadcast.updates.delete(id);
  pendingBroadcast.removes.add(id);
  scheduleBatchFlush();
}

function queueGroupsCatalogRefresh() {
  pendingBroadcast.groupsCatalog = true;
  scheduleBatchFlush();
}

function getStreamEndpoint() {
  const raw = String(getString("TAK_URL", "")).trim();
  if (!raw) return null;
  try {
    const host = new URL(raw).hostname;
    const port = getInt("TAK_STREAM_PORT", 8089);
    return { host, port };
  } catch {
    return null;
  }
}

function isMarkerExpired(marker, now = Date.now()) {
  if (marker?.stale) {
    const t = Date.parse(marker.stale);
    if (Number.isFinite(t) && now > t + STALE_GRACE_MS) return true;
  }
  return false;
}

function isFeedOriginMarker(marker) {
  return String(marker?.origin || "").toLowerCase() === "feed";
}

function parseMarkerFromCoT(cot) {
  try {
    const uid = cot.uid();
    if (!uid) return null;
    const attrs = cot.raw?.event?._attributes || {};
    const point = cot.raw?.event?.point?._attributes;
    if (!point) return null;

    const [lon, lat] = cot.position();
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat === 0 && lon === 0) return null;

    let callsign = "";
    try {
      callsign = cot.callsign() || "";
    } catch (_) {}
    if (!callsign) {
      const contact = cot.raw?.event?.detail?.contact?._attributes;
      if (contact?.callsign) callsign = String(contact.callsign);
    }

    const detail = cot.raw?.event?.detail || {};
    const type = String(attrs.type || cot.type() || "");
    const team = mapMeta.parseTeamName(detail) || null;
    const role = mapMeta.parseTeamRole(detail);
    const { course, speed } = mapMeta.parseCourseAndSpeed(detail, point);

    const base = {
      uid: String(uid),
      callsign: callsign || String(uid).slice(0, 16),
      type,
      lat,
      lon,
      hae: point.hae != null ? Number(point.hae) : null,
      course,
      speed,
      time: attrs.time || null,
      start: attrs.start || null,
      stale: attrs.stale || null,
      how: attrs.how || null,
      team,
      role,
      teamColor: mapMeta.parseTeamColor(detail),
      affiliation: mapMeta.parseAffiliationFromType(type),
      remarks: mapMeta.parseRemarks(detail),
      updatedAt: new Date().toISOString(),
    };

    try {
      base.cotRaw = JSON.parse(JSON.stringify(cot.raw));
    } catch (_) {
      base.cotRaw = cot.raw || null;
    }

    base.relatedUids = mapMeta.parseRelatedUids(detail);
    base.cotRouteGroups = mapMeta.parseGroupsFromCoTDetail(detail);
    base.flowTagUids = mapMeta.parseFlowTagUids(detail);
    base.sourceHints = mapMeta.parseSourceHints(detail);
    base.detailKeys = Object.keys(detail || {});
    base.groups = mapMeta.resolveGroupsForMarker(base, detail);
    base.origin = mapMeta.classifyMarkerOrigin(base);

    const usericon = mapIcon.parseUserIcon(detail);
    base.iconsetpath = usericon.iconsetpath || null;
    base.iconGroup = usericon.group || null;
    base.iconName = usericon.name || null;

    const icon = mapIcon.resolveIcon({
      type: base.type,
      affiliation: base.affiliation,
      usericon,
    });
    if (icon) {
      base.iconId = icon.iconId;
      base.iconSource = icon.source;
    }

    return base;
  } catch {
    return null;
  }
}

function removeMarker(uid, notify = true) {
  if (!markers.has(uid)) return;
  markers.delete(uid);
  if (notify) queueMarkerRemove(uid);
  else bumpMarkerRevision();
}

function tryRemoveMarker(uid, notify = true) {
  const id = String(uid || "").trim();
  if (!id) return;
  const existing = markers.get(id);
  if (existing && isFeedOriginMarker(existing)) return;
  removeMarker(id, notify);
}

function handleDeleteCot(cot) {
  const uid = String(cot.uid?.() || cot.raw?.event?._attributes?.uid || "").trim();
  if (uid) {
    forgetLiveShape(uid);
    tryRemoveMarker(uid);
  }

  const links = cot.raw?.event?.detail?.link;
  const linkList = Array.isArray(links) ? links : links ? [links] : [];
  for (const link of linkList) {
    const linkUid = String(link?._attributes?.uid || link?.uid || "").trim();
    if (linkUid) {
      forgetLiveShape(linkUid);
      tryRemoveMarker(linkUid);
    }
  }
}

function enrichMarkerIconAsync(marker) {
  if (!marker || marker.iconId) return;
  void mapIcon
    .resolveIconAsync({
      type: marker.type,
      affiliation: marker.affiliation,
      usericon: {
        iconsetpath: marker.iconsetpath || "",
        group: marker.iconGroup || "",
        name: marker.iconName || "",
      },
    })
    .then((icon) => {
      if (!icon) return;
      const current = markers.get(marker.uid);
      if (!current) return;
      if (current.iconId) return;
      current.iconId = icon.iconId;
      current.iconSource = icon.source;
      current.updatedAt = new Date().toISOString();
      queueMarkerUpdate(current);
    })
    .catch(() => {});
}

function handleCot(cot) {
  const type = String(cot.type?.() || cot.raw?.event?._attributes?.type || "").trim();
  if (type === "t-x-d-d") {
    handleDeleteCot(cot);
    return;
  }
  if (type.startsWith("t-x-")) return;

  const marker = parseMarkerFromCoT(cot);
  if (!marker) return;

  if (isShapeDrawingCotType(marker.type) && hasShapeDetail(cot)) {
    void trackLiveShapeFeature(cot, marker);
    tryRemoveMarker(marker.uid);
    return;
  }

  if (markerIsShapeDecor(marker)) {
    tryRemoveMarker(marker.uid);
    return;
  }

  markers.set(marker.uid, marker);
  if (!marker.iconId) enrichMarkerIconAsync(marker);
  queueMarkerUpdate(marker);
}

function broadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const send of subscribers) {
    try {
      send(line);
    } catch (_) {}
  }
}

function sweepStaleMarkers(notify = true) {
  const now = Date.now();
  let removed = false;
  for (const [uid, marker] of markers) {
    if (isMarkerExpired(marker, now)) {
      markers.delete(uid);
      removed = true;
      if (notify) {
        queueMarkerRemove(uid);
      }
    }
  }
  if (removed && !notify) bumpMarkerRevision();
}

async function refreshAllMarkerIcons() {
  if (!mapIcon.getStatus().ready) return;
  for (const marker of markers.values()) {
    let icon = mapIcon.resolveIcon({
      type: marker.type,
      affiliation: marker.affiliation,
      usericon: {
        iconsetpath: marker.iconsetpath || "",
        group: marker.iconGroup || "",
        name: marker.iconName || "",
      },
    });
    if (!icon) {
      icon = await mapIcon.resolveIconAsync({
        type: marker.type,
        affiliation: marker.affiliation,
        usericon: {
          iconsetpath: marker.iconsetpath || "",
          group: marker.iconGroup || "",
          name: marker.iconName || "",
        },
      });
    }
    const nextId = icon?.iconId || null;
    const nextSource = icon?.source || null;
    if (marker.iconId === nextId && marker.iconSource === nextSource) continue;
    marker.iconId = nextId;
    marker.iconSource = nextSource;
    marker.updatedAt = new Date().toISOString();
    queueMarkerUpdate(marker);
  }
}

function getMarkerList() {
  return Array.from(markers.values())
    .filter((marker) => !markerIsShapeDecor(marker))
    .sort((a, b) => String(a.callsign).localeCompare(String(b.callsign)));
}

function getStateSnapshot(options = {}) {
  sweepStaleMarkers(false);
  mapMeta.ensureRefreshLoop();
  const markerList = getMarkerList();
  const snapshot = {
    ok: true,
    connected: bridgeState.connected,
    connecting: bridgeState.connecting,
    bypassed: isTakBypassed(),
    configured: isTakConfigured(),
    lastError: bridgeState.lastError,
    host: bridgeState.host,
    port: bridgeState.port,
    markerCount: markerList.length,
    revision: markerRevision,
    updatedAt: new Date().toISOString(),
  };
  if (options.includeGroupsCatalog !== false) {
    snapshot.groupsCatalog = mapMeta.buildGroupsCatalogWithCounts(markerList);
  }
  return snapshot;
}

function getMarkersSlimList() {
  return getMarkerList().map((m) => mapRender.toSlimMarker(m));
}

function getMarkersGeoJson(options) {
  return mapRender.buildGeoJson(getMarkerList(), {
    ...options,
    markerRevision,
  });
}

function clearConnection() {
  if (takConn) {
    try {
      takConn.removeAllListeners();
      takConn.destroy();
    } catch (_) {}
    takConn = null;
  }
  bridgeState.connected = false;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  bridgeState.connected = false;
  bridgeState.connecting = false;
  broadcast({
    type: "status",
    connected: false,
    lastError: bridgeState.lastError,
    at: new Date().toISOString(),
  });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectBridge();
  }, reconnectDelay);
  reconnectDelay = Math.min(Math.floor(reconnectDelay * 1.5), RECONNECT_MAX_MS);
}

async function connectBridge() {
  mapMeta.ensureRefreshLoop();

  if (isTakBypassed()) {
    bridgeState.lastError = "TAK bypass enabled (TAK_BYPASS_ENABLED)";
    return;
  }
  if (!isTakConfigured()) {
    bridgeState.lastError = "TAK_URL is not configured";
    return;
  }

  const endpoint = getStreamEndpoint();
  if (!endpoint) {
    bridgeState.lastError = "Could not parse TAK_URL hostname";
    return;
  }

  if (bridgeState.connecting) return;

  bridgeState.connecting = true;
  bridgeState.host = endpoint.host;
  bridgeState.port = endpoint.port;

  clearConnection();

  try {
    const authRaw = getTakTlsAuth({ allowInsecureServer: true });
    const auth = {
      cert:
        typeof authRaw.cert === "string" ? authRaw.cert : String(authRaw.cert),
      key: typeof authRaw.key === "string" ? authRaw.key : String(authRaw.key),
      rejectUnauthorized: authRaw.rejectUnauthorized === true,
    };
    if (authRaw.passphrase) auth.passphrase = authRaw.passphrase;
    if (authRaw.ca) {
      auth.ca =
        typeof authRaw.ca === "string" ? authRaw.ca : String(authRaw.ca);
    }

    const takMod = await import("@tak-ps/node-tak");
    const TAK = takMod.default;
    const url = new URL(`ssl://${endpoint.host}:${endpoint.port}`);
    const tak = await TAK.connect(url, auth);
    takConn = tak;
    reconnectDelay = RECONNECT_MIN_MS;

    tak.on("secureConnect", () => {
      bridgeState.connected = true;
      bridgeState.connecting = false;
      bridgeState.lastConnectAt = new Date().toISOString();
      bridgeState.lastError = null;
      setTimeout(function () {
        purgeShapeDecorMarkers(true);
      }, 3000);
      broadcast({
        type: "status",
        connected: true,
        host: endpoint.host,
        port: endpoint.port,
        at: bridgeState.lastConnectAt,
      });
    });

    tak.on("cot", (cot) => {
      try {
        handleCot(cot);
      } catch (err) {
        console.error("[map-cot] handle error:", err?.message || err);
      }
    });

    tak.on("error", (err) => {
      bridgeState.lastError = err?.message || String(err);
      clearConnection();
      scheduleReconnect();
    });

    tak.on("end", () => {
      clearConnection();
      scheduleReconnect();
    });
  } catch (err) {
    bridgeState.connecting = false;
    bridgeState.lastError = err?.message || String(err);
    scheduleReconnect();
  }
}

function ensureBridgeStarted() {
  if (started) return;
  started = true;
  mapMeta.ensureRefreshLoop();
  if (!staleTimer) {
    staleTimer = setInterval(() => sweepStaleMarkers(true), STALE_SWEEP_MS);
    if (typeof staleTimer.unref === "function") staleTimer.unref();
  }
  void connectBridge();
}

function subscribe(sendFn) {
  ensureBridgeStarted();
  subscribers.add(sendFn);
  try {
    sendFn(
      `data: ${JSON.stringify({ type: "stream_open", at: new Date().toISOString() })}\n\n`
    );
    sendFn(
      `data: ${JSON.stringify({
        type: "snapshot",
        state: getStateSnapshot({ includeGroupsCatalog: false }),
      })}\n\n`
    );
  } catch (_) {}

  return () => {
    subscribers.delete(sendFn);
  };
}

function refreshAllMarkerGroups() {
  let changed = false;
  for (const marker of markers.values()) {
    const nextGroups = mapMeta.resolveGroupsForMarker(marker, null);
    const prevGroups = Array.isArray(marker.groups) ? marker.groups : [];
    const groupsChanged =
      nextGroups.length !== prevGroups.length ||
      !nextGroups.every((g, i) => g === prevGroups[i]);
    const nextOrigin = mapMeta.classifyMarkerOrigin(marker);
    const originChanged = marker.origin !== nextOrigin;

    if (!groupsChanged && !originChanged) continue;

    if (groupsChanged) marker.groups = nextGroups;
    if (originChanged) marker.origin = nextOrigin;
    marker.updatedAt = new Date().toISOString();
    queueMarkerUpdate(marker);
    changed = true;
  }
  if (changed) queueGroupsCatalogRefresh();
}

function getMarkerByUid(uid) {
  const id = String(uid || "").trim();
  if (!id) return null;
  return markers.get(id) || null;
}

function getMarkerRawCot(uid) {
  const marker = getMarkerByUid(uid);
  if (!marker || marker.cotRaw == null) return null;
  return marker.cotRaw;
}

function findMarkersByCallsign(callsign) {
  const q = String(callsign || "").trim().toLowerCase();
  if (!q) return [];
  return getMarkerList().filter(
    (m) => String(m?.callsign || "").trim().toLowerCase() === q
  );
}

mapMeta.onSubscriptionIndexRefreshed(() => {
  refreshAllMarkerGroups();
});

module.exports = {
  getStateSnapshot,
  getMarkerList,
  getMarkerByUid,
  getMarkerRawCot,
  findMarkersByCallsign,
  getMarkersSlimList,
  getMarkersGeoJson,
  getMarkerRevision,
  subscribe,
  ensureBridgeStarted,
  refreshAllMarkerIcons,
  refreshAllMarkerGroups,
};
