const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const ROOT_DIR = path.join(DATA_DIR, "mou");
const VERSIONS_DIR = path.join(ROOT_DIR, "versions");
const SIGNED_DIR = path.join(ROOT_DIR, "signed");
const SIGNATURES_DIR = path.join(ROOT_DIR, "signatures");

const INDEX_PATH = path.join(ROOT_DIR, "index.json");
const USER_AGREEMENT_PATH = path.join(ROOT_DIR, "user-agreement.json");
const ACKS_PATH = path.join(ROOT_DIR, "acks.json");
const VIEWS_PATH = path.join(ROOT_DIR, "views.json");
const REMINDERS_PATH = path.join(ROOT_DIR, "reminders.json");

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureParentDir(filePath) {
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

  if (!fs.existsSync(INDEX_PATH)) {
    atomicWriteJson(INDEX_PATH, {
      schemaVersion: 1,
      streams: [],
    });
  }

  if (!fs.existsSync(USER_AGREEMENT_PATH)) {
    atomicWriteJson(USER_AGREEMENT_PATH, {
      schemaVersion: 1,
      currentVersion: 0,
      versions: [],
    });
  }

  if (!fs.existsSync(ACKS_PATH)) {
    atomicWriteJson(ACKS_PATH, {
      schemaVersion: 1,
      items: [],
    });
  }

  if (!fs.existsSync(VIEWS_PATH)) {
    atomicWriteJson(VIEWS_PATH, {
      schemaVersion: 1,
      items: [],
    });
  }

  if (!fs.existsSync(REMINDERS_PATH)) {
    atomicWriteJson(REMINDERS_PATH, {
      schemaVersion: 1,
      agency: {},
    });
  }
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

function loadIndex() {
  ensureStorage();
  return readJsonFile(INDEX_PATH, { schemaVersion: 1, streams: [] });
}

function saveIndex(data) {
  ensureStorage();
  atomicWriteJson(INDEX_PATH, data);
}

function loadUserAgreement() {
  ensureStorage();
  return readJsonFile(USER_AGREEMENT_PATH, {
    schemaVersion: 1,
    enabled: false,
    currentVersion: 0,
    versions: [],
  });
}

function saveUserAgreement(data) {
  ensureStorage();
  atomicWriteJson(USER_AGREEMENT_PATH, data);
}

function loadAcks() {
  ensureStorage();
  return readJsonFile(ACKS_PATH, { schemaVersion: 1, items: [] });
}

function saveAcks(data) {
  ensureStorage();
  atomicWriteJson(ACKS_PATH, data);
}

function loadViews() {
  ensureStorage();
  return readJsonFile(VIEWS_PATH, { schemaVersion: 1, items: [] });
}

function saveViews(data) {
  ensureStorage();
  atomicWriteJson(VIEWS_PATH, data);
}

function loadReminders() {
  ensureStorage();
  return readJsonFile(REMINDERS_PATH, { schemaVersion: 1, agency: {} });
}

function saveReminders(data) {
  ensureStorage();
  atomicWriteJson(REMINDERS_PATH, data);
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
  getVersionPath,
  getVersionContentPath,
  getSignedHtmlPath,
  getSignaturePngPath,
  getSignedUploadPath,
  readHtml,
  writeHtml,
  writeBinary,
  deleteFile,
};
