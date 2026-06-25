/**
 * ESM: bulk mission CoT XML → GeoJSON via @tak-ps/node-cot.
 */
import { CoTParser } from "@tak-ps/node-cot";

const SKIP_TYPE_PREFIXES = ["b-t-f", "t-x-m-c", "t-x-d-d"];
const SKIP_POINT_TYPE_PREFIXES = ["b-m-p-s-p-i", "b-m-p-s-p-loc"];

function shouldSkipType(type) {
  const t = String(type || "").trim().toLowerCase();
  if (!t) return true;
  if (SKIP_POINT_TYPE_PREFIXES.some((p) => t === p || t.startsWith(p + "-"))) return true;
  return SKIP_TYPE_PREFIXES.some((p) => t === p || t.startsWith(p + "-"));
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
    if (geomType === "point" && (t.startsWith("b-m-p") || t.startsWith("u-d"))) {
      return null;
    }
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
