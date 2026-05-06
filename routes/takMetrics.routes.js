const router = require("express").Router();
const { getTakMetricsSnapshot, getSubscriptionsAll } = require("../services/takMetrics.service");
const accessSvc = require("../services/access.service");

const NODERED_PREFIX = "nodered-";

router.get("/metrics", async (req, res) => {
  const user = req.authentikUser;
  const isAdmin = !!(user && (user.isGlobalAdmin || user.isAgencyAdmin));
  if (!isAdmin) return res.status(403).json({ error: "Forbidden" });

  try {
    const metrics = await getTakMetricsSnapshot();
    try {
      const sub = await getSubscriptionsAll();
      const list = Array.isArray(sub.data) ? sub.data : [];
      const noderedCount = list.filter((item) => {
        const u = (item.username != null ? String(item.username).trim() : "").toLowerCase();
        return u.indexOf(NODERED_PREFIX) === 0;
      }).length;
      const total = typeof metrics.connectedClients === "number" ? metrics.connectedClients : 0;
      metrics.connectedClients = Math.max(0, total - noderedCount);
      metrics.connectedIntegrations = noderedCount;
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
    // TAK subscription rows only include usernames (no Authentik attributes).
    if (result.data && result.configured && user && user.isAgencyAdmin && !user.isGlobalAdmin) {
      result.data = result.data.filter((item) =>
        accessSvc.isUsernameInAllowedAgencies(user, item && item.username)
      );
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
