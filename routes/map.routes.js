const router = require("express").Router();
const path = require("path");
const cotStream = require("../services/cotStream.service");
const mapMeta = require("../services/mapMeta.service");
const mapIcon = require("../services/mapIcon.service");
const mapRender = require("../services/mapRender.service");
const geocode = require("../services/geocode.service");

mapIcon.ensureIconsets().then(() => {
  cotStream.refreshAllMarkerIcons();
}).catch((err) => {
  console.warn("[map] iconset init failed:", err?.message || err);
});

function getMapAccessContext(req) {
  const user = req.authentikUser || {};
  const isGlobalAdmin = !!user.isGlobalAdmin;
  const isAgencyAdmin = !!user.isAgencyAdmin && !isGlobalAdmin;
  return {
    isGlobalAdmin,
    isAgencyAdmin,
    scopeMemberGroups: isAgencyAdmin,
    userGroups: Array.isArray(user.groups) ? user.groups : [],
  };
}

async function attachScopedGroupCatalog(snapshot, ctx) {
  const catalog = await mapMeta.getTakGroupCatalog(cotStream.getMarkerList(), {
    scopeMemberGroups: ctx.scopeMemberGroups,
    userGroupNames: ctx.userGroups,
  });
  snapshot.groupsCatalog = catalog.groups;
  snapshot.channelScope = catalog.channelScope;
  snapshot.allowedChannelKeys = catalog.allowedChannelKeys;
  return snapshot;
}

router.get("/state", async (req, res) => {
  cotStream.ensureBridgeStarted();
  const ctx = getMapAccessContext(req);
  const snapshot = cotStream.getStateSnapshot();
  snapshot.icons = mapIcon.getStatus();
  try {
    await attachScopedGroupCatalog(snapshot, ctx);
  } catch (err) {
    snapshot.groupsCatalog = [];
    snapshot.channelScope = ctx.scopeMemberGroups ? "member" : "all";
    snapshot.allowedChannelKeys = ctx.scopeMemberGroups ? [] : null;
    snapshot.groupsError = err?.message || String(err);
  }
  return res.json(snapshot);
});

router.get("/markers", (req, res) => {
  cotStream.ensureBridgeStarted();
  res.setHeader("Cache-Control", "no-cache");
  return res.json({
    markers: cotStream.getMarkersSlimList(),
    updatedAt: new Date().toISOString(),
  });
});

router.get("/cot-raw", (req, res) => {
  cotStream.ensureBridgeStarted();
  const uid = String(req.query.uid || "").trim();
  if (!uid) return res.status(400).json({ error: "Missing uid" });
  const raw = cotStream.getMarkerRawCot(uid);
  if (raw == null) {
    return res.status(404).json({ error: "Marker or raw CoT not found" });
  }
  res.setHeader("Cache-Control", "no-cache");
  res.type("application/json");
  return res.send(JSON.stringify(raw, null, 2));
});

router.get("/geojson", (req, res) => {
  cotStream.ensureBridgeStarted();
  const options = mapRender.parseGeoJsonQuery(req.query);
  const geojson = cotStream.getMarkersGeoJson(options);
  res.setHeader("Cache-Control", "no-cache");
  return res.json(geojson);
});

router.get("/icons", (req, res) => {
  const iconId = String(req.query.id || "").trim();
  if (!iconId) return res.status(400).json({ error: "Missing id" });
  const filePath = mapIcon.getIconFilePath(iconId);
  if (!filePath) return res.status(404).end();
  res.setHeader("Cache-Control", "public, max-age=86400");
  return res.sendFile(path.resolve(filePath));
});

router.get("/groups", async (req, res) => {
  cotStream.ensureBridgeStarted();
  const ctx = getMapAccessContext(req);
  try {
    const catalog = await mapMeta.getTakGroupCatalog(cotStream.getMarkerList(), {
      scopeMemberGroups: ctx.scopeMemberGroups,
      userGroupNames: ctx.userGroups,
    });
    return res.json(catalog);
  } catch (err) {
    return res.status(500).json({
      groups: [],
      channelScope: ctx.scopeMemberGroups ? "member" : "all",
      allowedChannelKeys: ctx.scopeMemberGroups ? [] : null,
      error: err?.message || String(err),
      updatedAt: new Date().toISOString(),
    });
  }
});

/** Trace group assignment for one marker (compare EUD vs data-feed). */
router.get("/debug/groups", async (req, res) => {
  cotStream.ensureBridgeStarted();
  await mapMeta.refreshSubscriptionIndex();
  await mapMeta.refreshDataFeedIndex();

  const uid = String(req.query.uid || "").trim();
  const callsign = String(req.query.callsign || "").trim();

  let marker = uid ? cotStream.getMarkerByUid(uid) : null;
  if (!marker && callsign) {
    const matches = cotStream.findMarkersByCallsign(callsign);
    if (matches.length === 1) marker = matches[0];
    else if (matches.length > 1) {
      return res.json({
        error: "Multiple markers match callsign; pass uid instead",
        matches: matches.map((m) => ({ uid: m.uid, callsign: m.callsign, groups: m.groups })),
      });
    }
  }

  if (!marker) {
    return res.status(404).json({
      error: "Marker not found on map",
      hint: "Pass ?uid=ICAO-ACE18D or ?callsign=N929W while the marker is live",
    });
  }

  res.setHeader("Cache-Control", "no-cache");
  return res.json(mapMeta.explainGroupAssignment(marker));
});

router.get("/geocode", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Missing q" });
  const limit = Math.min(10, Math.max(1, Number.parseInt(req.query.limit, 10) || 5));
  const nearLat = Number.parseFloat(req.query.nearLat);
  const nearLon = Number.parseFloat(req.query.nearLon);
  try {
    const results = await geocode.geocodeSearch(q, {
      limit,
      nearLat: Number.isFinite(nearLat) ? nearLat : undefined,
      nearLon: Number.isFinite(nearLon) ? nearLon : undefined,
    });
    if (!results.length) {
      res.setHeader("Cache-Control", "private, max-age=60");
      return res.json({ results: [] });
    }
    res.setHeader(
      "Cache-Control",
      Number.isFinite(nearLat) && Number.isFinite(nearLon)
        ? "private, max-age=30"
        : "private, max-age=300"
    );
    if (limit === 1) {
      return res.json(results[0]);
    }
    return res.json({ results });
  } catch (err) {
    return res.status(502).json({
      error: err?.message || "Geocoding failed",
    });
  }
});

router.get("/stream", (req, res) => {
  req.socket.setTimeout(0);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const ac = new AbortController();
  const onReqClose = () => ac.abort();
  req.on("close", onReqClose);

  const sendLine = (line) => {
    if (ac.signal.aborted) return;
    try {
      res.write(line);
    } catch (_) {}
  };

  const unsubscribe = cotStream.subscribe(sendLine);

  req.on("close", () => {
    try {
      unsubscribe();
    } catch (_) {}
    try {
      req.off("close", onReqClose);
    } catch (_) {}
    try {
      res.end();
    } catch (_) {}
  });
});

/** Debug icon resolution for a live marker or synthetic inputs. */
router.get("/debug/icon", async (req, res) => {
  await mapIcon.ensureIconsets();

  const uid = String(req.query.uid || "").trim();
  const type = String(req.query.type || "").trim();
  const affiliation = String(req.query.affiliation || "friend").trim();
  const origin = String(req.query.origin || "").trim();

  let marker = uid ? cotStream.getMarkerByUid(uid) : null;
  const cotType = marker?.type || type;
  if (!cotType) {
    return res.status(400).json({
      error: "Pass ?uid= while marker is live, or ?type=a-f-A-C-H",
    });
  }

  const usericon = marker
    ? {
        iconsetpath: marker.iconsetpath || "",
        group: marker.iconGroup || "",
        name: marker.iconName || "",
      }
    : req.query.iconsetpath
      ? {
          iconsetpath: String(req.query.iconsetpath),
          group: String(req.query.group || ""),
          name: String(req.query.name || ""),
        }
      : null;

  const trace = mapIcon.explainIconResolution({
    type: cotType,
    affiliation: marker?.affiliation || affiliation,
    usericon,
    origin: marker?.origin || origin || null,
  });

  const displayMarker = marker || {
    type: cotType,
    affiliation: affiliation || "friend",
    origin: origin || "feed",
    iconId: trace.resolved?.iconId || null,
    iconSource: trace.resolved?.source || null,
  };
  if (trace.resolved && !marker) {
    displayMarker.iconId = trace.resolved.iconId;
    displayMarker.iconSource = trace.resolved.source;
  }

  res.setHeader("Cache-Control", "no-cache");
  return res.json({
    marker: marker
      ? {
          uid: marker.uid,
          callsign: marker.callsign,
          type: marker.type,
          origin: marker.origin,
          storedIconId: marker.iconId,
          storedIconSource: marker.iconSource,
        }
      : null,
    trace,
    display: {
      markerUsesMapIcon: mapRender.markerUsesMapIcon(displayMarker),
      rules: [
        "EUD origin always renders team dot",
        "feed + resolved icon uses PNG for type2525b",
        "air types use PNG when not EUD",
      ],
    },
    indexes: {
      iconsets: mapIcon.listIconsets(),
      typeMappingCount: mapIcon.getStatus().typeMappings,
    },
  });
});

module.exports = router;
