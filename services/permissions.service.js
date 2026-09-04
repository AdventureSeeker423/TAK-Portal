/**
 * Effective permissions: role defaults + per-user allow/deny overrides (Postgres).
 */

const registry = require("./permissions.registry");
const { getString } = require("./env");
const pgCache = require("./pgCache");

const DATA_FILE = null;

function loadOverridesFromDisk() {
  const parsed = pgCache.caches.permissionOverrides;
  if (typeof parsed !== "object" || parsed === null) return {};
  return parsed;
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
function getBridgeMemberPermissions() {
  const permsRaw = getString("PORTAL_BRIDGE_MEMBER_PERMISSIONS", "page.locate");
  return String(permsRaw || "")
    .split(",")
    .map((p) => p.trim())
    .filter((id) => registry.isValidPermissionId(id));
}

function getEffectivePermissionSet(user, authDisabled) {
  if (authDisabled) {
    return new Set(registry.ALL_PERMISSION_IDS);
  }
  const role = getRoleType(user);
  const base = registry.getDefaultSetForRole(role);
  const un = normalizeUsername(user && user.username);
  const all = loadOverridesFromDisk();
  const entry = un && all[un] ? all[un] : null;
  const out = new Set(base);

  if (user && user.isBridgeMember) {
    for (const id of getBridgeMemberPermissions()) {
      out.add(id);
    }
  }

  if (!entry) {
    return out;
  }
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

  const all = { ...loadOverridesFromDisk() };
  if (uniqueDeny.length === 0 && allowFinal.length === 0) {
    delete all[un];
  } else {
    all[un] = {
      deny: uniqueDeny.sort(),
      allow: allowFinal.sort(),
    };
  }
  pgCache.replacePermissionOverrides(all);
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
  describeEffectiveForUser,
  DATA_FILE,
};
