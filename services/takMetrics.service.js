/**
 * services/takMetrics.service.js
 *
 * Pull operational metrics from TAK Server.
 *
 * ONLY exposes what we still use:
 *   - Connected Clients (custom network endpoint)
 *   - Server Uptime (Spring actuator metric)
 *   - Disk Usage (custom disk endpoint)
 *
 * Reads config from settings.json via services/env.js (settings first, then process.env):
 *   TAK_URL
 *   TAK_DEBUG
 *   TAK_API_P12_PATH / TAK_API_P12_PASSPHRASE   OR   TAK_API_CERT_PATH / TAK_API_KEY_PATH
 *   TAK_CA_PATH
 *
 * Optional smoothing config (still used for sampling freshness / buffering):
 *   TAK_METRICS_SAMPLE_INTERVAL_MS  (default 2000)
 *   TAK_METRICS_WINDOW_SAMPLES      (default 5)
 *   TAK_METRICS_MAX_SAMPLE_AGE_MS   (default 15000)
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const axios = require("axios");
const { URL } = require("url");
const { getBool, getString } = require("./env");
const { attachCookieStore, getSharedTakCookieStore } = require("./takHttpSession");

function resolvePathMaybe(p) {
  const v = String(p || "").trim();
  if (!v) return "";
  if (path.isAbsolute(v)) return v;
  return path.resolve(process.cwd(), v);
}

function normalizeBase(urlLike) {
  const raw = String(urlLike || "").trim();
  if (!raw) return "";
  const u = new URL(raw);
  u.pathname = u.pathname.replace(/\/+$/, "");
  return u.toString().replace(/\/+$/, "");
}

function getHostRootFromTakUrl(takUrl) {
  // If TAK_URL is https://host:8443/Marti, actuator lives at https://host:8443
  const u = new URL(String(takUrl || "").trim());
  u.pathname = "";
  u.search = "";
  u.hash = "";
  return u.toString().replace(/\/+$/, "");
}

function normalizePemCertificateChain(pemCertificate) {
  return String(pemCertificate)
    .replace(/\r\n/g, "\n")
    .split("-----BEGIN CERTIFICATE-----")
    .join("-----BEGIN CERTIFICATE-----\n")
    .split("-----END CERTIFICATE-----")
    .join("\n-----END CERTIFICATE-----")
    .trim();
}

function normalizePemKey(pemKey) {
  let key = String(pemKey).replace(/\r\n/g, "\n").trim();

  if (key.includes("-----BEGIN RSA PRIVATE KEY-----")) {
    key = key
      .split("-----BEGIN RSA PRIVATE KEY-----")
      .join("-----BEGIN RSA PRIVATE KEY-----\n")
      .split("-----END RSA PRIVATE KEY-----")
      .join("\n-----END RSA PRIVATE KEY-----")
      .trim();
  }

  if (key.includes("-----BEGIN PRIVATE KEY-----")) {
    key = key
      .split("-----BEGIN PRIVATE KEY-----")
      .join("-----BEGIN PRIVATE KEY-----\n")
      .split("-----END PRIVATE KEY-----")
      .join("\n-----END PRIVATE KEY-----")
      .trim();
  }

  return key;
}

function buildTakAxios() {
  const TAK_DEBUG = getBool("TAK_DEBUG", false);

  const p12Path = resolvePathMaybe(getString("TAK_API_P12_PATH", ""));
  const p12Pass = String(getString("TAK_API_P12_PASSPHRASE", "")); // allow empty

  const certPath = resolvePathMaybe(getString("TAK_API_CERT_PATH", ""));
  const keyPath = resolvePathMaybe(getString("TAK_API_KEY_PATH", ""));
  const keyPass = getString("TAK_API_KEY_PASSPHRASE", "")
    ? String(getString("TAK_API_KEY_PASSPHRASE", ""))
    : undefined;

  const caPath = resolvePathMaybe(getString("TAK_CA_PATH", ""));

  const agentOptions = {
    keepAlive: true,
    ca: caPath ? fs.readFileSync(caPath) : undefined,
    rejectUnauthorized: true,
    // keep previous behavior (skip hostname verification)
    checkServerIdentity: () => undefined,
  };

  if (p12Path) {
    const { getPemFromP12 } = require("p12-pem");
    const certs = getPemFromP12(p12Path, p12Pass);

    if (!certs?.pemCertificate) throw new Error("TAK metrics: Unable to extract certificate(s) from P12");
    if (!certs?.pemKey) throw new Error("TAK metrics: Unable to extract private key from P12");

    agentOptions.cert = normalizePemCertificateChain(certs.pemCertificate);
    agentOptions.key = normalizePemKey(certs.pemKey);
  } else if (certPath && keyPath) {
    agentOptions.cert = fs.readFileSync(certPath);
    agentOptions.key = fs.readFileSync(keyPath);
    if (keyPass) agentOptions.passphrase = keyPass;
  }

  const httpsAgent = new https.Agent(agentOptions);

  const client = axios.create({
    httpsAgent,
    timeout: 10_000,
    maxRedirects: 0,
    validateStatus: (s) => s >= 200 && s < 500,
  });

  attachCookieStore(client, getSharedTakCookieStore());

  if (TAK_DEBUG) {
    client.interceptors.request.use((cfg) => {
      // eslint-disable-next-line no-console
      console.log("[TAK][metrics] ->", cfg.method?.toUpperCase(), cfg.url);
      return cfg;
    });
    client.interceptors.response.use((res) => {
      // eslint-disable-next-line no-console
      console.log("[TAK][metrics] <-", res.status, res.config?.url);
      return res;
    });
  }

  return client;
}

let _metricsAxios = null;

function getMetricsAxios() {
  if (!_metricsAxios) _metricsAxios = buildTakAxios();
  return _metricsAxios;
}

/**
 * Shared HTTPS agent for outbound requests to TAK (mTLS: same P12/cert as Marti API).
 * Used by locate relay and anywhere else that needs GET/POST to TAK URLs without the Marti baseURL.
 *
 * @param {{ allowInsecureServerCert?: boolean }} [opts] - If true, sets rejectUnauthorized: false (lab); still sends client cert.
 */
function buildTakMtlsHttpsAgent(opts = {}) {
  const allowInsecureServer =
    opts.allowInsecureServerCert === true || getBool("TAK_LOCATE_RELAY_TLS_INSECURE", false);

  const p12Path = resolvePathMaybe(getString("TAK_API_P12_PATH", ""));
  const p12Pass = String(getString("TAK_API_P12_PASSPHRASE", ""));

  const certPath = resolvePathMaybe(getString("TAK_API_CERT_PATH", ""));
  const keyPath = resolvePathMaybe(getString("TAK_API_KEY_PATH", ""));
  const keyPass = getString("TAK_API_KEY_PASSPHRASE", "")
    ? String(getString("TAK_API_KEY_PASSPHRASE", ""))
    : undefined;

  const caPath = resolvePathMaybe(getString("TAK_CA_PATH", ""));

  if (!p12Path && (!certPath || !keyPath)) {
    throw new Error(
      "TAK API client certificate is required (TAK_API_P12_PATH or TAK_API_CERT_PATH + TAK_API_KEY_PATH). " +
        "The locate relay uses the same mTLS credentials as other TAK API calls."
    );
  }

  const agentOptions = {
    ca: caPath ? fs.readFileSync(caPath) : undefined,
    rejectUnauthorized: !allowInsecureServer,
    checkServerIdentity: () => undefined,
  };

  if (p12Path) {
    const { getPemFromP12 } = require("p12-pem");
    const certs = getPemFromP12(p12Path, p12Pass);

    if (!certs?.pemCertificate) throw new Error("TAK locate relay: Unable to extract certificate(s) from P12");
    if (!certs?.pemKey) throw new Error("TAK locate relay: Unable to extract private key from P12");

    agentOptions.cert = normalizePemCertificateChain(certs.pemCertificate);
    agentOptions.key = normalizePemKey(certs.pemKey);
  } else {
    agentOptions.cert = fs.readFileSync(certPath);
    agentOptions.key = fs.readFileSync(keyPath);
    if (keyPass) agentOptions.passphrase = keyPass;
  }

  return new https.Agent(agentOptions);
}

function pickNumber(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      const n = Number(obj[k]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function clampPct(x) {
  if (!Number.isFinite(x)) return null;
  return Math.max(0, Math.min(100, x));
}

async function safeGetJson(client, url) {
  const res = await client.get(url, { headers: { Accept: "application/json" } });
  if (res.status >= 200 && res.status < 300) return res.data;
  return null;
}

// ---- Custom endpoints (your TAK server) ----

async function getDiskFromCustomEndpoint(client, actuatorBase) {
  const data = await safeGetJson(client, `${actuatorBase}/actuator/custom-disk-metrics`);
  if (!data) return null;

  const total = pickNumber(data, ["totalSpace"]);
  const used = pickNumber(data, ["usedSpace"]);
  const free = pickNumber(data, ["freeSpace"]);
  const usable = pickNumber(data, ["usableSpace"]);

  const diskUsagePercent =
    Number.isFinite(used) && Number.isFinite(total) && total > 0
      ? clampPct((used / total) * 100)
      : null;

  return {
    totalSpace: Number.isFinite(total) ? total : null,
    usedSpace: Number.isFinite(used) ? used : null,
    freeSpace: Number.isFinite(free) ? free : null,
    usableSpace: Number.isFinite(usable) ? usable : null,
    diskUsagePercent,
    raw: data,
  };
}

async function getNetworkFromCustomEndpoint(client, actuatorBase) {
  const data = await safeGetJson(client, `${actuatorBase}/actuator/custom-network-metrics`);
  if (!data) return null;

  const numClients = pickNumber(data, ["numClients"]);
  const bytesRead = pickNumber(data, ["bytesRead"]);
  const bytesWritten = pickNumber(data, ["bytesWritten"]);
  const numReads = pickNumber(data, ["numReads"]);
  const numWrites = pickNumber(data, ["numWrites"]);

  return {
    numClients: Number.isFinite(numClients) ? numClients : null,
    bytesRead: Number.isFinite(bytesRead) ? bytesRead : null,
    bytesWritten: Number.isFinite(bytesWritten) ? bytesWritten : null,
    numReads: Number.isFinite(numReads) ? numReads : null,
    numWrites: Number.isFinite(numWrites) ? numWrites : null,
    raw: data,
  };
}

// ---- Spring metric for uptime ----

async function getSpringMetricValue(client, actuatorBase, name) {
  const data = await safeGetJson(client, `${actuatorBase}/actuator/metrics/${encodeURIComponent(name)}`);
  if (!data || typeof data !== "object") return null;

  if (typeof data.value === "number") return data.value;
  const m = Array.isArray(data.measurements) ? data.measurements : [];
  const first = m.find((x) => x && typeof x.value === "number");
  return first ? first.value : null;
}

async function getUptimeSeconds(client, actuatorBase) {
  const up = await getSpringMetricValue(client, actuatorBase, "process.uptime");
  if (!Number.isFinite(up)) return null;
  return up;
}

// ---------------------------
// Sampling Buffer (freshness)
// ---------------------------

const SAMPLE_INTERVAL_MS = Number(process.env.TAK_METRICS_SAMPLE_INTERVAL_MS ?? 2000);
const WINDOW_SAMPLES = Math.max(1, Number(process.env.TAK_METRICS_WINDOW_SAMPLES ?? 5));
const MAX_SAMPLE_AGE_MS = Math.max(1000, Number(process.env.TAK_METRICS_MAX_SAMPLE_AGE_MS ?? 15000));
const METRICS_CACHE_TTL_MS = Math.max(
  1000,
  Number(process.env.TAK_METRICS_CACHE_TTL_MS ?? 5000)
);
const SUBSCRIPTIONS_CACHE_TTL_MS = Math.max(
  1000,
  Number(process.env.TAK_SUBSCRIPTIONS_CACHE_TTL_MS ?? 15000)
);

let _samplerStarted = false;
let _sampleTimer = null;
let _metricsCache = null;
let _metricsCacheTs = 0;
let _metricsInFlight = null;
let _subscriptionsCache = null;
let _subscriptionsCacheTs = 0;
let _subscriptionsInFlight = null;
let _subscriptionsFullCache = null;
let _subscriptionsFullCacheTs = 0;
let _subscriptionsFullInFlight = null;

/** Each sample: { ts, disk, net, uptimeSeconds } */
let _samples = [];

function pushSample(s) {
  _samples.push(s);
  // keep buffer bounded
  const maxKeep = Math.max(WINDOW_SAMPLES * 3, WINDOW_SAMPLES + 2);
  if (_samples.length > maxKeep) {
    _samples.splice(0, _samples.length - maxKeep);
  }
}

function isFreshEnough() {
  const last = _samples[_samples.length - 1];
  if (!last) return false;
  return Date.now() - last.ts <= MAX_SAMPLE_AGE_MS;
}

function takeWindowSamples() {
  const now = Date.now();
  // Only consider relatively recent samples (avoid averaging across a long downtime)
  const recent = _samples.filter((s) => now - s.ts <= MAX_SAMPLE_AGE_MS);
  if (!recent.length) return [];
  return recent.slice(Math.max(0, recent.length - WINDOW_SAMPLES));
}

function startSamplerIfNeeded({ client, actuatorBase }) {
  if (_samplerStarted) return;
  _samplerStarted = true;

  const tick = async () => {
    try {
      const [disk, net, uptimeSeconds] = await Promise.all([
        getDiskFromCustomEndpoint(client, actuatorBase).catch(() => null),
        getNetworkFromCustomEndpoint(client, actuatorBase).catch(() => null),
        getUptimeSeconds(client, actuatorBase).catch(() => null),
      ]);

      pushSample({
        ts: Date.now(),
        disk,
        net,
        uptimeSeconds,
      });
    } catch {
      // swallow; next tick will try again
    }
  };

  // Prime immediately (don’t wait for first interval)
  void tick();

  _sampleTimer = setInterval(tick, SAMPLE_INTERVAL_MS);
  // don't keep node alive solely for this timer
  if (typeof _sampleTimer.unref === "function") _sampleTimer.unref();
}

// ---- Snapshot ----

async function buildTakMetricsSnapshot() {
  const takUrl = getString("TAK_URL", "");
  if (!String(takUrl || "").trim()) {
    return { configured: false, fetchedAt: new Date().toISOString() };
  }

  const base = normalizeBase(takUrl);
  const root = getHostRootFromTakUrl(base);
  const actuatorBase = root;

  const client = getMetricsAxios();

  // Start background sampler (collects samples even if snapshot isn't called often)
  startSamplerIfNeeded({ client, actuatorBase });

  // If we have no fresh sample, do a one-off immediate fetch to avoid returning nulls
  if (!isFreshEnough()) {
    try {
      const [disk, net, uptimeSeconds] = await Promise.all([
        getDiskFromCustomEndpoint(client, actuatorBase).catch(() => null),
        getNetworkFromCustomEndpoint(client, actuatorBase).catch(() => null),
        getUptimeSeconds(client, actuatorBase).catch(() => null),
      ]);
      pushSample({ ts: Date.now(), disk, net, uptimeSeconds });
    } catch {
      // ignore
    }
  }

  const window = takeWindowSamples();
  const latest = window[window.length - 1] || _samples[_samples.length - 1] || null;

  const diskOut = latest?.disk
    ? {
        totalSpace: latest.disk.totalSpace,
        usedSpace: latest.disk.usedSpace,
        freeSpace: latest.disk.freeSpace,
        usableSpace: latest.disk.usableSpace,
      }
    : null;

  const netOut = latest?.net
    ? {
        bytesRead: latest.net.bytesRead,
        bytesWritten: latest.net.bytesWritten,
        numReads: latest.net.numReads,
        numWrites: latest.net.numWrites,
      }
    : null;

  return {
    configured: true,
    fetchedAt: new Date().toISOString(),

    sampleWindow: {
      intervalMs: SAMPLE_INTERVAL_MS,
      windowSamples: window.length,
      maxSampleAgeMs: MAX_SAMPLE_AGE_MS,
    },

    // What you said you use:
    connectedClients: latest?.net?.numClients ?? null,

    uptimeSeconds: latest?.uptimeSeconds ?? null,

    diskUsagePercent: latest?.disk?.diskUsagePercent ?? null,
    disk: diskOut,

    // Optional detail if you still want it downstream:
    network: netOut,
  };
}

async function getTakMetricsSnapshot() {
  const now = Date.now();
  if (_metricsCache && now - _metricsCacheTs <= METRICS_CACHE_TTL_MS) {
    return { ..._metricsCache };
  }

  if (_metricsInFlight) {
    const snapshot = await _metricsInFlight;
    return snapshot ? { ...snapshot } : snapshot;
  }

  _metricsInFlight = buildTakMetricsSnapshot()
    .then((snapshot) => {
      _metricsCache = snapshot;
      _metricsCacheTs = Date.now();
      return snapshot;
    })
    .finally(() => {
      _metricsInFlight = null;
    });

  const snapshot = await _metricsInFlight;
  return snapshot ? { ...snapshot } : snapshot;
}

// ---- Marti subscriptions (connected clients list) ----

const NODERED_PREFIX = "nodered-";
const TLS_CALLSIGN_PREFIX = "tls:";

/**
 * Federation hubs often appear with long colon-separated hex token usernames
 * (not portal/TAK usernames). Hide these from Connected Users and exclude from counts.
 */
function isFederationTokenUsername(username) {
  const u = String(username || "").trim();
  if (!u || u.indexOf(":") < 0) return false;
  const parts = u.split(":");
  if (parts.length < 6) return false;
  return parts.every((part) => /^[0-9a-f]{2}$/i.test(part));
}

function isNoderedUsername(username) {
  const u = String(username || "").trim().toLowerCase();
  return u.indexOf(NODERED_PREFIX) === 0;
}

function isTlsCallsign(callsign) {
  const c = String(callsign || "").trim().toLowerCase();
  return c.indexOf(TLS_CALLSIGN_PREFIX) === 0;
}

function isTlsCallsignSubscription(item) {
  return isTlsCallsign(item && (item.callsign || item.callSign));
}

/** Channel-patch bridge / rebroadcast ghosts on the webadmin stream. */
function isChannelPatchBridgeSubscription(item) {
  const cs = String(item && item.callsign || "").trim().toLowerCase();
  const uid = String(item && (item.uid || item.clientUid) || "").trim().toLowerCase();
  if (cs === "tak-portal") return true;
  if (uid === "takportal-channel-patch-bridge") return true;
  if (cs.includes(".takportal.") || uid.includes(".takportal.")) return true;
  return false;
}

function isBlankConnectedField(value) {
  const s = String(value == null ? "" : value).trim();
  return !s || /^[—–−\-]+$/.test(s);
}

function isEmptyConnectedClient(item) {
  const username = pickConnectedUsername(item);
  const callsign = String((item && (item.callsign || item.callSign)) || "").trim();
  return isBlankConnectedField(username) && isBlankConnectedField(callsign);
}

function isExcludedConnectedUserSubscription(item) {
  const username = pickConnectedUsername(item);
  return (
    isEmptyConnectedClient(item) ||
    isNoderedUsername(username) ||
    isFederationTokenUsername(username) ||
    isTlsCallsignSubscription(item) ||
    isChannelPatchBridgeSubscription(item)
  );
}

function subscriptionMatchesAgencyScope(authUser, username, agencyOnly) {
  if (!agencyOnly || !authUser) return true;
  const accessSvc = require("./access.service");
  return accessSvc.isUsernameInAllowedAgencySuffixes(authUser, username);
}

/** Remove federation hub token rows; keep nodered (needed by integrations page). */
function filterFederationSubscriptions(list) {
  return (Array.isArray(list) ? list : []).filter((item) => {
    if (isEmptyConnectedClient(item)) return false;
    return !isFederationTokenUsername(pickConnectedUsername(item));
  });
}

/** Human connected users for dashboard list/count (no nodered, no federation). */
function filterConnectedUserSubscriptions(list, options = {}) {
  const { authUser = null, agencyOnly = false } = options;
  return filterFederationSubscriptions(list).filter((item) => {
    if (isEmptyConnectedClient(item)) return false;
    const username = pickConnectedUsername(item);
    if (isNoderedUsername(username)) return false;
    if (isTlsCallsignSubscription(item)) return false;
    if (isChannelPatchBridgeSubscription(item)) return false;
    return subscriptionMatchesAgencyScope(authUser, username, agencyOnly);
  });
}

function computeSubscriptionExclusionCounts(list, options = {}) {
  const { authUser = null, agencyOnly = false } = options;
  let noderedCount = 0;
  let federationCount = 0;
  let tlsCallsignCount = 0;
  // Marti can retain stale/ghost sessions for the same integration (e.g. an old
  // tls:24x row lingering after Node-RED reconnected as tls:25x). Track distinct
  // integration usernames so the "Connected Integrations" stat isn't inflated by
  // duplicate sessions, while still subtracting every nodered row from clients.
  const noderedUsernames = new Set();

  for (const item of Array.isArray(list) ? list : []) {
    const username = pickConnectedUsername(item);
    if (isNoderedUsername(username)) {
      if (subscriptionMatchesAgencyScope(authUser, username, agencyOnly)) {
        noderedCount += 1;
        noderedUsernames.add(String(username).trim().toLowerCase());
      }
    } else if (!agencyOnly && isFederationTokenUsername(username)) {
      federationCount += 1;
    } else if (!agencyOnly && isTlsCallsignSubscription(item)) {
      tlsCallsignCount += 1;
    }
  }

  return {
    noderedCount,
    noderedDistinctCount: noderedUsernames.size,
    federationCount,
    tlsCallsignCount,
  };
}

function applySubscriptionMetricsSplit(takMetricsBase, subscriptions, options = {}) {
  if (!takMetricsBase || !subscriptions) return takMetricsBase;
  const list = Array.isArray(subscriptions.data) ? subscriptions.data : [];
  const { authUser = null, agencyOnly = false } = options;
  const { noderedCount, noderedDistinctCount, federationCount, tlsCallsignCount } =
    computeSubscriptionExclusionCounts(list, options);

  // Agency dashboard: count only subscriptions whose username matches allowed agency suffixes (tail or prefix).
  if (agencyOnly && authUser) {
    const connectedClients = filterConnectedUserSubscriptions(list, {
      authUser,
      agencyOnly: true,
    }).length;
    return {
      ...takMetricsBase,
      connectedClients,
    };
  }

  const total =
    typeof takMetricsBase.connectedClients === "number" ? takMetricsBase.connectedClients : 0;

  return {
    ...takMetricsBase,
    connectedClients: Math.max(0, total - noderedCount - federationCount - tlsCallsignCount),
    connectedIntegrations: noderedDistinctCount,
  };
}

function unwrapMartiList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return null;
}

async function fetchMartiList(client, url, params) {
  const res = await client.get(url, {
    headers: { Accept: "application/json" },
    params: params || undefined,
  });
  if (res.status !== 200 || !res.data) return null;
  return unwrapMartiList(res.data);
}

function pickConnectedUsername(row) {
  const user = row?.user;
  const lastSa = row?.lastSA || row?.lastSa;
  const candidates = [
    row?.username,
    row?.userName,
    row?.user_name,
    typeof user === "string" ? user : "",
    user && typeof user === "object" ? user.name : "",
    user && typeof user === "object" ? user.identifier : "",
    user && typeof user === "object" ? user.username : "",
    lastSa && typeof lastSa === "object" ? lastSa.username : "",
    row?.xn,
  ];
  for (const raw of candidates) {
    if (isBlankConnectedField(raw)) continue;
    return String(raw).trim();
  }
  return "";
}

function connectedRowUid(row) {
  return String(
    row?.uid || row?.clientUid || row?.subscriptionUid || row?.deviceUid || row?.lastSA?.uid || ""
  )
    .trim()
    .toLowerCase();
}

function connectedRowCallsign(row) {
  return String(row?.callsign || row?.callSign || "")
    .trim()
    .toLowerCase();
}

function indexConnectedRows(rows) {
  const byUid = new Map();
  const byCallsign = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object") continue;
    const uid = connectedRowUid(row);
    const cs = connectedRowCallsign(row);
    if (uid) byUid.set(uid, row);
    if (cs && !isBlankConnectedField(cs)) byCallsign.set(cs, row);
  }
  return { byUid, byCallsign };
}

const CONNECTED_DISPLAY_KEYS = [
  "team",
  "role",
  "takv",
  "takClient",
  "platform",
  "version",
  "takVersion",
  "appVersion",
  "clientVersion",
];

function enrichLiveConnectedRow(liveRow, contact) {
  const out = Object.assign({}, liveRow);
  if (contact) {
    if (!pickConnectedUsername(out)) {
      const username = pickConnectedUsername(contact);
      if (username) out.username = username;
    }
    if (isBlankConnectedField(out.callsign || out.callSign)) {
      const cs = contact.callsign || contact.callSign;
      if (!isBlankConnectedField(cs)) out.callsign = cs;
    }
    for (const key of CONNECTED_DISPLAY_KEYS) {
      if (isBlankConnectedField(out[key]) && !isBlankConnectedField(contact[key])) {
        out[key] = contact[key];
      }
    }
  }
  const username = pickConnectedUsername(out);
  if (username && out.username !== username) out.username = username;
  return out;
}

/**
 * Live connected membership comes from currently-connected clientEndPoints.
 * Contacts lite is a display lookup (team/role/takv) and never adds extra rows.
 * If endpoints is missing (fetch failed), fall back to the contacts/subscription list.
 */
function mergeClientEndpointUsernames(contacts, endpoints) {
  const liveIsEndpoints = Array.isArray(endpoints);
  const live = liveIsEndpoints
    ? endpoints
    : Array.isArray(contacts)
      ? contacts
      : [];
  if (!live.length) return [];
  if (!liveIsEndpoints) return live.map((row) => enrichLiveConnectedRow(row, null));

  const { byUid, byCallsign } = indexConnectedRows(contacts);
  return live.map((row) => {
    const uid = connectedRowUid(row);
    const cs = connectedRowCallsign(row);
    const contact = (uid && byUid.get(uid)) || (cs && byCallsign.get(cs)) || null;
    return enrichLiveConnectedRow(row, contact);
  });
}

function cleanTakClientLabel(value) {
  return String(value || "")
    .trim()
    .replace(/[:\-_\s]+$/g, "");
}

function parseTakvFields(raw) {
  if (raw && typeof raw === "object") {
    const attrs = raw._attributes || raw;
    return {
      takClient: cleanTakClientLabel(attrs.platform || attrs.device || ""),
      version: String(attrs.version || "").trim(),
    };
  }
  const s = String(raw || "").trim();
  if (!s) return { takClient: "", version: "" };

  const colon = s.lastIndexOf(":");
  if (colon > 0) {
    const left = s.slice(0, colon).trim();
    const right = s.slice(colon + 1).trim();
    if (!right || /\d+(?:\.\d+)+/.test(right)) {
      return { takClient: cleanTakClientLabel(left), version: right };
    }
  }

  const versionMatch = s.match(/(\d+(?:\.\d+)+.*)$/);
  if (!versionMatch) return { takClient: cleanTakClientLabel(s), version: "" };
  const version = String(versionMatch[1] || "").trim();
  return {
    takClient: cleanTakClientLabel(s.slice(0, Math.max(0, s.length - version.length))),
    version,
  };
}

/** Table/dashboard fields only — never keep Marti group vectors. */
function normalizeConnectedClientRow(row) {
  if (!row || typeof row !== "object") return null;
  const uid = String(
    row.clientUid || row.uid || row.subscriptionUid || row.deviceUid || ""
  ).trim();
  const parsed = parseTakvFields(row.takv);
  const takClient = cleanTakClientLabel(row.takClient || row.platform || parsed.takClient || "");
  const version = String(
    row.version || row.takVersion || row.appVersion || row.clientVersion || parsed.version || ""
  ).trim();
  const usernameRaw = pickConnectedUsername(row);
  const callsignRaw = String(row.callsign || row.callSign || "").trim();
  const username = isBlankConnectedField(usernameRaw) ? "" : usernameRaw;
  const callsign = isBlankConnectedField(callsignRaw) ? "" : callsignRaw;
  // Keep live sessions that only have a uid yet; drop true ghosts with no identity.
  if (!uid && !username && !callsign) return null;
  return {
    username,
    callsign,
    takClient,
    platform: takClient,
    team: String(row.team || "").trim(),
    role: String(row.role || "").trim(),
    takv: row.takv,
    version,
    clientUid: uid,
    subscriptionUid: String(row.subscriptionUid || uid).trim(),
    uid: String(row.uid || uid).trim(),
    clientUuid: row.clientUuid != null ? String(row.clientUuid).trim() : "",
    connectionUid: row.connectionUid != null ? String(row.connectionUid).trim() : "",
    deviceUid: row.deviceUid != null ? String(row.deviceUid).trim() : "",
  };
}

async function fetchContactsLookup(client, base) {
  const liteUrls = [`${base}/api/contacts/all/lite`, `${base}/api/contacts/all`];
  for (const url of liteUrls) {
    try {
      const list = await fetchMartiList(client, url);
      if (Array.isArray(list)) return list;
    } catch (_) {
      /* try next lite path */
    }
  }
  return null;
}

/**
 * Connected-client list for dashboard counts/table.
 * Live membership is currently-connected clientEndPoints. Contacts lite is a
 * display lookup only. `/api/subscriptions/all` is the slow fallback if
 * endpoints cannot be fetched.
 */
async function fetchSubscriptionsAll() {
  const takUrl = getString("TAK_URL", "");
  if (!String(takUrl || "").trim()) {
    return { configured: false, data: [] };
  }

  const base = normalizeBase(takUrl);
  const client = getMetricsAxios();
  const endpointsPromise = fetchMartiList(client, `${base}/api/clientEndPoints`, {
    showCurrentlyConnectedClients: true,
  }).catch(() => null);
  const contactsPromise = fetchContactsLookup(client, base).catch(() => null);

  const [endpoints, contacts] = await Promise.all([endpointsPromise, contactsPromise]);
  let liveMembership = Array.isArray(endpoints) ? endpoints : null;
  if (liveMembership === null) {
    try {
      const list = await fetchMartiList(client, `${base}/api/subscriptions/all`);
      liveMembership = Array.isArray(list) ? list : null;
    } catch (_) {
      liveMembership = null;
    }
  }

  const merged = mergeClientEndpointUsernames(
    Array.isArray(contacts) ? contacts : [],
    liveMembership
  );
  return {
    configured: true,
    data: merged.map(normalizeConnectedClientRow).filter(Boolean),
  };
}

async function attachPortalUsernames(list) {
  const rows = Array.isArray(list) ? list : [];
  const missing = [];
  for (const row of rows) {
    if (!isBlankConnectedField(pickConnectedUsername(row))) continue;
    const callsign = String(row?.callsign || row?.callSign || "").trim();
    if (!isBlankConnectedField(callsign)) missing.push(callsign);
  }
  if (!missing.length) return rows;
  try {
    const directoryRepo = require("./directoryRepo.service");
    const byKey = await directoryRepo.getUsersByCallsignKeys(missing);
    if (!byKey || !byKey.size) return rows;
    return rows.map((row) => {
      if (!isBlankConnectedField(pickConnectedUsername(row))) return row;
      const callsign = String(row?.callsign || row?.callSign || "").trim().toLowerCase();
      const username = (callsign && byKey.get(callsign)) || "";
      if (!username) return row;
      return Object.assign({}, row, { username });
    });
  } catch (_) {
    return rows;
  }
}

async function finalizeConnectedClientList(result) {
  if (!result || !Array.isArray(result.data)) return result;
  const withNames = await attachPortalUsernames(result.data);
  return {
    ...result,
    data: withNames,
  };
}

async function readDashboardSubscriptionsCache() {
  const dash = require("./takDashboardCache.service");
  const snap = await dash.getDashboardTakSnapshot();
  const cached = snap && snap.subscriptions;
  if (!(cached && Array.isArray(cached.data))) return null;
  const refreshedAt = snap.refreshedAt ? new Date(snap.refreshedAt).getTime() : 0;
  return { cached, refreshedAt };
}

/**
 * Connected-client list for dashboard counts/table (live endpoints + contacts lookup).
 * Default: worker Postgres snapshot (refreshed ~15s). Memory is used only when
 * it is at least as new as that snapshot.
 * `{ live: true }` always hits TAK — used by the worker refresher.
 */
async function getSubscriptionsAll(options = {}) {
  const live = options.live === true;
  const now = Date.now();

  if (!live) {
    try {
      const fromDash = await readDashboardSubscriptionsCache();
      if (fromDash) {
        const memoryFresh =
          _subscriptionsCache &&
          now - _subscriptionsCacheTs <= SUBSCRIPTIONS_CACHE_TTL_MS &&
          (!fromDash.refreshedAt || _subscriptionsCacheTs >= fromDash.refreshedAt);
        if (memoryFresh) {
          return finalizeConnectedClientList({
            ..._subscriptionsCache,
            data: Array.isArray(_subscriptionsCache.data) ? _subscriptionsCache.data.slice() : [],
          });
        }
        _subscriptionsCache = {
          ...fromDash.cached,
          data: fromDash.cached.data.slice(),
        };
        _subscriptionsCacheTs = fromDash.refreshedAt || Date.now();
        return finalizeConnectedClientList({
          ..._subscriptionsCache,
          data: _subscriptionsCache.data.slice(),
        });
      }
    } catch (_) {
      /* fall through to memory / live TAK */
    }
    if (_subscriptionsCache && now - _subscriptionsCacheTs <= SUBSCRIPTIONS_CACHE_TTL_MS) {
      return finalizeConnectedClientList({
        ..._subscriptionsCache,
        data: Array.isArray(_subscriptionsCache.data) ? _subscriptionsCache.data.slice() : [],
      });
    }
  }

  if (_subscriptionsInFlight) {
    const snapshot = await _subscriptionsInFlight;
    return finalizeConnectedClientList(snapshot ? { ...snapshot } : snapshot);
  }

  _subscriptionsInFlight = fetchSubscriptionsAll()
    .then((result) => {
      _subscriptionsCache = result;
      _subscriptionsCacheTs = Date.now();
      return result;
    })
    .catch((err) => {
      if (_subscriptionsCache) return _subscriptionsCache;
      return {
        configured: true,
        data: [],
        error: err?.response?.data || err?.message || "Failed to fetch subscriptions",
      };
    })
    .finally(() => {
      _subscriptionsInFlight = null;
    });

  const result = await _subscriptionsInFlight;
  return finalizeConnectedClientList(result ? { ...result } : result);
}

async function fetchSubscriptionsAllFull() {
  const takUrl = getString("TAK_URL", "");
  if (!String(takUrl || "").trim()) {
    return { configured: false, data: [] };
  }
  const base = normalizeBase(takUrl);
  const client = getMetricsAxios();
  const list = await fetchMartiList(client, `${base}/api/subscriptions/all`);
  return { configured: true, data: Array.isArray(list) ? list : [] };
}

async function getSubscriptionsAllFull() {
  const now = Date.now();
  if (_subscriptionsFullCache && now - _subscriptionsFullCacheTs <= SUBSCRIPTIONS_CACHE_TTL_MS) {
    return { ..._subscriptionsFullCache };
  }
  if (_subscriptionsFullInFlight) {
    const snapshot = await _subscriptionsFullInFlight;
    return snapshot ? { ...snapshot } : snapshot;
  }
  _subscriptionsFullInFlight = fetchSubscriptionsAllFull()
    .then((result) => {
      _subscriptionsFullCache = result;
      _subscriptionsFullCacheTs = Date.now();
      return result;
    })
    .catch((err) => {
      if (_subscriptionsFullCache) return _subscriptionsFullCache;
      return {
        configured: true,
        data: [],
        error: err?.response?.data || err?.message || "Failed to fetch subscriptions",
      };
    })
    .finally(() => {
      _subscriptionsFullInFlight = null;
    });
  const result = await _subscriptionsFullInFlight;
  return result ? { ...result } : result;
}

/** Dashboard/map client list only — drop Marti group payloads from the HTTP response. */
function slimSubscriptionForClientList(item) {
  if (!item || typeof item !== "object") return item;
  return {
    username: item.username,
    callsign: item.callsign,
    takClient: item.takClient,
    platform: item.platform,
    team: item.team,
    role: item.role,
    battery: item.battery,
    version: item.version,
    takVersion: item.takVersion,
    appVersion: item.appVersion,
    clientVersion: item.clientVersion,
    takv: item.takv,
    clientUid: item.clientUid,
    subscriptionUid: item.subscriptionUid,
    uid: item.uid,
    clientUuid: item.clientUuid,
    connectionUid: item.connectionUid,
    deviceUid: item.deviceUid,
  };
}

function slimSubscriptionsForClientList(list) {
  return (Array.isArray(list) ? list : []).map(slimSubscriptionForClientList);
}

module.exports = {
  getTakMetricsSnapshot,
  getSubscriptionsAll,
  getSubscriptionsAllFull,
  slimSubscriptionsForClientList,
  normalizeConnectedClientRow,
  parseTakvFields,
  mergeClientEndpointUsernames,
  isEmptyConnectedClient,
  buildTakMtlsHttpsAgent,
  isFederationTokenUsername,
  isNoderedUsername,
  isTlsCallsign,
  isTlsCallsignSubscription,
  isExcludedConnectedUserSubscription,
  filterFederationSubscriptions,
  filterConnectedUserSubscriptions,
  applySubscriptionMetricsSplit,
};
