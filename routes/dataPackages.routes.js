const express = require("express");
const multer = require("multer");
const { isTakConfigured } = require("../services/tak.service");
const { getBool, getString } = require("../services/env");
const dataPackagesSvc = require("../services/dataPackages.service");
const auditSvc = require("../services/auditLog.service");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024 * 1024 },
});

function takErrMessage(err) {
  const d = err?.response?.data;
  if (d == null) return err?.message || "TAK request failed";
  if (typeof d === "string") return d.slice(0, 2000);
  if (typeof d === "object") {
    return d.error || d.message || d.detail || JSON.stringify(d).slice(0, 1500);
  }
  return String(d);
}

function sendTakError(res, err, fallbackStatus) {
  const code = err?.code;
  if (
    code === "TAK_NOT_CONFIGURED" ||
    code === "TAK_BYPASS" ||
    code === "INVALID_HASH" ||
    code === "INVALID_UPLOAD"
  ) {
    return res.status(400).json({ error: err.message, code });
  }
  const status = err?.response?.status;
  const outStatus =
    typeof status === "number" && status >= 400 && status < 600 ? status : fallbackStatus || 502;
  return res.status(outStatus).json({
    error: takErrMessage(err),
    code: err?.code,
    takStatus: status,
  });
}

router.get("/status", (req, res) => {
  const bypass = getBool("TAK_BYPASS_ENABLED", false);
  let takHost = "";
  try {
    const u = new URL(String(getString("TAK_URL", "") || "").trim());
    takHost = u.host || "";
  } catch (_) {
    takHost = "";
  }
  res.json({
    configured: !!(isTakConfigured() && !bypass),
    bypassed: bypass,
    takHost,
  });
});

router.get("/packages", async (req, res) => {
  try {
    const data = await dataPackagesSvc.listDataPackages(req.query || {});
    return res.json(data);
  } catch (err) {
    return sendTakError(res, err);
  }
});

router.get("/packages/:hash/metadata", async (req, res) => {
  try {
    const out = await dataPackagesSvc.getDataPackageMetadata(req.params.hash);
    return res.json(out);
  } catch (err) {
    return sendTakError(res, err);
  }
});

router.post("/packages/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file || !file.buffer || !file.size) {
      return res.status(400).json({ error: "Select a file to upload." });
    }

    const out = await dataPackagesSvc.uploadDataPackage(file.buffer, file.originalname, {
      mimeType: file.mimetype || "application/octet-stream",
      keywords: "missionpackage",
      tool: "public",
      creator_uid: req.body && req.body.creator_uid ? String(req.body.creator_uid) : "",
    });
    auditSvc.auditFromRequest(req, {
      action: "DATA_PACKAGE_UPLOADED",
      targetType: "data_package",
      targetId: String(out?.hash || out?.uid || file.originalname || ""),
      details: {
        fileName: String(file.originalname || ""),
        sizeBytes: file.size,
        summary: `Uploaded data package ${file.originalname || "(unnamed)"}.`,
      },
    });
    return res.json(out);
  } catch (err) {
    return sendTakError(res, err);
  }
});

router.get("/packages/download", async (req, res) => {
  try {
    const hash = req.query && req.query.hash ? String(req.query.hash) : "";
    const r = await dataPackagesSvc.downloadDataPackageStream(hash);

    if (r.status >= 400) {
      const chunks = [];
      await new Promise((resolve, reject) => {
        r.data.on("data", (c) => chunks.push(c));
        r.data.on("end", resolve);
        r.data.on("error", reject);
      });
      const msg = Buffer.concat(chunks).toString("utf8").slice(0, 2000) || "Download failed";
      return res.status(r.status).json({ error: msg });
    }

    res.status(r.status);
    const ct = r.headers["content-type"];
    if (ct) res.setHeader("Content-Type", ct);
    const cd = r.headers["content-disposition"];
    if (cd) res.setHeader("Content-Disposition", cd);
    const cl = r.headers["content-length"];
    if (cl) res.setHeader("Content-Length", cl);
    auditSvc.auditFromRequest(req, {
      action: "DATA_PACKAGE_DOWNLOADED",
      targetType: "data_package",
      targetId: hash,
      details: { summary: `Downloaded data package ${hash}.` },
    });
    r.data.pipe(res);
  } catch (err) {
    return sendTakError(res, err);
  }
});

router.delete("/packages/:hash", async (req, res) => {
  try {
    const hash = req.params.hash;
    const out = await dataPackagesSvc.deleteDataPackage(hash);
    auditSvc.auditFromRequest(req, {
      action: "DATA_PACKAGE_DELETED",
      targetType: "data_package",
      targetId: hash,
      details: { summary: `Deleted data package ${hash}.` },
    });
    return res.json(out || { ok: true });
  } catch (err) {
    return sendTakError(res, err);
  }
});

router.put("/packages/:hash/metadata", async (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const hash = req.params.hash;
    const out = await dataPackagesSvc.updateDataPackageMetadata(hash, {
      tool: body.tool,
      keywords: body.keywords,
      installOnEnrollment: body.installOnEnrollment,
      installOnConnection: body.installOnConnection,
    });
    auditSvc.auditFromRequest(req, {
      action: "DATA_PACKAGE_METADATA_UPDATED",
      targetType: "data_package",
      targetId: hash,
      details: {
        tool: body.tool,
        keywords: body.keywords,
        installOnEnrollment: body.installOnEnrollment,
        installOnConnection: body.installOnConnection,
        summary: `Updated metadata for data package ${hash}.`,
      },
    });
    return res.json(out);
  } catch (err) {
    return sendTakError(res, err);
  }
});

module.exports = router;
