/**
 * Effective permissions: role defaults + per-user allow/deny overrides (JSON file).
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
  if (!entry) {
    return new Set(base);
  }
  const out = new Set(base);
  const allow = Array.isArray(entry.allow) ? entry.allow : [];
  for (const id of allow) {
    if (registry.isValidPermissionId(id)) {
      out.add(id);
    }
  }
  const deny = Array.isArray(entry.deny) ? entry.deny : [];
  if (!deny.length) {
    return out;
  }
  for (const id of deny) {
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

function saveOverridesForUser(username, overrideInput) {
  const un = normalizeUsername(username);
  if (!un) {
    throw new Error("Username required");
  }
  // Backward compatibility:
  // - saveOverridesForUser(username, denyList[])
  // - saveOverridesForUser(username, { deny: [], allow: [] })
  const rawDeny = Array.isArray(overrideInput)
    ? overrideInput
    : overrideInput && Array.isArray(overrideInput.deny)
    ? overrideInput.deny
    : [];
  const rawAllow =
    overrideInput && !Array.isArray(overrideInput) && Array.isArray(overrideInput.allow)
      ? overrideInput.allow
      : [];

  const uniqueDeny = Array.from(
    new Set(
      (rawDeny || [])
        .map((x) => String(x || "").trim())
        .filter(Boolean)
    )
  );
  const uniqueAllow = Array.from(
    new Set(
      (rawAllow || [])
        .map((x) => String(x || "").trim())
        .filter(Boolean)
    )
  );

  for (const id of uniqueDeny) {
    if (!registry.isValidPermissionId(id)) {
      throw new Error("Invalid permission id: " + id);
    }
  }
  for (const id of uniqueAllow) {
    if (!registry.isValidPermissionId(id)) {
      throw new Error("Invalid permission id: " + id);
    }
  }

  // Deny wins on conflicts.
  const denySet = new Set(uniqueDeny);
  const allowFinal = uniqueAllow.filter((id) => !denySet.has(id));

  const all = loadOverridesFromDisk();
  if (uniqueDeny.length === 0 && allowFinal.length === 0) {
    delete all[un];
  } else {
    all[un] = {
      deny: uniqueDeny.sort(),
      allow: allowFinal.sort(),
    };
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
  if (!ent) {
    return { deny: [], allow: [] };
  }
  const deny = Array.isArray(ent.deny) ? ent.deny.slice() : [];
  const allow = Array.isArray(ent.allow) ? ent.allow.slice() : [];
  return { deny, allow };
}

function listAllOverrideUsernames() {
  const all = loadOverridesFromDisk();
  return Object.keys(all).sort();
}

function clearAllOverrides() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({}, null, 2), "utf8");
  fs.renameSync(tmp, DATA_FILE);
  cache = { raw: null, mtimeMs: 0, parsed: {} };
  loadOverridesFromDisk();
}

/**
 * For UI: effective = base + allow - deny; return labels for granted areas
 */
function describeEffectiveForUser(user, authDisabled) {
  const role = getRoleType(user);
  const base = registry.getDefaultSetForRole(role);
  const un = normalizeUsername(user && user.username);
  const all = loadOverridesFromDisk();
  const entry = un && all[un] ? all[un] : null;
  const deny = entry && Array.isArray(entry.deny) ? entry.deny : [];
  const allow = entry && Array.isArray(entry.allow) ? entry.allow : [];
  const effective = getEffectivePermissionSet(user, authDisabled);
  return {
    baseRole: role,
    deny,
    allow,
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
  clearAllOverrides,
  describeEffectiveForUser,
  DATA_FILE,
};
