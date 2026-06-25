/**
 * Shared helpers for mission content entries from TAK Marti payloads.
 */
const dataSyncAccess = require("./dataSyncAccess.service");

function unwrapMissionPayload(payload) {
  if (!payload) return null;
  return dataSyncAccess.unwrapMission(payload) || payload;
}

function missionContentsList(missionPayload) {
  const mission = unwrapMissionPayload(missionPayload) || {};
  const contents = mission.contents || mission.Contents || [];
  return Array.isArray(contents) ? contents : [];
}

function contentHash(entry) {
  return String(
    entry?.hash ||
      entry?.Hash ||
      entry?.contentHash ||
      entry?.ContentHash ||
      entry?.sha256 ||
      entry?.uid ||
      entry?.UID ||
      entry?.UUID ||
      ""
  ).trim();
}

function contentName(entry) {
  return String(
    entry?.name || entry?.filename || entry?.downloadName || entry?.FileName || ""
  ).trim();
}

function contentMime(entry) {
  return String(
    entry?.mimeType || entry?.mimetype || entry?.MimeType || entry?.type || ""
  )
    .trim()
    .toLowerCase();
}

function parseMissionBbox(mission) {
  const m = unwrapMissionPayload(mission) || mission || {};
  const bbox = m.bbox ?? m.Bbox ?? m.BBox;
  if (!bbox) return null;

  if (typeof bbox === "string") {
    const parts = bbox.split(/[,\s]+/).map(Number);
    if (parts.length >= 4 && parts.every(Number.isFinite)) {
      const [a, b, c, d] = parts;
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
  missionContentsList,
  contentHash,
  contentName,
  contentMime,
  parseMissionBbox,
};
