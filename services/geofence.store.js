/**
 * Persist portal geofences and membership state under data/.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { validateGeometry } = require("./geofence.geometry");

const FENCES_PATH = path.join(__dirname, "..", "data", "geofences.json");
const STATE_PATH = path.join(__dirname, "..", "data", "geofence-state.json");

let _fences = null;
let _state = null;
let _stateDirty = false;
let _stateFlushTimer = null;

function ensureDirExists(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (err) {
    console.warn(`[geofence.store] Failed to read ${filePath}:`, err.message || err);
    return fallback;
  }
}

function writeJsonSafe(filePath, value) {
  ensureDirExists(filePath);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function safeStr(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
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
  const parsed = readJsonSafe(FENCES_PATH, { fences: [] });
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
  writeJsonSafe(FENCES_PATH, { fences, updatedAt: new Date().toISOString() });
}

function loadState() {
  const parsed = readJsonSafe(STATE_PATH, { membership: {} });
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

function flushStateNow() {
  if (!_stateDirty || _state === null) return;
  writeJsonSafe(STATE_PATH, {
    membership: _state.membership,
    updatedAt: new Date().toISOString(),
  });
  _stateDirty = false;
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
  if (inside) {
    state.membership[fid][uid] = {
      inside: true,
      lastEnterAt: now,
      lastExitAt: state.membership[fid][uid]?.lastExitAt || null,
    };
  } else {
    delete state.membership[fid][uid];
  }
  scheduleStateFlush();
}

function clearFenceMembership(fenceId) {
  const fid = safeStr(fenceId).trim();
  const state = ensureState();
  if (state.membership[fid]) {
    delete state.membership[fid];
    scheduleStateFlush();
  }
}

function dropMember(fenceId, clientUid) {
  const fid = safeStr(fenceId).trim();
  const uid = safeStr(clientUid).trim();
  const state = ensureState();
  if (state.membership[fid] && state.membership[fid][uid]) {
    delete state.membership[fid][uid];
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
  clearFenceMembership,
  dropMember,
  wasMemberInside,
  getMembershipSummary,
  flushStateNow,
  normalizeChannelActions,
  normalizeMissionActions,
  markFenceForReapplyEnter,
  takePendingReapplyEnterIds,
  _resetForTests,
};
