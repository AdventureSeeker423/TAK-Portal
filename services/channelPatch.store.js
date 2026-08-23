/**
 * Persist channel patches under data/channel-patches.json.
 *
 * Model: a named set of channels patched together (full mesh, both directions).
 * Legacy hub/spokes rows are migrated on read.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const FILE = path.join(__dirname, "..", "data", "channel-patches.json");

let _cache = null;

function ensureDirExists(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeStr(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function groupDedupeKey(name) {
  return safeStr(name).trim().toLowerCase();
}

/** Match Authentik `tak_` names to catalog / patch group names. */
function groupMatchKey(name) {
  let n = safeStr(name).trim();
  if (n.toLowerCase().startsWith("tak_")) n = n.slice(4);
  return n.toLowerCase().replace(/\s+/g, " ").trim();
}

function groupDisplayLabel(name) {
  let n = safeStr(name).trim();
  if (n.toLowerCase().startsWith("tak_")) n = n.slice(4);
  return n;
}

/**
 * For each channel in enabled patches, the other channels it is patched with.
 * @param {Array<{ enabled?: boolean, groups?: string[] }>} patches
 * @returns {Map<string, string[]>} matchKey -> sorted peer display labels
 */
function peerLabelsByGroupKeyFromPatches(patches) {
  const byKey = new Map();
  for (const p of Array.isArray(patches) ? patches : []) {
    if (!p || p.enabled === false) continue;
    const items = (Array.isArray(p.groups) ? p.groups : [])
      .map((g) => ({ key: groupMatchKey(g), label: groupDisplayLabel(g) }))
      .filter((x) => x.key);
    for (const src of items) {
      if (!byKey.has(src.key)) byKey.set(src.key, new Map());
      const peers = byKey.get(src.key);
      for (const dst of items) {
        if (dst.key === src.key) continue;
        if (!peers.has(dst.key)) peers.set(dst.key, dst.label);
      }
    }
  }
  const out = new Map();
  for (const [k, peers] of byKey) {
    out.set(
      k,
      Array.from(peers.values()).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" })
      )
    );
  }
  return out;
}

function enabledPeerLabelsByGroupKey() {
  return peerLabelsByGroupKeyFromPatches(listEnabled());
}

function annotateGroupsWithPatchPeers(groups) {
  const index = enabledPeerLabelsByGroupKey();
  if (!index.size) return Array.isArray(groups) ? groups : [];
  return (Array.isArray(groups) ? groups : []).map((g) => {
    const peers = index.get(groupMatchKey(g && g.name));
    if (!peers || !peers.length) return g;
    return Object.assign({}, g, { patchedWith: peers });
  });
}

/**
 * Accept modern `groups: string[]` or legacy hub + spokes.
 * @returns {string[]}
 */
function extractGroupNames(raw) {
  const out = [];
  const seen = new Set();

  function push(name) {
    const g = safeStr(name).trim();
    if (!g) return;
    const key = groupDedupeKey(g);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(g);
  }

  if (Array.isArray(raw?.groups)) {
    for (const item of raw.groups) {
      if (typeof item === "string" || typeof item === "number") {
        push(item);
      } else if (item && typeof item === "object") {
        push(item.group || item.name || item.groupName);
      }
    }
  }

  // Legacy hub / spokes → flat mesh
  if (!out.length) {
    push(raw?.hubGroup || raw?.hub);
    const spokes = Array.isArray(raw?.spokes) ? raw.spokes : [];
    for (const row of spokes) {
      if (typeof row === "string" || typeof row === "number") {
        push(row);
      } else if (row && typeof row === "object") {
        push(row.group || row.name || row.groupName);
      }
    }
  }

  return out;
}

function normalizePatch(raw, { assignId = false } = {}) {
  if (!raw || typeof raw !== "object") return null;

  const groups = extractGroupNames(raw);
  if (groups.length < 2) return null;

  let id = safeStr(raw.id).trim();
  if (!id && assignId) id = crypto.randomUUID();
  if (!id) return null;

  const now = new Date().toISOString();
  return {
    id,
    name: safeStr(raw.name).trim() || "Untitled Patch",
    enabled: raw.enabled !== false && raw.enabled !== "false" && raw.enabled !== 0,
    groups,
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
      "Invalid patch: select at least two distinct channels."
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
      "Invalid patch: select at least two distinct channels."
    );
    err.status = 400;
    throw err;
  }

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
  writeFile(items);
  return row;
}

function invalidateCache() {
  _cache = null;
}

module.exports = {
  list,
  listEnabled,
  getById,
  create,
  update,
  remove,
  touchRuntime,
  invalidateCache,
  normalizePatch,
  extractGroupNames,
  groupMatchKey,
  groupDisplayLabel,
  peerLabelsByGroupKeyFromPatches,
  enabledPeerLabelsByGroupKey,
  annotateGroupsWithPatchPeers,
};
