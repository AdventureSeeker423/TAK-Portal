"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const backup = require("../services/backup");
const auditSvc = require("../services/auditLog.service");

const router = express.Router();

backup.files.ensureDir(backup.files.INCOMING_DIR);
backup.files.ensureDir(backup.files.BACKUPS_DIR);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      backup.files.ensureDir(backup.files.INCOMING_DIR);
      cb(null, backup.files.INCOMING_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase();
      const safeExt = ext === ".takbackup" || ext === ".zip" ? ext : ".bin";
      cb(null, crypto.randomUUID() + safeExt);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const name = String(file.originalname || "").toLowerCase();
    if (name.endsWith(".zip") || name.endsWith(".takbackup")) return cb(null, true);
    cb(new Error("Upload a .zip or .takbackup file"));
  },
});

function actorName(req) {
  return String(req.authentikUser?.username || req.authentikUser?.name || "").trim() || null;
}

function parseCategories(body) {
  if (Array.isArray(body?.categories)) return body.categories.map(String);
  if (typeof body?.categories === "string" && body.categories.trim()) {
    try {
      const parsed = JSON.parse(body.categories);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch (_) {
      return body.categories.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return [];
}

router.get("/catalog", (_req, res) => {
  return res.json(backup.catalog.publicCatalog());
});

router.post("/export", async (req, res) => {
  try {
    const categories = parseCategories(req.body);
    const unknown = backup.catalog.unknownCategoryIds(categories);
    if (unknown.length) {
      return res.status(400).json({ error: "Unknown categories: " + unknown.join(", ") });
    }
    if (!categories.length) {
      return res.status(400).json({ error: "Select at least one category" });
    }
    const includeSecrets = !!req.body?.includeSecrets;
    const passphrase = String(req.body?.passphrase || "");
    const job = await backup.jobs.createJob({
      kind: "backup_export",
      createdBy: actorName(req),
      options: { categories, includeSecrets, passphrase },
    });
    auditSvc.auditFromRequest(req, {
      action: "SETTINGS_BACKUP_EXPORTED",
      targetType: "backup",
      targetId: job.id,
      details: {
        summary: "Queued portal backup export",
        categories,
        includeSecrets,
        encrypted: !!passphrase,
      },
    });
    return res.json({ ok: true, job: backup.jobs.toClient(job) });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

router.post("/inspect", (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || String(err) });
    if (!req.file) return res.status(400).json({ error: "Choose a backup file" });
    const passphrase = String(req.body?.passphrase || req.query?.passphrase || "");
    try {
      const peeked = backup.files.peekIsEncrypted(req.file.path);
      if (peeked && !passphrase) {
        return res.json({
          inspectId: path.basename(req.file.filename, path.extname(req.file.filename)),
          filename: req.file.filename,
          encrypted: true,
          needsPassphrase: true,
          manifest: null,
        });
      }
      const { encrypted, manifest } = await backup.importSvc.inspectArchive(
        req.file.path,
        passphrase
      );
      return res.json({
        inspectId: path.basename(req.file.filename, path.extname(req.file.filename)),
        filename: req.file.filename,
        encrypted,
        needsPassphrase: false,
        manifest,
      });
    } catch (e) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (_) {}
      return res.status(400).json({ error: e.message || String(e) });
    }
  });
});

router.post("/import", async (req, res) => {
  try {
    const filename = String(req.body?.filename || "").trim();
    if (!filename || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
      return res.status(400).json({ error: "Invalid inspect file" });
    }
    const archivePath = path.join(backup.files.INCOMING_DIR, filename);
    if (!fs.existsSync(archivePath)) {
      return res.status(400).json({ error: "Upload has expired. Select the file again." });
    }
    const categories = parseCategories(req.body);
    const unknown = backup.catalog.unknownCategoryIds(categories);
    if (unknown.length) {
      return res.status(400).json({ error: "Unknown categories: " + unknown.join(", ") });
    }
    const mode = String(req.body?.mode || "merge").toLowerCase() === "replace" ? "replace" : "merge";
    const job = await backup.jobs.createJob({
      kind: "backup_import",
      createdBy: actorName(req),
      options: {
        archivePath,
        filename,
        categories,
        mode,
        dryRun: !!req.body?.dryRun,
        includeSecrets: req.body?.includeSecrets,
        sendOnboardingEmail: !!req.body?.sendOnboardingEmail,
        passphrase: String(req.body?.passphrase || ""),
      },
    });
    auditSvc.auditFromRequest(req, {
      action: "SETTINGS_BACKUP_IMPORTED",
      targetType: "backup",
      targetId: job.id,
      details: {
        summary: req.body?.dryRun ? "Queued portal backup dry run" : "Queued portal backup import",
        categories,
        mode,
        dryRun: !!req.body?.dryRun,
      },
    });
    return res.json({ ok: true, job: backup.jobs.toClient(job) });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

router.get("/jobs/:id", async (req, res) => {
  try {
    const job = await backup.jobs.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    return res.json({ ok: true, job: backup.jobs.toClient(job) });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

router.get("/jobs/:id/download", async (req, res) => {
  try {
    const job = await backup.jobs.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.kind !== "backup_export" || job.status !== "complete" || !job.artifact_path) {
      return res.status(404).json({ error: "Download is not available" });
    }
    const abs = backup.jobs.artifactAbs(job.artifact_path);
    if (!abs || !fs.existsSync(abs)) {
      return res.status(404).json({ error: "Backup file is gone" });
    }
    const name = path.basename(abs);
    return res.download(abs, name);
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

router.post("/jobs/:id/cancel", async (req, res) => {
  try {
    const job = await backup.jobs.cancelJob(req.params.id);
    if (!job) return res.status(409).json({ error: "Job cannot be cancelled" });
    return res.json({ ok: true, job: backup.jobs.toClient(job) });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

module.exports = router;
