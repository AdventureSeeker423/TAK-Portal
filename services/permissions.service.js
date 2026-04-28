/**
 * Effective permissions: role defaults + per-user deny overrides (JSON file).
 */

const fs = require("fs");
const path = require("path");
const registry = require("./permissions.registry");

const DATA_FILE = path.join(__dirname, "..", "data", "permission-overrides.json");

let cache = { raw: null, mtimeMs: 0, parsed: {} };

function loadOverridesFromDisk() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return {};
    }
    const st = fs.statSync(DATA_FILE);
    if (cache.raw != null && st.mtimeMs === cache.mtimeMs) {
      return cache.parsed;
    }
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw || "{}");
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    cache = { raw, mtimeMs: st.mtimeMs, parsed };
    return parsed;
  } catch (e) {
    console.warn("[permissions] Failed to load permission-overrides.json:", e.message || e);
    return {};
  }
}

function normalizeUsername(u) {
  return String(u || "").trim().toLowerCase();
}

/**
 * @param {{ isGlobalAdmin: boolean, isAgencyAdmin: boolean, username?: string }} user
 * @returns {"global_admin"|"agency_admin"|"standard"}
 */
function getRoleType(user) {
  if (user && user.isGlobalAdmin) return "global_admin";
  if (user && user.isAgencyAdmin) return "agency_admin";
  return "standard";
}

/**
 * @param {{ isGlobalAdmin: boolean, isAgencyAdmin: boolean, username?: string }} user
 * @param {boolean} authDisabled - PORTAL_AUTH_ENABLED false: full access
 * @returns {Set<string>}
 */
function getEffectivePermissionSet(user, authDisabled) {
  if (authDisabled) {
    return new Set(registry.ALL_PERMISSION_IDS);
  }
  const role = getRoleType(user);
  const base = registry.getDefaultSetForRole(role);
  const un = normalizeUsername(user && user.username);
  const all = loadOverridesFromDisk();
  const entry = un && all[un] ? all[un] : null;
  if (!entry || !Array.isArray(entry.deny) || !entry.deny.length) {
    return new Set(base);
  }
  const out = new Set(base);
  for (const id of entry.deny) {
    if (registry.isValidPermissionId(id)) {
      out.delete(id);
    }
  }
  return out;
}

function can(effectiveSet, permissionId) {
  if (!effectiveSet) return false;
  return effectiveSet.has(permissionId);
}

/**
 * @returns {boolean} true if allowed
 */
function canAccessPath(effectiveSet, reqPath, method) {
  const required = registry.getRequiredPermissionsForRequest(reqPath, method);
  if (required === null) {
    return false;
  }
  if (required.length === 0) {
    return true;
  }
  return required.every((id) => effectiveSet.has(id));
}

function saveOverridesForUser(username, denyList) {
  const un = normalizeUsername(username);
  if (!un) {
    throw new Error("Username required");
  }
  const unique = Array.from(
    new Set(
      (denyList || [])
        .map((x) => String(x || "").trim())
        .filter(Boolean)
    )
  );
  for (const id of unique) {
    if (!registry.isValidPermissionId(id)) {
      throw new Error("Invalid permission id: " + id);
    }
  }
  const all = loadOverridesFromDisk();
  if (unique.length === 0) {
    delete all[un];
  } else {
    all[un] = { deny: unique.sort() };
  }
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), "utf8");
  fs.renameSync(tmp, DATA_FILE);
  cache = { raw: null, mtimeMs: 0, parsed: {} };
  loadOverridesFromDisk();
}

function getOverridesForUser(username) {
  const un = normalizeUsername(username);
  const all = loadOverridesFromDisk();
  const ent = all[un];
  if (!ent || !Array.isArray(ent.deny)) {
    return { deny: [] };
  }
  return { deny: ent.deny.slice() };
}

function listAllOverrideUsernames() {
  const all = loadOverridesFromDisk();
  return Object.keys(all).sort();
}

/**
 * For UI: effective = base minus deny; return labels for granted areas
 */
function describeEffectiveForUser(user, authDisabled) {
  const role = getRoleType(user);
  const base = registry.getDefaultSetForRole(role);
  const un = normalizeUsername(user && user.username);
  const all = loadOverridesFromDisk();
  const entry = un && all[un] ? all[un] : null;
  const deny = entry && Array.isArray(entry.deny) ? entry.deny : [];
  const effective = getEffectivePermissionSet(user, authDisabled);
  return {
    baseRole: role,
    deny,
    effectiveIds: Array.from(effective).sort(),
  };
}

module.exports = {
  getRoleType,
  getEffectivePermissionSet,
  can,
  canAccessPath,
  saveOverridesForUser,
  getOverridesForUser,
  listAllOverrideUsernames,
  describeEffectiveForUser,
  DATA_FILE,
};
