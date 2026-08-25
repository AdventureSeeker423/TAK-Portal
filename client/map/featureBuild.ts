import type { MarkerFeature, PaintFeatureProperties, SlimMarker } from "./types";
import { AFFILIATION_COLORS } from "./constants";
import { computeLabelSortKey } from "./labelDeclutter";
import { vectorId } from "./uidHash";

/** ATAK/TAK Aware self-SA ground (a-f-G-U-C). Other clients draw a team dot. */
export function isStandardGroundEudType(type: unknown): boolean {
  const parts = String(type || "")
    .trim()
    .split("-")
    .filter(Boolean);
  return (
    parts.length >= 5 &&
    parts[0].toLowerCase() === "a" &&
    parts[2].toUpperCase() === "G" &&
    parts[3].toUpperCase() === "U" &&
    parts[4].toUpperCase() === "C"
  );
}

function isExplicitCustomIconSource(source: unknown): boolean {
  const src = String(source || "").toLowerCase();
  return src === "usericon" || src === "path" || src === "alias";
}

/**
 * Ground EUDs stay team dots even if a stale slim payload still has a milsym/FalconView mapImageId.
 * usesMapIcon === 0 also wins over a leftover mapImageId.
 */
export function markerPaintsMapIcon(marker: SlimMarker): boolean {
  if (isStandardGroundEudType(marker.type) && !isExplicitCustomIconSource(marker.iconSource)) {
    return false;
  }
  if (marker.usesMapIcon === 0) return false;
  return /^mimg-[0-9a-f]{16}$/i.test(String(marker.mapImageId || "").trim());
}

export function effectiveMapImageId(marker: SlimMarker): string {
  return markerPaintsMapIcon(marker) ? String(marker.mapImageId || "").trim() : "";
}

function markerDrawTier(marker: SlimMarker): number {
  const origin = String(marker.origin || "").toLowerCase();
  if (origin === "feed" || origin === "air") return 0;
  return 1;
}

function markerRenderSort(marker: SlimMarker): number {
  const tier = markerDrawTier(marker);
  const callsign = String(marker.callsign || marker.uid || "");
  let h = 0;
  for (let i = 0; i < callsign.length; i++) h = (h * 31 + callsign.charCodeAt(i)) | 0;
  return tier * 1_000_000 + (h >>> 0) % 1_000_000;
}

function resolveColor(marker: SlimMarker): string {
  if (marker.color) return String(marker.color);
  const aff = String(marker.affiliation || "other").toLowerCase();
  return AFFILIATION_COLORS[aff] || AFFILIATION_COLORS.other;
}

/** Paint-only GeoJSON feature for the live marker source. */
export function buildPaintFeature(
  marker: SlimMarker,
  options: {
    selectedUid?: string | null;
    lockedUid?: string | null;
    showLabel?: number;
    overviewMode?: boolean;
    iconReady?: boolean;
  } = {}
): MarkerFeature | null {
  const lat = Number(marker.lat);
  const lon = Number(marker.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (!marker.uid) return null;

  const color = resolveColor(marker);
  // Slim markers carry mapImageId (mimg-*); never treat raw api iconId as a MapLibre image name.
  const mapImageId = effectiveMapImageId(marker);
  const apiIconId = mapImageId ? String(marker.iconId || "") : "";
  const usesIcon = !!mapImageId;
  const overview = !!options.overviewMode;
  const hasMapImage = !!mapImageId;
  const iconReady = !!options.iconReady && hasMapImage && !overview;
  // Keep iconId on the feature even before the bitmap is installed so styleimagemissing can fire.
  const showCircle = overview || !hasMapImage || !iconReady ? 1 : 0;
  const drawTier = marker.drawTier != null ? Number(marker.drawTier) : markerDrawTier(marker);
  const renderSort =
    marker.renderSort != null ? Number(marker.renderSort) : markerRenderSort(marker);
  const uid = String(marker.uid);
  const selected = uid === options.selectedUid;
  const locked = uid === options.lockedUid;
  const showLabel =
    options.showLabel != null
      ? options.showLabel
      : selected || locked
        ? 1
        : 1;
  const labelSort = computeLabelSortKey(marker, options.selectedUid, options.lockedUid);

  const properties: PaintFeatureProperties = {
    kind: "marker",
    uid,
    callsign: String(marker.callsign || uid.slice(0, 16)),
    type: String(marker.type || ""),
    affiliation: String(marker.affiliation || "other"),
    color,
    teamColor: marker.teamColor != null ? marker.teamColor : null,
    iconId: overview || !hasMapImage ? "" : mapImageId,
    apiIconId: apiIconId || "",
    iconSource: String(marker.iconSource || ""),
    origin: String(marker.origin || ""),
    usesMapIcon: usesIcon ? 1 : 0,
    showCircle,
    drawTier,
    selected,
    locked,
    renderSort,
    labelSort,
    showLabel,
    channelKeys: String(marker.channelKeys || ""),
    course:
      marker.course != null && Number.isFinite(Number(marker.course))
        ? Math.round(Number(marker.course))
        : null,
  };

  return {
    type: "Feature",
    id: vectorId(uid),
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties,
  };
}

export function featurePropertyPatch(
  marker: SlimMarker,
  options: {
    selectedUid?: string | null;
    lockedUid?: string | null;
    showLabel?: number;
    overviewMode?: boolean;
    iconReady?: boolean;
  }
): Array<{ key: string; value: unknown }> {
  const feat = buildPaintFeature(marker, options);
  if (!feat) return [];
  const p = feat.properties;
  return [
    { key: "callsign", value: p.callsign },
    { key: "type", value: p.type },
    { key: "affiliation", value: p.affiliation },
    { key: "color", value: p.color },
    { key: "teamColor", value: p.teamColor },
    { key: "iconId", value: p.iconId },
    { key: "apiIconId", value: p.apiIconId },
    { key: "iconSource", value: p.iconSource },
    { key: "origin", value: p.origin },
    { key: "usesMapIcon", value: p.usesMapIcon },
    { key: "showCircle", value: p.showCircle },
    { key: "drawTier", value: p.drawTier },
    { key: "selected", value: p.selected },
    { key: "locked", value: p.locked },
    { key: "renderSort", value: p.renderSort },
    { key: "labelSort", value: p.labelSort },
    { key: "showLabel", value: p.showLabel },
    { key: "channelKeys", value: p.channelKeys },
    { key: "course", value: p.course },
  ];
}

export function pointInBounds(
  lon: number,
  lat: number,
  bounds: { west: number; south: number; east: number; north: number } | null
): boolean {
  if (!bounds) return true;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  if (bounds.west <= bounds.east) {
    return lon >= bounds.west && lon <= bounds.east && lat >= bounds.south && lat <= bounds.north;
  }
  // antimeridian
  return (lon >= bounds.west || lon <= bounds.east) && lat >= bounds.south && lat <= bounds.north;
}
