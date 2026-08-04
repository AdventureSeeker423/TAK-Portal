const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Jimp = require("jimp"); // Jimp 0.22.x
const settingsSvc = require("./settings.service");
const { addLogoToQrPng } = require("./qrLogoOverlay.service");

// Prefer TAK_URL from settings.json, fall back to .env if needed
function getTakUrl() {
  try {
    const settings = settingsSvc.getSettings() || {};
    if (
      settings.TAK_URL &&
      typeof settings.TAK_URL === "string" &&
      settings.TAK_URL.trim()
    ) {
      return settings.TAK_URL.trim();
    }
  } catch (err) {
    console.warn(
      "Failed to read TAK_URL from settings.json:",
      err?.message || err
    );
  }

  if (process.env.TAK_URL && process.env.TAK_URL.trim()) {
    return process.env.TAK_URL.trim();
  }

  return null;
}

function getTakHost() {
  const takUrl = getTakUrl();
  if (!takUrl) return null;
  try {
    return new URL(takUrl).hostname;
  } catch {
    return null;
  }
}

function buildEnrollUrl({ username, token }) {
  const u = String(username || "").trim();
  const t = String(token || "").trim();
  if (!u || !t) return null;

  const host = getTakHost();
  if (!host) return null;

  return (
    `tak://com.atakmap.app/enroll?` +
    `host=${host}` +
    `&username=${encodeURIComponent(u)}` +
    `&token=${encodeURIComponent(t)}`
  );
}

/**
 * Build iTAK registration QR payload (plain-text JSON scanned by iTAK).
 * @see iTAK registration QR format: connectionString host:8089:ssl, user app-password token.
 */
function buildItakEnrollPayload({ host, username, token, registrationId }) {
  const h = String(host || "").trim();
  const u = String(username || "").trim();
  const t = String(token || "").trim();
  if (!h || !u || !t) return null;

  const regId =
    String(registrationId || "").trim() || crypto.randomUUID();

  const payload = {
    passphrase: "false",
    type: "registration",
    serverCredentials: {
      connectionString: `${h}:8089:ssl`,
    },
    userCredentials: {
      username: u,
      password: t,
      registrationId: regId,
    },
  };

  return JSON.stringify(payload);
}

/**
 * Build ATAK device preference URL for callsign, team (color), and role.
 * Format: tak://com.atakmap.app/preference?key1=locationCallsign&type1=string&value1=...&key2=locationTeam&type2=string&value2=...&key3=atakRoleType&type3=string&value3=...
 */
function buildPreferenceUrl({ callsign, teamLabel, roleLabel }) {
  const c = String(callsign || "").trim();
  const t = String(teamLabel || "").trim();
  const r = String(roleLabel || "Team Member").trim();
  if (!c && !t && !r) return null;

  const params = [];
  if (c) params.push(`key1=locationCallsign&type1=string&value1=${encodeURIComponent(c)}`);
  if (t) params.push(`key2=locationTeam&type2=string&value2=${encodeURIComponent(t)}`);
  if (r) params.push(`key3=atakRoleType&type3=string&value3=${encodeURIComponent(r)}`);
  if (!params.length) return null;

  return `tak://com.atakmap.app/preference?${params.join("&")}`;
}

async function addLogoToPng(pngBuffer, options = {}) {
  const settings = settingsSvc.getSettings() || {};
  const logoUrl = settings.BRAND_LOGO_URL;
  if (!logoUrl || typeof logoUrl !== "string") return pngBuffer;

  const logoUrlPath = logoUrl.replace(/^\//, "");
  const logoFsPath = path.join(__dirname, "..", "data", logoUrlPath);
  if (!fs.existsSync(logoFsPath)) return pngBuffer;

  return addLogoToQrPng(pngBuffer, logoFsPath, options);
}

// Add username label underneath the QR image (for downloaded image only)
async function addUsernameLabel(pngBuffer, username) {
  try {
    const qrImage = await Jimp.read(pngBuffer);

    // Built-in font in Jimp 0.22.x
    const font = await Jimp.loadFont(Jimp.FONT_SANS_64_BLACK);

    // FORCE ALL CAPS
    const text = (String(username || "").trim() || "USER").toUpperCase();

    const textBlockHeight = 80; // a little extra space for bigger text

    const qrWidth = qrImage.getWidth();
    const qrHeight = qrImage.getHeight();

    // New canvas: same width, extra height for text
    const combined = new Jimp(
      qrWidth,
      qrHeight + textBlockHeight,
      0xffffffff // white background
    );

    // Paste the QR code at the top
    combined.composite(qrImage, 0, 0);

    // Center text under QR
    combined.print(
      font,
      0,
      qrHeight + 10,
      {
        text,
        alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
        alignmentY: Jimp.VERTICAL_ALIGN_TOP,
      },
      qrWidth,
      textBlockHeight
    );

    return combined.getBufferAsync(Jimp.MIME_PNG);
  } catch (err) {
    console.error("Failed to add username label to QR:", err);
    return pngBuffer;
  }
}

async function generateDisplayQrDataUrl(enrollUrl) {
  const basePng = await QRCode.toBuffer(enrollUrl, {
    errorCorrectionLevel: "H",
    type: "png",
    width: 512, // Display size
    margin: 2,
    color: {
      dark: "#000000",
      light: "#FFFFFF",
    },
  });

  const finalPng = await addLogoToPng(basePng);
  return "data:image/png;base64," + finalPng.toString("base64");
}

async function generateDownloadPng(enrollUrl, username) {
  const pngBuffer = await QRCode.toBuffer(enrollUrl, {
    errorCorrectionLevel: "H",
    type: "png",
    width: 1200,
    margin: 3,
    color: {
      dark: "#000000",
      light: "#FFFFFF",
    },
  });

  let finalPng = await addLogoToPng(pngBuffer);
  finalPng = await addUsernameLabel(finalPng, username);
  return finalPng;
}

module.exports = {
  getTakUrl,
  getTakHost,
  buildEnrollUrl,
  buildItakEnrollPayload,
  buildPreferenceUrl,
  generateDisplayQrDataUrl,
  generateDownloadPng,
};
