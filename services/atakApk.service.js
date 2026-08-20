/**
 * Hosted ATAK client APK for Setup My Device (replaces Play Store when present).
 * File lives under data/atak/; metadata in settings.json.
 */

const fs = require("fs");
const path = require("path");
const settingsSvc = require("./settings.service");

const ATAK_DIR = path.join(__dirname, "..", "data", "atak");
const STORED_FILENAME = "atak-client.apk";
const DOWNLOAD_PATH = "/api/atak/download";

function ensureAtakDir() {
  if (!fs.existsSync(ATAK_DIR)) {
    fs.mkdirSync(ATAK_DIR, { recursive: true });
  }
}

function getStoredFilePath() {
  return path.join(ATAK_DIR, STORED_FILENAME);
}

function hasApk() {
  try {
    return fs.existsSync(getStoredFilePath());
  } catch (_) {
    return false;
  }
}

function getOriginalName() {
  const settings = settingsSvc.getSettings() || {};
  const name = String(settings.ATAK_APK_ORIGINAL_NAME || "").trim();
  if (name) return name;
  return STORED_FILENAME;
}

/**
 * @returns {{ uploaded: boolean, originalName: string|null, size: number|null, downloadUrl: string|null }}
 */
function getApkInfo() {
  if (!hasApk()) {
    return {
      uploaded: false,
      originalName: null,
      size: null,
      downloadUrl: null,
    };
  }
  let size = null;
  try {
    size = fs.statSync(getStoredFilePath()).size;
  } catch (_) {
    size = null;
  }
  return {
    uploaded: true,
    originalName: getOriginalName(),
    size,
    downloadUrl: DOWNLOAD_PATH,
  };
}

function getApkFilePath() {
  if (!hasApk()) return null;
  return getStoredFilePath();
}

/**
 * Move an uploaded temp file into data/atak and record the original name.
 * @param {string} tempPath
 * @param {string} originalName
 */
function saveUploadedApk(tempPath, originalName) {
  if (!tempPath || !fs.existsSync(tempPath)) {
    throw new Error("Uploaded file not found.");
  }
  const safeName = String(originalName || STORED_FILENAME)
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .trim() || STORED_FILENAME;
  if (!/\.apk$/i.test(safeName)) {
    throw new Error("Only .apk files are allowed.");
  }

  ensureAtakDir();
  const dest = getStoredFilePath();
  try {
    fs.renameSync(tempPath, dest);
  } catch (err) {
    // Cross-device rename can fail; copy then unlink.
    fs.copyFileSync(tempPath, dest);
    try {
      fs.unlinkSync(tempPath);
    } catch (_) {
      /* ignore */
    }
  }

  settingsSvc.updateSettings({
    ATAK_APK_ORIGINAL_NAME: safeName,
  });

  return getApkInfo();
}

function removeApk() {
  const dest = getStoredFilePath();
  if (fs.existsSync(dest)) {
    try {
      fs.unlinkSync(dest);
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
  }

  const current = settingsSvc.getSettings() || {};
  if (Object.prototype.hasOwnProperty.call(current, "ATAK_APK_ORIGINAL_NAME")) {
    const next = { ...current };
    delete next.ATAK_APK_ORIGINAL_NAME;
    settingsSvc.saveSettings(next);
  }

  return getApkInfo();
}

module.exports = {
  DOWNLOAD_PATH,
  hasApk,
  getApkInfo,
  getApkFilePath,
  getOriginalName,
  saveUploadedApk,
  removeApk,
};
