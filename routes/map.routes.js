const router = require("express").Router();
const path = require("path");
const cotStream = require("../services/cotStream.service");
const mapMeta = require("../services/mapMeta.service");
const mapIcon = require("../services/mapIcon.service");
const mapSymbol = require("../services/mapSymbol.service");

Promise.all([mapIcon.ensureIconsets(), mapSymbol.ensureType2525()])
  .then(() => {
    cotStream.refreshAllMarkerSymbols();
    cotStream.refreshAllMarkerIcons();
  })
  .catch((err) => {
    console.warn("[map] icon/symbol init failed:", err?.message || err);
  });

router.get("/state", (req, res) => {
  cotStream.ensureBridgeStarted();
  const snapshot = cotStream.getStateSnapshot();
  snapshot.icons = mapIcon.getStatus();
  return res.json(snapshot);
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
