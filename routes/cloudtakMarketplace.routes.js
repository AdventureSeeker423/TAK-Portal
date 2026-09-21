"use strict";

const fs = require("fs");
const path = require("path");
const router = require("express").Router();
const multer = require("multer");
const marketplace = require("../services/cloudtakMarketplace.service");
const ssh = require("../services/cloudtakMarketplace.ssh");
const store = require("../services/cloudtakMarketplace.store");
const settingsSvc = require("../services/settings.service");
const stackHealth = require("../services/stackHealth.service");
const auditSvc = require("../services/auditLog.service");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 } });

function username(req) {
  return req.authentikUser && req.authentikUser.username ? req.authentikUser.username : "";
}

function busyChangeError(res) {
  if (!marketplace.hasBusyChangeJobs()) return false;
  res.status(409).json({
    ok: false,
    error: "Wait until the current job is complete and containers are recreated and running.",
  });
  return true;
}

router.get("/status", async (req, res) => {
  try {
    let worker = { ok: true };
    try {
      const health = await stackHealth.getStackHealth();
      worker = health.worker || worker;
    } catch (_) {}
    if (marketplace.isEnabled()) {
      const scan = store.readScanCache();
      if ((!scan || !scan.scannedAt) && !marketplace.hasBusyChangeJobs()) {
        marketplace.enqueueJobOnce("scan", username(req) || "page");
      }
    }
    res.json({
      ok: true,
      enabled: marketplace.isEnabled(),
      ssh: ssh.sshStatus(),
      catalogUrl: marketplace.defaultCatalogUrl(),
      worker,
      busy: marketplace.hasBusyChangeJobs(),
      jobs: marketplace.listJobs().slice(0, 20),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

router.get("/plugins", async (req, res) => {
  try {
    const snapshot = marketplace.buildUiPlugins({ skipRemoteSha: true });
    res.json({ ok: true, ...snapshot });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

router.get("/jobs", (req, res) => {
  try {
    res.json({ ok: true, jobs: marketplace.listJobs() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

router.post("/jobs/clear-idle", (req, res) => {
  try {
    const jobs = marketplace.clearIdleJobs();
    res.json({ ok: true, jobs });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

router.post("/jobs/deploy", (req, res) => {
  try {
    if (busyChangeError(res)) return;
    const result = marketplace.deployStaged();
    if (!result.count) {
      return res.status(400).json({ ok: false, error: "Queue is empty" });
    }
    auditSvc.auditFromRequest(req, {
      action: "CLOUDTAK_MARKETPLACE_DEPLOY",
      targetType: "cloudtak_plugin",
      targetId: "queue",
      details: { count: result.count, summary: `Deployed ${result.count} CloudTAK marketplace change(s)` },
    });
    res.json({ ok: true, count: result.count });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

router.post("/jobs/unstage", (req, res) => {
  try {
    if (busyChangeError(res)) return;
    const jobId = req.body && req.body.jobId ? String(req.body.jobId).trim() : "";
    const result = marketplace.unstageJob(jobId);
    if (!result.ok) {
      return res.status(404).json({ ok: false, error: "Queue item not found" });
    }
    res.json({ ok: true, job: result.job });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

router.post("/jobs", (req, res) => {
  try {
    const kind = String((req.body && req.body.kind) || "").trim();
    const allowed = new Set(["install", "update", "update-all", "uninstall", "refresh-catalog", "scan"]);
    if (!allowed.has(kind)) {
      return res.status(400).json({ ok: false, error: "Unknown job kind" });
    }
    const pluginId = req.body && req.body.pluginId ? String(req.body.pluginId).trim() : null;
    const extra = {};
    if (req.body && req.body.dest) extra.dest = String(req.body.dest).trim();
    const createdBy = username(req);
    if (["install", "update", "update-all", "uninstall"].includes(kind) && busyChangeError(res)) return;

    if (kind === "update-all") {
      const snap = marketplace.buildUiPlugins({ skipRemoteSha: true });
      const staged = [];
      for (const p of snap.plugins || []) {
        if (p.installed && p.updateAvailable && !p.unknown) {
          const result = marketplace.stageJob({ kind: "update", pluginId: p.id, createdBy, toggle: false });
          if (result.job) staged.push(result.job);
        }
      }
      auditSvc.auditFromRequest(req, {
        action: "CLOUDTAK_MARKETPLACE_JOB",
        targetType: "cloudtak_plugin",
        targetId: "update-all",
        details: { kind, count: staged.length, summary: `Staged ${staged.length} CloudTAK plugin update(s)` },
      });
      return res.json({ ok: true, jobs: staged, count: staged.length });
    }

    if (kind === "install" || kind === "update") {
      if (!pluginId) {
        return res.status(400).json({ ok: false, error: "pluginId is required" });
      }
      const result = marketplace.stageJob({ kind, pluginId, createdBy, extra });
      auditSvc.auditFromRequest(req, {
        action: "CLOUDTAK_MARKETPLACE_JOB",
        targetType: "cloudtak_plugin",
        targetId: pluginId,
        details: {
          kind,
          pluginId,
          staged: !result.removed,
          removed: !!result.removed,
          summary: result.removed ? `Removed CloudTAK marketplace ${kind} from queue` : `Staged CloudTAK marketplace ${kind}`,
        },
      });
      return res.json({ ok: true, ...result });
    }

    if (kind === "uninstall") {
      const result = marketplace.stageJob({ kind, pluginId, createdBy, extra });
      auditSvc.auditFromRequest(req, {
        action: "CLOUDTAK_MARKETPLACE_JOB",
        targetType: "cloudtak_plugin",
        targetId: pluginId || extra.dest || kind,
        details: { kind, pluginId, staged: !result.removed, summary: "Staged CloudTAK marketplace uninstall" },
      });
      return res.json({ ok: true, ...result });
    }

    const job = marketplace.enqueueJob({
      kind,
      pluginId,
      createdBy,
      extra,
    });
    auditSvc.auditFromRequest(req, {
      action: "CLOUDTAK_MARKETPLACE_JOB",
      targetType: "cloudtak_plugin",
      targetId: pluginId || kind,
      details: { kind, pluginId, jobId: job.id, summary: `Queued CloudTAK marketplace ${kind}` },
    });
    res.json({ ok: true, job });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

router.post("/catalog/refresh", async (req, res) => {
  try {
    const result = await marketplace.fetchCatalog();
    res.json({
      ok: !!result.ok,
      error: result.ok ? undefined : result.message,
      count: result.catalog && result.catalog.plugins ? result.catalog.plugins.length : 0,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

router.post("/ssh/test", async (req, res) => {
  try {
    const result = await ssh.testConnection();
    if (result.ok) {
      marketplace.enqueueJob({ kind: "scan", createdBy: username(req) });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

router.post("/ssh/detect", async (req, res) => {
  try {
    const result = await marketplace.detectAndPersist({ overwritePath: true });
    if (result.ok && result.path) {
      marketplace.enqueueJobOnce("scan", username(req));
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

router.post("/ssh/key", upload.single("key"), (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ ok: false, error: "No key file uploaded" });
    }
    const dest = ssh.DEFAULT_CLOUDTAK_KEY;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, req.file.buffer, { mode: 0o600 });
    const current = settingsSvc.getSettings() || {};
    settingsSvc.saveSettings({
      ...current,
      CLOUDTAK_SSH_PRIVATE_KEY_PATH: path.relative(process.cwd(), dest).replace(/\\/g, "/"),
    });
    auditSvc.auditFromRequest(req, {
      action: "CLOUDTAK_MARKETPLACE_SSH_KEY",
      targetType: "settings",
      targetId: "cloudtak-ssh",
      details: { summary: "Uploaded CloudTAK marketplace SSH private key." },
    });
    res.json({ ok: true, path: "data/ssh/cloudtak_ssh_ed25519" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

router.post("/notify/test", async (req, res) => {
  try {
    const result = await marketplace.sendTestEmail();
    res.json({ ok: !!result.sent, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

router.get("/scan-cache", (req, res) => {
  try {
    res.json({ ok: true, scan: store.readScanCache() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

module.exports = router;
