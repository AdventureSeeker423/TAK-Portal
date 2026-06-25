/**
 * Shared helpers for mission content entries from TAK Marti payloads.
 */
const dataSyncAccess = require("./dataSyncAccess.service");

function unwrapMissionPayload(payload) {
  if (!payload) return null;
  return dataSyncAccess.unwrapMission(payload) || payload;
}

function normalizeContentEntry(entry) {
  if (!entry) return null;
  if (typeof entry === "string") {
    const hash = entry.trim();
    return hash ? { hash, name: "", mimeType: "" } : null;
  }
  if (typeof entry !== "object") return null;
  const data =
    entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
      ? entry.data
      : entry;
  return data && typeof data === "object" ? data : null;
}

function missionContentsList(missionPayload) {
  const mission = unwrapMissionPayload(missionPayload) || {};
  const contents =
    mission.contents ||
    mission.Contents ||
    mission.content ||
    mission.Content ||
    [];
  const list = Array.isArray(contents) ? contents : contents ? [contents] : [];
  return list.map(normalizeContentEntry).filter(Boolean);
}

function listMissionAttachmentEntries(missionPayload) {
  const mission = unwrapMissionPayload(missionPayload) || {};
  const entries = missionContentsList(mission);
  const seen = new Set();
  const out = [];

  function add(entry, source) {
    const norm = normalizeContentEntry(entry);
    if (!norm) return;
    const hash = contentHash(norm);
    if (!hash || seen.has(hash)) return;
    seen.add(hash);
    if (source) norm._attachmentSource = source;
    out.push(norm);
  }

  for (const entry of entries) add(entry);

  const baseLayer = mission.baseLayer ?? mission.BaseLayer;
  if (baseLayer) {
    if (typeof baseLayer === "string") {
      add({ hash: baseLayer.trim(), name: "baseLayer.tif" }, "baseLayer");
    } else {
      add(baseLayer, "baseLayer");
    }
  }

  const mapLayers = mission.mapLayers || mission.MapLayers || [];
  for (const layer of Array.isArray(mapLayers) ? mapLayers : []) {
    add(layer, "mapLayer");
  }

  const externalData = mission.externalData || mission.ExternalData || [];
  for (const item of Array.isArray(externalData) ? externalData : []) {
    add(item, "externalData");
  }

  return out;
}

function contentHash(entry) {
  const data = normalizeContentEntry(entry) || entry || {};
  return String(
    data.hash ||
      data.Hash ||
      data.contentHash ||
      data.ContentHash ||
      data.sha256 ||
      data.uid ||
      data.UID ||
      data.UUID ||
      ""
  ).trim();
}

function contentName(entry) {
  const data = normalizeContentEntry(entry) || entry || {};
  return String(
    data.name ||
      data.filename ||
      data.downloadName ||
      data.FileName ||
      data.keywords ||
      ""
  ).trim();
}

function contentMime(entry) {
  const data = normalizeContentEntry(entry) || entry || {};
  return String(
    data.mimeType || data.mimetype || data.MimeType || data.type || ""
  )
    .trim()
    .toLowerCase();
}

function looksLikeLatLonBbox(a, b, c, d) {
  if (![a, b, c, d].every(Number.isFinite)) return false;
  if (Math.abs(a) > 90 || Math.abs(c) > 90) return false;
  if (Math.abs(b) > 180 || Math.abs(d) > 180) return false;
  if (a > 0 && c > 0 && b < 0 && d < 0) return true;
  const avgLat = (Math.abs(a) + Math.abs(c)) / 2;
  const avgLon = (Math.abs(b) + Math.abs(d)) / 2;
  return avgLat < avgLon;
}

function parseMissionBbox(mission) {
  const m = unwrapMissionPayload(mission) || mission || {};
  const bbox = m.bbox ?? m.Bbox ?? m.BBox;
  if (!bbox) return null;

  if (typeof bbox === "string") {
    const parts = bbox.split(/[,\s]+/).map(Number);
    if (parts.length >= 4 && parts.every(Number.isFinite)) {
      const [a, b, c, d] = parts;
      if (looksLikeLatLonBbox(a, b, c, d)) {
        const south = Math.min(a, c);
        const north = Math.max(a, c);
        const west = Math.min(b, d);
        const east = Math.max(b, d);
        return [west, south, east, north];
      }
      const west = Math.min(a, c);
      const east = Math.max(a, c);
      const south = Math.min(b, d);
      const north = Math.max(b, d);
      return [west, south, east, north];
    }
    return null;
  }

  if (typeof bbox === "object") {
    const west = Number(bbox.west ?? bbox.minLon ?? bbox.lonMin ?? bbox.minX);
    const south = Number(bbox.south ?? bbox.minLat ?? bbox.latMin ?? bbox.minY);
    const east = Number(bbox.east ?? bbox.maxLon ?? bbox.lonMax ?? bbox.maxX);
    const north = Number(bbox.north ?? bbox.maxLat ?? bbox.latMax ?? bbox.maxY);
    if ([west, south, east, north].every(Number.isFinite)) {
      return [west, south, east, north];
    }
  }
  return null;
}

function parseGeoPoint(point) {
  if (point == null) return null;
  if (Array.isArray(point) && point.length >= 2) {
    const a = Number(point[0]);
    const b = Number(point[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    if (looksLikeLatLonBbox(a, b, a, b)) return [b, a];
    return [a, b];
  }
  if (typeof point === "object") {
    const lat = Number(
      point.lat ?? point.latitude ?? point.Lat ?? point.Latitude ?? point.y ?? point.Y
    );
    const lon = Number(
      point.lon ?? point.lng ?? point.longitude ?? point.Lon ?? point.Longitude ?? point.x ?? point.X
    );
    if (Number.isFinite(lat) && Number.isFinite(lon)) return [lon, lat];
  }
  return null;
}

/** Bounds from a single mission content / mapLayer entry (WGS84 lon/lat). */
function parseContentEntryBounds(entry) {
  const data = normalizeContentEntry(entry) || entry || {};

  const bbox = data.bbox ?? data.Bbox ?? data.BBox;
  if (bbox != null) {
    const parsed = parseMissionBbox({ bbox });
    if (parsed) return parsed;
  }

  const north = Number(data.north ?? data.North ?? data.maxLat ?? data.top);
  const south = Number(data.south ?? data.South ?? data.minLat ?? data.bottom);
  const east = Number(data.east ?? data.East ?? data.maxLon ?? data.right);
  const west = Number(data.west ?? data.West ?? data.minLon ?? data.left);
  if ([north, south, east, west].every(Number.isFinite)) {
    return [west, south, east, north];
  }

  const extent = data.extent ?? data.Extent;
  if (Array.isArray(extent) && extent.length >= 4) {
    const parts = extent.map(Number);
    if (parts.every(Number.isFinite)) {
      const parsed = parseMissionBbox({ bbox: parts.join(",") });
      if (parsed) return parsed;
    }
  }

  const ul = parseGeoPoint(data.upperLeft ?? data.UpperLeft ?? data.topLeft ?? data.TopLeft);
  const ur = parseGeoPoint(data.upperRight ?? data.UpperRight ?? data.topRight ?? data.TopRight);
  const lr = parseGeoPoint(data.lowerRight ?? data.LowerRight ?? data.bottomRight ?? data.BottomRight);
  const ll = parseGeoPoint(data.lowerLeft ?? data.LowerLeft ?? data.bottomLeft ?? data.BottomLeft);
  if (ul && ur && lr && ll) {
    const lons = [ul[0], ur[0], lr[0], ll[0]];
    const lats = [ul[1], ur[1], lr[1], ll[1]];
    return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  }

  return null;
}

/** MapLibre image-source corners from entry metadata: TL, TR, BR, BL. */
function parseContentEntryCoordinates(entry) {
  const data = normalizeContentEntry(entry) || entry || {};
  const ul = parseGeoPoint(data.upperLeft ?? data.UpperLeft ?? data.topLeft ?? data.TopLeft);
  const ur = parseGeoPoint(data.upperRight ?? data.UpperRight ?? data.topRight ?? data.TopRight);
  const lr = parseGeoPoint(data.lowerRight ?? data.LowerRight ?? data.bottomRight ?? data.BottomRight);
  const ll = parseGeoPoint(data.lowerLeft ?? data.LowerLeft ?? data.bottomLeft ?? data.BottomLeft);
  if (!ul || !ur || !lr || !ll) return null;
  return [ul, ur, lr, ll];
}

module.exports = {
  unwrapMissionPayload,
  normalizeContentEntry,
  missionContentsList,
  listMissionAttachmentEntries,
  contentHash,
  contentName,
  contentMime,
  parseMissionBbox,
  looksLikeLatLonBbox,
  parseGeoPoint,
  parseContentEntryBounds,
  parseContentEntryCoordinates,
};
