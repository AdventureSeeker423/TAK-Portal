const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "../data/agencies.json");

const DOMAIN_PART = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/**
 * Parse comma-separated domains from agency JSON (lookupDomain).
 * Returns null when empty (no domains configured).
 * Throws if any segment is invalid.
 */
function normalizeLookupDomainString(raw) {
  if (raw === null || raw === undefined) return null;
  const parts = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  for (const p of parts) {
    if (p.includes("@") || !DOMAIN_PART.test(p)) {
      throw new Error(`Invalid domain: ${p}`);
    }
  }
  return parts.map((p) => p.toLowerCase()).join(", ");
}

/** Non-throwing list for checks; empty array means no restriction. */
function domainsListFromStored(stored) {
  if (stored === null || stored === undefined || stored === "") return [];
  return String(stored)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function emailDomainInAgencyList(email, storedDomains) {
  const list = domainsListFromStored(storedDomains);
  if (list.length === 0) return true;
  const at = String(email).indexOf("@");
  if (at < 0) return false;
  const d = String(email).slice(at + 1).trim().toLowerCase();
  return list.includes(d);
}

function load() {
  return fs.existsSync(FILE)
    ? JSON.parse(fs.readFileSync(FILE, "utf8"))
    : [];
}

function isAgencyActive(agency) {
  return agency?.isActive !== false;
}

/** Agencies shown on public forms and eligible for lookup / request access. */
function isAgencyPublicEnrollmentEligible(agency) {
  return isAgencyActive(agency);
}

function filterPublicEnrollmentAgencies(agencies) {
  return (Array.isArray(agencies) ? agencies : load()).filter(
    isAgencyPublicEnrollmentEligible
  );
}

function findAgencyBySuffix(suffix, agencies) {
  const sfx = String(suffix || "").trim().toLowerCase();
  if (!sfx) return null;
  const list = Array.isArray(agencies) ? agencies : load();
  return (
    list.find((a) => String(a?.suffix || "").trim().toLowerCase() === sfx) || null
  );
}

function assertAgencyActiveBySuffix(suffix, agencies) {
  const ag = findAgencyBySuffix(suffix, agencies);
  if (!ag) throw new Error("Invalid agency");
  if (!isAgencyActive(ag)) {
    const label = String(ag.name || ag.suffix || "Agency").trim();
    throw new Error(
      `Agency "${label}" is disabled. Enable the agency on the Agencies page before performing this action.`
    );
  }
  return ag;
}

/** Trim only — preserve case and internal spaces for agency short names. */
function normalizeGroupPrefix(raw) {
  return String(raw || "").trim();
}

const GROUP_PREFIX_ALLOWED = /^[A-Za-z0-9 _-]+$/;

/**
 * Validate agency abbreviation / short name charset.
 * @returns {string|null} error message or null if valid
 */
function validateGroupPrefix(raw) {
  const gp = normalizeGroupPrefix(raw);
  if (!gp) return "Agency abbreviation / short name is required";
  if (!GROUP_PREFIX_ALLOWED.test(gp)) {
    return "Agency abbreviation / short name can only contain letters, numbers, spaces, dashes, and underscores";
  }
  return null;
}

function groupPrefixKey(raw) {
  return normalizeGroupPrefix(raw).toLowerCase();
}

function agencyNameKey(raw) {
  return String(raw || "").trim().toLowerCase();
}

/**
 * Case-insensitive uniqueness check for groupPrefix.
 * @returns {string|null} error message or null if unique
 */
function assertUniqueGroupPrefix(agencies, groupPrefix, excludeIndex) {
  const key = groupPrefixKey(groupPrefix);
  if (!key) return "Agency abbreviation / short name is required";
  const list = Array.isArray(agencies) ? agencies : load();
  const exclude = Number.isInteger(excludeIndex) ? excludeIndex : -1;
  for (let i = 0; i < list.length; i++) {
    if (i === exclude) continue;
    if (groupPrefixKey(list[i]?.groupPrefix) === key) {
      return "Agency abbreviation / short name already exists";
    }
  }
  return null;
}

/**
 * Case-insensitive uniqueness check for agency full name.
 * @returns {string|null} error message or null if unique
 */
function assertUniqueAgencyName(agencies, name, excludeIndex) {
  const key = agencyNameKey(name);
  if (!key) return "Name is required";
  const list = Array.isArray(agencies) ? agencies : load();
  const exclude = Number.isInteger(excludeIndex) ? excludeIndex : -1;
  for (let i = 0; i < list.length; i++) {
    if (i === exclude) continue;
    if (agencyNameKey(list[i]?.name) === key) {
      return "Agency name already exists";
    }
  }
  return null;
}

function getGroupAttributes(group) {
  return group && typeof group === "object" && group.attributes && typeof group.attributes === "object"
    ? group.attributes
    : {};
}

/** True when group attrs mark ownership by this agency's full name. */
function isAgencyOwnedGroup(group, agency) {
  const name = String(agency?.name || "").trim();
  if (!name) return false;
  const attrs = getGroupAttributes(group);
  const createdType = String(attrs.created_type || "").trim().toLowerCase();
  if (createdType !== "agency") return false;
  const detail = String(attrs.created_type_detail || "").trim();
  return detail.toLowerCase() === name.toLowerCase();
}

/**
 * Resolve agency from group attributes (created_type + created_type_detail).
 * Falls back to longest groupPrefix name match for legacy groups.
 */
function findAgencyForGroup(group, agencies) {
  const list = Array.isArray(agencies) ? agencies : load();
  const attrs = getGroupAttributes(group);
  const createdType = String(attrs.created_type || "").trim().toLowerCase();
  const detail = String(attrs.created_type_detail || "").trim();

  if (createdType === "agency" && detail) {
    const detailLower = detail.toLowerCase();
    const byName = list.find(
      (a) => String(a?.name || "").trim().toLowerCase() === detailLower
    );
    if (byName) return byName;

    // Legacy: created_type_detail may have been the abbreviation only
    const byPrefix = list.find(
      (a) => groupPrefixKey(a?.groupPrefix) === detailLower
    );
    if (byPrefix) return byPrefix;
  }

  const nameWithoutTak = String(group?.name || "").trim();
  const stripped = nameWithoutTak.toLowerCase().startsWith("tak_")
    ? nameWithoutTak.slice(4)
    : nameWithoutTak;
  return findAgencyForGroupName(stripped, list);
}

/** Legacy name-prefix match (longest groupPrefix first). */
function findAgencyForGroupName(nameWithoutTak, agencies) {
  const upper = String(nameWithoutTak || "").trim().toUpperCase();
  if (!upper) return null;
  const list = Array.isArray(agencies) ? agencies : load();
  const prefixes = list
    .map((a) => ({
      agency: a,
      prefix: normalizeGroupPrefix(a?.groupPrefix).toUpperCase(),
    }))
    .filter((x) => x.prefix)
    .sort((a, b) => b.prefix.length - a.prefix.length);
  for (const { agency, prefix } of prefixes) {
    if (
      upper.startsWith(prefix + " ") ||
      upper.startsWith(prefix + "-") ||
      upper.startsWith(prefix + " -")
    ) {
      return agency;
    }
  }
  return null;
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  try {
    const dashboardStatsCache = require("./dashboardStatsCache.service");
    dashboardStatsCache.refreshAfterAgenciesChanged();
  } catch (err) {
    console.warn(
      "[AGENCIES] Dashboard stats refresh after save failed:",
      err?.message || err
    );
  }
}

module.exports = {
  load,
  save,
  FILE,
  normalizeLookupDomainString,
  domainsListFromStored,
  emailDomainInAgencyList,
  isAgencyActive,
  isAgencyPublicEnrollmentEligible,
  filterPublicEnrollmentAgencies,
  findAgencyBySuffix,
  assertAgencyActiveBySuffix,
  normalizeGroupPrefix,
  validateGroupPrefix,
  groupPrefixKey,
  agencyNameKey,
  assertUniqueGroupPrefix,
  assertUniqueAgencyName,
  isAgencyOwnedGroup,
  findAgencyForGroup,
  findAgencyForGroupName,
};
