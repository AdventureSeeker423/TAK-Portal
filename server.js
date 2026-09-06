require("dotenv").config({ quiet: true });
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const settingsSvc = require("./services/settings.service");
const prefPkgSvc = require("./services/preferencePackage.service");
const takDashboardCache = require("./services/takDashboardCache.service");
const axios = require("axios");
const { getString, getBool, isLiveMapEnabled } = require("./services/env");
const { URL } = require("url");
const pkg = require("./package.json");
const mutualAidSvc = require("./services/mutualAid.service");
const portalAuth = require("./services/portalAuth.middleware");
const portalAuthEnrich = require("./services/portalAuthEnrich.middleware");
const emailSvc = require("./services/email.service");
const smsSvc = require("./services/sms.service");
const emailTemplatesSvc = require("./services/emailTemplates.service");
const qrSvc = require("./services/qr.service");
const agenciesStore = require("./services/agencies.service");
const userRequestsSvc = require("./services/userRequests.service");
const userRequestsRoutes = require("./routes/userRequests.routes");
const auditSvc = require("./services/auditLog.service");
const permsSvc = require("./services/permissions.service");
const mouSvc = require("./services/mouService");
const mouScheduler = require("./services/mouScheduler");
const mapPageAssets = require("./services/mapPageAssets.service");
const mapBasemapsConfig = require("./config/mapBasemaps");
const accessControlRoutes = require("./routes/accessControl.routes");
const usersSvc = require("./services/users.service");
const groupsSvc = require("./services/groups.service");
const channelPatchStore = require("./services/channelPatch.store");
const channelPatchAccess = require("./services/channelPatchAccess.service");
const accessSvc = require("./services/access.service");
const agencyTypesSvc = require("./services/agencyTypes.service");
const regionsSvc = require("./services/regions.service");
const locatorsSvc = require("./services/locators.service");
const pluginsSvc = require("./services/plugins.service");
const atakApkSvc = require("./services/atakApk.service");
const { toSafeApiError } = require("./services/apiErrorPayload.service");
const {
  USER_AGREEMENT_SESSION_COOKIE,
  hasAcceptedAgreementForSession,
} = require("./services/userAgreementSession.service");

const app = express();

const FONT_FAMILY_OPTIONS = new Set([
  "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  "Arial, Helvetica, sans-serif",
  '"Helvetica Neue", Helvetica, Arial, sans-serif',
  "Verdana, Geneva, sans-serif",
  '"Trebuchet MS", Helvetica, sans-serif',
  "Tahoma, Geneva, sans-serif",
  "Georgia, serif",
  '"Times New Roman", Times, serif',
  "Garamond, serif",
  '"Palatino Linotype", "Book Antiqua", Palatino, serif',
  '"Courier New", Courier, monospace',
  '"Lucida Console", Monaco, monospace',
]);

const DEFAULT_SITE_FONT_FAMILY =
  "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

// Expose version to all EJS views (e.g. sidebar).
// `version` stays the last stable release so update checks and 1.4.9 installs
// are unchanged. `beta-version` is only present on post-stable builds.
const APP_STABLE_VERSION = String(pkg.version || "dev").trim();
const APP_BETA_VERSION = String(pkg["beta-version"] || "").trim();
app.locals.APP_VERSION = APP_STABLE_VERSION;
app.locals.APP_BETA_VERSION = APP_BETA_VERSION;
app.locals.APP_IS_BETA_BUILD = Boolean(
  APP_BETA_VERSION && APP_BETA_VERSION !== APP_STABLE_VERSION
);
app.locals.APP_LATEST_VERSION = APP_STABLE_VERSION;
app.locals.APP_UPDATE_AVAILABLE = false;

// Simple semver compare: returns true if `latest` > `current`
function isNewerVersion(latest, current) {
  const toParts = (v) =>
    String(v || "0.0.0")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);

  const [la, lb, lc] = toParts(latest);
  const [ca, cb, cc] = toParts(current);

  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

let loggedAvailableUpdateVersion = null;

async function refreshAppUpdateLocals() {
  try {
    const db = require("./services/db");
    if (!db.isConfigured()) return;
    const r = await db.query("SELECT latest, update_available FROM app_update_meta WHERE id = 1");
    const row = r.rows[0];
    if (!row) return;
    if (row.latest) app.locals.APP_LATEST_VERSION = row.latest;
    app.locals.APP_UPDATE_AVAILABLE = !!row.update_available;
    if (app.locals.APP_UPDATE_AVAILABLE && loggedAvailableUpdateVersion !== row.latest) {
      loggedAvailableUpdateVersion = row.latest;
      console.log(`[update] ${app.locals.APP_VERSION} → ${row.latest} available`);
    }
  } catch (_) {}
}

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/branding", express.static(path.join(__dirname, "data", "branding")));
app.use(
  "/mutual-aid-logos",
  express.static(path.join(__dirname, "data", "mutual-aid-logos"))
);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

const migrationGate = require("./services/migrationGate.middleware");
const stackHealthGate = require("./services/stackHealthGate.middleware");
const jsonImport = require("./services/jsonImport.service");
const stackHealth = require("./services/stackHealth.service");

app.get("/api/system/health", async (req, res) => {
  try {
    const health = await stackHealth.getStackHealth();
    return res.status(health.ok ? 200 : 503).json(health);
  } catch (e) {
    return res.status(503).json({
      ok: false,
      migrating: false,
      postgres: { ok: false, detail: e?.message || "health_failed" },
      worker: { ok: false, detail: "health_failed" },
    });
  }
});

app.get("/api/system/migration-status", async (req, res) => {
  try {
    return res.json(await jsonImport.readStatusJson());
  } catch (e) {
    return res.json({ active: false, phase: "idle", percent: 100 });
  }
});

app.post("/api/system/migration-retry", async (req, res) => {
  try {
    const s = await jsonImport.readStatusJson();
    if (s.phase !== "failed") {
      return res.status(409).json({ error: "retry_not_available", phase: s.phase });
    }
    jsonImport.retry().catch((e) => console.error("[json-import] retry:", e?.message || e));
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "retry failed" });
  }
});

app.get("/migration", async (req, res) => {
  try {
    const status = await jsonImport.readStatusJson();
    if (!status.active) return res.redirect("/");
    return res.status(503).render("migration", { status });
  } catch (e) {
    return res.redirect("/");
  }
});

app.get("/stack-down", async (req, res) => {
  try {
    const health = await stackHealth.getStackHealth();
    if (health.ok) return res.redirect("/");
    return res.status(503).render("stack-down", {
      health,
      unavailable: stackHealth.getUnavailablePageLocals(),
    });
  } catch (e) {
    const unavailable = stackHealth.getUnavailablePageLocals();
    return res.status(503).render("stack-down", {
      health: {
        ok: false,
        title: unavailable.title,
        message: unavailable.message,
      },
      unavailable,
    });
  }
});

app.use(migrationGate);
app.use(stackHealthGate);

// Multer storage for settings uploads (certs + branding)
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      let targetDir;

      if (
        file.fieldname === "TAK_API_P12_UPLOAD" ||
        file.fieldname === "TAK_CA_UPLOAD"
      ) {
        targetDir = path.join(__dirname, "data", "certs");
      } else if (file.fieldname === "BRAND_LOGO_UPLOAD") {
        targetDir = path.join(__dirname, "data", "branding");
      } else {
        targetDir = path.join(__dirname, "data", "uploads");
      }

      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      cb(null, targetDir);
    } catch (err) {
      console.error("Failed to determine upload destination:", err);
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    const safeOriginal = file.originalname
      ? file.originalname.replace(/[^a-zA-Z0-9_.-]/g, "_")
      : "upload";

    if (file.fieldname === "TAK_API_P12_UPLOAD") {
      return cb(null, "tak-client.p12");
    }

    if (file.fieldname === "TAK_CA_UPLOAD") {
      return cb(null, "tak-ca.pem");
    }

    if (file.fieldname === "BRAND_LOGO_UPLOAD") {
      const ext = path.extname(safeOriginal) || ".png";
      // A unique URL prevents browsers from showing a cached previous logo.
      return cb(null, `logo-${Date.now()}${ext}`);
    }

    cb(null, safeOriginal);
  },
});

const upload = multer({ storage: uploadStorage });

function pageTitleForPath(pathname, portalTitle, serverAbbrev) {
  const p = String(pathname || "/").replace(/\/+$/, "") || "/";
  const liveMapTitle = "Live Map";
  const labels = [
    ["/dashboard", "Dashboard"],
    ["/setup-my-device", "Setup My Device"],
    ["/users", "Users"],
    ["/groups", "Groups / Channels"],
    ["/templates", "Templates"],
    ["/audit-log", "Audit Log"],
    ["/data-packages", "Data Package"],
    ["/data-package", "Data Package"],
    ["/data-sync", "Data Sync"],
    ["/email", "Email Users"],
    ["/locate-persons", "Locate Persons"],
    ["/locate", "Locate Persons"],
    ["/mutual-aid", "Mutual Aid"],
    ["/admin/mou", "MOU Documents"],
    ["/mou", "MOU Documents"],
    ["/agencies", "Agencies"],
    ["/integrations", "Integrations"],
    ["/plugin-manager", "Plugin Manager"],
    ["/access-control", "Access Control"],
    ["/settings", "Server Settings"],
    ["/plugins", "ATAK Plugins"],
    ["/map", liveMapTitle],
    ["/getting-started", "Getting Started"],
    ["/channel-patch", "Channel Patch"],
    ["/pending-user-requests", "Pending Requests"],
    ["/lookup", "Lookup"],
    ["/request-access", "Request Access"],
  ];
  if (p === "/") return "Dashboard";
  let bestPrefix = "";
  let bestLabel = "";
  for (const [prefix, label] of labels) {
    if (p === prefix || p.startsWith(prefix + "/")) {
      if (prefix.length >= bestPrefix.length) {
        bestPrefix = prefix;
        bestLabel = label;
      }
    }
  }
  return bestLabel || portalTitle || "TAK Portal";
}

// Expose settings + theme/logo + current path to all views (for sidebar active state)
app.use((req, res, next) => {
  try {
    const settings = settingsSvc.getSettings();
    const defaultTheme = String(settings?.DEFAULT_THEME_MODE || "dark")
      .trim()
      .toLowerCase();
    const rawPrimaryButtonColor = String(
      settings?.PRIMARY_BUTTON_COLOR || ""
    ).trim();
    const primaryButtonColor = /^#[0-9a-fA-F]{6}$/.test(rawPrimaryButtonColor)
      ? rawPrimaryButtonColor
      : "";
    const rawSiteFontFamily = String(settings?.SITE_FONT_FAMILY || "").trim();
    const siteFontFamily = FONT_FAMILY_OPTIONS.has(rawSiteFontFamily)
      ? rawSiteFontFamily
      : "";
    res.locals.settings = settings || {};
    res.locals.teamColorLabels = prefPkgSvc.buildTeamColorLabelMap(settings || {});
    res.locals.roleLabels = prefPkgSvc.buildRoleLabelMap(settings || {});
    // Server default is used when no per-device theme has been saved yet.
    res.locals.brandTheme = defaultTheme === "light" ? "light" : "dark";
    res.locals.brandLogoUrl = settings.BRAND_LOGO_URL || "";
    const serverAbbrev =
      String(settings.SERVER_NAME || "")
        .trim()
        .toUpperCase() || "TAK";
    res.locals.serverAbbrev = serverAbbrev;
    res.locals.portalTitle = `${serverAbbrev} Portal`;
    res.locals.primaryButtonColor = primaryButtonColor;
    res.locals.siteFontFamily = siteFontFamily;
    res.locals.currentPath = (req.path || "/").replace(/\/+$/, "") || "/";
    res.locals.pageTitle = pageTitleForPath(
      res.locals.currentPath,
      res.locals.portalTitle,
      serverAbbrev
    );
  } catch (err) {
    console.warn("Failed to load settings for request:", err?.message || err);
    res.locals.settings = {};
    res.locals.teamColorLabels = {};
    res.locals.roleLabels = {};
    res.locals.brandTheme = "dark";
    res.locals.brandLogoUrl = "";
    res.locals.serverAbbrev = "TAK";
    res.locals.portalTitle = "TAK Portal";
    res.locals.primaryButtonColor = "";
    res.locals.siteFontFamily = "";
    res.locals.currentPath = (req.path || "/").replace(/\/+$/, "") || "/";
    res.locals.pageTitle = pageTitleForPath(
      res.locals.currentPath,
      res.locals.portalTitle,
      res.locals.serverAbbrev
    );
  }
  next();
});

// >>> Enforce optional Authentik/group access control <<<
// Public paths that must remain reachable without Authentik forward_auth
const PUBLIC_PATHS = new Set([
  "/lookup",
  "/request-access",
  "/request-access/confirmation",
  "/api/system/health",
]);

function isPublicPortalBypass(req) {
  const p = (req.path || "").replace(/\/+$/, "") || "/";
  const method = String(req.method || "").toUpperCase();
  if (PUBLIC_PATHS.has(p)) return true;
  // Public missing-person locator pages (not the admin /locate console)
  if (p.startsWith("/locate/") && p !== "/locate") return true;
  // Anonymous ping API for locator share links
  if (p.startsWith("/api/public/locate/")) return true;
  // Tokenized access-request review (under /request-access* for Caddy public bypass)
  if (method === "GET" && /^\/request-access\/[a-f0-9]{32,64}$/i.test(p)) return true;
  if (method === "GET" && /^\/request-access\/[a-f0-9]{32,64}\/(data|meta)$/i.test(p)) {
    return true;
  }
  if (method === "POST" && /^\/request-access\/[a-f0-9]{32,64}\/(approve|reject|create-agency)$/i.test(p)) {
    return true;
  }
  // Tokenized external MOU signing (under /request-access* for Caddy public bypass)
  if (method === "GET" && /^\/request-access\/mou\/[a-f0-9]{32,64}$/i.test(p)) return true;
  if (method === "GET" && /^\/request-access\/mou\/[a-f0-9]{32,64}\/file$/i.test(p)) {
    return true;
  }
  if (method === "POST" && /^\/request-access\/mou\/[a-f0-9]{32,64}\/sign$/i.test(p)) {
    return true;
  }
  if (method === "GET" && /^\/request-access\/mou\/complete\/[a-f0-9]{32,64}$/i.test(p)) {
    return true;
  }
  if (method === "GET" && /^\/request-access\/mou\/complete\/[a-f0-9]{32,64}\/pdf$/i.test(p)) {
    return true;
  }
  return false;
}

app.use((req, res, next) => {
  try {
    if (isPublicPortalBypass(req)) return next();
  } catch (_) {
    // fall through
  }
  return portalAuth(req, res, next);
});

app.use((req, res, next) => {
  try {
    if (isPublicPortalBypass(req)) return next();
  } catch (_) {
    // fall through
  }
  return portalAuthEnrich(req, res, next);
});

app.use((req, res, next) => {
  try {
    const user = req.authentikUser;
    const normalizedPath = (req.path || "").replace(/\/+$/, "") || "/";
    const isApi = normalizedPath.startsWith("/api/");
    const currentAgreement = mouSvc.getCurrentUserAgreement().current;
    const hasAcceptedAgreement =
      hasAcceptedAgreementForSession(req, user, currentAgreement);
    const isAgreementTargetUser = !!(user && user.username) && !user.isGlobalAdmin;
    const isPortalAdmin = !!(user && (user.isGlobalAdmin || user.isAgencyAdmin));
    const isAgreementApiPath =
      normalizedPath === "/api/mou/user-agreement/accept" ||
      normalizedPath === "/api/mou/user-agreement/decline";
    const isSetupMyDevicePath =
      normalizedPath === "/setup-my-device" ||
      normalizedPath.startsWith("/api/setup-my-device");
    const isAtakApkDownloadPath =
      normalizedPath === "/api/atak/download";
    const isAgreementExemptPath =
      normalizedPath === "/logout" ||
      isAgreementApiPath ||
      (isPortalAdmin && normalizedPath === "/dashboard") ||
      isSetupMyDevicePath ||
      isAtakApkDownloadPath;

    if (
      !isAgreementTargetUser ||
      !mouSvc.isEnabled() ||
      !mouSvc.shouldRequireUserAgreement(user, {
        acceptedForSession: hasAcceptedAgreement,
      })
    ) {
      return next();
    }

    if (isAgreementExemptPath) {
      return next();
    }

    if (isApi) {
      return res.status(423).json({
        error: "You must accept the current user agreement before continuing.",
      });
    }

    return res.redirect(isPortalAdmin ? "/dashboard" : "/setup-my-device");
  } catch (err) {
    console.warn("[mou-gate] Failed to evaluate user agreement gate:", err?.message || err);
    return next();
  }
});

function isApiRequest(req) {
  const p = req.originalUrl || req.path || "";
  return p.startsWith("/api/");
}

/** Capability check using effective permissions (role defaults minus overrides). */
function requirePermission(permissionId) {
  return (req, res, next) => {
    const eff = req.effectivePermissionSet;
    if (!eff || !permsSvc.can(eff, permissionId)) {
      const user = req.authentikUser;
      const username = user && user.username ? user.username : "";
      if (isApiRequest(req)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      return res.status(403).render("access-denied", { username });
    }
    next();
  };
}

app.get("/api/system/directory-sync-status", requirePermission("page.users"), async (req, res) => {
  try {
    const directorySync = require("./services/directorySync.service");
    return res.json(await directorySync.getDirectorySyncStatus());
  } catch (e) {
    return res.json({ ok: true, lastError: null, lastSuccessAt: null });
  }
});

function requireBetaMode(req, res, next) {
  const cfg = settingsSvc.getSettings() || {};
  const beta = String(cfg.BETA_MODE || "").toLowerCase() === "true";
  if (!beta) {
    return res.status(404).render("access-denied", {
      username: req.authentikUser?.username || "",
    });
  }
  next();
}

function requireGlobalAdminRole(req, res, next) {
  const u = req.authentikUser;
  if (!u || !u.isGlobalAdmin) {
    const username = u && u.username ? u.username : "";
    if (isApiRequest(req)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    return res.status(403).render("access-denied", { username });
  }
  return next();
}

function getMapStorageUserKey(req) {
  return String(req.authentikUser?.uid || req.authentikUser?.username || "anonymous").replace(
    /[^a-zA-Z0-9._-]/g,
    "_"
  );
}

function getDefaultMapSource() {
  const settings = settingsSvc.getSettings() || {};
  return mapBasemapsConfig.getDefaultMapSource(settings);
}

function applyLiveMapRuntime() {
  try {
    const geofenceEngine = require("./services/geofence.engine");
    if (isLiveMapEnabled()) {
      geofenceEngine.start();
    } else {
      geofenceEngine.stop();
    }
  } catch (e) {
    console.log("⚠️ Live Map runtime apply failed", e?.message || e);
  }
}

function isDashboardMiniMapApiPath(req) {
  const raw = String(req.path || req.url || "").split("?")[0];
  const p = raw.replace(/\/+$/, "") || "/";
  return (
    p === "/icons" ||
    p.startsWith("/icons/") ||
    p === "/api/map/icons" ||
    p.startsWith("/api/map/icons/")
  );
}

function requireLiveMapEnabled(req, res, next) {
  if (isLiveMapEnabled() || isDashboardMiniMapApiPath(req)) return next();
  if (isApiRequest(req)) {
    return res.status(404).json({ error: "Live Map is disabled" });
  }
  const u = req.authentikUser;
  const dest = u && (u.isGlobalAdmin || u.isAgencyAdmin) ? "/" : "/setup-my-device";
  return res.redirect(dest);
}

function requireMapAccess(req, res, next) {
  const u = req.authentikUser;
  if (!u) {
    const username = "";
    if (isApiRequest(req)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    return res.status(403).render("access-denied", { username });
  }
  return next();
}

function requireBetaModeApi(req, res, next) {
  const cfg = settingsSvc.getSettings() || {};
  const beta = String(cfg.BETA_MODE || "").toLowerCase() === "true";
  if (!beta) {
    return res.status(404).json({ error: "Not found" });
  }
  next();
}

app.get("/logout", (req, res) => {
  // Where to send the user back after logout (the portal itself)
  const portalUrlRaw =
    getString("TAK_PORTAL_PUBLIC_URL", "") ||
    `${req.protocol}://${req.get("host")}/`;
  res.clearCookie(USER_AGREEMENT_SESSION_COOKIE, {
    path: "/",
  });
  try {
    // Canonicalize so rd is always a full normalized URL (includes trailing slash on host roots).
    const portalUrl = new URL(portalUrlRaw).toString();

    // Use the outpost sign-out endpoint on the portal domain so the
    // outpost proxy cookie is cleared (prevents immediate re-authentication).
    const u = new URL(portalUrl);
    u.pathname = "/outpost.goauthentik.io/sign_out";
    u.searchParams.set("rd", portalUrl);
    return res.redirect(u.toString());
  } catch (err) {
    console.error("Failed to build outpost logout URL:", err);
    return res
      .status(500)
      .send("Logout is misconfigured. Check portal base URL/proxy setup.");
  }
});

// API Routes
app.use("/api/agencies", require("./routes/agencies.routes"));
app.use("/api/regions", require("./routes/regions.routes"));
app.use("/api/users", require("./routes/users.routes"));
app.use("/api/groups", require("./routes/groups.routes"));
app.use("/api/templates", require("./routes/templates.routes"));
app.use("/api/qr", require("./routes/qr.routes"));
app.use("/api/setup-my-device", require("./routes/setupDevice.routes"));
app.use("/api/mutual-aid", require("./routes/mutualAid.routes"));
app.use("/api/tak", require("./routes/takMetrics.routes"));
app.use("/api/user-requests", userRequestsRoutes);
// Allow authenticated users on the Plugins page to download plugin files.
app.get("/api/plugins/:id/download", (req, res) => {
  try {
    const { id } = req.params;
    const filePath = pluginsSvc.getPluginFilePath(id);
    if (!filePath) {
      return res.status(404).json({ error: "Plugin not found." });
    }
    const filename = path.basename(filePath);
    auditSvc.auditFromRequest(req, {
      action: "PLUGIN_DOWNLOADED",
      targetType: "plugin",
      targetId: String(id),
      details: {
        filename,
        summary: `Downloaded plugin file ${filename}.`,
      },
    });
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.sendFile(filePath);
  } catch (err) {
    return res.status(500).json({ error: toSafeApiError(err) });
  }
});
// Hosted ATAK client APK for Setup My Device (same audience as plugin downloads).
app.get("/api/atak/download", (req, res) => {
  try {
    const filePath = atakApkSvc.getApkFilePath();
    if (!filePath) {
      return res.status(404).json({ error: "No ATAK APK has been uploaded." });
    }
    const filename = atakApkSvc.getOriginalName();
    auditSvc.auditFromRequest(req, {
      action: "ATAK_APK_DOWNLOADED",
      targetType: "atak_apk",
      targetId: "client",
      details: {
        filename,
        summary: `Downloaded hosted ATAK APK ${filename}.`,
      },
    });
    const safeDisposition = String(filename || "atak-client.apk").replace(
      /["\\\r\n]/g,
      "_"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeDisposition}"`
    );
    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    return res.sendFile(filePath);
  } catch (err) {
    return res.status(500).json({ error: toSafeApiError(err) });
  }
});
app.use("/api/audit-log", requirePermission("page.audit_log"), require("./routes/auditLog.routes"));
app.use("/api/plugins", requirePermission("page.plugin_manager"), require("./routes/plugins.routes"));
app.use("/api/integrations", requirePermission("page.integrations"), require("./routes/integrations.routes"));
app.use("/api/ssh", requirePermission("page.integrations"), require("./routes/ssh.routes"));
app.use("/api/map", requireMapAccess, requireLiveMapEnabled, require("./routes/map.routes"));
app.use(
  "/api/channel-patch",
  requirePermission("page.channel_patch"),
  require("./routes/channel-patch.routes")
);
app.use(
  "/api/settings/tak-maintenance",
  requirePermission("page.settings"),
  require("./routes/settingsTakMaintenance.routes")
);
app.use(
  "/api/settings/atak-apk",
  requirePermission("page.settings"),
  require("./routes/atakApk.routes")
);
app.use(
  "/api/settings/openaddresses",
  requirePermission("page.settings"),
  require("./routes/openaddresses.routes")
);
app.use(
  "/api/settings/backup",
  requirePermission("page.settings"),
  require("./routes/settingsBackup.routes")
);
app.use(
  "/api/settings/legacy-import",
  requirePermission("page.settings"),
  require("./routes/settingsLegacyImport.routes")
);
// Locate + data packages (admin + JSON APIs): page-aligned capability.
app.use("/api/locate", requirePermission("page.locate"), require("./routes/locate.routes"));

app.use(
  "/api/data-sync",
  requirePermission("page.data_sync"),
  require("./routes/dataSync.routes")
);
app.use(
  "/api/data-packages",
  requirePermission("page.data_package"),
  require("./routes/dataPackages.routes")
);

// Public locate APIs: CORS + OPTIONS (preflight for JSON POST).
function publicLocateApiCors(req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, X-Requested-With"
  );
  res.setHeader("Access-Control-Max-Age", "7200");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
}

function handlePublicLocateClientConfig(req, res) {
  try {
    const slug = String(req.params.slug || "").trim().toLowerCase();
    const cfg = locatorsSvc.getClientConfigForPublicSlug(slug);
    if (!cfg) {
      return res.status(404).json({ ok: false, error: "Locator not found." });
    }
    res.json(cfg);
  } catch (err) {
    res.status(500).json({ ok: false, error: toSafeApiError(err) });
  }
}

function formStringField(v) {
  if (v == null || v === "") return "";
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return formStringField(v[0]);
  return String(v).trim();
}

async function handlePublicLocatePing(req, res) {
  try {
    const slug = String(req.params.slug || "").trim().toLowerCase();
    const loc = locatorsSvc.getBySlug(slug);
    if (!loc || loc.archived) {
      return res.status(404).json({ ok: false, error: "Locator not found." });
    }
    if (!loc.active) {
      return res.status(403).json({ ok: false, error: "This locator is inactive." });
    }
    const body = req.body || {};
    const lat = Number(body.latitude);
    const lng = Number(body.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ ok: false, error: "Valid latitude and longitude are required." });
    }
    const accuracyMeters = Number(body.accuracyMeters);
    const acc =
      Number.isFinite(accuracyMeters) && accuracyMeters >= 0 && accuracyMeters < 1e7
        ? accuracyMeters
        : null;
    const last = formStringField(body.lastName);
    const first = formStringField(body.firstName);
    const name = locatorsSvc.formatLocatePingNameForTak(first, last);
    const remarks = formStringField(body.remarks);

    locatorsSvc.addHistoryEntry({
      locatorId: loc.id,
      latitude: lat,
      longitude: lng,
      name,
      remarks,
      kind: "interval",
      accuracyMeters: acc,
    });

    const accLabel =
      acc != null ? ` (accuracy about ${Math.round(acc)} m)` : "";
    const remarksShort = remarks
      ? String(remarks).trim().slice(0, 240)
      : "";
    auditSvc.logEvent({
      actor: null,
      request: {
        method: req.method,
        path: req.originalUrl || req.path,
        ip: req.ip,
      },
      action: "LOCATE_PUBLIC_POSITION_REPORTED",
      targetType: "locator",
      targetId: loc.id,
      details: {
        slug,
        locatorTitle: loc.title,
        latitude: lat,
        longitude: lng,
        accuracyMeters: acc,
        takDisplayName: name,
        remarksPreview: remarksShort || undefined,
        clientUserAgent: String(req.get("user-agent") || "").trim().slice(0, 400) || undefined,
        summary: `Someone using the public locate page reported a position for "${loc.title}" (${slug}): ${lat.toFixed(
          5
        )}, ${lng.toFixed(5)}${accLabel}. Display name sent to TAK: ${name}${
          remarksShort ? `. Remarks: ${remarksShort}` : ""
        }.`,
      },
    });

    res.json({ ok: true });

    setImmediate(() => {
      locatorsSvc
        .relayPingToTak({
          latitude: lat,
          longitude: lng,
          name,
          remarks,
        })
        .catch((err) => {
          console.error("[locate ping] TAK relay failed:", err?.message || err);
        });
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: toSafeApiError(err) });
  }
}

function handlePublicLocateStopSharing(req, res) {
  try {
    const slug = String(req.params.slug || "").trim().toLowerCase();
    const loc = locatorsSvc.getBySlug(slug);
    if (!loc || loc.archived) {
      return res.status(404).json({ ok: false, error: "Locator not found." });
    }
    if (!loc.active) {
      return res.status(403).json({ ok: false, error: "This locator is inactive." });
    }
    locatorsSvc.setSharingStoppedByUser(loc.id, true);
    auditSvc.logEvent({
      actor: null,
      request: {
        method: req.method,
        path: req.originalUrl || req.path,
        ip: req.ip,
      },
      action: "LOCATE_PUBLIC_SHARING_STOPPED",
      targetType: "locator",
      targetId: loc.id,
      details: {
        slug,
        locatorTitle: loc.title,
        clientUserAgent: String(req.get("user-agent") || "").trim().slice(0, 400) || undefined,
        summary: `Someone using the public locate page stopped sharing for "${loc.title}" (${slug}).`,
      },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: toSafeApiError(err) });
  }
}

app.use("/api/public/locate", publicLocateApiCors);
app.get("/api/public/locate/:slug/client-config", handlePublicLocateClientConfig);
app.post("/api/public/locate/:slug/ping", handlePublicLocatePing);
app.post("/api/public/locate/:slug/stop-sharing", handlePublicLocateStopSharing);

// Same handlers under /locate/:slug/... so reverse proxies can expose only /locate/* as
// public (bypassing forward_auth) without listing /api/public/locate/* — e.g. Caddy @public path /locate/*
app.options("/locate/:slug/ping", publicLocateApiCors);
app.get(
  "/locate/:slug/client-config",
  publicLocateApiCors,
  handlePublicLocateClientConfig
);
app.post("/locate/:slug/ping", publicLocateApiCors, handlePublicLocatePing);
app.options("/locate/:slug/stop-sharing", publicLocateApiCors);
app.post("/locate/:slug/stop-sharing", publicLocateApiCors, handlePublicLocateStopSharing);
app.use("/api/email", requirePermission("page.email"), require("./routes/email.routes"));
app.use("/", require("./routes/mou.routes"));
app.use("/dashboard", require("./routes/dashboard.routes"));

// Access control (per-user permission deny overrides)
app.get("/access-control", requirePermission("page.access_control"), (req, res) =>
  res.render("access-control")
);
app.use(
  "/api/access-control",
  requirePermission("page.access_control"),
  accessControlRoutes
);

// UI Routes

app.get("/", (req, res) => {
  const user = req.authentikUser;
  const isAdmin = !!(user && (user.isGlobalAdmin || user.isAgencyAdmin));
  if (!isAdmin) return res.redirect("setup-my-device");
  return res.redirect("dashboard");
});

app.get("/users", requirePermission("page.users"), async (req, res) => {
  const pendingUserRequestsCount =
    userRequestsSvc.countRequestsForUser(req.authentikUser);
  const enrollmentPkg = require("./services/enrollmentPackage.service");

  return res.render("users", {
    pendingUserRequestsCount,
    dataPackageAvailable: enrollmentPkg.isDataPackageAvailable(),
  });
});
app.get("/users/manage", requirePermission("page.users"), (req, res) => res.redirect(301, "/users"));
app.get("/users/create", requirePermission("page.users"), (req, res) => res.redirect(301, "/users"));
app.get("/sample-users.csv", requirePermission("page.users"), (req, res) => {
  const filePath = path.join(__dirname, "sample-users.csv");
  return res.download(filePath, "users-import-template.csv");
});
app.get("/sample-agencies.csv", requirePermission("page.users"), (req, res) => {
  const filePath = path.join(__dirname, "sample-agencies.csv");
  return res.download(filePath, "agencies-import-template.csv");
});
app.get("/csv-instructions-readme.txt", requirePermission("page.users"), (req, res) => {
  const filePath = path.join(__dirname, "csv-instructions-readme.txt");
  return res.download(filePath, "csv-instructions-readme.txt");
});
app.get("/groups", async (req, res) => {
  const canSeeChannelPatch =
    typeof res.locals.perm !== "function" || res.locals.perm("page.channel_patch");
  let activeChannelPatchCount = 0;
  if (canSeeChannelPatch) {
    try {
      const enabled = channelPatchStore.listEnabled();
      if (enabled.length) {
        const authUser = req.authentikUser || null;
        const access = accessSvc.getAgencyAccess(authUser);
        const allowed = await channelPatchAccess.resolveAllowedChannelKeySet(authUser);
        activeChannelPatchCount = channelPatchAccess.filterPatchesForAccess(
          access,
          enabled,
          allowed
        ).length;
      }
    } catch (_) {
      activeChannelPatchCount = 0;
    }
  }
  return res.render("groups", { canSeeChannelPatch, activeChannelPatchCount });
});
app.get("/agencies", requirePermission("page.agencies"), (req, res) =>
  res.render("agencies", {
    agencyTypeOptions: agencyTypesSvc.getAgencyTypeOptions(),
    regionOptions: regionsSvc.listNormalized(),
    regionCountyLocks: regionsSvc.listLocks(),
  })
); //require Global Admin
app.get("/templates", (req, res) => res.render("templates"));
app.get("/mutual-aid", requirePermission("page.mutual_aid"), (req, res) => {
  let enrollmentFlyerHtml = "";
  try {
    enrollmentFlyerHtml = fs.readFileSync(
      path.join(__dirname, "views", "partials", "mutual_aid_enrollment_flyer.html"),
      "utf8"
    );
  } catch (err) {
    console.warn(
      "[mutual-aid] enrollment flyer template missing:",
      err?.message || err
    );
  }
  let flyerUserAgreement = { enabled: false, text: "" };
  try {
    const agreement = mouSvc.getCurrentUserAgreement();
    const body = String(agreement?.current?.bodyMarkdown || "").trim();
    flyerUserAgreement = {
      enabled: agreement?.enabled === true && !!body,
      text: body,
    };
  } catch (err) {
    console.warn(
      "[mutual-aid] user agreement unavailable for flyer:",
      err?.message || err
    );
  }
  res.render("mutual-aid", { enrollmentFlyerHtml, flyerUserAgreement });
}); //require Global Admin
app.get("/integrations", requirePermission("page.integrations"), (req, res) =>
  res.render("integrations")
);

// Admin: email (global + agency defaults; overridable per user)
app.get("/email", requirePermission("page.email"), (req, res) =>
  res.render("email")
);

// Channel Patch (global + agency admins; agency-scoped in the route)
app.get("/channel-patch", requirePermission("page.channel_patch"), (req, res) =>
  res.render("channel-patch")
);
app.get("/locate-persons", (req, res) => {
  res.redirect(301, "/locate");
});

// Locate admin page: global admins only (not beta-gated).
app.get("/locate", requirePermission("page.locate"), (req, res) => res.render("locate"));

app.get("/data-sync", requirePermission("page.data_sync"), (req, res) =>
  res.render("data-sync")
);

// Public share link for a locator (no auth)
app.get("/locate/:slug", (req, res) => {
  const slug = String(req.params.slug || "").trim().toLowerCase();
  const loc = locatorsSvc.getBySlug(slug);
  if (!loc || loc.archived) {
    return res.status(404).render("locate-not-found");
  }
  return res.render("locate-public", {
    slug: loc.slug,
    pingIntervalSeconds: locatorsSvc.normalizePingIntervalSeconds(loc.pingIntervalSeconds),
    locatorActive: loc.active,
    intervalEpoch: Number(loc.intervalEpoch) || 1,
    remotePingEpoch: Number(loc.remotePingEpoch) || 1,
  });
});

// Plugin Manager (global admin only)
app.get("/plugin-manager", requirePermission("page.plugin_manager"), async (req, res) => {
  const pluginsSvc = require("./services/plugins.service");
  const takGovLink = await pluginsSvc.getTakGovLinkState(false);
  const plugins = pluginsSvc.listPlugins();
  return res.render("plugin-manager", { takGovLink, plugins });
});

// Beta: Getting Started (global admins only, beta mode)
app.get("/map", requireMapAccess, requireLiveMapEnabled, (req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  const mapUserKey = getMapStorageUserKey(req);
  return res.render("map", {
    ...mapPageAssets.getRenderLocals(),
    mapStorageUserKey: mapUserKey,
    defaultMapSource: getDefaultMapSource(),
  });
});
app.get("/getting-started", requireGlobalAdminRole, requireBetaMode, (req, res) =>
  res.render("getting-started")
);

// Data Package (global admins only; not beta-gated)
app.get("/data-package", requirePermission("page.data_package"), (req, res) =>
  res.render("data-package")
);
app.get("/data-packages", requirePermission("page.data_package"), (req, res) =>
  res.redirect("/data-package")
);

// Plugins page (any authenticated user)
app.get("/plugins", (req, res) => {
  const pluginsSvc = require("./services/plugins.service");
  const plugins = pluginsSvc.listPlugins();
  const selectedAtakVersion = String(req.query?.atak || "").trim();
  return res.render("plugins", { plugins, selectedAtakVersion });
});

// Admin: audit log (GLOBAL ADMINS ONLY)
app.get("/audit-log", requirePermission("page.audit_log"), async (req, res) => {
  try {
    const raw = req.query || {};

    const filters = {
      q: raw.q || "",
      actor: raw.actor || "",
      action: raw.action || "",
      targetType: raw.targetType || "",
      agencySuffix: raw.agencySuffix || "",
      from: raw.from || "",
      to: raw.to || "",
      page: raw.page || "1",
      pageSize: raw.pageSize || "50",
    };

    const result = await auditSvc.queryLogs(filters);
    const agencies = agenciesStore.load();

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isUuid = (s) => typeof s === "string" && uuidRegex.test(s.trim());
    const userIds = new Set();
    const groupIds = new Set();
    (result.items || []).forEach((log) => {
      const t = String(log.targetType || "").toLowerCase();
      const tid = log.targetId != null ? String(log.targetId).trim() : "";
      if ((t === "user" || t === "authentik_user") && tid && !isUuid(tid)) userIds.add(tid);
      const d = log.details || {};
      if (d.userId != null) userIds.add(String(d.userId));
      if (d.UserId != null) userIds.add(String(d.UserId));
      if (Array.isArray(d.groups)) {
        d.groups.forEach((g) => {
          const id = g != null ? String(g).trim() : "";
          if (id && isUuid(id)) groupIds.add(id);
        });
      }
      if (d.groupId != null && isUuid(String(d.groupId))) groupIds.add(String(d.groupId));
      if (d.GroupId != null && isUuid(String(d.GroupId))) groupIds.add(String(d.GroupId));
    });

    const userMap = {};
    const groupMap = {};
    await Promise.all([
      ...Array.from(userIds).map(async (id) => {
        try {
          const u = await usersSvc.getUserById(id);
          userMap[id] = { username: u?.username ?? null, name: u?.name ?? null };
        } catch {
          userMap[id] = { username: null, name: null };
        }
      }),
      ...Array.from(groupIds).map(async (uuid) => {
        try {
          const g = await groupsSvc.getGroupById(uuid);
          groupMap[uuid] = g?.name ?? null;
        } catch {
          groupMap[uuid] = null;
        }
      }),
    ]);

    // Build agency lookup map by suffix
  const agencyMap = {};
  (Array.isArray(agencies) ? agencies : []).forEach(a => {
    const sfx = String(a?.suffix || "").trim().toLowerCase();
    if (sfx) agencyMap[sfx] = a;
  });

  const agencyOptions = (Array.isArray(agencies) ? agencies : [])
    .map((a) => ({
      value: String(a?.suffix || "").trim().toLowerCase(),
      label: `${String(a?.name || a?.groupPrefix || a?.suffix || "").trim()} (${String(a?.suffix || "").trim()})`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const [actionOptions, targetTypeOptions, actorOptions] = await Promise.all([
    auditSvc.listDistinctValues({ field: "actions" }),
    auditSvc.listDistinctValues({ field: "targetTypes" }),
    auditSvc.listDistinctActors(),
  ]);

  function buildLink(newPage) {
    const u = new URL(`${req.protocol}://${req.get("host")}${req.path}`);
    Object.entries(filters).forEach(([k, v]) => {
      if (k === "page") return;
      if (v != null && String(v).trim() !== "") {
        u.searchParams.set(k, String(v));
      }
    });
    u.searchParams.set("page", String(newPage));
    if (filters.pageSize) {
      u.searchParams.set("pageSize", String(filters.pageSize));
    }
    return u.pathname + u.search;
  }

  const pageLinks = {
    first: buildLink(1),
    prev: buildLink(Math.max(1, result.page - 1)),
    next: buildLink(Math.min(result.pageCount, result.page + 1)),
    last: buildLink(result.pageCount),
  };

  return res.render("audit-log", {
    filters,
    result,
    pageLinks,
    agencyOptions,
    actionOptions,
    targetTypeOptions,
    actorOptions,
    agencyMap,
    userMap: userMap || {},
    groupMap: groupMap || {},
  });
  } catch (err) {
    console.error("[audit-log]", err?.message || err);
    res.status(500).send("Failed to load audit log.");
  }
});

app.get("/setup-my-device", async (req, res) => {
  // Used by the Setup My Device page to display the correct TAK server hostname.
  const takHost = qrSvc.getTakHost();
  let enrollQrBootstrap = null;
  const user = req.authentikUser;
  const u = user && String(user.username || "").trim();
  // Precompute standard (ATAK / TAK Aware) enrollment QR on the server so the first
  // "Scan QR" click does not rely on a client fetch (avoids intermittent failures when
  // reverse proxies or sessions mishandle XHR/fetch to the same API).
  if (
    u &&
    u !== "bootstrap" &&
    qrSvc.getTakUrl()
  ) {
    try {
      const tokensSvc = require("./services/authentikTokens.service");
      const { identifier, key, expiresAt } =
        await tokensSvc.getOrCreateEnrollmentAppPassword({
          username: u,
          userId: user.uid || null,
        });
      const enrollUrl = qrSvc.buildEnrollUrl({ username: u, token: key });
      const qrCode = enrollUrl
        ? await qrSvc.generateDisplayQrDataUrl(enrollUrl)
        : "";
      enrollQrBootstrap = {
        username: u,
        tokenIdentifier: identifier,
        token: key,
        expiresAt,
        enrollUrl: enrollUrl || "",
        qrCode,
      };
    } catch (err) {
      console.warn(
        "[setup-my-device] enroll QR bootstrap failed:",
        err?.message || err
      );
      enrollQrBootstrap = null;
    }
  }
  const locateConfigSvc = require("./services/locateConfig.service");
  const takSshSvc = require("./services/takSsh.service");
  return res.render("setup-my-device", {
    takHost,
    enrollQrBootstrap,
    sshConfigured: !!takSshSvc.isPrivilegedSshReady(),
    atakApk: atakApkSvc.getApkInfo(),
    agreementSummary: mouSvc.getAgreementSummaryForUser(req.authentikUser, {
      acceptedForSession: hasAcceptedAgreementForSession(
        req,
        req.authentikUser,
        mouSvc.getCurrentUserAgreement().current
      ),
    }),
  });
});


// Public: account lookup (must remain reachable by non-authenticated users)
app.get("/lookup", (req, res) => {
  const settings = (res.locals && res.locals.settings)
    ? res.locals.settings
    : (settingsSvc.getSettings() || {});

  const hcaptchaSiteKey = String(settings.HCAPTCHA_SITE_KEY || "").trim();
  const hcaptchaSecretKey = String(settings.HCAPTCHA_SECRET_KEY || "").trim();
  const hcaptchaEnabled = !!(hcaptchaSiteKey && hcaptchaSecretKey);

  return res.render("lookup", {
    form: {},
    error: null,
    success: null,
    hcaptchaEnabled,
    hcaptchaSiteKey: hcaptchaEnabled ? hcaptchaSiteKey : ""
  });
});

app.post("/lookup", async (req, res) => {
  const body = req.body || {};
  const form = {
    email: String(body.email || "").trim().toLowerCase(),
    username: String(body.username || "").trim().toLowerCase(),
  };

  const settings = (res.locals && res.locals.settings)
    ? res.locals.settings
    : (settingsSvc.getSettings() || {});

  const hcaptchaSiteKey = String(settings.HCAPTCHA_SITE_KEY || "").trim();
  const hcaptchaSecretKey = String(settings.HCAPTCHA_SECRET_KEY || "").trim();
  const hcaptchaEnabled = !!(hcaptchaSiteKey && hcaptchaSecretKey);
  let hcaptchaPassed = !hcaptchaEnabled;
  let lookupAuditLogged = false;

  function renderLookupError() {
    return res.status(400).render("lookup", {
      form: req.body || {},
      error: "Email address or Username Not Found",
      success: null,
      hcaptchaEnabled,
      hcaptchaSiteKey: hcaptchaEnabled ? hcaptchaSiteKey : "",
    });
  }

  function logLookupFailure(failureReason, extra = {}) {
    lookupAuditLogged = true;
    auditSvc.logLookupEvent(req, {
      form,
      outcome: "failure",
      failureReason,
      hcaptchaEnabled,
      hcaptchaPassed,
      ...extra,
    });
  }

  try {
    if (hcaptchaEnabled) {
      const token = body["h-captcha-response"];
      if (!token) {
        logLookupFailure("captcha_missing");
        throw new Error("Captcha verification failed.");
      }

      const params = new URLSearchParams();
      params.append("secret", hcaptchaSecretKey);
      params.append("response", token);

      const verifyResp = await axios.post(
        "https://hcaptcha.com/siteverify",
        params.toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );

      if (!verifyResp?.data?.success) {
        logLookupFailure("captcha_failed");
        throw new Error("Captcha verification failed.");
      }
      hcaptchaPassed = true;
    }

    if (!form.email || !form.username) {
      logLookupFailure("missing_fields");
      throw new Error("Agency Domain or Username Not Found");
    }

    const emailParts = form.email.split("@");
    if (emailParts.length !== 2 || !emailParts[0] || !emailParts[1]) {
      logLookupFailure("invalid_email", {
        form: { ...form, emailDomain: null },
      });
      throw new Error("Agency Domain or Username Not Found");
    }

    const domain = emailParts[1].toLowerCase();
    const formWithDomain = { ...form, emailDomain: domain };

    const agencies = agenciesStore.load() || [];
    const lookupEnabledAgencyCount = agencies.filter(
      (a) => a && a.lookupEnabled === true && agenciesStore.isAgencyPublicEnrollmentEligible(a)
    ).length;

    const domainMatch = agencies.find((a) => {
      if (!a) return false;
      if (a.lookupEnabled !== true) return false;
      return agenciesStore.emailDomainInAgencyList(form.email, a.lookupDomain);
    });

    if (domainMatch && !agenciesStore.isAgencyPublicEnrollmentEligible(domainMatch)) {
      logLookupFailure("agency_disabled", {
        form: formWithDomain,
        agencySuffix: String(domainMatch?.suffix || "").trim().toLowerCase() || undefined,
        agencyName: String(domainMatch?.name || "") || undefined,
        lookupEnabledAgencyCount,
      });
      throw new Error("Email address or Username Not Found");
    }

    const agency = domainMatch && agenciesStore.isAgencyPublicEnrollmentEligible(domainMatch)
      ? domainMatch
      : null;

    if (!agency) {
      logLookupFailure("agency_not_eligible", {
        form: formWithDomain,
        lookupEnabledAgencyCount,
      });
      throw new Error("Email address or Username Not Found");
    }

    const found = await usersSvc.getUserById(form.username);
    const usernameExists = !!found;
    const userHasEmailOnFile = !!(found && found.email && String(found.email).trim());
    const user = found && !userHasEmailOnFile ? found : null;

    if (!user) {
      logLookupFailure("user_not_found", {
        form: formWithDomain,
        agencySuffix: String(agency?.suffix || "").trim().toLowerCase() || undefined,
        agencyName: String(agency?.name || "") || undefined,
        lookupEnabledAgencyCount,
        usernameExists,
        userHasEmailOnFile,
      });
      throw new Error("Email address or Username Not Found");
    }

    const tokensSvc = require("./services/authentikTokens.service");

    const { key } = await tokensSvc.getOrCreateEnrollmentAppPassword({
      username: user.username,
      userId: user.pk || user.id,
    });

    const enrollUrl = qrSvc.buildEnrollUrl({
      username: user.username,
      token: key,
    });

    const pngBuffer = await qrSvc.generateDownloadPng(enrollUrl, user.username);

    try {
      await emailSvc.sendMail({
        to: form.email,
        subject: "Your TAK Enrollment QR Code",
        text: "Attached is your TAK enrollment QR code. Please note that this QR code is valid only for 15 minutes.",
        attachments: [
          {
            filename: `tak-${user.username}-enrollment-qr.png`,
            content: pngBuffer,
          },
        ],
      });
    } catch (mailErr) {
      logLookupFailure("email_send_failed", {
        form: formWithDomain,
        agencySuffix: String(agency?.suffix || "").trim().toLowerCase() || undefined,
        agencyName: String(agency?.name || "") || undefined,
        matchedUsername: user.username,
        matchedUserId: String(user.pk || user.id || "").trim() || undefined,
        usernameExists: true,
        userHasEmailOnFile: false,
        errorMessage: mailErr?.message || String(mailErr),
      });
      throw mailErr;
    }

    auditSvc.logLookupEvent(req, {
      form: formWithDomain,
      outcome: "success",
      hcaptchaEnabled,
      hcaptchaPassed,
      agencySuffix: String(agency?.suffix || "").trim().toLowerCase() || undefined,
      agencyName: String(agency?.name || "") || undefined,
      matchedUsername: user.username,
      matchedUserId: String(user.pk || user.id || "").trim() || undefined,
      usernameExists: true,
      userHasEmailOnFile: false,
      lookupEnabledAgencyCount,
    });
    lookupAuditLogged = true;

    return res.render("lookup", {
      form: {},
      error: null,
      success:
        "Your account has been found and a QR code has been sent to your email address. Please note that this QR code is valid only for 15 minutes.",
      hcaptchaEnabled,
      hcaptchaSiteKey: hcaptchaEnabled ? hcaptchaSiteKey : "",
    });
  } catch (err) {
    if (!lookupAuditLogged) {
      auditSvc.logLookupEvent(req, {
        form,
        outcome: "failure",
        failureReason: "unknown",
        hcaptchaEnabled,
        hcaptchaPassed,
        errorMessage: err?.message || String(err),
      });
    }
    return renderLookupError();
  }
});

// Public: request access form (must remain reachable by non-authenticated users)
function isRequestAccessEnabled() {
  return getBool("REQUEST_ACCESS_ENABLED", true);
}

function isRequestAccessRequireAllAgencyDetails() {
  return getBool("REQUEST_ACCESS_REQUIRE_ALL_AGENCY_DETAILS", false);
}

function renderRequestAccessDisabled(req, res) {
  return res.status(404).render("access-denied", {
    username: req.authentikUser?.username || "",
  });
}

app.get("/request-access", (req, res) => {
  if (!isRequestAccessEnabled()) return renderRequestAccessDisabled(req, res);
  const agencies = agenciesStore.filterPublicEnrollmentAgencies(agenciesStore.load());
  const settings = (res.locals && res.locals.settings) ? res.locals.settings : (settingsSvc.getSettings() || {});
  const hcaptchaSiteKey = String(settings.HCAPTCHA_SITE_KEY || "").trim();
  const hcaptchaSecretKey = String(settings.HCAPTCHA_SECRET_KEY || "").trim();
  const hcaptchaEnabled = !!(hcaptchaSiteKey && hcaptchaSecretKey);

  return res.render("request-access", {
    agencies,
    form: {},
    error: null,
    requireAllAgencyDetails: isRequestAccessRequireAllAgencyDetails(),
    agencyTypeOptions: agencyTypesSvc.getAgencyTypeOptions(),
    regionOptions: regionsSvc.listNormalized(),
    regionCountyLocks: regionsSvc.listLocks(),
    hcaptchaEnabled,
    hcaptchaSiteKey: hcaptchaEnabled ? hcaptchaSiteKey : ""
  });
});

app.post("/request-access", async (req, res) => {
  try {
    if (!isRequestAccessEnabled()) return renderRequestAccessDisabled(req, res);
    const body = req.body || {};

    // hCaptcha enforcement (enabled only if BOTH keys are set)
    const settings = (res.locals && res.locals.settings) ? res.locals.settings : (settingsSvc.getSettings() || {});
    const hcaptchaSiteKey = String(settings.HCAPTCHA_SITE_KEY || "").trim();
    const hcaptchaSecretKey = String(settings.HCAPTCHA_SECRET_KEY || "").trim();
    const hcaptchaEnabled = !!(hcaptchaSiteKey && hcaptchaSecretKey);

    if (hcaptchaEnabled) {
      const token = body["h-captcha-response"];
      if (!token) {
        throw new Error("Please complete the captcha before submitting.");
      }

      const params = new URLSearchParams();
      params.append("secret", hcaptchaSecretKey);
      params.append("response", token);

      const verifyResp = await axios.post("https://hcaptcha.com/siteverify", params.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });

      if (!verifyResp?.data?.success) {
        throw new Error("Captcha verification failed. Please try again.");
      }
    }

    const created = await userRequestsSvc.createRequest({
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email,
      badgeNumber: body.badgeNumber,
      radioCallsign: body.radioCallsign,
      agencySuffix: body.agencySuffix,
      otherAgency: body.otherAgency,
      otherReason: body.otherReason,
      groupPrefix: body.groupPrefix,
      usernameTokenPlacement: body.usernameTokenPlacement,
      suffix: body.suffix,
      state: body.state,
      county: body.county,
      countyAbbrev: body.countyAbbrev,
      type: body.type,
      stateFederalAgency: body.stateFederalAgency,
    });

    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "CREATE_ACCESS_REQUEST",
      targetType: "user_request",
      targetId: String(created?.id || ""),
      details: {
        source: "request-access-form",
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email,
        badgeNumber: body.badgeNumber,
        radioCallsign: body.radioCallsign,
        agencySuffix: body.agencySuffix,
        otherAgency: body.otherAgency,
        otherReason: body.otherReason,
        groupPrefix: body.groupPrefix,
        usernameTokenPlacement: body.usernameTokenPlacement,
        suffix: body.suffix,
        state: body.state,
        county: body.county,
        countyAbbrev: body.countyAbbrev,
        type: body.type,
        stateFederalAgency: body.stateFederalAgency,
      },
    });

    if (created?.autoApproved) {
      auditSvc.logEvent({
        actor: req.authentikUser || null,
        request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
        action: "CREATE_USER",
        targetType: "user",
        targetId: String(created?.createdUser?.pk || created?.createdUsername || ""),
        details: {
          username: created?.createdUsername,
          email: body.email,
          name: [body.lastName, body.firstName].filter(Boolean).join(", "),
          groups: Array.isArray(created?.createdGroups)
            ? created.createdGroups.map((g) => g?.name).filter(Boolean)
            : [],
          created_method: "request_access_auto_approve",
          agencySuffix: body.agencySuffix,
        },
      });
    }

    return res.redirect(
      created?.autoApproved
        ? "/request-access/confirmation?created=1"
        : "/request-access/confirmation"
    );
  } catch (err) {
    const agencies = agenciesStore.filterPublicEnrollmentAgencies(agenciesStore.load());
    const settings = (res.locals && res.locals.settings) ? res.locals.settings : (settingsSvc.getSettings() || {});
    const hcaptchaSiteKey = String(settings.HCAPTCHA_SITE_KEY || "").trim();
    const hcaptchaSecretKey = String(settings.HCAPTCHA_SECRET_KEY || "").trim();
    const hcaptchaEnabled = !!(hcaptchaSiteKey && hcaptchaSecretKey);

    return res.status(400).render("request-access", {
      agencies,
      error: err?.message || "Failed to submit request",
      showLoginLink: err?.code === "USER_ALREADY_EXISTS",
      loginUrl: "/",
      form: req.body || {},
      requireAllAgencyDetails: isRequestAccessRequireAllAgencyDetails(),
      agencyTypeOptions: agencyTypesSvc.getAgencyTypeOptions(),
      regionOptions: regionsSvc.listNormalized(),
      regionCountyLocks: regionsSvc.listLocks(),
      hcaptchaEnabled,
      hcaptchaSiteKey: hcaptchaEnabled ? hcaptchaSiteKey : "",
    });
  }
});

app.get("/request-access/confirmation", (req, res) => {
  if (!isRequestAccessEnabled()) return renderRequestAccessDisabled(req, res);
  return res.render("request-access-confirmation", {
    autoApproved: String(req.query.created || "") === "1",
  });
});

userRequestsRoutes.registerPublicReviewRoutes(app);

app.get("/request-access/:reviewToken", (req, res, next) => {
  const token = String(req.params.reviewToken || "").trim();
  if (!userRequestsRoutes.isValidReviewToken(token)) return next();
  return res.render("request-access-review", {
    reviewToken: token,
    agencyTypeOptions: agencyTypesSvc.getAgencyTypeOptions(),
    regionOptions: regionsSvc.listNormalized(),
    regionCountyLocks: regionsSvc.listLocks(),
  });
});

// Admin: review pending access requests
app.get("/pending-user-requests", requirePermission("page.users"), (req, res) => {
  return res.render("pending-user-requests", {
    agencyTypeOptions: agencyTypesSvc.getAgencyTypeOptions(),
    regionOptions: regionsSvc.listNormalized(),
    regionCountyLocks: regionsSvc.listLocks(),
  });
});

app.get("/settings", requirePermission("page.settings"), (req, res) => {
  const settings = settingsSvc.getSettings();
  const keys = Object.keys(settings).sort();

  // --- REAL FILE EXISTENCE CHECKS ---
  function fileExistsSafe(relPath) {
    if (!relPath || typeof relPath !== "string") return false;
    const abs = path.resolve(process.cwd(), relPath);
    return fs.existsSync(abs);
  }

  const p12Exists = fileExistsSafe(settings.TAK_API_P12_PATH);
  const caExists = fileExistsSafe(settings.TAK_CA_PATH);

  // Discover available email HTML templates (for admin editing).
  let emailTemplates = [];
  try {
    const templatesDir = emailTemplatesSvc.getTemplatesDir();
    const fileNames = fs.readdirSync(templatesDir).filter((name) =>
      typeof name === "string" && name.toLowerCase().endsWith(".html")
    );

    const overrides =
      settings &&
      settings.EMAIL_TEMPLATES_OVERRIDES &&
      typeof settings.EMAIL_TEMPLATES_OVERRIDES === "object"
        ? settings.EMAIL_TEMPLATES_OVERRIDES
        : {};

    function normalizeHtmlForCompare(str) {
      return String(str || "")
        .replace(/\r\n/g, "\n")
        .trim();
    }

    emailTemplates = fileNames.map((filename) => {
      let defaultHtml = "";
      try {
        defaultHtml = fs.readFileSync(path.join(templatesDir, filename), "utf8");
      } catch (err) {
        console.error(
          "[settings] Failed to read email template file:",
          filename,
          err
        );
      }

      const overrideHtmlRaw = overrides && overrides[filename];
      const overrideHtml =
        typeof overrideHtmlRaw === "string" ? overrideHtmlRaw : "";
      const html = overrideHtml || defaultHtml;

      // Only show "Custom" when the saved override actually differs from the repo default.
      const hasOverride = overrideHtml !== "";
      const differsFromDefault =
        hasOverride &&
        normalizeHtmlForCompare(overrideHtml) !== normalizeHtmlForCompare(defaultHtml);

      return {
        filename,
        idSafe: filename.replace(/[^a-zA-Z0-9_-]+/g, "_"),
        html,
        defaultHtml,
        overridden: differsFromDefault,
      };
    });

    // Remove overrides that match the repo default so badges and storage stay correct.
    const toRemove = emailTemplates
      .filter((t) => {
        const overrideHtmlRaw = overrides && overrides[t.filename];
        const overrideHtml =
          typeof overrideHtmlRaw === "string" ? overrideHtmlRaw : "";
        if (overrideHtml === "") return false;
        return (
          normalizeHtmlForCompare(overrideHtml) ===
          normalizeHtmlForCompare(t.defaultHtml || "")
        );
      })
      .map((t) => t.filename);
    if (toRemove.length > 0) {
      const current = settingsSvc.getSettings() || {};
      const overridesObj =
        current.EMAIL_TEMPLATES_OVERRIDES &&
        typeof current.EMAIL_TEMPLATES_OVERRIDES === "object"
          ? { ...current.EMAIL_TEMPLATES_OVERRIDES }
          : {};
      toRemove.forEach((filename) => delete overridesObj[filename]);
      if (Object.keys(overridesObj).length === 0) {
        const next = { ...current };
        delete next.EMAIL_TEMPLATES_OVERRIDES;
        settingsSvc.saveSettings(next);
      } else {
        settingsSvc.saveSettings({ ...current, EMAIL_TEMPLATES_OVERRIDES: overridesObj });
      }
      // Recompute overridden so the page shows Default for cleaned items.
      emailTemplates = emailTemplates.map((t) => ({
        ...t,
        overridden: toRemove.includes(t.filename) ? false : t.overridden,
      }));
    }
  } catch (err) {
    console.error("[settings] Failed to load email templates:", err);
    emailTemplates = [];
  }

  const locateConfigSvc = require("./services/locateConfig.service");
  const takSshSvcForSettings = require("./services/takSsh.service");
  const takSshMaintenanceVisible = locateConfigSvc.isSshConfigured().configured;
  const sshPrivilegedReady = takSshSvcForSettings.isPrivilegedSshReady(settings);

  res.render("settings", {
  settings,
  keys,
  emailTemplates,
  mapBasemapOptions: mapBasemapsConfig.BASEMAP_OPTIONS,
  importStatus: req.query.import,
  importError: req.query.error,
  smsTest: req.query.smsTest || "",
  smsErr: req.query.smsErr || "",
  p12Exists,
  caExists,
  takSshMaintenanceVisible,
  sshPrivilegedReady,
  defaultAgencyTypes: agencyTypesSvc.DEFAULT_AGENCY_TYPES,
  configurableAgencyTypes: agencyTypesSvc.getConfigurableAgencyTypes(settings),
  atakApk: atakApkSvc.getApkInfo(),
  portalDb: {
    host: "127.0.0.1",
    port: String(process.env.POSTGRES_HOST_PORT || "47193"),
    user: "takportal",
    database: "takportal",
    password: String(process.env.POSTGRES_PASSWORD || ""),
  },
  });
});


app.post(
  "/settings",
  requirePermission("page.settings"),
  upload.fields([
    { name: "TAK_API_P12_UPLOAD", maxCount: 1 },
    { name: "TAK_CA_UPLOAD", maxCount: 1 },
    { name: "BRAND_LOGO_UPLOAD", maxCount: 1 },
  ]),
  (req, res) => {
    const wantsJson =
      String(req.get("Accept") || "").includes("application/json") ||
      req.get("X-Requested-With") === "XMLHttpRequest";

    const rawBody = req.body || {};

    // Grab the current full settings object
    const currentSettings = settingsSvc.getSettings() || {};

    // Reset all email template overrides to built-in files in /email_templates.
    // This path only clears EMAIL_TEMPLATES_OVERRIDES; other settings are unchanged.
    const resetAllEmailTemplatesRaw =
      req.body && req.body._resetAllEmailTemplates != null
        ? String(req.body._resetAllEmailTemplates).trim().toLowerCase()
        : "";
    if (
      resetAllEmailTemplatesRaw === "1" ||
      resetAllEmailTemplatesRaw === "true" ||
      resetAllEmailTemplatesRaw === "yes" ||
      resetAllEmailTemplatesRaw === "on"
    ) {
      const next = { ...currentSettings };
      delete next.EMAIL_TEMPLATES_OVERRIDES;

      try {
        settingsSvc.saveSettings(next);
      } catch (err) {
        console.error("[settings] reset all email templates failed:", err);
        if (wantsJson) {
          return res.status(500).json({
            ok: false,
            error: err?.message || "Reset failed",
          });
        }
        return res.status(500).send("Failed to reset email templates");
      }

      try {
        auditSvc.logEvent({
          actor: req.authentikUser || null,
          request: {
            method: req.method,
            path: req.originalUrl || req.path,
            ip: req.ip,
          },
          action: "UPDATE_SETTINGS",
          targetType: "settings",
          targetId: "server",
          details: {
            changedKeys: ["EMAIL_TEMPLATES_OVERRIDES"],
            resetAllEmailTemplates: true,
          },
        });
      } catch (e) {
        // never block settings save
      }

      if (wantsJson) {
        return res.json({ ok: true, resetAllEmailTemplates: true });
      }
      return res.redirect("/settings");
    }

    // Start from existing settings so we don't lose anything (like BRAND_LOGO_URL)
    const merged = { ...currentSettings };

    // --- collect settings[*] fields from the form ---

    const bodySettings = {};

    // Nested "settings" object (non-multipart or other cases)
    if (rawBody.settings && typeof rawBody.settings === "object") {
      Object.keys(rawBody.settings).forEach((key) => {
        bodySettings[key] = rawBody.settings[key];
      });
    }

    // Flat fields like "settings[BRAND_THEME]" / nested
    // "settings[EMAIL_TEMPLATES_OVERRIDES][file.html]" created by multer.
    Object.keys(rawBody).forEach((key) => {
      const nested = key.match(/^settings\[([^\]]+)\]\[([^\]]+)\]$/);
      if (nested) {
        const parent = nested[1];
        const child = nested[2];
        if (!bodySettings[parent] || typeof bodySettings[parent] !== "object") {
          bodySettings[parent] = {};
        }
        bodySettings[parent][child] = rawBody[key];
        return;
      }
      const match = key.match(/^settings\[([^\]]+)\]$/);
      if (match) {
        bodySettings[match[1]] = rawBody[key];
      }
    });

    // Apply simple settings onto merged
    // Note: email template overrides are handled separately so we can support
    // per-template "reset to default" behavior.
    Object.keys(bodySettings).forEach((key) => {
      if (
        key === "EMAIL_TEMPLATES_OVERRIDES" ||
        key === "EMAIL_TEMPLATES_OVERRIDES_RESET"
      ) {
        return;
      }
      if (key === "SERVER_NAME") {
        const raw = String(bodySettings[key] || "").trim();
        merged[key] = raw ? raw.toUpperCase() : "";
        return;
      }
      if (key === "DEFAULT_MAP_SOURCE") {
        merged[key] = mapBasemapsConfig.normalizeBasemapId(bodySettings[key]);
        return;
      }
      if (key === "TAK_SSH_PRIVILEGE_CMD") {
        merged[key] =
          String(bodySettings[key] || "").trim().toLowerCase() === "dzdo" ? "dzdo" : "sudo";
        return;
      }
      merged[key] = bodySettings[key];
    });

    // Figure out if the user clicked a per-template "Save This Template" button.
    // When present, this is the filename of the template that was explicitly saved.
    const onlyTemplate =
      req.body && typeof req.body._saveTemplate === "string"
        ? req.body._saveTemplate
        : null;

    // --- email template overrides (HTML bodies) ---
    // Important: do NOT persist textarea bodies on general Save Settings / autosave.
    // Browsers decode HTML entities inside <textarea> content, so "default" markup
    // posted back no longer matches /email_templates and would falsely become Custom.
    // Overrides are only written when Save Custom Template is used; resets still apply.
    const currentOverrides =
      currentSettings &&
      currentSettings.EMAIL_TEMPLATES_OVERRIDES &&
      typeof currentSettings.EMAIL_TEMPLATES_OVERRIDES === "object"
        ? { ...currentSettings.EMAIL_TEMPLATES_OVERRIDES }
        : {};

    const overridesFromForm = bodySettings.EMAIL_TEMPLATES_OVERRIDES;

    // We'll compare posted values against the current default files on disk.
    let templatesDirForCompare = null;
    try {
      templatesDirForCompare = emailTemplatesSvc.getTemplatesDir();
    } catch (e) {
      console.error("[settings] Unable to get templates dir for compare:", e);
    }

    function normalizeHtml(str) {
      return String(str || "")
        .replace(/\r\n/g, "\n")
        .trim();
    }

    if (
      onlyTemplate &&
      overridesFromForm &&
      typeof overridesFromForm === "object"
    ) {
      const value = overridesFromForm[onlyTemplate];
      if (typeof value === "string") {
        let isSameAsDefault = false;

        if (templatesDirForCompare) {
          try {
            const defaultHtml = fs.readFileSync(
              path.join(templatesDirForCompare, onlyTemplate),
              "utf8"
            );
            if (normalizeHtml(value) === normalizeHtml(defaultHtml)) {
              isSameAsDefault = true;
            }
          } catch (err) {
            // If we can't read the default file, we just treat it as custom.
            console.error(
              "[settings] Failed to read default email template for compare:",
              onlyTemplate,
              err
            );
          }
        }

        if (isSameAsDefault) {
          delete currentOverrides[onlyTemplate];
        } else {
          currentOverrides[onlyTemplate] = value;
        }
      }
    }

    const resetMap = bodySettings.EMAIL_TEMPLATES_OVERRIDES_RESET;
    if (resetMap && typeof resetMap === "object") {
      Object.keys(resetMap).forEach((filename) => {
        // Always apply reset flags so "Reset to Default" takes effect even when
        // the user later saves a different template or the main form.
        const rawFlag = resetMap[filename];
        const flag =
          typeof rawFlag === "string"
            ? rawFlag.trim().toLowerCase()
            : String(rawFlag || "").trim().toLowerCase();

        if (
          flag === "1" ||
          flag === "true" ||
          flag === "yes" ||
          flag === "on"
        ) {
          // "Reset to default" means: drop the override, so we fall back to the file.
          delete currentOverrides[filename];
        }
      });
    }

    if (Object.keys(currentOverrides).length > 0) {
      merged.EMAIL_TEMPLATES_OVERRIDES = currentOverrides;
    } else {
      delete merged.EMAIL_TEMPLATES_OVERRIDES;
    }

    // --- handle uploaded files (certs + logo) ---

    const files = req.files || {};

    const p12Files = files.TAK_API_P12_UPLOAD || [];
    if (p12Files.length > 0) {
      const f = p12Files[0];
      const relPath = path.relative(process.cwd(), f.path);
      merged.TAK_API_P12_PATH = relPath.replace(/\\/g, "/");
    }

    const caFiles = files.TAK_CA_UPLOAD || [];
    if (caFiles.length > 0) {
      const f = caFiles[0];
      const relPath = path.relative(process.cwd(), f.path);
      merged.TAK_CA_PATH = relPath.replace(/\\/g, "/");
    }

    const logoFiles = files.BRAND_LOGO_UPLOAD || [];
    if (logoFiles.length > 0) {
      const f = logoFiles[0];
      const webPath = "/branding/" + path.basename(f.path);
      merged.BRAND_LOGO_URL = webPath.replace(/\\/g, "/");
    }
    // IMPORTANT: if no logo file uploaded, we do NOT touch merged.BRAND_LOGO_URL
    // so it stays whatever it was before.

    const takSshSvcForSave = require("./services/takSsh.service");
    takSshSvcForSave.clearPrivilegedModeCache();
    if (!takSshSvcForSave.isPrivilegedSshReady(merged)) {
      merged.ALLOWED_CLIENT_DATA_PACKAGE = "false";
    }

    // Save the FULL merged settings object
    try {
      settingsSvc.saveSettings(merged);
    } catch (err) {
      console.error("[settings] saveSettings failed:", err);
      if (wantsJson) {
        return res.status(500).json({
          ok: false,
          error: err?.message || "Save failed",
        });
      }
      return res.status(500).send("Failed to save settings");
    }

    if (logoFiles.length > 0) {
      const previousLogoUrl = String(currentSettings.BRAND_LOGO_URL || "")
        .split("?")[0]
        .trim();
      if (previousLogoUrl.startsWith("/branding/")) {
        const previousLogoName = path.basename(previousLogoUrl);
        const currentLogoName = path.basename(logoFiles[0].path);
        if (
          previousLogoName.startsWith("logo") &&
          previousLogoName !== currentLogoName
        ) {
          try {
            fs.unlinkSync(
              path.join(__dirname, "data", "branding", previousLogoName)
            );
          } catch (err) {
            if (err?.code !== "ENOENT") {
              console.warn("[settings] Failed to remove previous logo:", err);
            }
          }
        }
      }
    }

    try {
      // Audit: record which keys changed (avoid storing secrets/content)
      const changedKeys = [];
      const keys = new Set([
        ...Object.keys(currentSettings || {}),
        ...Object.keys(merged || {}),
      ]);

      keys.forEach((k) => {
        if (k === "EMAIL_TEMPLATES_OVERRIDES") {
          const before = currentSettings?.EMAIL_TEMPLATES_OVERRIDES || {};
          const after = merged?.EMAIL_TEMPLATES_OVERRIDES || {};
          const beforeKeys = Object.keys(before);
          const afterKeys = Object.keys(after);
          const same =
            beforeKeys.length === afterKeys.length &&
            beforeKeys.every((x) => Object.prototype.hasOwnProperty.call(after, x));
          if (!same) changedKeys.push(k);
          return;
        }
        const a = currentSettings?.[k];
        const b = merged?.[k];
        if (JSON.stringify(a) !== JSON.stringify(b)) changedKeys.push(k);
      });

      auditSvc.logEvent({
        actor: req.authentikUser || null,
        request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
        action: "UPDATE_SETTINGS",
        targetType: "settings",
        targetId: "server",
        details: {
          changedKeys,
          savedTemplate: onlyTemplate,
          uploaded: {
            p12: (files.TAK_API_P12_UPLOAD || []).length > 0,
            ca: (files.TAK_CA_UPLOAD || []).length > 0,
            logo: (files.BRAND_LOGO_UPLOAD || []).length > 0,
          },
        },
      });
    } catch (e) {
      // never block settings save
    }

    applyLiveMapRuntime();

    if (wantsJson) {
      return res.json({ ok: true });
    }
    return res.redirect("/settings");
  }
);

// Send a simple SMTP test email using Always CC / BCC lists from the current form.

app.post(
  "/settings/test-email",
  requirePermission("page.settings"),
  upload.fields([
    { name: "TAK_API_P12_UPLOAD", maxCount: 1 },
    { name: "TAK_CA_UPLOAD", maxCount: 1 },
    { name: "BRAND_LOGO_UPLOAD", maxCount: 1 },
  ]),
  async (req, res) => {
    console.log("[settings] Test email requested");

    try {
      const bodySettings = settingsSvc.collectBodySettings(req.body || {});
      const currentSettings = settingsSvc.getSettings() || {};
      const merged = emailSvc.mergeEmailFormSettings(currentSettings, bodySettings);

      settingsSvc.saveSettings(merged);

      const result = await emailSvc.sendMail({
        // no explicit "to": we only use CC / BCC lists
        subject: "TAK Portal - Email SMTP Test",
        text: "TAK Portal - Email SMTP Test",
      });

      if (result.sent) {
        auditSvc.auditFromRequest(req, {
          action: "SETTINGS_TEST_EMAIL_SENT",
          targetType: "settings",
          targetId: "smtp",
          details: { summary: "Sent SMTP test email from Settings." },
        });
      }

      console.log("[settings] Test email result:", result);
      return res.redirect("/settings");
    } catch (err) {
      console.error("[settings] Test email failed:", err?.message || err);
      return res
        .status(500)
        .send("Failed to send test email. Check SMTP settings and server logs.");
    }
  }
);

const uploadSmsTest = multer();
app.post(
  "/settings/test-sms",
  requirePermission("page.settings"),
  uploadSmsTest.none(),
  async (req, res) => {
    try {
      const bodySettings = smsSvc.collectBodySettings(req.body || {});
      const current = settingsSvc.getSettings() || {};
      const cfg = { ...current };
      [
        "SMS_PROVIDER",
        "SMS_TWILIO_ACCOUNT_SID",
        "SMS_TWILIO_AUTH_TOKEN",
        "SMS_TWILIO_FROM",
        "SMS_BREVO_API_KEY",
        "SMS_BREVO_SENDER",
        "SMS_TEST_TO",
      ].forEach((k) => {
        if (bodySettings[k] !== undefined) cfg[k] = bodySettings[k];
      });

      const provider = String(cfg.SMS_PROVIDER || "disabled").trim().toLowerCase();
      if (provider !== "twilio" && provider !== "brevo") {
        return res.redirect(
          "/settings?smsTest=fail&smsErr=" +
            encodeURIComponent("Choose Twilio or Brevo and enter credentials.") +
            "#sms-settings"
        );
      }

      const testToRaw = String(bodySettings.SMS_TEST_TO || "").trim();
      if (!testToRaw) {
        return res.redirect(
          "/settings?smsTest=fail&smsErr=" +
            encodeURIComponent(
              "Enter a test number in “SMS test recipient(s)” (digits + country code, comma-separated for Twilio)."
            ) +
            "#sms-settings"
        );
      }

      const parsed = smsSvc.parsePhoneList(testToRaw);
      if (parsed.error) {
        return res.redirect(
          "/settings?smsTest=fail&smsErr=" + encodeURIComponent(parsed.error) + "#sms-settings"
        );
      }

      const msg = "TAK Portal - SMS test";
      for (const phone of parsed.phones) {
        const out = await smsSvc.sendSmsUsingConfig(cfg, phone, msg);
        if (!out.ok) {
          return res.redirect(
            "/settings?smsTest=fail&smsErr=" +
              encodeURIComponent(out.error || "SMS failed") +
              "#sms-settings"
          );
        }
      }

      auditSvc.auditFromRequest(req, {
        action: "SETTINGS_TEST_SMS_SENT",
        targetType: "settings",
        targetId: "sms",
        details: {
          provider,
          recipientCount: parsed.phones.length,
          summary: `Sent SMS test to ${parsed.phones.length} number(s).`,
        },
      });

      return res.redirect("/settings?smsTest=ok#sms-settings");
    } catch (err) {
      console.error("[settings] Test SMS failed:", err?.message || err);
      return res.redirect(
        "/settings?smsTest=fail&smsErr=" +
          encodeURIComponent(err?.message || String(err)) +
          "#sms-settings"
      );
    }
  }
);


async function boot() {
  const db = require("./services/db");
  const pgCache = require("./services/pgCache");
  try {
    settingsSvc.ensureSettingsInitialized();
  } catch (e) {
    console.warn("[boot] settings init:", e?.message || e);
  }
  try {
    require("./services/cryptoSecrets").getKeyBuffer();
  } catch (_) {}
  if (!db.isConfigured()) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  try {
    await db.connectWithRetry(60000);
    await db.migrate();
    await pgCache.hydrate();
  } catch (e) {
    console.error("[boot] Postgres migrate failed:", e?.message || e);
    process.exit(1);
  }
  const port = process.env.WEB_UI_PORT || 3000;
  app.listen(port, () => {
    console.log(
      `✅ TAK Portal ${app.locals.APP_VERSION} running on http://localhost:${port}`
    );
    refreshAppUpdateLocals();
    setInterval(refreshAppUpdateLocals, 60 * 1000).unref?.();
    try {
      applyLiveMapRuntime();
    } catch (e) {
      console.log("⚠️ Geofence evaluator init failed", e?.message || e);
    }
    try {
      const channelPatchEngine = require("./services/channelPatch.engine");
      channelPatchEngine.start();
    } catch (e) {
      console.log("⚠️ Channel patch engine init failed", e?.message || e);
    }
    jsonImport.run().catch((e) => console.error("[json-import]", e?.message || e));
    setInterval(() => {
      stackHealth.getStackHealth().catch(() => {});
    }, 20000).unref?.();
    try {
      const takUrl = getString("TAK_URL", "");
      if (!takUrl) {
        console.log("⚠️ TAK_URL not set in settings.json");
      } else {
        console.log("TAK host:", new URL(takUrl).hostname);
      }
    } catch (e) {
      console.log("⚠️ Invalid TAK_URL in settings.json");
    }
  });
}

boot().catch((e) => {
  console.error("[boot] fatal:", e?.message || e);
  process.exit(1);
});
