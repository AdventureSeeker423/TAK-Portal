const router = require("express").Router();
const path = require("path");
const cotStream = require("../services/cotStream.service");
const mapMeta = require("../services/mapMeta.service");
const mapIcon = require("../services/mapIcon.service");
const mapRender = require("../services/mapRender.service");

mapIcon.ensureIconsets().then(() => {
  cotStream.refreshAllMarkerIcons();
}).catch((err) => {
  console.warn("[map] iconset init failed:", err?.message || err);
});

router.get("/state", (req, res) => {
  cotStream.ensureBridgeStarted();
  const snapshot = cotStream.getStateSnapshot();
  snapshot.icons = mapIcon.getStatus();
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
  try {
    const catalog = await mapMeta.getTakGroupCatalog(cotStream.getMarkerList());
    return res.json(catalog);
  } catch (err) {
    return res.status(500).json({
      groups: [],
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

module.exports = router;
