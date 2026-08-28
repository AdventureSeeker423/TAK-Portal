// services/portalAuth.middleware.js
const { getBool, getString } = require("./env");
const accessSvc = require("./access.service");
const { parseGroupList } = require("./authzRoles.service");
const permsSvc = require("./permissions.service");

/**
 * Optional Authentik-based access control with role levels.
 *
 * When PORTAL_AUTH_ENABLED is "false":
 *   - authentication is disabled entirely
 *   - everything is wide open
 *   - every visitor is treated as a bootstrap GLOBAL ADMIN
 *
 * When "true":
 *   - for most routes:
 *       - require X-Authentik-Username header (from Caddy + Authentik)
 *       - require membership in at least one configured admin group
 *         if any are configured.
 */

const PUBLIC_PATHS = new Set([
  "/",
  "/dashboard",
  "/setup-my-device",
  "/request-access",
  "/request-access/confirmation",
  // Token in query is the credential; session may be expired when saving high-res QR.
  "/api/qr/download",
  "/styles.css",
  "/favicon.ico",
]);

function normalizePath(p) {
  // remove trailing slashes (except keep "/" as "/")
  const out = String(p || "").replace(/\/+$/, "");
  return out || "/";
}

function attachPermissions(req, res, authUser, authEnabled) {
  const eff = permsSvc.getEffectivePermissionSet(authUser, !authEnabled);
  req.effectivePermissionSet = eff;
  res.locals.perm = (permissionId) => permsSvc.can(eff, permissionId);
  res.locals.effectivePermissionIds = Array.from(eff).sort();
}

function portalAuthMiddleware(req, res, next) {
  const authEnabled = getBool("PORTAL_AUTH_ENABLED", false);
  const method = String(req.method || "").toUpperCase();

  // Safe defaults for views
  res.locals.authUser = null;
  res.locals.isGlobalAdmin = false;
  res.locals.isAgencyAdmin = false;
  res.locals.perm = () => false;
  res.locals.effectivePermissionIds = [];
  delete req.effectivePermissionSet;

  // Always allow logout through so users who are blocked can sign out
  if (req.path === "/logout") {
    return next();
  }

  const normalizedPath = normalizePath(req.path);
  const isPublicPath = PUBLIC_PATHS.has(normalizedPath);

  // Allow anonymous submission of access requests without exposing the
  // admin-only listing endpoint.
  const isPublicAccessRequestSubmit =
    normalizedPath === "/api/user-requests" && method === "POST";
  const isPublicAccessRequestReview =
    (method === "GET" && /^\/request-access\/[a-f0-9]{32,64}$/i.test(normalizedPath)) ||
    (method === "GET" &&
      /^\/request-access\/[a-f0-9]{32,64}\/(data|meta)$/i.test(normalizedPath)) ||
    (method === "POST" &&
      /^\/request-access\/[a-f0-9]{32,64}\/(approve|reject|create-agency)$/i.test(normalizedPath));
  const isPublicMouExternalSign =
    (method === "GET" &&
      /^\/request-access\/mou\/[a-f0-9]{32,64}$/i.test(normalizedPath)) ||
    (method === "GET" &&
      /^\/request-access\/mou\/[a-f0-9]{32,64}\/file$/i.test(normalizedPath)) ||
    (method === "POST" &&
      /^\/request-access\/mou\/[a-f0-9]{32,64}\/sign$/i.test(normalizedPath)) ||
    (method === "GET" &&
      /^\/request-access\/mou\/complete\/[a-f0-9]{32,64}$/i.test(normalizedPath)) ||
    (method === "GET" &&
      /^\/request-access\/mou\/complete\/[a-f0-9]{32,64}\/pdf$/i.test(normalizedPath));

  const isPluginDownloadApi =
    method === "GET" &&
    normalizedPath.startsWith("/api/plugins/") &&
    normalizedPath.endsWith("/download");
  const isAtakApkDownloadApi =
    method === "GET" && normalizedPath === "/api/atak/download";

  // ============================================================
  // AUTH DISABLED => EVERYTHING WIDE OPEN + BOOTSTRAP ADMIN USER
  // ============================================================
  if (!authEnabled) {
    const bootstrapUser = {
      username: "bootstrap",
      uid: null,
      displayName: "ANONYMOUS",
      groups: [],
      isGlobalAdmin: true,
      isAgencyAdmin: true,
      allowedAgencySuffixes: [],
    };

    req.authentikUser = bootstrapUser;
    res.locals.authUser = bootstrapUser;
    res.locals.isGlobalAdmin = true;
    res.locals.isAgencyAdmin = true;
    res.locals.allowedAgencySuffixes = [];
    res.locals.agencyPageTitleAbbrev = null;
    attachPermissions(req, res, bootstrapUser, authEnabled);
    return next();
  }

  // ============================================================
  // AUTH ENABLED => REQUIRE HEADERS + APPLY GROUP RULES
  // ============================================================

  const usernameHeader = req.headers["x-authentik-username"];
  const username = (usernameHeader && String(usernameHeader).trim()) || "";

  const uidHeader =
    req.headers["x-authentik-uid"] ||
    req.headers["x-authentik-user-id"] ||
    req.headers["x-authentik-userid"] ||
    req.headers["x-authentik-user-pk"];
  const uid = (uidHeader && String(uidHeader).trim()) || null;

  const groupsHeader = req.headers["x-authentik-groups"] || "";

  // Tokenized review links work without portal login (even if a session exists).
  if (isPublicAccessRequestReview || isPublicMouExternalSign) {
    return next();
  }

  // Allow completely anonymous access to public paths
  if (!username && (isPublicPath || isPublicAccessRequestSubmit)) {
    return next();
  }

  if (!username) {
    return res
      .status(401)
      .send(
        "Authentication required. This portal expects to be behind an Authentik forward_auth proxy."
      );
  }

  // Parse groups from header. Authentik commonly uses ';' as a separator,
  // but we also tolerate ',' and '|' just in case.
  const userGroups = String(groupsHeader)
    .split(/[;|,]/)
    .map((g) => String(g || "").trim())
    .filter(Boolean);

  const userGroupsLower = userGroups.map((g) => g.toLowerCase());

  // Global Admin groups (existing setting)
  const globalGroupsStr = getString("PORTAL_AUTH_REQUIRED_GROUP", "").trim();
  const globalGroups = parseGroupList(globalGroupsStr);

  const isGlobalAdmin =
    globalGroups.length > 0 &&
    globalGroups.some((needed) => userGroupsLower.includes(needed));

  // Agency admin status now comes purely from the Agencies config. Any
  // agency that lists one of the user's groups in its "adminGroups"
  // field will treat this user as an agency admin for that agency.
  const agencySuffixesForUser = accessSvc.getAllowedAgencySuffixesForGroups(
    userGroupsLower
  );
  const isAgencyAdmin =
    Array.isArray(agencySuffixesForUser) && agencySuffixesForUser.length > 0;

  // CloudTAK (or other internal) bridge may inject member groups via X-Authentik-Groups
  // without granting global/agency admin. See PORTAL_BRIDGE_MEMBER_GROUPS.
  const bridgeMemberGroupsStr = getString("PORTAL_BRIDGE_MEMBER_GROUPS", "").trim();
  const bridgeMemberGroups = parseGroupList(bridgeMemberGroupsStr);
  const isBridgeMember =
    bridgeMemberGroups.length > 0 &&
    bridgeMemberGroups.some((needed) => userGroupsLower.includes(needed));

  const anyAdminGroupConfigured =
    globalGroups.length > 0 || accessSvc.hasAnyAgencyAdminsConfigured();

  // If no admin groups are configured at all, any authenticated user is allowed.
  const hasAnyRequired =
    !anyAdminGroupConfigured || isGlobalAdmin || isAgencyAdmin || isBridgeMember;

  function deny() {
    if (normalizedPath.startsWith("/api/")) {
      return res.status(403).json({ error: "Access denied" });
    }
    return res.status(403).render("access-denied", { username });
  }

  // —— Minimum portal membership: must be in an admin group (when configured) ——
  if (!isPublicPath && !isPublicAccessRequestReview) {
    if (!hasAnyRequired) {
      const isAllowedNonAdminPath =
        normalizedPath === "/setup-my-device" ||
        normalizedPath.startsWith("/api/setup-my-device") ||
        normalizedPath === "/api/mou/user-agreement/accept" ||
        normalizedPath === "/api/mou/user-agreement/decline" ||
        normalizedPath === "/plugins" ||
        normalizedPath === "/map" ||
        normalizedPath.startsWith("/map/") ||
        normalizedPath === "/api/map" ||
        normalizedPath.startsWith("/api/map/") ||
        isPluginDownloadApi ||
        isAtakApkDownloadApi;
      if (!isAllowedNonAdminPath) {
        return deny();
      }
    }

    // —— Capability / path table (replaces per-role allowlists) ——
    const eff = permsSvc.getEffectivePermissionSet(
      { username, isGlobalAdmin, isAgencyAdmin, isBridgeMember },
      false
    );
    if (!permsSvc.canAccessPath(eff, normalizedPath, method)) {
      return deny();
    }
  }

  const displayNameHeader =
    req.headers["x-authentik-name"] || req.headers["x-authentik-display-name"];
  const displayName =
    (displayNameHeader && String(displayNameHeader).trim()) || username;

  const authUser = {
    username,
    uid,
    displayName,
    groups: userGroups,
    isGlobalAdmin,
    isAgencyAdmin,
    isBridgeMember,
    allowedAgencySuffixes: agencySuffixesForUser || [],
  };

  req.authentikUser = authUser;
  res.locals.authUser = authUser;
  res.locals.isGlobalAdmin = isGlobalAdmin;
  res.locals.isAgencyAdmin = isAgencyAdmin;
  res.locals.allowedAgencySuffixes = agencySuffixesForUser || [];
  res.locals.agencyPageTitleAbbrev = accessSvc.getAgencyPageTitleAbbrev(authUser);
  res.locals.isMultiAgencyAdmin =
    isAgencyAdmin && !isGlobalAdmin && (agencySuffixesForUser || []).length > 1;
  attachPermissions(req, res, authUser, authEnabled);

  return next();
}

module.exports = portalAuthMiddleware;
