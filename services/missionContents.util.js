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
};
