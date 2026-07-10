const router = require("express").Router();
const {
  getTakMetricsSnapshot,
  getSubscriptionsAll,
  applySubscriptionMetricsSplit,
  filterConnectedUserSubscriptions,
  filterFederationSubscriptions,
} = require("../services/takMetrics.service");
const cotStream = require("../services/cotStream.service");
const mapRender = require("../services/mapRender.service");
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

function pickBestLiveMarker(markers) {
  const list = Array.isArray(markers) ? markers : [];
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  const eud = list.filter((m) => String(m?.origin || "").toLowerCase() === "eud");
  const pool = eud.length ? eud : list;
  pool.sort((a, b) => {
    const ta = a?.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const tb = b?.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return tb - ta;
  });
  return pool[0];
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
      accessMode: req.body?.accessMode,
      direction: req.body?.direction,
      active,
    });

    const changed = out.changed || {};
    const accessLabel = changed.accessMode || "GROUP";
    auditSvc.logEvent({
      actor: user,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "REMOTE_TOGGLE_CLIENT_GROUP",
      targetType: "tak_client",
      targetId: out.clientUid || String(req.params.clientId || ""),
      details: {
        summary: `${active ? "Enabled" : "Disabled"} ${accessLabel} on "${changed.groupName}" for ${out.callsign || out.username}.`,
        username: out.username,
        callsign: out.callsign,
        clientUid: out.clientUid,
        groupName: changed.groupName,
        accessMode: changed.accessMode,
        typeLabel: accessLabel,
        active,
      },
    });

    return res.json(out);
  } catch (err) {
    return takRouteError(res, err);
  }
});

router.get("/clients/:clientId/preference-config", async (req, res) => {
  const user = requireTakAdmin(req, res);
  if (!user) return;

  try {
    const out = await takGroupControl.getClientPreferenceConfig(req.params.clientId, user);
    return res.json(out);
  } catch (err) {
    return takRouteError(res, err);
  }
});

router.post("/clients/:clientId/send-preference-config", async (req, res) => {
  const user = requireTakAdmin(req, res);
  if (!user) return;

  try {
    const out = await takGroupControl.sendClientPreferenceConfig(req.params.clientId, user, {
      callsign: req.body?.callsign,
      teamLabel: req.body?.teamLabel ?? req.body?.team,
      roleLabel: req.body?.roleLabel ?? req.body?.role,
    });

    auditSvc.logEvent({
      actor: user,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "REMOTE_SEND_PREFERENCE_CONFIG",
      targetType: "tak_client",
      targetId: out.clientUid || String(req.params.clientId || ""),
      details: {
        summary: `Sent preference configuration (${out.packageName}) to ${out.callsign || out.username}.`,
        username: out.username,
        clientUid: out.clientUid,
        callsign: out.callsign,
        teamLabel: out.teamLabel,
        roleLabel: out.roleLabel,
        packageName: out.packageName,
      },
    });

    return res.json(out);
  } catch (err) {
    return takRouteError(res, err);
  }
});

router.get("/clients/:clientId/data-sync-missions", async (req, res) => {
  const user = requireTakAdmin(req, res);
  if (!user) return;

  try {
    const out = await takGroupControl.getClientDataSyncMissions(req.params.clientId, user);
    return res.json(out);
  } catch (err) {
    return takRouteError(res, err);
  }
});

router.post("/clients/:clientId/send-data-sync-invite", async (req, res) => {
  const user = requireTakAdmin(req, res);
  if (!user) return;

  try {
    const out = await takGroupControl.sendClientDataSyncInvite(req.params.clientId, user, {
      missionName: req.body?.missionName ?? req.body?.name,
    });

    auditSvc.logEvent({
      actor: user,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "REMOTE_SEND_DATA_SYNC_INVITE",
      targetType: "tak_client",
      targetId: out.clientUid || String(req.params.clientId || ""),
      details: {
        summary: `Sent Data Sync invite "${out.missionName}" to ${out.callsign || out.username}.`,
        username: out.username,
        clientUid: out.clientUid,
        callsign: out.callsign,
        missionName: out.missionName,
        groupName: out.groupName,
        channelWasEnabled: out.channelWasEnabled,
      },
    });

    return res.json(out);
  } catch (err) {
    return takRouteError(res, err);
  }
});

router.get("/clients/:clientId/live-marker", async (req, res) => {
  const user = requireTakAdmin(req, res);
  if (!user) return;

  try {
    cotStream.ensureBridgeStarted();
    const callsign = String(req.query.callsign || "").trim();
    if (!callsign) {
      return res.status(400).json({ error: "Missing callsign query parameter" });
    }

    const marker = pickBestLiveMarker(cotStream.findMarkersByCallsign(callsign));
    if (!marker) {
      return res.json({
        found: false,
        marker: null,
        feature: null,
        iconManifest: [],
      });
    }

    const lat = Number(marker.lat);
    const lon = Number(marker.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.json({
        found: false,
        marker: null,
        feature: null,
        iconManifest: [],
      });
    }

    const feature = mapRender.toRenderedFeature(marker, { selectedUid: marker.uid });
    const slim = mapRender.toSlimMarker(marker);
    const iconManifest = [];
    const mapImageId = feature.properties && feature.properties.iconId;
    const apiIconId = feature.properties && feature.properties.apiIconId;
    if (mapImageId && apiIconId) {
      iconManifest.push({
        mapImageId,
        apiIconId,
        color: feature.properties.color,
        teamColor: marker.teamColor != null ? marker.teamColor : null,
        iconSource: marker.iconSource || "",
        origin: marker.origin || "",
        type: marker.type || "",
        affiliation: marker.affiliation || "other",
      });
    }

    return res.json({
      found: true,
      marker: slim,
      feature,
      iconManifest,
    });
  } catch (err) {
    return takRouteError(res, err);
  }
});

module.exports = router;
