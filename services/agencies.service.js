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

function findAgencyForGroupName(nameWithoutTak, agencies) {
  const upper = String(nameWithoutTak || "").trim().toUpperCase();
  if (!upper) return null;
  const list = Array.isArray(agencies) ? agencies : load();
  const prefixes = list
    .map((a) => ({
      agency: a,
      prefix: String(a?.groupPrefix || "").trim().toUpperCase(),
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
  findAgencyBySuffix,
  assertAgencyActiveBySuffix,
  findAgencyForGroupName,
};
