require("dotenv").config({ quiet: true });
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const settingsSvc = require("./services/settings.service");
const dashboardStatsCache = require("./services/dashboardStatsCache.service");
const takDashboardCache = require("./services/takDashboardCache.service");
const axios = require("axios");
const { getString } = require("./services/env");
const { URL } = require("url");
const pkg = require("./package.json");
const mutualAidSvc = require("./services/mutualAid.service");
const portalAuth = require("./services/portalAuth.middleware");
const emailSvc = require("./services/email.service");
const smsSvc = require("./services/sms.service");
const emailTemplatesSvc = require("./services/emailTemplates.service");
const qrSvc = require("./services/qr.service");
const agenciesStore = require("./services/agencies.service");
const userRequestsSvc = require("./services/userRequests.service");
const auditSvc = require("./services/auditLog.service");
const accessSvc = require("./services/access.service");
const usersSvc = require("./services/users.service");
const groupsSvc = require("./services/groups.service");
const agencyTypesSvc = require("./services/agencyTypes.service");
const locatorsSvc = require("./services/locators.service");
const { toSafeApiError } = require("./services/apiErrorPayload.service");

const app = express();

// Expose version to all EJS views (e.g. sidebar)
app.locals.APP_VERSION = pkg.version || "dev";
app.locals.APP_LATEST_VERSION = pkg.version || "dev";
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

async function checkForUpdates() {
  try {
    // You can move this to an env var if you like
    const repo = process.env.GITHUB_REPO || "AdventureSeeker423/TAK-Portal";

    // Grab package.json from main and read its version
    const url = `https://raw.githubusercontent.com/${repo}/main/package.json`;
    const response = await axios.get(url, { timeout: 5000 });

    const data =
      typeof response.data === "string"
        ? JSON.parse(response.data)
        : response.data;

    const latestVersion = data.version || app.locals.APP_VERSION;

    app.locals.APP_LATEST_VERSION = latestVersion;
    app.locals.APP_UPDATE_AVAILABLE = isNewerVersion(
      latestVersion,
      app.locals.APP_VERSION
    );

    console.log(
      `[update-check] current=${app.locals.APP_VERSION} latest=${latestVersion} update=${app.locals.APP_UPDATE_AVAILABLE}`
    );
  } catch (err) {
    console.warn("Failed to check for updates:", err.message || err);
  }
}

// Run once on startup, then periodically (every 15 min)
checkForUpdates();
setInterval(checkForUpdates, 15 * 60 * 1000);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/branding", express.static(path.join(__dirname, "data", "branding")));

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
      return cb(null, "logo" + ext);
    }

    cb(null, safeOriginal);
  },
});

const upload = multer({ storage: uploadStorage });

// Expose settings + theme/logo + current path to all views (for sidebar active state)
app.use((req, res, next) => {
  try {
    const settings = settingsSvc.getSettings();
    res.locals.settings = settings || {};
    // Hard default: dark mode; per-device toggle is handled client-side.
    res.locals.brandTheme = "dark";
    res.locals.brandLogoUrl = settings.BRAND_LOGO_URL || "";
    res.locals.currentPath = (req.path || "/").replace(/\/+$/, "") || "/";
  } catch (err) {
    console.warn("Failed to load settings for request:", err?.message || err);
    res.locals.settings = {};
    res.locals.brandTheme = "dark-blue";
    res.locals.brandLogoUrl = "";
    res.locals.currentPath = (req.path || "/").replace(/\/+$/, "") || "/";
  }
  next();
});

// >>> Enforce optional Authentik/group access control <<<
// Public paths that must remain reachable without Authentik forward_auth
const PUBLIC_PATHS = new Set([
  "/lookup",
  "/request-access",
  "/request-access/confirmation",
]);

app.use((req, res, next) => {
  try {
    // Normalize path (strip trailing slash except root)
    const p = (req.path || "").replace(/\/+$/, "") || "/";
    if (PUBLIC_PATHS.has(p)) return next();
    // Public missing-person locator pages (not the admin /locate console)
    if (p.startsWith("/locate/") && p !== "/locate") return next();
    // Anonymous ping API for locator share links
    if (p.startsWith("/api/public/locate/")) return next();
  } catch (_) {
    // fall through
  }
  return portalAuth(req, res, next);
});

// Helper: only allow Global Admins to access certain routes (e.g. settings, templates)
function requireGlobalAdmin(req, res, next) {
  const user = req.authentikUser;

  // Allow both Global Admins and Agency Admins
  if (!user || (!user.isGlobalAdmin && !user.isAgencyAdmin)) {
    const username = user && user.username ? user.username : "";
    return res.status(403).render("access-denied", { username });
  }

  next();
}

// Helper: only allow Global Admins (no Agency Admins)
function requireStrictGlobalAdmin(req, res, next) {
  const user = req.authentikUser;

  if (!user || !user.isGlobalAdmin) {
    const username = user && user.username ? user.username : "";
    return res.status(403).render("access-denied", { username });
  }

  next();
}

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

/** Beta + global or agency admin (for Documents page + shared MOU workflows). */
function requireBetaDocumentsPage(req, res, next) {
  const cfg = settingsSvc.getSettings() || {};
  if (String(cfg.BETA_MODE || "").toLowerCase() !== "true") {
    return res.status(404).render("access-denied", {
      username: req.authentikUser?.username || "",
    });
  }
  const u = req.authentikUser;
  if (!u || (!u.isGlobalAdmin && !u.isAgencyAdmin)) {
    const username = u && u.username ? u.username : "";
    return res.status(403).render("access-denied", { username });
  }
  next();
}

function requireStrictGlobalAdminApi(req, res, next) {
  const user = req.authentikUser;
  if (!user || !user.isGlobalAdmin) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

function requireBetaModeApi(req, res, next) {
  const cfg = settingsSvc.getSettings() || {};
  const beta = String(cfg.BETA_MODE || "").toLowerCase() === "true";
  if (!beta) {
    return res.status(404).json({ error: "Not found" });
  }
  next();
}
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.get("/logout", (req, res) => {
  // Where to send the user back after logout (the portal itself)
  const portalUrl =
    getString("TAK_PORTAL_PUBLIC_URL", "") ||
    `${req.protocol}://${req.get("host")}/`;
  try {
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
app.use("/api/users", require("./routes/users.routes"));
app.use("/api/groups", require("./routes/groups.routes"));
app.use("/api/templates", require("./routes/templates.routes"));
app.use("/api/qr", require("./routes/qr.routes"));
app.use("/api/setup-my-device", require("./routes/setupDevice.routes"));
app.use("/api/mutual-aid", require("./routes/mutualAid.routes"));
app.use("/api/tak", require("./routes/takMetrics.routes"));
app.use("/api/user-requests", require("./routes/userRequests.routes"));
app.use("/api/audit-log", requireGlobalAdmin, require("./routes/auditLog.routes"));
app.use("/api/plugins", requireGlobalAdmin, require("./routes/plugins.routes"));
app.use("/api/integrations", requireGlobalAdmin, require("./routes/integrations.routes"));
app.use("/api/ssh", requireGlobalAdmin, require("./routes/ssh.routes"));
// Locate + data packages (admin + JSON APIs): strict global admin only. Not gated by BETA_MODE
// (Data Sync / Getting Started remain beta + global admin).
app.use("/api/locate", requireStrictGlobalAdminApi, require("./routes/locate.routes"));

app.use(
  "/api/data-sync",
  requireStrictGlobalAdminApi,
  requireBetaModeApi,
  require("./routes/dataSync.routes")
);
app.use(
  "/api/data-packages",
  requireStrictGlobalAdminApi,
  require("./routes/dataPackages.routes")
);

app.use("/api/documents", require("./routes/documents.routes"));

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
app.use("/api/email", (req, res, next) => {
  const user = req.authentikUser;
  if (!user || (!user.isGlobalAdmin && !user.isAgencyAdmin)) {
    const username = user && user.username ? user.username : "";
    return res.status(403).render("access-denied", { username });
  }
  next();
}, require("./routes/email.routes"));
app.use("/dashboard", require("./routes/dashboard.routes"));

// UI Routes

app.get("/", (req, res) => {
  const user = req.authentikUser;
  const isAdmin = !!(user && (user.isGlobalAdmin || user.isAgencyAdmin));
  if (!isAdmin) return res.redirect("setup-my-device");
  return res.redirect("dashboard");
});

app.get("/users/create", (req, res) => res.render("users-create"));
app.get("/users/manage", (req, res) => {
  const pendingUserRequestsCount =
    userRequestsSvc.countRequestsForUser(req.authentikUser);

  return res.render("users-manage", {
    pendingUserRequestsCount,
  });
});
app.get("/sample-users.csv", requireGlobalAdmin, (req, res) => {
  const filePath = path.join(__dirname, "sample-users.csv");
  return res.download(filePath, "users-import-template.csv");
});
app.get("/csv-instructions-readme.txt", requireGlobalAdmin, (req, res) => {
  const filePath = path.join(__dirname, "csv-instructions-readme.txt");
  return res.download(filePath, "csv-instructions-readme.txt");
});
app.get("/groups", (req, res) => res.render("groups"));
app.get("/agencies", requireGlobalAdmin, (req, res) =>
  res.render("agencies", {
    agencyTypeOptions: agencyTypesSvc.getAgencyTypeOptions(),
  })
); //require Global Admin
app.get("/templates", (req, res) => res.render("templates"));
app.get("/mutual-aid", requireGlobalAdmin, (req, res) =>
  res.render("mutual-aid")
); //require Global Admin
app.get("/integrations", requireGlobalAdmin, (req, res) =>
  res.render("integrations")
);

// Admin: email (global + agency admins; always visible, not gated by beta)
app.get("/email", (req, res) => {
  const user = req.authentikUser;
  if (!user || (!user.isGlobalAdmin && !user.isAgencyAdmin)) {
    const username = user && user.username ? user.username : "";
    return res.status(403).render("access-denied", { username });
  }
  return res.render("email");
});
app.get("/locate-persons", (req, res) => {
  res.redirect(301, "/locate");
});

// Locate admin page: global admins only (not beta-gated).
app.get("/locate", requireStrictGlobalAdmin, (req, res) => res.render("locate"));

app.get("/data-sync", requireStrictGlobalAdmin, requireBetaMode, (req, res) =>
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
app.get("/plugin-manager", requireGlobalAdmin, async (req, res) => {
  const pluginsSvc = require("./services/plugins.service");
  const takGovLink = await pluginsSvc.getTakGovLinkState(false);
  const plugins = pluginsSvc.listPlugins();
  return res.render("plugin-manager", { takGovLink, plugins });
});

// Beta: Getting Started (global admins only, beta mode)
app.get("/getting-started", requireStrictGlobalAdmin, requireBetaMode, (req, res) =>
  res.render("getting-started")
);

// Beta: Documents (global + agency admins; per-document ACL in API)
app.get("/documents", requireBetaDocumentsPage, (req, res) => {
  const agencies = agenciesStore.load();
  const visible = accessSvc.filterAgenciesForUser(req.authentikUser, agencies);
  const docAgencyOptions = visible
    .filter((a) => a && String(a.suffix || "").trim())
    .map((a) => ({
      value: String(a.suffix).trim().toLowerCase(),
      label: `${String(a.name || "").trim() || "Agency"} (${String(a.suffix).trim()})`,
    }));
  return res.render("documents", { docAgencyOptions });
});

// Data Package (global admins only; not beta-gated)
app.get("/data-package", requireStrictGlobalAdmin, (req, res) =>
  res.render("data-package")
);
app.get("/data-packages", requireStrictGlobalAdmin, (req, res) =>
  res.redirect("/data-package")
);

// Plugins page (any authenticated user)
app.get("/plugins", (req, res) => {
  const pluginsSvc = require("./services/plugins.service");
  const plugins = pluginsSvc.listPlugins();
  return res.render("plugins", { plugins });
});

// Admin: audit log (GLOBAL ADMINS ONLY)
app.get("/audit-log", requireGlobalAdmin, async (req, res) => {
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

    const result = auditSvc.queryLogs(filters);
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

  const actionOptions = auditSvc.listDistinctValues({ field: "actions" });
  const targetTypeOptions = auditSvc.listDistinctValues({ field: "targetTypes" });
  const actorOptions = auditSvc.listDistinctActors();

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
    prev: buildLink(Math.max(1, result.page - 1)),
    next: buildLink(Math.min(result.pageCount, result.page + 1)),
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
  return res.render("setup-my-device", { takHost, enrollQrBootstrap });
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
  try {
    const body = req.body || {};
    const email = String(body.email || "").trim().toLowerCase();
    const username = String(body.username || "")
      .trim()
      .toLowerCase();

    const settings = (res.locals && res.locals.settings)
      ? res.locals.settings
      : (settingsSvc.getSettings() || {});

    const hcaptchaSiteKey = String(settings.HCAPTCHA_SITE_KEY || "").trim();
    const hcaptchaSecretKey = String(settings.HCAPTCHA_SECRET_KEY || "").trim();
    const hcaptchaEnabled = !!(hcaptchaSiteKey && hcaptchaSecretKey);

    // Enforce hCaptcha only if BOTH keys are configured
    if (hcaptchaEnabled) {
      const token = body["h-captcha-response"];
      if (!token) {
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
        throw new Error("Captcha verification failed.");
      }
    }

    if (!email || !username) {
      throw new Error("Agency Domain or Username Not Found");
    }

    const emailParts = email.split("@");
    if (emailParts.length !== 2) {
      throw new Error("Agency Domain or Username Not Found");
    }

    const domain = emailParts[1].toLowerCase();

    const agencies = agenciesStore.load() || [];

    // Domain-to-agency validation:
    // - Agency must explicitly allow lookup (lookupEnabled === true)
    // - Email domain must match one of the comma-separated domains in lookupDomain
    const agency = agencies.find((a) => {
      if (!a) return false;
      if (a.lookupEnabled !== true) return false;
      return agenciesStore.emailDomainInAgencyList(email, a.lookupDomain);
    });

    if (!agency) {
      throw new Error("Email address or Username Not Found");
    }

    const usersSvc = require("./services/users.service");
    const allUsers = await usersSvc.getAllUsers({ forceRefresh: true });

    const user = allUsers.find(u =>
      String(u.username || "")
        .trim()
        .toLowerCase() === username &&
      (!u.email || !String(u.email).trim())
    );

    if (!user) {
      throw new Error("Email address or Username Not Found");
    }

    const tokensSvc = require("./services/authentikTokens.service");
    const qrSvc = require("./services/qr.service");

    const { key } = await tokensSvc.getOrCreateEnrollmentAppPassword({
      username: user.username,
      userId: user.pk || user.id
    });

    const enrollUrl = qrSvc.buildEnrollUrl({
      username: user.username,
      token: key
    });

    const pngBuffer = await qrSvc.generateDownloadPng(
      enrollUrl,
      user.username
    );

    await emailSvc.sendMail({
      to: email,
      subject: "Your TAK Enrollment QR Code",
      text: "Attached is your TAK enrollment QR code. Please note that this QR code is valid only for 15 minutes.",
      attachments: [
        {
          filename: `tak-${user.username}-enrollment-qr.png`,
          content: pngBuffer
        }
      ]
    });

    return res.render("lookup", {
      form: {},
      error: null,
      success: "Your account has been found and a QR code has been sent to your email address. Please note that this QR code is valid only for 15 minutes.",
      hcaptchaEnabled,
      hcaptchaSiteKey: hcaptchaEnabled ? hcaptchaSiteKey : ""
    });

  } catch (err) {
    const settings = (res.locals && res.locals.settings)
      ? res.locals.settings
      : (settingsSvc.getSettings() || {});

    const hcaptchaSiteKey = String(settings.HCAPTCHA_SITE_KEY || "").trim();
    const hcaptchaSecretKey = String(settings.HCAPTCHA_SECRET_KEY || "").trim();
    const hcaptchaEnabled = !!(hcaptchaSiteKey && hcaptchaSecretKey);

    return res.status(400).render("lookup", {
      form: req.body || {},
      error: "Email address or Username Not Found",
      success: null,
      hcaptchaEnabled,
      hcaptchaSiteKey: hcaptchaEnabled ? hcaptchaSiteKey : ""
    });
  }
});

// Public: request access form (must remain reachable by non-authenticated users)
app.get("/request-access", (req, res) => {
  const agencies = agenciesStore.load();
  const settings = (res.locals && res.locals.settings) ? res.locals.settings : (settingsSvc.getSettings() || {});
  const hcaptchaSiteKey = String(settings.HCAPTCHA_SITE_KEY || "").trim();
  const hcaptchaSecretKey = String(settings.HCAPTCHA_SECRET_KEY || "").trim();
  const hcaptchaEnabled = !!(hcaptchaSiteKey && hcaptchaSecretKey);

  return res.render("request-access", {
    agencies,
    form: {},
    error: null,
    hcaptchaEnabled,
    hcaptchaSiteKey: hcaptchaEnabled ? hcaptchaSiteKey : ""
  });
});

app.post("/request-access", async (req, res) => {
  try {
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

    await userRequestsSvc.createRequest({
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email,
      badgeNumber: body.badgeNumber,
      agencySuffix: body.agencySuffix,
      otherAgency: body.otherAgency,
      otherReason: body.otherReason,
    });

    return res.redirect("/request-access/confirmation");
  } catch (err) {
    const agencies = agenciesStore.load();
    const settings = (res.locals && res.locals.settings) ? res.locals.settings : (settingsSvc.getSettings() || {});
    const hcaptchaSiteKey = String(settings.HCAPTCHA_SITE_KEY || "").trim();
    const hcaptchaSecretKey = String(settings.HCAPTCHA_SECRET_KEY || "").trim();
    const hcaptchaEnabled = !!(hcaptchaSiteKey && hcaptchaSecretKey);

    return res.status(400).render("request-access", {
      agencies,
      error: err?.message || "Failed to submit request",
      form: req.body || {},
      hcaptchaEnabled,
      hcaptchaSiteKey: hcaptchaEnabled ? hcaptchaSiteKey : "",
    });
  }
});

app.get("/request-access/confirmation", (req, res) => {
  return res.render("request-access-confirmation");
});

// Admin: review pending access requests
app.get("/pending-user-requests", requireGlobalAdmin, (req, res) => {
  return res.render("pending-user-requests");
});

app.get("/settings", requireGlobalAdmin, (req, res) => {
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

  res.render("settings", {
  settings,
  keys,
  emailTemplates,
  importStatus: req.query.import,
  importError: req.query.error,
  smsTest: req.query.smsTest || "",
  smsErr: req.query.smsErr || "",
  p12Exists,
  caExists
  });
});


app.post(
  "/settings",
  requireGlobalAdmin,
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

    // Flat fields like "settings[BRAND_THEME]" created by multer
    Object.keys(rawBody).forEach((key) => {
      const match = key.match(/^settings\[(.+)\]$/);
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
      merged[key] = bodySettings[key];
    });

    // Figure out if the user clicked a per-template "Save This Template" button.
    // When present, this is the filename of the template that was explicitly saved.
    const onlyTemplate =
      req.body && typeof req.body._saveTemplate === "string"
        ? req.body._saveTemplate
        : null;

    // --- email template overrides (HTML bodies) ---
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

    if (overridesFromForm && typeof overridesFromForm === "object") {
      Object.keys(overridesFromForm).forEach((filename) => {
        // If a per-template Save was used, ignore other templates.
        if (onlyTemplate && filename !== onlyTemplate) {
          return;
        }

        const value = overridesFromForm[filename];
        if (typeof value !== "string") {
          return;
        }

        let isSameAsDefault = false;

        if (templatesDirForCompare) {
          try {
            const defaultHtml = fs.readFileSync(
              path.join(templatesDirForCompare, filename),
              "utf8"
            );
            if (normalizeHtml(value) === normalizeHtml(defaultHtml)) {
              isSameAsDefault = true;
            }
          } catch (err) {
            // If we can't read the default file, we just treat it as custom.
            console.error(
              "[settings] Failed to read default email template for compare:",
              filename,
              err
            );
          }
        }

        if (isSameAsDefault) {
          // If the value matches the default on disk, we do NOT keep an override.
          delete currentOverrides[filename];
        } else {
          // Otherwise, keep/update the override.
          currentOverrides[filename] = value;
        }
      });
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

    if (wantsJson) {
      return res.json({ ok: true });
    }
    return res.redirect("/settings");
  }
);

// Send a simple SMTP test email using Always CC / BCC lists

app.post("/settings/test-email", requireGlobalAdmin, async (req, res) => {
  console.log("[settings] Test email requested");

  try {
    const result = await emailSvc.sendMail({
      // no explicit "to": we only use CC / BCC lists
      subject: "TAK Portal - Email SMTP Test",
      text: "TAK Portal - Email SMTP Test",
    });

    console.log("[settings] Test email result:", result);
    return res.redirect("/settings");
  } catch (err) {
    console.error("[settings] Test email failed:", err?.message || err);
    return res
      .status(500)
      .send("Failed to send test email. Check SMTP settings and server logs.");
  }
});

const uploadSmsTest = multer();
app.post(
  "/settings/test-sms",
  requireGlobalAdmin,
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


// Import (restore) a zip into the data folder
// Expected zip structure is either:
//   - data/<files...>  (matches the Export Configuration zip)
//   - <files...>       (will be treated as data/<files...>)
app.post(
  "/settings/import-data",
  requireGlobalAdmin,
  upload.single("CONFIG_ZIP_UPLOAD"),
  async (req, res) => {
    const unzipper = require("unzipper");
    const { finished } = require("stream/promises");

    try {
      if (!req.file || !req.file.path) {
        return res.redirect("/settings?error=No+file+uploaded");
      }

      const zipPath = req.file.path;
      const dataDir = path.join(__dirname, "data");

      // Ensure data directory exists
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      const directory = await unzipper.Open.file(zipPath);
      const dataDirResolved = path.resolve(dataDir) + path.sep;

      // Extract entries safely (prevent Zip Slip)
      for (const entry of directory.files) {
        // Normalize to forward slashes as used inside zip archives
        const raw = (entry.path || "").replace(/\\/g, "/");

        // Ignore empty / weird names
        if (!raw || raw === "/" || raw.endsWith("/")) {
          if (entry.type === "Directory") continue;
        }

        // Only allow restoring into data/
        const rel = raw.startsWith("data/") ? raw.slice("data/".length) : raw;

        if (!rel) continue;

        // Basic traversal / absolute path protection
        if (rel.includes("..") || rel.startsWith("/") || rel.startsWith("\\")) {
          console.warn("Skipping unsafe zip entry:", raw);
          continue;
        }

        const outPath = path.join(dataDir, rel);
        const outResolved = path.resolve(outPath);

        if (!outResolved.startsWith(dataDirResolved)) {
          console.warn("Skipping zip entry outside dataDir:", raw);
          continue;
        }

        if (entry.type === "Directory") {
          if (!fs.existsSync(outResolved)) {
            fs.mkdirSync(outResolved, { recursive: true });
          }
          continue;
        }

        // Ensure parent dir exists
        const parent = path.dirname(outResolved);
        if (!fs.existsSync(parent)) {
          fs.mkdirSync(parent, { recursive: true });
        }

        // Overwrite/create file
        const writeStream = fs.createWriteStream(outResolved);
        await finished(entry.stream().pipe(writeStream));
      }

      // Cleanup uploaded zip
      try {
        fs.unlinkSync(zipPath);
      } catch (_) {}

      // IMPORTANT: reload cached settings from disk so UI reflects imported settings.json
      try {
        settingsSvc.ensureSettingsInitialized();
      } catch (e) {
        console.warn("[settings] Failed to reload settings after import:", e?.message || e);
      }

      return res.redirect("/settings?import=1");

    } catch (err) {
      console.error("Import data zip error:", err);
      try {
        if (req.file?.path) fs.unlinkSync(req.file.path);
      } catch (_) {}
      return res.redirect("/settings?error=Failed+to+import+zip");
    }
  }
);

// Export a zip of the data folder
app.get("/settings/export-data", requireGlobalAdmin, (req, res) => {
  const archiver = require("archiver");
  const dataDir = path.join(__dirname, "data");

  if (!fs.existsSync(dataDir)) {
    return res.status(404).send("No data directory to export");
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="tak-portal-data.zip"'
  );

  const archive = archiver("zip", { zlib: { level: 9 } });

  archive.on("error", (err) => {
    console.error("Export data zip error:", err);
    res.status(500).end("Failed to export data");
  });

  archive.pipe(res);
  archive.directory(dataDir, "data");
  archive.finalize();
});

const port = process.env.WEB_UI_PORT || 3000;

app.listen(port, () => {
  console.log(`✅ TAK Portal running on http://localhost:${port}`);

  // Prime dashboard Authentik stats cache (dashboard-only)
  dashboardStatsCache.startDashboardStatsRefresher();

  // TAK metrics for dashboard HTML: background refresh so /dashboard does not wait on TAK
  takDashboardCache.startTakDashboardRefresher();

  // Rehydrate expiration timers from stored mutual aid records.
  try {
    mutualAidSvc.initExpirationScheduler();
  } catch (e) {
    console.log(
      "⚠️ Mutual aid expiration scheduler init failed",
      e?.message || e
    );
  }

  try {
    const takUrl = getString("TAK_URL", "");
    if (!takUrl) {
      console.log("⚠️ TAK_URL not set in settings.json");
      return;
    }

    const host = new URL(takUrl).hostname;
    console.log("TAK host:", host);
  } catch (e) {
    console.log("⚠️ Invalid TAK_URL in settings.json");
  }
});
