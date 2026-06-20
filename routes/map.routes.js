const router = require("express").Router();
const path = require("path");
const cotStream = require("../services/cotStream.service");
const mapMeta = require("../services/mapMeta.service");
const mapIcon = require("../services/mapIcon.service");
const mapRender = require("../services/mapRender.service");
const mapIconRender = require("../services/mapIconRender.service");
const geocode = require("../services/geocode.service");

mapIcon.ensureIconsets().then(() => {
  cotStream.refreshAllMarkerIcons();
}).catch((err) => {
  console.warn("[map] iconset init failed:", err?.message || err);
});

geocode
  .geocodeSearch("600 Market St, Chattanooga, TN", { limit: 1 })
  .then(function (out) {
    if (out?.lookupFailed || !Array.isArray(out?.results) || !out.results.length) {
      console.warn(
        "[map] geocode self-test failed — address search may be unavailable (check outbound HTTPS or set GEOCODIO_API_KEY)"
      );
    }
  })
  .catch(function (err) {
    console.warn("[map] geocode self-test error:", err?.message || err);
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
    revision: cotStream.getMarkerRevision(),
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

function buildGeoJsonOptions(req) {
  const options = mapRender.parseGeoJsonQuery(req.query);
  options.selectedUid = options.selectedUid || String(req.query.selected || "").trim();
  options.lockedUid = options.lockedUid || String(req.query.locked || "").trim();
  return options;
}

router.get("/geojson", async (req, res) => {
  cotStream.ensureBridgeStarted();
  const options = buildGeoJsonOptions(req);
  const currentRevision = String(cotStream.getMarkerRevision());
  const ifNoneMatch = String(req.headers["if-none-match"] || "").trim();

  if (ifNoneMatch && ifNoneMatch === currentRevision) {
    res.setHeader("ETag", currentRevision);
    res.setHeader("Cache-Control", "no-cache");
    return res.status(304).end();
  }

  const geojson = cotStream.getMarkersGeoJson(options);
  const manifest = Array.isArray(geojson.meta?.iconManifest) ? geojson.meta.iconManifest : [];
  if (manifest.length) {
    try {
      await mapIconRender.prewarmIconManifest(manifest);
    } catch (err) {
      console.warn("[map] icon prewarm failed:", err?.message || err);
    }
  }
  res.setHeader("ETag", String(geojson.meta?.revision || currentRevision));
  res.setHeader("Cache-Control", "no-cache");
  return res.json(geojson);
});

router.post("/geojson/viewport", (req, res) => {
  cotStream.ensureBridgeStarted();
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const query = {
    channels: body.channels,
    scopeKeys: body.scopeKeys,
    selected: body.selected,
    locked: body.locked,
    zoom: body.zoom,
    bounds: body.bounds,
    declutter: "1",
  };
  const options = mapRender.parseGeoJsonQuery(query);
  if (body.scopeKeys == null && Array.isArray(body.allowedChannelKeys)) {
    options.scopeChannelKeys = new Set(
      body.allowedChannelKeys.map(String).filter(Boolean)
    );
  }
  const geojson = cotStream.getMarkersGeoJson(options);
  res.setHeader("Cache-Control", "no-cache");
  return res.json(geojson);
});

router.get("/icons/rendered", async (req, res) => {
  const mapImageId = String(req.query.mapImageId || req.query.id || "").trim();
  if (!mapImageId) return res.status(400).json({ error: "Missing mapImageId" });

  let cached = await mapIconRender.getRenderedBuffer(mapImageId);
  if (cached) {
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.setHeader("Content-Type", cached.contentType || "image/png");
    return res.send(cached.buffer);
  }

  const apiIconId = String(req.query.apiIconId || "").trim();
  const color = String(req.query.color || "").trim();
  if (!apiIconId) return res.status(404).end();

  const marker = {
    iconId: apiIconId,
    iconSource: String(req.query.iconSource || ""),
    origin: String(req.query.origin || "feed"),
    type: String(req.query.type || ""),
    affiliation: String(req.query.affiliation || "friend"),
    teamColor: color || null,
  };

  const rendered = await mapIconRender.renderIconForMarker(marker);
  if (!rendered.buffer) return res.status(404).end();
  res.setHeader("Cache-Control", "public, max-age=86400, immutable");
  res.setHeader("Content-Type", rendered.contentType || "image/png");
  return res.send(rendered.buffer);
});

router.post("/icons/rendered/batch", async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const icons = Array.isArray(body.icons) ? body.icons : [];
  if (!icons.length) {
    return res.status(400).json({ error: "Missing icons array" });
  }

  try {
    const result = await mapIconRender.renderIconBatch(icons);
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    return res.json(result);
  } catch (err) {
    console.warn("[map] icon batch render failed:", err?.message || err);
    return res.status(500).json({ error: "Icon batch render failed" });
  }
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
    const out = await geocode.geocodeSearch(q, {
      limit,
      nearLat: Number.isFinite(nearLat) ? nearLat : undefined,
      nearLon: Number.isFinite(nearLon) ? nearLon : undefined,
    });
    const results = Array.isArray(out?.results) ? out.results : [];
    const lookupFailed = !!out?.lookupFailed;
    if (!results.length) {
      res.setHeader("Cache-Control", "private, max-age=60");
      return res.json({ results: [], lookupFailed });
    }
    res.setHeader(
      "Cache-Control",
      Number.isFinite(nearLat) && Number.isFinite(nearLon)
        ? "private, max-age=30"
        : "private, max-age=300"
    );
    if (limit === 1) {
      return res.json({ ...results[0], lookupFailed: false });
    }
    return res.json({ results, lookupFailed: false });
  } catch (err) {
    console.warn("[map] geocode failed:", err?.message || err);
    res.setHeader("Cache-Control", "private, max-age=30");
    return res.json({ results: [], lookupFailed: true });
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

router.get("/debug/render-stats", (req, res) => {
  cotStream.ensureBridgeStarted();
  res.setHeader("Cache-Control", "no-cache");
  return res.json({
    revision: cotStream.getMarkerRevision(),
    markerCount: cotStream.getMarkerList().length,
    render: mapRender.getRenderStats(),
    icons: mapIconRender.getStats(),
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
