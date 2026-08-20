/**
 * One-way sync of portal plugins → TAK Server OTA update directory.
 * Target: /opt/tak/webcontent/update/ with product.inf + product.infz
 */

const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const pluginsSvc = require("./plugins.service");
const apkMetaSvc = require("./apkMeta.service");
const takSshSvc = require("./takSsh.service");
const qrSvc = require("./qr.service");
const settingsSvc = require("./settings.service");
const auditSvc = require("./auditLog.service");

const DATA_DIR = path.join(__dirname, "..", "data");
const STAGING_DIR = path.join(DATA_DIR, "plugin-update-staging");
const STATUS_PATH = path.join(DATA_DIR, "plugin-update-sync-status.json");
const MANAGED_SIDE_CAR = "tak-portal-managed.json";

const DEFAULT_REMOTE_DIR = "/opt/tak/webcontent/update";
const DEBOUNCE_MS = 4000;

let debounceTimer = null;
let running = false;
let rerunAfter = false;
let inMemoryStatus = null;

function ensureStagingDir() {
  if (!fs.existsSync(STAGING_DIR)) {
    fs.mkdirSync(STAGING_DIR, { recursive: true });
  }
}

function getRemoteUpdateDir() {
  const settings = settingsSvc.getSettings() || {};
  const override = String(settings.TAK_PLUGIN_UPDATE_REMOTE_DIR || "").trim();
  if (override.startsWith("/")) return override.replace(/\/+$/, "");
  return DEFAULT_REMOTE_DIR;
}

function getUpdateServerUrl() {
  const host = qrSvc.getTakHost();
  if (!host) return null;
  return `https://${host}:8443/update`;
}

function defaultStatus() {
  return {
    inProgress: false,
    state: "idle", // idle | syncing | success | error | blocked_ssh
    lastStartedAt: null,
    lastFinishedAt: null,
    lastSuccessAt: null,
    error: null,
    message: null,
    pluginCount: 0,
    remoteDir: getRemoteUpdateDir(),
    updateServerUrl: getUpdateServerUrl(),
  };
}

function loadStatus() {
  if (inMemoryStatus) {
    return {
      ...inMemoryStatus,
      remoteDir: getRemoteUpdateDir(),
      updateServerUrl: getUpdateServerUrl(),
      inProgress: running || inMemoryStatus.state === "syncing",
    };
  }
  try {
    if (fs.existsSync(STATUS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(STATUS_PATH, "utf8"));
      inMemoryStatus = { ...defaultStatus(), ...raw };
      return {
        ...inMemoryStatus,
        remoteDir: getRemoteUpdateDir(),
        updateServerUrl: getUpdateServerUrl(),
        inProgress: running || inMemoryStatus.state === "syncing",
      };
    }
  } catch (_) {
    /* ignore */
  }
  inMemoryStatus = defaultStatus();
  return { ...inMemoryStatus };
}

function saveStatus(patch) {
  const merged = { ...loadStatus(), ...(patch || {}) };
  const next = {
    ...merged,
    remoteDir: getRemoteUpdateDir(),
    updateServerUrl: getUpdateServerUrl(),
    inProgress:
      running ||
      merged.state === "syncing" ||
      !!(patch && patch.inProgress),
  };
  inMemoryStatus = next;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATUS_PATH, JSON.stringify(next, null, 2));
  } catch (err) {
    console.warn("[plugin-update-sync] Failed to persist status:", err?.message || err);
  }
  return next;
}

function csvEscape(value) {
  const s = String(value == null ? "" : value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function safeRemoteFilename(name, fallbackExt) {
  const base = String(name || "plugin")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 180);
  if (!base) return `plugin${fallbackExt || ""}`;
  return base;
}

/**
 * Enrich a plugin manifest entry with APK metadata when missing.
 */
async function enrichPluginMetadata(plugin) {
  const filePath = pluginsSvc.getPluginFilePath(plugin.id);
  if (!filePath) return { plugin, meta: null, filePath: null };

  const needsParse =
    !plugin.package_name ||
    !plugin.version ||
    plugin.revision_code == null ||
    !plugin.apk_hash;

  let meta = null;
  try {
    meta = await apkMetaSvc.extractApkMetadata(filePath);
  } catch (err) {
    console.warn(
      `[plugin-update-sync] APK parse failed for ${plugin.id}:`,
      err?.message || err
    );
  }

  if (meta && needsParse) {
    const updates = {};
    if (!plugin.package_name && meta.packageName) updates.package_name = meta.packageName;
    if (!plugin.version && meta.versionName) updates.version = meta.versionName;
    if (plugin.revision_code == null && meta.versionCode) {
      const code = parseInt(meta.versionCode, 10);
      if (Number.isFinite(code)) updates.revision_code = code;
    }
    if (!plugin.description && meta.description) updates.description = meta.description;
    if (!plugin.os_requirement && meta.minSdk) updates.os_requirement = meta.minSdk;
    if (!plugin.tak_prereq && meta.pluginApi) updates.tak_prereq = meta.pluginApi;
    if (meta.sha256) updates.apk_hash = meta.sha256;
    if (meta.label && (!plugin.name || plugin.name === path.basename(plugin.filename || "", ".apk"))) {
      updates.name = meta.label;
    }
    if (Object.keys(updates).length) {
      // Persist via direct manifest update (updatePluginMetadata only allows favorite/description).
      try {
        const manifest = JSON.parse(fs.readFileSync(pluginsSvc.MANIFEST_PATH, "utf8"));
        const idx = (manifest.plugins || []).findIndex((p) => p.id === plugin.id);
        if (idx >= 0) {
          manifest.plugins[idx] = { ...manifest.plugins[idx], ...updates };
          fs.writeFileSync(pluginsSvc.MANIFEST_PATH, JSON.stringify(manifest, null, 2));
          plugin = { ...plugin, ...updates };
        }
      } catch (err) {
        console.warn("[plugin-update-sync] Failed to persist APK metadata:", err?.message || err);
      }
    }
  }

  return { plugin, meta, filePath };
}

function buildProductInfRows(entries) {
  const lines = [];
  for (const e of entries) {
    lines.push(
      [
        "Android",
        "plugin",
        e.packageName,
        e.label,
        e.version,
        e.revisionCode,
        e.apkFilename,
        e.iconFilename || "",
        e.description || "",
        e.sha256,
        e.osRequirement || "",
        e.takPrereq || "",
        e.size,
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  return lines.join("\n") + (lines.length ? "\n" : "");
}

function zipProductInfz(productInfPath, iconFiles, outPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", () => resolve());
    archive.on("error", reject);
    archive.pipe(output);
    archive.file(productInfPath, { name: "product.inf" });
    for (const icon of iconFiles) {
      if (icon && icon.path && fs.existsSync(icon.path)) {
        archive.file(icon.path, { name: icon.name });
      }
    }
    archive.finalize();
  });
}

async function buildStagingBundle(plugins) {
  ensureStagingDir();
  // Clear previous staging contents
  for (const name of fs.readdirSync(STAGING_DIR)) {
    try {
      fs.unlinkSync(path.join(STAGING_DIR, name));
    } catch (_) {
      /* ignore */
    }
  }

  const rows = [];
  const iconFiles = [];
  const managedFiles = [MANAGED_SIDE_CAR, "product.inf", "product.infz"];

  for (const raw of plugins) {
    const { plugin, meta, filePath } = await enrichPluginMetadata(raw);
    if (!filePath) continue;

    const apkFilename = safeRemoteFilename(plugin.filename || path.basename(filePath), ".apk");
    const destApk = path.join(STAGING_DIR, apkFilename);
    fs.copyFileSync(filePath, destApk);
    managedFiles.push(apkFilename);

    let iconFilename = "";
    if (meta && meta.iconPng) {
      iconFilename = safeRemoteFilename(
        path.basename(apkFilename, path.extname(apkFilename)) + ".png",
        ".png"
      );
      const iconPath = path.join(STAGING_DIR, iconFilename);
      fs.writeFileSync(iconPath, meta.iconPng);
      iconFiles.push({ path: iconPath, name: iconFilename });
      managedFiles.push(iconFilename);
    }

    const packageName =
      plugin.package_name ||
      (meta && meta.packageName) ||
      path.basename(apkFilename, ".apk");
    const version = plugin.version || (meta && meta.versionName) || "0";
    const revisionCode =
      plugin.revision_code != null
        ? plugin.revision_code
        : meta && meta.versionCode
          ? parseInt(meta.versionCode, 10) || 0
          : 0;
    const sha256 = plugin.apk_hash || (meta && meta.sha256) || "";
    const size = plugin.size || (meta && meta.size) || fs.statSync(destApk).size;

    rows.push({
      packageName,
      label: plugin.name || packageName,
      version,
      revisionCode,
      apkFilename,
      iconFilename,
      description: String(plugin.description || (meta && meta.description) || "")
        .replace(/,/g, ".")
        .slice(0, 500),
      sha256,
      osRequirement: plugin.os_requirement || (meta && meta.minSdk) || "",
      takPrereq: plugin.tak_prereq || (meta && meta.pluginApi) || "",
      size,
    });
  }

  const productInfPath = path.join(STAGING_DIR, "product.inf");
  fs.writeFileSync(productInfPath, buildProductInfRows(rows), "utf8");

  const productInfzPath = path.join(STAGING_DIR, "product.infz");
  await zipProductInfz(productInfPath, iconFiles, productInfzPath);

  const managedPath = path.join(STAGING_DIR, MANAGED_SIDE_CAR);
  fs.writeFileSync(
    managedPath,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        files: managedFiles,
        pluginCount: rows.length,
      },
      null,
      2
    ),
    "utf8"
  );

  return { rows, managedFiles, stagingDir: STAGING_DIR };
}

async function runSyncOnce() {
  if (running) {
    rerunAfter = true;
    return loadStatus();
  }

  running = true;
  rerunAfter = false;
  saveStatus({
    state: "syncing",
    lastStartedAt: new Date().toISOString(),
    error: null,
    message: "Syncing plugins to TAK Server…",
  });

  try {
    if (!takSshSvc.isPrivilegedSshReady()) {
      saveStatus({
        state: "blocked_ssh",
        lastFinishedAt: new Date().toISOString(),
        error: null,
        message:
          "SSH privileged access is required. Complete Generate Key + Handshake in Settings.",
        pluginCount: pluginsSvc.listPlugins().filter((p) => p.exists).length,
      });
      return loadStatus();
    }

    const plugins = pluginsSvc.listPlugins().filter((p) => p.exists);
    const previousManaged = Array.isArray(loadStatus().managedFiles)
      ? loadStatus().managedFiles.slice()
      : [];
    const { managedFiles, stagingDir } = await buildStagingBundle(plugins);
    const remoteDir = getRemoteUpdateDir();

    // Upload all staged files
    for (const name of managedFiles) {
      const localPath = path.join(stagingDir, name);
      if (!fs.existsSync(localPath)) continue;
      const remotePath = `${remoteDir}/${name}`;
      const up = await takSshSvc.uploadRemoteFilePrivileged({
        localPath,
        remoteAbsolutePath: remotePath,
        timeoutMs: 600000,
      });
      if (!up.ok) {
        throw new Error(up.message || `Failed to upload ${name}`);
      }
    }

    // Remove files we previously managed that are no longer in the catalog
    const managedSet = new Set(managedFiles);
    for (const name of previousManaged) {
      if (managedSet.has(name)) continue;
      if (name === MANAGED_SIDE_CAR || name === "product.inf" || name === "product.infz") {
        continue;
      }
      await takSshSvc.removeRemoteFilePrivileged(`${remoteDir}/${name}`);
    }

    const finishedAt = new Date().toISOString();
    saveStatus({
      state: "success",
      lastFinishedAt: finishedAt,
      lastSuccessAt: finishedAt,
      error: null,
      message: `Synced ${plugins.length} plugin(s) to ${remoteDir}.`,
      pluginCount: plugins.length,
      managedFiles,
    });

    try {
      auditSvc.logEvent({
        actor: null,
        request: null,
        action: "PLUGIN_UPDATE_SYNC_SUCCEEDED",
        targetType: "plugin_update_sync",
        targetId: "tak-server",
        details: {
          pluginCount: plugins.length,
          remoteDir,
          updateServerUrl: getUpdateServerUrl(),
          summary: `Synced ${plugins.length} plugin(s) to TAK Server update directory.`,
        },
      });
    } catch (_) {
      /* never block */
    }

    return loadStatus();
  } catch (err) {
    const message = err?.message || String(err);
    saveStatus({
      state: "error",
      lastFinishedAt: new Date().toISOString(),
      error: message,
      message: "Plugin sync failed.",
    });
    try {
      auditSvc.logEvent({
        actor: null,
        request: null,
        action: "PLUGIN_UPDATE_SYNC_FAILED",
        targetType: "plugin_update_sync",
        targetId: "tak-server",
        details: { error: message, summary: "Plugin update sync failed." },
      });
    } catch (_) {
      /* never block */
    }
    return loadStatus();
  } finally {
    running = false;
    saveStatus({ inProgress: false });
    if (rerunAfter) {
      rerunAfter = false;
      scheduleSync("follow-up");
    }
  }
}

function scheduleSync(reason) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runSyncOnce().catch((err) => {
      console.error("[plugin-update-sync] unexpected error:", err?.message || err);
    });
  }, DEBOUNCE_MS);
  saveStatus({
    message: `Sync scheduled (${reason || "change"})…`,
  });
}

/**
 * Called after portal plugin catalog mutations.
 */
function notifyCatalogChanged(reason) {
  try {
    scheduleSync(reason || "catalog-change");
  } catch (err) {
    console.warn("[plugin-update-sync] schedule failed:", err?.message || err);
  }
}

async function syncNow() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  saveStatus({
    state: "syncing",
    message: "Sync starting…",
    lastStartedAt: new Date().toISOString(),
    error: null,
  });
  try {
    auditSvc.logEvent({
      actor: null,
      request: null,
      action: "PLUGIN_UPDATE_SYNC_STARTED",
      targetType: "plugin_update_sync",
      targetId: "tak-server",
      details: { summary: "Manual plugin update sync started." },
    });
  } catch (_) {
    /* ignore */
  }
  return runSyncOnce();
}

function getSyncStatus() {
  return loadStatus();
}

module.exports = {
  DEFAULT_REMOTE_DIR,
  getRemoteUpdateDir,
  getUpdateServerUrl,
  getSyncStatus,
  notifyCatalogChanged,
  syncNow,
  scheduleSync,
};
