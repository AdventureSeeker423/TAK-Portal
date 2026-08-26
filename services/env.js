const settingsStore = require("./settings.service");

function rawEnv(name) {
  const fromSettings = settingsStore.get(name, undefined);
  if (fromSettings !== undefined) return String(fromSettings ?? "");

  if (!Object.prototype.hasOwnProperty.call(process.env, name)) return undefined;
  return String(process.env[name] ?? "");
}

function getString(name, fallback) {
  const raw = rawEnv(name);
  if (raw === undefined || raw === null || raw === "") return fallback;
  return String(raw);
}

function getBool(name, fallback) {
  const v = getString(name, "").toLowerCase();
  if (!v) return fallback;

  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;

  return fallback;
}

function getInt(name, fallback) {
  const v = getString(name, "");
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function isLiveMapEnabled() {
  return getBool("LIVE_MAP_ENABLED", true);
}

module.exports = {
  getString,
  getBool,
  getInt,
  isLiveMapEnabled,
};
