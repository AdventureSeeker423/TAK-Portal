/**
 * ESM: bulk mission CoT XML → GeoJSON via @tak-ps/node-cot.
 */
import { CoTParser } from "@tak-ps/node-cot";

const SKIP_TYPE_PREFIXES = ["b-t-f", "t-x-m-c", "t-x-d-d"];

function shouldSkipType(type) {
  const t = String(type || "").trim().toLowerCase();
  if (!t) return true;
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
    return feat;
  } catch (_) {
    return null;
  }
}

export async function missionCotXmlToFeatureCollection(xml, missionName) {
  const chunks = splitMissionCotXml(xml);
  const features = [];
  for (const chunk of chunks) {
    const feat = await cotXmlToGeoJsonFeature(chunk);
    if (!feat) continue;
    features.push(feat);
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
