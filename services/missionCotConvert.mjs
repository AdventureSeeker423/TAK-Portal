/**
 * ESM: bulk mission CoT XML → GeoJSON via @tak-ps/node-cot.
 */
import { createRequire } from "module";
import { CoTParser } from "@tak-ps/node-cot";

const require = createRequire(import.meta.url);
const shapeDecor = require("../public/shapeDecorFilter.js");

/** Chat / mission control chatter — never map geometry. */
const SKIP_TYPE_PREFIXES = ["b-t-f", "t-x-m-c", "t-x-d-d"];
/** Video bit events are attachments, not map positions (often at 0,0). */
const SKIP_BIT_TYPE_PREFIXES = ["b-i-v"];

function shouldSkipType(type) {
  const t = String(type || "").trim().toLowerCase();
  if (!t) return true;
  if (SKIP_BIT_TYPE_PREFIXES.some((p) => t === p || t.startsWith(p + "-"))) return true;
  return SKIP_TYPE_PREFIXES.some((p) => t === p || t.startsWith(p + "-"));
}

function extractVideoMeta(xmlChunk) {
  const raw = String(xmlChunk || "");
  const urlAttr = raw.match(/<__video\b[^>]*\burl\s*=\s*['"]([^'"]+)['"]/i);
  const addressAttr = raw.match(/<ConnectionEntry\b[^>]*\baddress\s*=\s*['"]([^'"]+)['"]/i);
  const videoUidAttr = raw.match(/<__video\b[^>]*\buid\s*=\s*['"]([^'"]+)['"]/i);
  const url = (urlAttr && urlAttr[1]) || (addressAttr && addressAttr[1]) || "";
  const videoUid = (videoUidAttr && videoUidAttr[1]) || "";
  if (!url && !videoUid) return null;
  return { videoUrl: url || "", videoUid: videoUid || "" };
}

function pointIsNullIsland(geometry) {
  if (!geometry || String(geometry.type || "").toLowerCase() !== "point") return false;
  const c = geometry.coordinates;
  if (!Array.isArray(c) || c.length < 2) return false;
  return Number(c[0]) === 0 && Number(c[1]) === 0;
}

export function splitMissionCotXml(xml) {
  const raw = String(xml || "").trim();
  if (!raw) return [];
  const chunks = [];
  const re = /<event[\s>]/gi;
  let match;
  const starts = [];
  while ((match = re.exec(raw)) !== null) {
    starts.push(match.index);
  }
  if (!starts.length) return [];
  for (let i = 0; i < starts.length; i++) {
    const slice = raw.slice(starts[i], starts[i + 1] != null ? starts[i + 1] : undefined);
    const end = slice.lastIndexOf("</event>");
    if (end === -1) continue;
    chunks.push(slice.slice(0, end + "</event>".length));
  }
  return chunks;
}

export async function cotXmlToGeoJsonFeature(xmlChunk) {
  try {
    const cot = CoTParser.from_xml(xmlChunk, { flow: false });
    const type = cot.type();
    if (shouldSkipType(type)) return null;
    const feat = await CoTParser.to_geojson(cot);
    if (!feat || !feat.geometry) return null;
    const geomType = String(feat.geometry.type || "").toLowerCase();
    const t = String(type || "").toLowerCase();

    // Drawing/shape control points are rendered via their parent polygon/line.
    // Keep operational SPI / sensor / camera points (b-m-p-s-p-loc, b-m-p-s-p-i, …).
    if (geomType === "point" && shapeDecor.isShapeControlCotType(t)) {
      return null;
    }

    // Discard null-island points (common for unpaired video/sensor sidecars).
    if (pointIsNullIsland(feat.geometry)) {
      return null;
    }

    const video = extractVideoMeta(xmlChunk);
    if (video) {
      feat.properties = Object.assign({}, feat.properties || {}, {
        videoUrl: video.videoUrl || undefined,
        videoUid: video.videoUid || undefined,
        contentSource: video.videoUrl ? "video" : feat.properties?.contentSource,
      });
    }
    // Keep original event XML for Copy RAW (packages / offline overlays).
    feat.properties = Object.assign({}, feat.properties || {}, {
      cotRawXml: String(xmlChunk || "").trim(),
    });
    return feat;
  } catch (_) {
    return null;
  }
}

export async function missionCotXmlToFeatureCollection(xml, missionName) {
  const chunks = splitMissionCotXml(xml);
  const features = [];
  const batchSize = 24;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const converted = await Promise.all(batch.map((chunk) => cotXmlToGeoJsonFeature(chunk)));
    for (let j = 0; j < converted.length; j++) {
      if (converted[j]) features.push(converted[j]);
    }
  }
  return {
    type: "FeatureCollection",
    features,
    meta: {
      missionName: String(missionName || ""),
      eventCount: chunks.length,
      featureCount: features.length,
    },
  };
}
