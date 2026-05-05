const router = require("express").Router();
const dashboardStatsCache = require("../services/dashboardStatsCache.service");
const takDashboardCache = require("../services/takDashboardCache.service");
const mutualAidService = require("../services/mutualAid.service");
const bookmarksService = require("../services/bookmarks.service");
const agenciesStore = require("../services/agencies.service");

const userRequestsSvc = require("../services/userRequests.service");

router.get("/", async (req, res) => {
  const user = req.authentikUser;
  const isAdmin = !!(user && (user.isGlobalAdmin || user.isAgencyAdmin));
  if (!isAdmin) {
    return res.redirect("/setup-my-device");
  }

  try {
    let snap = dashboardStatsCache.getDashboardStatsSnapshot();
    // First visit after process start used to read all zeros until the delayed background refresh ran.
    if (!snap.refreshedAt) {
      await dashboardStatsCache.refreshNow();
      snap = dashboardStatsCache.getDashboardStatsSnapshot();
    }
    const { stats, charts } = snap;
    const bookmarks = bookmarksService.loadBookmarks();

    // TAK metrics: read server-side background cache (no await on TAK HTTP; client still polls /api/tak/metrics).
    const { takMetrics } = takDashboardCache.getDashboardTakSnapshot();

    // --- Mutual Aid active banners ---
    const pendingUserRequestsCount = userRequestsSvc.countRequestsForUser(req.authentikUser);
    let activeIncidentCount = 0;
    let activeEventCount = 0;
    try {
      const nowMs = Date.now();
      const items = mutualAidService.list();
      for (const it of items) {
        const t = String(it.type || "").trim().toUpperCase();
        const enabled = !!it.expireEnabled;
        const atMs = it.expireAt ? new Date(it.expireAt).getTime() : NaN;
        const expired = enabled && Number.isFinite(atMs) && atMs <= nowMs;
        if (expired) continue;
        if (t === "INCIDENT") activeIncidentCount += 1;
        if (t === "EVENT") activeEventCount += 1;
      }
    } catch (e) {
      console.error("[DASHBOARD] MutualAid stats failed:", e?.message || e);
    }

    const agencies = agenciesStore.load() || [];
    const agencyColors = {};
    for (const a of agencies) {
      const name = String(a.name || "").trim();
      const suffix = String(a.suffix || "").trim().toUpperCase();
      const key = name || suffix;
      if (key) agencyColors[key] = String(a.color || "").trim() || null;
    }

    const usersByAgency = (charts && charts.usersByAgency) || {};
    const typeColors = {};
    for (const type of Object.keys(charts?.usersByType || {})) {
      const typeTrim = String(type || "").trim();
      if (!typeTrim) continue;
      const agenciesOfType = (agencies || []).filter(
        (a) => String(a.type || "").trim() === typeTrim
      );
      let bestColor = null;
      let bestCount = -1;
      for (const a of agenciesOfType) {
        const name = String(a.name || "").trim();
        const suffix = String(a.suffix || "").trim().toUpperCase();
        const key = name || suffix;
        if (!key) continue;
        const count = usersByAgency[key] || 0;
        if (count > bestCount) {
          bestCount = count;
          bestColor = String(a.color || "").trim() || null;
        }
      }
      if (bestColor) typeColors[typeTrim] = bestColor;
    }

    const viewModel = {
      stats: {
        totalUsers: stats?.totalUsers ?? 0,
        totalGroups: stats?.totalGroups ?? 0,
        totalAgencies: stats?.totalAgencies ?? 0,
        totalIntegrations: stats?.totalIntegrations ?? 0,
      },
      mutualAid: {
        activeIncidents: activeIncidentCount,
        activeEvents: activeEventCount,
      },
      charts: charts || {
        usersByAgency: {},
        unknownAgency: 0,
        usersByType: {},
        unknownType: 0,
      },
      agencyColors,
      typeColors,
      bookmarks,
      takMetrics,
      pendingUserRequestsCount, 
    };

    res.render("dashboard", viewModel);
  } catch (err) {
    console.error("[DASHBOARD] failed:", err?.message || err);

    const bookmarks = bookmarksService.loadBookmarks();
    const { takMetrics: cachedTak } = takDashboardCache.getDashboardTakSnapshot();
    const viewModel = {
      stats: {
        totalUsers: 0,
        totalGroups: 0,
        totalAgencies: 0,
        totalIntegrations: 0,
      },
      mutualAid: {
        activeIncidents: 0,
        activeEvents: 0,
      },
      charts: {
        usersByAgency: {},
        unknownAgency: 0,
        usersByType: {},
        unknownType: 0,
      },
      agencyColors: {},
      typeColors: {},
      bookmarks,
      takMetrics: cachedTak,
      pendingUserRequestsCount: userRequestsSvc.countRequestsForUser(req.authentikUser), 
      error: err?.response?.data || err?.message || "Failed to load dashboard",
    };

    res.status(500).render("dashboard", viewModel);
  }
});

module.exports = router;
