const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const agenciesStore = require("./agencies.service");

const FILE = path.join(__dirname, "../data/regions.json");

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
 * Delete region and clear regionId on all agencies that referenced it.
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

  return { region: removed, agenciesCleared };
}

function agenciesForRegion(regionId, agencies) {
  const key = String(regionId || "").trim();
  if (!key) return [];
  const list = Array.isArray(agencies) ? agencies : agenciesStore.load();
  return list.filter((a) => String(a?.regionId || "").trim() === key);
}

/**
 * Set regionId on all agencies matching state + county (case-insensitive).
 * @returns {{ updated: number, agencies: object[] }}
 */
function assignCountyToRegion(regionId, stateRaw, countyRaw) {
  const key = String(regionId || "").trim();
  if (!key) throw new Error("Region id is required");
  if (!findById(key)) throw new Error("Region not found");

  const state = String(stateRaw || "").trim().toUpperCase();
  const county = String(countyRaw || "").trim();
  if (!state) throw new Error("State is required");
  if (!county) throw new Error("County is required");

  const countyLower = county.toLowerCase();
  const agencies = agenciesStore.load();
  const updatedAgencies = [];
  let updated = 0;

  for (const a of agencies) {
    const aState = String(a?.state || "").trim().toUpperCase();
    const aCounty = String(a?.county || "").trim();
    if (aState !== state) continue;
    if (aCounty.toLowerCase() !== countyLower) continue;
    if (String(a.regionId || "").trim() !== key) {
      a.regionId = key;
      updated += 1;
    }
    updatedAgencies.push(a);
  }

  if (updated > 0) {
    agenciesStore.save(agencies);
  }

  return { updated, matched: updatedAgencies.length, agencies: updatedAgencies };
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
  assignCountyToRegion,
  resolveRegionId,
  getRegionName,
  namesLongestFirst,
};
