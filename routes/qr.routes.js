const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const qrSvc = require("../services/qr.service");
const auditSvc = require("../services/auditLog.service");

/**
 * Generate QR for on-page display (medium resolution)
 * POST /api/qr
 */
router.post("/", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Missing username or password" });
    }

    const takUrl = qrSvc.getTakUrl();
    if (!takUrl) {
      return res.status(500).json({
        error:
          "TAK_URL is not configured. Set it in Settings (TAK URL) or via the TAK_URL environment variable.",
      });
    }

    const enrollUrl = qrSvc.buildEnrollUrl({ username, token: password });
    if (!enrollUrl) {
      return res.status(500).json({ error: "Failed to build enrollment URL" });
    }

    const qrCode = await qrSvc.generateDisplayQrDataUrl(enrollUrl);

    auditSvc.auditFromRequest(req, {
      action: "QR_GENERATED",
      targetType: "user",
      targetId: String(username).trim().toLowerCase(),
      details: {
        username: String(username).trim(),
        summary: "Generated on-screen enrollment QR (admin tool).",
      },
    });

    return res.json({
      qrCode,
      enrollUrl,
    });
  } catch (err) {
    console.error("QR generation error:", err);
    return res.status(500).json({ error: "Failed to generate QR code" });
  }
});

/**
 * Download high-resolution QR (print-quality)
 * GET /api/qr/download?username=...&token=...
 */
router.get("/download", async (req, res) => {
  try {
    const username = String(req.query.username || "").trim();
    const token = String(req.query.token || "").trim();

    if (!username || !token) {
      return res.status(400).send("Missing username or token");
    }

    const takUrl = qrSvc.getTakUrl();
    if (!takUrl) {
      return res
        .status(500)
        .send(
          "TAK_URL is not configured. Set it in Settings (TAK URL) or via the TAK_URL environment variable."
        );
    }

    const format = String(req.query.format || "").trim().toLowerCase();
    const isItak = format === "itak";

    let qrContent;
    if (isItak) {
      qrContent = qrSvc.buildItakEnrollPayload({
        host: qrSvc.getTakHost(),
        username,
        token,
        registrationId: crypto.randomUUID(),
      });
    } else {
      qrContent = qrSvc.buildEnrollUrl({ username, token });
    }

    if (!qrContent) {
      return res.status(500).send("Failed to build enrollment QR content");
    }

    const finalPng = await qrSvc.generateDownloadPng(qrContent, username);

    const safeUser =
      username.toLowerCase().replace(/[^a-z0-9_-]/g, "") || "user";

    const filename = isItak
      ? `itak-${safeUser}-enrollment-qr.png`
      : `tak-${safeUser}-enrollment-qr.png`;

    res.setHeader("Content-Type", "image/png");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`
    );

    auditSvc.auditFromRequest(req, {
      action: "QR_DOWNLOADED",
      targetType: "user",
      targetId: username.toLowerCase(),
      details: {
        username,
        filename,
        summary: isItak
          ? `Downloaded iTAK enrollment QR image for ${username}.`
          : `Downloaded enrollment QR image for ${username}.`,
      },
    });

    return res.send(finalPng);
  } catch (err) {
    console.error("QR download error:", err);
    return res.status(500).send("Failed to generate download QR");
  }
});

module.exports = router;
