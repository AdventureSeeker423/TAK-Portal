/**
 * services/tak.service.js
 *
 * TAK certificate revoke helper (Marti certadmin API)
 *
 * Goals:
 * - Revoke ALL certificates ever issued by a given creatorDn (creatorDn == username)
 * - Use the generic "all certs" endpoint (includes active/revoked/expired/etc.)
 * - Absolutely verify revocation before returning success (to block Authentik deletion if not verified)
 * - Support legacy PKCS#12 (RC2-40-CBC) by parsing P12 via node-tak’s approach (p12-pem) and supplying PEM to Node TLS
 *
 * Env:
 *   TAK_URL                       e.g. https://tak.example.com:8443 or https://tak.example.com:8443/Marti
 *   TAK_DEBUG=true                (optional)
 *
 * Mutual TLS (choose ONE):
 *   TAK_API_P12_PATH              path to .p12/.pfx
 *   TAK_API_P12_PASSPHRASE        passphrase (may be empty string)
 *     OR
 *   TAK_API_CERT_PATH             PEM client cert
 *   TAK_API_KEY_PATH              PEM private key
 *   TAK_API_KEY_PASSPHRASE        (optional)
 *
 * Optional:
 *   TAK_CA_PATH                   PEM CA bundle
 *
 * Notes:
 * - For P12 parsing, install:
 *     npm install p12-pem
 * - Remove node-forge if previously used:
 *     npm uninstall node-forge
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const axios = require("axios");
const { getBool, getString } = require("./env");

// IMPORTANT: env.js reads from settingsStore first, then process.env.
// We need the same behavior here, but ALSO need to support empty string
// for TAK_API_P12_PASSPHRASE (because empty can be valid for PKCS#12).
const settingsStore = require("./settings.service");

function isTakConfigured() {
  return !!String(getString("TAK_URL", "")).trim();
}

function isTakBypassed() {
  // TAK_BYPASS_ENABLED=true will disable ALL outbound TAK calls.
  // Useful for local testing where you don't want to touch cert state.
  return getBool("TAK_BYPASS_ENABLED", false);
}

function toLowerTrim(v) {
  return String(v ?? "").trim().toLowerCase();
}

function resolvePathMaybe(p) {
  if (!p) return null;
  const raw = String(p).trim();
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

function getTakBaseUrl() {
  const raw = String(getString("TAK_URL", "")).trim();
  const u = new URL(raw);

  // Default Marti context if none provided
  const pn = (u.pathname || "").replace(/\/+$/, "");
  if (!pn) u.pathname = "/Marti";

  return u.toString().replace(/\/+$/, "");
}

function unwrapTakList(payload) {
  // TAK commonly returns { version, type, data, nodeId }
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && Array.isArray(payload.results)) return payload.results;
  return [];
}

/**
 * Return whether a key is explicitly present in the app's settings/env source.
 * - If a key exists and is set to "" (empty string), that should count as "present".
 */
function hasSettingOrEnvKey(name) {
  const fromSettings = settingsStore.get(name, undefined);
  if (fromSettings !== undefined) return true;
  return Object.prototype.hasOwnProperty.call(process.env, name);
}

/**
 * Get a string value allowing empty string.
 * - If key is not present at all, returns undefined.
 * - If present in settings/env, returns a string (possibly "").
 */
function getStringAllowEmpty(name) {
  const fromSettings = settingsStore.get(name, undefined);
  if (fromSettings !== undefined) return String(fromSettings ?? "");

  if (!Object.prototype.hasOwnProperty.call(process.env, name)) return undefined;
  return String(process.env[name] ?? "");
}

/**
 * @param {{
 *   allowInsecureServer?: boolean;
 *   baseURL?: string;
 *   timeout?: number;
 * }} [options] - allowInsecureServer: skip server cert verify (locate relay). baseURL/timeout: optional overrides (locate relay uses locate API origin, not Marti).
 */
function buildTakAxios(options = {}) {
  const TAK_DEBUG = getBool("TAK_DEBUG", false);

  const p12Path = resolvePathMaybe(getString("TAK_API_P12_PATH", ""));

  // ✅ Robust passphrase selection:
  // - Prefer TAK_API_P12_PASSPHRASE if explicitly present (even if empty string).
  // - Otherwise fall back to TAK_API_KEY_PASSPHRASE (legacy).
  // - If neither present, leave undefined and we'll use "" when calling getPemFromP12.
  let p12Pass;
  if (hasSettingOrEnvKey("TAK_API_P12_PASSPHRASE")) {
    p12Pass = getStringAllowEmpty("TAK_API_P12_PASSPHRASE");
  } else if (String(getString("TAK_API_KEY_PASSPHRASE", "")).length > 0) {
    p12Pass = String(getString("TAK_API_KEY_PASSPHRASE", ""));
  } else {
    p12Pass = undefined;
  }

  if (TAK_DEBUG) {
    const present = hasSettingOrEnvKey("TAK_API_P12_PASSPHRASE");
    const len = typeof p12Pass === "string" ? p12Pass.length : -1;
    console.log(
      `[TAK TLS] p12Path=${p12Path ? "set" : "unset"} p12PassphrasePresent=${present} p12PassphraseLen=${len}`
    );
  }

  const certPath = resolvePathMaybe(getString("TAK_API_CERT_PATH", ""));
  const keyPath = resolvePathMaybe(getString("TAK_API_KEY_PATH", ""));
  const caPath = resolvePathMaybe(getString("TAK_CA_PATH", ""));

  if (!p12Path && (!certPath || !keyPath)) {
    throw new Error(
      "TAK_URL is set but no client TLS credentials provided. Set TAK_API_P12_PATH (and optional TAK_API_P12_PASSPHRASE) OR set TAK_API_CERT_PATH + TAK_API_KEY_PATH."
    );
  }

  const allowInsecureServer = options.allowInsecureServer === true;

  const agentOptions = {
    ca: caPath ? fs.readFileSync(caPath) : undefined,
    rejectUnauthorized: !allowInsecureServer,

    // Keep your previous behavior (skip hostname verification)
    checkServerIdentity: () => undefined,
  };

  if (p12Path) {
    // Parse legacy PKCS#12 (incl RC2-40-CBC) -> PEM using node-tak’s approach via p12-pem
    const { getPemFromP12 } = require("p12-pem");

    const pass = p12Pass ?? ""; // allow intentionally-empty passphrases
    const certs = getPemFromP12(p12Path, pass);

    if (!certs?.pemCertificate) {
      throw new Error("Unable to extract certificate(s) from P12");
    }
    if (!certs?.pemKey) {
      throw new Error("Unable to extract private key from P12");
    }

    // Normalize formatting (ensure newlines around PEM markers)
    const cert = String(certs.pemCertificate)
      .split("-----BEGIN CERTIFICATE-----")
      .join("-----BEGIN CERTIFICATE-----\n")
      .split("-----END CERTIFICATE-----")
      .join("\n-----END CERTIFICATE-----");

    // p12-pem often returns RSA PRIVATE KEY; keep formatting robust either way
    let key = String(certs.pemKey);

    // If RSA marker exists, normalize around it
    if (key.includes("-----BEGIN RSA PRIVATE KEY-----")) {
      key = key
        .split("-----BEGIN RSA PRIVATE KEY-----")
        .join("-----BEGIN RSA PRIVATE KEY-----\n")
        .split("-----END RSA PRIVATE KEY-----")
        .join("\n-----END RSA PRIVATE KEY-----");
    }

    // If PKCS8 marker exists, normalize around it too
    if (key.includes("-----BEGIN PRIVATE KEY-----")) {
      key = key
        .split("-----BEGIN PRIVATE KEY-----")
        .join("-----BEGIN PRIVATE KEY-----\n")
        .split("-----END PRIVATE KEY-----")
        .join("\n-----END PRIVATE KEY-----");
    }

    agentOptions.cert = cert;
    agentOptions.key = key;

    // Note: no agentOptions.passphrase here — we extracted an unencrypted PEM key for Node TLS
  } else {
    agentOptions.cert = fs.readFileSync(certPath);
    agentOptions.key = fs.readFileSync(keyPath);
    agentOptions.passphrase =
      getString("TAK_API_KEY_PASSPHRASE", "") || undefined;
  }

  const httpsAgent = new https.Agent(agentOptions);

  const client = axios.create({
    baseURL: options.baseURL !== undefined ? options.baseURL : getTakBaseUrl(),
    httpsAgent,
    timeout: typeof options.timeout === "number" ? options.timeout : 5000,
  });

  if (TAK_DEBUG) {
    const fullUrl = (config) => {
      const base = config.baseURL || "";
      const url = config.url || "";
      return base.replace(/\/+$/, "") + "/" + String(url).replace(/^\/+/, "");
    };

    client.interceptors.request.use((config) => {
      console.log(
        "\n[TAK REQ]",
        (config.method || "get").toUpperCase(),
        fullUrl(config)
      );
      if (config.params) console.log("[TAK REQ params]", config.params);
      if (config.data) console.log("[TAK REQ body]", config.data);
      return config;
    });

    client.interceptors.response.use(
      (res) => {
        console.log("[TAK RES]", res.status, res.config?.url);
        if (res.data && typeof res.data === "object" && !Array.isArray(res.data)) {
          console.log("[TAK RES keys]", Object.keys(res.data).slice(0, 30));
        }
        return res;
      },
      (err) => {
        if (err.response) {
          console.error("[TAK ERR]", err.response.status, err.config?.url);
          console.error("[TAK ERR body]", err.response.data);
        } else {
          console.error("[TAK NET ERR]", err.message);
        }
        return Promise.reject(err);
      }
    );
  }

  return client;
}

/**
 * Generic "all certs" list.
 * GET /api/certadmin/cert
 */
async function getAllCerts(client, TAK_DEBUG) {
  const candidates = [
    "/api/certadmin/cert",
    "/api/certadmin/cert/all",
    "/api/certadmin/cert/list",
  ];

  for (const url of candidates) {
    try {
      const res = await client.get(url);
      const list = unwrapTakList(res.data);
      if (TAK_DEBUG) console.log(`[TAK CERT LIST] ${url} -> ${list.length}`);
      if (list.length) return list;
    } catch (e) {
      if (TAK_DEBUG) {
        console.log(
          `[TAK CERT LIST] ${url} not available (${e.response?.status || e.message})`
        );
      }
    }
  }

  return [];
}

function isRevokedGeneric(cert) {
  // Different TAK builds expose different fields. We check common ones.
  const status = toLowerTrim(cert?.status || cert?.state || cert?.certStatus);
  if (status && (status.includes("revok") || status === "r")) return true;

  const revokedBool =
    cert?.revoked === true ||
    cert?.isRevoked === true ||
    cert?.revocation === true;

  if (revokedBool) return true;

  const hasRevocationTime =
    !!cert?.revokedTime ||
    !!cert?.revocationTime ||
    !!cert?.revocationDate ||
    !!cert?.revokedAt;

  if (hasRevocationTime) return true;

  return false;
}

async function verifyRevoked(client, ids, TAK_DEBUG) {
  // First attempt: verify using fields present in the generic /cert list
  const after = await getAllCerts(client, TAK_DEBUG);
  const byId = new Map(after.map((c) => [String(c?.id ?? "").trim(), c]));

  const pending = [];
  for (const id of ids) {
    const c = byId.get(String(id));
    if (!c) {
      pending.push(String(id));
      continue;
    }
    if (!isRevokedGeneric(c)) pending.push(String(id));
  }

  if (!pending.length) return { ok: true, pending: [] };

  // Fallback: use revoked endpoint ONLY for verification.
  try {
    const res = await client.get("/api/certadmin/cert/revoked");
    const revokedList = unwrapTakList(res.data);
    const revokedIds = new Set(
      revokedList.map((c) => String(c?.id ?? "").trim()).filter(Boolean)
    );

    const stillPending = pending.filter((id) => !revokedIds.has(String(id)));
    if (stillPending.length === 0) return { ok: true, pending: [] };

    return { ok: false, pending: stillPending };
  } catch (e) {
    return { ok: false, pending };
  }
}

function certIdsForUsername(allCerts, username) {
  const u = toLowerTrim(username);
  if (!u) return [];

  const matches = allCerts.filter((c) => {
    if (toLowerTrim(c?.creatorDn) !== u) return false;
    return !isRevokedGeneric(c);
  });

  return Array.from(
    new Set(matches.map((c) => String(c?.id ?? "").trim()).filter(Boolean))
  );
}

function buildCertIdsByUsername(allCerts, usernames) {
  const byUsername = new Map();
  for (const username of usernames || []) {
    const ids = certIdsForUsername(allCerts, username);
    if (ids.length) byUsername.set(toLowerTrim(username), ids);
  }
  return byUsername;
}

async function revokeCertIds(client, ids, TAK_DEBUG) {
  const unique = Array.from(
    new Set((Array.isArray(ids) ? ids : []).map((id) => String(id).trim()).filter(Boolean))
  );
  if (!unique.length) return { attempted: 0, ids: [] };

  const idsPath = encodeURIComponent(unique.join(","));
  await client.delete(`/api/certadmin/cert/revoke/${idsPath}`);

  if (TAK_DEBUG) {
    console.log("[TAK CERT REVOKE] IDs:", unique);
  }

  return { attempted: unique.length, ids: unique };
}

const TAK_REVOKE_ID_CHUNK_SIZE = 100;

async function revokeCertIdsInChunks(client, ids, TAK_DEBUG) {
  const unique = Array.from(
    new Set((Array.isArray(ids) ? ids : []).map((id) => String(id).trim()).filter(Boolean))
  );
  if (!unique.length) return { attempted: 0, ids: [] };

  for (let i = 0; i < unique.length; i += TAK_REVOKE_ID_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + TAK_REVOKE_ID_CHUNK_SIZE);
    await revokeCertIds(client, chunk, TAK_DEBUG);
  }

  return { attempted: unique.length, ids: unique };
}

/**
 * Revoke certificates for many users with a single cert-catalog fetch and one final verify pass.
 * Used by agency disable to avoid O(users) full cert list downloads.
 */
async function revokeCertsForUsersBulk(usernames, options = {}) {
  const requireVerified = options.requireVerified !== false;
  const TAK_DEBUG = getBool("TAK_DEBUG", false);
  const list = Array.isArray(usernames)
    ? usernames.map((u) => String(u || "").trim()).filter(Boolean)
    : [];

  if (!list.length) {
    return {
      revoked: 0,
      attempted: 0,
      skipped: true,
      verified: true,
      byUsername: new Map(),
    };
  }

  if (isTakBypassed()) {
    if (TAK_DEBUG) {
      console.log(
        "[TAK] BYPASS enabled (TAK_BYPASS_ENABLED=true) — skipping certificate operations."
      );
    }
    return {
      revoked: 0,
      attempted: 0,
      skipped: true,
      bypassed: true,
      verified: true,
      byUsername: new Map(),
    };
  }

  if (!isTakConfigured()) {
    return {
      revoked: 0,
      attempted: 0,
      skipped: true,
      verified: true,
      byUsername: new Map(),
    };
  }

  const client = buildTakAxios();
  const allCerts = await getAllCerts(client, TAK_DEBUG);
  if (!allCerts.length) {
    if (requireVerified) {
      throw new Error(
        "TAK: Unable to list certificates from /api/certadmin/cert; refusing to proceed."
      );
    }
    return {
      revoked: 0,
      attempted: 0,
      skipped: false,
      verified: false,
      byUsername: new Map(),
    };
  }

  const byUsername = buildCertIdsByUsername(allCerts, list);
  const allIds = Array.from(
    new Set(Array.from(byUsername.values()).flatMap((ids) => ids))
  );

  if (TAK_DEBUG) {
    console.log("\n[TAK CERT BULK DISCOVERY] usernames:", list.length);
    console.log("[TAK CERT BULK DISCOVERY] total certs considered:", allCerts.length);
    console.log("[TAK CERT BULK DISCOVERY] matched cert IDs:", allIds.length);
  }

  if (!allIds.length) {
    return {
      revoked: 0,
      attempted: 0,
      skipped: false,
      verified: true,
      byUsername,
    };
  }

  await revokeCertIdsInChunks(client, allIds, TAK_DEBUG);
  const vr = await verifyRevoked(client, allIds, TAK_DEBUG);

  if (!vr.ok && requireVerified) {
    throw new Error(
      `TAK: Revoke attempted but could not verify revoked state for cert ID(s): ${vr.pending.join(
        ", "
      )}`
    );
  }

  return {
    revoked: allIds.length,
    attempted: allIds.length,
    skipped: false,
    verified: vr.ok,
    pending: vr.pending || [],
    byUsername,
  };
}

async function revokeCertsForUser(username, options = {}) {
  const requireVerified = options.requireVerified !== false; // default true for safety
  const TAK_DEBUG = getBool("TAK_DEBUG", false);

  if (isTakBypassed()) {
    if (TAK_DEBUG) {
      console.log(
        "[TAK] BYPASS enabled (TAK_BYPASS_ENABLED=true) — skipping certificate operations."
      );
    }
    return {
      revoked: 0,
      attempted: 0,
      skipped: true,
      bypassed: true,
      verified: true,
    };
  }

  if (!isTakConfigured())
    return { revoked: 0, attempted: 0, skipped: true, verified: true };

  const u = toLowerTrim(username);
  if (!u) throw new Error("Missing username for TAK certificate revocation");

  const client = buildTakAxios();

  const allCerts = await getAllCerts(client, TAK_DEBUG);
  if (!allCerts.length) {
    if (requireVerified) {
      throw new Error(
        "TAK: Unable to list certificates from /api/certadmin/cert; refusing to proceed."
      );
    }
    return { revoked: 0, attempted: 0, skipped: false, verified: false };
  }

  const ids = certIdsForUsername(allCerts, u);

  if (TAK_DEBUG) {
    console.log("\n[TAK CERT DISCOVERY] username:", u);
    console.log("[TAK CERT DISCOVERY] total certs considered:", allCerts.length);
    console.log("[TAK CERT DISCOVERY] matched cert count:", ids.length);
    console.log("[TAK CERT DISCOVERY] IDs to revoke:", ids);
  }

  if (!ids.length) {
    return { revoked: 0, attempted: 0, skipped: false, verified: true };
  }

  await revokeCertIds(client, ids, TAK_DEBUG);
  const vr = await verifyRevoked(client, ids, TAK_DEBUG);

  if (!vr.ok && requireVerified) {
    throw new Error(
      `TAK: Revoke attempted but could not verify revoked state for cert ID(s): ${vr.pending.join(
        ", "
      )}`
    );
  }

  return {
    revoked: ids.length,
    attempted: ids.length,
    skipped: false,
    verified: vr.ok,
    pending: vr.pending || [],
  };
}

module.exports = {
  isTakConfigured,
  revokeCertsForUser,
  revokeCertsForUsersBulk,
  buildTakAxios,
  getTakBaseUrl,
};
