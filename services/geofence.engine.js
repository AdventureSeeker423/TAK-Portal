/**
 * Background geofence evaluator — enter/exit channel control + enter-only Data Sync.
 */
const cotStream = require("./cotStream.service");
const mapMeta = require("./mapMeta.service");
const { getSubscriptionsAll, isExcludedConnectedUserSubscription } = require("./takMetrics.service");
const takGroupControl = require("./takGroupControl.service");
const dataSyncAccess = require("./dataSyncAccess.service");
const store = require("./geofence.store");
const { pointInGeometry } = require("./geofence.geometry");

const POLL_MS = 2500;
const SUB_CACHE_MS = 8000;

let timer = null;
let ticking = false;
let started = false;

/** fenceId -> previously known active flag (detect activate edge) */
const prevActiveByFence = new Map();

/** clientUid -> Promise chain for serialized Marti actions */
const clientQueues = new Map();

let subCache = {
  fetchedAt: 0,
  byUid: new Map(),
  byCallsign: new Map(),
  list: [],
};

function safeStr(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function enqueueClient(clientUid, fn) {
  const uid = safeStr(clientUid).trim();
  const prev = clientQueues.get(uid) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => fn())
    .catch((err) => {
      console.warn(
        `[geofence] action failed for ${uid}:`,
        err?.message || err
      );
    });
  clientQueues.set(uid, next);
  return next.finally(() => {
    if (clientQueues.get(uid) === next) clientQueues.delete(uid);
  });
}

function indexSubscriptions(list) {
  const byUid = new Map();
  const byCallsign = new Map();
  for (const sub of Array.isArray(list) ? list : []) {
    if (!sub || isExcludedConnectedUserSubscription(sub)) continue;
    const clientUid = safeStr(sub.clientUid).trim();
    if (!clientUid) continue;
    const entry = { ...sub, clientUid };
    const uidFields = [
      sub.uid,
      sub.clientUid,
      sub.clientUuid,
      sub.connectionUid,
      sub.deviceUid,
      sub.subscriptionUid,
    ];
    for (const raw of uidFields) {
      const k = safeStr(raw).trim().toLowerCase();
      if (k && !byUid.has(k)) byUid.set(k, entry);
    }
    const callsign = safeStr(sub.callsign).trim().toLowerCase();
    if (callsign && !byCallsign.has(callsign)) byCallsign.set(callsign, entry);
    const username = safeStr(sub.username).trim().toLowerCase();
    if (username && !byCallsign.has(username)) byCallsign.set(username, entry);
  }
  return { byUid, byCallsign, list: Array.isArray(list) ? list : [] };
}

async function getSubscriptionIndex() {
  const now = Date.now();
  if (now - subCache.fetchedAt < SUB_CACHE_MS && subCache.byUid.size) {
    return subCache;
  }
  try {
    const result = await getSubscriptionsAll();
    const indexed = indexSubscriptions(result?.data);
    subCache = { fetchedAt: now, ...indexed };
  } catch (err) {
    console.warn("[geofence] subscription refresh failed:", err?.message || err);
    if (!subCache.fetchedAt) {
      subCache = { fetchedAt: now, byUid: new Map(), byCallsign: new Map(), list: [] };
    }
  }
  return subCache;
}

function resolveSubscriptionForMarker(marker, index) {
  if (!marker || !index) return null;
  const uid = safeStr(marker.uid).trim().toLowerCase();
  if (uid && index.byUid.has(uid)) return index.byUid.get(uid);
  const callsign = safeStr(marker.callsign).trim().toLowerCase();
  if (callsign && index.byCallsign.has(callsign)) return index.byCallsign.get(callsign);
  return null;
}

/**
 * Pure transition computation for tests.
 * @returns {{ enters: string[], exits: string[], drops: string[] }}
 */
function computeTransitions({
  fenceId,
  active,
  wasActive,
  insideClientUids,
  previousInsideUids,
}) {
  const enters = [];
  const exits = [];
  const drops = [];
  const insideSet = new Set(insideClientUids || []);
  const prevSet = new Set(previousInsideUids || []);

  if (!active) {
    for (const uid of prevSet) drops.push(uid);
    return { enters, exits, drops };
  }

  const forceEnterAll = wasActive === false;
  for (const uid of insideSet) {
    if (forceEnterAll || !prevSet.has(uid)) enters.push(uid);
  }
  for (const uid of prevSet) {
    if (!insideSet.has(uid)) {
      // Still visible as a previous member but not inside now:
      // caller distinguishes disconnect (drop) vs exit via online set.
      exits.push(uid);
    }
  }
  return { enters, exits, drops };
}

/**
 * Map catalog uses tak_* names; Marti often uses the CN without tak_.
 * Match by canonical key against the EUD's entitled groups.
 */
async function resolveEntitledChannel(clientUid, authUser, configuredName) {
  const want = dataSyncAccess.canonicalGroupKey(configuredName);
  if (!want) return null;
  const state = await takGroupControl.getClientGroupControlState(clientUid, authUser);
  const groups = Array.isArray(state?.groups) ? state.groups : [];
  const hit = groups.find(
    (g) => dataSyncAccess.canonicalGroupKey(g?.name) === want
  );
  if (!hit) return null;
  return {
    groupName: safeStr(hit.name).trim(),
    accessMode: safeStr(hit.accessMode).trim().toUpperCase() || "BOTH",
  };
}

async function applyChannelActions(clientUid, authUser, channels, phase) {
  const list = Array.isArray(channels) ? channels : [];
  for (const ch of list) {
    const want = phase === "enter" ? ch.onEnter === true : ch.onExit === true;
    if (!want) continue;
    const configuredName = safeStr(ch.groupName).trim();
    if (!configuredName) continue;
    try {
      const entitled = await resolveEntitledChannel(clientUid, authUser, configuredName);
      if (!entitled) {
        console.info(
          `[geofence] skip channel ${configuredName} ${phase} for ${clientUid}: not entitled`
        );
        continue;
      }
      await takGroupControl.setClientGroupActive(clientUid, authUser, {
        groupName: entitled.groupName,
        accessMode: entitled.accessMode || ch.accessMode || "BOTH",
        active: phase === "enter",
      });
      console.info(
        `[geofence] ${phase} channel ${entitled.groupName} (${entitled.accessMode}) for ${clientUid}`
      );
    } catch (err) {
      const status = err?.status || err?.response?.status;
      if (status === 404 || status === 400 || status === 403) {
        console.info(
          `[geofence] skip channel ${configuredName} ${phase} for ${clientUid}:`,
          err?.message || err
        );
        continue;
      }
      throw err;
    }
  }
}

async function applyMissionEnter(clientUid, authUser, missions) {
  const list = Array.isArray(missions) ? missions : [];
  for (const m of list) {
    const missionName = safeStr(m.missionName || m.name).trim();
    if (!missionName) continue;
    try {
      await takGroupControl.sendClientDataSyncInvite(clientUid, authUser, { missionName });
    } catch (err) {
      const status = err?.status || err?.response?.status;
      if (status === 404 || status === 400 || status === 403) {
        console.info(
          `[geofence] skip mission ${missionName} enter for ${clientUid}:`,
          err?.message || err
        );
        continue;
      }
      throw err;
    }
  }
}

function authUserForFence(fence) {
  const o = fence?.owner && typeof fence.owner === "object" ? fence.owner : {};
  if (o.isGlobalAdmin === true || o.isAgencyAdmin === true) return o;
  // Map access is admin-only; missing flags should not block Marti control.
  return { ...o, isGlobalAdmin: true };
}

async function handleEnter(fence, clientUid) {
  const authUser = authUserForFence(fence);
  const channels = fence.actions?.channels || [];
  const missions = fence.actions?.missions || [];
  const enterChannels = channels.filter((c) => c && c.onEnter === true).length;
  console.info(
    `[geofence] enter ${clientUid} fence=${fence.id || "?"} channels=${enterChannels} missions=${missions.length}`
  );
  await applyChannelActions(clientUid, authUser, channels, "enter");
  await applyMissionEnter(clientUid, authUser, missions);
}

async function handleExit(fence, clientUid) {
  const authUser = authUserForFence(fence);
  console.info(`[geofence] exit ${clientUid} fence=${fence.id || "?"}`);
  await applyChannelActions(clientUid, authUser, fence.actions?.channels, "exit");
}

async function evaluateFence(fence, eudPoints, onlineUids) {
  const fenceId = fence.id;
  const known = prevActiveByFence.has(fenceId);
  const wasActive = known ? prevActiveByFence.get(fenceId) : fence.active === true;
  const active = fence.active === true;
  prevActiveByFence.set(fenceId, active);

  const membership = store.getMembershipMap(fenceId);
  const previousInsideUids = Object.keys(membership).filter(
    (uid) => membership[uid] && membership[uid].inside === true
  );

  if (!active) {
    for (const uid of previousInsideUids) {
      store.dropMember(fenceId, uid);
    }
    return;
  }

  const insideClientUids = [];
  for (const pt of eudPoints) {
    if (pointInGeometry(pt.lon, pt.lat, fence.geometry)) {
      insideClientUids.push(pt.clientUid);
    }
  }
  const insideSet = new Set(insideClientUids);

  // Force re-enter on inactive→active. Also treat first observation of an
  // already-active fence as normal (membership empty → enter), which covers
  // "drew fence over EUD already here" and "configured Enter after create".
  const forceEnterAll = known && wasActive === false;
  const enters = [];
  const exits = [];

  for (const uid of insideSet) {
    if (forceEnterAll || !store.wasMemberInside(fenceId, uid)) {
      enters.push(uid);
    }
  }

  for (const uid of previousInsideUids) {
    if (insideSet.has(uid)) continue;
    if (onlineUids.has(uid)) {
      exits.push(uid);
    } else {
      store.dropMember(fenceId, uid);
    }
  }

  if (enters.length || exits.length) {
    console.info(
      `[geofence] fence=${fenceId} inside=${insideSet.size} enter=${enters.length} exit=${exits.length}`
    );
  }

  // Load fresh fence config at action time (actions may have just been patched).
  for (const uid of enters) {
    store.setMemberInside(fenceId, uid, true);
    enqueueClient(uid, () => {
      const latest = store.getFence(fenceId) || fence;
      return handleEnter(latest, uid);
    });
  }
  for (const uid of exits) {
    store.setMemberInside(fenceId, uid, false);
    enqueueClient(uid, () => {
      const latest = store.getFence(fenceId) || fence;
      return handleExit(latest, uid);
    });
  }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    cotStream.ensureBridgeStarted();
    await mapMeta.refreshSubscriptionIndex().catch(() => {});
    const index = await getSubscriptionIndex();
    const markers = cotStream.getMarkerList();
    const eudPoints = [];
    const onlineUids = new Set();

    for (const marker of markers) {
      const sub = resolveSubscriptionForMarker(marker, index);
      if (!sub) continue;
      // Skip obvious data-feed markers; anything matched to a live subscription is actionable.
      if (mapMeta.classifyMarkerOrigin(marker) === "feed") continue;
      const lon = Number(marker.lon);
      const lat = Number(marker.lat);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      eudPoints.push({
        clientUid: sub.clientUid,
        lon,
        lat,
        callsign: marker.callsign,
      });
      onlineUids.add(sub.clientUid);
    }

    const fences = store.listFences();
    const knownIds = new Set(fences.map((f) => f.id));
    for (const id of Array.from(prevActiveByFence.keys())) {
      if (!knownIds.has(id)) prevActiveByFence.delete(id);
    }

    for (const fence of fences) {
      await evaluateFence(fence, eudPoints, onlineUids);
    }

    for (const fenceId of store.takePendingReapplyEnterIds()) {
      reapplyEnterForMembers(fenceId);
    }
  } catch (err) {
    console.warn("[geofence] tick failed:", err?.message || err);
  } finally {
    ticking = false;
  }
}

/** Re-apply enter actions for devices currently marked inside an active fence. */
function reapplyEnterForMembers(fenceId) {
  const id = safeStr(fenceId).trim();
  const fence = store.getFence(id);
  if (!fence || fence.active !== true) return;
  const membership = store.getMembershipMap(id);
  const uids = Object.keys(membership).filter(
    (uid) => membership[uid] && membership[uid].inside === true
  );
  if (!uids.length) {
    // Nobody tracked yet — evaluate spatially on this or next tick.
    return;
  }
  console.info(`[geofence] reapply enter fence=${id} members=${uids.length}`);
  for (const uid of uids) {
    enqueueClient(uid, () => {
      const latest = store.getFence(id) || fence;
      return handleEnter(latest, uid);
    });
  }
}

function start() {
  if (started) return;
  started = true;
  try {
    cotStream.ensureBridgeStarted();
  } catch (_) {}
  void tick();
  timer = setInterval(() => {
    void tick();
  }, POLL_MS);
  if (typeof timer.unref === "function") timer.unref();
  console.log(`[geofence] evaluator started (poll ${POLL_MS}ms)`);
}

function stop() {
  started = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  POLL_MS,
  start,
  stop,
  tick,
  computeTransitions,
  resolveSubscriptionForMarker,
  indexSubscriptions,
  resolveEntitledChannel,
  applyChannelActions,
  applyMissionEnter,
  handleEnter,
  handleExit,
  enqueueClient,
  authUserForFence,
  reapplyEnterForMembers,
};
