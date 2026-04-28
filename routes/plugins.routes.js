/**
 * Plugin Manager API: TAK.gov link, list/download/delete plugins.
 * Mounted with requirePermission("api.plugins_admin") in server.js.
 */

const router = require("express").Router();
const path = require("path");
const fs = require("fs");
const pluginsSvc = require("../services/plugins.service");
const auditSvc = require("../services/auditLog.service");
const multer = require("multer");

// Upload plugin APK to temp dir; we copy into data/plugins in the service then remove temp file
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, "..", "data", "uploads");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const base = (file.originalname || "plugin").replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `plugin_${Date.now()}_${base}`);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
});

const { toSafeApiError } = require("../services/apiErrorPayload.service");

function toErrorPayload(err) {
  return toSafeApiError(err);
}

/**
 * GET /api/plugins/state
 * Returns TAK.gov link state and list of installed plugins.
 */
router.get("/state", async (req, res) => {
  try {
    const linkState = await pluginsSvc.getTakGovLinkState(false);
    const plugins = pluginsSvc.listPlugins();
    res.json({
      takGovLink: linkState,
      plugins,
    });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

/**
 * GET /api/plugins/update-status
 * Returns which plugin ids have an update available from TAK.gov. { updateStatus: { "plugin-1": true, ... } }
 */
router.get("/update-status", async (req, res) => {
  try {
    const updateStatus = await pluginsSvc.getUpdateStatus();
    res.json({ updateStatus });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

/**
 * POST /api/plugins/link-code
 * Request a new user_code from TAK.gov (OAuth 2.0 device flow). User enters that code at TAK.gov.
 */
router.post("/link-code", async (req, res) => {
  try {
    const state = await pluginsSvc.getTakGovLinkState(true);
    if (state.error) {
      return res.status(400).json({ success: false, error: state.error });
    }
    const auditUser = req.authentikUser;
    auditSvc.logEvent({
      actor: auditUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "PLUGIN_LINK_CODE_GENERATED",
      targetType: "plugin_manager",
      targetId: null,
      details: {},
    });
    res.json({ success: true, ...state });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

/**
 * POST /api/plugins/link
 * Exchange stored device_code for tokens (user has already entered user_code on TAK.gov and authorized).
 */
router.post("/link", async (req, res) => {
  try {
    const result = await pluginsSvc.linkTakGovAccount();
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.message });
    }
    const auditUser = req.authentikUser;
    auditSvc.logEvent({
      actor: auditUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "PLUGIN_TAKGOV_LINKED",
      targetType: "plugin_manager",
      targetId: null,
      details: {},
    });
    res.json({ success: true, message: result.message });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

/**
 * POST /api/plugins/unlink
 * Unlink TAK.gov account.
 */
router.post("/unlink", (req, res) => {
  try {
    pluginsSvc.unlinkTakGovAccount();
    const auditUser = req.authentikUser;
    auditSvc.logEvent({
      actor: auditUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "PLUGIN_TAKGOV_UNLINKED",
      targetType: "plugin_manager",
      targetId: null,
      details: {},
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

/**
 * GET /api/plugins
 * List installed plugins only.
 */
router.get("/", (req, res) => {
  try {
    const plugins = pluginsSvc.listPlugins();
    res.json({ plugins });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

/**
 * GET /api/plugins/takgov/plugins
 * Query TAK.gov for plugin list (requires linked account). Query: product, product_version.
 */
router.get("/takgov/plugins", async (req, res) => {
  try {
    const product = (req.query.product || "ATAK-CIV").trim();
    const product_version = (req.query.product_version || "5.5.0").trim();
    if (!product || !product_version) {
      return res.status(400).json({ error: "product and product_version are required." });
    }
    const result = await pluginsSvc.fetchTakGovPlugins(product, product_version);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json({ success: true, plugins: result.plugins || [] });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

/**
 * POST /api/plugins/takgov/download
 * Download a plugin from TAK.gov and add to server. Body: plugin object from TAK.gov list (apk_url, display_name, etc.).
 */
router.post("/takgov/download", async (req, res) => {
  try {
    const pluginItem = req.body?.plugin || req.body;
    const result = await pluginsSvc.downloadTakGovPlugin(pluginItem);
    if (!result.success) {
      console.error("[plugins] TAK.gov download failed:", result.error);
      return res.status(400).json({ error: result.error });
    }
    const auditUser = req.authentikUser;
    auditSvc.logEvent({
      actor: auditUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "PLUGIN_DOWNLOADED_TAKGOV",
      targetType: "plugin",
      targetId: result.plugin?.id || null,
      details: { name: result.plugin?.name, filename: result.plugin?.filename },
    });
    res.json({ success: true, plugin: result.plugin });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

/**
 * POST /api/plugins/download
 * Body: { url, name?, atakFlavor?, atakVersion? } - download plugin from URL and add to store.
 */
router.post("/download", async (req, res) => {
  try {
    const { url, name, atakFlavor, atakVersion } = req.body || {};
    const downloadUrl = typeof url === "string" ? url.trim() : "";
    if (!downloadUrl) {
      return res.status(400).json({ error: "URL is required." });
    }
    const result = await pluginsSvc.addPluginFromUrl(downloadUrl, {
      name: name || undefined,
      source: "tak.gov",
      atakFlavor: atakFlavor || undefined,
      atakVersion: atakVersion || undefined,
    });
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    const auditUser = req.authentikUser;
    auditSvc.logEvent({
      actor: auditUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "PLUGIN_DOWNLOADED",
      targetType: "plugin",
      targetId: result.plugin?.id || null,
      details: { name: result.plugin?.name, filename: result.plugin?.filename },
    });
    res.json({ success: true, plugin: result.plugin });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

/**
 * POST /api/plugins/upload
 * Multipart: single file field "plugin". Adds to data/plugins and manifest.
 */
router.post("/upload", upload.single("plugin"), (req, res) => {
  try {
    if (!req.file || !req.file.path) {
      return res.status(400).json({ error: "No plugin file uploaded." });
    }
    const { name, atakFlavor, atakVersion } = req.body || {};
    const result = pluginsSvc.addPluginFromFile(req.file.path, {
      name: name || undefined,
      source: "upload",
      atakFlavor: atakFlavor || undefined,
      atakVersion: atakVersion || undefined,
    });
    try {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    } catch (_) {}
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    const auditUser = req.authentikUser;
    auditSvc.logEvent({
      actor: auditUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "PLUGIN_UPLOADED",
      targetType: "plugin",
      targetId: result.plugin?.id || null,
      details: { name: result.plugin?.name, filename: result.plugin?.filename },
    });
    res.json({ success: true, plugin: result.plugin });
  } catch (err) {
    try {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    } catch (_) {}
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

/**
 * PATCH /api/plugins/:id
 * Update plugin metadata. Body: { favorite?: boolean, description?: string } (at least one required)
 */
router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { favorite, description } = req.body || {};
    const updates = {};
    if (typeof favorite === "boolean") updates.favorite = favorite;
    if (description !== undefined) updates.description = typeof description === "string" ? description : null;
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "Body must include at least one of favorite (boolean) or description (string)." });
    }
    const result = pluginsSvc.updatePluginMetadata(id, updates);
    if (!result.success) {
      return res.status(404).json({ error: result.error });
    }
    res.json({ success: true, plugin: result.plugin });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

/**
 * POST /api/plugins/:id/update-from-takgov
 * Update a TAK.gov plugin to the latest version from TAK.gov (by package_name).
 */
router.post("/:id/update-from-takgov", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pluginsSvc.updatePluginFromTakGov(id);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    const auditUser = req.authentikUser;
    auditSvc.logEvent({
      actor: auditUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "PLUGIN_UPDATED_TAKGOV",
      targetType: "plugin",
      targetId: result.plugin?.id || id,
      details: { name: result.plugin?.name, filename: result.plugin?.filename },
    });
    res.json({ success: true, plugin: result.plugin });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

/**
 * DELETE /api/plugins/:id
 * Remove plugin and its file.
 */
router.delete("/:id", (req, res) => {
  try {
    const { id } = req.params;
    const result = pluginsSvc.deletePlugin(id);
    if (!result.success) {
      return res.status(404).json({ error: result.error });
    }
    const auditUser = req.authentikUser;
    auditSvc.logEvent({
      actor: auditUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "PLUGIN_DELETED",
      targetType: "plugin",
      targetId: id,
      details: {},
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

/**
 * GET /api/plugins/:id/download
 * Stream plugin file for download (admin only).
 */
router.get("/:id/download", (req, res) => {
  try {
    const { id } = req.params;
    const filePath = pluginsSvc.getPluginFilePath(id);
    if (!filePath) {
      return res.status(404).json({ error: "Plugin not found." });
    }
    const filename = path.basename(filePath);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

module.exports = router;
