interface DedicatedWorkerGlobalScope extends WorkerGlobalScope {
  postMessage(message: unknown): void;
  onmessage: ((ev: MessageEvent) => void) | null;
}

declare const self: DedicatedWorkerGlobalScope;
