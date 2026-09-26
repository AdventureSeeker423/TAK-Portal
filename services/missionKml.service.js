/**
 * Parse KML/KMZ mission attachments into GeoJSON features.
 */
const unzipper = require("unzipper");
const { kml } = require("@tmcw/togeojson");
const { DOMParser } = require("@xmldom/xmldom");
const dataSyncSvc = require("./dataSync.service");
const {
  listMissionAttachmentEntries,
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

function decodeKmlDescription(value) {
  let text = String(value || "");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
  return text
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cotTypeFromKmlProperties(props) {
  const style = String(props?.styleUrl || props?.styleurl || "")
    .replace(/^#/, "")
    .trim();
  if (/^[a-z](?:-[a-z0-9]+)+$/i.test(style)) return style;
  const desc = String(props?.description || "");
  const match = desc.match(/Type:\s*([a-z](?:-[A-Za-z0-9]+)+)/i);
  return match ? match[1] : "";
}

function xmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pointFeatureToCotXml(feature, cotType, callsign, remarks) {
  const coords =
    feature.geometry && Array.isArray(feature.geometry.coordinates)
      ? feature.geometry.coordinates
      : [];
  const lon = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return "";
  const hae = Number.isFinite(Number(coords[2])) ? Number(coords[2]) : 9999999;
  const uid = String(feature.id || "").trim() || "kml-point";
  const type = String(cotType || "a-u-G").trim() || "a-u-G";
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const remarksXml = remarks ? `<remarks>${xmlEscape(remarks)}</remarks>` : "";
  return (
    `<event version="2.0" uid="${xmlEscape(uid)}" type="${xmlEscape(type)}" ` +
    `time="${stamp}" start="${stamp}" stale="${stamp}" how="h-g-i-g-o">` +
    `<point lat="${lat}" lon="${lon}" hae="${hae}" ce="9999999.0" le="9999999.0"/>` +
    `<detail><contact callsign="${xmlEscape(callsign)}"/>${remarksXml}</detail></event>`
  );
}

function kmlToFeatures(xml, missionName, sourceMeta) {
  const doc = new DOMParser().parseFromString(String(xml), "text/xml");
  const gj = kml(doc);
  const features = [];
  for (const f of gj.features || []) {
    if (!f?.geometry) continue;
    const props = f.properties || {};
    const placemarkId = String(f.id || "").trim();
    const uid = placemarkId || `kml:${sourceMeta.hash}:${features.length}`;
    const cotType = cotTypeFromKmlProperties(props);
    const remarks = decodeKmlDescription(props.description || "");
    const callsign =
      String(props.name || "").trim() || remarks || sourceMeta.name || "KML";
    const feature = {
      type: "Feature",
      id: uid,
      geometry: f.geometry,
      properties: {
        ...props,
        kind: "mission-feature",
        missionName,
        id: uid,
        uid,
        type: cotType || props.type || "",
        cotType: cotType || "kml",
        callsign,
        remarks,
        description: remarks,
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
        stroke: props.stroke || "#22d3ee",
        fill: props.fill || "#22d3ee",
        "stroke-width": Number(props["stroke-width"]) || 2,
        "fill-opacity": props["fill-opacity"] != null ? props["fill-opacity"] : 0.35,
        origin: "mission",
      },
    };
    if (f.geometry.type === "Point") {
      feature.properties.cotRawXml = pointFeatureToCotXml(
        feature,
        cotType || "a-u-G",
        callsign,
        remarks
      );
    }
    features.push(feature);
  }
  return features;
}

async function loadKmlFeaturesFromMission(missionName, missionPayload) {
  const list = listMissionAttachmentEntries(missionPayload);
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
  extractKmlXmlFromBuffer,
};
