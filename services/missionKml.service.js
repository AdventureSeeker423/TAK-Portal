/**
 * Parse KML/KMZ mission attachments into GeoJSON features.
 */
const unzipper = require("unzipper");
const { kml } = require("@tmcw/togeojson");
const { DOMParser } = require("@xmldom/xmldom");
const dataSyncSvc = require("./dataSync.service");
const {
  missionContentsList,
  contentHash,
  contentName,
  contentMime,
} = require("./missionContents.util");

const KML_EXT = /\.(kml|kmz)$/i;

function isKmlContent(entry) {
  const mime = contentMime(entry);
  const name = contentName(entry).toLowerCase();
  if (
    mime === "application/vnd.google-earth.kml+xml" ||
    mime === "application/vnd.google-earth.kmz" ||
    mime === "text/xml" ||
    mime === "application/xml"
  ) {
    return true;
  }
  if (mime === "application/octet-stream" && KML_EXT.test(name)) return true;
  return KML_EXT.test(name);
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
  if (name.endsWith(".kmz") || (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b)) {
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
    const label =
      f.properties?.name || f.properties?.description || sourceMeta.name || "KML";
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
        callsign: label,
        showLabel: 1,
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
  const list = missionContentsList(missionPayload);
  const features = [];

  for (const entry of list) {
    if (!isKmlContent(entry)) continue;
    const hash = contentHash(entry);
    if (!hash) continue;
    try {
      const buf = await bufferFromSyncContent(hash);
      const fileName = contentName(entry);
      const xmlBuf = await extractKmlXmlFromBuffer(buf, fileName);
      if (!xmlBuf) continue;
      features.push(
        ...kmlToFeatures(xmlBuf.toString("utf8"), missionName, {
          hash,
          name: fileName || hash,
        })
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
