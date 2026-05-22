const router = require("express").Router();
const takSshSvc = require("../services/takSsh.service");
const settingsSvc = require("../services/settings.service");
const auditSvc = require("../services/auditLog.service");

router.get("/status", (req, res) => {
  try {
    const cfg = settingsSvc.getSettings() || {};
    const keyStatus = takSshSvc.getLocalKeyStatus();
    const host = String(cfg.TAK_SSH_HOST || "").trim();
    const username = String(cfg.TAK_SSH_USER || "").trim();
    const port = String(cfg.TAK_SSH_PORT || "22").trim() || "22";
    const onboarded = String(cfg.TAK_SSH_ONBOARDED || "").toLowerCase() === "true";
    res.json({
      ok: true,
      status: {
        host,
        username,
        port,
        onboarded,
        lastHandshakeAt: cfg.TAK_SSH_LAST_HANDSHAKE_AT || "",
        ...keyStatus,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

router.post("/generate-key", (req, res) => {
  try {
    const keyStatus = takSshSvc.ensureLocalSshKeyPair();
    auditSvc.auditFromRequest(req, {
      action: "SSH_GENERATE_KEY",
      targetType: "ssh",
      targetId: "local",
      details: {
        hasPublicKey: !!keyStatus?.hasPublicKey,
        summary: "Generated or refreshed local SSH key pair for TAK Server integration.",
      },
    });
    res.json({ ok: true, keyStatus });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

router.post("/handshake", async (req, res) => {
  try {
    const body = req.body || {};
    const result = await takSshSvc.onboardTakSshWithPassword({
      host: body.host,
      port: body.port,
      username: body.username,
      password: body.password,
    });
    if (result?.ok) {
      auditSvc.auditFromRequest(req, {
        action: "SSH_HANDSHAKE",
        targetType: "ssh",
        targetId: String(body.host || "").trim() || "tak",
        details: {
          host: String(body.host || "").trim() || undefined,
          port: body.port != null ? String(body.port) : undefined,
          username: String(body.username || "").trim() || undefined,
          summary: "Completed SSH onboarding handshake to TAK Server host.",
        },
      });
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message || String(err) });
  }
});

router.post("/run-command", async (req, res) => {
  try {
    const body = req.body || {};
    const command = String(body.command || "").trim();
    const result = await takSshSvc.runRemoteSshCommand(command);
    if (!result.ok) {
      return res.status(400).json(result);
    }
    auditSvc.auditFromRequest(req, {
      action: "SSH_RUN_COMMAND",
      targetType: "ssh",
      targetId: "remote",
      details: {
        commandPreview: command.slice(0, 500),
        exitCode: result.exitCode,
        summary: `Ran remote SSH command (${command.slice(0, 120)}${command.length > 120 ? "…" : ""}).`,
      },
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

router.post("/test-connection", async (req, res) => {
  try {
    const result = await takSshSvc.runRemoteSshCommand("whoami");
    if (!result.ok) {
      return res.status(400).json(result);
    }
    auditSvc.auditFromRequest(req, {
      action: "SSH_TEST_CONNECTION",
      targetType: "ssh",
      targetId: "remote",
      details: {
        remoteUser: String(result.stdout || "").trim() || undefined,
        summary: "SSH connection test succeeded (whoami).",
      },
    });
    res.json({
      ok: true,
      message: "SSH connection successful.",
      remoteUser: String(result.stdout || "").trim(),
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      exitCode: result.exitCode,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

module.exports = router;
