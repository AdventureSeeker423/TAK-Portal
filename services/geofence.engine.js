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
/**
 * Keep "inside" membership across brief CoT/subscription blips so one-time
 * enter actions do not re-fire when the device never actually left.
 * Longer than a couple-second drop; shorter than a true disconnect.
 */
const OFFLINE_GRACE_MS = 45000;

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
 * Whether a previously-inside member who is temporarily not observed should
 * keep membership (hold) or be dropped so a later sighting can re-enter.
 * @returns {"hold"|"drop"}
 */
function resolveOfflineMembership({
  lastSeenAt,
  lastEnterAt,
  nowMs = Date.now(),
  graceMs = OFFLINE_GRACE_MS,
}) {
  const raw = lastSeenAt || lastEnterAt || null;
  const lastSeenMs = typeof raw === "number" ? raw : Date.parse(safeStr(raw));
  if (!Number.isFinite(lastSeenMs)) {
    // Legacy row with no timestamps: start grace from this observation.
    return "hold";
  }
  if (nowMs - lastSeenMs < graceMs) return "hold";
  return "drop";
}

/**
 * Pure transition computation for tests.
 * @returns {{ enters: string[], exits: string[], drops: string[], holds: string[] }}
 */
function computeTransitions({
  fenceId,
  active,
  wasActive,
  insideClientUids,
  previousInsideUids,
  onlineUids,
  membershipByUid,
  nowMs = Date.now(),
  offlineGraceMs = OFFLINE_GRACE_MS,
}) {
  const enters = [];
  const exits = [];
  const drops = [];
  const holds = [];
  const insideSet = new Set(insideClientUids || []);
  const prevSet = new Set(previousInsideUids || []);
  const onlineSet =
    onlineUids instanceof Set
      ? onlineUids
      : new Set(Array.isArray(onlineUids) ? onlineUids : []);

  if (!active) {
    for (const uid of prevSet) drops.push(uid);
    return { enters, exits, drops, holds };
  }

  const forceEnterAll = wasActive === false;
  for (const uid of insideSet) {
    if (forceEnterAll || !prevSet.has(uid)) enters.push(uid);
  }
  for (const uid of prevSet) {
    if (insideSet.has(uid)) continue;
    // Legacy callers omit onlineUids → treat missing as a geographic exit.
    if (onlineUids == null) {
      exits.push(uid);
      continue;
    }
    if (onlineSet.has(uid)) {
      exits.push(uid);
      continue;
    }
    const row =
      membershipByUid && typeof membershipByUid === "object"
        ? membershipByUid[uid]
        : null;
    const action = resolveOfflineMembership({
      lastSeenAt: row?.lastSeenAt,
      lastEnterAt: row?.lastEnterAt,
      nowMs,
      graceMs: offlineGraceMs,
    });
    if (action === "hold") holds.push(uid);
    else drops.push(uid);
  }
  return { enters, exits, drops, holds };
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

function resolvePhaseChannelAction(ch, phase) {
  if (!ch) return "";
  const raw = phase === "enter" ? ch.enterAction : ch.exitAction;
  const v = safeStr(raw).trim().toLowerCase();
  if (v === "enable" || v === "disable") return v;
  // Legacy booleans
  if (phase === "enter" && ch.onEnter === true) return "enable";
  if (phase === "exit" && ch.onExit === true) return "disable";
  return "";
}

/** Whether display/group state already matches the desired enable/disable. */
function channelStateMatchesDesired(hit, wantActive) {
  if (!hit) return false;
  if (
    hit.accessMode === "BOTH" &&
    typeof hit.inActive === "boolean" &&
    typeof hit.outActive === "boolean"
  ) {
    if (wantActive) return hit.inActive === true && hit.outActive === true;
    return hit.inActive === false && hit.outActive === false;
  }
  return hit.active === wantActive;
}

async function applyChannelActions(clientUid, authUser, channels, phase) {
  const list = Array.isArray(channels) ? channels : [];
  for (const ch of list) {
    const action = resolvePhaseChannelAction(ch, phase);
    if (action !== "enable" && action !== "disable") continue;
    const configuredName = safeStr(ch.groupName).trim();
    if (!configuredName) continue;
    try {
      const entitled = await resolveEntitledChannel(clientUid, authUser, configuredName);
      if (!entitled) {
        console.info(
          `[geofence] skip channel ${configuredName} ${phase}/${action} for ${clientUid}: not entitled`
        );
        continue;
      }
      await takGroupControl.setClientGroupActive(clientUid, authUser, {
        groupName: entitled.groupName,
        accessMode: entitled.accessMode || ch.accessMode || "BOTH",
        active: action === "enable",
      });
      console.info(
        `[geofence] ${phase} ${action} channel ${entitled.groupName} (${entitled.accessMode}) for ${clientUid}`
      );
    } catch (err) {
      const status = err?.status || err?.response?.status;
      if (status === 404 || status === 400 || status === 403) {
        console.info(
          `[geofence] skip channel ${configuredName} ${phase}/${action} for ${clientUid}:`,
          err?.message || err
        );
        continue;
      }
      throw err;
    }
  }
}

/**
 * Force mode: re-apply enter channel actions only when current state differs.
 * Does not re-send Data Sync invites.
 */
async function enforceEnterChannelsIfNeeded(clientUid, authUser, channels) {
  const list = Array.isArray(channels) ? channels : [];
  const wanted = list.filter((ch) => {
    const action = resolvePhaseChannelAction(ch, "enter");
    return action === "enable" || action === "disable";
  });
  if (!wanted.length) return;

  let groups = [];
  try {
    const state = await takGroupControl.getClientGroupControlState(clientUid, authUser);
    groups = Array.isArray(state?.groups) ? state.groups : [];
  } catch (err) {
    console.warn(
      `[geofence] force state check failed for ${clientUid}:`,
      err?.message || err
    );
    return;
  }

  for (const ch of wanted) {
    const action = resolvePhaseChannelAction(ch, "enter");
    const wantActive = action === "enable";
    const configuredName = safeStr(ch.groupName).trim();
    if (!configuredName) continue;
    const wantKey = dataSyncAccess.canonicalGroupKey(configuredName);
    const hit = groups.find(
      (g) => dataSyncAccess.canonicalGroupKey(g?.name) === wantKey
    );
    if (!hit) {
      console.info(
        `[geofence] force skip channel ${configuredName} for ${clientUid}: not entitled`
      );
      continue;
    }
    if (channelStateMatchesDesired(hit, wantActive)) continue;
    try {
      await takGroupControl.setClientGroupActive(clientUid, authUser, {
        groupName: safeStr(hit.name).trim(),
        accessMode: safeStr(hit.accessMode).trim().toUpperCase() || ch.accessMode || "BOTH",
        active: wantActive,
      });
      console.info(
        `[geofence] force ${action} channel ${hit.name} (${hit.accessMode}) for ${clientUid}`
      );
      // Keep local groups in sync for subsequent checks in this pass.
      hit.active = wantActive;
      if (typeof hit.inActive === "boolean") hit.inActive = wantActive;
      if (typeof hit.outActive === "boolean") hit.outActive = wantActive;
    } catch (err) {
      const status = err?.status || err?.response?.status;
      if (status === 404 || status === 400 || status === 403) {
        console.info(
          `[geofence] force skip channel ${configuredName} for ${clientUid}:`,
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
  const enterChannels = channels.filter(
    (c) => resolvePhaseChannelAction(c, "enter") === "enable" || resolvePhaseChannelAction(c, "enter") === "disable"
  ).length;
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

async function handleForceEnforce(fence, clientUid) {
  const authUser = authUserForFence(fence);
  await enforceEnterChannelsIfNeeded(clientUid, authUser, fence.actions?.channels);
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
  const nowMs = Date.now();

  // Force re-enter on inactive→active. Also treat first observation of an
  // already-active fence as normal (membership empty → enter), which covers
  // "drew fence over EUD already here" and "configured Enter after create".
  const forceEnterAll = known && wasActive === false;
  const enters = [];
  const exits = [];
  const stayInside = [];

  for (const uid of insideSet) {
    if (forceEnterAll || !store.wasMemberInside(fenceId, uid)) {
      enters.push(uid);
    } else {
      stayInside.push(uid);
    }
  }

  // Refresh last-seen while still observed inside (feeds offline grace).
  for (const uid of stayInside) {
    store.touchMemberSeen(fenceId, uid, nowMs);
  }

  for (const uid of previousInsideUids) {
    if (insideSet.has(uid)) continue;
    if (onlineUids.has(uid)) {
      exits.push(uid);
      continue;
    }
    // Not observed (marker/subscription blip): keep membership through grace
    // so one-time enter does not re-fire when they reappear still inside.
    const row = membership[uid];
    const action = resolveOfflineMembership({
      lastSeenAt: row?.lastSeenAt,
      lastEnterAt: row?.lastEnterAt,
      nowMs,
      graceMs: OFFLINE_GRACE_MS,
    });
    if (action === "hold") {
      if (!row?.lastSeenAt && !row?.lastEnterAt) {
        store.touchMemberSeen(fenceId, uid, nowMs);
      }
      continue;
    }
    store.dropMember(fenceId, uid);
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

  const enforceMode =
    safeStr(fence.enforceMode).trim().toLowerCase() === "force" ? "force" : "one-time";
  if (enforceMode === "force" && stayInside.length) {
    for (const uid of stayInside) {
      enqueueClient(uid, () => {
        const latest = store.getFence(fenceId) || fence;
        if (!latest || latest.active !== true) return;
        if (safeStr(latest.enforceMode).trim().toLowerCase() !== "force") return;
        return handleForceEnforce(latest, uid);
      });
    }
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
  OFFLINE_GRACE_MS,
  start,
  stop,
  tick,
  computeTransitions,
  resolveOfflineMembership,
  resolveSubscriptionForMarker,
  indexSubscriptions,
  resolveEntitledChannel,
  resolvePhaseChannelAction,
  channelStateMatchesDesired,
  applyChannelActions,
  enforceEnterChannelsIfNeeded,
  applyMissionEnter,
  handleEnter,
  handleExit,
  handleForceEnforce,
  enqueueClient,
  authUserForFence,
  reapplyEnterForMembers,
};
