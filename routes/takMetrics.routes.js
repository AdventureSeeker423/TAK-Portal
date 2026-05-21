const router = require("express").Router();
const {
  getTakMetricsSnapshot,
  getSubscriptionsAll,
  applySubscriptionMetricsSplit,
  filterConnectedUserSubscriptions,
  filterFederationSubscriptions,
} = require("../services/takMetrics.service");

router.get("/metrics", async (req, res) => {
  const user = req.authentikUser;
  const isAdmin = !!(user && (user.isGlobalAdmin || user.isAgencyAdmin));
  if (!isAdmin) return res.status(403).json({ error: "Forbidden" });

  try {
    let metrics = await getTakMetricsSnapshot();
    try {
      const sub = await getSubscriptionsAll();
      const isAgencyOnly = !!(user && user.isAgencyAdmin && !user.isGlobalAdmin);
      metrics = applySubscriptionMetricsSplit(metrics, sub, {
        authUser: user,
        agencyOnly: isAgencyOnly,
      });
    } catch (_) {
      // leave metrics.connectedClients as-is if subscriptions fetch fails
    }
    return res.json(metrics);
  } catch (err) {
    return res.status(500).json({
      error: err?.response?.data || err?.message || "Failed to fetch TAK metrics",
    });
  }
});

router.get("/subscriptions", async (req, res) => {
  const user = req.authentikUser;
  const isAdmin = !!(user && (user.isGlobalAdmin || user.isAgencyAdmin));
  if (!isAdmin) return res.status(403).json({ error: "Forbidden" });

  try {
    const result = await getSubscriptionsAll();
    if (result.data && result.configured) {
      const isAgencyOnly = !!(user && user.isAgencyAdmin && !user.isGlobalAdmin);
      result.data = isAgencyOnly
        ? filterConnectedUserSubscriptions(result.data, {
            authUser: user,
            agencyOnly: true,
          })
        : filterFederationSubscriptions(result.data);
    }
    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      configured: true,
      data: [],
      error: err?.message || "Failed to fetch subscriptions",
    });
  }
});

module.exports = router;
