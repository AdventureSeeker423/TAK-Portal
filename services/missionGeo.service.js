/**
 * Mission CoT → GeoJSON for map overlays (read-only).
 */
const { getInt } = require("./env");
const dataSyncSvc = require("./dataSync.service");
const mapIcon = require("./mapIcon.service");
const mapRender = require("./mapRender.service");
const mapIconRender = require("./mapIconRender.service");
const missionKml = require("./missionKml.service");
const missionRaster = require("./missionRaster.service");
const { unwrapMissionPayload } = require("./missionContents.util");

const CACHE_TTL_MS = getInt("MISSION_GEO_CACHE_TTL_MS", 45000);
const geoCache = new Map();
const layerCache = new Map();

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
  const parts = String(cotType || "").trim().split("-");
  if (parts.length < 2) return "other";
  const aff = parts[1].toLowerCase();
  if (aff === "f") return "friend";
  if (aff === "h") return "hostile";
  if (aff === "n") return "neutral";
  if (aff === "u") return "unknown";
  return "other";
}

function parseUserIconFromFeature(props) {
  const iconPath = props?.icon;
  if (!iconPath) return null;
  return {
    iconsetpath: String(iconPath),
    name: String(iconPath).split("/").pop() || "",
  };
}

async function augmentPointFeature(feature, missionName) {
  const props = feature.properties || {};
  const cotType = String(props.type || "");
  const uid = String(feature.id || props.uid || "");
  const usericon = parseUserIconFromFeature(props);
  const affiliation = affiliationFromType(cotType);

  await mapIcon.ensureIconsets();
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
    teamColor: colorFromProps(props),
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
      showLabel: 1,
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
      showLabel: 1,
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

async function normalizeFeatureCollection(fc, missionName) {
  const out = [];
  for (const feature of fc.features || []) {
    if (!feature?.geometry) continue;
    const geomType = geometryType(feature.geometry);
    if (geomType === "point") {
      out.push(await augmentPointFeature(feature, missionName));
    } else {
      out.push(normalizeFeature(feature, missionName));
    }
  }
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

async function fetchMissionCotGeoJson(missionName, queryParams = {}) {
  const res = await dataSyncSvc.getMissionCotXml(missionName, queryParams);
  if (res.status >= 400) {
    const err = new Error(`Mission CoT fetch failed (${res.status})`);
    err.status = res.status;
    err.code = "MISSION_COT_FETCH_FAILED";
    throw err;
  }
  const mod = await loadCotConvert();
  const fc = await mod.missionCotXmlToFeatureCollection(res.data, missionName);
  return normalizeFeatureCollection(fc, missionName);
}

async function getMissionGeoJson(missionName, options = {}) {
  const name = String(missionName || "").trim();
  const cacheKey = `${name}:att=${options.includeAttachments ? 1 : 0}:${JSON.stringify(options.queryParams || {})}`;
  if (!options.refresh) {
    const cached = cacheGet(geoCache, cacheKey);
    if (cached) return cached;
  }

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
        fc = {
          type: "FeatureCollection",
          features: [...fc.features, ...kmlFeatures],
        };
      }
      rasterOverlays = await missionRaster.buildRasterOverlays(name, mission);
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
        iconManifest.push({
          mapImageId: p.iconId,
          apiIconId: p.apiIconId,
          color: p.color,
          iconSource: p.iconSource,
          origin: "mission",
          type: p.cotType,
          affiliation: affiliationFromType(p.cotType),
        });
      }
    }
  }

  const result = {
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
  cacheSet(geoCache, cacheKey, result);
  return result;
}

async function getMissionLayerTree(missionName, options = {}) {
  const name = String(missionName || "").trim();
  const cacheKey = name;
  if (!options.refresh) {
    const cached = cacheGet(layerCache, cacheKey);
    if (cached) return cached;
  }

  const res = await dataSyncSvc.getMissionLayers(name, options.queryParams || {});
  if (res.status >= 400) {
    const err = new Error(`Mission layer fetch failed (${res.status})`);
    err.status = res.status;
    err.code = "MISSION_LAYER_FETCH_FAILED";
    throw err;
  }

  let featureUids = options.featureUids;
  if (!featureUids) {
    const geo = await getMissionGeoJson(name, {
      queryParams: options.queryParams,
      refresh: options.refresh,
    });
    featureUids = (geo.features || []).map((f) => String(f.id || f.properties?.uid || ""));
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
    return;
  }
  const prefix = String(missionName).trim();
  for (const key of geoCache.keys()) {
    if (key.startsWith(prefix)) geoCache.delete(key);
  }
  layerCache.delete(prefix);
}

module.exports = {
  CACHE_TTL_MS,
  geometryType,
  normalizeLayerTree,
  normalizeFeatureCollection,
  getMissionGeoJson,
  getMissionLayerTree,
  clearCache,
};
