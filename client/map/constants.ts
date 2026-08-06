export const SOURCE_ID = "tak-markers";
export const LIVE_SHAPES_SOURCE_ID = "tak-live-shapes";
export const LIVE_SHAPES_FILL_LAYER = "tak-live-shapes-fill";
export const LIVE_SHAPES_LINE_LAYER = "tak-live-shapes-line";
export const CIRCLE_LAYER_LOW = "tak-markers-circle-low";
export const ICON_LAYER_LOW = "tak-markers-icon-low";
export const CIRCLE_LAYER_HIGH = "tak-markers-circle-high";
export const ICON_LAYER_HIGH = "tak-markers-icon-high";
export const LABEL_LAYER = "tak-markers-label";
export const LABEL_PRIORITY_LAYER = "tak-markers-label-priority";

export const MARKER_HIT_LAYER_IDS = [
  CIRCLE_LAYER_LOW,
  ICON_LAYER_LOW,
  CIRCLE_LAYER_HIGH,
  ICON_LAYER_HIGH,
] as const;

export const MARKER_LAYER_IDS = [
  CIRCLE_LAYER_LOW,
  ICON_LAYER_LOW,
  CIRCLE_LAYER_HIGH,
  ICON_LAYER_HIGH,
  LABEL_LAYER,
  LABEL_PRIORITY_LAYER,
] as const;

export const LEGACY_MARKER_LAYER_IDS = [
  "tak-markers-circle",
  "tak-markers-icon",
  "tak-markers-course",
] as const;

export const MARKER_FILTER: unknown[] = ["==", ["get", "kind"], "marker"];
export const MAP_LABEL_FONT = ["Open Sans Semibold"];
export const STALE_GRACE_MS = 30000;
export const MAP_DIFF_FLUSH_MS = 400;
/** Extra viewport fringe so markers just off-screen are already painted while panning. */
export const VIEWPORT_PAD_RATIO = 0.55;
export const OVERVIEW_MODE_ZOOM = 5;
export const LABEL_MIN_ZOOM = 7;
/** Debounce for pushing map bounds to the CoT worker while the camera is moving. */
export const VIEW_PUSH_DEBOUNCE_MS = 80;
/** Faster worker flush when only the camera changed (keep CoT batch flush at MAP_DIFF_FLUSH_MS). */
export const VIEW_FLUSH_MS = 50;

export const AFFILIATION_COLORS: Record<string, string> = {
  friend: "#22c55e",
  hostile: "#ef4444",
  neutral: "#eab308",
  unknown: "#f97316",
  other: "#38bdf8",
};
