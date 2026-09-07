/**
 * Atlas-style CoT entity store (CloudTAK-inspired).
 * Owns all live markers; emits batched GeoJSONSourceDiff to the main thread.
 */
import type {
  GeoJsonDiff,
  LiveShapeFeature,
  LonLatBounds,
  MarkerFeature,
  SlimMarker,
  WorkerInbound,
  WorkerOutbound,
} from "../types";
import { MAP_DIFF_FLUSH_MS, STALE_SWEEP_MS, VIEW_FLUSH_MS } from "../constants";
import {
  buildPaintFeature,
  effectiveMapImageId,
  featurePropertyPatch,
  isMarkerExpired,
  isMarkerStale,
  isSpecialChannelKey,
  aliasSpecialChannelKeys,
  paintChannelKeys,
  pointInBounds,
} from "../featureBuild";
import { computeLabelVisibility } from "../labelDeclutter";
import { vectorId } from "../uidHash";

const markers = new Map<string, SlimMarker>();
const sourceUids = new Set<string>();
const readyIcons = new Set<string>();
const liveShapes = new Map<string, LiveShapeFeature>();
/** Sticky label flags — recomputed on camera/selection, not every CoT move. */
const showLabelByUid = new Map<string, number>();
/** Last painted stale flag so we only flush when a CoT crosses stale/expiry. */
const staleFlagByUid = new Map<string, number>();

let revision = 0;
let bounds: LonLatBounds | null = null;
let zoom = 10;
let overviewMode = false;
let selectedUid: string | null = null;
let lockedUid: string | null = null;
let channelMode: "all" | "none" | "keys" = "all";
let enabledKeys: Set<string> | null = null;
let scopeKeys: Set<string> | null = null;

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushDelayMs = MAP_DIFF_FLUSH_MS;
let dirty = false;
let needFullResync = true;
let labelsNeedRecompute = true;

function post(msg: WorkerOutbound): void {
  (self as DedicatedWorkerGlobalScope).postMessage(msg);
}

function channelKeyList(marker: SlimMarker): string[] {
  const raw = paintChannelKeys(marker);
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function markerInChannelScope(marker: SlimMarker): boolean {
  const keys = channelKeyList(marker);
  if (scopeKeys && scopeKeys.size) {
    if (!keys.some((k) => scopeKeys!.has(k))) return false;
  }
  if (channelMode === "all") return true;
  if (channelMode === "none") return false;
  if (!enabledKeys) return true;
  if (!enabledKeys.size) return false;
  const specialEnabled =
    enabledKeys.has("__unassigned__") ||
    enabledKeys.has("unassigned") ||
    enabledKeys.has("__stale__") ||
    enabledKeys.has("stale");
  if (!keys.length) return specialEnabled;
  if (keys.some((k) => enabledKeys!.has(k))) return true;
  return specialEnabled && keys.every(isSpecialChannelKey);
}

function isPriority(uid: string): boolean {
  return uid === selectedUid || uid === lockedUid;
}

function shouldMap(marker: SlimMarker): boolean {
  if (!markerInChannelScope(marker) && !isPriority(String(marker.uid))) return false;
  if (isPriority(String(marker.uid))) return true;
  return pointInBounds(Number(marker.lon), Number(marker.lat), bounds);
}

function scheduleFlush(delayMs: number = MAP_DIFF_FLUSH_MS): void {
  dirty = true;
  if (flushTimer != null) {
    // Promote to a sooner flush if a view update needs it.
    if (delayMs < flushDelayMs) {
      clearTimeout(flushTimer);
      flushTimer = null;
      flushDelayMs = delayMs;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushDelayMs = MAP_DIFF_FLUSH_MS;
        flush();
      }, delayMs);
    }
    return;
  }
  flushDelayMs = delayMs;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushDelayMs = MAP_DIFF_FLUSH_MS;
    flush();
  }, delayMs);
}

function visibleMarkers(): SlimMarker[] {
  const out: SlimMarker[] = [];
  for (const m of markers.values()) {
    if (shouldMap(m)) out.push(m);
  }
  return out;
}

function resolveShowLabel(uid: string, labelMap: Map<string, number> | null): number {
  if (uid === selectedUid || uid === lockedUid) {
    showLabelByUid.set(uid, 1);
    return 1;
  }
  if (labelMap) {
    const v = labelMap.get(uid) ?? 0;
    showLabelByUid.set(uid, v);
    return v;
  }
  if (showLabelByUid.has(uid)) return showLabelByUid.get(uid) as number;
  // New marker entering the padded viewport mid-stream: show until next camera pass.
  const fallback = zoom >= 7 ? 1 : 0;
  showLabelByUid.set(uid, fallback);
  return fallback;
}

function buildFeature(marker: SlimMarker, showLabel: number): MarkerFeature | null {
  const mapImageId = effectiveMapImageId(marker);
  const hasMapImage = !!mapImageId;
  return buildPaintFeature(marker, {
    selectedUid,
    lockedUid,
    showLabel,
    overviewMode,
    iconReady: !hasMapImage || readyIcons.has(mapImageId),
  });
}

function emitSearchIndex(): void {
  const entries: Array<{ uid: string; callsign: string; lat: number; lon: number }> = [];
  for (const m of markers.values()) {
    entries.push({
      uid: String(m.uid),
      callsign: String(m.callsign || ""),
      lat: Number(m.lat),
      lon: Number(m.lon),
    });
  }
  post({ type: "searchIndex", entries });
}

function flush(): void {
  if (!dirty && !needFullResync) return;
  dirty = false;

  const visible = visibleMarkers();
  let labelMap: Map<string, number> | null = null;
  if (labelsNeedRecompute || needFullResync) {
    labelMap = computeLabelVisibility(visible, {
      zoom,
      selectedUid,
      lockedUid,
      bounds,
    });
    labelsNeedRecompute = false;
  }

  if (needFullResync) {
    needFullResync = false;
    const features: MarkerFeature[] = [];
    const next = new Set<string>();
    showLabelByUid.clear();
    for (const m of visible) {
      const uid = String(m.uid);
      const showLabel = resolveShowLabel(uid, labelMap);
      const feat = buildFeature(m, showLabel);
      if (!feat) continue;
      features.push(feat);
      next.add(uid);
    }
    sourceUids.clear();
    for (const uid of next) sourceUids.add(uid);
    post({
      type: "resync",
      features,
      meta: {
        total: markers.size,
        visible: visible.length,
        mapped: features.length,
        revision,
      },
    });
    emitShapes();
    return;
  }

  const nextUids = new Set<string>();
  const want = new Map<string, MarkerFeature>();
  for (const m of visible) {
    const uid = String(m.uid);
    const showLabel = resolveShowLabel(uid, labelMap);
    const feat = buildFeature(m, showLabel);
    if (!feat) continue;
    want.set(uid, feat);
    nextUids.add(uid);
  }

  const diff: GeoJsonDiff = { add: [], update: [], remove: [] };

  for (const uid of sourceUids) {
    if (!nextUids.has(uid)) {
      diff.remove.push(vectorId(uid));
      showLabelByUid.delete(uid);
    }
  }

  for (const [uid, feat] of want) {
    if (!sourceUids.has(uid)) {
      diff.add.push(feat);
      continue;
    }
    const marker = markers.get(uid);
    if (!marker) continue;
    const showLabel = resolveShowLabel(uid, labelMap);
    const paintId = effectiveMapImageId(marker);
    // Geometry always; full property patch only when labels were recomputed or icon state may change.
    if (labelMap) {
      diff.update.push({
        id: feat.id,
        newGeometry: feat.geometry,
        addOrUpdateProperties: featurePropertyPatch(marker, {
          selectedUid,
          lockedUid,
          showLabel,
          overviewMode,
          iconReady: !paintId || readyIcons.has(paintId),
        }),
      });
    } else {
      diff.update.push({
        id: feat.id,
        newGeometry: feat.geometry,
        addOrUpdateProperties: [
          { key: "callsign", value: String(marker.callsign || uid.slice(0, 16)) },
          { key: "color", value: feat.properties.color },
          { key: "iconId", value: feat.properties.iconId },
          { key: "showCircle", value: feat.properties.showCircle },
          { key: "showLabel", value: showLabel },
          { key: "selected", value: uid === selectedUid },
          { key: "locked", value: uid === lockedUid },
          { key: "stale", value: feat.properties.stale },
        ],
      });
    }
  }

  sourceUids.clear();
  for (const uid of nextUids) sourceUids.add(uid);

  post({
    type: "diff",
    diff,
    meta: {
      total: markers.size,
      visible: visible.length,
      mapped: nextUids.size,
      revision,
    },
  });
}

function emitShapes(): void {
  post({ type: "shapes", features: Array.from(liveShapes.values()) });
}

function dropMarker(uid: string): void {
  const id = String(uid || "");
  if (!id) return;
  markers.delete(id);
  showLabelByUid.delete(id);
  staleFlagByUid.delete(id);
}

function upsertMarker(marker: SlimMarker): void {
  if (!marker?.uid) return;
  const uid = String(marker.uid);
  const now = Date.now();
  if (isMarkerExpired(marker, now)) {
    dropMarker(uid);
    return;
  }
  markers.set(uid, marker);
  staleFlagByUid.set(uid, isMarkerStale(marker, now) ? 1 : 0);
}

function shapeStaleValue(feature: LiveShapeFeature): string | null {
  const props = feature?.properties as { stale?: string | null } | null | undefined;
  return props?.stale != null ? String(props.stale) : null;
}

function sweepStale(): void {
  const now = Date.now();
  let markersChanged = false;
  let shapesChanged = false;
  for (const [uid, marker] of markers) {
    if (isMarkerExpired(marker, now)) {
      dropMarker(uid);
      markersChanged = true;
      continue;
    }
    const flag = isMarkerStale(marker, now) ? 1 : 0;
    if (staleFlagByUid.get(uid) !== flag) {
      staleFlagByUid.set(uid, flag);
      markersChanged = true;
    }
  }
  for (const [uid, feat] of liveShapes) {
    if (isMarkerExpired({ stale: shapeStaleValue(feat) }, now)) {
      liveShapes.delete(uid);
      shapesChanged = true;
    }
  }
  if (markersChanged) {
    emitSearchIndex();
    scheduleFlush();
  }
  if (shapesChanged) emitShapes();
}

function handle(msg: WorkerInbound): void {
  switch (msg.type) {
    case "reset": {
      markers.clear();
      sourceUids.clear();
      showLabelByUid.clear();
      staleFlagByUid.clear();
      for (const m of msg.markers || []) upsertMarker(m);
      revision = Number(msg.revision) || revision;
      needFullResync = true;
      labelsNeedRecompute = true;
      emitSearchIndex();
      scheduleFlush();
      break;
    }
    case "batch": {
      for (const uid of msg.removes || []) {
        dropMarker(String(uid));
      }
      for (const m of msg.updates || []) upsertMarker(m);
      if (msg.revision != null) revision = Number(msg.revision) || revision;
      emitSearchIndex();
      scheduleFlush();
      break;
    }
    case "setView": {
      const nextZoom = Number(msg.zoom) || zoom;
      bounds = msg.bounds;
      zoom = nextZoom;
      overviewMode = !!msg.overviewMode;
      // Live pan: paint the padded fringe without reshuffling labels.
      // Settled camera / explicit true: recompute which callsigns stay visible.
      if (msg.recomputeLabels !== false) {
        labelsNeedRecompute = true;
      }
      scheduleFlush(VIEW_FLUSH_MS);
      break;
    }
    case "setChannels": {
      channelMode = msg.mode;
      enabledKeys =
        msg.enabledKeys == null ? null : aliasSpecialChannelKeys(msg.enabledKeys);
      scopeKeys = msg.scopeKeys == null ? null : aliasSpecialChannelKeys(msg.scopeKeys);
      labelsNeedRecompute = true;
      scheduleFlush();
      break;
    }
    case "setSelection": {
      selectedUid = msg.selectedUid ? String(msg.selectedUid) : null;
      lockedUid = msg.lockedUid ? String(msg.lockedUid) : null;
      labelsNeedRecompute = true;
      scheduleFlush(VIEW_FLUSH_MS);
      break;
    }
    case "forceResync": {
      needFullResync = true;
      labelsNeedRecompute = true;
      scheduleFlush();
      break;
    }
    case "shapesSnapshot": {
      liveShapes.clear();
      for (const f of msg.features || []) {
        const uid = String(f?.properties?.uid || f?.id || "");
        if (uid) liveShapes.set(uid, f);
      }
      emitShapes();
      break;
    }
    case "shapesBatch": {
      for (const uid of msg.removes || []) liveShapes.delete(String(uid));
      for (const f of msg.updates || []) {
        const uid = String(f?.properties?.uid || f?.id || "");
        if (uid) liveShapes.set(uid, f);
      }
      emitShapes();
      break;
    }
    case "iconReady": {
      const id = String(msg.mapImageId || "");
      if (id) readyIcons.add(id);
      scheduleFlush();
      break;
    }
    default:
      break;
  }
}

self.onmessage = (ev: MessageEvent<WorkerInbound>) => {
  try {
    handle(ev.data);
  } catch (err) {
    console.error("[cotStore.worker]", err);
  }
};

setInterval(sweepStale, STALE_SWEEP_MS);

post({ type: "ready" });
