/**
 * Persist channel patches under data/channel-patches.json.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const FILE = path.join(__dirname, "..", "data", "channel-patches.json");

const DIRECTIONS = new Set(["both", "from_hub", "to_hub"]);

let _cache = null;

function ensureDirExists(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeStr(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function normalizeDirection(raw) {
  const d = safeStr(raw).trim().toLowerCase();
  if (DIRECTIONS.has(d)) return d;
  return "both";
}

function normalizeSpoke(row) {
  const group = safeStr(row?.group || row?.name || row?.groupName).trim();
  if (!group) return null;
  return {
    group,
    direction: normalizeDirection(row?.direction),
  };
}

function normalizePatch(raw, { assignId = false } = {}) {
  if (!raw || typeof raw !== "object") return null;

  const hubGroup = safeStr(raw.hubGroup || raw.hub).trim();
  if (!hubGroup) return null;

  const spokeRows = Array.isArray(raw.spokes) ? raw.spokes : [];
  const spokes = [];
  const seen = new Set();
  const hubKey = hubGroup.toLowerCase();
  for (const row of spokeRows) {
    const spoke = normalizeSpoke(row);
    if (!spoke) continue;
    const key = spoke.group.toLowerCase();
    if (key === hubKey) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    spokes.push(spoke);
  }
  if (!spokes.length) return null;

  let id = safeStr(raw.id).trim();
  if (!id && assignId) id = crypto.randomUUID();
  if (!id) return null;

  const now = new Date().toISOString();
  return {
    id,
    name: safeStr(raw.name).trim() || "Untitled Patch",
    enabled: raw.enabled !== false && raw.enabled !== "false" && raw.enabled !== 0,
    hubGroup,
    spokes,
    createdBy: safeStr(raw.createdBy).trim() || "",
    createdAt: safeStr(raw.createdAt).trim() || now,
    updatedAt: safeStr(raw.updatedAt).trim() || now,
    agencyScope: Array.isArray(raw.agencyScope)
      ? raw.agencyScope.map((s) => safeStr(s).trim()).filter(Boolean)
      : [],
    lastForwardAt: safeStr(raw.lastForwardAt).trim() || null,
    lastError: safeStr(raw.lastError).trim() || null,
  };
}

function readFile() {
  try {
    if (!fs.existsSync(FILE)) return [];
    const raw = fs.readFileSync(FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn("[channelPatch.store] Failed to read:", err.message || err);
    return [];
  }
}

function writeFile(items) {
  ensureDirExists(FILE);
  fs.writeFileSync(FILE, JSON.stringify(items, null, 2));
}

function load() {
  if (_cache) return _cache.slice();
  const items = readFile()
    .map((row) => normalizePatch(row))
    .filter(Boolean);
  _cache = items;
  return items.slice();
}

function save(items) {
  const arr = (Array.isArray(items) ? items : [])
    .map((row) => normalizePatch(row))
    .filter(Boolean);
  _cache = arr;
  writeFile(arr);
  return arr.slice();
}

function list() {
  return load();
}

function listEnabled() {
  return load().filter((p) => p.enabled);
}

function getById(id) {
  const key = safeStr(id).trim();
  if (!key) return null;
  return load().find((p) => p.id === key) || null;
}

function create(input, actorName) {
  const patch = normalizePatch(
    {
      ...input,
      id: crypto.randomUUID(),
      createdBy: safeStr(actorName).trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastForwardAt: null,
      lastError: null,
    },
    { assignId: true }
  );
  if (!patch) {
    const err = new Error(
      "Invalid patch: require hub group and at least one distinct spoke."
    );
    err.status = 400;
    throw err;
  }
  const items = load();
  items.push(patch);
  save(items);
  return patch;
}

function update(id, patchFields) {
  const key = safeStr(id).trim();
  const items = load();
  const idx = items.findIndex((p) => p.id === key);
  if (idx < 0) {
    const err = new Error("Patch not found");
    err.status = 404;
    throw err;
  }

  const prev = items[idx];
  const merged = {
    ...prev,
    ...patchFields,
    id: prev.id,
    createdBy: prev.createdBy,
    createdAt: prev.createdAt,
    updatedAt: new Date().toISOString(),
  };

  if (patchFields && Object.prototype.hasOwnProperty.call(patchFields, "enabled")) {
    merged.enabled =
      patchFields.enabled !== false &&
      patchFields.enabled !== "false" &&
      patchFields.enabled !== 0;
  }

  const next = normalizePatch(merged);
  if (!next) {
    const err = new Error(
      "Invalid patch: require hub group and at least one distinct spoke."
    );
    err.status = 400;
    throw err;
  }

  // Preserve runtime status fields unless explicitly overwritten
  if (
    patchFields &&
    !Object.prototype.hasOwnProperty.call(patchFields, "lastForwardAt")
  ) {
    next.lastForwardAt = prev.lastForwardAt || null;
  }
  if (
    patchFields &&
    !Object.prototype.hasOwnProperty.call(patchFields, "lastError")
  ) {
    next.lastError = prev.lastError || null;
  }

  items[idx] = next;
  save(items);
  return next;
}

function remove(id) {
  const key = safeStr(id).trim();
  const items = load();
  const next = items.filter((p) => p.id !== key);
  if (next.length === items.length) {
    const err = new Error("Patch not found");
    err.status = 404;
    throw err;
  }
  save(next);
  return true;
}

function touchRuntime(id, { lastForwardAt, lastError } = {}) {
  const key = safeStr(id).trim();
  const items = load();
  const idx = items.findIndex((p) => p.id === key);
  if (idx < 0) return null;
  const row = { ...items[idx] };
  if (lastForwardAt !== undefined) row.lastForwardAt = lastForwardAt;
  if (lastError !== undefined) row.lastError = lastError;
  row.updatedAt = items[idx].updatedAt;
  items[idx] = row;
  _cache = items;
  // Soft write — avoid thrashing disk on every CoT; debounce via engine if needed
  writeFile(items);
  return row;
}

function invalidateCache() {
  _cache = null;
}

module.exports = {
  DIRECTIONS,
  list,
  listEnabled,
  getById,
  create,
  update,
  remove,
  touchRuntime,
  invalidateCache,
  normalizePatch,
  normalizeDirection,
};
