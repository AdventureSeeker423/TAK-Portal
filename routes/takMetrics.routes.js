const router = require("express").Router();
const {
  getTakMetricsSnapshot,
  getSubscriptionsAll,
  applySubscriptionMetricsSplit,
  filterConnectedUserSubscriptions,
  filterFederationSubscriptions,
} = require("../services/takMetrics.service");
const cotStream = require("../services/cotStream.service");
const takGroupControl = require("../services/takGroupControl.service");
const auditSvc = require("../services/auditLog.service");

function requireTakAdmin(req, res) {
  const user = req.authentikUser;
  const isAdmin = !!(user && (user.isGlobalAdmin || user.isAgencyAdmin));
  if (!isAdmin) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return user;
}

function takRouteError(res, err) {
  const status = Number(err?.status) || err?.response?.status || 500;
  let message = err?.message || "TAK request failed";
  const data = err?.response?.data;
  if (typeof data === "string" && data.trim()) message = data;
  else if (data && typeof data === "object") {
    message = data.message || data.error || JSON.stringify(data);
  }
  return res.status(status).json({ error: message });
}

router.get("/metrics", async (req, res) => {
  const user = requireTakAdmin(req, res);
  if (!user) return;

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
  const user = requireTakAdmin(req, res);
  if (!user) return;

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
      cotStream.ensureBridgeStarted();
      result.data = cotStream.enrichSubscriptionsWithLiveMarkerBattery(result.data);
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

router.get("/clients/:clientId/groups", async (req, res) => {
  const user = requireTakAdmin(req, res);
  if (!user) return;

  try {
    const out = await takGroupControl.getClientGroupControlState(req.params.clientId, user);
    return res.json(out);
  } catch (err) {
    return takRouteError(res, err);
  }
});

router.put("/clients/:clientId/groups", async (req, res) => {
  const user = requireTakAdmin(req, res);
  if (!user) return;

  try {
    const active =
      req.body?.active === true
        ? true
        : req.body?.active === false
          ? false
          : null;
    if (active === null) {
      return res.status(400).json({ error: "active must be true or false" });
    }

    const out = await takGroupControl.setClientGroupActive(req.params.clientId, user, {
      groupName: req.body?.groupName,
      direction: req.body?.direction,
      active,
    });

    const changed = out.changed || {};
    auditSvc.logEvent({
      actor: user,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "REMOTE_TOGGLE_CLIENT_GROUP",
      targetType: "tak_client",
      targetId: out.clientUid || String(req.params.clientId || ""),
      details: {
        summary: `${active ? "Enabled" : "Disabled"} ${changed.direction === "IN" ? "WRITE" : "READ"} on "${changed.groupName}" for ${out.callsign || out.username}.`,
        username: out.username,
        callsign: out.callsign,
        clientUid: out.clientUid,
        groupName: changed.groupName,
        direction: changed.direction,
        typeLabel: changed.direction === "IN" ? "WRITE" : "READ",
        active,
      },
    });

    return res.json(out);
  } catch (err) {
    return takRouteError(res, err);
  }
});

module.exports = router;
