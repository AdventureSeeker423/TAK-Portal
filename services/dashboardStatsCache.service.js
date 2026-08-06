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

/** Per normalized agency name: coalesced refresh promises. */
const _agencyRefreshInFlight = new Map();

/** @type {Map<string, object>} */
const _agencySnapshots = new Map();

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

function normalizeAgencyNameKey(agencyName) {
  return String(agencyName || "").trim().toLowerCase();
}

function isAgencySnapshotStale(entry) {
  if (!entry || !entry.refreshedAt) return true;
  const ageMs = Date.now() - entry.refreshedAt.getTime();
  return ageMs > parseRefreshSeconds() * 1000;
}

function resolveManagedAgenciesForUser(authUser) {
  const access = accessSvc.getAgencyAccess(authUser);
  const allowed = access.allowedAgencySuffixes || [];
  const all = agenciesStore.load() || [];
  const byNameKey = new Map();

  for (const sfx of allowed) {
    const norm = String(sfx || "").trim().toLowerCase();
    if (!norm) continue;
    const agency = all.find((a) => String(a.suffix || "").trim().toLowerCase() === norm);
    if (!agency) continue;
    const name = String(agency.name || "").trim();
    if (!name) continue;
    const key = normalizeAgencyNameKey(name);
    if (byNameKey.has(key)) continue;
    byNameKey.set(key, {
      name,
      suffix: norm,
      groupPrefix: String(agency.groupPrefix || "").trim(),
      color: String(agency.color || "").trim() || null,
    });
  }

  return Array.from(byNameKey.values());
}

async function refreshAgencyNow(agencyName, { expectedAgencySuffix, groupPrefix, authUser } = {}) {
  const name = String(agencyName || "").trim();
  const key = normalizeAgencyNameKey(name);
  if (!key) {
    throw new Error("Agency name is required for agency dashboard refresh");
  }

  if (_agencyRefreshInFlight.has(key)) {
    return _agencyRefreshInFlight.get(key);
  }

  const refreshPromise = (async () => {
    const prev = _agencySnapshots.get(key);
    try {
      const [totalUsers, usersByTemplate, groups] = await Promise.all([
        usersService.countUsersByAgencyName(name),
        usersService.buildUsersByTemplateForAgencyName(name, { expectedAgencySuffix }),
        groupsService.getAllGroups(),
      ]);

      const filteredGroups = accessSvc.filterAgencySpecificGroupsForDashboard(
        groups || [],
        name || groupPrefix
      );

      const entry = {
        agencyName: name,
        expectedAgencySuffix: String(expectedAgencySuffix || "").trim().toLowerCase(),
        stats: {
          totalUsers: Number(totalUsers) || 0,
          totalGroups: Array.isArray(filteredGroups) ? filteredGroups.length : 0,
        },
        charts: {
          usersByTemplate: usersByTemplate || {},
        },
        refreshedAt: new Date(),
        error: null,
      };
      _agencySnapshots.set(key, entry);
      return entry;
    } catch (err) {
      console.warn(
        `[DASHBOARD] Agency stats cache refresh failed (${name}):`,
        err?.message || err
      );
      const entry = {
        agencyName: name,
        expectedAgencySuffix: String(expectedAgencySuffix || "").trim().toLowerCase(),
        stats: prev?.stats || { totalUsers: 0, totalGroups: 0 },
        charts: prev?.charts || { usersByTemplate: {} },
        refreshedAt: new Date(),
        error: err?.message || String(err),
      };
      _agencySnapshots.set(key, entry);
      return entry;
    } finally {
      _agencyRefreshInFlight.delete(key);
    }
  })();

  _agencyRefreshInFlight.set(key, refreshPromise);
  return refreshPromise;
}

async function getAgencyDashboardSnapshot(
  agencyName,
  { expectedAgencySuffix, groupPrefix, authUser } = {}
) {
  const name = String(agencyName || "").trim();
  const key = normalizeAgencyNameKey(name);
  if (!key) {
    return {
      agencyName: "",
      stats: { totalUsers: 0, totalGroups: 0 },
      charts: { usersByTemplate: {} },
      refreshedAt: null,
      error: "Missing agency name",
    };
  }

  const cached = _agencySnapshots.get(key);
  if (!isAgencySnapshotStale(cached)) {
    return cached;
  }

  return refreshAgencyNow(name, { expectedAgencySuffix, groupPrefix, authUser });
}

function mergeAgencySnapshots(snapshots, managedAgencies) {
  const list = Array.isArray(snapshots) ? snapshots.filter(Boolean) : [];
  const managed = Array.isArray(managedAgencies) ? managedAgencies : [];
  let totalUsers = 0;
  const usersByTemplate = {};
  const usersByAgency = {};
  let totalGroups = 0;
  let refreshedAt = null;
  const errors = [];

  for (let i = 0; i < list.length; i++) {
    const snap = list[i];
    totalUsers += Number(snap?.stats?.totalUsers) || 0;
    const tmplMap = snap?.charts?.usersByTemplate || {};
    for (const [label, count] of Object.entries(tmplMap)) {
      usersByTemplate[label] = (usersByTemplate[label] || 0) + (Number(count) || 0);
    }
    const agencyName = String(
      managed[i]?.name || snap?.agencyName || ""
    ).trim();
    if (agencyName) {
      usersByAgency[agencyName] = Number(snap?.stats?.totalUsers) || 0;
    }
    if (snap?.refreshedAt) {
      const t = snap.refreshedAt instanceof Date ? snap.refreshedAt : new Date(snap.refreshedAt);
      if (!refreshedAt || t > refreshedAt) refreshedAt = t;
    }
    totalGroups += Number(snap?.stats?.totalGroups) || 0;
    if (snap?.error) errors.push(snap.error);
  }

  return {
    stats: { totalUsers, totalGroups },
    charts: { usersByTemplate, usersByAgency },
    refreshedAt,
    error: errors.length ? errors.join("; ") : null,
  };
}

function invalidateAgencyDashboardSnapshots() {
  _agencySnapshots.clear();
}

/**
 * Call after agencies.json changes (create, edit, delete, rename).
 * Clears per-agency dashboard cache and refreshes global dashboard stats in the background.
 */
function refreshAfterAgenciesChanged() {
  invalidateAgencyDashboardSnapshots();
  void refreshNow().catch((err) => {
    console.warn("[DASHBOARD] refresh after agencies change failed:", err?.message || err);
  });
}

/**
 * Call after bulk user changes (e.g. CSV import).
 * Clears per-agency dashboard cache and refreshes global dashboard stats in the background.
 */
function refreshAfterUsersChanged() {
  invalidateAgencyDashboardSnapshots();
  void refreshNow().catch((err) => {
    console.warn("[DASHBOARD] refresh after users change failed:", err?.message || err);
  });
}

async function getAgencyDashboardForUser(authUser) {
  const managed = resolveManagedAgenciesForUser(authUser);
  if (!managed.length) {
    return {
      managedAgencies: [],
      agencyDisplayName: "Agency Dashboard",
      stats: { totalUsers: 0, totalGroups: 0 },
      charts: { usersByTemplate: {} },
      refreshedAt: null,
      error: null,
    };
  }

  const snapshots = await Promise.all(
    managed.map((agency) =>
      getAgencyDashboardSnapshot(agency.name, {
        expectedAgencySuffix: agency.suffix,
        groupPrefix: agency.groupPrefix,
        authUser,
      })
    )
  );

  const merged = mergeAgencySnapshots(snapshots, managed);
  const agencyDisplayName =
    managed.length === 1 ? managed[0].name : "Multi-Agency";

  return {
    managedAgencies: managed,
    agencyDisplayName,
    ...merged,
  };
}

module.exports = {
  startDashboardStatsRefresher,
  stopDashboardStatsRefresher,
  restartDashboardStatsRefresher,
  refreshNow,
  refreshAfterAgenciesChanged,
  refreshAfterUsersChanged,
  invalidateAgencyDashboardSnapshots,
  getDashboardStatsSnapshot,
  normalizeAgencyNameKey,
  resolveManagedAgenciesForUser,
  refreshAgencyNow,
  getAgencyDashboardSnapshot,
  getAgencyDashboardForUser,
};
