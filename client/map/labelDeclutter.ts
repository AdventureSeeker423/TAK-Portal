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
  zoom: number
): LabelBox {
  const p = projectMercator(lon, lat);
  const scale = Math.pow(2, Math.max(0, zoom));
  const charW = 6.2 / (256 * scale);
  const h = 14 / (256 * scale);
  const w = Math.max(24, String(callsign || "").length * 7.2) / (256 * scale);
  return { x: p.x - charW, y: p.y - h, w, h };
}

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function priority(
  m: SlimMarker,
  selectedUid: string | null,
  lockedUid: string | null
): number {
  if (m.uid === selectedUid || m.uid === lockedUid) return 0;
  const origin = String(m.origin || "").toLowerCase();
  if (origin === "eud" || origin === "user") return 1;
  if (origin === "feed") return 3;
  return 2;
}

/**
 * Grid-style label declutter (ported from server/client map logic).
 * Returns uid → 0|1 showLabel map for markers currently considered visible.
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
  if (!Number.isFinite(zoom) || zoom < 7) {
    for (const m of visible) {
      const uid = String(m.uid);
      out.set(uid, uid === selectedUid || uid === lockedUid ? 1 : 0);
    }
    return out;
  }

  const sorted = visible.slice().sort((a, b) => {
    const pa = priority(a, selectedUid, lockedUid);
    const pb = priority(b, selectedUid, lockedUid);
    if (pa !== pb) return pa - pb;
    return String(a.callsign).localeCompare(String(b.callsign));
  });

  const placed: LabelBox[] = [];
  for (const m of sorted) {
    const uid = String(m.uid);
    if (uid === selectedUid || uid === lockedUid) {
      out.set(uid, 1);
      placed.push(estimateLabelBox(m.lon, m.lat, m.callsign, zoom));
      continue;
    }
    const box = estimateLabelBox(m.lon, m.lat, m.callsign, zoom);
    let hit = false;
    for (let j = 0; j < placed.length; j++) {
      if (overlaps(box, placed[j])) {
        hit = true;
        break;
      }
    }
    if (hit) {
      out.set(uid, 0);
    } else {
      out.set(uid, 1);
      placed.push(box);
    }
  }
  return out;
}
