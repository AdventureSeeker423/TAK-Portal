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
import { MAP_DIFF_FLUSH_MS } from "../constants";
import { buildPaintFeature, featurePropertyPatch, pointInBounds } from "../featureBuild";
import { computeLabelVisibility } from "../labelDeclutter";
import { vectorId } from "../uidHash";

const markers = new Map<string, SlimMarker>();
const sourceUids = new Set<string>();
const readyIcons = new Set<string>();
const liveShapes = new Map<string, LiveShapeFeature>();

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
let dirty = false;
let needFullResync = true;

function post(msg: WorkerOutbound): void {
  (self as DedicatedWorkerGlobalScope).postMessage(msg);
}

function channelKeyList(marker: SlimMarker): string[] {
  const raw = String(marker.channelKeys || "").trim();
  if (raw) {
    return raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  const groups = Array.isArray(marker.groups) ? marker.groups : [];
  return groups
    .map((g) =>
      String(g || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ")
    )
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
  if (!keys.length) return enabledKeys.has("__unassigned__") || enabledKeys.has("unassigned");
  return keys.some((k) => enabledKeys!.has(k));
}

function isPriority(uid: string): boolean {
  return uid === selectedUid || uid === lockedUid;
}

function shouldMap(marker: SlimMarker): boolean {
  if (!markerInChannelScope(marker) && !isPriority(String(marker.uid))) return false;
  if (isPriority(String(marker.uid))) return true;
  return pointInBounds(Number(marker.lon), Number(marker.lat), bounds);
}

function scheduleFlush(): void {
  dirty = true;
  if (flushTimer != null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, MAP_DIFF_FLUSH_MS);
}

function visibleMarkers(): SlimMarker[] {
  const out: SlimMarker[] = [];
  for (const m of markers.values()) {
    if (shouldMap(m)) out.push(m);
  }
  return out;
}

function buildFeature(marker: SlimMarker, showLabel: number): MarkerFeature | null {
  const mapImageId = String(marker.mapImageId || "");
  return buildPaintFeature(marker, {
    selectedUid,
    lockedUid,
    showLabel,
    overviewMode,
    iconReady: !mapImageId || readyIcons.has(mapImageId),
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
  const labelMap = computeLabelVisibility(visible, {
    zoom,
    selectedUid,
    lockedUid,
    bounds,
  });

  if (needFullResync) {
    needFullResync = false;
    const features: MarkerFeature[] = [];
    const next = new Set<string>();
    for (const m of visible) {
      const uid = String(m.uid);
      const feat = buildFeature(m, labelMap.get(uid) ?? 0);
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
    const feat = buildFeature(m, labelMap.get(uid) ?? 0);
    if (!feat) continue;
    want.set(uid, feat);
    nextUids.add(uid);
  }

  const diff: GeoJsonDiff = { add: [], update: [], remove: [] };

  for (const uid of sourceUids) {
    if (!nextUids.has(uid)) {
      diff.remove.push(vectorId(uid));
    }
  }

  for (const [uid, feat] of want) {
    if (!sourceUids.has(uid)) {
      diff.add.push(feat);
      continue;
    }
    const marker = markers.get(uid);
    if (!marker) continue;
    diff.update.push({
      id: feat.id,
      newGeometry: feat.geometry,
      addOrUpdateProperties: featurePropertyPatch(marker, {
        selectedUid,
        lockedUid,
        showLabel: labelMap.get(uid) ?? 0,
        overviewMode,
        iconReady:
          !String(marker.mapImageId || "") ||
          readyIcons.has(String(marker.mapImageId || "")),
      }),
    });
  }

  sourceUids.clear();
  for (const uid of nextUids) sourceUids.add(uid);

  if (diff.add.length || diff.update.length || diff.remove.length) {
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
  } else {
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
}

function emitShapes(): void {
  post({ type: "shapes", features: Array.from(liveShapes.values()) });
}

function upsertMarker(marker: SlimMarker): void {
  if (!marker?.uid) return;
  markers.set(String(marker.uid), marker);
}

function handle(msg: WorkerInbound): void {
  switch (msg.type) {
    case "reset": {
      markers.clear();
      sourceUids.clear();
      for (const m of msg.markers || []) upsertMarker(m);
      revision = Number(msg.revision) || revision;
      needFullResync = true;
      emitSearchIndex();
      scheduleFlush();
      break;
    }
    case "batch": {
      for (const uid of msg.removes || []) {
        markers.delete(String(uid));
      }
      for (const m of msg.updates || []) upsertMarker(m);
      if (msg.revision != null) revision = Number(msg.revision) || revision;
      emitSearchIndex();
      scheduleFlush();
      break;
    }
    case "setView": {
      bounds = msg.bounds;
      zoom = Number(msg.zoom) || zoom;
      overviewMode = !!msg.overviewMode;
      scheduleFlush();
      break;
    }
    case "setChannels": {
      channelMode = msg.mode;
      enabledKeys =
        msg.enabledKeys == null ? null : new Set(msg.enabledKeys.map((k) => String(k).toLowerCase()));
      scopeKeys =
        msg.scopeKeys == null ? null : new Set(msg.scopeKeys.map((k) => String(k).toLowerCase()));
      scheduleFlush();
      break;
    }
    case "setSelection": {
      selectedUid = msg.selectedUid ? String(msg.selectedUid) : null;
      lockedUid = msg.lockedUid ? String(msg.lockedUid) : null;
      scheduleFlush();
      break;
    }
    case "forceResync": {
      needFullResync = true;
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

post({ type: "ready" });
