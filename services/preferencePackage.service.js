/**
 * Build preference data packages (config.pref + manifest) for remote delivery.
 * ATAK-CIV: MANIFEST/manifest.xml + certs/config.pref.
 * iTAK: server.pref at ZIP root + manifest.xml (ephemeral auto-import).
 */
const crypto = require("crypto");
const archiver = require("archiver");

const PREFERENCE_PACKAGE_FORMAT = {
  ATAK: "atak",
  ITAK: "itak",
};

const ALLOWED_TEAM_COLORS = [
  "Blue",
  "Dark Blue",
  "Brown",
  "Cyan",
  "Green",
  "Dark Green",
  "Magenta",
  "Maroon",
  "Orange",
  "Purple",
  "Red",
  "Teal",
  "White",
  "Yellow",
];

const ALLOWED_ATAK_ROLES = [
  "Team Member",
  "Team Lead",
  "HQ",
  "Sniper",
  "Medic",
  "Forward Observer",
  "RTO",
  "K9",
];

const TEAM_DEPLOYMENT_SETTING_KEYS = {
  Blue: "DP_COLOR_BLUE",
  "Dark Blue": "DP_COLOR_DARK_BLUE",
  Brown: "DP_COLOR_BROWN",
  Cyan: "DP_COLOR_CYAN",
  Green: "DP_COLOR_GREEN",
  "Dark Green": "DP_COLOR_DARK_GREEN",
  Magenta: "DP_COLOR_MAGENTA",
  Maroon: "DP_COLOR_MAROON",
  Orange: "DP_COLOR_ORANGE",
  Purple: "DP_COLOR_PURPLE",
  Red: "DP_COLOR_RED",
  Teal: "DP_COLOR_TEAL",
  White: "DP_COLOR_WHITE",
  Yellow: "DP_COLOR_YELLOW",
};

const ROLE_DEPLOYMENT_SETTING_KEYS = {
  "Team Member": "DP_ROLE_TEAM_MEMBER",
  "Team Lead": "DP_ROLE_TEAM_LEAD",
  HQ: "DP_ROLE_HQ",
  Sniper: "DP_ROLE_SNIPER",
  Medic: "DP_ROLE_MEDIC",
  "Forward Observer": "DP_ROLE_FORWARD_OBSERVER",
  RTO: "DP_ROLE_RTO",
  K9: "DP_ROLE_K9",
};

const CIV_IDENTITY_KEYS = new Set([
  "locationCallsign",
  "locationTeam",
  "atakRoleType",
  "locationUnitType",
  "userRemarks",
]);

const JAVA_CLASS = {
  string: "class java.lang.String",
  boolean: "class java.lang.Boolean",
  int: "class java.lang.Integer",
  long: "class java.lang.Long",
};

function safeStr(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function escapeXml(value) {
  return safeStr(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeTeamLabel(raw) {
  const s = safeStr(raw).trim();
  if (!s) return "";
  const match = ALLOWED_TEAM_COLORS.find((c) => c.toLowerCase() === s.toLowerCase());
  return match || "";
}

function normalizeRoleLabel(raw) {
  const s = safeStr(raw).trim();
  if (!s) return "Team Member";
  const match = ALLOWED_ATAK_ROLES.find((r) => r.toLowerCase() === s.toLowerCase());
  return match || "";
}

function deploymentPacketDefinition(settings, key) {
  if (!key) return "";
  return safeStr(settings?.[key]).trim();
}

function buildDeploymentOptionLabel(name, settings, keyMap) {
  const definition = deploymentPacketDefinition(settings, keyMap[name]);
  return definition ? `${name} — ${definition}` : name;
}

function buildTeamSelectOptions(settings = {}) {
  return ALLOWED_TEAM_COLORS.map((name) => ({
    value: name,
    label: buildDeploymentOptionLabel(name, settings, TEAM_DEPLOYMENT_SETTING_KEYS),
  }));
}

function buildRoleSelectOptions(settings = {}) {
  return ALLOWED_ATAK_ROLES.map((name) => ({
    value: name,
    label: buildDeploymentOptionLabel(name, settings, ROLE_DEPLOYMENT_SETTING_KEYS),
  }));
}

function sanitizeFilenamePart(value) {
  return safeStr(value)
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function resolvePreferencePackageFormat(takClient, platform) {
  const client = safeStr(takClient).trim().toUpperCase();
  const plat = safeStr(platform).trim().toUpperCase();
  if (client.includes("ITAK") || plat.includes("ITAK")) return PREFERENCE_PACKAGE_FORMAT.ITAK;
  return PREFERENCE_PACKAGE_FORMAT.ATAK;
}

function getPreferencePackageLayout(format = PREFERENCE_PACKAGE_FORMAT.ATAK) {
  if (format === PREFERENCE_PACKAGE_FORMAT.ITAK) {
    // iTAK enrollment/mission packages use flat root layout with server.pref
    // (see Cloud-RF/tak-server certDP.sh and qrtak iTAK builder).
    return {
      manifestPaths: ["manifest.xml"],
      prefPath: "server.pref",
      prefZipEntry: "server.pref",
      includeOnReceiveImport: true,
      onReceiveDelete: true,
      includeContentName: false,
    };
  }
  return {
    manifestPaths: ["MANIFEST/manifest.xml"],
    prefPath: "certs/config.pref",
    prefZipEntry: "certs/config.pref",
    includeOnReceiveImport: true,
    onReceiveDelete: false,
    includeContentName: true,
  };
}
function buildPreferencePackageFilename({ callsign, teamLabel, roleLabel }) {
  const parts = ["Pref", sanitizeFilenamePart(callsign)];
  const team = sanitizeFilenamePart(teamLabel);
  const role = sanitizeFilenamePart(roleLabel);
  if (team) parts.push(team);
  if (role) parts.push(role);
  return `${parts.filter(Boolean).join("-") || "Pref-config"}.zip`;
}

function entryXml(key, value) {
  return `    <entry key="${escapeXml(key)}" class="${JAVA_CLASS.string}">${escapeXml(value)}</entry>`;
}

function buildConfigPrefXml(entries, format = PREFERENCE_PACKAGE_FORMAT.ATAK) {
  const civ = entries.filter((e) => CIV_IDENTITY_KEYS.has(e.key));
  const other = entries.filter((e) => !CIV_IDENTITY_KEYS.has(e.key));
  const blocks = [];

  if (civ.length) {
    blocks.push(
      `  <preference version="1" name="com.atakmap.app_civ_preferences">\n${civ.map((e) => entryXml(e.key, e.value)).join("\n")}\n  </preference>`
    );
    blocks.push(
      `  <preference version="1" name="com.atakmap.app_preferences">\n${civ.map((e) => entryXml(e.key, e.value)).join("\n")}\n  </preference>`
    );
  }
  if (other.length) {
    blocks.push(
      `  <preference version="1" name="com.atakmap.app_preferences">\n${other.map((e) => entryXml(e.key, e.value)).join("\n")}\n  </preference>`
    );
  }

  if (!blocks.length) {
    return `<?xml version='1.0' encoding='ASCII' standalone='yes'?>\n<preferences>\n</preferences>\n`;
  }

  return `<?xml version='1.0' encoding='ASCII' standalone='yes'?>\n<preferences>\n${blocks.join("\n")}\n</preferences>\n`;
}

function buildManifestXml({
  packageName,
  uid,
  format = PREFERENCE_PACKAGE_FORMAT.ATAK,
  includeOnReceiveImport,
  onReceiveDelete,
}) {
  const layout = getPreferencePackageLayout(format);
  const { prefZipEntry } = layout;
  const shouldImport =
    includeOnReceiveImport != null ? includeOnReceiveImport : layout.includeOnReceiveImport;
  const shouldDelete = onReceiveDelete != null ? onReceiveDelete : layout.onReceiveDelete;
  const name = escapeXml(packageName);
  const id = escapeXml(uid || crypto.randomUUID());
  const importParam = shouldImport
    ? `    <Parameter name="onReceiveImport" value="true"/>\n`
    : "";
  const contentInner = layout.includeContentName
    ? `\n      <Parameter name="name" value="Preference Configuration"/>\n    `
    : "";
  return `<MissionPackageManifest version="2">
  <Configuration>
    <Parameter name="uid" value="${id}"/>
    <Parameter name="name" value="${name}"/>
${importParam}    <Parameter name="onReceiveDelete" value="${shouldDelete ? "true" : "false"}"/>
  </Configuration>
  <Contents>
    <Content ignore="false" zipEntry="${prefZipEntry}">${contentInner}</Content>
  </Contents>
</MissionPackageManifest>
`;
}

function validatePreferenceInputs({ callsign, teamLabel, roleLabel }) {
  const c = safeStr(callsign).trim();
  if (!c) {
    const err = new Error("Callsign is required.");
    err.status = 400;
    throw err;
  }

  const teamRaw = safeStr(teamLabel).trim();
  const team = normalizeTeamLabel(teamRaw);
  if (teamRaw && !team) {
    const err = new Error(`Invalid team color. Expected one of: ${ALLOWED_TEAM_COLORS.join(", ")}`);
    err.status = 400;
    throw err;
  }

  const roleRaw = safeStr(roleLabel).trim();
  const role = normalizeRoleLabel(roleRaw || "Team Member");
  if (roleRaw && !ALLOWED_ATAK_ROLES.some((r) => r.toLowerCase() === roleRaw.toLowerCase())) {
    const err = new Error(`Invalid role. Expected one of: ${ALLOWED_ATAK_ROLES.join(", ")}`);
    err.status = 400;
    throw err;
  }

  return { callsign: c, teamLabel: team, roleLabel: role };
}

function buildPreferenceEntries({ callsign, teamLabel, roleLabel }) {
  const entries = [{ key: "locationCallsign", value: callsign }];
  if (teamLabel) entries.push({ key: "locationTeam", value: teamLabel });
  if (roleLabel) entries.push({ key: "atakRoleType", value: roleLabel });
  return entries;
}

async function buildPreferencePackageZip({ callsign, teamLabel, roleLabel, format }) {
  const resolvedFormat = format || PREFERENCE_PACKAGE_FORMAT.ATAK;
  const normalized = validatePreferenceInputs({ callsign, teamLabel, roleLabel });
  const packageName = buildPreferencePackageFilename(normalized);
  const entries = buildPreferenceEntries(normalized);
  const prefXml = buildConfigPrefXml(entries, resolvedFormat);
  const layout = getPreferencePackageLayout(resolvedFormat);
  const manifestXml = buildManifestXml({
    packageName,
    uid: crypto.randomUUID(),
    format: resolvedFormat,
  });

  return new Promise((resolve, reject) => {
    const chunks = [];
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("data", (chunk) => chunks.push(chunk));
    archive.on("error", reject);
    archive.on("end", () => {
      const buffer = Buffer.concat(chunks);
      resolve({
        buffer,
        hash: crypto.createHash("sha256").update(buffer).digest("hex"),
        packageName,
        packageFormat: resolvedFormat,
        ...normalized,
      });
    });
    for (const manifestPath of layout.manifestPaths) {
      archive.append(manifestXml, { name: manifestPath });
    }
    archive.append(prefXml, { name: layout.prefPath });
    archive.finalize();
  });
}

module.exports = {
  ALLOWED_TEAM_COLORS,
  ALLOWED_ATAK_ROLES,
  PREFERENCE_PACKAGE_FORMAT,
  buildTeamSelectOptions,
  buildRoleSelectOptions,
  buildPreferencePackageZip,
  buildPreferencePackageFilename,
  buildConfigPrefXml,
  buildManifestXml,
  validatePreferenceInputs,
  normalizeTeamLabel,
  normalizeRoleLabel,
  resolvePreferencePackageFormat,
  getPreferencePackageLayout,
};
