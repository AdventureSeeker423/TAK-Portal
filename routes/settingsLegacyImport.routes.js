"use strict";

const express = require("express");
const jsonImport = require("../services/jsonImport.service");
const auditSvc = require("../services/auditLog.service");

const router = express.Router();

router.get("/status", async (_req, res) => {
  try {
    return res.json(await jsonImport.readRecoveryStatus());
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Could not read legacy import status" });
  }
});

router.post("/rerun", async (req, res) => {
  try {
    const result = await jsonImport.startRerunFromBackup();
    auditSvc.auditFromRequest(req, {
      action: "SETTINGS_LEGACY_JSON_RERUN",
      targetType: "json_import",
      targetId: "legacy",
      details: {
        summary: "Restored migrated JSON backups and re-queued the 1.4.9 data import",
        queuedFiles: result.queuedFiles,
        restore: result.restore,
      },
    });
    return res.json({
      ok: true,
      queuedFiles: result.queuedFiles,
      restore: result.restore,
    });
  } catch (e) {
    const code = e?.code || "";
    const status = code === "import_running" ? 409 : code === "nothing_to_import" ? 400 : 500;
    return res.status(status).json({ error: e?.message || "Could not rerun legacy import" });
  }
});

module.exports = router;
