/**
 * Persist portal geofences and membership state in Postgres.
 * Membership writes are debounced (~500ms) and flushed as dirty-key upserts.
 */
const crypto = require("crypto");
const { validateGeometry } = require("./geofence.geometry");
const pgCache = require("./pgCache");

const FENCES_PATH = null;
const STATE_PATH = null;

let _fences = null;
let _state = null;
let _stateDirty = false;
let _stateFlushTimer = null;
const _dirtyMemberships = new Map();

function ensureDirExists() {}

function readJsonSafe(_filePath, fallback) {
  return fallback;
}

function writeJsonSafe() {}

function safeStr(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function normalizeEnforceMode(value) {
  const v = safeStr(value).trim().toLowerCase();
  return v === "force" ? "force" : "one-time";
}

function normalizeAccessMode(value) {
  const v = safeStr(value).trim().toUpperCase();
  if (v === "READ" || v === "WRITE" || v === "BOTH") return v;
  return "BOTH";
}

function normalizeChannelActions(list) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(list) ? list : []) {
    const groupName = safeStr(row?.groupName || row?.name).trim();
    if (!groupName) continue;
    const key = groupName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    let enterAction = safeStr(row?.enterAction).trim().toLowerCase();
    let exitAction = safeStr(row?.exitAction).trim().toLowerCase();
    if (enterAction !== "enable" && enterAction !== "disable") {
      // Legacy boolean: onEnter true → enable on enter
      enterAction = row?.onEnter === true ? "enable" : "";
    }
    if (exitAction !== "enable" && exitAction !== "disable") {
      // Legacy boolean: onExit true → disable on exit
      exitAction = row?.onExit === true ? "disable" : "";
    }
    out.push({
      groupName,
      accessMode: normalizeAccessMode(row?.accessMode),
      enterAction: enterAction || "",
      exitAction: exitAction || "",
    });
  }
  return out;
}

function normalizeMissionActions(list) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(list) ? list : []) {
    const missionName = safeStr(row?.missionName || row?.name).trim();
    if (!missionName) continue;
    const key = missionName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ missionName });
  }
  return out;
}

function normalizeOwner(owner) {
  if (!owner || typeof owner !== "object") {
    return {
      username: "",
      isGlobalAdmin: true,
      isAgencyAdmin: false,
      groups: [],
    };
  }
  return {
    username: safeStr(owner.username || owner.preferred_username).trim(),
    isGlobalAdmin: owner.isGlobalAdmin === true,
    isAgencyAdmin: owner.isAgencyAdmin === true && owner.isGlobalAdmin !== true,
    groups: Array.isArray(owner.groups) ? owner.groups.map((g) => safeStr(g).trim()).filter(Boolean) : [],
  };
}

function normalizeFence(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = safeStr(raw.id).trim();
  if (!id) return null;
  const geo = validateGeometry(raw.geometry);
  if (!geo.ok) return null;
  const actions = raw.actions && typeof raw.actions === "object" ? raw.actions : {};
  return {
    id,
    name: safeStr(raw.name).trim(),
    active: raw.active === true,
    enforceMode: normalizeEnforceMode(raw.enforceMode),
    geometry: geo.geometry,
    actions: {
      channels: normalizeChannelActions(actions.channels),
      missions: normalizeMissionActions(actions.missions),
    },
    owner: normalizeOwner(raw.owner),
    createdAt: safeStr(raw.createdAt) || new Date().toISOString(),
    updatedAt: safeStr(raw.updatedAt) || new Date().toISOString(),
  };
}

function loadFences() {
  const parsed = pgCache.caches.geofences || { fences: [] };
  const list = Array.isArray(parsed?.fences)
    ? parsed.fences
    : Array.isArray(parsed)
      ? parsed
      : [];
  _fences = list.map(normalizeFence).filter(Boolean);
  return _fences;
}

function ensureFences() {
  if (_fences === null) loadFences();
  return _fences;
}

function saveFences() {
  const fences = ensureFences();
  pgCache.replaceGeofences(fences);
}

function loadState() {
  const parsed = pgCache.caches.geofenceState || { membership: {} };
  const membership =
    parsed && typeof parsed.membership === "object" && !Array.isArray(parsed.membership)
      ? parsed.membership
      : {};
  _state = { membership };
  _stateDirty = false;
  return _state;
}

function ensureState() {
  if (_state === null) loadState();
  return _state;
}

function markDirtyMembership(fenceId, clientUid, payload) {
  const fid = safeStr(fenceId).trim();
  const uid = safeStr(clientUid).trim();
  if (!fid) return;
  const key = uid ? `${fid}|${uid}` : `${fid}|`;
  _dirtyMemberships.set(key, payload);
}

function flushStateNow() {
  if (!_stateDirty || _state === null) return;
  const dirty = Array.from(_dirtyMemberships.values());
  _dirtyMemberships.clear();
  _stateDirty = false;
  pgCache.caches.geofenceState = {
    membership: _state.membership,
    updatedAt: new Date().toISOString(),
  };
  if (dirty.length) {
    pgCache.persistCatch("geofence-memberships", () =>
      pgCache.upsertGeofenceMemberships(dirty)
    );
  }
}

function scheduleStateFlush() {
  _stateDirty = true;
  if (_stateFlushTimer) return;
  _stateFlushTimer = setTimeout(() => {
    _stateFlushTimer = null;
    try {
      flushStateNow();
    } catch (err) {
      console.warn("[geofence.store] state flush failed:", err?.message || err);
    }
  }, 500);
}

function listFences() {
  return ensureFences().map((f) => ({ ...f, actions: { ...f.actions, channels: [...f.actions.channels], missions: [...f.actions.missions] } }));
}

function getFence(id) {
  const want = safeStr(id).trim();
  return ensureFences().find((f) => f.id === want) || null;
}

function ownerFromAuthUser(authUser) {
  return normalizeOwner({
    username: authUser?.preferred_username || authUser?.username || "",
    isGlobalAdmin: !!authUser?.isGlobalAdmin,
    isAgencyAdmin: !!authUser?.isAgencyAdmin,
    groups: authUser?.groups,
  });
}

function createFence(input, authUser) {
  const geo = validateGeometry(input?.geometry);
  if (!geo.ok) {
    const err = new Error(geo.error);
    err.status = 400;
    throw err;
  }
  const now = new Date().toISOString();
  const fence = {
    id: crypto.randomUUID(),
    name: safeStr(input?.name).trim(),
    active: input?.active === true,
    enforceMode: normalizeEnforceMode(input?.enforceMode),
    geometry: geo.geometry,
    actions: {
      channels: normalizeChannelActions(input?.actions?.channels),
      missions: normalizeMissionActions(input?.actions?.missions),
    },
    owner: ownerFromAuthUser(authUser),
    createdAt: now,
    updatedAt: now,
  };
  ensureFences().push(fence);
  saveFences();
  return { ...fence };
}

function updateFence(id, patch, authUser) {
  const fences = ensureFences();
  const idx = fences.findIndex((f) => f.id === safeStr(id).trim());
  if (idx < 0) {
    const err = new Error("Geofence not found.");
    err.status = 404;
    throw err;
  }
  const current = fences[idx];
  const next = { ...current };
  let actionsChanged = false;
  let geometryChanged = false;
  const wasActive = current.active === true;

  if (patch && Object.prototype.hasOwnProperty.call(patch, "name")) {
    next.name = safeStr(patch.name).trim();
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, "active")) {
    next.active = patch.active === true;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, "enforceMode")) {
    next.enforceMode = normalizeEnforceMode(patch.enforceMode);
  }
  if (patch && patch.geometry) {
    const geo = validateGeometry(patch.geometry);
    if (!geo.ok) {
      const err = new Error(geo.error);
      err.status = 400;
      throw err;
    }
    next.geometry = geo.geometry;
    geometryChanged = true;
  }
  if (patch && patch.actions && typeof patch.actions === "object") {
    next.actions = {
      channels: Object.prototype.hasOwnProperty.call(patch.actions, "channels")
        ? normalizeChannelActions(patch.actions.channels)
        : current.actions.channels,
      missions: Object.prototype.hasOwnProperty.call(patch.actions, "missions")
        ? normalizeMissionActions(patch.actions.missions)
        : current.actions.missions,
    };
    actionsChanged =
      JSON.stringify(next.actions) !== JSON.stringify(current.actions);
  }
  if (authUser && (!next.owner || !next.owner.username)) {
    next.owner = ownerFromAuthUser(authUser);
  }
  next.updatedAt = new Date().toISOString();
  fences[idx] = next;
  saveFences();

  // Re-fire enter for anyone already inside after config/geometry/activate changes.
  const becameActive = !wasActive && next.active === true;
  if (next.active && (geometryChanged || becameActive)) {
    clearFenceMembership(next.id);
  } else if (next.active && actionsChanged) {
    // Keep membership; ask engine to re-apply enter actions to devices already inside.
    markFenceForReapplyEnter(next.id);
  }

  return { ...next };
}

const pendingReapplyEnter = new Set();

function markFenceForReapplyEnter(fenceId) {
  const id = safeStr(fenceId).trim();
  if (id) pendingReapplyEnter.add(id);
}

function takePendingReapplyEnterIds() {
  const ids = Array.from(pendingReapplyEnter);
  pendingReapplyEnter.clear();
  return ids;
}

function deleteFence(id) {
  const want = safeStr(id).trim();
  const fences = ensureFences();
  const idx = fences.findIndex((f) => f.id === want);
  if (idx < 0) {
    const err = new Error("Geofence not found.");
    err.status = 404;
    throw err;
  }
  fences.splice(idx, 1);
  saveFences();
  clearFenceMembership(want);
  return true;
}

function getMembershipMap(fenceId) {
  const state = ensureState();
  const key = safeStr(fenceId).trim();
  const block = state.membership[key];
  return block && typeof block === "object" ? block : {};
}

function setMemberInside(fenceId, clientUid, inside) {
  const fid = safeStr(fenceId).trim();
  const uid = safeStr(clientUid).trim();
  if (!fid || !uid) return;
  const state = ensureState();
  if (!state.membership[fid] || typeof state.membership[fid] !== "object") {
    state.membership[fid] = {};
  }
  const now = new Date().toISOString();
  const prev = state.membership[fid][uid];
  if (inside) {
    const row = {
      inside: true,
      lastEnterAt: now,
      lastSeenAt: now,
      lastExitAt: prev?.lastExitAt || null,
    };
    state.membership[fid][uid] = row;
    markDirtyMembership(fid, uid, {
      fenceId: fid,
      clientUid: uid,
      inside: true,
      lastEnterAt: row.lastEnterAt,
      lastSeenAt: row.lastSeenAt,
      lastExitAt: row.lastExitAt,
    });
  } else {
    delete state.membership[fid][uid];
    markDirtyMembership(fid, uid, { fenceId: fid, clientUid: uid, delete: true });
  }
  scheduleStateFlush();
}

/** Refresh lastSeenAt for a member still observed inside (offline-grace tracking). */
function touchMemberSeen(fenceId, clientUid, atMs) {
  const fid = safeStr(fenceId).trim();
  const uid = safeStr(clientUid).trim();
  if (!fid || !uid) return;
  const state = ensureState();
  const row = state.membership[fid] && state.membership[fid][uid];
  if (!row || row.inside !== true) return;
  const ms = Number.isFinite(atMs) ? atMs : Date.now();
  row.lastSeenAt = new Date(ms).toISOString();
  markDirtyMembership(fid, uid, {
    fenceId: fid,
    clientUid: uid,
    inside: true,
    lastEnterAt: row.lastEnterAt,
    lastSeenAt: row.lastSeenAt,
    lastExitAt: row.lastExitAt,
  });
  scheduleStateFlush();
}

function clearFenceMembership(fenceId) {
  const fid = safeStr(fenceId).trim();
  const state = ensureState();
  if (state.membership[fid]) {
    delete state.membership[fid];
    markDirtyMembership(fid, "", { fenceId: fid, delete: true });
    scheduleStateFlush();
  }
}

function dropMember(fenceId, clientUid) {
  const fid = safeStr(fenceId).trim();
  const uid = safeStr(clientUid).trim();
  const state = ensureState();
  if (state.membership[fid] && state.membership[fid][uid]) {
    delete state.membership[fid][uid];
    markDirtyMembership(fid, uid, { fenceId: fid, clientUid: uid, delete: true });
    scheduleStateFlush();
  }
}

function wasMemberInside(fenceId, clientUid) {
  const map = getMembershipMap(fenceId);
  const row = map[safeStr(clientUid).trim()];
  return !!(row && row.inside === true);
}

function getMembershipSummary() {
  const state = ensureState();
  const summary = {};
  for (const [fid, block] of Object.entries(state.membership || {})) {
    summary[fid] = Object.keys(block || {}).length;
  }
  return summary;
}

function _resetForTests() {
  if (_stateFlushTimer) {
    clearTimeout(_stateFlushTimer);
    _stateFlushTimer = null;
  }
  _fences = null;
  _state = null;
  _stateDirty = false;
  _dirtyMemberships.clear();
  pendingReapplyEnter.clear();
}

module.exports = {
  FENCES_PATH,
  STATE_PATH,
  listFences,
  getFence,
  createFence,
  updateFence,
  deleteFence,
  ownerFromAuthUser,
  getMembershipMap,
  setMemberInside,
  touchMemberSeen,
  clearFenceMembership,
  dropMember,
  wasMemberInside,
  getMembershipSummary,
  flushStateNow,
  normalizeChannelActions,
  normalizeMissionActions,
  normalizeEnforceMode,
  markFenceForReapplyEnter,
  takePendingReapplyEnterIds,
  _resetForTests,
};
