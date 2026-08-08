const settingsSvc = require("./settings.service");

/**
 * Shipped default agency types (order fixed for new installs / reset).
 * "Other" is always appended last in the Agencies dropdown and is not stored.
 */
const DEFAULT_AGENCY_TYPES = [
  "Law Enforcement",
  "Fire",
  "EMS",
  "State Defense",
  "Military",
  "Game Warden / NPS / Forestry",
  "CBRNE / HAZMAT",
  "SAR / Technical",
  "Emergency Management",
  "Dispatch / Communications",
  "Public Works",
  "Volunteer",
];

/** @deprecated Use DEFAULT_AGENCY_TYPES */
const CORE_AGENCY_TYPES = DEFAULT_AGENCY_TYPES;

const MAX_AGENCY_TYPES = 30;
/** @deprecated Use MAX_AGENCY_TYPES */
const MAX_ADDITIONAL_AGENCY_TYPES = MAX_AGENCY_TYPES;

function isCustomized(settings) {
  const raw = String(settings?.AGENCY_TYPES_CUSTOMIZED || "")
    .trim()
    .toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

function getStoredAgencyTypes(settings) {
  const s = settings || {};
  const out = [];
  const seen = new Set();
  for (let i = 1; i <= MAX_AGENCY_TYPES; i += 1) {
    const v = String(s[`ADDITIONAL_AGENCY_TYPE_${i}`] || "").trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (key === "other") continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/** @deprecated Use getStoredAgencyTypes */
function getAdditionalAgencyTypesFromSettings(settings) {
  return getStoredAgencyTypes(settings);
}

function mergeDefaultsAndExtras(extras) {
  const seen = new Set();
  const out = [];
  for (const t of DEFAULT_AGENCY_TYPES) {
    const key = String(t || "")
      .trim()
      .toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  for (const e of extras || []) {
    const v = String(e || "").trim();
    const key = v.toLowerCase();
    if (!v || key === "other" || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out.slice(0, MAX_AGENCY_TYPES);
}

/**
 * Editable types for settings UI / dropdown (without trailing "Other").
 * - Customized installs: stored list (fallback to defaults if empty)
 * - Legacy / uncustomized: shipped defaults + any stored extras
 */
function getConfigurableAgencyTypes(settings) {
  const s = settings != null ? settings : settingsSvc.getSettings() || {};
  const stored = getStoredAgencyTypes(s);
  if (isCustomized(s)) {
    return stored.length ? stored.slice(0, MAX_AGENCY_TYPES) : [...DEFAULT_AGENCY_TYPES];
  }
  return mergeDefaultsAndExtras(stored);
}

/**
 * Full ordered list for the Agencies page type dropdown.
 * Configurable types, then Other.
 */
function getAgencyTypeOptions(settings) {
  return [...getConfigurableAgencyTypes(settings), "Other"];
}

function buildAgencyTypeSettingsPatch(types, customized = true) {
  const seen = new Set();
  const normalized = [];
  for (const raw of Array.isArray(types) ? types : []) {
    const v = String(raw || "").trim();
    const key = v.toLowerCase();
    if (!v || key === "other" || seen.has(key)) continue;
    seen.add(key);
    normalized.push(v);
    if (normalized.length >= MAX_AGENCY_TYPES) break;
  }
  const patch = {
    AGENCY_TYPES_CUSTOMIZED: customized ? "true" : "false",
  };
  for (let i = 1; i <= MAX_AGENCY_TYPES; i += 1) {
    patch[`ADDITIONAL_AGENCY_TYPE_${i}`] = normalized[i - 1] || "";
  }
  return patch;
}

module.exports = {
  DEFAULT_AGENCY_TYPES,
  CORE_AGENCY_TYPES,
  MAX_AGENCY_TYPES,
  MAX_ADDITIONAL_AGENCY_TYPES,
  getAgencyTypeOptions,
  getConfigurableAgencyTypes,
  getStoredAgencyTypes,
  getAdditionalAgencyTypesFromSettings,
  buildAgencyTypeSettingsPatch,
  isCustomized,
};
