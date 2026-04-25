// services/portalAuth.middleware.js
const { getBool, getString } = require("./env");
const accessSvc = require("./access.service");

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

function parseGroupList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean);
}

function normalizePath(p) {
  // remove trailing slashes (except keep "/" as "/")
  const out = String(p || "").replace(/\/+$/, "");
  return out || "/";
}

function portalAuthMiddleware(req, res, next) {
  const authEnabled = getBool("PORTAL_AUTH_ENABLED", false);
  const method = String(req.method || "").toUpperCase();

  // Safe defaults for views
  res.locals.authUser = null;
  res.locals.isGlobalAdmin = false;
  res.locals.isAgencyAdmin = false;

  // Always allow logout through so users who are blocked can sign out
  if (req.path === "/logout") {
    return next();
  }

  const normalizedPath = normalizePath(req.path);
  const isPublicPath = PUBLIC_PATHS.has(normalizedPath);

  // Allow anonymous submission of access requests without exposing the
  // admin-only listing endpoint.
  const isPublicAccessRequestSubmit =
    normalizedPath === "/api/user-requests" &&
    method === "POST";

  const isPluginDownloadApi =
    method === "GET" &&
    normalizedPath.startsWith("/api/plugins/") &&
    normalizedPath.endsWith("/download");

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
      isAgencyAdmin: true, // optional, but helps if any code checks this too
      allowedAgencySuffixes: [],
    };

    req.authentikUser = bootstrapUser;
    res.locals.authUser = bootstrapUser;
    res.locals.isGlobalAdmin = true;
    res.locals.isAgencyAdmin = true;
    res.locals.allowedAgencySuffixes = [];

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
  const agencySuffixesForUser =
    accessSvc.getAllowedAgencySuffixesForGroups(userGroupsLower);
  const isAgencyAdmin =
    Array.isArray(agencySuffixesForUser) && agencySuffixesForUser.length > 0;

  const anyAdminGroupConfigured =
    globalGroups.length > 0 || accessSvc.hasAnyAgencyAdminsConfigured();

  // If no admin groups are configured at all, any authenticated user is allowed.
  const hasAnyRequired =
    !anyAdminGroupConfigured || isGlobalAdmin || isAgencyAdmin;

// ============================================================
// ROLE-BASED ROUTE ENFORCEMENT
// ============================================================

function deny() {
  if (normalizedPath.startsWith("/api/")) {
    return res.status(403).json({ error: "Access denied" });
  }
  return res.status(403).render("access-denied", { username });
}

if (!isPublicPath) {

  // Must be authenticated
  if (!username) {
    if (normalizedPath.startsWith("/api/")) {
      return res.status(401).json({ error: "Authentication required" });
    }

    return res
      .status(401)
      .send(
        "Authentication required. This portal expects to be behind an Authentik forward_auth proxy."
      );
  }

  // If admin groups exist, user must be at least agency admin — except
  // any authenticated user may access Setup My Device and the Plugins page.
  if (!hasAnyRequired) {
    const isAllowedNonAdminPath =
      normalizedPath === "/setup-my-device" ||
      normalizedPath.startsWith("/api/setup-my-device") ||
      normalizedPath === "/plugins" ||
      isPluginDownloadApi;
    if (!isAllowedNonAdminPath) {
      return deny();
    }
  }

  // GLOBAL ADMINS can access everything
  if (isGlobalAdmin) {
    // allow
  }

  // AGENCY ADMINS limited routes
  else if (isAgencyAdmin) {

    // Agency admins must be able to *read* agencies so the UI can load and
    // prefill agency dropdowns (Users / Groups / Templates).
    // Any writes to agencies remain GLOBAL ADMIN only.
    if (normalizedPath === "/api/agencies" || normalizedPath.startsWith("/api/agencies/")) {
      const method = String(req.method || "GET").toUpperCase();
      if (method !== "GET") {
        return deny();
      }
      // GET is allowed; continue to normal allowlist checks.
    }

    const allowedAgencyAdminPrefixes = [
      "/dashboard",
      "/users",
      "/groups",
      "/templates",
      "/email",
      "/plugins",
      "/setup-my-device",
      "/pending-user-requests",
      "/documents",
      "/sample-users.csv",
      "/csv-instructions-readme.txt",
      "/api/users",
      "/api/groups",
      "/api/templates",
      "/api/agencies",
      "/api/email",
      "/api/setup-my-device",
      "/api/user-requests",
      "/api/tak",
      "/api/documents",
      "/api/plugins",
    ];

    const allowed = allowedAgencyAdminPrefixes.some(prefix =>
      normalizedPath === prefix || normalizedPath.startsWith(prefix + "/")
    );

    if (!allowed) {
      return deny();
    }
  }

  // NORMAL USERS: setup-my-device and plugins page
  else {

    const allowedUserPrefixes = [
      "/setup-my-device",
      "/api/setup-my-device",
      "/plugins",
      "/api/plugins",
    ];

    const allowed = allowedUserPrefixes.some(prefix =>
      normalizedPath === prefix || normalizedPath.startsWith(prefix + "/")
    );

    if (!allowed) {
      return deny();
    }
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
    allowedAgencySuffixes: agencySuffixesForUser || [],
  };

  req.authentikUser = authUser;
  res.locals.authUser = authUser;
  res.locals.isGlobalAdmin = isGlobalAdmin;
  res.locals.isAgencyAdmin = isAgencyAdmin;
  res.locals.allowedAgencySuffixes = agencySuffixesForUser || [];

  return next();
}

module.exports = portalAuthMiddleware;
