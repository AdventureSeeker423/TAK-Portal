/**
 * ATAK client APK upload / remove (settings) and download (setup my device).
 */

const router = require("express").Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const atakApkSvc = require("../services/atakApk.service");
const auditSvc = require("../services/auditLog.service");
const { toSafeApiError } = require("../services/apiErrorPayload.service");

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, "..", "data", "uploads");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const base = (file.originalname || "atak").replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `atak_${Date.now()}_${base}`);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
  fileFilter: (req, file, cb) => {
    const name = String(file.originalname || "").toLowerCase();
    if (!name.endsWith(".apk")) {
      return cb(new Error("Only .apk files are allowed."));
    }
    return cb(null, true);
  },
});

router.get("/status", (req, res) => {
  try {
    return res.json({ ok: true, ...atakApkSvc.getApkInfo() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.post("/upload", (req, res) => {
  upload.single("apk")(req, res, (err) => {
    if (err) {
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? "APK exceeds the 500 MB upload limit."
          : err.message || "Upload failed.";
      return res.status(400).json({ ok: false, error: message });
    }
    try {
      if (!req.file || !req.file.path) {
        return res.status(400).json({ ok: false, error: "No APK file uploaded." });
      }
      const info = atakApkSvc.saveUploadedApk(req.file.path, req.file.originalname);
      try {
        auditSvc.logEvent({
          actor: req.authentikUser || null,
          request: {
            method: req.method,
            path: req.originalUrl || req.path,
            ip: req.ip,
          },
          action: "ATAK_APK_UPLOADED",
          targetType: "atak_apk",
          targetId: "client",
          details: {
            originalName: info.originalName,
            size: info.size,
            summary: `Uploaded ATAK APK ${info.originalName || ""}.`.trim(),
          },
        });
      } catch (_) {
        /* never block */
      }
      return res.json({ ok: true, ...info });
    } catch (e) {
      if (req.file && req.file.path) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (_) {
          /* ignore */
        }
      }
      return res.status(500).json({ ok: false, error: toSafeApiError(e) });
    }
  });
});

router.delete("/", (req, res) => {
  try {
    const before = atakApkSvc.getApkInfo();
    const info = atakApkSvc.removeApk();
    try {
      auditSvc.logEvent({
        actor: req.authentikUser || null,
        request: {
          method: req.method,
          path: req.originalUrl || req.path,
          ip: req.ip,
        },
        action: "ATAK_APK_REMOVED",
        targetType: "atak_apk",
        targetId: "client",
        details: {
          originalName: before.originalName || null,
          summary: "Removed hosted ATAK APK; Setup My Device uses Play Store again.",
        },
      });
    } catch (_) {
      /* never block */
    }
    return res.json({ ok: true, ...info });
  } catch (err) {
    return res.status(500).json({ ok: false, error: toSafeApiError(err) });
  }
});

module.exports = router;
