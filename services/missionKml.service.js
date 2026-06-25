/**
 * Parse KML/KMZ mission attachments into GeoJSON features.
 */
const unzipper = require("unzipper");
const { kml } = require("@tmcw/togeojson");
const { DOMParser } = require("@xmldom/xmldom");
const dataSyncSvc = require("./dataSync.service");

const KML_MIMES = new Set([
  "application/vnd.google-earth.kml+xml",
  "application/vnd.google-earth.kmz",
  "text/xml",
  "application/xml",
]);

function isKmlContent(entry) {
  const mime = String(entry?.mimeType || entry?.mimetype || entry?.type || "").toLowerCase();
  const name = String(entry?.name || entry?.filename || "").toLowerCase();
  if (KML_MIMES.has(mime)) return true;
  return name.endsWith(".kml") || name.endsWith(".kmz");
}

function contentHash(entry) {
  return String(entry?.hash || entry?.contentHash || entry?.sha256 || "").trim();
}

async function bufferFromSyncContent(hash) {
  const res = await dataSyncSvc.getSyncContent(hash);
  if (res.status >= 400) {
    const err = new Error(`Sync content fetch failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return Buffer.from(res.data);
}

async function extractKmlXmlFromBuffer(buf, filename) {
  const name = String(filename || "").toLowerCase();
  if (name.endsWith(".kmz") || buf[0] === 0x50) {
    const directory = await unzipper.Open.buffer(buf);
    for (const entry of directory.files) {
      if (/\.kml$/i.test(entry.path)) {
        return entry.buffer();
      }
    }
    return null;
  }
  return buf;
}

function kmlToFeatures(xml, missionName, sourceMeta) {
  const doc = new DOMParser().parseFromString(String(xml), "text/xml");
  const gj = kml(doc);
  const features = [];
  for (const f of gj.features || []) {
    if (!f?.geometry) continue;
    const uid = `kml:${sourceMeta.hash}:${features.length}`;
    features.push({
      type: "Feature",
      id: uid,
      geometry: f.geometry,
      properties: {
        ...(f.properties || {}),
        kind: "mission-feature",
        missionName,
        id: uid,
        uid,
        cotType: "kml",
        callsign: f.properties?.name || f.properties?.description || "KML",
        contentSource: "kml",
        contentHash: sourceMeta.hash,
        contentName: sourceMeta.name,
        geometryType:
          f.geometry.type === "Point"
            ? "point"
            : f.geometry.type === "LineString" || f.geometry.type === "MultiLineString"
              ? "line"
              : "polygon",
        stroke: f.properties?.stroke || "#22d3ee",
        fill: f.properties?.fill || "#22d3ee",
        "stroke-width": Number(f.properties?.["stroke-width"]) || 2,
        "fill-opacity": f.properties?.["fill-opacity"] != null ? f.properties["fill-opacity"] : 0.35,
        origin: "mission",
      },
    });
  }
  return features;
}

async function loadKmlFeaturesFromMission(missionName, missionPayload) {
  const mission = missionPayload?.data || missionPayload || {};
  const contents = mission.contents || mission.Contents || [];
  const list = Array.isArray(contents) ? contents : [];
  const features = [];

  for (const entry of list) {
    if (!isKmlContent(entry)) continue;
    const hash = contentHash(entry);
    if (!hash) continue;
    try {
      const buf = await bufferFromSyncContent(hash);
      const xmlBuf = await extractKmlXmlFromBuffer(buf, entry.name || entry.filename);
      if (!xmlBuf) continue;
      const name = String(entry.name || entry.filename || hash);
      features.push(
        ...kmlToFeatures(xmlBuf.toString("utf8"), missionName, { hash, name })
      );
    } catch (err) {
      console.warn("[mission-kml] failed to load", hash, err?.message || err);
    }
  }
  return features;
}

module.exports = {
  isKmlContent,
  loadKmlFeaturesFromMission,
  kmlToFeatures,
};
