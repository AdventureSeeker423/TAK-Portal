const router = require("express").Router();
const cotStream = require("../services/cotStream.service");
const mapMeta = require("../services/mapMeta.service");

router.get("/state", (req, res) => {
  cotStream.ensureBridgeStarted();
  return res.json(cotStream.getStateSnapshot());
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
