import type { LonLatBounds, SlimMarker } from "./types";

type LabelBox = { x: number; y: number; w: number; h: number };

function projectMercator(lon: number, lat: number): { x: number; y: number } {
  const x = (lon + 180) / 360;
  const sin = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
  return { x, y };
}

function estimateLabelBox(
  lon: number,
  lat: number,
  callsign: string,
  zoom: number,
  density: number
): LabelBox {
  const p = projectMercator(lon, lat);
  const scale = Math.pow(2, Math.max(0, zoom));
  const px = 1 / (256 * scale);
  const label = String(callsign || "");
  // Slight under-estimate so nearby short callsigns can both keep labels.
  const w = Math.max(20, label.length * 5.2) * density * px;
  const h = 11 * density * px;
  return { x: p.x - w / 2, y: p.y - h * 2.1, w, h };
}

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function isSpiLike(m: SlimMarker): boolean {
  const origin = String(m.origin || "").toLowerCase();
  if (origin === "spi") return true;
  const type = String(m.type || "")
    .trim()
    .toLowerCase();
  return type.startsWith("b-m-p-s-p-i") || type.startsWith("b-m-p-s-p-loc");
}

function priority(
  m: SlimMarker,
  selectedUid: string | null,
  lockedUid: string | null
): number {
  if (m.uid === selectedUid || m.uid === lockedUid) return 0;
  if (isSpiLike(m)) return 1;
  const origin = String(m.origin || "").toLowerCase();
  if (origin === "eud" || origin === "user" || origin === "federation" || origin === "feed") {
    return 2;
  }
  if (origin === "air") return 3;
  return 4;
}

function densityForZoom(zoom: number): number {
  // Tighter packing (more labels) as you zoom in.
  if (zoom >= 15) return 0.4;
  if (zoom >= 13) return 0.55;
  if (zoom >= 11) return 0.7;
  if (zoom >= 9) return 0.9;
  return 1.15;
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
 * Declutter for CoT callsign labels.
 * Intended to run on viewport/selection changes — not on every CoT move —
 * so labels stay sticky until the camera settles.
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

  if (!Number.isFinite(zoom) || zoom < 7) {
    for (const m of candidates) {
      const uid = String(m.uid);
      out.set(uid, uid === selectedUid || uid === lockedUid ? 1 : 0);
    }
    return out;
  }

  // City / neighborhood: show everything — allow-overlap keeps labels sticky.
  if (zoom >= 11) {
    for (const m of candidates) out.set(String(m.uid), 1);
    return out;
  }

  const density = densityForZoom(zoom);
  const sorted = candidates.slice().sort((a, b) => {
    const pa = priority(a, selectedUid, lockedUid);
    const pb = priority(b, selectedUid, lockedUid);
    if (pa !== pb) return pa - pb;
    const la = String(a.callsign || "").length;
    const lb = String(b.callsign || "").length;
    if (la !== lb) return la - lb;
    return String(a.callsign || "").localeCompare(String(b.callsign || ""));
  });

  const placed: LabelBox[] = [];
  for (const m of sorted) {
    const uid = String(m.uid);
    const forced = uid === selectedUid || uid === lockedUid || isSpiLike(m);
    const box = estimateLabelBox(m.lon, m.lat, m.callsign, zoom, density);
    if (forced) {
      out.set(uid, 1);
      placed.push(box);
      continue;
    }
    let hit = false;
    for (let j = 0; j < placed.length; j++) {
      if (overlaps(box, placed[j])) {
        hit = true;
        break;
      }
    }
    if (hit) out.set(uid, 0);
    else {
      out.set(uid, 1);
      placed.push(box);
    }
  }
  return out;
}

/** Ascending sort key — lower values draw on top. */
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
