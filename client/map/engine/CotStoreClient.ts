import type {
  GeoJsonDiff,
  LiveShapeFeature,
  LonLatBounds,
  MarkerFeature,
  SlimMarker,
  WorkerInbound,
  WorkerOutbound,
} from "../types";

type Meta = { total: number; visible: number; mapped: number; revision: number };

export class CotStoreClient {
  private worker: Worker;
  private handlers: {
    onDiff: (diff: GeoJsonDiff, meta: Meta) => void;
    onResync: (features: MarkerFeature[], meta: Meta) => void;
    onShapes: (features: LiveShapeFeature[]) => void;
    onSearchIndex: (
      entries: Array<{ uid: string; callsign: string; lat: number; lon: number }>
    ) => void;
    onReady?: () => void;
  };
  private ready = false;
  private queue: WorkerInbound[] = [];
  /** Compact mirror for detail/go-to without holding GeoJSON clones. */
  readonly markersByUid = new Map<string, SlimMarker>();

  constructor(
    workerUrl: string,
    handlers: {
      onDiff: (diff: GeoJsonDiff, meta: Meta) => void;
      onResync: (features: MarkerFeature[], meta: Meta) => void;
      onShapes: (features: LiveShapeFeature[]) => void;
      onSearchIndex: (
        entries: Array<{ uid: string; callsign: string; lat: number; lon: number }>
      ) => void;
      onReady?: () => void;
    }
  ) {
    this.handlers = handlers;
    this.worker = new Worker(workerUrl);
    this.worker.onmessage = (ev: MessageEvent<WorkerOutbound>) => {
      const msg = ev.data;
      switch (msg.type) {
        case "ready":
          this.ready = true;
          for (const m of this.queue) this.worker.postMessage(m);
          this.queue = [];
          this.handlers.onReady?.();
          break;
        case "diff":
          this.handlers.onDiff(msg.diff, msg.meta);
          break;
        case "resync":
          this.handlers.onResync(msg.features, msg.meta);
          break;
        case "shapes":
          this.handlers.onShapes(msg.features);
          break;
        case "searchIndex":
          this.markersByUid.clear();
          for (const e of msg.entries) {
            const prev = this.markersByUid.get(e.uid);
            this.markersByUid.set(e.uid, {
              ...(prev || {}),
              uid: e.uid,
              callsign: e.callsign,
              lat: e.lat,
              lon: e.lon,
              type: prev?.type || "",
            });
          }
          this.handlers.onSearchIndex(msg.entries);
          break;
        default:
          break;
      }
    };
    this.worker.onerror = (err) => {
      console.error("[CotStoreClient] worker error", err);
    };
  }

  private send(msg: WorkerInbound): void {
    if (!this.ready) {
      this.queue.push(msg);
      return;
    }
    this.worker.postMessage(msg);
  }

  reset(markers: SlimMarker[], revision: number): void {
    this.markersByUid.clear();
    for (const m of markers) {
      if (m?.uid) this.markersByUid.set(String(m.uid), m);
    }
    this.send({ type: "reset", markers, revision });
  }

  batch(updates: SlimMarker[], removes: string[], revision?: number): void {
    for (const uid of removes) this.markersByUid.delete(String(uid));
    for (const m of updates) {
      if (m?.uid) this.markersByUid.set(String(m.uid), m);
    }
    this.send({ type: "batch", updates, removes, revision });
  }

  setView(
    bounds: LonLatBounds | null,
    zoom: number,
    overviewMode: boolean,
    recomputeLabels: boolean = true
  ): void {
    this.send({ type: "setView", bounds, zoom, overviewMode, recomputeLabels });
  }

  setChannels(
    mode: "all" | "none" | "keys",
    enabledKeys: string[] | null,
    scopeKeys: string[] | null
  ): void {
    this.send({ type: "setChannels", mode, enabledKeys, scopeKeys });
  }

  setSelection(selectedUid: string | null, lockedUid: string | null): void {
    this.send({ type: "setSelection", selectedUid, lockedUid });
  }

  forceResync(): void {
    this.send({ type: "forceResync" });
  }

  shapesSnapshot(features: LiveShapeFeature[]): void {
    this.send({ type: "shapesSnapshot", features });
  }

  shapesBatch(updates: LiveShapeFeature[], removes: string[]): void {
    this.send({ type: "shapesBatch", updates, removes });
  }

  iconReady(mapImageId: string, uids: string[]): void {
    this.send({ type: "iconReady", mapImageId, uids });
  }

  getMarker(uid: string): SlimMarker | null {
    return this.markersByUid.get(String(uid)) || null;
  }

  terminate(): void {
    this.worker.terminate();
  }
}
