/**
 * Background geofence evaluator — enter/exit channel control + enter-only Data Sync.
 */
const cotStream = require("./cotStream.service");
const mapMeta = require("./mapMeta.service");
const { getSubscriptionsAll, isExcludedConnectedUserSubscription } = require("./takMetrics.service");
const takGroupControl = require("./takGroupControl.service");
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

async function applyChannelActions(clientUid, authUser, channels, phase) {
  const list = Array.isArray(channels) ? channels : [];
  for (const ch of list) {
    const want = phase === "enter" ? ch.onEnter === true : ch.onExit === true;
    if (!want) continue;
    const groupName = safeStr(ch.groupName).trim();
    if (!groupName) continue;
    try {
      await takGroupControl.setClientGroupActive(clientUid, authUser, {
        groupName,
        accessMode: ch.accessMode || "BOTH",
        active: phase === "enter",
      });
    } catch (err) {
      const status = err?.status || err?.response?.status;
      if (status === 404 || status === 400 || status === 403) {
        console.info(
          `[geofence] skip channel ${groupName} ${phase} for ${clientUid}:`,
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

async function handleEnter(fence, clientUid) {
  const authUser = fence.owner || { isGlobalAdmin: true };
  await applyChannelActions(clientUid, authUser, fence.actions?.channels, "enter");
  await applyMissionEnter(clientUid, authUser, fence.actions?.missions);
}

async function handleExit(fence, clientUid) {
  const authUser = fence.owner || { isGlobalAdmin: true };
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

  // Only force re-enter when we observed inactive → active (not cold start).
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

  for (const uid of enters) {
    // Optimistic membership prevents duplicate enter on overlapping ticks.
    store.setMemberInside(fenceId, uid, true);
    enqueueClient(uid, () => handleEnter(fence, uid));
  }
  for (const uid of exits) {
    store.setMemberInside(fenceId, uid, false);
    enqueueClient(uid, () => handleExit(fence, uid));
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
      if (mapMeta.classifyMarkerOrigin(marker) !== "eud") continue;
      const sub = resolveSubscriptionForMarker(marker, index);
      if (!sub) continue;
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
  } catch (err) {
    console.warn("[geofence] tick failed:", err?.message || err);
  } finally {
    ticking = false;
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
  applyChannelActions,
  applyMissionEnter,
  handleEnter,
  handleExit,
  enqueueClient,
};
