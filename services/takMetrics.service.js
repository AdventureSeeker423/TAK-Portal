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

  const client = buildTakAxios();

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

function isExcludedConnectedUserSubscription(item) {
  const username = item && item.username;
  return isNoderedUsername(username) || isFederationTokenUsername(username);
}

function subscriptionMatchesAgencyScope(authUser, username, agencyOnly) {
  if (!agencyOnly || !authUser) return true;
  const accessSvc = require("./access.service");
  return accessSvc.isUsernameInAllowedAgencySuffixes(authUser, username);
}

/** Remove federation hub token rows; keep nodered (needed by integrations page). */
function filterFederationSubscriptions(list) {
  return (Array.isArray(list) ? list : []).filter(
    (item) => !isFederationTokenUsername(item && item.username)
  );
}

/** Human connected users for dashboard list/count (no nodered, no federation). */
function filterConnectedUserSubscriptions(list, options = {}) {
  const { authUser = null, agencyOnly = false } = options;
  return filterFederationSubscriptions(list).filter((item) => {
    if (isNoderedUsername(item && item.username)) return false;
    return subscriptionMatchesAgencyScope(authUser, item && item.username, agencyOnly);
  });
}

function computeSubscriptionExclusionCounts(list, options = {}) {
  const { authUser = null, agencyOnly = false } = options;
  let noderedCount = 0;
  let federationCount = 0;

  for (const item of Array.isArray(list) ? list : []) {
    const username = item && item.username;
    if (isNoderedUsername(username)) {
      if (subscriptionMatchesAgencyScope(authUser, username, agencyOnly)) {
        noderedCount += 1;
      }
    } else if (!agencyOnly && isFederationTokenUsername(username)) {
      federationCount += 1;
    }
  }

  return { noderedCount, federationCount };
}

function applySubscriptionMetricsSplit(takMetricsBase, subscriptions, options = {}) {
  if (!takMetricsBase || !subscriptions) return takMetricsBase;
  const list = Array.isArray(subscriptions.data) ? subscriptions.data : [];
  const { authUser = null, agencyOnly = false } = options;
  const { noderedCount, federationCount } = computeSubscriptionExclusionCounts(list, options);

  // Agency dashboard: count only subscriptions whose username matches allowed agency suffixes.
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
    connectedClients: Math.max(0, total - noderedCount - federationCount),
    connectedIntegrations: noderedCount,
  };
}

async function fetchSubscriptionsAll() {
  const takUrl = getString("TAK_URL", "");
  if (!String(takUrl || "").trim()) {
    return { configured: false, data: [] };
  }

  const base = normalizeBase(takUrl);
  const client = buildTakAxios();
  const url = `${base}/api/subscriptions/all`;

  try {
    const res = await client.get(url, { headers: { Accept: "application/json" } });
    if (res.status !== 200 || !res.data) return { configured: true, data: [] };
    const list = Array.isArray(res.data.data) ? res.data.data : [];
    return { configured: true, data: list };
  } catch (err) {
    throw err;
  }
}

async function getSubscriptionsAll() {
  const now = Date.now();
  if (_subscriptionsCache && now - _subscriptionsCacheTs <= SUBSCRIPTIONS_CACHE_TTL_MS) {
    return { ..._subscriptionsCache };
  }

  if (_subscriptionsInFlight) {
    const snapshot = await _subscriptionsInFlight;
    return snapshot ? { ...snapshot } : snapshot;
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
  return result ? { ...result } : result;
}

module.exports = {
  getTakMetricsSnapshot,
  getSubscriptionsAll,
  buildTakMtlsHttpsAgent,
  isFederationTokenUsername,
  isNoderedUsername,
  isExcludedConnectedUserSubscription,
  filterFederationSubscriptions,
  filterConnectedUserSubscriptions,
  applySubscriptionMetricsSplit,
};
