const express = require("express");
const router = express.Router();

const qrSvc = require("../services/qr.service");
const tokensSvc = require("../services/authentikTokens.service");
const usersSvc = require("../services/users.service");
const auditSvc = require("../services/auditLog.service");

function requireLoggedIn(req, res) {
  const u = req.authentikUser;
  if (!u || !u.username) {
    res.status(401).json({ ok: false, error: "Authentication required" });
    return null;
  }
  return u;
}

router.post("/enroll-qr", async (req, res) => {
  try {
    const user = requireLoggedIn(req, res);
    if (!user) return;

    const takUrl = qrSvc.getTakUrl();
    if (!takUrl) {
      return res.status(500).json({
        ok: false,
        error:
          "TAK_URL is not configured. Set it in Settings (TAK URL) or via the TAK_URL environment variable.",
      });
    }

    const isOtt = req.body && String(req.body.app || "").toLowerCase() === "ott";

    const { identifier, key, expiresAt } =
      await tokensSvc.getOrCreateEnrollmentAppPassword({
        username: user.username,
        userId: user.uid || null,
      });

    let enrollUrl;
    if (isOtt) {
      const host = qrSvc.getTakHost();
      const userId = await tokensSvc.getUserIdByUsername(user.username);
      const fullUser = await usersSvc.getUserById(userId);
      const pref = usersSvc.getPreferenceDataForUser(fullUser);
      enrollUrl = qrSvc.buildOttEnrollUrl({
        host,
        username: user.username,
        token: key,
        callsign: pref.callsign,
        teamLabel: pref.teamLabel,
        roleLabel: pref.roleLabel,
      });
    } else {
      enrollUrl = qrSvc.buildEnrollUrl({
        username: user.username,
        token: key,
      });
    }

    const qrCode = await qrSvc.generateDisplayQrDataUrl(enrollUrl);

    auditSvc.auditFromRequest(req, {
      action: "SELF_SERVICE_ENROLLMENT_QR",
      targetType: "user",
      targetId: String(user.username || "").trim().toLowerCase(),
      details: {
        username: user.username,
        tokenIdentifier: identifier,
        expiresAt,
        ott: isOtt,
        summary: `User generated own enrollment QR (${isOtt ? "OTT" : "standard"}).`,
      },
    });

    return res.json({
      ok: true,
      username: user.username,
      tokenIdentifier: identifier,
      token: key,
      expiresAt,
      enrollUrl: enrollUrl || "",
      qrCode,
    });
  } catch (err) {
    // Log only a concise error (no header/user dumps)
    console.error(
      "[setup-device] Failed to create enrollment QR:",
      err?.message || err
    );

    return res.status(500).json({
      ok: false,
      error:
        err?.response?.status
          ? `Authentik API error (HTTP ${err.response.status})`
          : (err?.message || "Failed to generate enrollment QR"),
    });
  }
});

// GET preference data + QR for Android Step 3 (Configure Device Preferences)
router.get("/preference-data", async (req, res) => {
  try {
    const user = requireLoggedIn(req, res);
    if (!user) return;

    const userId = await tokensSvc.getUserIdByUsername(user.username);
    const fullUser = await usersSvc.getUserById(userId);
    const data = usersSvc.getPreferenceDataForUser(fullUser);

    const preferenceUrl = qrSvc.buildPreferenceUrl({
      callsign: data.callsign,
      teamLabel: data.teamLabel,
      roleLabel: data.roleLabel,
    });

    let qrCode = null;
    if (preferenceUrl) {
      qrCode = await qrSvc.generateDisplayQrDataUrl(preferenceUrl);
    }

    return res.json({
      ok: true,
      callsign: data.callsign,
      teamLabel: data.teamLabel,
      roleLabel: data.roleLabel,
      preferenceUrl: preferenceUrl || "",
      qrCode,
    });
  } catch (err) {
    console.error(
      "[setup-device] Failed to get preference data:",
      err?.message || err
    );
    return res.status(500).json({
      ok: false,
      error: err?.message || "Failed to get preference data",
    });
  }
});

module.exports = router;
