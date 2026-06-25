/**
 * Mission CoT → GeoJSON for map overlays (read-only).
 */
const shapeDecor = require("../public/shapeDecorFilter.js");
const { getInt } = require("./env");
const dataSyncSvc = require("./dataSync.service");
const mapIcon = require("./mapIcon.service");
const mapMeta = require("./mapMeta.service");
const mapRender = require("./mapRender.service");
const mapIconRender = require("./mapIconRender.service");
const missionKml = require("./missionKml.service");
const missionRaster = require("./missionRaster.service");
const { unwrapMissionPayload } = require("./missionContents.util");

const CACHE_TTL_MS = getInt("MISSION_GEO_CACHE_TTL_MS", 45000);
const geoCache = new Map();
const layerCache = new Map();
const rawFcCache = new Map();
/** @type {Map<string, Promise<object>>} */
const rawFcInFlight = new Map();
/** @type {Map<string, Promise<object>>} */
const geoInFlight = new Map();

/** @type {Promise<typeof import('./missionCotConvert.mjs')>|null} */
let cotConvertPromise = null;

function loadCotConvert() {
  if (!cotConvertPromise) cotConvertPromise = import("./missionCotConvert.mjs");
  return cotConvertPromise;
}

function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    map.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(map, key, value) {
  map.set(key, { at: Date.now(), value });
}

function geometryType(geom) {
  const t = String(geom?.type || "").toLowerCase();
  if (t === "point") return "point";
  if (t === "linestring" || t === "multilinestring") return "line";
  if (t === "polygon" || t === "multipolygon") return "polygon";
  return "other";
}

function colorFromProps(props) {
  return (
    props.stroke ||
    props["marker-color"] ||
    props.fill ||
    props.color ||
    "#22d3ee"
  );
}

function affiliationFromType(cotType) {
  return mapMeta.parseAffiliationFromType(cotType);
}

function parseUserIconFromFeature(props) {
  if (!props || typeof props !== "object") return null;
  const iconPath = props.icon || props.iconsetpath || "";
  if (!iconPath) return null;
  return mapIcon.parseUserIcon({
    usericon: {
      iconsetpath: String(iconPath),
      name: props.iconName || String(iconPath).split("/").pop() || "",
      group: props.iconGroup || "",
    },
  });
}

function explicitMarkerColorFromProps(props) {
  const fromMarkerColor = mapMeta.normalizeTakColor(props?.["marker-color"]);
  if (fromMarkerColor) return fromMarkerColor;
  return mapMeta.normalizeTakColor(props?.color);
}

function markerColorFromFeatureProps(props, affiliation) {
  const explicit = explicitMarkerColorFromProps(props);
  if (explicit) return explicit;
  return mapMeta.resolveMarkerDisplayColor({
    teamColor: null,
    affiliation,
    type: props?.type || props?.cotType || "",
  });
}

async function augmentPointFeature(feature, missionName) {
  const props = feature.properties || {};
  const cotType = String(props.type || "");
  const uid = String(feature.id || props.uid || "");
  const usericon = parseUserIconFromFeature(props);
  const affiliation = affiliationFromType(cotType);
  const explicitTeamColor = explicitMarkerColorFromProps(props);

  let resolved = mapIcon.resolveIcon({
    type: cotType,
    affiliation,
    usericon,
  });
  if (!resolved) {
    resolved = await mapIcon.resolveIconAsync({
      type: cotType,
      affiliation,
      usericon,
    });
  }

  const marker = {
    uid,
    type: cotType,
    affiliation,
    origin: "mission",
    iconId: resolved?.iconId || null,
    iconSource: resolved?.source || null,
    teamColor: explicitTeamColor,
    callsign: props.callsign || uid.slice(0, 16),
  };

  const usesIcon = mapRender.markerUsesMapIcon(marker);
  const color = mapRender.markerDisplayColor(marker);
  const apiIconId = usesIcon ? String(marker.iconId || "") : "";
  const mapImageId = apiIconId
    ? mapIconRender.computeMapImageId(marker, apiIconId, color)
    : "";

  return {
    ...feature,
    id: uid || feature.id,
    properties: {
      ...props,
      kind: "mission-feature",
      missionName,
      id: uid || feature.id,
      uid,
      cotType,
      callsign: props.callsign || uid.slice(0, 16),
      showLabel: 0,
      labelSort: 4,
      geometryType: "point",
      stroke: props.stroke || color,
      fill: props.fill || props["marker-color"] || color,
      "stroke-width": props["stroke-width"] || 2,
      usesMapIcon: usesIcon ? 1 : 0,
      apiIconId: apiIconId || "",
      iconId: mapImageId || "",
      iconSource: marker.iconSource || "",
      origin: "mission",
      color,
      teamColor: explicitTeamColor,
      showCircle: mapImageId ? 0 : 1,
      how: props.how || "",
      contentSource: "cot",
    },
  };
}

function normalizeFeature(feature, missionName) {
  const props = feature.properties || {};
  const uid = String(feature.id || props.uid || "");
  const geomType = geometryType(feature.geometry);
  const color = colorFromProps(props);
  return {
    ...feature,
    id: uid || feature.id,
    properties: {
      ...props,
      kind: "mission-feature",
      missionName,
      id: uid || feature.id,
      uid,
      cotType: props.type || "",
      callsign: props.callsign || uid.slice(0, 16),
      showLabel: 0,
      labelSort: 4,
      remarks: props.remarks || "",
      geometryType: geomType,
      stroke: props.stroke || color,
      fill: props.fill || props["marker-color"] || color,
      "stroke-width": Number(props["stroke-width"]) || 2,
      "stroke-opacity": props["stroke-opacity"] != null ? props["stroke-opacity"] : 1,
      "fill-opacity": props["fill-opacity"] != null ? props["fill-opacity"] : 0.35,
      contentSource: props.contentSource || "cot",
      origin: "mission",
    },
  };
}

function isShapeVertexPoint(feature, vertexKeys) {
  return shapeDecor.shouldDropShapeDecorPoint(feature, {
    vertexKeys: vertexKeys || new Set(),
    segments: [],
    ringProfiles: [],
    hasShapes: false,
  });
}

function collectShapeVertexKeys(features) {
  return shapeDecor.buildShapeDecorIndex(features).vertexKeys;
}

function filterShapeVertexPoints(features) {
  return shapeDecor.filterShapeVertexPoints(features);
}

async function normalizeFeatureCollection(fc, missionName) {
  const rawFeatures = (fc.features || []).filter((feature) => feature?.geometry);
  const decorIndex = shapeDecor.buildShapeDecorIndex(rawFeatures);
  await mapIcon.ensureIconsets();
  const jobs = rawFeatures.map(async function (feature) {
    const geomType = geometryType(feature.geometry);
    if (geomType === "point") {
      if (shapeDecor.shouldDropShapeDecorPoint(feature, decorIndex)) return null;
      return augmentPointFeature(feature, missionName);
    }
    return normalizeFeature(feature, missionName);
  });
  const results = await Promise.all(jobs);
  const out = results.filter(Boolean);
  return {
    type: "FeatureCollection",
    features: out,
  };
}

function collectLayerUids(node, pathParts, folders, uidSet) {
  if (!node || typeof node !== "object") return;
  const type = String(node.type || node.Type || "").toUpperCase();
  const name = String(node.name || node.Name || "Layer").trim();
  const path = pathParts.join("/");

  if (type === "GROUP" || type === "FOLDER") {
    const folderPath = path ? `${path}/${name}` : name;
    const uids = [];
    const children = node.children || node.Children || node.child || [];
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (!child) continue;
      if (String(child.type || child.Type || "").toUpperCase() === "UID") {
        const raw = child.uids || child.Uids || child.uid || child.UID || [];
        const arr = Array.isArray(raw) ? raw : [raw];
        for (const u of arr) {
          const id = String(u || "").trim();
          if (id) {
            uids.push(id);
            uidSet.add(id);
          }
        }
      } else {
        collectLayerUids(child, folderPath.split("/").filter(Boolean), folders, uidSet);
      }
    }
    if (uids.length) {
      folders.push({ path: folderPath, name, uids: [...new Set(uids)] });
    }
    return;
  }

  if (type === "UID") {
    const raw = node.uids || node.Uids || node.uid || node.UID || [];
    const arr = Array.isArray(raw) ? raw : [raw];
    const uids = arr.map((u) => String(u || "").trim()).filter(Boolean);
    if (uids.length) {
      folders.push({ path: path || name, name: name || path || "Items", uids });
      uids.forEach((u) => uidSet.add(u));
    }
    return;
  }

  const children = node.children || node.Children || node.child || node.layers || [];
  const list = Array.isArray(children) ? children : children ? [children] : [];
  for (const child of list) {
    collectLayerUids(child, pathParts, folders, uidSet);
  }
}

function normalizeLayerTree(raw, featureUids) {
  const folders = [];
  const layerUids = new Set();
  const roots = Array.isArray(raw) ? raw : raw?.layers || raw?.data || raw ? [raw] : [];
  for (const root of roots) {
    collectLayerUids(root, [], folders, layerUids);
  }
  const all = new Set(featureUids || []);
  const orphaned = [...all].filter((uid) => !layerUids.has(uid));
  return { folders, orphaned };
}

function filterNormalizedDecorPoints(fc) {
  const features = fc?.features || [];
  const decorIndex = shapeDecor.buildShapeDecorIndex(features);
  const out = features.filter(function (feature) {
    if (geometryType(feature?.geometry) !== "point") return true;
    return !shapeDecor.shouldDropShapeDecorPoint(feature, decorIndex);
  });
  return Object.assign({}, fc, { features: out });
}

async function fetchRawMissionCotFeatureCollection(missionName, queryParams = {}) {
  const key = `${String(missionName || "").trim()}:${JSON.stringify(queryParams || {})}`;
  const cached = cacheGet(rawFcCache, key);
  if (cached) return cached;

  const pending = rawFcInFlight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    const res = await dataSyncSvc.getMissionCotXml(missionName, queryParams);
    if (res.status >= 400) {
      const err = new Error(`Mission CoT fetch failed (${res.status})`);
      err.status = res.status;
      err.code = "MISSION_COT_FETCH_FAILED";
      throw err;
    }
    const mod = await loadCotConvert();
    const fc = await mod.missionCotXmlToFeatureCollection(res.data, missionName);
    cacheSet(rawFcCache, key, fc);
    return fc;
  })().finally(() => {
    rawFcInFlight.delete(key);
  });

  rawFcInFlight.set(key, promise);
  return promise;
}

async function auditMissionShapeDecor(missionName, options = {}) {
  const name = String(missionName || "").trim();
  const rawFc = await fetchRawMissionCotFeatureCollection(name, options.queryParams || {});
  const normalized = await normalizeFeatureCollection(rawFc, name);
  return {
    missionName: name,
    cot: shapeDecor.auditShapeDecor(rawFc.features || []),
    normalized: shapeDecor.auditShapeDecor(normalized.features || []),
  };
}

async function fetchMissionCotGeoJson(missionName, queryParams = {}) {
  const rawFc = await fetchRawMissionCotFeatureCollection(missionName, queryParams);
  return normalizeFeatureCollection(rawFc, missionName);
}

async function buildMissionGeoJson(name, options = {}) {
  let fc = await fetchMissionCotGeoJson(name, options.queryParams || {});

  let rasterOverlays = [];
  let attachmentSummary = { kml: 0, raster: 0 };

  if (options.includeAttachments) {
    try {
      const missionRaw = options.missionMeta || (await dataSyncSvc.getMission(name));
      const mission = unwrapMissionPayload(missionRaw);
      const kmlFeatures = await missionKml.loadKmlFeaturesFromMission(name, mission);
      attachmentSummary.kml = kmlFeatures.length;
      if (kmlFeatures.length) {
        fc = filterNormalizedDecorPoints({
          type: "FeatureCollection",
          features: [...fc.features, ...kmlFeatures],
        });
      }
      rasterOverlays = await missionRaster.buildRasterOverlays(name, mission, {
        features: fc.features,
      });
      attachmentSummary.raster = rasterOverlays.length;
    } catch (err) {
      console.warn("[mission-geo] attachment load failed:", err?.message || err);
    }
  }

  const iconManifest = [];
  const manifestKeys = new Set();
  for (const f of fc.features) {
    const p = f.properties || {};
    if (p.geometryType === "point" && p.iconId && p.apiIconId) {
      if (!manifestKeys.has(p.iconId)) {
        manifestKeys.add(p.iconId);
        const marker = {
          type: p.cotType || "",
          affiliation: affiliationFromType(p.cotType || ""),
          origin: "mission",
          iconId: p.apiIconId,
          iconSource: p.iconSource || "",
          teamColor: p.teamColor || null,
        };
        iconManifest.push({
          mapImageId: p.iconId,
          apiIconId: p.apiIconId,
          color: mapRender.markerDisplayColor(marker),
          teamColor: marker.teamColor != null ? marker.teamColor : null,
          iconSource: p.iconSource,
          origin: "mission",
          type: p.cotType,
          affiliation: marker.affiliation,
        });
      }
    }
  }

  return {
    type: "FeatureCollection",
    features: fc.features,
    meta: {
      missionName: name,
      fetchedAt: new Date().toISOString(),
      revision: Date.now(),
      featureCount: fc.features.length,
      iconManifest,
      rasterOverlays,
      attachmentSummary,
    },
  };
}

async function getMissionGeoJson(missionName, options = {}) {
  const name = String(missionName || "").trim();
  const cacheKey = `${name}:v4:att=${options.includeAttachments ? 1 : 0}:${JSON.stringify(options.queryParams || {})}`;
  if (!options.refresh) {
    const cached = cacheGet(geoCache, cacheKey);
    if (cached) return cached;
    const pending = geoInFlight.get(cacheKey);
    if (pending) return pending;
  }

  const promise = buildMissionGeoJson(name, options)
    .then((result) => {
      cacheSet(geoCache, cacheKey, result);
      return result;
    })
    .finally(() => {
      geoInFlight.delete(cacheKey);
    });

  if (!options.refresh) {
    geoInFlight.set(cacheKey, promise);
  }
  return promise;
}

async function getMissionLayerTree(missionName, options = {}) {
  const name = String(missionName || "").trim();
  const cacheKey = name;
  if (!options.refresh) {
    const cached = cacheGet(layerCache, cacheKey);
    if (cached) return cached;
  }

  const res = await dataSyncSvc.getMissionLayers(name, options.queryParams || {});
  if (res.status === 404) {
    const empty = {
      missionName: name,
      fetchedAt: new Date().toISOString(),
      folders: [],
      orphaned: [],
    };
    cacheSet(layerCache, cacheKey, empty);
    return empty;
  }
  if (res.status >= 400) {
    const err = new Error(`Mission layer fetch failed (${res.status})`);
    err.status = res.status;
    err.code = "MISSION_LAYER_FETCH_FAILED";
    throw err;
  }

  let featureUids = options.featureUids;
  if (!featureUids) {
    const rawFc = await fetchRawMissionCotFeatureCollection(name, options.queryParams || {});
    featureUids = (rawFc.features || []).map((f) => String(f.id || f.properties?.uid || ""));
  }

  const normalized = normalizeLayerTree(res.data, featureUids);
  const result = {
    missionName: name,
    fetchedAt: new Date().toISOString(),
    ...normalized,
  };
  cacheSet(layerCache, cacheKey, result);
  return result;
}

function clearCache(missionName) {
  if (!missionName) {
    geoCache.clear();
    layerCache.clear();
    rawFcCache.clear();
    rawFcInFlight.clear();
    geoInFlight.clear();
    return;
  }
  const prefix = String(missionName).trim();
  for (const key of geoCache.keys()) {
    if (key.startsWith(prefix)) geoCache.delete(key);
  }
  for (const key of rawFcCache.keys()) {
    if (key.startsWith(prefix)) rawFcCache.delete(key);
  }
  for (const key of rawFcInFlight.keys()) {
    if (key.startsWith(prefix)) rawFcInFlight.delete(key);
  }
  for (const key of geoInFlight.keys()) {
    if (key.startsWith(prefix)) geoInFlight.delete(key);
  }
  layerCache.delete(prefix);
}

/** Polygon/line features from recently fetched mission GeoJSON (for live decor filtering). */
function getCachedMissionShapeFeatures() {
  const out = [];
  for (const entry of geoCache.values()) {
    if (!entry || Date.now() - entry.at > CACHE_TTL_MS) continue;
    const fc = entry.value;
    if (!fc || !Array.isArray(fc.features)) continue;
    for (const feature of fc.features) {
      const gt = geometryType(feature?.geometry);
      if (gt === "polygon" || gt === "line") out.push(feature);
    }
  }
  return out;
}

async function getMissionCotRaw(missionName, uid, options = {}) {
  const name = String(missionName || "").trim();
  const id = String(uid || "").trim();
  if (!name || !id) {
    const err = new Error("Mission name and uid are required.");
    err.code = "INVALID_PARAMS";
    throw err;
  }
  const res = await dataSyncSvc.getMissionCotXml(name, options.queryParams || {});
  if (res.status >= 400) {
    const err = new Error(`Mission CoT fetch failed (${res.status})`);
    err.status = res.status;
    err.code = "MISSION_COT_FETCH_FAILED";
    throw err;
  }
  const mod = await loadCotConvert();
  const chunks = mod.splitMissionCotXml(res.data);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const match = chunk.match(/\buid=['"]([^'"]+)['"]/i);
    if (match && match[1] === id) return chunk;
  }
  const err = new Error("CoT event not found in mission.");
  err.code = "NOT_FOUND";
  err.status = 404;
  throw err;
}

module.exports = {
  CACHE_TTL_MS,
  geometryType,
  normalizeLayerTree,
  normalizeFeatureCollection,
  isShapeVertexPoint,
  collectShapeVertexKeys,
  filterShapeVertexPoints,
  getMissionGeoJson,
  getMissionLayerTree,
  getMissionCotRaw,
  auditMissionShapeDecor,
  getCachedMissionShapeFeatures,
  clearCache,
};
