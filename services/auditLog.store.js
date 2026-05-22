const fs = require("fs");
const path = require("path");

// Keep consistent with other stores (mutual-aid, user-requests, templates):
// plain JSON array persisted under /data.
const FILE = path.join(__dirname, "../data/audit-log.json");

/** Max on-disk size for audit-log.json before oldest entries are dropped. */
const MAX_FILE_BYTES =
  parseInt(process.env.AUDIT_LOG_MAX_FILE_BYTES, 10) || 2 * 1024 * 1024 * 1024;

/** Trim target — stay under max so we do not re-trim on every write. */
const TRIM_TARGET_BYTES = Math.floor(MAX_FILE_BYTES * 0.92);

function jsonByteLength(arr) {
  return Buffer.byteLength(JSON.stringify(arr, null, 2), "utf8");
}

/**
 * Newest-first array: index 0 is latest; drop from the end (oldest) until under limit.
 * @returns {{ items: object[], removed: number }}
 */
function trimOldestToMaxBytes(items, maxBytes = TRIM_TARGET_BYTES) {
  const arr = Array.isArray(items) ? items.slice() : [];
  if (!arr.length) return { items: arr, removed: 0 };

  let removed = 0;
  while (arr.length > 0 && jsonByteLength(arr) > maxBytes) {
    const drop = Math.max(1, Math.ceil(arr.length * 0.1));
    arr.splice(-drop);
    removed += drop;
  }
  return { items: arr, removed };
}

function load() {
  if (!fs.existsSync(FILE)) return [];
  try {
    let fileSize = 0;
    try {
      fileSize = fs.statSync(FILE).size;
    } catch (_) {
      fileSize = 0;
    }

    const raw = fs.readFileSync(FILE, "utf8");
    const data = JSON.parse(raw);
    const arr = Array.isArray(data) ? data : [];
    if (!arr.length) return [];

    if (fileSize <= MAX_FILE_BYTES && jsonByteLength(arr) <= MAX_FILE_BYTES) {
      return arr;
    }

    const { items, removed } = trimOldestToMaxBytes(arr, TRIM_TARGET_BYTES);
    if (removed > 0) {
      try {
        fs.writeFileSync(FILE, JSON.stringify(items, null, 2));
        console.warn(
          `[audit] trimmed ${removed} oldest log entries on load (file was ~${Math.round(fileSize / (1024 * 1024))} MB, limit ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB)`
        );
      } catch (e) {
        console.warn("[audit] failed to rewrite trimmed audit log:", e?.message || e);
      }
    }
    return items;
  } catch {
    return [];
  }
}

function save(items) {
  let arr = Array.isArray(items) ? items : [];
  const { items: trimmed, removed } = trimOldestToMaxBytes(arr, TRIM_TARGET_BYTES);
  arr = trimmed;
  if (removed > 0) {
    console.warn(
      `[audit] trimmed ${removed} oldest log entries before save (limit ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB)`
    );
  }
  fs.writeFileSync(FILE, JSON.stringify(arr, null, 2));
}

module.exports = {
  FILE,
  MAX_FILE_BYTES,
  TRIM_TARGET_BYTES,
  trimOldestToMaxBytes,
  load,
  save,
};
