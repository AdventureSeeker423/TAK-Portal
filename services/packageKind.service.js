/**
 * Classify TAK file-sync metadata rows as data packages vs data sync missions.
 *
 * Explicit tag (set by Portal when archiving data sync): keyword "datasync"
 * Legacy rows are inferred from metadata shape (size, tool, filename, groups).
 */

const DATA_SYNC_KEYWORD = "datasync";
const PACKAGE_ACTIVE_KEYWORD = "missionpackage";
const ARCHIVED_KEYWORD = "ARCHIVED_MISSION";

const PORTAL_KIND = {
  DATA_PACKAGE: "data_package",
  DATA_SYNC: "data_sync",
};

function pickScalar(obj, keys) {
  if (!obj || typeof obj !== "object") return "";
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const v = obj[k];
    if (v == null || v === "") continue;
    if (typeof v === "string") {
      const s = v.trim();
      if (s) return s;
    } else if (typeof v === "number" || typeof v === "boolean") {
      return String(v).trim();
    }
  }
  return "";
}

function normalizeKeywords(record) {
  if (Array.isArray(record && record.keywords)) {
    return record.keywords.map((k) => String(k || "").trim()).filter(Boolean);
  }
  const raw = pickScalar(record, ["keywords", "Keywords", "keyword", "tags"]);
  if (!raw) return [];
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

function keywordSet(record) {
  return new Set(normalizeKeywords(record).map((k) => k.toLowerCase()));
}

function packageFilename(record) {
  return pickScalar(record, [
    "filename",
    "Filename",
    "fileName",
    "FileName",
    "name",
    "Name",
    "original_filename",
  ]);
}

function packageGroupCount(record) {
  const raw = pickScalar(record, ["groups", "Groups", "group", "Group"]);
  if (!raw) return 0;
  return raw
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean).length;
}

function parseSizeBytes(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return null;
  const direct = Number(s);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const m = s.match(/^([\d.]+)\s*([kmgt]?b)$/i);
  if (!m) return null;
  const val = parseFloat(m[1]);
  if (!Number.isFinite(val) || val < 0) return null;
  const unit = m[2].toLowerCase();
  if (unit === "b") return val;
  if (unit === "kb") return val * 1024;
  if (unit === "mb") return val * 1024 * 1024;
  if (unit === "gb") return val * 1024 * 1024 * 1024;
  if (unit === "tb") return val * 1024 * 1024 * 1024 * 1024;
  return null;
}

function packageSizeBytes(record) {
  const raw = pickScalar(record, ["size", "Size", "content_length", "contentLength"]);
  return parseSizeBytes(raw);
}

function hasDataSyncKeyword(record) {
  return keywordSet(record).has(DATA_SYNC_KEYWORD);
}

function hasArchivedKeyword(record) {
  return keywordSet(record).has(ARCHIVED_KEYWORD.toLowerCase());
}

function hasPackageActiveKeyword(record) {
  return keywordSet(record).has(PACKAGE_ACTIVE_KEYWORD.toLowerCase());
}

function nameSuggestsDataSync(name) {
  return /data\s*sync/i.test(String(name || ""));
}

/** Small mission-style file sync row (not a uploaded map/layer zip). */
function isMissionLikeMetadata(record) {
  const name = packageFilename(record);
  if (nameSuggestsDataSync(name)) return true;
  if (/\.zip$/i.test(name)) return false;

  const tool = pickScalar(record, ["tool", "Tool"]).toLowerCase();
  if (tool === "public") return false;

  const bytes = packageSizeBytes(record);
  if (bytes != null && bytes > 512 * 1024) return false;

  const groups = packageGroupCount(record);
  if (groups > 1) return false;

  if (bytes != null && bytes <= 128 * 1024) return true;
  return !/\.zip$/i.test(name) && groups === 1;
}

function classifyPackageRecord(record) {
  if (hasDataSyncKeyword(record)) {
    return PORTAL_KIND.DATA_SYNC;
  }

  if (hasArchivedKeyword(record)) {
    return isMissionLikeMetadata(record)
      ? PORTAL_KIND.DATA_SYNC
      : PORTAL_KIND.DATA_PACKAGE;
  }

  if (hasPackageActiveKeyword(record)) {
    return isMissionLikeMetadata(record)
      ? PORTAL_KIND.DATA_SYNC
      : PORTAL_KIND.DATA_PACKAGE;
  }

  return isMissionLikeMetadata(record)
    ? PORTAL_KIND.DATA_SYNC
    : PORTAL_KIND.DATA_PACKAGE;
}

function isDataSyncRecord(record) {
  return classifyPackageRecord(record) === PORTAL_KIND.DATA_SYNC;
}

function isDataPackageRecord(record) {
  return classifyPackageRecord(record) === PORTAL_KIND.DATA_PACKAGE;
}

function annotatePackageRecord(record) {
  const portalKind = classifyPackageRecord(record);
  return {
    ...record,
    portalKind,
    portalKindIsDataSync: portalKind === PORTAL_KIND.DATA_SYNC,
    portalKindIsDataPackage: portalKind === PORTAL_KIND.DATA_PACKAGE,
  };
}

function archivedDataSyncKeywords() {
  return [ARCHIVED_KEYWORD, DATA_SYNC_KEYWORD];
}

module.exports = {
  DATA_SYNC_KEYWORD,
  PACKAGE_ACTIVE_KEYWORD,
  ARCHIVED_KEYWORD,
  PORTAL_KIND,
  classifyPackageRecord,
  isDataSyncRecord,
  isDataPackageRecord,
  annotatePackageRecord,
  archivedDataSyncKeywords,
};
