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
/**
 * Bounded raw CoT cache (not on the hot marker object).
 * Lazy/on-demand for GET /cot-raw — avoids deep-cloning full XML trees per update.
 */
const COT_RAW_CACHE_MAX = Math.max(50, getInt("MAP_COT_RAW_CACHE_MAX", 500));
/** @type {Map<string, object>} */
const cotRawByUid = new Map();
/** @type {Set<(line: string) => void>} */
const subscribers = new Set();

function rememberCotRaw(uid, raw) {
  const id = String(uid || "").trim();
  if (!id || raw == null) return;
  if (cotRawByUid.has(id)) cotRawByUid.delete(id);
  cotRawByUid.set(id, raw);
  while (cotRawByUid.size > COT_RAW_CACHE_MAX) {
    const oldest = cotRawByUid.keys().next().value;
    if (oldest == null) break;
    cotRawByUid.delete(oldest);
  }
}

function forgetCotRaw(uid) {
  const id = String(uid || "").trim();
  if (id) cotRawByUid.delete(id);
}

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
/** @type {Map<string, object>} uid -> GeoJSON Feature for SPI FOV / sensor footprints */
const liveOverlayFeatures = new Map();
/** @type {Promise<typeof import("@tak-ps/node-cot")>|null} */
let nodeCotPromise = null;
let takLogNoiseFilterInstalled = false;
let cotParseHardened = false;

function loadNodeCot() {
  if (!nodeCotPromise) nodeCotPromise = import("@tak-ps/node-cot");
  return nodeCotPromise;
}

/**
 * @tak-ps/node-tak console.error("Error parsing", err, data.toString()) dumps the
 * whole TCP chunk when a single CoT fails validation (e.g. hae=""). That looks
 * like every CoT is being logged. Suppress that library noise.
 */
function installTakLogNoiseFilter() {
  if (takLogNoiseFilterInstalled) return;
  takLogNoiseFilterInstalled = true;

  // node-cot prints every CoT JSON when this env var is truthy.
  if (process.env.DEBUG_COTS) delete process.env.DEBUG_COTS;

  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  function isTakParseNoise(args) {
    const first = args[0];
    if (typeof first !== "string") return false;
    if (first.startsWith("Error parsing")) return true;
    if (first.startsWith("Warning: must be number")) return true;
    if (/^ok - .+ @ (connect|secure):/.test(first)) return true;
    return false;
  }

  console.error = (...args) => {
    if (isTakParseNoise(args)) return;
    origError(...args);
  };
  console.warn = (...args) => {
    if (isTakParseNoise(args)) return;
    origWarn(...args);
  };
}

/** Coerce empty point numeric attrs so node-cot validation does not reject them. */
function sanitizeCotXmlPointAttrs(raw) {
  return String(raw ?? "")
    .replace(/\b(hae|ce|le)="\s*"/gi, '$1="9999999.0"')
    .replace(/\b(hae|ce|le)='\s*'/gi, "$1='9999999.0'");
}

/**
 * Patch shared CoTParser.from_xml (peer dep of node-tak) before connecting.
 * Prevents empty hae/ce/le from failing parse and triggering chunk dumps.
 */
async function hardenCotXmlParse() {
  if (cotParseHardened) return;
  const mod = await loadNodeCot();
  const CoTParser = mod?.CoTParser;
  if (!CoTParser || typeof CoTParser.from_xml !== "function") return;
  if (CoTParser.from_xml.__takPortalHardened) {
    cotParseHardened = true;
    return;
  }

  const orig = CoTParser.from_xml.bind(CoTParser);
  function fromXmlHardened(raw, opts) {
    return orig(sanitizeCotXmlPointAttrs(raw), opts);
  }
  fromXmlHardened.__takPortalHardened = true;
  CoTParser.from_xml = fromXmlHardened;
  cotParseHardened = true;
}

function hasShapeDetail(cot) {
  const detail = cot?.raw?.event?.detail;
  return !!(detail && detail.shape);
}

function isShapeDrawingCotType(type) {
  const t = String(type || "").toLowerCase();
  return t.startsWith("u-d-") || t.startsWith("u-r-") || t.startsWith("b-m-r");
}

function isSpiCotType(type) {
  const t = String(type || "").trim().toLowerCase();
  return t.startsWith("b-m-p-s-p-i") || t.startsWith("b-m-p-s-p-loc");
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

let missionDecorIndex = null;
let missionDecorIndexAt = 0;
const MISSION_DECOR_INDEX_MS = 5000;

function getMissionShapeDecorIndex() {
  const now = Date.now();
  if (missionDecorIndex && now - missionDecorIndexAt < MISSION_DECOR_INDEX_MS) {
    return missionDecorIndex;
  }
  const missionGeo = require("./missionGeo.service");
  missionDecorIndex = shapeDecor.buildShapeDecorIndex(missionGeo.getCachedMissionShapeFeatures());
  missionDecorIndexAt = now;
  return missionDecorIndex;
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

  const missionIndex = getMissionShapeDecorIndex();
  if (
    missionIndex.hasShapes ||
    missionIndex.ringProfiles.length ||
    missionIndex.segments.length
  ) {
    if (shapeDecor.shouldDropShapeDecorPoint(markerToDecorFeature(marker), missionIndex)) {
      return true;
    }
  }

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
    forgetCotRaw(uid);
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

function parseSpiOverlayFeature(cot, marker) {
  if (!cot || !marker || !isSpiCotType(marker.type)) return null;
  const cached = cotRawByUid.get(String(marker.uid || ""));
  const detail = cot?.raw?.event?.detail || cached?.event?.detail;
  const poly = detail?.shape?.polyline;
  if (!poly) return null;

  const attrs = poly._attributes || poly || {};
  const verts = poly.vertex;
  const list = Array.isArray(verts) ? verts : verts ? [verts] : [];
  const coords = [];
  for (const v of list) {
    const a = v?._attributes || v || {};
    const lat = Number(a.lat);
    const lon = Number(a.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    coords.push([lon, lat]);
  }
  if (coords.length < 2) return null;

  const closedAttr = attrs.closed;
  const closed =
    closedAttr === true ||
    String(closedAttr || "").toLowerCase() === "true" ||
    coords.length >= 3;

  let geometry;
  if (closed) {
    const ring = coords.slice();
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) {
      ring.push([first[0], first[1]]);
    }
    if (ring.length < 4) return null;
    geometry = { type: "Polygon", coordinates: [ring] };
  } else {
    geometry = { type: "LineString", coordinates: coords };
  }

  // SPI view box: white outline + light white fill (ignore CoT colors).
  const stroke = "#ffffff";
  const fill = "#ffffff";

  return {
    type: "Feature",
    id: String(marker.uid),
    geometry,
    properties: {
      uid: String(marker.uid),
      callsign: marker.callsign || "",
      cotType: marker.type || "",
      kind: "spi-fov",
      channelKeys: mapRender.markerChannelKeys(marker).join(","),
      stroke,
      fill,
      "fill-opacity": 0.1,
      "stroke-opacity": 0.9,
      "stroke-width": 2,
    },
  };
}

function trackSpiOverlayFeature(cot, marker) {
  if (!marker?.uid || !isSpiCotType(marker.type)) return;
  const feat = parseSpiOverlayFeature(cot, marker);
  if (!feat) {
    if (liveOverlayFeatures.has(marker.uid)) {
      liveOverlayFeatures.delete(marker.uid);
      queueShapeRemove(marker.uid);
    }
    return;
  }
  liveOverlayFeatures.set(marker.uid, feat);
  queueShapeUpdate(feat);
}

function forgetLiveShape(uid) {
  const id = String(uid || "").trim();
  if (!id) return;
  liveShapeFeatures.delete(id);
  if (liveOverlayFeatures.has(id)) {
    liveOverlayFeatures.delete(id);
    queueShapeRemove(id);
  }
}

function getLiveOverlayGeoJson() {
  return {
    type: "FeatureCollection",
    features: Array.from(liveOverlayFeatures.values()),
  };
}

const pendingBroadcast = {
  updates: new Map(),
  removes: new Set(),
  shapeUpdates: new Map(),
  shapeRemoves: new Set(),
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
  const shapeUpdates = Array.from(pendingBroadcast.shapeUpdates.values());
  const shapeRemoves = Array.from(pendingBroadcast.shapeRemoves);
  const includeGroups = pendingBroadcast.groupsCatalog;
  pendingBroadcast.updates.clear();
  pendingBroadcast.removes.clear();
  pendingBroadcast.shapeUpdates.clear();
  pendingBroadcast.shapeRemoves.clear();
  pendingBroadcast.groupsCatalog = false;

  if (
    !updates.length &&
    !removes.length &&
    !shapeUpdates.length &&
    !shapeRemoves.length &&
    !includeGroups
  ) {
    return;
  }

  const payload = {
    type: "batch",
    at: new Date().toISOString(),
    revision: markerRevision,
    updates,
    removes,
  };
  if (shapeUpdates.length) payload.shapeUpdates = shapeUpdates;
  if (shapeRemoves.length) payload.shapeRemoves = shapeRemoves;
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
  if (liveOverlayFeatures.has(id)) {
    liveOverlayFeatures.delete(id);
    pendingBroadcast.shapeUpdates.delete(id);
    pendingBroadcast.shapeRemoves.add(id);
  }
  scheduleBatchFlush();
}

function queueShapeUpdate(feature) {
  const uid = String(feature?.properties?.uid || feature?.id || "").trim();
  if (!uid || !feature) return;
  bumpMarkerRevision();
  pendingBroadcast.shapeRemoves.delete(uid);
  pendingBroadcast.shapeUpdates.set(uid, feature);
  scheduleBatchFlush();
}

function queueShapeRemove(uid) {
  const id = String(uid || "").trim();
  if (!id) return;
  bumpMarkerRevision();
  pendingBroadcast.shapeUpdates.delete(id);
  pendingBroadcast.shapeRemoves.add(id);
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
    const platform = mapMeta.parseTakPlatform(detail);
    const battery = mapMeta.parseBatteryPercent(detail);
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
      platform,
      battery,
      teamColor: mapMeta.parseTeamColor(detail),
      affiliation: mapMeta.parseAffiliationFromType(type),
      remarks: mapMeta.parseRemarks(detail),
      links: mapMeta.parseDetailLinks(detail),
      updatedAt: new Date().toISOString(),
    };

    // Keep raw off the slim marker; cache separately for /cot-raw (no deep clone).
    if (cot.raw) rememberCotRaw(base.uid, cot.raw);

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
  forgetCotRaw(uid);
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
  if (isSpiCotType(marker.type) && hasShapeDetail(cot)) {
    trackSpiOverlayFeature(cot, marker);
  }
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
      forgetCotRaw(uid);
      removed = true;
      if (notify) {
        queueMarkerRemove(uid);
      } else if (liveOverlayFeatures.has(uid)) {
        liveOverlayFeatures.delete(uid);
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
  if (options.includeLiveShapes !== false) {
    snapshot.liveShapes = getLiveOverlayGeoJson();
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
    installTakLogNoiseFilter();
    await hardenCotXmlParse();

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
    sendFn(
      `data: ${JSON.stringify({
        type: "shapes",
        shapes: getLiveOverlayGeoJson(),
        at: new Date().toISOString(),
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
    if (isSpiCotType(marker.type) && liveOverlayFeatures.has(marker.uid)) {
      const overlay = liveOverlayFeatures.get(marker.uid);
      if (overlay?.properties) {
        overlay.properties.channelKeys = mapRender.markerChannelKeys(marker).join(",");
        queueShapeUpdate(overlay);
      }
    }
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
  const id = String(uid || "").trim();
  if (!id) return null;
  // Prefer bounded cache; fall back to legacy field if present on older markers.
  if (cotRawByUid.has(id)) return cotRawByUid.get(id);
  const marker = getMarkerByUid(id);
  if (!marker || marker.cotRaw == null) return null;
  return marker.cotRaw;
}

function getBridgeMemoryStats() {
  return {
    markerCount: markers.size,
    cotRawCacheCount: cotRawByUid.size,
    cotRawCacheMax: COT_RAW_CACHE_MAX,
    liveShapeCount: liveShapeFeatures.size,
    liveOverlayCount: liveOverlayFeatures.size,
    subscriberCount: subscribers.size,
    markerRevision,
    rss: typeof process.memoryUsage === "function" ? process.memoryUsage().rss : null,
  };
}

function findMarkersByCallsign(callsign) {
  const q = String(callsign || "").trim().toLowerCase();
  if (!q) return [];
  return getMarkerList().filter(
    (m) => String(m?.callsign || "").trim().toLowerCase() === q
  );
}

/**
 * Resolve live map markers for a connected dashboard client.
 * Subscription callsign often differs from the CoT callsign / device uid,
 * so match by uid, callsign, and username.
 */
function findMarkersForConnectedClient(options = {}) {
  const callsign = String(options.callsign || "")
    .trim()
    .toLowerCase();
  const username = String(options.username || "")
    .trim()
    .toLowerCase();
  const clientUid = String(options.clientUid || options.uid || "")
    .trim()
    .toLowerCase();

  const nameKeys = new Set();
  if (callsign) nameKeys.add(callsign);
  if (username) nameKeys.add(username);

  const list = getMarkerList();
  const matches = [];
  for (const m of list) {
    const cs = String(m?.callsign || "")
      .trim()
      .toLowerCase();
    const mid = String(m?.uid || "")
      .trim()
      .toLowerCase();
    if (clientUid && mid && mid === clientUid) {
      matches.push(m);
      continue;
    }
    if (cs && nameKeys.has(cs)) {
      matches.push(m);
    }
  }
  return matches;
}

function formatBatteryPercentLabel(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (Number.isFinite(n)) return `${Math.round(Math.max(0, Math.min(100, n)))}%`;
  const s = String(value).trim();
  if (!s) return null;
  return /%$/.test(s) ? s : `${s}%`;
}

function buildLiveMarkerBatteryIndex(markerList) {
  const byCallsign = new Map();
  const byUid = new Map();
  for (const marker of Array.isArray(markerList) ? markerList : []) {
    const label = formatBatteryPercentLabel(marker?.battery);
    if (!label) continue;
    const callsign = String(marker?.callsign || "").trim().toLowerCase();
    if (callsign && !byCallsign.has(callsign)) byCallsign.set(callsign, label);
    const uid = String(marker?.uid || "").trim().toLowerCase();
    if (uid) byUid.set(uid, label);
  }
  return { byCallsign, byUid };
}

function resolveSubscriptionBattery(sub, index) {
  const uidFields = [
    sub?.uid,
    sub?.clientUid,
    sub?.clientUuid,
    sub?.connectionUid,
    sub?.deviceUid,
  ];
  for (const raw of uidFields) {
    const key = String(raw || "").trim().toLowerCase();
    if (key && index.byUid.has(key)) return index.byUid.get(key);
  }
  const callsign = String(sub?.callsign || "").trim().toLowerCase();
  if (callsign && index.byCallsign.has(callsign)) return index.byCallsign.get(callsign);
  const username = String(sub?.username || "").trim().toLowerCase();
  if (username && index.byCallsign.has(username)) return index.byCallsign.get(username);
  return null;
}

/** Join live CoT marker battery onto Marti subscription rows for dashboard. */
function enrichSubscriptionsWithLiveMarkerBattery(list) {
  const index = buildLiveMarkerBatteryIndex(getMarkerList());
  return (Array.isArray(list) ? list : []).map((sub) => ({
    ...sub,
    battery: resolveSubscriptionBattery(sub, index),
  }));
}

mapMeta.onSubscriptionIndexRefreshed(() => {
  refreshAllMarkerGroups();
});

module.exports = {
  getStateSnapshot,
  getMarkerList,
  getMarkerByUid,
  getMarkerRawCot,
  getBridgeMemoryStats,
  findMarkersByCallsign,
  findMarkersForConnectedClient,
  getMarkersSlimList,
  getMarkersGeoJson,
  getLiveOverlayGeoJson,
  parseSpiOverlayFeature,
  getMarkerRevision,
  subscribe,
  ensureBridgeStarted,
  refreshAllMarkerIcons,
  refreshAllMarkerGroups,
  enrichSubscriptionsWithLiveMarkerBattery,
};
