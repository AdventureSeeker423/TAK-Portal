const express = require("express");
const multer = require("multer");
const { isTakConfigured } = require("../services/tak.service");
const { getBool, getString } = require("../services/env");
const dataPackagesSvc = require("../services/dataPackages.service");
const auditSvc = require("../services/auditLog.service");
const packageKind = require("../services/packageKind.service");

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

function firstVal(obj, keys) {
  if (!obj || typeof obj !== "object") return "";
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (obj[k] != null && obj[k] !== "") return String(obj[k]);
  }
  return "";
}

function normalizeKeywordList(keywords) {
  if (Array.isArray(keywords)) {
    return keywords.map((k) => String(k || "").trim()).filter(Boolean);
  }
  if (keywords == null || keywords === "") return [];
  return String(keywords)
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

function resolveDataPackageMetadataAction(keywords) {
  const lower = normalizeKeywordList(keywords).map((k) => k.toLowerCase());
  if (lower.includes(String(packageKind.ARCHIVED_KEYWORD || "ARCHIVED_MISSION").toLowerCase())) {
    return "DATA_PACKAGE_ARCHIVED";
  }
  if (lower.includes(String(packageKind.PACKAGE_ACTIVE_KEYWORD || "missionpackage").toLowerCase())) {
    return "DATA_PACKAGE_RESTORED";
  }
  return "DATA_PACKAGE_METADATA_UPDATED";
}

const DATA_PACKAGE_SUMMARIES = {
  DATA_PACKAGE_UPLOADED: (label) => `Uploaded data package "${label}".`,
  DATA_PACKAGE_DOWNLOADED: (label) => `Downloaded data package "${label}".`,
  DATA_PACKAGE_DELETED: (label) => `Permanently deleted data package "${label}".`,
  DATA_PACKAGE_ARCHIVED: (label) => `Archived data package "${label}".`,
  DATA_PACKAGE_RESTORED: (label) => `Restored data package "${label}" to active.`,
  DATA_PACKAGE_METADATA_UPDATED: (label) => `Updated metadata for data package "${label}".`,
};

function auditDataPackage(req, action, hash, details = {}) {
  const h = String(hash || "").trim();
  const fileName = String(details.fileName || details.filename || "").trim();
  const label = fileName || h || "data package";
  const summaryFn = DATA_PACKAGE_SUMMARIES[action];
  auditSvc.auditFromRequest(req, {
    action,
    targetType: "data_package",
    targetId: h || fileName,
    details: {
      hash: h || undefined,
      fileName: fileName || undefined,
      summary: details.summary || (summaryFn ? summaryFn(label) : `Data package ${action} on "${label}".`),
      ...details,
    },
  });
}

async function resolveDataPackageLabel(hash, hint) {
  const fromHint = String(hint || "").trim();
  if (fromHint) return fromHint;
  const h = String(hash || "").trim();
  if (!h) return "";
  try {
    const meta = await dataPackagesSvc.getDataPackageMetadata(h);
    return firstVal(meta, ["filename", "name", "original_filename"]) || h;
  } catch (_) {
    return h;
  }
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
    auditDataPackage(req, "DATA_PACKAGE_UPLOADED", String(out?.hash || out?.uid || ""), {
      fileName: String(file.originalname || ""),
      sizeBytes: file.size,
      hash: String(out?.hash || out?.uid || ""),
    });
    return res.json(out);
  } catch (err) {
    return sendTakError(res, err);
  }
});

router.get("/packages/download", async (req, res) => {
  try {
    const hash = req.query && req.query.hash ? String(req.query.hash) : "";
    const fileNameHint =
      req.query && (req.query.fileName || req.query.filename)
        ? String(req.query.fileName || req.query.filename)
        : "";
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

    const label = await resolveDataPackageLabel(hash, fileNameHint);
    auditDataPackage(req, "DATA_PACKAGE_DOWNLOADED", hash, { fileName: label });
    r.data.pipe(res);
  } catch (err) {
    return sendTakError(res, err);
  }
});

router.delete("/packages/:hash", async (req, res) => {
  try {
    const hash = req.params.hash;
    const fileNameHint =
      req.query && (req.query.fileName || req.query.filename)
        ? String(req.query.fileName || req.query.filename)
        : req.body && (req.body.fileName || req.body.filename)
          ? String(req.body.fileName || req.body.filename)
          : "";
    const label = await resolveDataPackageLabel(hash, fileNameHint);
    const out = await dataPackagesSvc.deleteDataPackage(hash);
    auditDataPackage(req, "DATA_PACKAGE_DELETED", hash, { fileName: label });
    return res.json(out || { ok: true });
  } catch (err) {
    return sendTakError(res, err);
  }
});

router.put("/packages/:hash/metadata", async (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const hash = req.params.hash;
    const fileNameHint =
      body.fileName || body.filename || req.query?.fileName || req.query?.filename || "";
    const label = await resolveDataPackageLabel(hash, fileNameHint);
    const keywords = body.keywords;
    const action = resolveDataPackageMetadataAction(keywords);
    const out = await dataPackagesSvc.updateDataPackageMetadata(hash, {
      tool: body.tool,
      keywords: body.keywords,
      installOnEnrollment: body.installOnEnrollment,
      installOnConnection: body.installOnConnection,
    });
    auditDataPackage(req, action, hash, {
      fileName: label,
      tool: body.tool,
      keywords: normalizeKeywordList(keywords),
      installOnEnrollment: body.installOnEnrollment,
      installOnConnection: body.installOnConnection,
    });
    return res.json(out);
  } catch (err) {
    return sendTakError(res, err);
  }
});

module.exports = router;
