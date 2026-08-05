/**
 * Generate client/map/ported/*.js from legacy public map scripts.
 * Live-marker hot path is wired to CotStoreClient (Web Worker).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const legacyDir = path.join(root, "client", "map", "legacy");
const outDir = path.join(root, "client", "map", "ported");

function legacyPath(name) {
  const preferred = path.join(legacyDir, name);
  if (fs.existsSync(preferred)) return preferred;
  // Fallback during migration if files still live under public/
  return path.join(root, "public", name);
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function stripIife(src) {
  let s = src.replace(/^\uFEFF/, "");
  s = s.replace(/^\(function\s*\(\)\s*\{\s*["']use strict["'];\s*/m, "");
  s = s.replace(/\}\)\(\);\s*$/, "");
  return s;
}

/** ES modules cannot reassign `function foo` bindings — convert patch targets to let. */
function makeAssignable(body, names) {
  let out = body;
  for (const name of names) {
    const re = new RegExp(`function\\s+${name}\\s*\\(`, "g");
    out = out.replace(re, `let ${name} = function ${name}(`);
  }
  return out;
}

const PATCH_FNS = [
  "flushMapDiff",
  "queueMapDiffFromBatch",
  "applyLiveShapesSnapshot",
  "syncFullGeoJsonToMapSource",
  "syncChannelFilterToMap",
  "loadMarkersFromServer",
  "installMapImage",
  "clearLock",
  "toggleLock",
  "selectMarker",
  "applyBatch",
  "restoreMapAfterStyleChange",
  "deselectMarker",
  "runServerGeoJsonRefresh",
  "applyLocalChannelFilter",
  "applyClientLabelDeclutterToSource",
  "applyServerGeoJsonToMap",
];

function generateMapApp() {
  const src = legacyPath("map.js");
  const raw = fs.readFileSync(src, "utf8");
  let body = stripIife(raw);
  body = makeAssignable(body, PATCH_FNS);

  body = body.replace(
    /map\.addSource\(SOURCE_ID,\s*\{\s*type:\s*"geojson",\s*promoteId:\s*"uid",\s*data:/g,
    'map.addSource(SOURCE_ID, {\n        type: "geojson",\n        data:'
  );

  const finalOut = `/* Auto-generated from ${path.relative(root, src)} — re-run: node scripts/generate-map-app.mjs */
import { CotStoreClient } from "../engine/CotStoreClient";
import {
  OVERVIEW_MODE_ZOOM as _WORKER_OVERVIEW_ZOOM,
  VIEWPORT_PAD_RATIO as _WORKER_PAD,
} from "../constants";

let __cotStore = null;
let __workerMeta = { total: 0, visible: 0, mapped: 0, revision: 0 };

function __workerUrl() {
  const scripts = document.getElementsByTagName("script");
  for (let i = scripts.length - 1; i >= 0; i--) {
    const src = scripts[i].src || "";
    if (src.indexOf("/dist/map.js") !== -1) {
      return src.replace(/\\/dist\\/map\\.js(?:\\?.*)?$/, "/dist/map.worker.js");
    }
  }
  return "/dist/map.worker.js";
}

function __padBounds(b, ratio) {
  if (!b) return null;
  const padX = (b.east - b.west) * ratio;
  const padY = (b.north - b.south) * ratio;
  return {
    west: b.west - padX,
    south: b.south - padY,
    east: b.east + padX,
    north: b.north + padY,
  };
}

${body}

function __pushViewToWorker() {
  if (!__cotStore || typeof map === "undefined" || !map) return;
  try {
    const b = map.getBounds();
    const raw = {
      west: b.getWest(),
      south: b.getSouth(),
      east: b.getEast(),
      north: b.getNorth(),
    };
    const zoom = map.getZoom();
    __cotStore.setView(__padBounds(raw, _WORKER_PAD), zoom, zoom < _WORKER_OVERVIEW_ZOOM);
  } catch (_) {}
}

function __syncGeoJsonCacheFromWorkerFeatures(features) {
  const list = Array.isArray(features) ? features : [];
  lastServerGeoJson = {
    type: "FeatureCollection",
    features: list,
    meta: __workerMeta,
  };
  if (typeof rebuildIconUidIndex === "function") rebuildIconUidIndex(list);
  if (typeof applyLoadedIconCircles === "function") applyLoadedIconCircles();
  // Preload any mimg-* referenced by worker features / slim markers.
  if (typeof preloadIconsForMarkers === "function") {
    preloadIconsForMarkers(Array.from(markersByUid.values()));
  } else if (typeof scheduleMissingIconSweep === "function") {
    scheduleMissingIconSweep();
  }
}

function __applyWorkerDiff(diff) {
  if (!map || !markerLayersReady) return;
  const src = map.getSource(SOURCE_ID);
  if (!src || !diff) return;
  const empty =
    !(diff.add && diff.add.length) &&
    !(diff.update && diff.update.length) &&
    !(diff.remove && diff.remove.length);
  if (empty) {
    // Still ensure icons for current marker set (e.g. after channel toggle).
    if (typeof preloadIconsForMarkers === "function") {
      preloadIconsForMarkers(Array.from(markersByUid.values()));
    }
    return;
  }
  if (typeof src.updateData === "function") {
    try {
      src.updateData(diff);
    } catch (err) {
      console.warn("[map] worker updateData failed, resync", err);
      if (__cotStore) __cotStore.forceResync();
      return;
    }
  }
  // Keep lastServerGeoJson / icon index warm so sweeps and hideCircles work.
  if (diff.add && diff.add.length) {
    if (!lastServerGeoJson || !Array.isArray(lastServerGeoJson.features)) {
      lastServerGeoJson = {
        type: "FeatureCollection",
        features: [],
        meta: __workerMeta,
      };
    }
    const byUid = new Map();
    for (let i = 0; i < lastServerGeoJson.features.length; i++) {
      const f = lastServerGeoJson.features[i];
      const uid = f && f.properties && f.properties.uid;
      if (uid) byUid.set(String(uid), f);
    }
    for (let i = 0; i < diff.add.length; i++) {
      const f = diff.add[i];
      const uid = f && f.properties && f.properties.uid;
      if (uid) byUid.set(String(uid), f);
    }
    if (diff.remove && diff.remove.length) {
      const removeIds = new Set(diff.remove.map(String));
      byUid.forEach(function (f, uid) {
        if (f && f.id != null && removeIds.has(String(f.id))) byUid.delete(uid);
      });
    }
    lastServerGeoJson = {
      type: "FeatureCollection",
      features: Array.from(byUid.values()),
      meta: __workerMeta,
    };
    if (typeof rebuildIconUidIndex === "function") {
      rebuildIconUidIndex(lastServerGeoJson.features);
    }
  }
  if (typeof preloadIconsForMarkers === "function") {
    preloadIconsForMarkers(Array.from(markersByUid.values()));
  } else if (typeof scheduleMissingIconSweep === "function") {
    scheduleMissingIconSweep();
  }
}

function __applyWorkerResync(features) {
  if (!map || !markerLayersReady) return;
  const src = map.getSource(SOURCE_ID);
  if (!src) return;
  src.setData({ type: "FeatureCollection", features: features || [] });
  __syncGeoJsonCacheFromWorkerFeatures(features || []);
}

function __applyWorkerShapes(features) {
  liveShapesByUid.clear();
  for (let i = 0; i < (features || []).length; i++) {
    const f = features[i];
    const uid = String((f && f.properties && f.properties.uid) || f.id || "");
    if (uid) liveShapesByUid.set(uid, f);
  }
  syncLiveShapesSource();
}

function __initCotStore() {
  if (__cotStore) return __cotStore;
  __cotStore = new CotStoreClient(__workerUrl(), {
    onDiff: function (diff, meta) {
      __workerMeta = meta || __workerMeta;
      lastGeoMeta = { total: meta.total, visible: meta.visible, mapped: meta.mapped };
      updateVisibleCounts();
      __applyWorkerDiff(diff);
    },
    onResync: function (features, meta) {
      __workerMeta = meta || __workerMeta;
      lastGeoMeta = { total: meta.total, visible: meta.visible, mapped: meta.mapped };
      updateVisibleCounts();
      __applyWorkerResync(features);
    },
    onShapes: __applyWorkerShapes,
    onSearchIndex: function () {},
  });
  return __cotStore;
}

export function bootTakMap() {
  __initCotStore();

  const __origApplyBatch = applyBatch;
  applyBatch = function (msg) {
    __origApplyBatch(msg);
    const store = __initCotStore();
    store.batch(msg.updates || [], msg.removes || [], msg.revision);
    if (msg.shapeUpdates || msg.shapeRemoves) {
      store.shapesBatch(msg.shapeUpdates || [], msg.shapeRemoves || []);
    }
    __pushViewToWorker();
    if (typeof preloadIconsForMarkers === "function") {
      preloadIconsForMarkers(msg.updates || []);
    }
  };

  const __origLoadMarkers = loadMarkersFromServer;
  loadMarkersFromServer = async function () {
    const result = await __origLoadMarkers.apply(this, arguments);
    const store = __initCotStore();
    const list = Array.from(markersByUid.values());
    store.reset(list, lastMarkerRevision || 0);
    __pushViewToWorker();
    if (typeof preloadIconsForMarkers === "function") {
      preloadIconsForMarkers(list);
    }
    return result;
  };

  function __syncSelection() {
    if (__cotStore) __cotStore.setSelection(selectedUid, lockedUid);
  }
  const __origSelect = selectMarker;
  selectMarker = function (uid, showPopupFlag) {
    __origSelect(uid, showPopupFlag);
    __syncSelection();
  };
  const __origDeselect = deselectMarker;
  deselectMarker = function () {
    __origDeselect();
    __syncSelection();
  };
  const __origToggleLock = toggleLock;
  toggleLock = function (uid) {
    __origToggleLock(uid);
    __syncSelection();
  };
  const __origClearLock = clearLock;
  clearLock = function () {
    __origClearLock();
    __syncSelection();
  };

  syncChannelFilterToMap = function () {
    const store = __initCotStore();
    const keys = enabledChannelKeysForFilter();
    let mode = "keys";
    if (keys === null) mode = "all";
    else if (keys && keys.size === 0) mode = "none";
    store.setChannels(
      mode,
      keys ? Array.from(keys) : null,
      allowedMemberChannelKeys ? Array.from(allowedMemberChannelKeys) : null
    );
    __pushViewToWorker();
    try {
      applyMapChannelLayerFilters();
      updateChannelVisibleMeta();
    } catch (_) {}
  };

  syncFullGeoJsonToMapSource = function () {
    __pushViewToWorker();
    return true;
  };

  flushMapDiff = function () {
    mapDiffTimer = null;
    mapDiffFlushPending = false;
    pendingMapAdds.clear();
    pendingMapUpdates.clear();
    pendingMapRemoves.clear();
  };

  queueMapDiffFromBatch = function () {};

  map.on("moveend", __pushViewToWorker);
  map.on("zoomend", __pushViewToWorker);

  const __origInstall = installMapImage;
  installMapImage = function (mapImageId, source) {
    return Promise.resolve(__origInstall(mapImageId, source)).then(function (ok) {
      if (ok && __cotStore) {
        const set = iconUidByMapImageId.get(String(mapImageId));
        __cotStore.iconReady(String(mapImageId), set ? Array.from(set) : []);
      }
      return ok;
    });
  };

  const __origShapesSnap = applyLiveShapesSnapshot;
  applyLiveShapesSnapshot = function (fc) {
    __origShapesSnap(fc);
    const feats =
      fc && Array.isArray(fc.features)
        ? fc.features
        : Array.from(liveShapesByUid.values());
    __initCotStore().shapesSnapshot(feats);
  };

  const __origRestore = restoreMapAfterStyleChange;
  restoreMapAfterStyleChange = async function () {
    const r = await __origRestore.apply(this, arguments);
    if (__cotStore) __cotStore.forceResync();
    return r;
  };

  // Server GeoJSON is icon enrichment only — geometry/paint comes from the worker.
  const __origApplyServerGeo = applyServerGeoJsonToMap;
  applyServerGeoJsonToMap = function (geojson) {
    if (!geojson || !Array.isArray(geojson.features)) return false;
    if (geojson.meta && geojson.meta.revision != null) {
      lastMarkerRevision = Number(geojson.meta.revision) || lastMarkerRevision;
    }
    const features = geojson.features;
    for (let i = 0; i < features.length; i++) {
      const props = features[i] && features[i].properties;
      if (props && props.iconId) {
        registerServerMapImageMeta(props.iconId, props.apiIconId, props);
      }
      const uid = props && props.uid ? String(props.uid) : "";
      const marker = uid ? markersByUid.get(uid) : null;
      if (marker && props) {
        if (props.mapImageId || props.iconId) {
          marker.mapImageId = props.iconId || props.mapImageId || marker.mapImageId;
        }
        if (props.color) marker.color = props.color;
        if (props.callsign) marker.callsign = props.callsign;
        if (props.showCircle != null) marker.showCircle = props.showCircle;
        if (props.usesMapIcon != null) marker.usesMapIcon = props.usesMapIcon;
        if (props.apiIconId) marker.iconId = props.apiIconId;
        if (props.channelKeys) marker.channelKeys = props.channelKeys;
        if (props.drawTier != null) marker.drawTier = props.drawTier;
        if (props.renderSort != null) marker.renderSort = props.renderSort;
      }
    }
    preloadMarkerIcons(geojson.meta && geojson.meta.iconManifest);
    lastServerGeoJsonFull = geojson;
    lastGeoJsonFetchOk = true;
    const store = __initCotStore();
    store.reset(Array.from(markersByUid.values()), lastMarkerRevision || 0);
    __pushViewToWorker();
    void __origApplyServerGeo;
    return true;
  };

  runServerGeoJsonRefresh = function () {
    if (!markerLayersReady) {
      mapRefreshPending = true;
      return Promise.resolve(false);
    }
    if (serverGeoFetchInFlight) return serverGeoFetchInFlight;
    serverGeoFetchInFlight = fetchServerGeoJson()
      .then(function (geojson) {
        if (!geojson) return false;
        const ok = applyServerGeoJsonToMap(geojson);
        lastGeoJsonFetchOk = ok;
        mapRefreshPending = !ok;
        return ok;
      })
      .catch(function (err) {
        console.warn("Server GeoJSON refresh failed", err);
        lastGeoJsonFetchOk = false;
        mapRefreshPending = true;
        return false;
      })
      .finally(function () {
        serverGeoFetchInFlight = null;
      });
    return serverGeoFetchInFlight;
  };

  applyLocalChannelFilter = function () {
    syncChannelFilterToMap();
    return true;
  };

  applyClientLabelDeclutterToSource = function () {
    // Labels are computed in the CotStore worker.
    return true;
  };
}

bootTakMap();
`;

  fs.writeFileSync(path.join(outDir, "mapApp.js"), finalOut, "utf8");
  console.log("[generate-map-app] wrote client/map/ported/mapApp.js");
}

function generateOverlay(name, globalName, options = {}) {
  const srcPath = legacyPath(name);
  if (!fs.existsSync(srcPath)) {
    console.warn("[generate-map-app] missing", name);
    return;
  }
  const raw = fs.readFileSync(srcPath, "utf8");
  const body = stripIife(raw);
  const base = name.replace(/\.js$/, "");
  const gate =
    options.gateDefaultsKey != null
      ? `
if (window.${globalName} && typeof window.${globalName}.init === "function") {
  const __gfInit = window.${globalName}.init;
  window.${globalName}.init = function (bridge) {
    const defaults = window.TAK_PORTAL_MAP_DEFAULTS || {};
    if (!defaults.${options.gateDefaultsKey}) return;
    return __gfInit(bridge);
  };
}
`
      : "";
  const out = `/* Auto-generated from ${path.relative(root, srcPath)} — re-run: node scripts/generate-map-app.mjs */
${body}
${gate}
export default typeof window !== "undefined" ? window.${globalName} : null;
`;
  fs.writeFileSync(path.join(outDir, base + ".js"), out, "utf8");
  console.log("[generate-map-app] wrote client/map/ported/" + base + ".js");
}

ensureDir(outDir);
generateMapApp();
generateOverlay("map-missions.js", "TakMapMissions");
generateOverlay("map-packages.js", "TakMapPackages");
generateOverlay("map-geofences.js", "TakMapGeofences", {
  gateDefaultsKey: "enableGeofences",
});
console.log("[generate-map-app] done");
