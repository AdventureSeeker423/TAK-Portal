const router = require("express").Router();
const locateConfig = require("../services/locateConfig.service");
const takSshSvc = require("../services/takSsh.service");
const takMaint = require("../services/takMaintenance.service");

function ensureSsh(req, res, next) {
  if (!locateConfig.isSshConfigured().configured) {
    return res.status(403).json({ ok: false, error: "SSH to the TAK Server is not configured." });
  }
  return next();
}

router.post("/restart-service", ensureSsh, async (req, res) => {
  try {
    const result = await takSshSvc.runRemoteSshCommand("sudo systemctl restart takserver", 120000);
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.message || "Restart failed." });
    }
    return res.json({
      ok: true,
      message: "TAK Server service restart was requested over SSH (sudo systemctl restart takserver).",
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

router.post("/reboot-server", ensureSsh, async (req, res) => {
  try {
    const result = await takSshSvc.runRemoteRebootFireAndForget();
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.message || "Reboot failed." });
    }
    return res.json({
      ok: true,
      initiated: !!result.initiated,
      message: result.message || "Reboot was requested over SSH.",
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

router.get("/stream", ensureSsh, (req, res) => {
  req.socket.setTimeout(0);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const ac = new AbortController();
  const onReqClose = () => ac.abort();
  req.on("close", onReqClose);

  const send = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch (_) {}
  };

  send({ type: "stream_open", at: new Date().toISOString() });

  (async () => {
    try {
      await takMaint.streamHealthWaitAndTail({ send, signal: ac.signal });
    } catch (e) {
      if (!ac.signal.aborted) {
        send({ type: "error", message: e?.message || String(e) });
      }
    } finally {
      try {
        req.off("close", onReqClose);
      } catch (_) {}
      try {
        res.end();
      } catch (_) {}
    }
  })();
});

module.exports = router;
