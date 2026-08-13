/**
 * Build WinTAK / ATAK auto-enrollment data packages
 * (config.pref + TAK truststore p12 + MANIFEST).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const archiver = require("archiver");

const settingsSvc = require("./settings.service");
const takSshSvc = require("./takSsh.service");
const qrSvc = require("./qr.service");
const prefPkg = require("./preferencePackage.service");

const TRUSTSTORE_CACHE_DIR = path.join(__dirname, "..", "data", "enrollment-truststore");
const TRUSTSTORE_CACHE_P12 = path.join(TRUSTSTORE_CACHE_DIR, "caCert.p12");
const TRUSTSTORE_CACHE_META = path.join(TRUSTSTORE_CACHE_DIR, "meta.json");
const TRUSTSTORE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const JAVA_CLASS = {
  string: "class java.lang.String",
  boolean: "class java.lang.Boolean",
  int: "class java.lang.Integer",
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

function sanitizeFilenamePart(value) {
  return safeStr(value)
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function isSshConfigured() {
  return !!takSshSvc.getTakSshConfig();
}

function isPrivilegedSshReady(settings) {
  return !!takSshSvc.isPrivilegedSshReady(settings);
}

function isDataPackageEnabled(settings) {
  const cfg = settings || settingsSvc.getSettings() || {};
  return String(cfg.ALLOWED_CLIENT_DATA_PACKAGE || "").trim().toLowerCase() === "true";
}

function isDataPackageAvailable(settings) {
  return isPrivilegedSshReady(settings) && isDataPackageEnabled(settings);
}

function typedEntry(key, javaClass, value) {
  return `    <entry key="${escapeXml(key)}" class="${javaClass}">${escapeXml(value)}</entry>`;
}

function buildEnrollmentPackageFilename({ callsign, username }) {
  const base =
    sanitizeFilenamePart(callsign) ||
    sanitizeFilenamePart(username) ||
    "TAK";
  return `${base}-TAK-DataPackage.zip`;
}

function buildEnrollmentConfigPrefXml({
  host,
  description,
  caPassword,
  username,
  password,
  callsign,
  teamLabel,
  roleLabel,
}) {
  const h = safeStr(host).trim();
  const desc = safeStr(description).trim() || "TAK Server";
  const pass = safeStr(caPassword);
  const user = safeStr(username).trim();
  const authPassword = safeStr(password);
  const connectString = `${h}:8089:ssl`;

  const streamEntries = [
    typedEntry("count", JAVA_CLASS.int, "1"),
    typedEntry("description0", JAVA_CLASS.string, desc),
    typedEntry("enabled0", JAVA_CLASS.boolean, "true"),
    typedEntry("connectString0", JAVA_CLASS.string, connectString),
    typedEntry("caLocation0", JAVA_CLASS.string, "cert/caCert.p12"),
    typedEntry("caPassword0", JAVA_CLASS.string, pass),
  ];
  if (user) {
    streamEntries.push(typedEntry("username0", JAVA_CLASS.string, user));
  }
  if (authPassword) {
    streamEntries.push(typedEntry("password0", JAVA_CLASS.string, authPassword));
  }
  streamEntries.push(
    typedEntry("enrollForCertificateWithTrust0", JAVA_CLASS.boolean, "true"),
    typedEntry("useAuth0", JAVA_CLASS.boolean, "true"),
    typedEntry("cacheCreds0", JAVA_CLASS.string, "Cache credentials")
  );

  const identityEntries = [
    typedEntry("displayServerConnectionWidget", JAVA_CLASS.boolean, "true"),
  ];
  if (safeStr(callsign).trim()) {
    identityEntries.push(typedEntry("locationCallsign", JAVA_CLASS.string, safeStr(callsign).trim()));
  }
  if (safeStr(teamLabel).trim()) {
    identityEntries.push(typedEntry("locationTeam", JAVA_CLASS.string, safeStr(teamLabel).trim()));
  }
  if (safeStr(roleLabel).trim()) {
    identityEntries.push(typedEntry("atakRoleType", JAVA_CLASS.string, safeStr(roleLabel).trim()));
  }

  const civEntries = identityEntries.filter((line) =>
    /key="(locationCallsign|locationTeam|atakRoleType)"/.test(line)
  );

  const blocks = [
    `  <preference version="1" name="cot_streams">\n${streamEntries.join("\n")}\n  </preference>`,
    `  <preference version="1" name="com.atakmap.app_preferences">\n${identityEntries.join("\n")}\n  </preference>`,
  ];
  if (civEntries.length) {
    blocks.push(
      `  <preference version="1" name="com.atakmap.app_civ_preferences">\n${civEntries.join("\n")}\n  </preference>`
    );
  }

  return `<?xml version='1.0' encoding='ASCII' standalone='yes'?>\n<preferences>\n${blocks.join("\n")}\n</preferences>\n`;
}

function buildEnrollmentManifestXml({ packageName, uid }) {
  const name = escapeXml(packageName);
  const id = escapeXml(uid || crypto.randomUUID());
  return `<MissionPackageManifest version="2">
  <Configuration>
    <Parameter name="uid" value="${id}"/>
    <Parameter name="name" value="${name}"/>
    <Parameter name="onReceiveDelete" value="true"/>
  </Configuration>
  <Contents>
    <Content ignore="false" zipEntry="certs/config.pref"/>
    <Content ignore="false" zipEntry="certs/caCert.p12"/>
  </Contents>
</MissionPackageManifest>
`;
}

function readCachedTruststore() {
  try {
    if (!fs.existsSync(TRUSTSTORE_CACHE_P12) || !fs.existsSync(TRUSTSTORE_CACHE_META)) {
      return null;
    }
    const meta = JSON.parse(fs.readFileSync(TRUSTSTORE_CACHE_META, "utf8"));
    const fetchedAt = Number(meta && meta.fetchedAt) || 0;
    if (!fetchedAt || Date.now() - fetchedAt > TRUSTSTORE_CACHE_TTL_MS) {
      return null;
    }
    const p12 = fs.readFileSync(TRUSTSTORE_CACHE_P12);
    if (!p12 || !p12.length) return null;
    return {
      p12,
      password: String((meta && meta.password) || "atakatak"),
      sourcePath: String((meta && meta.sourcePath) || ""),
      fromCache: true,
    };
  } catch (_) {
    return null;
  }
}

function writeCachedTruststore({ p12, password, sourcePath }) {
  fs.mkdirSync(TRUSTSTORE_CACHE_DIR, { recursive: true });
  fs.writeFileSync(TRUSTSTORE_CACHE_P12, p12, { mode: 0o600 });
  fs.writeFileSync(
    TRUSTSTORE_CACHE_META,
    JSON.stringify(
      {
        password: String(password || "atakatak"),
        sourcePath: String(sourcePath || ""),
        fetchedAt: Date.now(),
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
}

async function getTakTruststore({ forceRefresh } = {}) {
  if (!forceRefresh) {
    const cached = readCachedTruststore();
    if (cached) return cached;
  }
  const remote = await takSshSvc.fetchTakTruststoreP12FromRemote();
  writeCachedTruststore(remote);
  return { ...remote, fromCache: false };
}

async function zipEnrollmentPackage({ prefXml, manifestXml, caP12 }) {
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
      });
    });
    archive.append(manifestXml, { name: "MANIFEST/manifest.xml" });
    archive.append(prefXml, { name: "certs/config.pref" });
    archive.append(caP12, { name: "certs/caCert.p12" });
    archive.finalize();
  });
}

async function buildEnrollmentPackageZip({
  username,
  password,
  callsign,
  teamLabel,
  roleLabel,
  caP12,
  caPassword,
  host,
  description,
} = {}) {
  const settings = settingsSvc.getSettings() || {};
  const takHost = safeStr(host).trim() || qrSvc.getTakHost();
  if (!takHost) {
    const err = new Error(
      "TAK_URL is not configured. Set it in Settings (TAK URL) or via the TAK_URL environment variable."
    );
    err.status = 500;
    throw err;
  }

  let trust = null;
  if (caP12 && Buffer.isBuffer(caP12) && caP12.length) {
    trust = { p12: caP12, password: safeStr(caPassword) || "atakatak" };
  } else {
    trust = await getTakTruststore();
  }

  const identity = (() => {
    const callsignFallback =
      safeStr(callsign).trim() || safeStr(username).trim() || "TAK";
    try {
      return prefPkg.validatePreferenceInputs({
        callsign: callsignFallback,
        teamLabel,
        roleLabel: safeStr(roleLabel).trim() || "Team Member",
      });
    } catch (_) {
      // Don't fail package build on agency color / role mismatches.
      try {
        return prefPkg.validatePreferenceInputs({
          callsign: callsignFallback,
          teamLabel: "",
          roleLabel: "Team Member",
        });
      } catch {
        return {
          callsign: callsignFallback,
          teamLabel: "",
          roleLabel: "Team Member",
        };
      }
    }
  })();

  const serverName = safeStr(description).trim() || safeStr(settings.SERVER_NAME).trim() || "TAK Server";
  const packageName = buildEnrollmentPackageFilename({
    callsign: identity.callsign,
    username,
  });
  const prefXml = buildEnrollmentConfigPrefXml({
    host: takHost,
    description: serverName,
    caPassword: trust.password,
    username: safeStr(username).trim(),
    password: safeStr(password),
    callsign: identity.callsign,
    teamLabel: identity.teamLabel,
    roleLabel: identity.roleLabel,
  });
  const manifestXml = buildEnrollmentManifestXml({
    packageName,
    uid: crypto.randomUUID(),
  });
  const zipped = await zipEnrollmentPackage({
    prefXml,
    manifestXml,
    caP12: trust.p12,
  });

  return {
    ...zipped,
    packageName,
    ...identity,
  };
}

module.exports = {
  isSshConfigured,
  isPrivilegedSshReady,
  isDataPackageEnabled,
  isDataPackageAvailable,
  buildEnrollmentPackageFilename,
  buildEnrollmentConfigPrefXml,
  buildEnrollmentManifestXml,
  buildEnrollmentPackageZip,
  getTakTruststore,
};
