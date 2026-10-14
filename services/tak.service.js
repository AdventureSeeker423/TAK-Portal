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
 *   TAK_CERT_LIST_TIMEOUT_MS      timeout for cert catalog GETs (default 60000)
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
const { getBool, getInt, getString } = require("./env");
const { attachCookieStore, getSharedTakCookieStore } = require("./takHttpSession");

/** Full cert catalogs can exceed the default 5s Marti axios timeout on busy servers. */
const DEFAULT_CERT_LIST_TIMEOUT_MS = 60_000;

function getCertListTimeoutMs() {
  const n = getInt("TAK_CERT_LIST_TIMEOUT_MS", DEFAULT_CERT_LIST_TIMEOUT_MS);
  return Math.max(5_000, n || DEFAULT_CERT_LIST_TIMEOUT_MS);
}

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
 * Load mutual-TLS client materials for TAK (PEM cert/key, optional CA).
 */
function loadTakClientTlsMaterials() {
  const p12Path = resolvePathMaybe(getString("TAK_API_P12_PATH", ""));

  let p12Pass;
  if (hasSettingOrEnvKey("TAK_API_P12_PASSPHRASE")) {
    p12Pass = getStringAllowEmpty("TAK_API_P12_PASSPHRASE");
  } else if (String(getString("TAK_API_KEY_PASSPHRASE", "")).length > 0) {
    p12Pass = String(getString("TAK_API_KEY_PASSPHRASE", ""));
  } else {
    p12Pass = undefined;
  }

  const certPath = resolvePathMaybe(getString("TAK_API_CERT_PATH", ""));
  const keyPath = resolvePathMaybe(getString("TAK_API_KEY_PATH", ""));
  const caPath = resolvePathMaybe(getString("TAK_CA_PATH", ""));

  if (!p12Path && (!certPath || !keyPath)) {
    throw new Error(
      "TAK_URL is set but no client TLS credentials provided. Set TAK_API_P12_PATH (and optional TAK_API_P12_PASSPHRASE) OR set TAK_API_CERT_PATH + TAK_API_KEY_PATH."
    );
  }

  let ca;
  if (caPath) {
    if (!fs.existsSync(caPath)) {
      const err = new Error(
        `TAK CA certificate file is missing (${caPath}). Upload the TAK CA (.pem) in Server Settings → Connection & Certificates, or ensure privileged SSH is configured so the portal can fetch it from the TAK server.`
      );
      err.code = "TAK_CA_MISSING";
      throw err;
    }
    ca = fs.readFileSync(caPath);
  }
  let cert;
  let key;
  let passphrase;

  if (p12Path) {
    const { getPemFromP12 } = require("p12-pem");

    const pass = p12Pass ?? "";
    const certs = getPemFromP12(p12Path, pass);

    if (!certs?.pemCertificate) {
      throw new Error("Unable to extract certificate(s) from P12");
    }
    if (!certs?.pemKey) {
      throw new Error("Unable to extract private key from P12");
    }

    cert = String(certs.pemCertificate)
      .split("-----BEGIN CERTIFICATE-----")
      .join("-----BEGIN CERTIFICATE-----\n")
      .split("-----END CERTIFICATE-----")
      .join("\n-----END CERTIFICATE-----");

    key = String(certs.pemKey);

    if (key.includes("-----BEGIN RSA PRIVATE KEY-----")) {
      key = key
        .split("-----BEGIN RSA PRIVATE KEY-----")
        .join("-----BEGIN RSA PRIVATE KEY-----\n")
        .split("-----END RSA PRIVATE KEY-----")
        .join("\n-----END RSA PRIVATE KEY-----");
    }

    if (key.includes("-----BEGIN PRIVATE KEY-----")) {
      key = key
        .split("-----BEGIN PRIVATE KEY-----")
        .join("-----BEGIN PRIVATE KEY-----\n")
        .split("-----END PRIVATE KEY-----")
        .join("\n-----END PRIVATE KEY-----");
    }
  } else {
    cert = fs.readFileSync(certPath);
    key = fs.readFileSync(keyPath);
    passphrase = getString("TAK_API_KEY_PASSPHRASE", "") || undefined;
  }

  return { cert, key, ca, passphrase };
}

/**
 * @param {{ allowInsecureServer?: boolean }} [options]
 */
function getTakTlsAuth(options = {}) {
  const allowInsecureServer = options.allowInsecureServer === true;
  const { cert, key, ca, passphrase } = loadTakClientTlsMaterials();
  return {
    cert,
    key,
    ca,
    passphrase,
    rejectUnauthorized: !allowInsecureServer,
  };
}


/**
 * @param {{
 *   allowInsecureServer?: boolean;
 *   baseURL?: string;
 *   timeout?: number;
 * }} [options] - allowInsecureServer: skip server cert verify (locate relay). baseURL/timeout: optional overrides (locate relay uses locate API origin, not Marti).
 */
function withDefaultTimeout(client, timeoutMs) {
  if (typeof timeoutMs !== "number") return client;
  const merge = (config) => {
    const next = { ...(config || {}) };
    if (typeof next.timeout !== "number") next.timeout = timeoutMs;
    return next;
  };
  return {
    get: (url, config) => client.get(url, merge(config)),
    delete: (url, config) => client.delete(url, merge(config)),
    head: (url, config) => client.head(url, merge(config)),
    options: (url, config) => client.options(url, merge(config)),
    post: (url, data, config) => client.post(url, data, merge(config)),
    put: (url, data, config) => client.put(url, data, merge(config)),
    patch: (url, data, config) => client.patch(url, data, merge(config)),
    request: (config) => client.request(merge(config)),
  };
}

function attachTakDebugInterceptors(client) {
  const TAK_DEBUG = getBool("TAK_DEBUG", false);
  if (!TAK_DEBUG || client.__takDebugAttached) return client;
  client.__takDebugAttached = true;

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
  return client;
}

function createTakAxiosClient(options = {}) {
  const TAK_DEBUG = getBool("TAK_DEBUG", false);

  if (TAK_DEBUG) {
    const p12Path = resolvePathMaybe(getString("TAK_API_P12_PATH", ""));
    const present = hasSettingOrEnvKey("TAK_API_P12_PASSPHRASE");
    let p12PassLen = -1;
    if (hasSettingOrEnvKey("TAK_API_P12_PASSPHRASE")) {
      p12PassLen = getStringAllowEmpty("TAK_API_P12_PASSPHRASE").length;
    }
    console.log(
      `[TAK TLS] p12Path=${p12Path ? "set" : "unset"} p12PassphrasePresent=${present} p12PassphraseLen=${p12PassLen}`
    );
  }

  const tlsAuth = getTakTlsAuth(options);

  const agentOptions = {
    keepAlive: true,
    ca: tlsAuth.ca,
    rejectUnauthorized: tlsAuth.rejectUnauthorized !== false,
    checkServerIdentity: () => undefined,
    cert: tlsAuth.cert,
    key: tlsAuth.key,
  };
  if (tlsAuth.passphrase) {
    agentOptions.passphrase = tlsAuth.passphrase;
  }

  const httpsAgent = new https.Agent(agentOptions);

  const client = axios.create({
    baseURL: options.baseURL !== undefined ? options.baseURL : getTakBaseUrl(),
    httpsAgent,
    timeout: typeof options.timeout === "number" ? options.timeout : 5000,
  });

  const shareCookies = options.allowInsecureServer !== true;
  if (shareCookies) {
    attachCookieStore(client, getSharedTakCookieStore());
  }

  attachTakDebugInterceptors(client);
  return client;
}

let _martiAxios = null;
let _martiAxiosKey = "";

function clearMartiAxiosCache() {
  _martiAxios = null;
  _martiAxiosKey = "";
}

function getDefaultMartiAxios() {
  let key = "marti";
  try {
    key = `marti:${getTakBaseUrl()}`;
  } catch (_) {
    key = "marti";
  }
  if (_martiAxios && _martiAxiosKey === key) return _martiAxios;
  _martiAxios = createTakAxiosClient();
  _martiAxiosKey = key;
  return _martiAxios;
}

const DEFAULT_TAK_CA_REL_PATH = "data/certs/tak-ca.pem";

/**
 * Ensure TAK_CA_PATH points at a readable PEM. When the configured file is missing
 * (common with installer settings that still point at ./certs/tak-ca.pem), fetch
 * ca.pem from the TAK server over privileged SSH and persist under data/certs.
 */
async function ensureTakCaAvailable() {
  const configured = String(getString("TAK_CA_PATH", "") || "").trim();
  const caPath = resolvePathMaybe(configured);
  if (caPath && fs.existsSync(caPath)) {
    return { ok: true, path: caPath, fetched: false };
  }

  const defaultAbs = path.join(process.cwd(), DEFAULT_TAK_CA_REL_PATH);
  if (fs.existsSync(defaultAbs)) {
    if (!configured || caPath !== defaultAbs) {
      const current = settingsStore.getSettings() || {};
      settingsStore.saveSettings({
        ...current,
        TAK_CA_PATH: DEFAULT_TAK_CA_REL_PATH,
      });
      clearMartiAxiosCache();
    }
    return { ok: true, path: defaultAbs, fetched: false };
  }

  let takSshSvc;
  try {
    takSshSvc = require("./takSsh.service");
  } catch (_) {
    takSshSvc = null;
  }

  if (!takSshSvc || !takSshSvc.isPrivilegedSshReady()) {
    if (!configured) {
      return { ok: true, path: null, fetched: false };
    }
    const err = new Error(
      `TAK CA certificate file is missing (${caPath || configured}). Upload the TAK CA (.pem) in Server Settings → Connection & Certificates, or complete privileged SSH setup so the portal can fetch it.`
    );
    err.code = "TAK_CA_MISSING";
    throw err;
  }

  const remote = await takSshSvc.fetchTakCaPemFromRemote();
  const pem = Buffer.isBuffer(remote?.pem) ? remote.pem : Buffer.from(String(remote?.pem || ""), "utf8");
  if (!pem.length || !String(pem).includes("BEGIN CERTIFICATE")) {
    const err = new Error("Fetched TAK CA from the server but it was empty or not a PEM certificate.");
    err.code = "TAK_CA_MISSING";
    throw err;
  }

  fs.mkdirSync(path.dirname(defaultAbs), { recursive: true });
  fs.writeFileSync(defaultAbs, pem, { mode: 0o600 });
  const current = settingsStore.getSettings() || {};
  settingsStore.saveSettings({
    ...current,
    TAK_CA_PATH: DEFAULT_TAK_CA_REL_PATH,
  });
  clearMartiAxiosCache();
  return {
    ok: true,
    path: defaultAbs,
    fetched: true,
    sourcePath: String(remote?.sourcePath || ""),
  };
}

function buildTakAxios(options = {}) {
  const customBase = options.baseURL !== undefined;
  const insecure = options.allowInsecureServer === true;
  const client =
    !customBase && !insecure
      ? getDefaultMartiAxios()
      : createTakAxiosClient(options);
  return withDefaultTimeout(client, options.timeout);
}

function formatCertListFailure(url, err) {
  const status = err?.response?.status;
  if (status) {
    let body = err.response?.data;
    if (body != null && typeof body === "object") {
      try {
        body = JSON.stringify(body);
      } catch (_) {
        body = String(body);
      }
    } else if (body != null) {
      body = String(body);
    }
    const clipped = body ? String(body).replace(/\s+/g, " ").trim().slice(0, 240) : "";
    return clipped ? `${url} (HTTP ${status}: ${clipped})` : `${url} (HTTP ${status})`;
  }
  const code = err?.code ? `${err.code}: ` : "";
  return `${url} (${code}${err?.message || String(err)})`;
}

/**
 * Generic "all certs" list.
 * Tries /api/certadmin/cert, /all, then /list. First HTTP success wins.
 *
 * Uses a longer per-request timeout than the default Marti client (5s) so a slow
 * catalog does not abort before a working candidate can return. A 500 from one
 * candidate does not block trying the others.
 *
 * Returns { ok, list, url, failures? }.
 * - ok=true when any candidate returned HTTP success (including an empty catalog)
 * - ok=false when every candidate failed (network/HTTP error)
 */
async function getAllCerts(client, TAK_DEBUG) {
  const candidates = [
    "/api/certadmin/cert",
    "/api/certadmin/cert/all",
    "/api/certadmin/cert/list",
  ];

  const timeout = getCertListTimeoutMs();
  const failures = [];

  for (const url of candidates) {
    try {
      const res = await client.get(url, { timeout });
      const list = unwrapTakList(res.data);
      if (TAK_DEBUG) console.log(`[TAK CERT LIST] ${url} -> ${list.length} (timeout=${timeout}ms)`);
      // A successful response (even with 0 certs) is a valid answer on a fresh system.
      return { ok: true, list, url, failures };
    } catch (e) {
      const detail = formatCertListFailure(url, e);
      failures.push(detail);
      // Per-candidate noise (e.g. expected 404 on /all) stays behind TAK_DEBUG.
      // Status/body are retained in `failures` for the final warn and revoke errors.
      if (TAK_DEBUG) console.warn(`[TAK CERT LIST] ${detail}`);
    }
  }

  console.warn(
    `[TAK CERT LIST] Unable to list certificates; all candidates failed: ${failures.join("; ")}`
  );
  return { ok: false, list: [], url: null, failures };
}

function isExpiredGeneric(cert) {
  const status = toLowerTrim(cert?.status || cert?.state || cert?.certStatus);
  if (status && status.includes("expir")) return true;

  const exp =
    cert?.expirationDate ||
    cert?.expiration ||
    cert?.expires ||
    cert?.notAfter ||
    cert?.validTo;
  if (exp == null || exp === "") return false;
  if (typeof exp === "number" && Number.isFinite(exp)) {
    const ms = exp < 1e12 ? exp * 1000 : exp;
    return ms <= Date.now();
  }
  const t = Date.parse(exp);
  return Number.isFinite(t) && t <= Date.now();
}

function isActiveUnrevokedCert(cert) {
  if (!cert) return false;
  if (isRevokedGeneric(cert)) return false;
  if (isExpiredGeneric(cert)) return false;
  return true;
}

function buildActiveCertUsernameSet(allCerts) {
  return new Set(countActiveUnrevokedCertsByUsername(allCerts).keys());
}

/**
 * Unrevoked, unexpired client certificates per username (creatorDn).
 * The same username can appear many times after a mutual aid is deleted and
 * recreated; revoked certificates are ignored, and duplicate cert ids count once.
 */
function countActiveUnrevokedCertsByUsername(allCerts) {
  const counts = new Map();
  const seen = new Set();
  for (const c of Array.isArray(allCerts) ? allCerts : []) {
    if (!isActiveUnrevokedCert(c)) continue;
    const u = toLowerTrim(c?.creatorDn);
    if (!u) continue;
    const id = String(c?.id ?? c?.hash ?? c?.serialNumber ?? c?.certificateId ?? "").trim();
    if (id) {
      const key = `${u}\n${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    counts.set(u, (counts.get(u) || 0) + 1);
  }
  return counts;
}

let _certCatalogCache = { at: 0, result: null };
const CERT_CATALOG_TTL_MS = 45_000;

async function loadCachedCertCatalog() {
  if (!isTakConfigured()) {
    return { ok: false, list: [], reason: "not_configured" };
  }
  if (isTakBypassed()) {
    return { ok: false, list: [], reason: "bypass" };
  }

  try {
    const now = Date.now();
    let catalog = _certCatalogCache.result;
    if (!catalog || !catalog.ok || now - _certCatalogCache.at >= CERT_CATALOG_TTL_MS) {
      const client = buildTakAxios();
      const TAK_DEBUG = getBool("TAK_DEBUG", false);
      catalog = await getAllCerts(client, TAK_DEBUG);
      if (catalog.ok) _certCatalogCache = { at: now, result: catalog };
    }
    if (!catalog || !catalog.ok) {
      return { ok: false, list: [], reason: "list_failed" };
    }
    return { ok: true, list: catalog.list, reason: null };
  } catch (e) {
    return { ok: false, list: [], reason: e?.message || "error" };
  }
}

/**
 * Usernames (lowercase) with at least one unrevoked, unexpired TAK cert.
 * ok=false when TAK is off/bypassed or the cert catalog could not be listed
 * (callers must not treat that as "no certs").
 */
async function getActiveCertUsernameSet() {
  const catalog = await loadCachedCertCatalog();
  if (!catalog.ok) {
    return { ok: false, usernames: new Set(), reason: catalog.reason || "list_failed" };
  }
  return { ok: true, usernames: buildActiveCertUsernameSet(catalog.list) };
}

/**
 * Count of unrevoked, unexpired client certificates keyed by lowercase username.
 * ok=false when the catalog could not be listed (callers must not treat that as zero).
 */
async function getActiveCertCountsByUsername() {
  const catalog = await loadCachedCertCatalog();
  if (!catalog.ok) {
    return { ok: false, counts: new Map(), reason: catalog.reason || "list_failed" };
  }
  return { ok: true, counts: countActiveUnrevokedCertsByUsername(catalog.list) };
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
  const afterResult = await getAllCerts(client, TAK_DEBUG);
  const after = afterResult.ok ? afterResult.list : [];
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
  const certCatalog = await getAllCerts(client, TAK_DEBUG);
  if (!certCatalog.ok) {
    if (requireVerified) {
      const detail = (certCatalog.failures || []).join("; ") || "all candidates failed";
      throw new Error(
        `TAK: Unable to list certificates; refusing to proceed (${detail}).`
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

  const allCerts = certCatalog.list;
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

  const certCatalog = await getAllCerts(client, TAK_DEBUG);
  if (!certCatalog.ok) {
    if (requireVerified) {
      const detail = (certCatalog.failures || []).join("; ") || "all candidates failed";
      throw new Error(
        `TAK: Unable to list certificates; refusing to proceed (${detail}).`
      );
    }
    return { revoked: 0, attempted: 0, skipped: false, verified: false };
  }

  const allCerts = certCatalog.list;
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
  isTakBypassed,
  revokeCertsForUser,
  revokeCertsForUsersBulk,
  buildTakAxios,
  getTakTlsAuth,
  getTakBaseUrl,
  ensureTakCaAvailable,
  clearMartiAxiosCache,
  isExpiredGeneric,
  isActiveUnrevokedCert,
  buildActiveCertUsernameSet,
  countActiveUnrevokedCertsByUsername,
  getActiveCertUsernameSet,
  getActiveCertCountsByUsername,
};
