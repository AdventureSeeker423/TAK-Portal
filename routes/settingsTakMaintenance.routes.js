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

/**
 * Do not await the full `systemctl restart` over SSH in this request: it can run 30–120s,
 * and reverse proxies (Caddy, nginx, cloud load balancers) often return 502/504 with an
 * empty body before Node responds—clients then see "Request failed" while the restart
 * still completes. Respond immediately and run the SSH command in the background.
 */
router.post("/restart-service", ensureSsh, (req, res) => {
  void takSshSvc
    .runRemoteSshCommand("sudo systemctl restart takserver", 120000)
    .then((result) => {
      if (!result.ok) {
        console.error("[tak-maintenance] restart-service SSH failed:", result.message);
      }
    })
    .catch((err) => {
      console.error("[tak-maintenance] restart-service SSH error:", err?.message || err);
    });

  return res.json({
    ok: true,
    message:
      "TAK Server service restart has been queued over SSH (sudo systemctl restart takserver). It may take up to about a minute on the host; the status panel tracks API health and the log tail.",
  });
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

  const tailOnly =
    String(req.query.tailOnly || req.query.logs || "").trim() === "1" ||
    String(req.query.mode || "")
      .trim()
      .toLowerCase() === "tail";

  (async () => {
    try {
      if (tailOnly) {
        send({
          type: "tail_only",
          at: new Date().toISOString(),
          message: "Live tail of /opt/tak/logs/takserver-api.log (no restart).",
        });
        await takMaint.streamTakApiLogTail({ send, signal: ac.signal });
      } else {
        await takMaint.streamHealthWaitAndTail({ send, signal: ac.signal });
      }
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
