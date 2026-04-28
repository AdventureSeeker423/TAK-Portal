/**
 * Central permission catalog + default role caps + path → required permission(s).
 * Keys are stable strings (e.g. page.settings) used in overrides and UI.
 */

const PERMISSIONS = {
  // —— Pages (HTML) ——
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
      label: "Email users",
      description: "Send email to users from the portal.",
      section: "administration",
    },
    plugins: {
      id: "page.plugins",
      label: "ATAK plugins (end user)",
      description: "Download plugins as an end user.",
      section: "onboarding",
    },
    setup_device: {
      id: "page.setup_device",
      label: "Setup my device",
      description: "End-user device enrollment flows.",
      section: "onboarding",
    },
    pending_requests: {
      id: "page.pending_requests",
      label: "Pending user requests",
      description: "Review access requests (admin queue).",
      section: "administration",
    },
    documents: {
      id: "page.documents",
      label: "Documents",
      description: "Document workflows (beta).",
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
      label: "Server settings",
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
      label: "Audit log",
      description: "View security and audit events.",
      section: "administration",
    },
    mutual_aid: {
      id: "page.mutual_aid",
      label: "Mutual aid",
      description: "Mutual aid workflows.",
      section: "administration",
    },
    plugin_manager: {
      id: "page.plugin_manager",
      label: "Plugin manager",
      description: "Upload and manage server-side plugin packages.",
      section: "configuration",
    },
    locate: {
      id: "page.locate",
      label: "Locate persons (admin)",
      description: "Administrator locate tools (strict global today).",
      section: "administration",
    },
    data_sync: {
      id: "page.data_sync",
      label: "Data sync",
      description: "Data sync (beta, global).",
      section: "administration",
    },
    data_package: {
      id: "page.data_package",
      label: "Data package",
      description: "Export and package data (global).",
      section: "administration",
    },
    getting_started: {
      id: "page.getting_started",
      label: "Getting started",
      description: "Global onboarding (beta).",
      section: "onboarding",
    },
    access_control: {
      id: "page.access_control",
      label: "Access control",
      description: "Per-user permission overrides (global by default).",
      section: "configuration",
    },
  },
  // —— API clusters ——
  api: {
    users: { id: "api.users", label: "Users API", description: "List and change users via API.", section: "api" },
    groups: { id: "api.groups", label: "Groups API", description: "Group management API.", section: "api" },
    templates: { id: "api.templates", label: "Templates API", description: "Templates API.", section: "api" },
    agencies_read: { id: "api.agencies_read", label: "Agencies (read API)", description: "GET /api/agencies* for dropdowns.", section: "api" },
    agencies_write: { id: "api.agencies_write", label: "Agencies (write API)", description: "Create/update agencies via API.", section: "api" },
    email: { id: "api.email", label: "Email API", description: "Send and preview email APIs.", section: "api" },
    setup: { id: "api.setup", label: "Setup my device API", description: "Enrollment and preference APIs.", section: "api" },
    user_requests: { id: "api.user_requests", label: "User requests API", description: "Access request listing and management.", section: "api" },
    tak: { id: "api.tak", label: "TAK metrics API", description: "TAK / metrics endpoints.", section: "api" },
    documents: { id: "api.documents", label: "Documents API", description: "Document CRUD and workflows.", section: "api" },
    plugin_download: { id: "api.plugin_download", label: "Plugin file download", description: "GET /api/plugins/:id/download.", section: "api" },
    plugins_admin: { id: "api.plugins_admin", label: "Plugin manager API", description: "Plugin list/upload/delete (admin).", section: "api" },
    audit_log: { id: "api.audit_log", label: "Audit log API", description: "Query audit events.", section: "api" },
    integrations: { id: "api.integrations", label: "Integrations API", description: "Integration config API.", section: "api" },
    ssh: { id: "api.ssh", label: "SSH API", description: "SSH key integration API.", section: "api" },
    qr: { id: "api.qr", label: "QR API", description: "High-res QR download and helpers.", section: "api" },
    mutual_aid: { id: "api.mutual_aid", label: "Mutual aid API", description: "Mutual aid API routes.", section: "api" },
    locate: { id: "api.locate", label: "Locate admin API", description: "Admin locate API.", section: "api" },
    data_sync: { id: "api.data_sync", label: "Data sync API", description: "Data sync API (strict global + beta).", section: "api" },
    data_packages: { id: "api.data_packages", label: "Data packages API", description: "Data package API.", section: "api" },
  },
  misc: {
    import_samples: {
      id: "misc.import_samples",
      label: "CSV / sample files",
      description: "Download sample CSV and readme for imports.",
      section: "administration",
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

/** Global admin: all capabilities. */
const GLOBAL_DEFAULT = new Set(ALL_PERMISSION_IDS);

/**
 * Agency admin: same prefix allowlist as legacy portalAuth (pages + API reads/writes
 * that were on the list). Excludes global-only app surfaces and agency write to agencies.
 */
const AGENCY_DEFAULT = new Set([
  "page.dashboard",
  "page.users",
  "page.groups",
  "page.templates",
  "page.email",
  "page.plugins",
  "page.setup_device",
  "page.pending_requests",
  "page.documents",
  "misc.import_samples",
  "api.users",
  "api.groups",
  "api.templates",
  "api.agencies_read",
  "api.email",
  "api.setup",
  "api.user_requests",
  "api.tak",
  "api.documents",
  "api.plugin_download",
]);

/**
 * Standard authenticated (non-admin): setup + plugins + plugin file download + QR
 * (matches legacy “normal user” allowlist; plugin download is separate route).
 */
const STANDARD_DEFAULT = new Set([
  "page.setup_device",
  "page.plugins",
  "api.setup",
  "api.plugin_download",
  "api.qr",
]);

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

  // Legacy portalAuth PUBLIC_PATHS: any authenticated user was allowed (allowlist was skipped).
  if (p === "/" || p === "/dashboard" || p.startsWith("/dashboard/")) return [];
  if (p === "/setup-my-device" || p.startsWith("/setup-my-device/")) return [];
  if (p === "/api/qr/download" && m === "GET") return [];
  if (p === "/styles.css" || p === "/favicon.ico") return [];

  // — Most specific first —
  if (p.startsWith("/api/audit-log")) return ["api.audit_log"];
  if (p.startsWith("/api/plugins/") && p.endsWith("/download") && m === "GET")
    return ["api.plugin_download"];
  if (p.startsWith("/api/plugins")) return ["api.plugins_admin"];
  if (p.startsWith("/api/integrations")) return ["api.integrations"];
  if (p.startsWith("/api/ssh")) return ["api.ssh"];
  if (p.startsWith("/api/locate")) return ["api.locate"];
  if (p.startsWith("/api/data-sync")) return ["api.data_sync"];
  if (p.startsWith("/api/data-packages")) return ["api.data_packages"];

  if (p === "/api/agencies" || p.startsWith("/api/agencies/")) {
    if (m === "GET" || m === "HEAD") return ["api.agencies_read"];
    return ["api.agencies_write"];
  }

  if (p.startsWith("/api/users")) return ["api.users"];
  if (p.startsWith("/api/groups")) return ["api.groups"];
  if (p.startsWith("/api/templates")) return ["api.templates"];
  if (p.startsWith("/api/qr")) return ["api.qr"];
  if (p.startsWith("/api/setup-my-device")) return ["api.setup"];
  if (p.startsWith("/api/mutual-aid")) return ["api.mutual_aid"];
  if (p.startsWith("/api/tak")) return ["api.tak"];
  if (p.startsWith("/api/user-requests")) return ["api.user_requests"];
  if (p.startsWith("/api/documents")) return ["api.documents"];
  if (p.startsWith("/api/email")) return ["api.email"];

  // Pages
  if (p === "/dashboard" || p.startsWith("/dashboard/")) return ["page.dashboard"];
  if (p === "/access-control" || p.startsWith("/access-control/")) return ["page.access_control"];
  if (p === "/api/access-control" || p.startsWith("/api/access-control/")) return ["page.access_control"];
  if (p.startsWith("/users")) return ["page.users"];
  if (p.startsWith("/groups")) return ["page.groups"];
  if (p.startsWith("/templates")) return ["page.templates"];
  if (p === "/email" || p.startsWith("/email/")) return ["page.email"];
  if (p === "/plugins" || p.startsWith("/plugins/")) return ["page.plugins"];
  if (p === "/setup-my-device" || p.startsWith("/setup-my-device/")) return ["page.setup_device"];
  if (p === "/pending-user-requests" || p.startsWith("/pending-user-requests/")) return ["page.pending_requests"];
  if (p === "/documents" || p.startsWith("/documents/")) return ["page.documents"];
  if (p === "/agencies" || p.startsWith("/agencies/")) return ["page.agencies"];
  if (p === "/settings" || p.startsWith("/settings/")) return ["page.settings"];
  if (p === "/integrations" || p.startsWith("/integrations/")) return ["page.integrations"];
  if (p === "/audit-log" || p.startsWith("/audit-log/")) return ["page.audit_log"];
  if (p === "/mutual-aid" || p.startsWith("/mutual-aid/")) return ["page.mutual_aid"];
  // Admin locate console is exactly /locate (public share /locate/:slug bypasses portalAuth in server.js)
  if (p === "/locate") return ["page.locate"];
  if (p === "/data-sync" || p.startsWith("/data-sync/")) return ["page.data_sync"];
  if (p === "/data-package" || p === "/data-packages" || p.startsWith("/data-package/")) return ["page.data_package"];
  if (p === "/getting-started" || p.startsWith("/getting-started/")) return ["page.getting_started"];
  if (p === "/plugin-manager" || p.startsWith("/plugin-manager/")) return ["page.plugin_manager"];
  if (p === "/sample-users.csv" || p === "/sample-agencies.csv" || p === "/csv-instructions-readme.txt")
    return ["misc.import_samples"];

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
