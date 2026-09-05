"use strict";

const MANIFEST_VERSION = 1;

const SECRET_SETTINGS_KEYS = [
  "AUTHENTIK_TOKEN",
  "TAK_API_P12_PASSPHRASE",
  "TAK_SSH_PASSPHRASE",
  "TAK_SSH_SUDO_PASSWORD",
  "SMTP_PASS",
  "SMS_TWILIO_AUTH_TOKEN",
  "SMS_TWILIO_ACCOUNT_SID",
  "SMS_BREVO_API_KEY",
  "HCAPTCHA_SECRET_KEY",
  "MUTUAL_AID_ENCRYPTION_KEY",
  "OPENADDRESSES_TOKEN",
];

const SETTINGS_SUBCATEGORIES = [
  {
    id: "settings.authentik",
    label: "Authentik connection",
    description: "Authentik URL, token, portal auth groups, and hidden prefixes.",
    requiresSecrets: false,
    keys: [
      "AUTHENTIK_URL",
      "AUTHENTIK_TOKEN",
      "AUTHENTIK_PUBLIC_URL",
      "USERS_HIDDEN_PREFIXES",
      "GROUPS_HIDDEN_PREFIXES",
      "USERS_ACTIONS_HIDDEN_PREFIXES",
      "GROUPS_ACTIONS_HIDDEN_PREFIXES",
      "DASHBOARD_AUTHENTIK_STATS_REFRESH_SECONDS",
      "PORTAL_AUTH_ENABLED",
      "PORTAL_AUTH_REQUIRED_GROUP",
      "AUTHENTIK_USER_PATH",
      "AUTHENTIK_USER_PAGE_SIZE",
    ],
  },
  {
    id: "settings.tak_api",
    label: "TAK Server API",
    description: "Marti URL, client P12/CA, revoke and debug flags.",
    requiresSecrets: false,
    keys: [
      "TAK_URL",
      "TAK_API_P12_PATH",
      "TAK_API_P12_PASSPHRASE",
      "TAK_CA_PATH",
      "TAK_REVOKE_ON_DISABLE",
      "TAK_DEBUG",
      "TAK_BYPASS_ENABLED",
      "DASHBOARD_TAK_STATS_REFRESH_SECONDS",
      "TAK_PLUGIN_UPDATE_REMOTE_DIR",
    ],
    files: ["certs"],
  },
  {
    id: "settings.tak_ssh",
    label: "TAK SSH",
    description: "SSH host, user, keys, and sudo settings for the TAK host.",
    requiresSecrets: false,
    keys: [
      "TAK_SSH_HOST",
      "TAK_SSH_PORT",
      "TAK_SSH_USER",
      "TAK_SSH_PRIVATE_KEY_PATH",
      "TAK_SSH_PUBLIC_KEY_PATH",
      "TAK_SSH_PASSPHRASE",
      "TAK_SSH_ONBOARDED",
      "TAK_SSH_LAST_HANDSHAKE_AT",
      "TAK_SSH_PRIVILEGE_CMD",
      "TAK_SSH_SUDOERS_CONFIGURED",
      "TAK_SSH_SUDO_PASSWORD",
    ],
    files: ["ssh"],
  },
  {
    id: "settings.email",
    label: "Email / SMTP",
    description: "SMTP provider, credentials, and from-address settings.",
    requiresSecrets: false,
    keys: [
      "EMAIL_ENABLED",
      "EMAIL_GROUP_CHANGES_ENABLED",
      "EMAIL_PROVIDER",
      "SMTP_HOST",
      "SMTP_PORT",
      "SMTP_SECURE",
      "SMTP_USER",
      "SMTP_PASS",
      "SMTP_FROM",
      "EMAIL_ALWAYS_CC",
      "EMAIL_SEND_COPY_TO",
      "EMAIL_FAIL_HARD",
    ],
  },
  {
    id: "settings.sms",
    label: "SMS",
    description: "Twilio / Brevo SMS provider settings.",
    requiresSecrets: false,
    keys: [
      "SMS_PROVIDER",
      "SMS_TWILIO_ACCOUNT_SID",
      "SMS_TWILIO_AUTH_TOKEN",
      "SMS_TWILIO_FROM",
      "SMS_BREVO_API_KEY",
      "SMS_BREVO_SENDER",
      "SMS_TEST_TO",
    ],
  },
  {
    id: "settings.captcha",
    label: "Captcha",
    description: "hCaptcha site and secret keys.",
    requiresSecrets: false,
    keys: ["HCAPTCHA_SITE_KEY", "HCAPTCHA_SECRET_KEY"],
  },
  {
    id: "settings.crypto",
    label: "Crypto keys",
    description: "Mutual-aid encryption key. Required to restore encrypted MA passwords.",
    requiresSecrets: true,
    keys: ["MUTUAL_AID_ENCRYPTION_KEY"],
  },
  {
    id: "settings.feature_flags",
    label: "Feature flags & clients",
    description: "MOU, request access, auto-create, allowed clients, live map, CloudTAK.",
    requiresSecrets: false,
    keys: [
      "MOU_ENABLED",
      "MOU_SEND_EMAILS",
      "MOU_DEFAULT_REMINDER_DAYS",
      "MOU_HTML_MAX_KB",
      "MOU_DEPLOY_REQUIRES_TYPED_CONFIRM",
      "MOU_REMINDER_SWEEP_HOURS",
      "REQUEST_ACCESS_ENABLED",
      "REQUEST_ACCESS_REQUIRE_ALL_AGENCY_DETAILS",
      "AUTO_CREATE_AGENCY_GROUPS_ENABLED",
      "AUTO_CREATE_COUNTY_GROUPS_ENABLED",
      "AUTO_CREATE_STATE_GROUPS_ENABLED",
      "AUTO_CREATE_REGION_GROUPS_ENABLED",
      "AUTO_CREATE_AGENCY_GROUP_TITLE_1",
      "AUTO_CREATE_AGENCY_GROUP_TITLE_2",
      "AUTO_CREATE_AGENCY_GROUP_TITLE_3",
      "AUTO_CREATE_COUNTY_GROUP_TITLE_1",
      "AUTO_CREATE_COUNTY_GROUP_TITLE_2",
      "AUTO_CREATE_COUNTY_GROUP_TITLE_3",
      "AUTO_CREATE_STATE_GROUP_TITLE_1",
      "AUTO_CREATE_STATE_GROUP_TITLE_2",
      "AUTO_CREATE_STATE_GROUP_TITLE_3",
      "AUTO_CREATE_AGENCY_DATA_SYNC_ENABLED",
      "AUTO_CREATE_COUNTY_DATA_SYNC_ENABLED",
      "AUTO_CREATE_STATE_DATA_SYNC_ENABLED",
      "AUTO_CREATE_AGENCY_DATA_SYNC_TITLE",
      "AUTO_CREATE_COUNTY_DATA_SYNC_TITLE",
      "AUTO_CREATE_STATE_DATA_SYNC_TITLE",
      "AUTO_CREATE_AGENCY_DATA_SYNC_GROUP_INDEX",
      "AUTO_CREATE_COUNTY_DATA_SYNC_GROUP_INDEX",
      "AUTO_CREATE_STATE_DATA_SYNC_GROUP_INDEX",
      "ALLOWED_CLIENT_TAK_AWARE",
      "ALLOWED_CLIENT_TAK_TRACKER",
      "ALLOWED_CLIENT_ATAK",
      "ALLOWED_CLIENT_LIVE_MAP",
      "ALLOWED_CLIENT_CLOUDTAK",
      "ALLOWED_CLIENT_DATA_PACKAGE",
      "ALLOWED_CLIENT_RECOMMENDED_IOS",
      "ALLOWED_CLIENT_RECOMMENDED_ANDROID",
      "ALLOWED_CLIENT_RECOMMENDED_WEB",
      "ALLOWED_CLIENT_RECOMMENDED_PC",
      "ALLOWED_CLIENT_ORDER_IOS",
      "ALLOWED_CLIENT_ORDER_ANDROID",
      "ALLOWED_CLIENT_ORDER_WEB",
      "ALLOWED_CLIENT_ORDER_PC",
      "ALLOWED_CLIENT_DEVICES_MIGRATION",
      "SHOW_ITAK_LINKS",
      "LIVE_MAP_ENABLED",
      "CLOUDTAK_URL",
      "BETA_MODE",
    ],
  },
  {
    id: "settings.openaddresses",
    label: "OpenAddresses token",
    description: "Geocoding token for live map address search.",
    requiresSecrets: true,
    keys: ["OPENADDRESSES_TOKEN"],
  },
  {
    id: "settings.public_urls",
    label: "Public URLs / server name",
    description: "Public portal URL and display name.",
    requiresSecrets: false,
    keys: ["SERVER_NAME", "TAK_PORTAL_PUBLIC_URL"],
  },
];

const SETTINGS_CHILD_IDS = SETTINGS_SUBCATEGORIES.map((s) => s.id);

const CATEGORIES = [
  {
    id: "regions",
    label: "Regions & county locks",
    group: "directory",
    groupLabel: "Directory & org",
    description: "Regions and which counties are locked to them.",
    deps: [],
    tables: ["regions", "region_county_locks"],
  },
  {
    id: "agencies",
    label: "Agencies",
    group: "directory",
    groupLabel: "Directory & org",
    description: "Agency records (suffix, type, county, admin groups).",
    deps: ["regions"],
    tables: ["agencies"],
  },
  {
    id: "templates",
    label: "Templates",
    group: "directory",
    groupLabel: "Directory & org",
    description: "Agency user templates and default group assignments.",
    deps: ["agencies"],
    tables: ["agency_templates"],
  },
  {
    id: "groups",
    label: "Groups",
    group: "directory",
    groupLabel: "Directory & org",
    description: "Authentik groups mirrored in the portal. Recreated on the destination Authentik.",
    deps: [],
    tables: ["groups"],
  },
  {
    id: "users",
    label: "Users",
    group: "directory",
    groupLabel: "Directory & org",
    description: "Portal users and group membership. Recreated in Authentik without passwords.",
    deps: ["groups", "agencies"],
    tables: ["users", "group_members"],
  },
  {
    id: "access_roles",
    label: "Access roles / permission overrides",
    group: "directory",
    groupLabel: "Directory & org",
    description: "Per-user allow/deny permission overrides.",
    deps: ["users"],
    tables: ["permission_overrides"],
  },
  {
    id: "user_requests",
    label: "Pending user access requests",
    group: "directory",
    groupLabel: "Directory & org",
    description: "Request-access queue (applicant PII).",
    deps: ["agencies"],
    tables: ["user_requests"],
  },
  {
    id: "integrations",
    label: "Integrations",
    group: "features",
    groupLabel: "Portal features",
    description: "Node-RED integration users and client certificates.",
    deps: ["groups"],
    files: ["integration-certs"],
    userPrefix: "nodered-",
  },
  {
    id: "mutual_aid",
    label: "Mutual Aids",
    group: "features",
    groupLabel: "Portal features",
    description: "Mutual-aid entries, logos, and linked users/groups. Encrypted passwords need the crypto key.",
    deps: ["groups"],
    tables: ["mutual_aid"],
    files: ["mutual-aid-logos"],
  },
  {
    id: "channel_patches",
    label: "Channel Patches",
    group: "features",
    groupLabel: "Portal features",
    description: "COT channel-patch rules.",
    deps: ["groups"],
    tables: ["channel_patches"],
  },
  {
    id: "geofences",
    label: "Geofences",
    group: "features",
    groupLabel: "Portal features",
    description: "Live-map geofence definitions (not live client membership).",
    deps: [],
    tables: ["geofences"],
  },
  {
    id: "locate",
    label: "Locate persons",
    group: "features",
    groupLabel: "Portal features",
    description: "Locate share links and locator configuration.",
    deps: [],
    tables: ["locators"],
  },
  {
    id: "locate_pings",
    label: "Locate ping history",
    group: "features",
    groupLabel: "Portal features",
    description: "Location trails for locate persons (sensitive PII).",
    deps: ["locate"],
    tables: ["locator_pings"],
  },
  {
    id: "mou",
    label: "MOU documents",
    group: "features",
    groupLabel: "Portal features",
    description: "MOU streams, acknowledgements, invites, and signed files.",
    deps: ["agencies"],
    tables: [
      "mou_streams",
      "mou_user_agreement",
      "mou_archived",
      "mou_acks",
      "mou_views",
      "mou_reminders",
      "mou_sign_invites",
    ],
    files: ["mou"],
  },
  {
    id: "plugins",
    label: "Plugins",
    group: "features",
    groupLabel: "Portal features",
    description: "Plugin APKs and catalog. TAK.gov token only when secrets are included.",
    deps: [],
    files: ["plugins", "plugin-manifest.json"],
  },
  {
    id: "auto_create_ledgers",
    label: "Auto-create groups / data-sync ledgers",
    group: "features",
    groupLabel: "Portal features",
    description: "Which county/agency groups and missions were already auto-created.",
    deps: [],
    tables: ["auto_create_groups", "auto_create_data_sync"],
  },
  {
    id: "email_templates",
    label: "Email template overrides",
    group: "features",
    groupLabel: "Portal features",
    description: "Custom HTML overrides stored in settings.",
    deps: [],
    settingsKeys: ["EMAIL_TEMPLATES_OVERRIDES"],
  },
  {
    id: "branding_assets",
    label: "Branding & portal assets",
    group: "features",
    groupLabel: "Portal features",
    description: "Logos, theme, bookmarks, ATAK APK, callsign format, agency types, packet colors/roles.",
    deps: [],
    files: ["branding", "atak"],
    settingsKeys: [
      "BRAND_LOGO_URL",
      "DEFAULT_THEME_MODE",
      "DEFAULT_MAP_SOURCE",
      "ATAK_APK_ORIGINAL_NAME",
      "CALLSIGN_FORMAT_EXPRESSION",
      "AGENCY_TYPES_CUSTOMIZED",
      ...Array.from({ length: 8 }, (_, i) => [`BOOKMARK${i + 1}_TITLE`, `BOOKMARK${i + 1}_URL`]).flat(),
      ...Array.from({ length: 30 }, (_, i) => `ADDITIONAL_AGENCY_TYPE_${i + 1}`),
      "DP_COLOR_BLUE",
      "DP_COLOR_DARK_BLUE",
      "DP_COLOR_BROWN",
      "DP_COLOR_CYAN",
      "DP_COLOR_GREEN",
      "DP_COLOR_DARK_GREEN",
      "DP_COLOR_MAGENTA",
      "DP_COLOR_MAROON",
      "DP_COLOR_ORANGE",
      "DP_COLOR_PURPLE",
      "DP_COLOR_RED",
      "DP_COLOR_TEAL",
      "DP_COLOR_WHITE",
      "DP_COLOR_YELLOW",
      "DP_ROLE_TEAM_MEMBER",
      "DP_ROLE_TEAM_LEAD",
      "DP_ROLE_HQ",
      "DP_ROLE_SNIPER",
      "DP_ROLE_MEDIC",
      "DP_ROLE_FORWARD_OBSERVER",
      "DP_ROLE_RTO",
      "DP_ROLE_K9",
    ],
  },
  {
    id: "audit_log",
    label: "Audit log",
    group: "features",
    groupLabel: "Portal features",
    description: "Operational history. Can be large.",
    deps: [],
    tables: ["audit_events"],
  },
  ...SETTINGS_SUBCATEGORIES.map((s) => ({
    ...s,
    group: "settings",
    groupLabel: "Server Settings",
    deps: [],
    parentId: "settings",
  })),
];

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

function isSettingsCategory(id) {
  return String(id || "").startsWith("settings.");
}

function getCategory(id) {
  return BY_ID.get(String(id || "")) || null;
}

function listCategories() {
  return CATEGORIES.slice();
}

function listCategoryIds() {
  return CATEGORIES.map((c) => c.id);
}

function publicCatalog() {
  const groups = [
    { id: "directory", label: "Directory & org" },
    { id: "features", label: "Portal features" },
    { id: "settings", label: "Server Settings" },
  ];
  return {
    manifestVersion: MANIFEST_VERSION,
    groups,
    categories: CATEGORIES.map((c) => ({
      id: c.id,
      label: c.label,
      group: c.group,
      groupLabel: c.groupLabel,
      description: c.description,
      deps: c.deps || [],
      requiresSecrets: !!c.requiresSecrets,
      parentId: c.parentId || null,
    })),
    settingsParent: {
      id: "settings",
      label: "Server Settings",
      children: SETTINGS_CHILD_IDS.slice(),
    },
    secretSettingsKeys: SECRET_SETTINGS_KEYS.slice(),
  };
}

function expandSettingsParent(ids) {
  const set = new Set((ids || []).map(String));
  if (set.has("settings")) {
    set.delete("settings");
    for (const id of SETTINGS_CHILD_IDS) set.add(id);
  }
  return set;
}

function unknownCategoryIds(ids) {
  const set = expandSettingsParent(ids);
  const unknown = [];
  for (const id of set) {
    if (!BY_ID.has(id)) unknown.push(id);
  }
  return unknown;
}

function requiredDeps(id, seen = new Set()) {
  const cat = BY_ID.get(id);
  if (!cat) return [];
  const out = [];
  for (const dep of cat.deps || []) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    out.push(dep, ...requiredDeps(dep, seen));
  }
  return out;
}

/**
 * Auto-add missing dependencies. Returns { selected, autoAdded }.
 * Does not re-add deps the caller explicitly removed if `explicit` is provided
 * as the originally checked set before unchecking — callers that want force
 * can omit `allowMissing`.
 */
function resolveDependencies(ids, opts = {}) {
  const allowMissing = !!opts.allowMissing;
  const selected = expandSettingsParent(ids);
  const autoAdded = [];
  if (allowMissing) {
    return { selected: [...selected], autoAdded };
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...selected]) {
      for (const dep of requiredDeps(id)) {
        if (!selected.has(dep)) {
          selected.add(dep);
          autoAdded.push(dep);
          changed = true;
        }
      }
    }
  }
  return { selected: [...selected], autoAdded };
}

function redactSettings(values, includeSecrets) {
  const out = { ...(values && typeof values === "object" ? values : {}) };
  if (includeSecrets) return out;
  for (const key of SECRET_SETTINGS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      out[key] = "";
    }
  }
  return out;
}

function pickSettingsKeys(allSettings, keys, includeSecrets) {
  const src = allSettings && typeof allSettings === "object" ? allSettings : {};
  const picked = {};
  for (const key of keys || []) {
    if (Object.prototype.hasOwnProperty.call(src, key)) {
      picked[key] = src[key];
    }
  }
  return redactSettings(picked, includeSecrets);
}

function settingsKeysForCategories(categoryIds) {
  const keys = new Set();
  for (const id of expandSettingsParent(categoryIds)) {
    const cat = BY_ID.get(id);
    if (!cat) continue;
    for (const k of cat.keys || []) keys.add(k);
    for (const k of cat.settingsKeys || []) keys.add(k);
  }
  return [...keys];
}

function fileGlobsForCategories(categoryIds, includeSecrets) {
  const dirs = [];
  const files = [];
  for (const id of expandSettingsParent(categoryIds)) {
    const cat = BY_ID.get(id);
    if (!cat) continue;
    if (cat.requiresSecrets && !includeSecrets) continue;
    for (const rel of cat.files || []) {
      if (String(rel).includes(".")) files.push(rel);
      else dirs.push(rel);
    }
  }
  return { dirs, files };
}

function naturalKey(categoryId, row) {
  const id = String(categoryId || "");
  const r = row || {};
  if (id === "users") return String(r.username || "").toLowerCase();
  if (id === "groups") return String(r.name || "").toLowerCase();
  if (id === "agencies") return String(r.suffix || "").toLowerCase();
  if (id === "templates") {
    return `${String(r.agency_suffix || "").toLowerCase()}::${String(r.name || "").toLowerCase()}`;
  }
  if (id === "regions") return String(r.id || r.name || "").toLowerCase();
  if (id === "locate") return String(r.slug || r.id || "").toLowerCase();
  if (id === "access_roles") return String(r.username || "").toLowerCase();
  if (id === "auto_create_ledgers") {
    return `${String(r.scope || "")}::${String(r.key || "")}`;
  }
  return String(r.id || r.pk || "");
}

function importOrder() {
  return [
    ...SETTINGS_CHILD_IDS,
    "email_templates",
    "branding_assets",
    "regions",
    "agencies",
    "templates",
    "auto_create_ledgers",
    "groups",
    "users",
    "access_roles",
    "integrations",
    "mutual_aid",
    "channel_patches",
    "geofences",
    "mou",
    "locate",
    "locate_pings",
    "user_requests",
    "plugins",
    "audit_log",
  ];
}

function orderedSelected(ids) {
  const set = expandSettingsParent(ids);
  return importOrder().filter((id) => set.has(id));
}

function credentialFileRel(rel) {
  const n = String(rel || "").replace(/\\/g, "/").toLowerCase();
  return (
    n.startsWith("certs/") ||
    n === "certs" ||
    n.startsWith("ssh/") ||
    n === "ssh" ||
    n.startsWith("integration-certs/") ||
    n === "integration-certs"
  );
}

module.exports = {
  MANIFEST_VERSION,
  SECRET_SETTINGS_KEYS,
  SETTINGS_SUBCATEGORIES,
  SETTINGS_CHILD_IDS,
  CATEGORIES,
  isSettingsCategory,
  getCategory,
  listCategories,
  listCategoryIds,
  publicCatalog,
  expandSettingsParent,
  unknownCategoryIds,
  requiredDeps,
  resolveDependencies,
  redactSettings,
  pickSettingsKeys,
  settingsKeysForCategories,
  fileGlobsForCategories,
  naturalKey,
  importOrder,
  orderedSelected,
  credentialFileRel,
};
