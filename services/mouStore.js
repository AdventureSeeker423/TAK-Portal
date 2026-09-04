const fs = require("fs");
const path = require("path");
const pgCache = require("./pgCache");

const DATA_DIR = path.join(__dirname, "..", "data");
const ROOT_DIR = path.join(DATA_DIR, "mou");
const VERSIONS_DIR = path.join(ROOT_DIR, "versions");
const SIGNED_DIR = path.join(ROOT_DIR, "signed");
const SIGNATURES_DIR = path.join(ROOT_DIR, "signatures");

const INDEX_PATH = null;
const USER_AGREEMENT_PATH = null;
const ACKS_PATH = null;
const VIEWS_PATH = null;
const REMINDERS_PATH = null;
const ARCHIVED_DOCUMENTS_PATH = null;
const SIGN_INVITES_PATH = null;

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureParentDir(filePath) {
  if (!filePath) return;
  ensureDir(path.dirname(filePath));
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[mou-store] Failed to read ${filePath}:`, err?.message || err);
    return fallback;
  }
}

function atomicWriteFile(filePath, content, encoding) {
  if (!filePath) return;
  ensureParentDir(filePath);
  const tmpPath = `${filePath}.tmp`;
  if (Buffer.isBuffer(content)) {
    fs.writeFileSync(tmpPath, content);
  } else {
    fs.writeFileSync(tmpPath, content, encoding || "utf8");
  }
  fs.renameSync(tmpPath, filePath);
}

function atomicWriteJson(filePath, value) {
  atomicWriteFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function ensureStorage() {
  ensureDir(ROOT_DIR);
  ensureDir(VERSIONS_DIR);
  ensureDir(SIGNED_DIR);
  ensureDir(SIGNATURES_DIR);
  // JSON indexes live in Postgres (pgCache). Only binary/HTML dirs stay on disk.
}

function normalizeVersion(version) {
  const parsed = Number.parseInt(String(version || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeSegment(value) {
  return String(value || "").trim();
}

function getVersionPath(mouId, version) {
  return path.join(VERSIONS_DIR, normalizeSegment(mouId), `${normalizeVersion(version)}.html`);
}

function normalizeExtension(extension, fallback) {
  const ext = String(extension || "").trim().replace(/^\.+/, "").toLowerCase();
  return ext || String(fallback || "html").trim().replace(/^\.+/, "").toLowerCase();
}

function getVersionContentPath(mouId, version, extension) {
  return path.join(
    VERSIONS_DIR,
    normalizeSegment(mouId),
    `${normalizeVersion(version)}.${normalizeExtension(extension, "html")}`
  );
}

function getSignedHtmlPath(mouId, agencyId, version) {
  return path.join(
    SIGNED_DIR,
    normalizeSegment(mouId),
    normalizeSegment(agencyId),
    `${normalizeVersion(version)}.html`
  );
}

function getSignedContentPath(mouId, agencyId, version, extension) {
  return path.join(
    SIGNED_DIR,
    normalizeSegment(mouId),
    normalizeSegment(agencyId),
    `${normalizeVersion(version)}-content.${normalizeExtension(extension, "html")}`
  );
}

function getSignaturePngPath(mouId, agencyId, version) {
  return path.join(
    SIGNATURES_DIR,
    normalizeSegment(mouId),
    normalizeSegment(agencyId),
    `${normalizeVersion(version)}.png`
  );
}

function getSignedUploadPath(mouId, agencyId, version, extension) {
  return path.join(
    SIGNED_DIR,
    normalizeSegment(mouId),
    normalizeSegment(agencyId),
    `${normalizeVersion(version)}-upload.${normalizeExtension(extension, "pdf")}`
  );
}

function getCountersignaturePngPath(mouId, agencyId, version) {
  return path.join(
    SIGNATURES_DIR,
    normalizeSegment(mouId),
    normalizeSegment(agencyId),
    `${normalizeVersion(version)}-countersign.png`
  );
}

function getCountersignUploadPath(mouId, agencyId, version, extension) {
  return path.join(
    SIGNED_DIR,
    normalizeSegment(mouId),
    normalizeSegment(agencyId),
    `${normalizeVersion(version)}-countersign-upload.${normalizeExtension(extension, "pdf")}`
  );
}

function loadIndex() {
  ensureStorage();
  return pgCache.caches.mouIndex || { schemaVersion: 1, streams: [] };
}

function saveIndex(data) {
  ensureStorage();
  pgCache.replaceMouIndex(data || { schemaVersion: 1, streams: [] });
}

function loadUserAgreement() {
  ensureStorage();
  return pgCache.caches.mouAgreement || {
    schemaVersion: 1,
    enabled: false,
    currentVersion: 0,
    versions: [],
  };
}

function saveUserAgreement(data) {
  ensureStorage();
  pgCache.replaceMouAgreement(data);
}

function loadAcks() {
  ensureStorage();
  return pgCache.caches.mouAcks || { schemaVersion: 1, items: [] };
}

function saveAcks(data) {
  ensureStorage();
  pgCache.replaceMouAcks(data);
}

function loadViews() {
  ensureStorage();
  return pgCache.caches.mouViews || { schemaVersion: 1, items: [] };
}

function saveViews(data) {
  ensureStorage();
  pgCache.replaceMouViews(data);
}

function loadReminders() {
  ensureStorage();
  return pgCache.caches.mouReminders || { schemaVersion: 1, agency: {} };
}

function saveReminders(data) {
  ensureStorage();
  pgCache.replaceMouReminders(data);
}

function loadArchivedDocuments() {
  ensureStorage();
  return pgCache.caches.mouArchived || { schemaVersion: 1, items: [] };
}

function saveArchivedDocuments(data) {
  ensureStorage();
  pgCache.replaceMouArchived(data);
}

function loadSignInvites() {
  ensureStorage();
  return pgCache.caches.mouInvites || { schemaVersion: 1, items: [] };
}

function saveSignInvites(data) {
  ensureStorage();
  pgCache.replaceMouInvites(data);
}

function readHtml(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return "";
  }
}

function writeHtml(filePath, html) {
  atomicWriteFile(filePath, String(html || ""), "utf8");
}

function writeBinary(filePath, buffer) {
  atomicWriteFile(filePath, buffer);
}

function deleteFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.warn(`[mou-store] Failed to delete ${filePath}:`, err?.message || err);
  }
}

module.exports = {
  ROOT_DIR,
  INDEX_PATH,
  USER_AGREEMENT_PATH,
  ACKS_PATH,
  VIEWS_PATH,
  REMINDERS_PATH,
  ARCHIVED_DOCUMENTS_PATH,
  SIGN_INVITES_PATH,
  ensureStorage,
  loadIndex,
  saveIndex,
  loadUserAgreement,
  saveUserAgreement,
  loadAcks,
  saveAcks,
  loadViews,
  saveViews,
  loadReminders,
  saveReminders,
  loadArchivedDocuments,
  saveArchivedDocuments,
  loadSignInvites,
  saveSignInvites,
  getVersionPath,
  getVersionContentPath,
  getSignedHtmlPath,
  getSignedContentPath,
  getSignaturePngPath,
  getSignedUploadPath,
  getCountersignaturePngPath,
  getCountersignUploadPath,
  readHtml,
  writeHtml,
  writeBinary,
  deleteFile,
};
