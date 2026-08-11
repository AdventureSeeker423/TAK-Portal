/**
 * Server-side cache for TAK metrics shown on the dashboard HTML view.
 * Refreshes on a background interval so GET /dashboard does not wait on TAK HTTP.
 * (API routes /api/tak/* still call takMetrics.service directly.)
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

const _state = {
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

async function refreshNow() {
  if (_refreshInFlight) return _refreshInFlight;

  _refreshInFlight = (async () => {
    _state.lastError = null;
    try {
      const [takMetricsBase, subscriptions] = await Promise.all([
        getTakMetricsSnapshot().catch(() => null),
        getSubscriptionsAll().catch(() => null),
      ]);
      _state.takMetrics = applySubscriptionMetricsSplit(takMetricsBase, subscriptions);
      _state.refreshedAt = new Date();
      return _state.takMetrics;
    } catch (err) {
      _state.lastError = err?.message || String(err);
      console.warn("[DASHBOARD] TAK stats cache refresh failed:", err);
      return _state.takMetrics;
    } finally {
      _refreshInFlight = null;
    }
  })();

  return _refreshInFlight;
}

function getDashboardTakSnapshot() {
  const refreshedAt = _state.refreshedAt;
  const ageMs = refreshedAt ? Date.now() - refreshedAt.getTime() : null;
  return {
    takMetrics: _state.takMetrics,
    refreshedAt,
    ageMs,
    error: _state.lastError,
  };
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
  getDashboardTakSnapshot,
  startTakDashboardRefresher,
  stopTakDashboardRefresher,
};
