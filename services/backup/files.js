"use strict";

const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const unzipper = require("unzipper");
const { credentialFileRel } = require("./catalog");
const { encryptBuffer, decryptBuffer, isEncryptedBackup } = require("./crypto");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const BACKUPS_DIR = path.join(DATA_DIR, "backups");
const INCOMING_DIR = path.join(BACKUPS_DIR, "incoming");

const SKIP_TOP = new Set(["backups", "migrated"]);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeResolve(root, rel) {
  const rootAbs = path.resolve(root);
  const resolved = path.resolve(rootAbs, String(rel || ""));
  const prefix = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  if (resolved !== rootAbs && !resolved.startsWith(prefix)) {
    throw new Error("Illegal path: " + rel);
  }
  return resolved;
}

function normalizeRel(rel) {
  return String(rel || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function walkFiles(absDir, relBase, out) {
  if (!fs.existsSync(absDir)) return;
  const st = fs.statSync(absDir);
  if (st.isFile()) {
    out.push({ abs: absDir, rel: normalizeRel(relBase) });
    return;
  }
  if (!st.isDirectory()) return;
  for (const name of fs.readdirSync(absDir)) {
    if (!relBase && SKIP_TOP.has(name)) continue;
    walkFiles(path.join(absDir, name), relBase ? `${relBase}/${name}` : name, out);
  }
}

function copyFileInto(stagingRoot, absSrc, rel) {
  const dest = safeResolve(stagingRoot, rel);
  ensureDir(path.dirname(dest));
  fs.copyFileSync(absSrc, dest);
}

function copyDataRelIntoStaging(stagingFilesDir, rel, includeSecrets) {
  const nrel = normalizeRel(rel);
  if (!nrel) return 0;
  if (!includeSecrets && credentialFileRel(nrel)) return 0;
  const abs = safeResolve(DATA_DIR, nrel);
  if (!fs.existsSync(abs)) return 0;
  const items = [];
  walkFiles(abs, nrel, items);
  let n = 0;
  for (const item of items) {
    if (!includeSecrets && credentialFileRel(item.rel)) continue;
    copyFileInto(stagingFilesDir, item.abs, item.rel);
    n += 1;
  }
  return n;
}

function zipDirectory(srcDir, outPath) {
  ensureDir(path.dirname(outPath));
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver("zip", { zlib: { level: 6 } });
    output.on("close", () => resolve(outPath));
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(srcDir, false);
    archive.finalize();
  });
}

async function encryptFileTo(srcPath, destPath, passphrase) {
  const plain = fs.readFileSync(srcPath);
  const enc = encryptBuffer(plain, passphrase);
  ensureDir(path.dirname(destPath));
  fs.writeFileSync(destPath, enc);
  return destPath;
}

function maybeDecryptToZip(srcPath, passphrase, tmpDir) {
  const buf = fs.readFileSync(srcPath);
  if (!isEncryptedBackup(buf)) return srcPath;
  const zipBuf = decryptBuffer(buf, passphrase);
  ensureDir(tmpDir);
  const out = path.join(tmpDir, "backup.zip");
  fs.writeFileSync(out, zipBuf);
  return out;
}

function peekIsEncrypted(srcPath) {
  const fd = fs.openSync(srcPath, "r");
  try {
    const header = Buffer.alloc(10);
    const n = fs.readSync(fd, header, 0, 10, 0);
    return n >= 10 && header.equals(Buffer.from("TAKBACKUP1"));
  } finally {
    fs.closeSync(fd);
  }
}

async function readZipEntryBuffer(zipPath, wanted) {
  const want = normalizeRel(wanted).toLowerCase();
  const directory = await unzipper.Open.file(zipPath);
  const entry = directory.files.find((f) => {
    const p = normalizeRel(f.path).toLowerCase();
    return p === want || p.endsWith("/" + want);
  });
  if (!entry) return null;
  return entry.buffer();
}

async function extractZip(zipPath, destDir) {
  ensureDir(destDir);
  const directory = await unzipper.Open.file(zipPath);
  for (const file of directory.files) {
    const rel = normalizeRel(file.path);
    if (!rel || rel.includes("..")) continue;
    if (file.type === "Directory") {
      ensureDir(safeResolve(destDir, rel));
      continue;
    }
    const dest = safeResolve(destDir, rel);
    ensureDir(path.dirname(dest));
    const buf = await file.buffer();
    fs.writeFileSync(dest, buf);
  }
  return destDir;
}

function restoreExtractedFiles(extractRoot, includeSecrets) {
  const filesRoot = findFilesRoot(extractRoot);
  if (!filesRoot || !fs.existsSync(filesRoot)) return 0;
  const items = [];
  walkFiles(filesRoot, "", items);
  let n = 0;
  for (const item of items) {
    if (!includeSecrets && credentialFileRel(item.rel)) continue;
    const dest = safeResolve(DATA_DIR, item.rel);
    ensureDir(path.dirname(dest));
    fs.copyFileSync(item.abs, dest);
    n += 1;
  }
  return n;
}

function findFilesRoot(extractRoot) {
  const direct = path.join(extractRoot, "files");
  if (fs.existsSync(direct)) return direct;
  const entries = fs.existsSync(extractRoot) ? fs.readdirSync(extractRoot) : [];
  for (const name of entries) {
    const nested = path.join(extractRoot, name, "files");
    if (fs.existsSync(nested)) return nested;
  }
  return direct;
}

function findCategoriesRoot(extractRoot) {
  const direct = path.join(extractRoot, "categories");
  if (fs.existsSync(direct)) return direct;
  const entries = fs.existsSync(extractRoot) ? fs.readdirSync(extractRoot) : [];
  for (const name of entries) {
    const nested = path.join(extractRoot, name, "categories");
    if (fs.existsSync(nested)) return nested;
  }
  return direct;
}

function findManifestPath(extractRoot) {
  const direct = path.join(extractRoot, "manifest.json");
  if (fs.existsSync(direct)) return direct;
  const entries = fs.existsSync(extractRoot) ? fs.readdirSync(extractRoot) : [];
  for (const name of entries) {
    const nested = path.join(extractRoot, name, "manifest.json");
    if (fs.existsSync(nested)) return nested;
  }
  return direct;
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

function cleanupOldBackups({ keep = 10, maxAgeMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  ensureDir(BACKUPS_DIR);
  const now = Date.now();
  let files = [];
  try {
    files = fs
      .readdirSync(BACKUPS_DIR)
      .filter((n) => n.endsWith(".zip") || n.endsWith(".takbackup"))
      .map((n) => {
        const abs = path.join(BACKUPS_DIR, n);
        const st = fs.statSync(abs);
        return { abs, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (_) {
    return;
  }
  files.forEach((f, i) => {
    if (i >= keep || now - f.mtime > maxAgeMs) {
      try {
        fs.unlinkSync(f.abs);
      } catch (_) {}
    }
  });
  try {
    ensureDir(INCOMING_DIR);
    const incomingMax = 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(INCOMING_DIR)) {
      const abs = path.join(INCOMING_DIR, name);
      try {
        const st = fs.statSync(abs);
        if (now - st.mtimeMs > incomingMax) fs.unlinkSync(abs);
      } catch (_) {}
    }
  } catch (_) {}
}

module.exports = {
  DATA_DIR,
  BACKUPS_DIR,
  INCOMING_DIR,
  ensureDir,
  safeResolve,
  normalizeRel,
  copyDataRelIntoStaging,
  zipDirectory,
  encryptFileTo,
  maybeDecryptToZip,
  peekIsEncrypted,
  readZipEntryBuffer,
  extractZip,
  restoreExtractedFiles,
  findFilesRoot,
  findCategoriesRoot,
  findManifestPath,
  rmrf,
  cleanupOldBackups,
};
