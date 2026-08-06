import type { LonLatBounds, SlimMarker } from "./types";

function isSpiLike(m: SlimMarker): boolean {
  const origin = String(m.origin || "").toLowerCase();
  if (origin === "spi") return true;
  const type = String(m.type || "")
    .trim()
    .toLowerCase();
  return type.startsWith("b-m-p-s-p-i") || type.startsWith("b-m-p-s-p-loc");
}

function inBounds(m: SlimMarker, bounds?: LonLatBounds | null): boolean {
  if (!bounds) return true;
  const lon = Number(m.lon);
  const lat = Number(m.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  if (bounds.west <= bounds.east) {
    return lon >= bounds.west && lon <= bounds.east && lat >= bounds.south && lat <= bounds.north;
  }
  return (lon >= bounds.west || lon <= bounds.east) && lat >= bounds.south && lat <= bounds.north;
}

/**
 * Label visibility for paint features.
 *
 * At usable zooms we mark nearly all in-view markers as showLabel=1 and let
 * MapLibre's symbol collision (real glyph metrics) hide the rest. Custom
 * mercator box estimates were too coarse and looked random in dense AVL.
 */
export function computeLabelVisibility(
  visible: SlimMarker[],
  options: {
    zoom: number;
    selectedUid?: string | null;
    lockedUid?: string | null;
    bounds?: LonLatBounds | null;
  }
): Map<string, number> {
  const out = new Map<string, number>();
  const selectedUid = options.selectedUid || null;
  const lockedUid = options.lockedUid || null;
  const zoom = Number(options.zoom);

  const candidates = (Array.isArray(visible) ? visible : []).filter((m) =>
    inBounds(m, options.bounds)
  );

  // County / overview: only selected/locked keep labels.
  if (!Number.isFinite(zoom) || zoom < 7) {
    for (const m of candidates) {
      const uid = String(m.uid);
      out.set(uid, uid === selectedUid || uid === lockedUid ? 1 : 0);
    }
    return out;
  }

  for (const m of candidates) {
    out.set(String(m.uid), 1);
  }

  // Ensure SPI / selection always request a label (priority layer + sort key).
  for (const m of candidates) {
    const uid = String(m.uid);
    if (uid === selectedUid || uid === lockedUid || isSpiLike(m)) {
      out.set(uid, 1);
    }
  }

  return out;
}

/** Ascending sort key — lower values win MapLibre collision / draw on top. */
export function computeLabelSortKey(
  marker: SlimMarker,
  selectedUid?: string | null,
  lockedUid?: string | null
): number {
  const uid = String(marker.uid || "");
  if (uid && uid === selectedUid) return 0;
  if (uid && uid === lockedUid) return 1;
  if (isSpiLike(marker)) return 2;
  const origin = String(marker.origin || "").toLowerCase();
  if (origin === "eud" || origin === "user" || origin === "federation") return 3;
  if (origin === "feed") return 4;
  if (origin === "air") return 5;
  return 6;
}
