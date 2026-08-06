/** Shared map client types (main thread + worker). */

export type LonLatBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export type SlimMarker = {
  uid: string;
  callsign: string;
  type: string;
  lat: number;
  lon: number;
  groups?: string[] | null;
  affiliation?: string | null;
  teamColor?: string | number | null;
  color?: string | null;
  stale?: string | null;
  course?: number | null;
  hae?: number | null;
  speed?: number | null;
  time?: string | null;
  start?: string | null;
  how?: string | null;
  origin?: string | null;
  team?: string | null;
  role?: string | null;
  platform?: string | null;
  battery?: string | number | null;
  updatedAt?: string | null;
  iconId?: string | null;
  iconSource?: string | null;
  mapImageId?: string;
  usesMapIcon?: number;
  channelKeys?: string;
  showCircle?: number;
  remarks?: string | null;
  links?: unknown[] | null;
  drawTier?: number;
  renderSort?: number;
};

export type PaintFeatureProperties = {
  kind: "marker";
  uid: string;
  callsign: string;
  type: string;
  affiliation: string;
  color: string;
  teamColor: string | number | null;
  iconId: string;
  apiIconId: string;
  iconSource: string;
  origin: string;
  usesMapIcon: number;
  showCircle: number;
  drawTier: number;
  selected: boolean;
  locked: boolean;
  renderSort: number;
  labelSort: number;
  showLabel: number;
  channelKeys: string;
  course: number | null;
};

export type MarkerFeature = {
  type: "Feature";
  id: number;
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: PaintFeatureProperties;
};

export type GeoJsonDiff = {
  add: MarkerFeature[];
  update: Array<{
    id: number;
    newGeometry?: { type: "Point"; coordinates: [number, number] };
    addOrUpdateProperties?: Array<{ key: string; value: unknown }>;
  }>;
  remove: number[];
};

export type LiveShapeFeature = GeoJSON.Feature & {
  id?: string | number;
  properties?: Record<string, unknown> | null;
};

/** Main → Worker */
export type WorkerInbound =
  | { type: "reset"; markers: SlimMarker[]; revision: number }
  | { type: "batch"; updates: SlimMarker[]; removes: string[]; revision?: number }
  | {
      type: "setView";
      bounds: LonLatBounds | null;
      zoom: number;
      overviewMode: boolean;
      /** When false, expand/cull painted markers without reshuffling showLabel. */
      recomputeLabels?: boolean;
    }
  | {
      type: "setChannels";
      enabledKeys: string[] | null;
      scopeKeys: string[] | null;
      mode: "all" | "none" | "keys";
    }
  | { type: "setSelection"; selectedUid: string | null; lockedUid: string | null }
  | { type: "forceResync" }
  | { type: "shapesSnapshot"; features: LiveShapeFeature[] }
  | {
      type: "shapesBatch";
      updates: LiveShapeFeature[];
      removes: string[];
    }
  | { type: "iconReady"; mapImageId: string; uids: string[] };

/** Worker → Main */
export type WorkerOutbound =
  | {
      type: "diff";
      diff: GeoJsonDiff;
      meta: { total: number; visible: number; mapped: number; revision: number };
    }
  | {
      type: "resync";
      features: MarkerFeature[];
      meta: { total: number; visible: number; mapped: number; revision: number };
    }
  | {
      type: "shapes";
      features: LiveShapeFeature[];
    }
  | {
      type: "searchIndex";
      entries: Array<{ uid: string; callsign: string; lat: number; lon: number }>;
    }
  | { type: "ready" };
