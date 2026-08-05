import type { GeoJsonDiff, MarkerFeature } from "../types";
import { SOURCE_ID } from "../constants";

type GeoJsonSource = {
  setData: (data: GeoJSON.FeatureCollection) => void;
  updateData?: (diff: GeoJsonDiff) => void;
};

/** Apply a worker diff; setData only as explicit recovery. */
export function applyGeoJsonDiff(
  map: { getSource: (id: string) => unknown },
  diff: GeoJsonDiff,
  onFail?: () => void
): boolean {
  const src = map.getSource(SOURCE_ID) as GeoJsonSource | undefined;
  if (!src || typeof src.updateData !== "function") return false;
  try {
    src.updateData(diff);
    return true;
  } catch (err) {
    console.warn("[map] updateData failed", err);
    onFail?.();
    return false;
  }
}

export function setGeoJsonFeatures(
  map: { getSource: (id: string) => unknown },
  features: MarkerFeature[]
): boolean {
  const src = map.getSource(SOURCE_ID) as GeoJsonSource | undefined;
  if (!src || typeof src.setData !== "function") return false;
  src.setData({ type: "FeatureCollection", features });
  return true;
}
