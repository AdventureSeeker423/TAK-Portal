"use strict";

const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "data", "cloudtak-marketplace");
const BUNDLED_CATALOG = path.join(__dirname, "..", "catalog", "cloudtak-plugins.json");
const MAX_JOBS = 50;

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function filePath(name) {
  return path.join(DIR, name);
}

function readJsonSafe(abs, fallback) {
  try {
    if (!fs.existsSync(abs)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(abs, "utf8"));
    if (parsed == null) return fallback;
    return parsed;
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(abs, obj) {
  ensureDir(path.dirname(abs));
  const tmp = abs + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, abs);
}

function readPluginsCache() {
  return readJsonSafe(filePath("plugins.json"), null);
}

function writePluginsCache(doc) {
  writeJsonAtomic(filePath("plugins.json"), doc);
}

function readBundledCatalog() {
  return readJsonSafe(BUNDLED_CATALOG, { version: 1, plugins: [] });
}

function readInstalled() {
  const doc = readJsonSafe(filePath("installed.json"), { plugins: {} });
  if (!doc.plugins || typeof doc.plugins !== "object") return { plugins: {} };
  return doc;
}

function writeInstalled(doc) {
  writeJsonAtomic(filePath("installed.json"), doc || { plugins: {} });
}

function readScanCache() {
  return readJsonSafe(filePath("scan-cache.json"), null);
}

function writeScanCache(doc) {
  writeJsonAtomic(filePath("scan-cache.json"), doc);
}

function readNotifyState() {
  return readJsonSafe(filePath("notify-state.json"), {
    lastCatalogAt: 0,
    lastScanAt: 0,
    lastNotifyAt: 0,
    mailedNewIds: {},
    mailedUpdateShas: {},
    seenPluginIds: [],
  });
}

function writeNotifyState(doc) {
  writeJsonAtomic(filePath("notify-state.json"), doc || {});
}

function readShaCache() {
  return readJsonSafe(filePath("sha-cache.json"), { byId: {}, updatedAt: null });
}

function writeShaCache(doc) {
  writeJsonAtomic(filePath("sha-cache.json"), doc || { byId: {}, updatedAt: null });
}

function readJobs() {
  const doc = readJsonSafe(filePath("jobs.json"), { jobs: [] });
  const jobs = Array.isArray(doc.jobs) ? doc.jobs : [];
  return { jobs };
}

function writeJobs(doc) {
  const jobs = Array.isArray(doc && doc.jobs) ? doc.jobs.slice(0, MAX_JOBS) : [];
  writeJsonAtomic(filePath("jobs.json"), { jobs });
}

function withJobs(mutator) {
  const doc = readJobs();
  const next = mutator(doc.jobs) || doc.jobs;
  writeJobs({ jobs: next });
  return { jobs: next };
}

module.exports = {
  DIR,
  BUNDLED_CATALOG,
  MAX_JOBS,
  ensureDir,
  readJsonSafe,
  writeJsonAtomic,
  readPluginsCache,
  writePluginsCache,
  readBundledCatalog,
  readInstalled,
  writeInstalled,
  readScanCache,
  writeScanCache,
  readNotifyState,
  writeNotifyState,
  readShaCache,
  writeShaCache,
  readJobs,
  writeJobs,
  withJobs,
};
