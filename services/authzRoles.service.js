/**
 * Derive portal roles (global / agency / standard) from Authentik group *names*.
 * Mirrors services/portalAuth.middleware.js logic for consistency.
 */

const { getString } = require("./env");
const accessSvc = require("./access.service");

function parseGroupList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * @param {string[]} groupNames - display names from Authentik (any case)
 * @returns {{ isGlobalAdmin: boolean, isAgencyAdmin: boolean, allowedAgencySuffixes: string[] }}
 */
function computePortalRolesFromGroupNames(groupNames) {
  const userGroupsLower = Array.isArray(groupNames)
    ? groupNames.map((g) => String(g || "").trim().toLowerCase()).filter(Boolean)
    : [];

  const globalGroupsStr = getString("PORTAL_AUTH_REQUIRED_GROUP", "").trim();
  const globalGroups = parseGroupList(globalGroupsStr);

  const isGlobalAdmin =
    globalGroups.length > 0 &&
    globalGroups.some((needed) => userGroupsLower.includes(needed));

  const agencySuffixesForUser =
    accessSvc.getAllowedAgencySuffixesForGroups(userGroupsLower);
  const isAgencyAdmin =
    Array.isArray(agencySuffixesForUser) && agencySuffixesForUser.length > 0;

  return {
    isGlobalAdmin,
    isAgencyAdmin,
    allowedAgencySuffixes: Array.isArray(agencySuffixesForUser)
      ? agencySuffixesForUser
      : [],
  };
}

module.exports = {
  computePortalRolesFromGroupNames,
  parseGroupList,
};
