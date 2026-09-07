const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const qrSvc = require("../services/qr.service");
const tokensSvc = require("../services/authentikTokens.service");
const usersSvc = require("../services/users.service");
const auditSvc = require("../services/auditLog.service");
const enrollmentPkg = require("../services/enrollmentPackage.service");

function requireLoggedIn(req, res) {
  const u = req.authentikUser;
  if (!u || !u.username) {
    res.status(401).json({ ok: false, error: "Authentication required" });
    return null;
  }
  return u;
}

async function requireActiveLoggedIn(req, res) {
  const user = requireLoggedIn(req, res);
  if (!user) return null;

  const localUser = await usersSvc.getUserById(user.uid || user.username);
  if (!localUser || localUser.is_active === false) {
    res.status(403).json({ ok: false, error: "Account is disabled" });
    return null;
  }
  return user;
}

router.post("/enroll-qr", async (req, res) => {
  try {
    const user = await requireActiveLoggedIn(req, res);
    if (!user) return;

    const takUrl = qrSvc.getTakUrl();
    if (!takUrl) {
      return res.status(500).json({
        ok: false,
        error:
          "TAK_URL is not configured. Set it in Settings (TAK URL) or via the TAK_URL environment variable.",
      });
    }

    const isItak = req.body && String(req.body.app || "").toLowerCase() === "itak";

    const { identifier, key, expiresAt } =
      await tokensSvc.getOrCreateEnrollmentAppPassword({
        username: user.username,
        userId: user.uid || null,
      });

    let enrollUrl = "";
    let itakPayload = null;
    let qrContent = null;

    if (isItak) {
      const host = qrSvc.getTakHost();
      itakPayload = qrSvc.buildItakEnrollPayload({
        host,
        username: user.username,
        token: key,
        registrationId: crypto.randomUUID(),
      });
      if (!itakPayload) {
        return res.status(500).json({
          ok: false,
          error: "Failed to build iTAK enrollment payload (check TAK_URL / hostname).",
        });
      }
      qrContent = itakPayload;
    } else {
      enrollUrl = qrSvc.buildEnrollUrl({
        username: user.username,
        token: key,
      });
      qrContent = enrollUrl;
    }

    if (!qrContent) {
      return res.status(500).json({
        ok: false,
        error: "Failed to build enrollment QR content.",
      });
    }

    const qrCode = await qrSvc.generateDisplayQrDataUrl(qrContent);

    auditSvc.auditFromRequest(req, {
      action: "SELF_SERVICE_ENROLLMENT_QR",
      targetType: "user",
      targetId: String(user.username || "").trim().toLowerCase(),
      details: {
        username: user.username,
        tokenIdentifier: identifier,
        expiresAt,
        itak: isItak,
        summary: `User generated own enrollment QR (${isItak ? "iTAK" : "standard"}).`,
      },
    });

    return res.json({
      ok: true,
      username: user.username,
      tokenIdentifier: identifier,
      token: key,
      expiresAt,
      enrollUrl: enrollUrl || "",
      itakPayload: itakPayload || undefined,
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
    const user = await requireActiveLoggedIn(req, res);
    if (!user) return;

    const uid = String(user.uid || "").trim();
    const fullUser = await usersSvc.getUserById(uid || user.username);
    if (!fullUser) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }
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

router.get("/data-package", async (req, res) => {
  try {
    const user = await requireActiveLoggedIn(req, res);
    if (!user) return;

    if (!enrollmentPkg.isDataPackageAvailable()) {
      return res.status(403).json({
        ok: false,
        error:
          "Data Package is not available. Enable it in Supported TAK Clients after SSH Generate Key + Handshake succeeds with sudo (privileged) access.",
      });
    }

    let prefs = { callsign: "", teamLabel: "", roleLabel: "" };
    try {
      const userId = String(user.uid || "").trim() || user.username;
      const fullUser = await usersSvc.getUserById(userId);
      prefs = usersSvc.getPreferenceDataForUser(fullUser);
    } catch (prefErr) {
      console.warn(
        "[setup-device] preference lookup for data package failed:",
        prefErr?.message || prefErr
      );
    }

    const built = await enrollmentPkg.buildEnrollmentPackageZip({
      username: user.username,
      callsign: prefs.callsign,
      teamLabel: prefs.teamLabel,
      roleLabel: prefs.roleLabel,
    });

    auditSvc.auditFromRequest(req, {
      action: "SELF_SERVICE_DATA_PACKAGE",
      targetType: "user",
      targetId: String(user.username || "").trim().toLowerCase(),
      details: {
        username: user.username,
        packageName: built.packageName,
        summary: "User downloaded a TAK enrollment data package.",
      },
    });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${built.packageName}"`
    );
    return res.send(built.buffer);
  } catch (err) {
    console.error(
      "[setup-device] Failed to build data package:",
      err?.message || err
    );
    const status = Number(err?.status) || 500;
    return res.status(status).json({
      ok: false,
      error: err?.message || "Failed to build data package",
    });
  }
});

router.requireActiveLoggedIn = requireActiveLoggedIn;
module.exports = router;
