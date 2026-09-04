/**
 * TAK dashboard stats: worker polls TAK and writes Postgres; web reads that row.
 * GET /dashboard must not wait on TAK HTTP.
 */

const settingsSvc = require("./settings.service");
const {
  getTakMetricsSnapshot,
  getSubscriptionsAll,
  applySubscriptionMetricsSplit,
} = require("./takMetrics.service");

const DEFAULT_REFRESH_SECONDS = 15;
const MIN_REFRESH_SECONDS = 5;

let _refreshInFlight = null;
let _timer = null;
let _pgHydrateInFlight = null;

const _state = {
  metricsBase: null,
  subscriptions: null,
  takMetrics: null,
  refreshedAt: null,
  lastError: null,
};

function parseRefreshSeconds() {
  const settings = settingsSvc.getSettings() || {};
  const raw =
    settings.DASHBOARD_TAK_STATS_REFRESH_SECONDS ??
    process.env.DASHBOARD_TAK_STATS_REFRESH_SECONDS;

  let seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) seconds = DEFAULT_REFRESH_SECONDS;
  if (seconds < MIN_REFRESH_SECONDS) seconds = MIN_REFRESH_SECONDS;

  return Math.floor(seconds);
}

function applyStateFromParts(metricsBase, subscriptions, updatedAt) {
  _state.metricsBase = metricsBase || null;
  _state.subscriptions = subscriptions || null;
  _state.takMetrics = applySubscriptionMetricsSplit(metricsBase, subscriptions) || metricsBase || null;
  _state.refreshedAt = updatedAt ? new Date(updatedAt) : new Date();
}

/**
 * Worker payload: { metricsBase, subscriptions }.
 * Older rows were the already-split metrics object (connectedClients, …).
 */
function ingestPayload(payload, updatedAt) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  if (payload.metricsBase && typeof payload.metricsBase === "object") {
    applyStateFromParts(payload.metricsBase, payload.subscriptions || null, updatedAt);
    return;
  }
  if (payload.metrics && typeof payload.metrics === "object") {
    applyStateFromParts(payload.metrics, payload.subscriptions || null, updatedAt);
    return;
  }
  if ("connectedClients" in payload || "uptimeSeconds" in payload || "diskUsagePercent" in payload) {
    _state.metricsBase = payload;
    _state.subscriptions = null;
    _state.takMetrics = payload;
    _state.refreshedAt = updatedAt ? new Date(updatedAt) : new Date();
  }
}

function metricsFromPayload(payload, options = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const base =
    payload.metricsBase && typeof payload.metricsBase === "object"
      ? payload.metricsBase
      : payload.metrics && typeof payload.metrics === "object"
        ? payload.metrics
        : "connectedClients" in payload || "uptimeSeconds" in payload
          ? payload
          : null;
  if (!base) return null;
  const subs = payload.subscriptions;
  if (subs) return applySubscriptionMetricsSplit(base, subs, options) || base;
  if (options.agencyOnly) return applySubscriptionMetricsSplit(base, subs, options) || base;
  return base;
}

function persistPayload() {
  return {
    metricsBase: _state.metricsBase,
    subscriptions: _state.subscriptions,
  };
}

function fmtPct(n) {
  if (typeof n !== "number" || !isFinite(n)) return "--";
  if (n < 10) return n.toFixed(1).replace(/\.0$/, "");
  return String(Math.round(n));
}

function fmtUptime(seconds) {
  if (typeof seconds !== "number" || !isFinite(seconds)) return "--";
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(d + "d");
  if (h || d) parts.push(h + "h");
  if (s < 86400) parts.push(m + "m");
  return parts.join(" ") || "0m";
}

function viewFields(m) {
  const connectedClients =
    m && typeof m.connectedClients === "number" && isFinite(m.connectedClients)
      ? String(m.connectedClients)
      : "--";
  const connectedIntegrations =
    m && typeof m.connectedIntegrations === "number" && isFinite(m.connectedIntegrations)
      ? String(m.connectedIntegrations)
      : "--";
  return {
    connectedClients,
    connectedIntegrations,
    uptime: fmtUptime(m && m.uptimeSeconds),
    disk: fmtPct(m && m.diskUsagePercent),
  };
}

function snapshotFromState(options = {}) {
  const { authUser = null, agencyOnly = false } = options;
  let takMetrics = _state.takMetrics;
  if (_state.metricsBase && _state.subscriptions) {
    takMetrics =
      applySubscriptionMetricsSplit(_state.metricsBase, _state.subscriptions, {
        authUser,
        agencyOnly,
      }) || _state.metricsBase;
  } else if (agencyOnly && _state.takMetrics && _state.subscriptions) {
    takMetrics =
      applySubscriptionMetricsSplit(_state.takMetrics, _state.subscriptions, {
        authUser,
        agencyOnly,
      }) || _state.takMetrics;
  }
  const refreshedAt = _state.refreshedAt;
  const ageMs = refreshedAt ? Date.now() - refreshedAt.getTime() : null;
  return {
    takMetrics,
    subscriptions: _state.subscriptions,
    refreshedAt,
    ageMs,
    error: _state.lastError,
    view: viewFields(takMetrics),
  };
}

async function hydrateFromPostgres() {
  const db = require("./db");
  if (!db.isConfigured()) return;
  if (_pgHydrateInFlight) {
    await _pgHydrateInFlight;
    return;
  }
  _pgHydrateInFlight = (async () => {
    try {
      const r = await db.query("SELECT payload, updated_at FROM tak_dashboard_stats WHERE id = 1");
      const row = r.rows[0];
      if (row && row.payload) ingestPayload(row.payload, row.updated_at);
    } catch (_) {
      /* keep last in-memory */
    } finally {
      _pgHydrateInFlight = null;
    }
  })();
  await _pgHydrateInFlight;
}

async function refreshNow() {
  if (_refreshInFlight) return _refreshInFlight;

  _refreshInFlight = (async () => {
    _state.lastError = null;
    try {
      const [takMetricsBase, subscriptions] = await Promise.all([
        getTakMetricsSnapshot().catch(() => null),
        getSubscriptionsAll().catch(() => null),
      ]);
      applyStateFromParts(takMetricsBase, subscriptions, new Date());
      return persistPayload();
    } catch (err) {
      _state.lastError = err?.message || String(err);
      console.warn("[DASHBOARD] TAK stats cache refresh failed:", err);
      return persistPayload();
    } finally {
      _refreshInFlight = null;
    }
  })();

  return _refreshInFlight;
}

async function getDashboardTakSnapshot(options = {}) {
  await hydrateFromPostgres();
  return snapshotFromState(options);
}

function startTakDashboardRefresher() {
  if (_timer) return;
  const seconds = parseRefreshSeconds();
  void refreshNow().catch(() => null);
  _timer = setInterval(() => {
    refreshNow().catch(() => null);
  }, seconds * 1000);
}

function stopTakDashboardRefresher() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

module.exports = {
  refreshNow,
  persistPayload,
  ingestPayload,
  metricsFromPayload,
  viewFields,
  getDashboardTakSnapshot,
  startTakDashboardRefresher,
  stopTakDashboardRefresher,
};
