const fs = require("fs");
const path = require("path");

const SETTINGS_PATH = path.join(__dirname, "..", "data", "settings.json");
// Example template at project root
const TEMPLATE_PATH = path.join(__dirname, "..", "settings.example.json");
const DEPRECATED_KEYS = new Set(["MOU_REQUIRE_AGENCY_SIGNATURE"]);

function ensureDirExists(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

let _settings = null;

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (err) {
    console.warn(`[settings] Failed to read ${filePath}:`, err.message || err);
  }
  return {};
}

function stripDeprecatedKeys(settings) {
  const next = { ...(settings || {}) };
  let removed = false;
  for (const key of DEPRECATED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(next, key)) {
      delete next[key];
      removed = true;
    }
  }
  return { settings: next, removed };
}

function mergeWithTemplate(existing) {
  const template = fs.existsSync(TEMPLATE_PATH)
    ? readJsonSafe(TEMPLATE_PATH)
    : {};

  // No template? Just return whatever we had.
  if (!template || Object.keys(template).length === 0) {
    return { merged: existing || {}, needsSave: false };
  }

  const { settings: current, removed: removedDeprecated } = stripDeprecatedKeys(
    existing || {}
  );

  // template values are defaults; existing config overrides them
  const merged = { ...template, ...current };

  // Needs save if we’re missing any template keys
  let needsSave = Object.keys(template).some(
    key => !Object.prototype.hasOwnProperty.call(current, key)
  ) || removedDeprecated;

  // One-time: when Allowed Client Devices was introduced, template merge seeded
  // ALLOWED_CLIENT_CLOUDTAK=false even if CLOUDTAK_URL was already set. Enable
  // CloudTAK once when a URL exists, then mark migration complete.
  if (String(current.ALLOWED_CLIENT_DEVICES_MIGRATION || "") !== "1") {
    const cloudtakUrl = String(merged.CLOUDTAK_URL || "").trim();
    if (cloudtakUrl) {
      merged.ALLOWED_CLIENT_CLOUDTAK = "true";
    }
    merged.ALLOWED_CLIENT_DEVICES_MIGRATION = "1";
    needsSave = true;
  }

  return { merged, needsSave };
}

function loadSettingsFromDisk() {
  let existing = {};

  if (fs.existsSync(SETTINGS_PATH)) {
    existing = readJsonSafe(SETTINGS_PATH);
  }

  const { merged, needsSave } = mergeWithTemplate(existing);

  if (!fs.existsSync(SETTINGS_PATH) || needsSave) {
    ensureDirExists(SETTINGS_PATH);
    try {
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
      console.log("[settings] Wrote merged settings.json");
    } catch (err) {
      console.warn(
        "[settings] Failed to write settings.json:",
        err.message || err
      );
    }
  }

  return merged;
}

function ensureSettingsInitialized() {
  _settings = loadSettingsFromDisk();
}

function getSettings() {
  if (_settings === null) {
    _settings = loadSettingsFromDisk();
  }
  return _settings;
}

function saveSettings(newSettings) {
  _settings = stripDeprecatedKeys(newSettings || {}).settings;
  ensureDirExists(SETTINGS_PATH);
  const payload = JSON.stringify(_settings, null, 2);
  // Atomic replace avoids torn/partial settings.json under rapid autosave writes.
  const tmpPath = SETTINGS_PATH + ".tmp";
  fs.writeFileSync(tmpPath, payload);
  try {
    fs.renameSync(tmpPath, SETTINGS_PATH);
  } catch (err) {
    // Windows can fail rename over an existing file; fall back to copy+unlink.
    fs.copyFileSync(tmpPath, SETTINGS_PATH);
    try {
      fs.unlinkSync(tmpPath);
    } catch (_) {}
  }
}

function updateSettings(patch) {
  const merged = { ...getSettings(), ...(patch || {}) };
  saveSettings(merged);
}

function get(name, fallback) {
  const cfg = getSettings();
  if (Object.prototype.hasOwnProperty.call(cfg, name)) {
    return cfg[name];
  }
  return fallback;
}

/** Parse flat settings[KEY] fields from a multipart or urlencoded POST body. */
function collectBodySettings(rawBody) {
  const bodySettings = {};
  const raw = rawBody || {};

  if (raw.settings && typeof raw.settings === "object") {
    Object.keys(raw.settings).forEach((key) => {
      bodySettings[key] = raw.settings[key];
    });
  }

  Object.keys(raw).forEach((key) => {
    const nested = key.match(/^settings\[([^\]]+)\]\[([^\]]+)\]$/);
    if (nested) {
      const parent = nested[1];
      const child = nested[2];
      if (!bodySettings[parent] || typeof bodySettings[parent] !== "object") {
        bodySettings[parent] = {};
      }
      bodySettings[parent][child] = raw[key];
      return;
    }
    const match = key.match(/^settings\[([^\]]+)\]$/);
    if (match) {
      bodySettings[match[1]] = raw[key];
    }
  });

  return bodySettings;
}

module.exports = {
  SETTINGS_PATH,
  TEMPLATE_PATH,
  ensureSettingsInitialized,
  getSettings,
  saveSettings,
  updateSettings,
  get,
  collectBodySettings,
};
