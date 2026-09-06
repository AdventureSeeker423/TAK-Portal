"use strict";

const fs = require("fs");
const path = require("path");

function importFileNamesLongestFirst(importFiles) {
  const names = (importFiles || []).map((f) => f.name);
  names.sort((a, b) => b.length - a.length);
  return names;
}

function parseMigratedFileName(diskName, importFiles) {
  const name = String(diskName || "");
  if (!name.endsWith(".json")) return null;
  for (const fileName of importFileNamesLongestFirst(importFiles)) {
    const prefix = `${fileName}.`;
    if (!name.startsWith(prefix)) continue;
    const stamp = name.slice(prefix.length, -".json".length);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(stamp)) continue;
    return { fileName, stamp, diskName: name };
  }
  return null;
}

function pickLatestBackup(entries) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (!list.length) return null;
  list.sort((a, b) => String(b.stamp || "").localeCompare(String(a.stamp || "")));
  return list[0];
}

function listMigratedBackupsIn(migratedDir, importFiles) {
  const byFile = new Map();
  if (!migratedDir || !fs.existsSync(migratedDir)) return byFile;
  let names = [];
  try {
    names = fs.readdirSync(migratedDir);
  } catch (_) {
    return byFile;
  }
  for (const diskName of names) {
    const parsed = parseMigratedFileName(diskName, importFiles);
    if (!parsed) continue;
    const abs = path.join(migratedDir, diskName);
    let size = 0;
    try {
      size = fs.statSync(abs).size;
    } catch (_) {
      continue;
    }
    const row = { ...parsed, abs, size };
    const list = byFile.get(parsed.fileName) || [];
    list.push(row);
    byFile.set(parsed.fileName, list);
  }
  return byFile;
}

function originalStat(absPath) {
  try {
    if (!absPath || !fs.existsSync(absPath)) {
      return { present: false, bytes: 0 };
    }
    const st = fs.statSync(absPath);
    if (!st.isFile()) return { present: false, bytes: 0 };
    return { present: true, bytes: Number(st.size) || 0 };
  } catch (_) {
    return { present: false, bytes: 0 };
  }
}

function inspectLegacySourcesIn(dataDir, migratedDir, importFiles) {
  const files = Array.isArray(importFiles) ? importFiles : [];
  const backups = listMigratedBackupsIn(migratedDir, files);
  return files.map((f) => {
    const abs = path.join(dataDir, f.rel);
    const orig = originalStat(abs);
    const list = backups.get(f.name) || [];
    const latest = pickLatestBackup(list);
    return {
      name: f.name,
      rel: String(f.rel).replace(/\\/g, "/"),
      originalPresent: orig.present,
      originalBytes: orig.bytes,
      backupCount: list.length,
      latestBackup: latest ? latest.diskName : null,
      latestBackupBytes: latest ? latest.size : 0,
    };
  });
}

function restoreLatestBackupsIn(dataDir, migratedDir, importFiles, opts) {
  const overwriteExisting = !!opts?.overwriteExisting;
  const files = Array.isArray(importFiles) ? importFiles : [];
  const backups = listMigratedBackupsIn(migratedDir, files);
  const results = [];
  for (const f of files) {
    const abs = path.join(dataDir, f.rel);
    const orig = originalStat(abs);
    const latest = pickLatestBackup(backups.get(f.name) || []);
    if (orig.present && orig.bytes > 0 && !overwriteExisting) {
      results.push({
        name: f.name,
        rel: String(f.rel).replace(/\\/g, "/"),
        action: "kept_original",
        from: latest ? latest.diskName : null,
        usable: true,
      });
      continue;
    }
    if (!latest) {
      results.push({
        name: f.name,
        rel: String(f.rel).replace(/\\/g, "/"),
        action: "missing",
        from: null,
        usable: false,
      });
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(latest.abs, abs);
    results.push({
      name: f.name,
      rel: String(f.rel).replace(/\\/g, "/"),
      action: orig.present ? "replaced_empty" : "restored",
      from: latest.diskName,
      usable: true,
    });
  }
  return results;
}

module.exports = {
  parseMigratedFileName,
  pickLatestBackup,
  listMigratedBackupsIn,
  inspectLegacySourcesIn,
  restoreLatestBackupsIn,
};
