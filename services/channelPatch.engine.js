/**
 * Channel patch engine — mesh CoT rebroadcast across selected channels (both ways).
 */
const cotStream = require("./cotStream.service");
const mapMeta = require("./mapMeta.service");
const mapRender = require("./mapRender.service");
const groupsSvc = require("./groups.service");
const store = require("./channelPatch.store");

const PATCH_TAG = "__takportal_patch";
const RUNTIME_FLUSH_MS = 5000;
const MAX_DESTS_PER_EVENT = 32;

let started = false;
let unsubscribe = null;
/** @type {Promise<typeof import("@tak-ps/node-cot")>|null} */
let nodeCotPromise = null;

/** In-memory runtime hints keyed by patch id (flushed periodically). */
const runtimeByPatch = new Map();
let runtimeFlushTimer = null;

function loadNodeCot() {
  if (!nodeCotPromise) nodeCotPromise = import("@tak-ps/node-cot");
  return nodeCotPromise;
}

function safeStr(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function groupKey(name) {
  return mapMeta.channelBaseKey(name);
}

/**
 * Portal catalog uses Authentik names (tak_…). Marti dest / filtergroup use the CN.
 */
function toMartiGroupName(catalogOrAny) {
  return groupsSvc.stripTakPrefix(safeStr(catalogOrAny).trim());
}

function isPortalPatchedCot(cot) {
  const detail = cot?.raw?.event?.detail || cot?.detail?.() || {};
  if (detail && detail[PATCH_TAG]) return true;
  // Also honor string attribute bag forms
  if (detail && detail[PATCH_TAG]?._attributes) return true;
  return false;
}

/**
 * Destinations for a source channel within one patch (full mesh, both ways).
 * @returns {string[]} destination group names (catalog names)
 */
function destinationsForSource(patch, sourceKey) {
  if (!sourceKey) return [];
  const groups = Array.isArray(patch?.groups) ? patch.groups : [];
  if (groups.length < 2) return [];

  const memberKeys = new Set(
    groups.map((g) => groupKey(g)).filter(Boolean)
  );
  if (!memberKeys.has(sourceKey)) return [];

  const dests = [];
  const seen = new Set();
  for (const groupName of groups) {
    const g = safeStr(groupName).trim();
    if (!g) continue;
    const k = groupKey(g);
    if (!k || k === sourceKey) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    dests.push(g);
  }
  return dests;
}

function queueRuntime(patchId, fields) {
  const id = safeStr(patchId).trim();
  if (!id) return;
  const prev = runtimeByPatch.get(id) || {};
  runtimeByPatch.set(id, { ...prev, ...fields, dirty: true });
  if (!runtimeFlushTimer) {
    runtimeFlushTimer = setTimeout(flushRuntime, RUNTIME_FLUSH_MS);
    if (typeof runtimeFlushTimer.unref === "function") runtimeFlushTimer.unref();
  }
}

function flushRuntime() {
  runtimeFlushTimer = null;
  for (const [id, row] of runtimeByPatch) {
    if (!row?.dirty) continue;
    try {
      store.touchRuntime(id, {
        lastForwardAt: row.lastForwardAt ?? undefined,
        lastError: row.lastError ?? undefined,
      });
      runtimeByPatch.set(id, { ...row, dirty: false });
    } catch (_) {}
  }
}

function clearExistingDests(detail) {
  if (!detail.marti) detail.marti = {};
  detail.marti.dest = [];
}

function stampPatchTag(detail, meta) {
  detail[PATCH_TAG] = {
    _attributes: {
      patchId: safeStr(meta.patchId),
      from: safeStr(meta.fromGroup),
      to: safeStr(meta.toGroup),
    },
  };
}

function setFilterGroup(detail, groupName) {
  const g = safeStr(groupName).trim();
  if (!g) return;
  detail.filtergroup = { _attributes: { group: g } };
}

/**
 * Build a CoT clone targeted at one destination group.
 * @param {string} destGroup catalog / Authentik name (may include tak_)
 */
async function buildTargetedCot(sourceCot, destGroup, meta) {
  const mod = await loadNodeCot();
  const CoT = mod.default || mod.CoT;
  if (!CoT) throw new Error("node-cot CoT constructor unavailable");

  const raw = JSON.parse(JSON.stringify(sourceCot.raw));
  if (!raw?.event) throw new Error("Invalid CoT raw");

  const clone = new CoT(raw);
  const detail = clone.detail();
  clearExistingDests(detail);
  // Marti routes by CN (no tak_ prefix). Catalog stores Authentik tak_* names.
  const martiGroup = toMartiGroupName(destGroup);
  if (!martiGroup) throw new Error("Empty Marti dest group");
  clone.addDest({ group: martiGroup });
  setFilterGroup(detail, martiGroup);
  stampPatchTag(detail, { ...meta, toGroup: destGroup });

  return clone;
}

async function forwardCot({ marker, cot }) {
  if (!cot || isPortalPatchedCot(cot)) return;
  if (!cotStream.isBridgeConnected()) return;

  const patches = store.listEnabled();
  if (!patches.length) return;

  const sourceKeys = mapRender.markerChannelKeys(marker).filter(
    (k) => k && k !== mapMeta.UNASSIGNED_CHANNEL_KEY
  );
  if (!sourceKeys.length) return;

  /** @type {Map<string, { dest: string, patchId: string, fromGroup: string }>} */
  const destJobs = new Map();

  for (const patch of patches) {
    for (const sourceKey of sourceKeys) {
      const dests = destinationsForSource(patch, sourceKey);
      for (const dest of dests) {
        const destKey = groupKey(dest);
        if (!destKey || destJobs.has(destKey)) continue;
        destJobs.set(destKey, {
          dest,
          patchId: patch.id,
          fromGroup: sourceKey,
        });
      }
    }
  }

  if (!destJobs.size) return;

  const jobs = Array.from(destJobs.values()).slice(0, MAX_DESTS_PER_EVENT);
  try {
    const cots = [];
    const patchIdsTouched = new Set();
    for (const job of jobs) {
      try {
        const targeted = await buildTargetedCot(cot, job.dest, {
          patchId: job.patchId,
          fromGroup: job.fromGroup,
        });
        cots.push(targeted);
        patchIdsTouched.add(job.patchId);
      } catch (err) {
        queueRuntime(job.patchId, {
          lastError: err?.message || String(err),
        });
      }
    }

    if (!cots.length) return;

    const ok = await cotStream.writeCot(cots, { stripFlow: true });
    const now = new Date().toISOString();
    for (const id of patchIdsTouched) {
      if (ok) {
        queueRuntime(id, { lastForwardAt: now, lastError: null });
      } else {
        queueRuntime(id, {
          lastError: "TAK stream not connected; write skipped",
        });
      }
    }
  } catch (err) {
    console.error("[channel-patch] forward failed:", err?.message || err);
  }
}

function onCot({ marker, cot }) {
  void forwardCot({ marker, cot });
}

/**
 * For map attribution: given a marker's current channel groups, return catalog
 * destinations that enabled patches would fan out to.
 */
function augmentDestGroupsForSourceGroups(sourceGroups) {
  const patches = store.listEnabled();
  if (!patches.length) return [];
  const sourceKeys = (Array.isArray(sourceGroups) ? sourceGroups : [])
    .map((g) => groupKey(g))
    .filter((k) => k && k !== mapMeta.UNASSIGNED_CHANNEL_KEY);
  if (!sourceKeys.length) return [];

  const dests = [];
  const seen = new Set();
  for (const patch of patches) {
    for (const sourceKey of sourceKeys) {
      for (const dest of destinationsForSource(patch, sourceKey)) {
        const channel = mapMeta.toChannelGroupName(dest) || safeStr(dest).trim();
        const k = groupKey(channel);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        dests.push(channel);
      }
    }
  }
  return dests;
}

function start() {
  if (started) return;
  started = true;
  cotStream.ensureBridgeStarted();
  if (typeof mapMeta.setPatchDestAugmenter === "function") {
    mapMeta.setPatchDestAugmenter(augmentDestGroupsForSourceGroups);
  }
  unsubscribe = cotStream.onCotProcessed(onCot);
  console.log("[channel-patch] engine started");
}

function stop() {
  if (typeof mapMeta.setPatchDestAugmenter === "function") {
    mapMeta.setPatchDestAugmenter(null);
  }
  if (unsubscribe) {
    try {
      unsubscribe();
    } catch (_) {}
    unsubscribe = null;
  }
  if (runtimeFlushTimer) {
    clearTimeout(runtimeFlushTimer);
    runtimeFlushTimer = null;
  }
  flushRuntime();
  started = false;
}

function getRuntimeHint(patchId) {
  return runtimeByPatch.get(safeStr(patchId).trim()) || null;
}

module.exports = {
  start,
  stop,
  destinationsForSource,
  isPortalPatchedCot,
  toMartiGroupName,
  getRuntimeHint,
  PATCH_TAG,
};
