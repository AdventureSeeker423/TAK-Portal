/**
 * OpenAddresses collection download / index (Live Map settings).
 */

const router = require("express").Router();
const oa = require("../services/openaddresses.service");
const auditSvc = require("../services/auditLog.service");
const { toSafeApiError } = require("../services/apiErrorPayload.service");

function collectionIdParam(req) {
  return String(req.params.collectionId || req.body?.collectionId || "").trim();
}

function audit(req, action, collectionId, details) {
  try {
    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: {
        method: req.method,
        path: req.originalUrl || req.path,
        ip: req.ip,
      },
      action,
      targetType: "openaddresses_collection",
      targetId: String(collectionId || ""),
      details: details || {},
    });
  } catch (_) {
    /* never block */
  }
}

router.get("/", async (req, res) => {
  try {
    const forceCatalog = String(req.query.refresh || "") === "1";
    const status = await oa.getStatus({ forceCatalog });
    return res.json({ ok: true, ...status });
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.post("/download", (req, res) => {
  try {
    const collectionId = collectionIdParam(req);
    const job = oa.startDownload(collectionId);
    audit(req, "OPENADDRESSES_DOWNLOAD_STARTED", collectionId, {
      summary: "Started OpenAddresses collection download.",
    });
    return res.json({ ok: true, job });
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.post("/cancel", (req, res) => {
  try {
    const job = oa.cancelJob();
    audit(req, "OPENADDRESSES_DOWNLOAD_CANCELLED", job && job.collectionId, {
      summary: "Cancelled OpenAddresses collection download.",
    });
    return res.json({ ok: true, job });
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.post("/:collectionId/update", (req, res) => {
  try {
    const collectionId = collectionIdParam(req);
    const job = oa.startUpdate(collectionId);
    audit(req, "OPENADDRESSES_UPDATE_STARTED", collectionId, {
      summary: "Started OpenAddresses collection update.",
    });
    return res.json({ ok: true, job });
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.delete("/:collectionId", (req, res) => {
  try {
    const collectionId = collectionIdParam(req);
    const job = oa.startRemove(collectionId);
    audit(req, "OPENADDRESSES_REMOVE_STARTED", collectionId, {
      summary: "Started OpenAddresses collection remove.",
    });
    return res.json({ ok: true, job });
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, error: toSafeApiError(err) });
  }
});

module.exports = router;
