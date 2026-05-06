const settingsSvc = require("./settings.service");
const usersService = require("./users.service");
const groupsService = require("./groups.service");
const agenciesStore = require("./agencies.service");
const accessSvc = require("./access.service");

const DEFAULT_REFRESH_SECONDS = 300;
const MIN_REFRESH_SECONDS = 30;
const DEFAULT_INITIAL_DELAY_SECONDS = 8;

/** Coalesces concurrent refreshNow() calls so waiters get the same result, not stale zeros. */
let _refreshInFlight = null;

const _state = {
  timer: null,
  lastError: null,
  refreshedAt: null,
  snapshot: {
    stats: {
      totalUsers: 0,
      totalGroups: 0,
      totalAgencies: 0,
      totalIntegrations: 0,
    },
    charts: {
      usersByAgency: {},
      unknownAgency: 0,
      usersByType: {},
      unknownType: 0,
    },
  },
};

function parseRefreshSeconds() {
  const settings = settingsSvc.getSettings() || {};

  const raw =
    settings.DASHBOARD_AUTHENTIK_STATS_REFRESH_SECONDS ??
    process.env.DASHBOARD_AUTHENTIK_STATS_REFRESH_SECONDS;

  let seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) seconds = DEFAULT_REFRESH_SECONDS;
  if (seconds < MIN_REFRESH_SECONDS) seconds = MIN_REFRESH_SECONDS;

  return Math.floor(seconds);
}

function parseInitialDelaySeconds() {
  const settings = settingsSvc.getSettings() || {};

  const raw =
    settings.DASHBOARD_AUTHENTIK_STATS_INITIAL_DELAY_SECONDS ??
    process.env.DASHBOARD_AUTHENTIK_STATS_INITIAL_DELAY_SECONDS;

  let seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) seconds = DEFAULT_INITIAL_DELAY_SECONDS;
  return Math.floor(seconds);
}

function buildCharts(users, agencies) {
  const agenciesNorm = (agencies || [])
    .map((a) => ({
      name: String(a.name || "").trim(),
      type: String(a.type || "").trim(), // Fire, EMS, Law, etc
      suffix: String(a.suffix || "").trim().toLowerCase(),
    }))
    .filter((a) => a.name && a.suffix);

  // Fast lookup: suffix -> agency record
  const bySuffix = new Map();
  for (const a of agenciesNorm) bySuffix.set(a.suffix, a);

  const usersByAgency = {};
  const usersByType = {};
  let unknownAgency = 0;
  let unknownType = 0;

  for (const u of users || []) {
    const suffix = accessSvc.resolveAgencySuffixFromUser(u);
    const agency = suffix ? bySuffix.get(suffix) : null;

    if (!agency) {
      unknownAgency += 1;
      unknownType += 1;
      continue;
    }

    const agencyName = agency.name || suffix.toUpperCase();
    const agencyType = agency.type || "Unknown";

    usersByAgency[agencyName] = (usersByAgency[agencyName] || 0) + 1;
    usersByType[agencyType] = (usersByType[agencyType] || 0) + 1;
  }

  return { usersByAgency, unknownAgency, usersByType, unknownType };
}

async function refreshNow() {
  if (_refreshInFlight) return _refreshInFlight;

  _refreshInFlight = (async () => {
    _state.lastError = null;

    try {
      // One lightweight user-directory pass + groups in parallel (avoids doubling Authentik work).
      const [{ visibleUsers, integrationCount }, groups] = await Promise.all([
        usersService.fetchUsersForDashboardStats(),
        groupsService.getAllGroups(), // <-- use portal logic
      ]);

      // Local data (agencies)
      const agencies = agenciesStore.load();

      const charts = buildCharts(visibleUsers || [], agencies || []);

      _state.snapshot = {
        stats: {
          totalUsers: Array.isArray(visibleUsers) ? visibleUsers.length : 0,
          totalGroups: Array.isArray(groups) ? groups.length : 0,
          totalAgencies: Array.isArray(agencies) ? agencies.length : 0,
          totalIntegrations: integrationCount,
        },
        charts,
      };

      _state.refreshedAt = new Date();
      return _state.snapshot;
    } catch (err) {
      _state.lastError = err?.message || String(err);
      console.warn("[DASHBOARD] Authentik stats cache refresh failed:", err);
      // Avoid unbounded /dashboard awaits when Authentik is down and we never had a successful refresh.
      if (!_state.refreshedAt) {
        _state.refreshedAt = new Date();
      }
      return _state.snapshot; // keep last good snapshot
    } finally {
      _refreshInFlight = null;
    }
  })();

  return _refreshInFlight;
}

function stopDashboardStatsRefresher() {
  if (_state.timer) {
    clearInterval(_state.timer);
    _state.timer = null;
  }
}

function startDashboardStatsRefresher() {
  // If already running, do nothing (use restartDashboardStatsRefresher to reconfigure)
  if (_state.timer) return;

  const seconds = parseRefreshSeconds();
  const initialDelaySeconds = parseInitialDelaySeconds();

  // Prime immediately so /dashboard is not stuck on zeros until the old "first refresh after delay" runs.
  void refreshNow().catch(() => null);

  // Optional second pass after startup so Authentik/network can settle (same intent as before).
  if (initialDelaySeconds > 0) {
    setTimeout(() => {
      refreshNow().catch(() => null);
    }, initialDelaySeconds * 1000).unref?.();
  }

  _state.timer = setInterval(() => {
    refreshNow().catch(() => null);
  }, seconds * 1000);

  console.log(
    `[DASHBOARD] Authentik stats cache enabled: immediate refresh + optional settle at ${initialDelaySeconds}s, then every ${seconds}s`
  );
}

function restartDashboardStatsRefresher() {
  stopDashboardStatsRefresher();
  startDashboardStatsRefresher();
}

function getDashboardStatsSnapshot() {
  const refreshedAt = _state.refreshedAt;
  const ageMs = refreshedAt ? Date.now() - refreshedAt.getTime() : null;

  return {
    ..._state.snapshot,
    refreshedAt,
    ageMs,
    error: _state.lastError,
  };
}

module.exports = {
  startDashboardStatsRefresher,
  stopDashboardStatsRefresher,
  restartDashboardStatsRefresher,
  refreshNow,
  getDashboardStatsSnapshot,
};
