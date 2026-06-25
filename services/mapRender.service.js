/**
 * Server-side map rendering: GeoJSON assembly + marker visibility filtering.
 */
const crypto = require("crypto");
const { getInt } = require("./env");
const mapMeta = require("./mapMeta.service");
const mapIconRender = require("./mapIconRender.service");

const GEOJSON_CACHE_MS = getInt("MAP_GEOJSON_CACHE_MS", 0);

/** @type {{ key: string, at: number, data: object } | null} */
let geoJsonCache = null;

const renderStats = {
  lastBuildMs: 0,
  lastVisible: 0,
  lastTotal: 0,
  lastUniqueIcons: 0,
};

function markerDisplayColor(marker) {
  return mapMeta.resolveMarkerDisplayColor(marker);
}

function markerChannelKeys(marker) {
  const groups =
    Array.isArray(marker?.groups) && marker.groups.length
      ? marker.groups
      : [mapMeta.UNASSIGNED_GROUP];
  const keys = new Set();
  for (const g of groups) {
    const channelName = mapMeta.toChannelGroupName(g) || g;
    const key = mapMeta.channelBaseKey(channelName);
    if (key) keys.add(key);
  }
  return Array.from(keys);
}

function parseKeySet(raw, delimiter) {
  const text = String(raw || "").trim();
  if (!text) return null;
  if (text === "__none__") return new Set();
  const out = new Set();
  for (const part of text.split(delimiter)) {
    const decoded = decodeURIComponent(part.trim());
    const key =
      mapMeta.channelBaseKey(decoded) ||
      String(decoded || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
    if (key) out.add(key);
  }
  return out;
}

function parseGeoJsonQuery(query) {
  const channelsRaw = String(query?.channels || "").trim();
  /** @type {Set<string>|null} */
  let enabledChannelKeys = null;

  if (channelsRaw === "__none__") {
    enabledChannelKeys = new Set();
  } else if (channelsRaw) {
    enabledChannelKeys = parseKeySet(channelsRaw, ",");
  }

  const scopeKeys = parseKeySet(query?.scopeKeys, ",");

  const zoom = Number.parseFloat(query?.zoom);
  const boundsRaw = String(query?.bounds || "").trim();
  let bounds = null;
  if (boundsRaw) {
    const parts = boundsRaw.split(",").map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      bounds = { west: parts[0], south: parts[1], east: parts[2], north: parts[3] };
    }
  }

  return {
    enabledChannelKeys,
    scopeChannelKeys: scopeKeys,
    search: String(query?.q || "").trim().toLowerCase(),
    selectedUid: String(query?.selected || "").trim(),
    lockedUid: String(query?.locked || "").trim(),
    revision: String(query?.revision || "").trim(),
    zoom: Number.isFinite(zoom) ? zoom : null,
    bounds,
    declutterLabels: String(query?.declutter || "").trim() === "1",
  };
}

function markerMatchesSearch(marker, search) {
  if (!search) return true;
  const groups = Array.isArray(marker?.groups) ? marker.groups : [];
  return (
    String(marker?.callsign || "").toLowerCase().includes(search) ||
    String(marker?.uid || "").toLowerCase().includes(search) ||
    String(marker?.type || "").toLowerCase().includes(search) ||
    groups.some((g) => String(g).toLowerCase().includes(search))
  );
}

function markerInBounds(marker, bounds) {
  if (!bounds) return true;
  const lat = Number(marker?.lat);
  const lon = Number(marker?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return (
    lon >= bounds.west &&
    lon <= bounds.east &&
    lat >= bounds.south &&
    lat <= bounds.north
  );
}

function markerVisible(marker, options) {
  const keys = markerChannelKeys(marker);
  const scopeChannelKeys = options?.scopeChannelKeys;

  if (scopeChannelKeys !== null && scopeChannelKeys !== undefined) {
    if (scopeChannelKeys.size === 0) return false;
    if (!keys.length) return false;
    if (!keys.some((k) => scopeChannelKeys.has(k))) return false;
  }

  const enabledChannelKeys = options?.enabledChannelKeys;
  if (enabledChannelKeys !== null && enabledChannelKeys !== undefined) {
    if (enabledChannelKeys.size === 0) return false;
    if (!keys.length) return false;
    if (!keys.some((k) => enabledChannelKeys.has(k))) return false;
  }

  if (!markerMatchesSearch(marker, options?.search)) return false;
  if (!markerInBounds(marker, options?.bounds)) return false;
  return true;
}

function isAirCotType(type) {
  const parts = String(type || "")
    .trim()
    .split("-");
  return parts.length >= 3 && parts[2].toUpperCase() === "A";
}

function isFeedLikeOrigin(origin) {
  const o = String(origin || "").toLowerCase();
  return o === "feed" || o === "mission";
}

/** PNG / 2525D map icons: feeds, explicit usericon/path, air type2525b; EUD uses team dots. */
function markerUsesMapIcon(marker) {
  if (!marker?.iconId) return false;
  if (String(marker.origin || "").toLowerCase() === "eud") return false;
  const src = String(marker.iconSource || "").toLowerCase();
  if (src === "usericon" || src === "path" || src === "alias" || src === "milsym") {
    return true;
  }
  const apiId = String(marker.iconId || "");
  if (apiId.startsWith("2525D:")) return true;
  if (isAirCotType(marker.type) && src === "default") return true;
  if (src === "type2525b") {
    if (isAirCotType(marker.type)) return true;
    return isFeedLikeOrigin(marker.origin);
  }
  return false;
}

function markerOriginRank(marker) {
  const origin = String(marker?.origin || "").toLowerCase();
  if (origin === "eud") return 2;
  if (origin === "feed") return 0;
  if (origin === "unknown") return 1;
  const type = String(marker?.type || "");
  if (/^a-f-G-/i.test(type)) return 2;
  if (/^a-[fnhu]-A-/i.test(type)) return 0;
  if (/^a-f-[GUS]-/i.test(type)) return 2;
  return 1;
}

function markerRenderSort(marker, options) {
  const selectedUid = options?.selectedUid || "";
  const lockedUid = options?.lockedUid || "";
  return (
    markerOriginRank(marker) * 100 +
    (marker.uid === selectedUid ? 50 : marker.uid === lockedUid ? 25 : 0)
  );
}

function markerDrawTier(marker) {
  return markerOriginRank(marker) >= 2 ? 1 : 0;
}

function markerLabelDeclutterPriority(marker, options) {
  if (marker.uid === options?.selectedUid) return 0;
  if (marker.uid === options?.lockedUid) return 1;
  const rank = markerOriginRank(marker);
  if (rank === 2) return 2;
  if (rank === 1) return 3;
  return 4;
}

function estimateLabelBoxMercator(lon, lat, callsign, zoom) {
  const z = Number.isFinite(zoom) ? zoom : 10;
  const scale = 256 * Math.pow(2, z);
  const x = ((lon + 180) / 360) * scale;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  const w = Math.max(36, String(callsign || "").length * 6.5);
  const h = 13;
  return { x: x - w / 2, y: y - 28, w, h };
}

function labelBoxOverlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function computeLabelVisibility(visible, options) {
  /** @type {Map<string, number>} */
  const out = new Map();
  const sorted = visible.slice().sort(function (a, b) {
    const aPri = markerLabelDeclutterPriority(a, options);
    const bPri = markerLabelDeclutterPriority(b, options);
    if (aPri !== bPri) return aPri - bPri;
    return String(a.callsign).localeCompare(String(b.callsign));
  });
  const placed = [];
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
    if (m.uid === options.selectedUid || m.uid === options.lockedUid) {
      out.set(m.uid, 1);
      placed.push(
        estimateLabelBoxMercator(m.lon, m.lat, m.callsign, options.zoom)
      );
      continue;
    }
    const box = estimateLabelBoxMercator(m.lon, m.lat, m.callsign, options.zoom);
    let overlap = false;
    for (let j = 0; j < placed.length; j++) {
      if (labelBoxOverlaps(box, placed[j])) {
        overlap = true;
        break;
      }
    }
    out.set(m.uid, overlap ? 0 : 1);
    if (!overlap) placed.push(box);
  }
  return out;
}

function buildCacheKey(markers, options, revision) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        revision: revision || 0,
        selectedUid: options.selectedUid || "",
        lockedUid: options.lockedUid || "",
        search: options.search || "",
        enabled: options.enabledChannelKeys
          ? Array.from(options.enabledChannelKeys).sort()
          : null,
        scope: options.scopeChannelKeys
          ? Array.from(options.scopeChannelKeys).sort()
          : null,
        bounds: options.bounds || null,
        zoom: options.zoom,
        declutter: !!options.declutterLabels,
        count: markers.length,
      })
    )
    .digest("hex");
}

function toSlimMarker(marker) {
  if (!marker) return null;
  const color = markerDisplayColor(marker);
  const usesIcon = markerUsesMapIcon(marker);
  const apiIconId = usesIcon ? String(marker.iconId || "") : "";
  const mapImageId = apiIconId
    ? mapIconRender.computeMapImageId(marker, apiIconId, color)
    : "";
  return {
    uid: marker.uid,
    callsign: marker.callsign,
    type: marker.type,
    lat: Number.isFinite(Number(marker?.lat)) ? Number(marker.lat) : marker?.lat,
    lon: Number.isFinite(Number(marker?.lon)) ? Number(marker.lon) : marker?.lon,
    groups: marker.groups,
    affiliation: marker.affiliation,
    teamColor: marker.teamColor,
    color,
    stale: marker.stale,
    course:
      marker.course != null && Number.isFinite(Number(marker.course))
        ? Math.round(Number(marker.course))
        : null,
    hae: marker.hae,
    speed:
      marker.speed != null && Number.isFinite(Number(marker.speed))
        ? Math.round(Number(marker.speed))
        : null,
    time: marker.time,
    start: marker.start,
    how: marker.how,
    origin: marker.origin || null,
    team: marker.team,
    role: marker.role || null,
    updatedAt: marker.updatedAt,
    iconId: marker.iconId || null,
    iconSource: marker.iconSource || null,
    mapImageId: mapImageId || "",
    usesMapIcon: usesIcon ? 1 : 0,
    channelKeys: markerChannelKeys(marker).join(","),
    showCircle: mapImageId ? 0 : 1,
    remarks: marker.remarks || null,
  };
}

function toRenderedFeature(marker, options = {}) {
  const color = markerDisplayColor(marker);
  const usesIcon = markerUsesMapIcon(marker);
  const apiIconId = usesIcon ? String(marker.iconId) : "";
  const mapImageId = apiIconId
    ? mapIconRender.computeMapImageId(marker, apiIconId, color)
    : "";
  const renderSort = markerRenderSort(marker, options);
  const showLabel =
    options.labelMap && options.labelMap.has(marker.uid)
      ? options.labelMap.get(marker.uid)
      : marker.uid === options.selectedUid || marker.uid === options.lockedUid
        ? 1
        : 1;

  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [marker.lon, marker.lat] },
    properties: {
      kind: "marker",
      uid: marker.uid,
      callsign: marker.callsign,
      type: marker.type,
      affiliation: marker.affiliation || "other",
      color,
      iconId: mapImageId,
      apiIconId: apiIconId || "",
      iconSource: marker.iconSource || "",
      origin: marker.origin || "",
      usesMapIcon: usesIcon ? 1 : 0,
      showCircle: mapImageId ? 0 : 1,
      drawTier: markerDrawTier(marker),
      selected: marker.uid === options.selectedUid,
      locked: marker.uid === options.lockedUid,
      renderSort,
      labelSort: renderSort,
      showLabel,
      channelKeys: markerChannelKeys(marker).join(","),
    },
  };
}

function buildGeoJson(markers, options = {}) {
  const started = Date.now();
  const list = Array.isArray(markers) ? markers : [];
  const revision = options.markerRevision || 0;

  if (GEOJSON_CACHE_MS > 0) {
    const key = buildCacheKey(list, options, revision);
    if (
      geoJsonCache &&
      geoJsonCache.key === key &&
      Date.now() - geoJsonCache.at < GEOJSON_CACHE_MS
    ) {
      return geoJsonCache.data;
    }
  }

  const visible = [];
  for (const marker of list) {
    if (!Number.isFinite(Number(marker?.lat)) || !Number.isFinite(Number(marker?.lon))) {
      continue;
    }
    if (markerVisible(marker, options)) visible.push(marker);
  }

  const labelMap =
    options.declutterLabels && options.zoom != null
      ? computeLabelVisibility(visible, options)
      : null;

  const uniqueIcons = new Set();
  const iconManifest = [];
  const iconManifestKeys = new Set();
  const features = [];

  for (const marker of visible) {
    const color = markerDisplayColor(marker);
    const apiIconId = markerUsesMapIcon(marker) ? String(marker.iconId) : "";
    const mapImageId = apiIconId
      ? mapIconRender.computeMapImageId(marker, apiIconId, color)
      : "";
    if (mapImageId) {
      uniqueIcons.add(mapImageId);
      if (!iconManifestKeys.has(mapImageId)) {
        iconManifestKeys.add(mapImageId);
        iconManifest.push({
          mapImageId,
          apiIconId,
          color,
          iconSource: marker.iconSource || "",
          origin: marker.origin || "",
          type: marker.type || "",
          affiliation: marker.affiliation || "other",
        });
      }
    }

    features.push(
      toRenderedFeature(marker, {
        selectedUid: options.selectedUid,
        lockedUid: options.lockedUid,
        labelMap,
      })
    );
  }

  renderStats.lastBuildMs = Date.now() - started;
  renderStats.lastVisible = visible.length;
  renderStats.lastTotal = list.length;
  renderStats.lastUniqueIcons = uniqueIcons.size;

  const result = {
    type: "FeatureCollection",
    features,
    meta: {
      total: list.length,
      visible: visible.length,
      uniqueIcons: uniqueIcons.size,
      iconManifest,
      revision,
      buildMs: renderStats.lastBuildMs,
      updatedAt: new Date().toISOString(),
    },
  };

  if (GEOJSON_CACHE_MS > 0) {
    geoJsonCache = {
      key: buildCacheKey(list, options, revision),
      at: Date.now(),
      data: result,
    };
  }

  return result;
}

function getRenderStats() {
  return { ...renderStats, geoJsonCacheMs: GEOJSON_CACHE_MS };
}

module.exports = {
  parseGeoJsonQuery,
  markerVisible,
  markerChannelKeys,
  isAirCotType,
  markerUsesMapIcon,
  markerDisplayColor,
  markerOriginRank,
  markerRenderSort,
  markerDrawTier,
  computeLabelVisibility,
  toSlimMarker,
  toRenderedFeature,
  buildGeoJson,
  getRenderStats,
};
