/**
 * Server-side map rendering: GeoJSON assembly + marker visibility filtering.
 */
const { getInt } = require("./env");
const mapMeta = require("./mapMeta.service");

function markerDisplayColor(marker) {
  return mapMeta.resolveMarkerDisplayColor(marker);
}

function markerOpacity(marker, now = Date.now()) {
  if (!marker?.stale) return 1;
  const staleMs = Date.parse(marker.stale);
  if (!Number.isFinite(staleMs)) return 1;
  const remaining = staleMs - now;
  if (remaining <= 0) return 0.35;
  if (remaining < 60000) return 0.55;
  return 1;
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

function parseGeoJsonQuery(query) {
  const channelsRaw = String(query?.channels || "").trim();
  /** @type {Set<string>|null} */
  let enabledChannelKeys = null;

  if (channelsRaw === "__none__") {
    enabledChannelKeys = new Set();
  } else if (channelsRaw) {
    enabledChannelKeys = new Set();
    for (const part of channelsRaw.split(",")) {
      const decoded = decodeURIComponent(part.trim());
      const key =
        mapMeta.channelBaseKey(decoded) ||
        String(decoded || "")
          .trim()
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();
      if (key) enabledChannelKeys.add(key);
    }
  }

  return {
    enabledChannelKeys,
    search: String(query?.q || "").trim().toLowerCase(),
    selectedUid: String(query?.selected || "").trim(),
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

function markerVisible(marker, options) {
  const keys = markerChannelKeys(marker);
  const enabledChannelKeys = options?.enabledChannelKeys;

  if (enabledChannelKeys !== null && enabledChannelKeys !== undefined) {
    if (enabledChannelKeys.size === 0) return false;
    if (!keys.length) return false;
    if (!keys.some((k) => enabledChannelKeys.has(k))) return false;
  }

  if (!markerMatchesSearch(marker, options?.search)) return false;
  return true;
}

function toSlimMarker(marker) {
  if (!marker) return null;
  return {
    uid: marker.uid,
    callsign: marker.callsign,
    type: marker.type,
    lat: Number.isFinite(Number(marker?.lat)) ? Number(marker.lat) : marker?.lat,
    lon: Number.isFinite(Number(marker?.lon)) ? Number(marker.lon) : marker?.lon,
    groups: marker.groups,
    affiliation: marker.affiliation,
    teamColor: marker.teamColor,
    stale: marker.stale,
    course: marker.course,
    hae: marker.hae,
    speed: marker.speed,
    time: marker.time,
    start: marker.start,
    how: marker.how,
    team: marker.team,
    updatedAt: marker.updatedAt,
    iconId: marker.iconId || null,
    iconSource: marker.iconSource || null,
  };
}

function buildGeoJson(markers, options = {}) {
  const list = Array.isArray(markers) ? markers : [];
  const now = Date.now();
  const selectedUid = options.selectedUid || "";
  const maxIcons = getInt("MAP_MAX_ICONS", 120);

  const visible = [];
  for (const marker of list) {
    if (markerVisible(marker, options)) visible.push(marker);
  }

  const useIcons = visible.length <= maxIcons;
  const features = [];

  for (const marker of visible) {
    const color = markerDisplayColor(marker);
    const labelOpacity = markerOpacity(marker, now);
    const apiIconId = marker.iconId ? String(marker.iconId) : "";
    const coords = [marker.lon, marker.lat];

    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: coords },
      properties: {
        kind: "marker",
        uid: marker.uid,
        callsign: marker.callsign,
        type: marker.type,
        affiliation: marker.affiliation || "other",
        color,
        apiIconId,
        showCircle: apiIconId ? 0 : 1,
        opacity: 1,
        labelOpacity,
        selected: marker.uid === selectedUid,
        course: Number.isFinite(marker.course) && marker.course >= 0 ? marker.course : 0,
      },
    });

    if (
      Number.isFinite(marker.course) &&
      marker.course >= 0 &&
      Number.isFinite(marker.lat) &&
      Number.isFinite(marker.lon)
    ) {
      const rad = (marker.course * Math.PI) / 180;
      const len = 0.02;
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            coords,
            [marker.lon + Math.sin(rad) * len, marker.lat + Math.cos(rad) * len],
          ],
        },
        properties: { uid: marker.uid, color, kind: "course-line" },
      });
    }
  }

  return {
    type: "FeatureCollection",
    features,
    meta: {
      total: list.length,
      visible: visible.length,
      iconsEnabled: useIcons,
      maxIcons,
      updatedAt: new Date().toISOString(),
    },
  };
}

module.exports = {
  parseGeoJsonQuery,
  markerVisible,
  markerChannelKeys,
  toSlimMarker,
  buildGeoJson,
};
