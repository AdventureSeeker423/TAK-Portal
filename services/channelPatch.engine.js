/**
 * Channel patch engine — mesh CoT rebroadcast across selected channels (both ways).
 *
 * Important: patched CoT is written on the portal's webadmin TLS stream. Reusing the
 * EUD's UID/SA would make TAK Server treat webadmin as a second instance of that
 * client (same callsign, admin's full group list). We therefore:
 *  - assign a distinct UID per dest
 *  - ignore our own echoes on the map stream
 *  - restore a stable bridge callsign after each write batch
 */
const cotStream = require("./cotStream.service");
const mapMeta = require("./mapMeta.service");
const mapRender = require("./mapRender.service");
const groupsSvc = require("./groups.service");
const store = require("./channelPatch.store");

const PATCH_TAG = "__takportal_patch";
const BRIDGE_TAG = "__takportal_bridge";
const BRIDGE_UID = "takportal-channel-patch-bridge";
const BRIDGE_CALLSIGN = "TAK-Portal";
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
  // Prefer callsign in the UID so ATAK still shows a readable label without a
  // <contact callsign> (which would steal the webadmin ClientEndpoint callsign).
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

/**
 * Strip elements that make TAK treat this as the injecting connection's own SA.
 * Returns the original callsign (for UID/remarks) if present.
 */
function neutralizeAsInjectedCopy(detail) {
  if (!detail || typeof detail !== "object") return "";

  const callsign = safeStr(
    detail.contact?._attributes?.callsign ||
      detail.contact?.callsign ||
      ""
  ).trim();

  // Connection/group membership announcements from the original EUD
  delete detail.__group;
  delete detail._group;
  delete detail.group;
  // Client identity / device fingerprint — leave these off the bridge write
  delete detail.takv;
  delete detail.status;
  delete detail.uid;
  delete detail._uid_;
  // Do not carry original flow tags onto the webadmin write
  delete detail["_flow-tags_"];
  delete detail["flow-tags"];
  delete detail._flowTags;
  delete detail.flowTags;

  // CRITICAL: any contact.callsign written on the webadmin TLS socket updates
  // that connection's ClientEndpoint callsign (dashboard "callsign stealing").
  delete detail.contact;

  if (callsign) {
    detail.remarks = { _text: callsign };
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
  const callsign = neutralizeAsInjectedCopy(detail);

  // Distinct UID (includes callsign for readable ATAK labels without <contact>).
  clone.uid(patchedUid(srcUid, destGroup, callsign));

  // Demote self-SA type so TAK is less likely to treat this as a live client.
  const typ = safeStr(clone.type()).trim();
  if (/^a-f-G-U-C/i.test(typ)) {
    clone.type("a-f-G");
  }

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

/**
 * Restore a stable callsign/uid on the webadmin stream so Client Dashboard
 * does not keep showing a previously stolen EUD callsign under username admin.
 * Avoid null-island (0,0) — TAK often ignores those for endpoint updates.
 */
async function buildBridgePresenceCot(point = {}) {
  const mod = await loadNodeCot();
  const CoT = mod.default || mod.CoT;
  if (!CoT) throw new Error("node-cot CoT constructor unavailable");

  let lat = Number(point.lat);
  let lon = Number(point.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) {
    // Far-south placeholder TAK will still accept for endpoint metadata.
    lat = -89.9;
    lon = 0;
  }
  const hae =
    point.hae != null && Number.isFinite(Number(point.hae))
      ? Number(point.hae)
      : 9999999.0;

  const now = new Date();
  const stale = new Date(now.getTime() + 5 * 60 * 1000);
  const iso = now.toISOString();
  const raw = {
    event: {
      _attributes: {
        version: "2.0",
        uid: BRIDGE_UID,
        type: "a-f-G-U-C",
        how: "h-g-i-g-o",
        time: iso,
        start: iso,
        stale: stale.toISOString(),
      },
      point: {
        _attributes: {
          lat: String(lat),
          lon: String(lon),
          hae: String(hae),
          ce: "9999999.0",
          le: "9999999.0",
        },
      },
      detail: {
        contact: { _attributes: { callsign: BRIDGE_CALLSIGN } },
        takv: {
          _attributes: {
            device: "TAK-Portal",
            platform: "TAK-Portal",
            os: "server",
            version: "channel-patch",
          },
        },
        [BRIDGE_TAG]: { _attributes: { v: "1" } },
      },
    },
  };
  return new CoT(raw);
}

async function forwardCot({ marker, cot }) {
  if (!cot || isPortalPatchedCot(cot) || isPortalBridgeCot(cot)) return;
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

    if (ok) {
      try {
        const bridgeCot = await buildBridgePresenceCot({
          lat: marker?.lat,
          lon: marker?.lon,
          hae: marker?.hae,
        });
        await cotStream.writeCot(bridgeCot, { stripFlow: true });
      } catch (err) {
        console.warn(
          "[channel-patch] bridge identity restore failed:",
          err?.message || err
        );
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
  // Claim a stable bridge callsign as soon as the stream is up.
  void (async () => {
    try {
      if (!cotStream.isBridgeConnected()) return;
      const bridgeCot = await buildBridgePresenceCot({});
      await cotStream.writeCot(bridgeCot, { stripFlow: true });
    } catch (_) {}
  })();
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
  getRuntimeHint,
  PATCH_TAG,
  BRIDGE_TAG,
  BRIDGE_UID,
  BRIDGE_CALLSIGN,
};
