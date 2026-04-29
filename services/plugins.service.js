/**
 * Plugin Manager service: TAK.gov link state + plugin storage under data/plugins.
 * Uses TAK.gov OAuth 2.0 Device Authorization Grant (same as OpenTAKServer).
 * TAK.gov returns 421 if not using HTTP/2, so we use Node's http2 module.
 * See: https://raw.githubusercontent.com/brian7704/OpenTAKServer/master/opentakserver/blueprints/ots_api/tak_gov_link_api.py
 */

const fs = require("fs");
const path = require("path");
const { pipeline, Readable } = require("stream");
const { promisify } = require("util");
const http2 = require("http2");
const { URL } = require("url");
const { fetch, Agent } = require("undici");

const pipelinePromise = promisify(pipeline);

const DATA_DIR = path.join(__dirname, "..", "data");
const PLUGINS_DIR = path.join(DATA_DIR, "plugins");
const MANIFEST_PATH = path.join(DATA_DIR, "plugin-manifest.json");

const TAK_GOV_DEVICE_URL = "https://auth.tak.gov/auth/realms/TPC/protocol/openid-connect/auth/device";
const TAK_GOV_TOKEN_URL = "https://auth.tak.gov/auth/realms/TPC/protocol/openid-connect/token";
const TAK_GOV_CLIENT_ID = "tak-gov-eud";
// Match OpenTAKServer User-Agent; TAK.gov may expect it
const USER_AGENT = "OpenTAKServer 1.7.9";

/**
 * POST to a TAK.gov URL using HTTP/2 (required; TAK.gov returns 421 over HTTP/1.1).
 * @param {string} url - full URL
 * @param {string} formBody - application/x-www-form-urlencoded body
 * @returns {Promise<{ statusCode: number, data: object }>}
 */
function takGovHttp2Post(url, formBody) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const host = u.hostname;
    const pathname = u.pathname || "/";
    const timeout = 15000;

    const client = http2.connect(url, {
      servername: host,
    });
    let timeoutId;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeoutId);
      try { client.close(); } catch (_) {}
    };
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    };
    timeoutId = setTimeout(() => {
      finish(reject, new Error("TAK.gov request timeout"));
    }, timeout);
    client.on("error", (err) => finish(reject, err));

    const headers = {
      ":path": pathname,
      ":method": "POST",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": USER_AGENT,
    };
    const req = client.request(headers);
    let body = "";
    req.setEncoding("utf8");
    req.on("response", (responseHeaders) => {
      const status = Number(responseHeaders[":status"]) || 0;
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        if (settled) return;
        settled = true;
        cleanup();
        let data;
        try {
          data = body ? JSON.parse(body) : {};
        } catch (_) {
          data = { raw: body };
        }
        resolve({ statusCode: status, data });
      });
    });
    req.on("error", (err) => finish(reject, err));
    req.write(formBody);
    req.end();
  });
}

/**
 * GET a URL using HTTP/2 with optional Bearer token (for TAK.gov eud_api).
 * @param {string} url - full URL
 * @param {string} [accessToken] - Bearer token
 * @param {{ responseType?: 'json'|'buffer', maxRedirects?: number, extraHeaders?: object }} [options]
 * @returns {Promise<{ statusCode: number, data: object|Buffer, headers: object }>}
 */
function takGovHttp2Get(url, accessToken, options = {}) {
  const responseType = options.responseType || "json";
  const maxRedirects = options.maxRedirects ?? 5;
  const timeout = options.timeoutMs ?? 120000;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const pathname = u.pathname + u.search;

    const client = http2.connect(url, { servername: u.hostname });
    let timeoutId;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeoutId);
      try { client.close(); } catch (_) {}
    };
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    };
    timeoutId = setTimeout(() => {
      finish(reject, new Error("TAK.gov request timeout"));
    }, timeout);
    client.on("error", (err) => finish(reject, err));

    const headers = {
      ":path": pathname,
      ":method": "GET",
      "user-agent": USER_AGENT,
    };
    if (accessToken) headers["authorization"] = `Bearer ${accessToken}`;
    if (options.extraHeaders && typeof options.extraHeaders === "object") {
      Object.assign(headers, options.extraHeaders);
    }

    const req = client.request(headers);
    const chunks = [];
    req.on("response", (responseHeaders) => {
      const status = Number(responseHeaders[":status"]) || 0;
      const location = responseHeaders["location"];
      if ((status === 301 || status === 302 || status === 307 || status === 308) && location && maxRedirects > 0) {
        cleanup();
        takGovHttp2Get(location, accessToken, { ...options, maxRedirects: maxRedirects - 1 })
          .then(resolve)
          .catch(reject);
        return;
      }
      req.on("data", (chunk) => { chunks.push(chunk); });
      req.on("end", () => {
        if (settled) return;
        settled = true;
        cleanup();
        const body = Buffer.concat(chunks);
        let data;
        if (responseType === "buffer") {
          data = body;
        } else {
          try {
            data = body.length ? JSON.parse(body.toString("utf8")) : {};
          } catch (_) {
            data = { raw: body.toString("utf8") };
          }
        }
        resolve({ statusCode: status, data, headers: responseHeaders });
      });
    });
    req.on("error", (err) => finish(reject, err));
    req.end();
  });
}

const TAK_GOV_SESSION_EXPIRED_MARKERS = [
  "session doesn't have required client",
  "invalid_grant",
  "refresh token",
  "session",
  "expired",
];

function isTakGovSessionExpiredError(message) {
  const lower = String(message || "").toLowerCase();
  return TAK_GOV_SESSION_EXPIRED_MARKERS.some((m) => lower.includes(m));
}

/**
 * Get a new access_token using stored refresh_token (for TAK.gov eud_api calls).
 * If TAK.gov returns a session/refresh error (e.g. "Session doesn't have required client"),
 * we clear the stored link so the user can re-link.
 * @returns {Promise<{ success: boolean, access_token?: string, error?: string, sessionExpired?: boolean }>}
 */
async function getTakGovAccessToken() {
  const manifest = loadManifest();
  const refreshToken = manifest.takGovLink?.refreshToken;
  if (!refreshToken) {
    return { success: false, error: "Not linked to TAK.gov. Link your account first." };
  }
  try {
    const formBody = new URLSearchParams({
      client_id: TAK_GOV_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString();
    const { statusCode, data } = await takGovHttp2Post(TAK_GOV_TOKEN_URL, formBody);
    if (statusCode !== 200 || !data.access_token) {
      const msg = data.error_description || data.error || `Token exchange returned ${statusCode}`;
      if (isTakGovSessionExpiredError(msg)) {
        const updated = {
          ...manifest.takGovLink,
          linked: false,
          refreshToken: null,
          linkCode: null,
          linkCodeExpiry: null,
          deviceCode: null,
          deviceCodeExpiry: null,
          interval: null,
          verificationUri: null,
        };
        saveManifest({ ...manifest, takGovLink: updated });
        return {
          success: false,
          error: "Your TAK.gov session has expired. Please unlink and link your account again: click Unlink account, then Get Link Code → enter the code at TAK.gov → Link Account.",
          sessionExpired: true,
        };
      }
      return { success: false, error: msg };
    }
    if (data.refresh_token) {
      const updated = { ...manifest.takGovLink, refreshToken: data.refresh_token };
      saveManifest({ ...manifest, takGovLink: updated });
    }
    return { success: true, access_token: data.access_token };
  } catch (err) {
    return { success: false, error: err?.message || "Failed to get access token." };
  }
}

const TAK_GOV_PLUGINS_URL = "https://tak.gov/eud_api/software/v1/plugins";

const TAKGOV_PLUGINS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const takgovPluginsCache = new Map(); // key: "product|product_version", value: { plugins, expiry }

function getAtakVersionValue(plugin) {
  if (!plugin || typeof plugin !== "object") return null;
  let raw = plugin.atakVersion ?? plugin.atak_version ?? plugin.product_version ?? null;
  if (raw == null && typeof plugin.version === "string") {
    // Backward compatibility: many existing entries encode ATAK target in version text,
    // e.g. "3.7.4 (5874618) - [5.6.0]".
    const versionText = plugin.version;
    const bracket = versionText.match(/\[(\d+\.\d+(?:\.\d+)?)\]/);
    if (bracket && bracket[1]) raw = bracket[1];
  }
  if (raw == null) return null;
  const s = String(raw).trim();
  return s || null;
}

function getAtakCompatibilityKey(version) {
  const raw = version == null ? "" : String(version).trim();
  if (!raw) return "";
  const match = raw.match(/^(\d+)\.(\d+)/);
  if (!match) return raw.toLowerCase();
  return `${match[1]}.${match[2]}`;
}

/**
 * Fetch plugin list from TAK.gov (requires linked account). Cached per product/version for 1 hour.
 * @param {string} product - e.g. ATAK-CIV, ATAK-GOV, ATAK-MIL
 * @param {string} product_version - e.g. 5.5.0
 * @returns {Promise<{ success: boolean, plugins?: array, error?: string }>}
 */
async function fetchTakGovPlugins(product, product_version) {
  const key = `${product}|${product_version}`;
  const cached = takgovPluginsCache.get(key);
  if (cached && cached.expiry > Date.now()) {
    return { success: true, plugins: cached.plugins };
  }
  const token = await getTakGovAccessToken();
  if (!token.success) return { success: false, error: token.error };
  const u = new URL(TAK_GOV_PLUGINS_URL);
  u.searchParams.set("product", product);
  u.searchParams.set("product_version", product_version);
  try {
    const { statusCode, data } = await takGovHttp2Get(u.toString(), token.access_token, { responseType: "json" });
    if (statusCode !== 200) {
      return { success: false, error: data?.error_description || data?.error || `TAK.gov returned ${statusCode}` };
    }
    const plugins = Array.isArray(data) ? data : (data.plugins || data.items || []);
    takgovPluginsCache.set(key, { plugins, expiry: Date.now() + TAKGOV_PLUGINS_CACHE_TTL_MS });
    return { success: true, plugins };
  } catch (err) {
    return { success: false, error: err?.message || "Failed to fetch plugins from TAK.gov." };
  }
}

/**
 * Download a URL to a file using undici fetch with HTTP/2 (allowH2).
 * TAK.gov requires HTTP/2; undici handles it without Node http2 protocol errors.
 * @param {string} url - APK URL
 * @param {string} accessToken - Bearer token
 * @param {string} destFilePath - path to write the file
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ statusCode: number, headers: Headers, error?: string }>}
 */
async function takGovFetchStreamToFile(url, accessToken, destFilePath, options = {}) {
  const timeoutMs = options.timeoutMs ?? 300000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      dispatcher: new Agent({ allowH2: true }),
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        "Authorization": `Bearer ${accessToken}`,
      },
      redirect: "follow",
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const errBody = await response.text().then((t) => t.trim().slice(0, 300)).catch(() => "");
      return { statusCode: response.status, headers: response.headers, error: errBody || `HTTP ${response.status}` };
    }
    const fileStream = fs.createWriteStream(destFilePath);
    const nodeStream = Readable.fromWeb(response.body);
    await pipelinePromise(nodeStream, fileStream);
    return { statusCode: response.status, headers: response.headers };
  } catch (err) {
    clearTimeout(timeoutId);
    try { if (fs.existsSync(destFilePath)) fs.unlinkSync(destFilePath); } catch (_) {}
    throw err;
  }
}

/**
 * Download a plugin from TAK.gov by URL (using stored refresh token for Bearer).
 * Streams directly to file (like OpenTAKServer) to avoid protocol errors from buffering large APKs.
 * @param {{ apk_url: string, display_name?: string, version?: string, package_name?: string, atak_version?: string, apk_size_bytes?: number }} pluginItem - from TAK.gov plugins list
 * @returns {Promise<{ success: boolean, plugin?: object, error?: string }>}
 */
async function downloadTakGovPlugin(pluginItem) {
  const apkUrl = pluginItem?.apk_url;
  if (!apkUrl || typeof apkUrl !== "string") {
    return { success: false, error: "Plugin apk_url is required." };
  }
  const token = await getTakGovAccessToken();
  if (!token.success) return { success: false, error: token.error };

  ensurePluginsDir();
  const tempPath = path.join(PLUGINS_DIR, `_tmp_${Date.now()}_${Math.random().toString(36).slice(2)}.apk`);
  try {
    const result = await takGovFetchStreamToFile(apkUrl, token.access_token, tempPath, { timeoutMs: 300000 });
    if (result.statusCode !== 200) {
      return { success: false, error: result.error || `TAK.gov returned ${result.statusCode} for plugin download.` };
    }
    const contentDisp = result.headers.get ? result.headers.get("content-disposition") : result.headers["content-disposition"];
    let filename = (typeof contentDisp === "string" && contentDisp.match(/filename[*]?=(?:UTF-8'')?["']?([^"'\s;]+)/i)?.[1]) || "plugin.apk";
    filename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const destPath = path.join(PLUGINS_DIR, filename);

    const manifest = loadManifest();
    const packageName = pluginItem.package_name || null;
    const incomingAtakVersion = getAtakVersionValue(pluginItem);
    const incomingCompatKey = getAtakCompatibilityKey(incomingAtakVersion);
    let preservedFavorite = false;
    // Remove existing by package_name + ATAK compatibility target (update scenario) or by same filename.
    // This allows side-by-side plugin variants for different ATAK versions (e.g. 5.6 and 5.7).
    const existingByPkg = packageName
      ? manifest.plugins.find((p) => {
        if (p.package_name !== packageName) return false;
        const existingCompatKey = getAtakCompatibilityKey(getAtakVersionValue(p));
        if (!incomingCompatKey) return !existingCompatKey;
        return existingCompatKey === incomingCompatKey;
      })
      : null;
    const existingByFile = manifest.plugins.find((p) => p.filename === filename);
    const existing = existingByPkg || existingByFile;
    if (existing) {
      preservedFavorite = existing.favorite === true;
      try {
        const oldPath = path.join(PLUGINS_DIR, existing.filename);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      } catch (_) {}
      manifest.plugins = manifest.plugins.filter((p) => p.id !== existing.id);
    }
    fs.renameSync(tempPath, destPath);
    const stat = fs.statSync(destPath);
    const id = nextPluginId(manifest.plugins);
    const plugin = {
      id,
      name: pluginItem.display_name || pluginItem.package_name || path.basename(filename, path.extname(filename)) || filename,
      description: pluginItem.description || null,
      filename,
      size: stat.size,
      downloadedAt: new Date().toISOString(),
      source: "tak.gov",
      atakFlavor: pluginItem.product || null,
      atakVersion: incomingAtakVersion,
      package_name: packageName,
      favorite: preservedFavorite,
      version: pluginItem.version || null,
      revision_code: pluginItem.revision_code != null ? pluginItem.revision_code : null,
    };
    manifest.plugins.push(plugin);
    saveManifest(manifest);
    return { success: true, plugin };
  } catch (err) {
    const msg = err?.message || "Download failed.";
    console.error("[plugins.service] downloadTakGovPlugin error:", msg, err?.code || "");
    return { success: false, error: msg };
  }
}

function ensurePluginsDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PLUGINS_DIR)) fs.mkdirSync(PLUGINS_DIR, { recursive: true });
}

function loadManifest() {
  ensurePluginsDir();
  if (!fs.existsSync(MANIFEST_PATH)) {
    return {
      takGovLink: { linked: false, linkCode: null, linkCodeExpiry: null },
      plugins: [],
    };
  }
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, "utf8");
    const data = JSON.parse(raw);
    const plugins = Array.isArray(data.plugins) ? data.plugins : [];
    const takGovLink = data.takGovLink && typeof data.takGovLink === "object"
      ? data.takGovLink
      : { linked: false, linkCode: null, linkCodeExpiry: null };
    return { takGovLink, plugins };
  } catch (err) {
    console.warn("[plugins.service] Failed to read manifest:", err?.message || err);
    return {
      takGovLink: { linked: false, linkCode: null, linkCodeExpiry: null },
      plugins: [],
    };
  }
}

function saveManifest(manifest) {
  ensurePluginsDir();
  const payload = {
    takGovLink: manifest.takGovLink || { linked: false, linkCode: null, linkCodeExpiry: null },
    plugins: Array.isArray(manifest.plugins) ? manifest.plugins : [],
  };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(payload, null, 2));
}

/**
 * Get current TAK.gov link status. If generateNewCode is true, request a new user_code from TAK.gov
 * (OAuth 2.0 Device Authorization Grant). The code is issued by TAK.gov, not generated by us.
 * @param {boolean} generateNewCode - if true, call TAK.gov device endpoint and store device_code + user_code
 * @returns {Promise<{ linked: boolean, linkCode?: string, linkCodeExpiry?: number, verificationUri?: string, message?: string, error?: string }>}
 */
async function getTakGovLinkState(generateNewCode = false) {
  const manifest = loadManifest();
  const { takGovLink } = manifest;

  if (generateNewCode) {
    try {
      const formBody = new URLSearchParams({
        client_id: TAK_GOV_CLIENT_ID,
        scope: "openid offline_access email profile",
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString();
      const { statusCode, data } = await takGovHttp2Post(TAK_GOV_DEVICE_URL, formBody);

      if (statusCode !== 200) {
        const msg = data.error_description || data.error || `TAK.gov returned ${statusCode}`;
        console.warn("[plugins.service] TAK.gov device request failed:", statusCode, msg);
        return { linked: !!takGovLink.linked, error: msg };
      }

      const userCode = data.user_code;
      const deviceCode = data.device_code;
      const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 180;
      const interval = typeof data.interval === "number" ? data.interval : 5;
      const verificationUri = data.verification_uri || "https://tak.gov/register-device";
      const verificationUriComplete = typeof data.verification_uri_complete === "string" ? data.verification_uri_complete : null;
      const expiry = Date.now() + expiresIn * 1000;

      const updated = {
        ...takGovLink,
        linkCode: userCode,
        linkCodeExpiry: expiry,
        deviceCode,
        deviceCodeExpiry: expiry,
        interval,
        verificationUri,
        verificationUriComplete: verificationUriComplete || undefined,
      };
      saveManifest({ ...manifest, takGovLink: updated });
      return {
        linked: !!takGovLink.linked,
        linkCode: userCode,
        linkCodeExpiry: expiry,
        verificationUri,
        verificationUriComplete: verificationUriComplete || undefined,
        message: `Enter this code at https://tak.gov/register-device (expires in ${Math.floor(expiresIn / 60)} minutes).`,
      };
    } catch (err) {
      const msg = err?.message || "Failed to get link code from TAK.gov.";
      console.warn("[plugins.service] TAK.gov device request failed:", msg);
      return {
        linked: !!takGovLink.linked,
        error: msg,
      };
    }
  }

  const hasValidCode = takGovLink.linkCode && takGovLink.linkCodeExpiry && Date.now() < takGovLink.linkCodeExpiry;
  return {
    linked: !!takGovLink.linked,
    linkCode: hasValidCode ? takGovLink.linkCode : null,
    linkCodeExpiry: takGovLink.linkCodeExpiry || null,
    verificationUri: takGovLink.verificationUri || "https://tak.gov/register-device",
    verificationUriComplete: takGovLink.verificationUriComplete || null,
  };
}

/**
 * Exchange the stored device_code for tokens (after user has entered user_code on TAK.gov and authorized).
 * No code parameter: we use the device_code stored when "Get Link Code" was called.
 * @returns {Promise<{ success: boolean, message?: string }>}
 */
async function linkTakGovAccount() {
  const manifest = loadManifest();
  const { takGovLink } = manifest;
  const deviceCode = takGovLink.deviceCode;
  if (!deviceCode) {
    return { success: false, message: "No device code. Click \"Get Link Code\" first, then enter that code at TAK.gov and authorize." };
  }
  if (takGovLink.deviceCodeExpiry && Date.now() >= takGovLink.deviceCodeExpiry) {
    return { success: false, message: "Link code expired. Click \"Get Link Code\" to get a new one." };
  }

  try {
    const formBody = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: TAK_GOV_CLIENT_ID,
    }).toString();
    const { statusCode, data } = await takGovHttp2Post(TAK_GOV_TOKEN_URL, formBody);

    if (statusCode === 200 && data.access_token) {
      const refreshToken = data.refresh_token;
      const updated = {
        ...takGovLink,
        linked: true,
        refreshToken,
        linkCode: null,
        linkCodeExpiry: null,
        deviceCode: null,
        deviceCodeExpiry: null,
        interval: null,
        verificationUri: null,
      };
      saveManifest({ ...manifest, takGovLink: updated });
      return { success: true, message: "TAK.gov account linked successfully." };
    }

    const err = data?.error;
    const desc = data?.error_description || err;
    if (err === "authorization_pending") {
      return { success: false, message: "Enter the code on TAK.gov and complete authorization, then click \"Link Account\" again." };
    }
    if (err === "expired_token") {
      return { success: false, message: "Link code expired. Click \"Get Link Code\" to get a new one." };
    }
    return { success: false, message: desc || "Linking failed. Try getting a new link code." };
  } catch (err) {
    const msg = err?.message || "Failed to link.";
    console.warn("[plugins.service] TAK.gov token request failed:", msg);
    return { success: false, message: msg };
  }
}

/**
 * Unlink TAK.gov (clears linked state and refresh token; does not remove downloaded plugins).
 */
function unlinkTakGovAccount() {
  const manifest = loadManifest();
  const updated = {
    ...manifest.takGovLink,
    linked: false,
    refreshToken: null,
    linkCode: null,
    linkCodeExpiry: null,
    deviceCode: null,
    deviceCodeExpiry: null,
    interval: null,
    verificationUri: null,
  };
  saveManifest({ ...manifest, takGovLink: updated });
  return { success: true };
}

/**
 * List all installed plugins (from manifest; verifies file still exists).
 */
function listPlugins() {
  const manifest = loadManifest();
  const result = [];
  for (const p of manifest.plugins) {
    const filePath = path.join(PLUGINS_DIR, p.filename || "");
    const exists = fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    result.push({
      ...p,
      exists,
      sizeBytes: exists ? fs.statSync(filePath).size : null,
    });
  }
  return result;
}

/**
 * Generate a unique id for a new plugin entry.
 */
function nextPluginId(plugins) {
  const ids = new Set((plugins || []).map((p) => p.id).filter(Boolean));
  let n = 1;
  while (ids.has("plugin-" + n)) n++;
  return "plugin-" + n;
}

/**
 * Add a plugin from a file path (e.g. after upload or download).
 * @param {string} sourceFilePath - path to the APK or plugin file
 * @param {{ name?: string, source?: string, atakFlavor?: string, atakVersion?: string }} meta
 * @returns {{ success: boolean, plugin?: object, error?: string }}
 */
function addPluginFromFile(sourceFilePath, meta = {}) {
  ensurePluginsDir();
  if (!fs.existsSync(sourceFilePath) || !fs.statSync(sourceFilePath).isFile()) {
    return { success: false, error: "File not found or not a file." };
  }
  const manifest = loadManifest();
  const baseName = path.basename(sourceFilePath);
  const ext = path.extname(baseName);
  const safeName = baseName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const destFileName = safeName;
  const destPath = path.join(PLUGINS_DIR, destFileName);

  // If same filename exists, remove old file and manifest entry
  const existing = manifest.plugins.find((p) => p.filename === destFileName);
  if (existing) {
    try {
      const oldPath = path.join(PLUGINS_DIR, existing.filename);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    } catch (_) {}
    manifest.plugins = manifest.plugins.filter((p) => p.id !== existing.id);
  }

  try {
    fs.copyFileSync(sourceFilePath, destPath);
  } catch (err) {
    return { success: false, error: err?.message || "Failed to copy file." };
  }

  const stat = fs.statSync(destPath);
  const id = nextPluginId(manifest.plugins);
  const plugin = {
    id,
    name: meta.name || path.basename(destFileName, ext) || destFileName,
    filename: destFileName,
    size: stat.size,
    downloadedAt: new Date().toISOString(),
    source: meta.source || "upload",
    atakFlavor: meta.atakFlavor || null,
    atakVersion: meta.atakVersion || null,
    favorite: false,
  };
  manifest.plugins.push(plugin);
  saveManifest(manifest);
  return { success: true, plugin };
}

/**
 * Add a plugin from a URL (download and store).
 * @param {string} downloadUrl - URL to the plugin file (e.g. from TAK.gov or direct link)
 * @param {{ name?: string, source?: string, atakFlavor?: string, atakVersion?: string }} meta
 * @returns {Promise<{ success: boolean, plugin?: object, error?: string }>}
 */
async function addPluginFromUrl(downloadUrl, meta = {}) {
  const axios = require("axios");
  const manifest = loadManifest();
  ensurePluginsDir();

  let response;
  try {
    response = await axios.get(downloadUrl, {
      responseType: "arraybuffer",
      timeout: 120000,
      maxContentLength: 500 * 1024 * 1024, // 500 MB
      validateStatus: (status) => status === 200,
    });
  } catch (err) {
    const msg = err?.response?.status
      ? `HTTP ${err.response.status}`
      : err?.message || "Download failed.";
    return { success: false, error: msg };
  }

  const buffer = Buffer.from(response.data);
  const contentType = response.headers["content-type"] || "";
  const contentDisp = response.headers["content-disposition"] || "";
  let baseName = "plugin.apk";
  const match = contentDisp.match(/filename[*]?=(?:UTF-8'')?["']?([^"'\s;]+)/i) || [];
  if (match[1]) baseName = match[1].trim();
  else if (contentType.includes("octet-stream") || downloadUrl) {
    try {
      const u = new URL(downloadUrl);
      const pathname = u.pathname || "";
      const seg = pathname.split("/").filter(Boolean).pop();
      if (seg && /\.(apk|zip|jar)$/i.test(seg)) baseName = seg;
    } catch (_) {}
  }
  const safeName = baseName.replace(/[^a-zA-Z0-9._-]/g, "_") || "plugin.apk";
  const destPath = path.join(PLUGINS_DIR, safeName);

  const existing = manifest.plugins.find((p) => p.filename === safeName);
  if (existing) {
    try {
      const oldPath = path.join(PLUGINS_DIR, existing.filename);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    } catch (_) {}
    manifest.plugins = manifest.plugins.filter((p) => p.id !== existing.id);
  }

  try {
    fs.writeFileSync(destPath, buffer);
  } catch (err) {
    return { success: false, error: err?.message || "Failed to write file." };
  }

  const stat = fs.statSync(destPath);
  const id = nextPluginId(manifest.plugins);
  const plugin = {
    id,
    name: meta.name || path.basename(safeName, path.extname(safeName)) || safeName,
    filename: safeName,
    size: stat.size,
    downloadedAt: new Date().toISOString(),
    source: meta.source || "tak.gov",
    atakFlavor: meta.atakFlavor || null,
    atakVersion: meta.atakVersion || null,
    favorite: false,
  };
  manifest.plugins.push(plugin);
  saveManifest(manifest);
  return { success: true, plugin };
}

/**
 * Delete a plugin by id: remove from manifest and delete file.
 * @param {string} id - plugin id from manifest
 * @returns {{ success: boolean, error?: string }}
 */
function deletePlugin(id) {
  const manifest = loadManifest();
  const plugin = manifest.plugins.find((p) => p.id === id);
  if (!plugin) {
    return { success: false, error: "Plugin not found." };
  }
  const filePath = path.join(PLUGINS_DIR, plugin.filename);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.warn("[plugins.service] Failed to delete file:", filePath, err?.message || err);
  }
  manifest.plugins = manifest.plugins.filter((p) => p.id !== id);
  saveManifest(manifest);
  return { success: true };
}

/**
 * Get absolute path to a plugin file by id (for streaming/serve).
 */
function getPluginFilePath(id) {
  const manifest = loadManifest();
  const plugin = manifest.plugins.find((p) => p.id === id);
  if (!plugin) return null;
  const filePath = path.join(PLUGINS_DIR, plugin.filename);
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? filePath : null;
}

/**
 * Set favorite flag on a plugin.
 * @param {string} id - plugin id
 * @param {boolean} favorite
 * @returns {{ success: boolean, error?: string }}
 */
function setPluginFavorite(id, favorite) {
  return updatePluginMetadata(id, { favorite });
}

/**
 * Update plugin metadata (description, favorite). At least one of description or favorite must be provided.
 * @param {string} id - plugin id
 * @param {{ description?: string, favorite?: boolean }} updates
 * @returns {{ success: boolean, plugin?: object, error?: string }}
 */
function updatePluginMetadata(id, updates) {
  if (!updates || (updates.description === undefined && updates.favorite === undefined)) {
    return { success: false, error: "Provide at least one of description or favorite." };
  }
  const manifest = loadManifest();
  const plugin = manifest.plugins.find((p) => p.id === id);
  if (!plugin) return { success: false, error: "Plugin not found." };
  if (updates.description !== undefined) plugin.description = typeof updates.description === "string" ? updates.description : null;
  if (updates.favorite !== undefined) plugin.favorite = updates.favorite === true;
  saveManifest(manifest);
  return { success: true, plugin: { ...plugin } };
}

/**
 * Update a TAK.gov-sourced plugin to the latest version from TAK.gov.
 * Fetches plugins for the plugin's atak_version and replaces by package_name.
 * @param {string} id - plugin id (must be source tak.gov with package_name)
 * @returns {Promise<{ success: boolean, plugin?: object, error?: string }>}
 */
async function updatePluginFromTakGov(id) {
  const manifest = loadManifest();
  const plugin = manifest.plugins.find((p) => p.id === id);
  if (!plugin) return { success: false, error: "Plugin not found." };
  if (plugin.source !== "tak.gov" || !plugin.package_name) {
    return { success: false, error: "Only TAK.gov plugins with a package name can be updated." };
  }
  const productVersion = getAtakVersionValue(plugin) || "5.5.0";
  const token = await getTakGovAccessToken();
  if (!token.success) return { success: false, error: token.error };
  const listResult = await fetchTakGovPlugins("ATAK-CIV", productVersion);
  if (!listResult.success) return { success: false, error: listResult.error || "Failed to fetch plugin list." };
  const list = listResult.plugins || [];
  const takGovItem = list.find((p) => p.package_name === plugin.package_name);
  if (!takGovItem) {
    return { success: false, error: "Plugin not found in TAK.gov for this ATAK version." };
  }
  return downloadTakGovPlugin(takGovItem);
}

/**
 * Compare two TAK.gov version/revision: true if remote is newer than current.
 * @param {{ version?: string, revision_code?: number }} current
 * @param {{ version?: string, revision_code?: number }} remote
 */
function isNewerVersion(current, remote) {
  const cv = (current.version || "").trim();
  const rv = (remote.version || "").trim();
  if (!rv) return false;
  if (!cv) return true;
  const cParts = cv.split(".").map((n) => parseInt(n, 10) || 0);
  const rParts = rv.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(cParts.length, rParts.length); i++) {
    const c = cParts[i] || 0;
    const r = rParts[i] || 0;
    if (r > c) return true;
    if (r < c) return false;
  }
  const cr = current.revision_code != null ? current.revision_code : 0;
  const rr = remote.revision_code != null ? remote.revision_code : 0;
  return rr > cr;
}

/**
 * Get which plugins have an update available from TAK.gov.
 * @returns {Promise<Record<string, boolean>>} map of plugin id -> updateAvailable
 */
async function getUpdateStatus() {
  const manifest = loadManifest();
  const takGovPlugins = (manifest.plugins || []).filter((p) => p.source === "tak.gov" && p.package_name);
  if (takGovPlugins.length === 0) return {};
  const versions = new Set();
  takGovPlugins.forEach((p) => {
    const v = getAtakVersionValue(p) || "5.5.0";
    versions.add(v);
  });
  const listByVersion = {};
  for (const productVersion of versions) {
    const result = await fetchTakGovPlugins("ATAK-CIV", productVersion);
    listByVersion[productVersion] = result.success ? (result.plugins || []) : [];
  }
  const out = {};
  for (const p of takGovPlugins) {
    const productVersion = getAtakVersionValue(p) || "5.5.0";
    const list = listByVersion[productVersion] || [];
    const remote = list.find((r) => r.package_name === p.package_name);
    out[p.id] = !!remote && isNewerVersion(p, remote);
  }
  return out;
}

module.exports = {
  PLUGINS_DIR,
  MANIFEST_PATH,
  ensurePluginsDir,
  getTakGovLinkState,
  linkTakGovAccount,
  unlinkTakGovAccount,
  getTakGovAccessToken,
  fetchTakGovPlugins,
  downloadTakGovPlugin,
  listPlugins,
  addPluginFromFile,
  addPluginFromUrl,
  deletePlugin,
  getPluginFilePath,
  setPluginFavorite,
  updatePluginMetadata,
  updatePluginFromTakGov,
  getUpdateStatus,
};
