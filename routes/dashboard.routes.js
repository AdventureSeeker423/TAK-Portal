const router = require("express").Router();
const dashboardStatsCache = require("../services/dashboardStatsCache.service");
const takDashboardCache = require("../services/takDashboardCache.service");
const {
  getSubscriptionsAll,
  applySubscriptionMetricsSplit,
} = require("../services/takMetrics.service");
const mutualAidService = require("../services/mutualAid.service");
const bookmarksService = require("../services/bookmarks.service");
const agenciesStore = require("../services/agencies.service");
const accessSvc = require("../services/access.service");
const mouService = require("../services/mouService");
const mapPageAssets = require("../services/mapPageAssets.service");
const mapBasemapsConfig = require("../config/mapBasemaps");

const userRequestsSvc = require("../services/userRequests.service");
const { hasAcceptedAgreementForSession } = require("../services/userAgreementSession.service");

function mapRenderLocals(req) {
  const mapUserKey = String(
    req.authentikUser?.uid || req.authentikUser?.username || "anonymous"
  ).replace(/[^a-zA-Z0-9._-]/g, "_");
  const settings = require("../services/settings.service").getSettings() || {};
  return {
    ...mapPageAssets.getRenderLocals(),
    mapStorageUserKey: mapUserKey,
    defaultMapSource: mapBasemapsConfig.getDefaultMapSource(settings),
  };
}

function agreementLocalsForRequest(req) {
  const currentAgreement = mouService.getCurrentUserAgreement().current;
  return {
    agreementSummary: mouService.getAgreementSummaryForUser(req.authentikUser, {
      acceptedForSession: hasAcceptedAgreementForSession(
        req,
        req.authentikUser,
        currentAgreement
      ),
    }),
  };
}

router.get("/", async (req, res) => {
  const user = req.authentikUser;
  const isAdmin = !!(user && (user.isGlobalAdmin || user.isAgencyAdmin));
  if (!isAdmin) {
    return res.redirect("/setup-my-device");
  }

  try {
    const isAgencyOnly = !!(user && user.isAgencyAdmin && !user.isGlobalAdmin);
    const bookmarks = bookmarksService.loadBookmarks();
    let { takMetrics } = takDashboardCache.getDashboardTakSnapshot();

    const pendingUserRequestsCount = userRequestsSvc.countRequestsForUser(req.authentikUser);
    const pendingMouDocumentsCount =
      user?.isAgencyAdmin && mouService.isEnabled()
        ? mouService
            .getAgencySignatureStatusRows()
            .filter(
              (row) =>
                row?.needsSignature &&
                accessSvc.isSuffixAllowed(req.authentikUser, row?.agencyId)
            ).length
        : 0;
    let activeIncidentCount = 0;
    let activeEventCount = 0;
    try {
      const nowMs = Date.now();
      const items = mutualAidService.listForUser(req.authentikUser || null);
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

    let stats;
    let charts;
    let agencyColors = {};
    let typeColors = {};
    let isAgencyDashboard = false;
    let isMultiAgencyDashboard = false;
    let agencyDisplayName = null;
    let templateChartColor = null;

    if (isAgencyOnly) {
      isAgencyDashboard = true;
      const allowedSuffixes = Array.isArray(user?.allowedAgencySuffixes)
        ? user.allowedAgencySuffixes
        : [];
      isMultiAgencyDashboard = allowedSuffixes.length > 1;
      const agencySnap = await dashboardStatsCache.getAgencyDashboardForUser(req.authentikUser);
      agencyDisplayName = agencySnap.agencyDisplayName || "Agency";
      const managed = agencySnap.managedAgencies || [];
      stats = {
        totalUsers: agencySnap.stats?.totalUsers ?? 0,
        totalGroups: agencySnap.stats?.totalGroups ?? 0,
        totalAgencies: isMultiAgencyDashboard ? managed.length : 0,
        totalIntegrations: 0,
      };
      charts = {
        usersByTemplate: agencySnap.charts?.usersByTemplate || {},
        usersByAgency: agencySnap.charts?.usersByAgency || {},
      };
      for (const a of managed) {
        const name = String(a.name || "").trim();
        if (name) agencyColors[name] = a.color || null;
      }
      if (managed.length === 1 && managed[0].color) {
        templateChartColor = managed[0].color;
      }
    } else {
      let snap = dashboardStatsCache.getDashboardStatsSnapshot();
      if (!snap.refreshedAt) {
        await dashboardStatsCache.refreshNow();
        snap = dashboardStatsCache.getDashboardStatsSnapshot();
      }
      stats = {
        totalUsers: snap.stats?.totalUsers ?? 0,
        totalGroups: snap.stats?.totalGroups ?? 0,
        totalAgencies: snap.stats?.totalAgencies ?? 0,
        totalIntegrations: snap.stats?.totalIntegrations ?? 0,
      };
      charts = snap.charts || {
        usersByAgency: {},
        unknownAgency: 0,
        usersByType: {},
        unknownType: 0,
      };

      const agencies = agenciesStore.load() || [];
      for (const a of agencies) {
        const name = String(a.name || "").trim();
        const suffix = String(a.suffix || "").trim().toUpperCase();
        const key = name || suffix;
        if (key) agencyColors[key] = String(a.color || "").trim() || null;
      }

      const usersByAgency = charts.usersByAgency || {};
      for (const type of Object.keys(charts.usersByType || {})) {
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
    }

    if (isAgencyOnly && takMetrics) {
      try {
        const sub = await getSubscriptionsAll();
        takMetrics = applySubscriptionMetricsSplit(takMetrics, sub, {
          authUser: req.authentikUser,
          agencyOnly: true,
        });
      } catch (e) {
        console.warn("[DASHBOARD] Agency TAK metrics adjustment failed:", e?.message || e);
      }
    }

    const viewModel = {
      stats,
      mutualAid: {
        activeIncidents: activeIncidentCount,
        activeEvents: activeEventCount,
      },
      charts,
      agencyColors,
      typeColors,
      bookmarks,
      takMetrics,
      pendingUserRequestsCount,
      pendingMouDocumentsCount,
      isAgencyDashboard,
      isMultiAgencyDashboard,
      agencyDisplayName,
      templateChartColor,
      ...mapRenderLocals(req),
      ...agreementLocalsForRequest(req),
    };

    res.render("dashboard", viewModel);
  } catch (err) {
    console.error("[DASHBOARD] failed:", err?.message || err);

    const bookmarks = bookmarksService.loadBookmarks();
    const { takMetrics: cachedTak } = takDashboardCache.getDashboardTakSnapshot();
    const isAgencyOnly = !!(user && user.isAgencyAdmin && !user.isGlobalAdmin);
    const allowedSuffixes = Array.isArray(user?.allowedAgencySuffixes)
      ? user.allowedAgencySuffixes
      : [];
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
      charts: isAgencyOnly
        ? { usersByTemplate: {}, usersByAgency: {} }
        : {
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
      pendingMouDocumentsCount:
        user?.isAgencyAdmin && mouService.isEnabled()
          ? mouService
              .getAgencySignatureStatusRows()
              .filter(
                (row) =>
                  row?.needsSignature &&
                  accessSvc.isSuffixAllowed(req.authentikUser, row?.agencyId)
              ).length
          : 0,
      isAgencyDashboard: isAgencyOnly,
      isMultiAgencyDashboard: isAgencyOnly && allowedSuffixes.length > 1,
      agencyDisplayName: isAgencyOnly ? "Agency Dashboard" : null,
      templateChartColor: null,
      error: err?.response?.data || err?.message || "Failed to load dashboard",
      ...mapRenderLocals(req),
      ...agreementLocalsForRequest(req),
    };

    res.status(500).render("dashboard", viewModel);
  }
});

module.exports = router;
