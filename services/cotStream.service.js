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

const STALE_SWEEP_MS = 5000;
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30000;

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

function isMarkerStale(marker, now = Date.now()) {
  if (marker?.stale) {
    const t = Date.parse(marker.stale);
    if (Number.isFinite(t) && t <= now) return true;
  }
  return false;
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
    const team =
      detail?.__group?._attributes?.name ||
      detail?.team?._attributes?.name ||
      null;

    const base = {
      uid: String(uid),
      callsign: callsign || String(uid).slice(0, 16),
      type,
      lat,
      lon,
      hae: point.hae != null ? Number(point.hae) : null,
      course: point.course != null ? Number(point.course) : null,
      speed: point.speed != null ? Number(point.speed) : null,
      time: attrs.time || null,
      start: attrs.start || null,
      stale: attrs.stale || null,
      how: attrs.how || null,
      team,
      teamColor: mapMeta.parseTeamColor(detail),
      affiliation: mapMeta.parseAffiliationFromType(type),
      updatedAt: new Date().toISOString(),
    };

    base.groups = mapMeta.resolveGroupsForMarker(base, detail);
    return base;
  } catch {
    return null;
  }
}

function removeMarker(uid, notify = true) {
  if (!markers.has(uid)) return;
  markers.delete(uid);
  if (notify) {
    broadcast({ type: "remove", uid, at: new Date().toISOString() });
  }
}

function handleDeleteCot(cot) {
  const uid = String(cot.uid?.() || cot.raw?.event?._attributes?.uid || "").trim();
  if (uid) removeMarker(uid);

  const links = cot.raw?.event?.detail?.link;
  const linkList = Array.isArray(links) ? links : links ? [links] : [];
  for (const link of linkList) {
    const linkUid = String(link?._attributes?.uid || link?.uid || "").trim();
    if (linkUid) removeMarker(linkUid);
  }
}

function handleCot(cot) {
  const type = String(cot.type?.() || cot.raw?.event?._attributes?.type || "").trim();
  if (type === "t-x-d-d") {
    handleDeleteCot(cot);
    return;
  }
  if (type.startsWith("t-x-")) return;

  try {
    if (typeof cot?.is_stale === "function" && cot.is_stale()) return;
  } catch (_) {}

  const marker = parseMarkerFromCoT(cot);
  if (!marker || isMarkerStale(marker)) return;
  markers.set(marker.uid, marker);
  broadcast({
    type: "update",
    marker,
    at: new Date().toISOString(),
  });
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
  for (const [uid, marker] of markers) {
    if (isMarkerStale(marker, now)) {
      markers.delete(uid);
      if (notify) {
        broadcast({ type: "remove", uid, at: new Date().toISOString() });
      }
    }
  }
}

function getMarkerList() {
  return Array.from(markers.values()).sort((a, b) =>
    String(a.callsign).localeCompare(String(b.callsign))
  );
}

function getStateSnapshot() {
  sweepStaleMarkers(false);
  mapMeta.ensureRefreshLoop();
  const markerList = getMarkerList();
  return {
    ok: true,
    connected: bridgeState.connected,
    connecting: bridgeState.connecting,
    bypassed: isTakBypassed(),
    configured: isTakConfigured(),
    lastError: bridgeState.lastError,
    host: bridgeState.host,
    port: bridgeState.port,
    markerCount: markerList.length,
    markers: markerList,
    groupsCatalog: mapMeta.buildGroupsCatalogWithCounts(markerList),
    updatedAt: new Date().toISOString(),
  };
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
      `data: ${JSON.stringify({ type: "snapshot", state: getStateSnapshot() })}\n\n`
    );
  } catch (_) {}

  return () => {
    subscribers.delete(sendFn);
  };
}

module.exports = {
  getStateSnapshot,
  getMarkerList,
  subscribe,
  ensureBridgeStarted,
};
