const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const agenciesStore = require("./agencies.service");

const FILE = path.join(__dirname, "../data/regions.json");
const LOCKS_FILE = path.join(__dirname, "../data/regionCountyLocks.json");

function ensureDirExists(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function load() {
  try {
    if (!fs.existsSync(FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn("[regions] Failed to read regions.json:", err?.message || err);
    return [];
  }
}

function save(data) {
  ensureDirExists(FILE);
  const list = Array.isArray(data) ? data : [];
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
  return list;
}

function normalizeName(raw) {
  return String(raw || "")
    .trim()
    .replace(/\s+/g, " ");
}

function nameKey(raw) {
  return normalizeName(raw).toLowerCase();
}

function normalizeCountyName(raw) {
  return normalizeName(raw);
}

function countyLockKey(state, county) {
  return `${String(state || "").trim().toUpperCase()}|${normalizeCountyName(county).toLowerCase()}`;
}

function stateLockKey(state) {
  return `${String(state || "").trim().toUpperCase()}|__STATE__`;
}

function loadLocks() {
  try {
    if (!fs.existsSync(LOCKS_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(LOCKS_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn(
      "[regions] Failed to read regionCountyLocks.json:",
      err?.message || err
    );
    return [];
  }
}

function saveLocks(data) {
  ensureDirExists(LOCKS_FILE);
  const list = Array.isArray(data) ? data : [];
  fs.writeFileSync(LOCKS_FILE, JSON.stringify(list, null, 2));
  return list;
}

function normalizeLock(lock) {
  if (!lock || typeof lock !== "object") return null;
  const regionId = String(lock.regionId || "").trim();
  const state = String(lock.state || "").trim().toUpperCase();
  const county = normalizeCountyName(lock.county);
  if (!regionId || !state) return null;

  const rawScope = String(lock.scope || "").trim().toLowerCase();
  const scope =
    rawScope === "state" || (!county && rawScope !== "county")
      ? "state"
      : "county";

  if (scope === "county") {
    if (!county) return null;
    return { scope: "county", regionId, state, county };
  }
  return { scope: "state", regionId, state };
}

function listLocks() {
  return loadLocks()
    .map(normalizeLock)
    .filter(Boolean)
    .sort((a, b) => {
      const sa = a.state.localeCompare(b.state);
      if (sa) return sa;
      if (a.scope !== b.scope) return a.scope === "state" ? -1 : 1;
      return String(a.county || "").localeCompare(String(b.county || ""), undefined, {
        sensitivity: "base",
      });
    });
}

function findStateLock(stateRaw, locks) {
  const state = String(stateRaw || "").trim().toUpperCase();
  if (!state) return null;
  const list = Array.isArray(locks) ? locks : listLocks();
  return list.find((l) => l.scope === "state" && l.state === state) || null;
}

function findCountyLock(stateRaw, countyRaw, locks) {
  const state = String(stateRaw || "").trim().toUpperCase();
  const county = normalizeCountyName(countyRaw);
  if (!state || !county) return null;
  const key = countyLockKey(state, county);
  const list = Array.isArray(locks) ? locks : listLocks();
  return (
    list.find(
      (l) =>
        l.scope === "county" &&
        countyLockKey(l.state, l.county) === key
    ) || null
  );
}

/**
 * Effective lock for a location: state lock wins over county lock.
 */
function findEffectiveLock(stateRaw, countyRaw, locks) {
  const list = Array.isArray(locks) ? locks : listLocks();
  const stateLock = findStateLock(stateRaw, list);
  if (stateLock) return stateLock;
  return findCountyLock(stateRaw, countyRaw, list);
}

function updateAgenciesRegion(predicate, regionId) {
  const key = String(regionId || "").trim();
  if (!key) return 0;
  const agencies = agenciesStore.load();
  let agenciesUpdated = 0;
  for (const a of agencies) {
    if (!predicate(a)) continue;
    if (String(a.regionId || "").trim() !== key) {
      a.regionId = key;
      agenciesUpdated += 1;
    }
  }
  if (agenciesUpdated > 0) {
    agenciesStore.save(agencies);
  }
  return agenciesUpdated;
}

/**
 * Lock an entire state to a region. Rejects if any county locks exist for that state.
 * Updates regionId on all agencies in the state.
 */
function lockState(regionId, stateRaw) {
  const key = String(regionId || "").trim();
  if (!key) throw new Error("Region id is required");
  if (!findById(key)) throw new Error("Region not found");

  const state = String(stateRaw || "").trim().toUpperCase();
  if (!state) throw new Error("State is required");

  const locks = loadLocks().map(normalizeLock).filter(Boolean);
  const countyLocksInState = locks.filter(
    (l) => l.scope === "county" && l.state === state
  );
  if (countyLocksInState.length) {
    throw new Error(
      `Cannot lock entire state ${state} while county locks exist. Unlock those counties first.`
    );
  }

  const next = locks.filter(
    (l) => !(l.scope === "state" && l.state === state)
  );
  next.push({ scope: "state", regionId: key, state });
  saveLocks(next);

  const agenciesUpdated = updateAgenciesRegion((a) => {
    return String(a?.state || "").trim().toUpperCase() === state;
  }, key);

  return {
    lock: { scope: "state", regionId: key, state },
    agenciesUpdated,
  };
}

/**
 * Lock a state+county to a region. Rejects if the entire state is already locked.
 * Also sets regionId on existing agencies in that county.
 */
function lockCounty(regionId, stateRaw, countyRaw) {
  const key = String(regionId || "").trim();
  if (!key) throw new Error("Region id is required");
  if (!findById(key)) throw new Error("Region not found");

  const state = String(stateRaw || "").trim().toUpperCase();
  const county = normalizeCountyName(countyRaw);
  if (!state) throw new Error("State is required");
  if (!county) throw new Error("County is required");

  const locks = loadLocks().map(normalizeLock).filter(Boolean);
  if (findStateLock(state, locks)) {
    throw new Error(
      `Cannot lock a county in ${state} because the entire state is locked. Unlock the state first.`
    );
  }

  const lockKey = countyLockKey(state, county);
  const next = locks.filter(
    (l) =>
      !(l.scope === "county" && countyLockKey(l.state, l.county) === lockKey)
  );
  next.push({ scope: "county", regionId: key, state, county });
  saveLocks(next);

  const agenciesUpdated = updateAgenciesRegion((a) => {
    const aState = String(a?.state || "").trim().toUpperCase();
    const aCounty = normalizeCountyName(a?.county);
    return (
      aState === state && aCounty.toLowerCase() === county.toLowerCase()
    );
  }, key);

  return {
    lock: { scope: "county", regionId: key, state, county },
    agenciesUpdated,
  };
}

/**
 * Lock helper: empty/missing county → state lock; otherwise county lock.
 */
function lockLocation(regionId, stateRaw, countyRaw) {
  const county = normalizeCountyName(countyRaw);
  if (!county) return lockState(regionId, stateRaw);
  return lockCounty(regionId, stateRaw, county);
}

function unlockState(stateRaw) {
  const state = String(stateRaw || "").trim().toUpperCase();
  if (!state) throw new Error("State is required");

  const locks = loadLocks().map(normalizeLock).filter(Boolean);
  const before = locks.length;
  const next = locks.filter((l) => !(l.scope === "state" && l.state === state));
  if (next.length === before) {
    throw new Error("State lock not found");
  }
  saveLocks(next);
  return { unlocked: { scope: "state", state } };
}

function unlockCounty(stateRaw, countyRaw) {
  const state = String(stateRaw || "").trim().toUpperCase();
  const county = normalizeCountyName(countyRaw);
  if (!state) throw new Error("State is required");
  if (!county) throw new Error("County is required");

  const lockKey = countyLockKey(state, county);
  const locks = loadLocks().map(normalizeLock).filter(Boolean);
  const before = locks.length;
  const next = locks.filter(
    (l) =>
      !(l.scope === "county" && countyLockKey(l.state, l.county) === lockKey)
  );
  if (next.length === before) {
    throw new Error("County lock not found");
  }
  saveLocks(next);
  return { unlocked: { scope: "county", state, county } };
}

/**
 * Unlock helper: empty/missing county → state unlock; otherwise county unlock.
 */
function unlockLocation(stateRaw, countyRaw) {
  const county = normalizeCountyName(countyRaw);
  if (!county) return unlockState(stateRaw);
  return unlockCounty(stateRaw, county);
}

function clearLocksForRegion(regionId) {
  const key = String(regionId || "").trim();
  if (!key) return 0;
  const locks = loadLocks().map(normalizeLock).filter(Boolean);
  const next = locks.filter((l) => l.regionId !== key);
  const cleared = locks.length - next.length;
  if (cleared > 0) saveLocks(next);
  return cleared;
}

function locksForRegion(regionId, locks) {
  const key = String(regionId || "").trim();
  if (!key) return [];
  const list = Array.isArray(locks) ? locks : listLocks();
  return list.filter((l) => l.regionId === key);
}

/**
 * Effective locked region for an agency (state lock wins over county lock).
 * State locks apply to state/federal agencies too.
 */
function lockedRegionIdForAgency(agency) {
  if (!agency) return null;
  const lock = findEffectiveLock(agency.state, agency.county);
  return lock ? lock.regionId : null;
}

function normalizeRegion(r) {
  if (!r || typeof r !== "object") return null;
  const id = String(r.id || "").trim();
  const name = normalizeName(r.name);
  if (!id || !name) return null;
  return { id, name };
}

function listNormalized() {
  return load()
    .map(normalizeRegion)
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

function findById(id, regions) {
  const key = String(id || "").trim();
  if (!key) return null;
  const list = Array.isArray(regions) ? regions : load();
  return list.find((r) => String(r?.id || "").trim() === key) || null;
}

function findByName(name, regions) {
  const key = nameKey(name);
  if (!key) return null;
  const list = Array.isArray(regions) ? regions : load();
  return list.find((r) => nameKey(r?.name) === key) || null;
}

function assertUniqueName(name, excludeId) {
  const key = nameKey(name);
  if (!key) return "Region name is required";
  const exclude = String(excludeId || "").trim();
  for (const r of load()) {
    if (exclude && String(r?.id || "").trim() === exclude) continue;
    if (nameKey(r?.name) === key) return "Region name already exists";
  }
  return null;
}

function create(nameRaw) {
  const name = normalizeName(nameRaw);
  const err = assertUniqueName(name);
  if (err) throw new Error(err);

  const region = {
    id: crypto.randomUUID(),
    name,
  };
  const list = load();
  list.push(region);
  save(list);
  return region;
}

/**
 * Rename a region in the registry only (Authentik rename is handled separately).
 */
function renameInStore(id, newNameRaw) {
  const key = String(id || "").trim();
  if (!key) throw new Error("Region id is required");

  const name = normalizeName(newNameRaw);
  const err = assertUniqueName(name, key);
  if (err) throw new Error(err);

  const list = load();
  const idx = list.findIndex((r) => String(r?.id || "").trim() === key);
  if (idx < 0) throw new Error("Region not found");

  const prev = list[idx];
  const oldName = normalizeName(prev?.name);
  list[idx] = { id: key, name };
  save(list);
  return { region: list[idx], oldName, newName: name };
}

/**
 * Delete region, clear agency regionIds, and remove county locks for this region.
 */
function remove(id) {
  const key = String(id || "").trim();
  if (!key) throw new Error("Region id is required");

  const list = load();
  const idx = list.findIndex((r) => String(r?.id || "").trim() === key);
  if (idx < 0) throw new Error("Region not found");

  const removed = list[idx];
  list.splice(idx, 1);
  save(list);

  const locksCleared = clearLocksForRegion(key);

  const agencies = agenciesStore.load();
  let agenciesCleared = 0;
  for (const a of agencies) {
    if (String(a?.regionId || "").trim() === key) {
      delete a.regionId;
      agenciesCleared += 1;
    }
  }
  if (agenciesCleared > 0) {
    agenciesStore.save(agencies);
  }

  return { region: removed, agenciesCleared, locksCleared };
}

function agenciesForRegion(regionId, agencies) {
  const key = String(regionId || "").trim();
  if (!key) return [];
  const list = Array.isArray(agencies) ? agencies : agenciesStore.load();
  return list.filter((a) => String(a?.regionId || "").trim() === key);
}

/**
 * Resolve regionId from raw id or region name (for CSV / API flexibility).
 * Empty input → null. Unknown → throws.
 */
function resolveRegionId(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;

  const byId = findById(s);
  if (byId) return String(byId.id);

  const byName = findByName(s);
  if (byName) return String(byName.id);

  throw new Error(`Unknown region: ${s}`);
}

function getRegionName(regionId) {
  const r = findById(regionId);
  return r ? normalizeName(r.name) : "";
}

/** Longest-name-first list for group name parsing. */
function namesLongestFirst() {
  return listNormalized()
    .map((r) => r.name)
    .sort((a, b) => b.length - a.length);
}

module.exports = {
  FILE,
  LOCKS_FILE,
  load,
  save,
  listNormalized,
  normalizeName,
  nameKey,
  normalizeRegion,
  findById,
  findByName,
  assertUniqueName,
  create,
  renameInStore,
  remove,
  agenciesForRegion,
  listLocks,
  findStateLock,
  findCountyLock,
  findEffectiveLock,
  lockState,
  lockCounty,
  lockLocation,
  unlockState,
  unlockCounty,
  unlockLocation,
  locksForRegion,
  lockedRegionIdForAgency,
  resolveRegionId,
  getRegionName,
  namesLongestFirst,
};
