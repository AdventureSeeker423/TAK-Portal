/**
 * Central permission catalog + default role caps + path -> required permission(s).
 */

const PERMISSIONS = {
  page: {
    dashboard: {
      id: "page.dashboard",
      label: "Dashboard",
      description: "View the home dashboard after sign-in.",
      section: "core",
    },
    users: {
      id: "page.users",
      label: "Users",
      description: "Open Users screens (create, manage, CSV samples).",
      section: "usersGroups",
    },
    groups: {
      id: "page.groups",
      label: "Groups",
      description: "Manage Authentik groups.",
      section: "usersGroups",
    },
    templates: {
      id: "page.templates",
      label: "Templates",
      description: "Onboarding / user templates.",
      section: "usersGroups",
    },
    email: {
      id: "page.email",
      label: "Email Users",
      description: "Send email to users from the portal.",
      section: "administration",
    },
    mou: {
      id: "page.mou",
      label: "MOUs",
      description: "View MOUs, user agreement, and compliance workflows.",
      section: "administration",
    },
    agencies: {
      id: "page.agencies",
      label: "Agencies",
      description: "View and manage agency records.",
      section: "configuration",
    },
    settings: {
      id: "page.settings",
      label: "Server Settings",
      description: "TAK/portal configuration and secrets.",
      section: "configuration",
    },
    integrations: {
      id: "page.integrations",
      label: "Integrations",
      description: "Third-party and SSH integrations UI.",
      section: "configuration",
    },
    audit_log: {
      id: "page.audit_log",
      label: "Audit Log",
      description: "View security and audit events.",
      section: "administration",
    },
    mutual_aid: {
      id: "page.mutual_aid",
      label: "Mutual Aid",
      description: "Mutual aid workflows.",
      section: "administration",
    },
    plugin_manager: {
      id: "page.plugin_manager",
      label: "Plugin Manager",
      description: "Upload and manage server-side plugin packages.",
      section: "configuration",
    },
    locate: {
      id: "page.locate",
      label: "Locate Persons (Admin)",
      description: "Administrator locate tools.",
      section: "administration",
    },
    data_sync: {
      id: "page.data_sync",
      label: "Data Sync",
      description: "Data sync (beta, global).",
      section: "administration",
    },
    data_package: {
      id: "page.data_package",
      label: "Data Package",
      description: "Export and package data (global).",
      section: "administration",
    },
    access_control: {
      id: "page.access_control",
      label: "Access Control",
      description: "Per-user permission overrides (global by default).",
      section: "configuration",
    },
  },
};

function flattenMeta() {
  const out = [];
  for (const g of Object.values(PERMISSIONS)) {
    for (const v of Object.values(g)) {
      if (v && v.id) out.push(v);
    }
  }
  return out;
}

const ALL_FLAT = flattenMeta();
const ALL_PERMISSION_IDS = ALL_FLAT.map((x) => x.id);
const BY_ID = new Map(ALL_FLAT.map((m) => [m.id, m]));

/** Global admin: all capabilities in registry. */
const GLOBAL_DEFAULT = new Set(ALL_PERMISSION_IDS);

/** Agency admin defaults (page-level only). */
const AGENCY_DEFAULT = new Set([
  "page.dashboard",
  "page.users",
  "page.groups",
  "page.templates",
  "page.email",
  "page.mou",
]);

/** Standard defaults are now handled by always-on routes (plugins/setup), not configurable keys. */
const STANDARD_DEFAULT = new Set(["page.mou"]);

function normalizePath(p) {
  const out = String(p || "").replace(/\/+$/, "");
  return out || "/";
}

/**
 * Returns permission ids required to access this path+method, or null if not covered (deny).
 */
function getRequiredPermissionsForRequest(path, method) {
  const p = normalizePath(path);
  const m = String(method || "GET").toUpperCase();

  // Legacy baseline pages/assets.
  if (p === "/" || p === "/dashboard" || p.startsWith("/dashboard/")) return [];
  if (p === "/setup-my-device" || p.startsWith("/setup-my-device/")) return [];
  if (p === "/plugins" || p.startsWith("/plugins/")) return [];
  if (p.startsWith("/api/setup-my-device")) return [];
  if (p.startsWith("/api/qr")) return [];
  if (p.startsWith("/api/plugins/") && p.endsWith("/download") && m === "GET") return [];
  if (p === "/styles.css" || p === "/favicon.ico") return [];

  // APIs now inherit from their owning page capability.
  if (p.startsWith("/api/audit-log")) return ["page.audit_log"];
  if (p.startsWith("/api/plugins")) return ["page.plugin_manager"];
  if (p.startsWith("/api/integrations")) return ["page.integrations"];
  if (p.startsWith("/api/ssh")) return ["page.integrations"];
  if (p.startsWith("/api/locate")) return ["page.locate"];
  if (p.startsWith("/api/data-sync")) return ["page.data_sync"];
  if (p.startsWith("/api/data-packages")) return ["page.data_package"];
  if (p === "/api/agencies" || p.startsWith("/api/agencies/")) {
    // Shared lookup API used by multiple pages (Users/Groups/Templates/Email/Pending requests).
    // Keep reads broadly available for authenticated users; writes remain restricted.
    if (m === "GET" || m === "HEAD") return [];
    return ["page.agencies"];
  }
  if (p.startsWith("/api/users")) return ["page.users"];
  if (p.startsWith("/api/groups")) return ["page.groups"];
  if (p.startsWith("/api/templates")) return ["page.templates"];
  if (p.startsWith("/api/mutual-aid")) return ["page.mutual_aid"];
  if (p.startsWith("/api/tak")) return ["page.dashboard"];
  if (p.startsWith("/api/user-requests")) return ["page.users"];
  if (p.startsWith("/api/email")) return ["page.email"];
  if (p.startsWith("/api/mou")) return ["page.mou"];
  if (p.startsWith("/api/settings/tak-maintenance")) return ["page.settings"];
  // Getting-started is role-gated in server.js, not permission-toggled.

  // Pages
  if (p === "/dashboard" || p.startsWith("/dashboard/")) return ["page.dashboard"];
  if (p === "/access-control" || p.startsWith("/access-control/")) return ["page.access_control"];
  if (p === "/api/access-control" || p.startsWith("/api/access-control/")) return ["page.access_control"];
  if (p.startsWith("/users")) return ["page.users"];
  if (p.startsWith("/groups")) return ["page.groups"];
  if (p.startsWith("/templates")) return ["page.templates"];
  if (p === "/email" || p.startsWith("/email/")) return ["page.email"];
  if (p === "/mou" || p.startsWith("/mou/")) return ["page.mou"];
  if (p === "/admin/mou" || p.startsWith("/admin/mou/")) return ["page.mou"];
  if (p === "/pending-user-requests" || p.startsWith("/pending-user-requests/")) return ["page.users"];
  if (p === "/agencies" || p.startsWith("/agencies/")) return ["page.agencies"];
  if (p === "/settings" || p.startsWith("/settings/")) return ["page.settings"];
  if (p === "/integrations" || p.startsWith("/integrations/")) return ["page.integrations"];
  if (p === "/audit-log" || p.startsWith("/audit-log/")) return ["page.audit_log"];
  if (p === "/mutual-aid" || p.startsWith("/mutual-aid/")) return ["page.mutual_aid"];
  // Admin locate console is exactly /locate (public share /locate/:slug bypasses portalAuth in server.js)
  if (p === "/locate") return ["page.locate"];
  if (p === "/data-sync" || p.startsWith("/data-sync/")) return ["page.data_sync"];
  if (p === "/data-package" || p === "/data-packages" || p.startsWith("/data-package/")) return ["page.data_package"];
  if (p === "/plugin-manager" || p.startsWith("/plugin-manager/")) return ["page.plugin_manager"];
  if (p === "/sample-users.csv" || p === "/sample-agencies.csv" || p === "/csv-instructions-readme.txt")
    return ["page.users"];

  // Unknown: deny at middleware (safe)
  return null;
}

/**
 * @param {"global_admin"|"agency_admin"|"standard"} role
 */
function getDefaultSetForRole(role) {
  if (role === "global_admin") return new Set(GLOBAL_DEFAULT);
  if (role === "agency_admin") return new Set(AGENCY_DEFAULT);
  return new Set(STANDARD_DEFAULT);
}

function isValidPermissionId(id) {
  return typeof id === "string" && BY_ID.has(id);
}

function listAllPermissionMeta() {
  return ALL_FLAT.slice();
}

function getPermissionMeta(id) {
  return BY_ID.get(id) || null;
}

module.exports = {
  PERMISSIONS,
  ALL_PERMISSION_IDS,
  BY_ID,
  getDefaultSetForRole,
  getRequiredPermissionsForRequest,
  getPermissionMeta,
  isValidPermissionId,
  listAllPermissionMeta,
  normalizePath,
};
