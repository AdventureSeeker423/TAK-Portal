/**
 * Channel patch engine — mesh CoT rebroadcast across selected channels (both ways).
 *
 * Important: patched CoT is written on the portal's webadmin TLS stream. Reusing the
 * EUD's UID/SA would make TAK Server treat webadmin as a second instance of that
 * client (same callsign, admin's full group list). We therefore:
 *  - assign a distinct UID per dest (…callsign.takportal.dest)
 *  - keep type, team (__group), usericon, color, and the rest of the marker payload
 *  - keep <contact callsign> so ATAK does not label markers "NO CALLSIGN"
 *  - strip only endpoint / flow-tags / detail uid so the copy is not a live ClientEndpoint
 *  - ignore our own echoes on the map stream
 */
const cotStream = require("./cotStream.service");
const mapMeta = require("./mapMeta.service");
const groupsSvc = require("./groups.service");
const store = require("./channelPatch.store");

const PATCH_TAG = "__takportal_patch";
const BRIDGE_TAG = "__takportal_bridge";
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
  if (detail && detail[PATCH_TAG]?._attributes) return true;
  return false;
}

function isPortalBridgeCot(cot) {
  const detail = cot?.raw?.event?.detail || cot?.detail?.() || {};
  return !!(detail && detail[BRIDGE_TAG]);
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
      srcUid: safeStr(meta.srcUid),
    },
  };
}

function setFilterGroup(detail, groupName) {
  const g = safeStr(groupName).trim();
  if (!g) return;
  detail.filtergroup = { _attributes: { group: g } };
}

function patchedUid(srcUid, destGroup, callsign) {
  // Distinct UID per dest so TAK does not bind the copy to the webadmin
  // ClientEndpoint as a second instance of the real EUD. Callsign prefix
  // keeps UIDs readable in logs / filters (see takMetrics .takportal. exclude).
  const label =
    safeStr(callsign).trim() || safeStr(srcUid).trim() || "unit";
  const slugLabel = label
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  const dest = groupKey(destGroup) || toMartiGroupName(destGroup) || "dest";
  const slugDest = dest.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  return `${slugLabel || "unit"}.takportal.${slugDest || "dest"}`.slice(0, 128);
}

function stripContactEndpoint(contact) {
  if (!contact || typeof contact !== "object") return contact;
  if (contact._attributes && typeof contact._attributes === "object") {
    const attrs = { ...contact._attributes };
    delete attrs.endpoint;
    delete attrs.Endpoint;
    return { ...contact, _attributes: attrs };
  }
  const next = { ...contact };
  delete next.endpoint;
  delete next.Endpoint;
  return next;
}

/**
 * Strip only routing/identity that would bind this copy to the webadmin socket.
 * Keep type, team (__group), usericon, color, takv, status, and other marker
 * payload so dest clients draw the same icon as the source.
 * Returns the callsign used on the copy.
 */
function neutralizeAsInjectedCopy(detail, fallbackCallsign) {
  if (!detail || typeof detail !== "object") {
    return safeStr(fallbackCallsign).trim();
  }

  const callsign = safeStr(
    detail.contact?._attributes?.callsign ||
      detail.contact?.callsign ||
      fallbackCallsign ||
      ""
  ).trim();

  // Detail <uid> is a device identity handle — do not advertise it on webadmin.
  delete detail.uid;
  delete detail._uid_;
  // Do not carry original flow tags onto the webadmin write
  delete detail["_flow-tags_"];
  delete detail["flow-tags"];
  delete detail._flowTags;
  delete detail.flowTags;

  // ATAK shows "NO CALLSIGN" when <contact callsign> is missing. Keep the
  // rest of <contact>, but strip endpoint so this is not a routable
  // ClientEndpoint advertise on the webadmin socket.
  if (detail.contact) {
    detail.contact = stripContactEndpoint(detail.contact);
    const attrs =
      detail.contact._attributes && typeof detail.contact._attributes === "object"
        ? detail.contact._attributes
        : detail.contact;
    if (callsign && !safeStr(attrs.callsign).trim()) attrs.callsign = callsign;
  } else if (callsign) {
    detail.contact = { _attributes: { callsign } };
  }

  return callsign;
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

  const srcUid = safeStr(raw.event?._attributes?.uid).trim();
  const clone = new CoT(raw);
  const detail = clone.detail();
  clearExistingDests(detail);
  const callsign = neutralizeAsInjectedCopy(detail, meta?.callsign);

  // Distinct UID so TAK does not bind this copy to the webadmin ClientEndpoint.
  // CoT type is left unchanged so dest clients keep the source icon.
  clone.uid(patchedUid(srcUid, destGroup, callsign));

  const martiGroup = toMartiGroupName(destGroup);
  if (!martiGroup) throw new Error("Empty Marti dest group");
  clone.addDest({ group: martiGroup });
  setFilterGroup(detail, martiGroup);
  stampPatchTag(detail, {
    ...meta,
    toGroup: destGroup,
    srcUid,
    callsign,
  });

  return clone;
}

async function forwardCot({ marker, cot }) {
  if (!cot || isPortalPatchedCot(cot) || isPortalBridgeCot(cot)) return;
  if (!cotStream.isBridgeConnected()) return;

  const patches = store.listEnabled();
  if (!patches.length) return;

  // Use the EUD's real publish subscription only — NOT marker.groups.
  // marker.groups may include channel-patch map attribution (dest channels),
  // which would fan traffic back onto the source channel as a ghost pin.
  const publishGroups = mapMeta.resolveGroupsFromSubscription(marker);
  const sourceKeys = (Array.isArray(publishGroups) ? publishGroups : [])
    .map((g) => groupKey(mapMeta.toChannelGroupName(g) || g))
    .filter((k) => k && k !== mapMeta.UNASSIGNED_CHANNEL_KEY);
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
          callsign: marker?.callsign,
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
  isPortalBridgeCot,
  toMartiGroupName,
  patchedUid,
  neutralizeAsInjectedCopy,
  getRuntimeHint,
  PATCH_TAG,
  BRIDGE_TAG,
};
