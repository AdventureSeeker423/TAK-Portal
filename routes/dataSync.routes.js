/**
 * Data Sync / Marti mission manager — proxies to TAK Server using portal mTLS credentials.
 * Requires global admin + beta (enforced in server.js).
 */

const express = require("express");
const multer = require("multer");
const { buildTakAxios, isTakConfigured } = require("../services/tak.service");
const { getBool } = require("../services/env");
const dataSyncSvc = require("../services/dataSync.service");
const auditSvc = require("../services/auditLog.service");

const router = express.Router();

function auditDataSync(req, action, missionName, details = {}) {
  const name = String(missionName || "").trim();
  auditSvc.auditFromRequest(req, {
    action,
    targetType: "data_sync_mission",
    targetId: name,
    details: { missionName: name, ...details },
  });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
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

/**
 * TAK rejects fat mission objects from GET when used as PUT/POST bodies (e.g. ownerRole, token, guid).
 * Only forward fields the Marti change-mission API expects.
 */
function sanitizeMissionWriteBody(body) {
  if (!body || typeof body !== "object") return {};
  const o = {};
  const keys = [
    "name",
    "tool",
    "description",
    "defaultRole",
    "keywords",
    "inviteOnly",
    "chatRoom",
    "baseLayer",
    "bbox",
    "path",
    "classification",
    "expiration",
  ];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (body[k] !== undefined) o[k] = body[k];
  }
  if (Array.isArray(body.groups)) {
    o.groups = body.groups
      .map((g) => {
        if (typeof g === "string") return g.trim();
        if (g && typeof g === "object" && g.name != null) return String(g.name).trim();
        return String(g || "").trim();
      })
      .filter(Boolean);
  }
  return o;
}

function sendTakError(res, err, fallbackStatus) {
  const code = err?.code;
  if (code === "TAK_NOT_CONFIGURED" || code === "TAK_BYPASS" || code === "INVALID_MISSION_NAME") {
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
    const u = new URL(String(require("../services/env").getString("TAK_URL", "") || "").trim());
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

router.get("/groups", async (req, res) => {
  try {
    const data = await dataSyncSvc.listGroupsAll();
    return res.json(data);
  } catch (err) {
    return sendTakError(res, err);
  }
});

router.get("/missions", async (req, res) => {
  try {
    const data = await dataSyncSvc.listPagedMissions(req.query);
    return res.json(data);
  } catch (err) {
    return sendTakError(res, err);
  }
});

/** Full Data Sync / mission export as KML (TAK GET /Marti/api/missions/:name/kml?download=true). Extra query params forwarded (e.g. password). */
router.get("/missions/:missionName/export-kml", async (req, res) => {
  try {
    const missionName = req.params.missionName;
    const q = { ...req.query };
    const r = await dataSyncSvc.exportMissionKmlStream(missionName, q);

    if (r.status >= 400) {
      const chunks = [];
      await new Promise((resolve, reject) => {
        r.data.on("data", (c) => chunks.push(c));
        r.data.on("end", resolve);
        r.data.on("error", reject);
      });
      const buf = Buffer.concat(chunks);
      let msg = buf.toString("utf8").slice(0, 2000);
      try {
        const j = JSON.parse(msg);
        msg = j.error || j.message || msg;
      } catch (_) {
        /* ignore */
      }
      return res.status(r.status).json({ error: msg || "TAK mission KML export failed" });
    }

    res.status(r.status);
    const ct = r.headers["content-type"];
    if (ct) res.setHeader("Content-Type", ct);
    else res.setHeader("Content-Type", dataSyncSvc.KML_MIME);

    const cd = r.headers["content-disposition"];
    if (cd) {
      res.setHeader("Content-Disposition", cd);
    } else {
      const safe =
        String(missionName).replace(/[^\w.\- ()\[\]]+/g, "_").trim().slice(0, 120) || "mission";
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safe}.kml"; filename*=UTF-8''${encodeURIComponent(safe + ".kml")}`
      );
    }
    const cl = r.headers["content-length"];
    if (cl) res.setHeader("Content-Length", cl);
    r.data.pipe(res);
  } catch (err) {
    return sendTakError(res, err);
  }
});

/** Mission HTML archive — TAK GET /Marti/api/missions/:name/archive */
router.get("/missions/:missionName/export-archive", async (req, res) => {
  try {
    const missionName = req.params.missionName;
    const q = { ...req.query };
    const r = await dataSyncSvc.exportMissionArchiveStream(missionName, q);

    if (r.status >= 400) {
      const chunks = [];
      await new Promise((resolve, reject) => {
        r.data.on("data", (c) => chunks.push(c));
        r.data.on("end", resolve);
        r.data.on("error", reject);
      });
      const buf = Buffer.concat(chunks);
      let msg = buf.toString("utf8").slice(0, 2000);
      try {
        const j = JSON.parse(msg);
        msg = j.error || j.message || msg;
      } catch (_) {
        /* ignore */
      }
      return res.status(r.status).json({ error: msg || "TAK mission archive failed" });
    }

    res.status(r.status);
    const ct = r.headers["content-type"];
    if (ct) res.setHeader("Content-Type", ct);
    else res.setHeader("Content-Type", "text/html; charset=utf-8");

    const cd = r.headers["content-disposition"];
    if (cd) {
      res.setHeader("Content-Disposition", cd);
    } else {
      const safe =
        String(missionName).replace(/[^\w.\- ()\[\]]+/g, "_").trim().slice(0, 120) || "mission";
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${safe}.html"; filename*=UTF-8''${encodeURIComponent(safe + ".html")}`
      );
    }
    const cl = r.headers["content-length"];
    if (cl) res.setHeader("Content-Length", cl);
    r.data.pipe(res);
  } catch (err) {
    return sendTakError(res, err);
  }
});

router.get("/missions/:missionName", async (req, res) => {
  try {
    const data = await dataSyncSvc.getMission(req.params.missionName);
    return res.json(data);
  } catch (err) {
    return sendTakError(res, err);
  }
});

router.put("/missions/:missionName", async (req, res) => {
  try {
    const body = sanitizeMissionWriteBody(req.body);
    const data = await dataSyncSvc.putMission(req.params.missionName, body);
    auditDataSync(req, "DATA_SYNC_MISSION_UPDATED", req.params.missionName, {
      fields: Object.keys(body || {}),
    });
    return res.json(data);
  } catch (err) {
    return sendTakError(res, err);
  }
});

router.post("/missions/:missionName", async (req, res) => {
  try {
    const body = sanitizeMissionWriteBody(req.body);
    const data = await dataSyncSvc.changeMission(req.params.missionName, body);
    auditDataSync(req, "DATA_SYNC_MISSION_CHANGED", req.params.missionName, {
      fields: Object.keys(body || {}),
    });
    return res.json(data);
  } catch (err) {
    return sendTakError(res, err);
  }
});

router.delete("/missions/:missionName", async (req, res) => {
  try {
    const data = await dataSyncSvc.deleteMission(req.params.missionName);
    auditDataSync(req, "DATA_SYNC_MISSION_DELETED", req.params.missionName);
    if (data === undefined || data === null || data === "") {
      return res.status(200).json({ ok: true });
    }
    return res.json(data);
  } catch (err) {
    return sendTakError(res, err);
  }
});

router.put("/missions/:missionName/password", async (req, res) => {
  try {
    const pw = req.body && req.body.password != null ? String(req.body.password) : "";
    const data = await dataSyncSvc.setMissionPassword(req.params.missionName, pw);
    auditDataSync(req, "DATA_SYNC_MISSION_PASSWORD_SET", req.params.missionName, {
      passwordChanged: true,
    });
    return res.json(data);
  } catch (err) {
    return sendTakError(res, err);
  }
});

router.delete("/missions/:missionName/password", async (req, res) => {
  try {
    const data = await dataSyncSvc.clearMissionPassword(req.params.missionName);
    auditDataSync(req, "DATA_SYNC_MISSION_PASSWORD_CLEARED", req.params.missionName);
    return res.json(data);
  } catch (err) {
    return sendTakError(res, err);
  }
});

router.put("/missions/:missionName/keywords", async (req, res) => {
  try {
    const data = await dataSyncSvc.putMissionKeywords(req.params.missionName, req.body);
    auditDataSync(req, "DATA_SYNC_MISSION_KEYWORDS_UPDATED", req.params.missionName);
    return res.json(data);
  } catch (err) {
    return sendTakError(res, err);
  }
});

router.put("/missions/:missionName/contents", async (req, res) => {
  try {
    const data = await dataSyncSvc.putMissionContents(req.params.missionName, req.body);
    auditDataSync(req, "DATA_SYNC_MISSION_CONTENTS_UPDATED", req.params.missionName);
    return res.json(data);
  } catch (err) {
    return sendTakError(res, err);
  }
});

router.get("/sync/search", async (req, res) => {
  try {
    const data = await dataSyncSvc.getSyncSearch(req.query);
    return res.json(data);
  } catch (err) {
    return sendTakError(res, err);
  }
});

router.get("/sync/content", async (req, res) => {
  try {
    dataSyncSvc.assertTakAvailable();
    const client = buildTakAxios({ timeout: 120000 });
    const r = await client.get("/sync/content", {
      params: req.query,
      responseType: "stream",
      validateStatus: () => true,
    });

    if (r.status >= 400) {
      const chunks = [];
      await new Promise((resolve, reject) => {
        r.data.on("data", (c) => chunks.push(c));
        r.data.on("end", resolve);
        r.data.on("error", reject);
      });
      const buf = Buffer.concat(chunks);
      let msg = buf.toString("utf8").slice(0, 2000);
      try {
        const j = JSON.parse(msg);
        msg = j.error || j.message || msg;
      } catch (_) {
        /* ignore */
      }
      return res.status(r.status).json({ error: msg || "TAK sync content error" });
    }

    res.status(r.status);
    const ct = r.headers["content-type"];
    if (ct) res.setHeader("Content-Type", ct);
    const cd = r.headers["content-disposition"];
    if (cd) res.setHeader("Content-Disposition", cd);
    const cl = r.headers["content-length"];
    if (cl) res.setHeader("Content-Length", cl);
    r.data.pipe(res);
  } catch (err) {
    return sendTakError(res, err);
  }
});

router.post("/sync/upload", upload.any(), async (req, res) => {
  try {
    dataSyncSvc.assertTakAvailable();
    const form = new FormData();
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: "No file uploaded. Data Sync packages must be a .kml file." });
    }
    const BlobCtor = global.Blob || require("node:buffer").Blob;
    const kmlMime = dataSyncSvc.KML_MIME;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const lower = String(f.originalname || "").toLowerCase();
      if (!lower.endsWith(".kml")) {
        return res.status(400).json({
          error: "Only .kml Data Sync packages are accepted (application/vnd.google-earth.kml+xml).",
        });
      }
      const blob = new BlobCtor([f.buffer], { type: kmlMime });
      form.append(f.fieldname, blob, f.originalname || "package.kml");
    }
    if (req.body && typeof req.body === "object") {
      Object.keys(req.body).forEach((k) => {
        const v = req.body[k];
        if (v != null && v !== "") form.append(k, String(v));
      });
    }

    const client = buildTakAxios({ timeout: 120000 });
    const r = await client.post("/sync/upload", form, {
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    auditSvc.auditFromRequest(req, {
      action: "DATA_SYNC_UPLOAD",
      targetType: "data_sync",
      targetId: "sync",
      details: {
        fileNames: files.map((f) => String(f.originalname || "")),
        fileCount: files.length,
        summary: `Uploaded ${files.length} file(s) to TAK Data Sync.`,
      },
    });
    return res.status(r.status || 200).json(r.data);
  } catch (err) {
    return sendTakError(res, err);
  }
});

module.exports = router;
