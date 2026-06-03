const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const Jimp = require("jimp"); // Jimp 0.22.x
const settingsSvc = require("./settings.service");

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
 * Build Open TAK Tracker enrollment URL (enrollment + callsign/team/role in one).
 * Format: opentaktracker://enroll?host=SERVER&username=USER&token=TOKEN&callsign=CALLSIGN&team=TEAM&role=ROLE
 */
function buildOttEnrollUrl({ host, username, token, callsign, teamLabel, roleLabel }) {
  const h = String(host || "").trim();
  const u = String(username || "").trim();
  const t = String(token || "").trim();
  if (!h || !u || !t) return null;

  const c = String(callsign || "").trim();
  const team = String(teamLabel || "").trim();
  const r = String(roleLabel || "Team Member").trim();

  const params = [
    `host=${encodeURIComponent(h)}`,
    `username=${encodeURIComponent(u)}`,
    `token=${encodeURIComponent(t)}`,
  ];
  if (c) params.push(`callsign=${encodeURIComponent(c)}`);
  if (team) params.push(`team=${encodeURIComponent(team)}`);
  if (r) params.push(`role=${encodeURIComponent(r)}`);

  return `opentaktracker://enroll?${params.join("&")}`;
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

// Overlay branding logo (if configured) onto the center of a QR PNG buffer.
async function addLogoToPng(pngBuffer, options = {}) {
  try {
    const settings = settingsSvc.getSettings() || {};
    const logoUrl = settings.BRAND_LOGO_URL;

    if (!logoUrl || typeof logoUrl !== "string") {
      return pngBuffer;
    }

    // BRAND_LOGO_URL is like "/branding/logo.png"
    // Files are stored under /data/branding and served via app.use("/branding", ...)
    const logoUrlPath = logoUrl.replace(/^\//, ""); // "branding/logo.png"
    const logoFsPath = path.join(__dirname, "..", "data", logoUrlPath);

    if (!fs.existsSync(logoFsPath)) {
      return pngBuffer;
    }

    const logoRatio = Number(options.logoRatio) > 0 ? Number(options.logoRatio) : 0.25;
    const padRatio =
      Number(options.logoPadRatio) >= 0 ? Number(options.logoPadRatio) : 0.04;

    const [qrImage, logoImageOriginal] = await Promise.all([
      Jimp.read(pngBuffer),
      Jimp.read(logoFsPath),
    ]);

    const qrWidth = qrImage.getWidth();
    const qrHeight = qrImage.getHeight();

    const badgeMax = Math.floor(Math.min(qrWidth, qrHeight) * logoRatio);
    const padding = Math.max(2, Math.floor(badgeMax * padRatio));
    const innerMax = Math.max(1, badgeMax - padding * 2);

    const nativeW = logoImageOriginal.getWidth();
    const nativeH = logoImageOriginal.getHeight();

    let logoW = innerMax;
    let logoH = innerMax;
    if (nativeW > 0 && nativeH > 0) {
      const fitScale = Math.min(innerMax / nativeW, innerMax / nativeH);
      const scale = Math.min(fitScale, 1);
      logoW = Math.max(1, Math.round(nativeW * scale));
      logoH = Math.max(1, Math.round(nativeH * scale));
    }

    const logoImage = logoImageOriginal.clone();
    const resizeMode = Jimp.RESIZE_BICUBIC || Jimp.RESIZE_BEZIER;
    logoImage.resize(logoW, logoH, resizeMode);

    const bgWidth = logoImage.getWidth() + padding * 2;
    const bgHeight = logoImage.getHeight() + padding * 2;

    const bgX = Math.floor((qrWidth - bgWidth) / 2);
    const bgY = Math.floor((qrHeight - bgHeight) / 2);

    qrImage.scan(bgX, bgY, bgWidth, bgHeight, function (x, y, idx) {
      this.bitmap.data[idx + 0] = 255;
      this.bitmap.data[idx + 1] = 255;
      this.bitmap.data[idx + 2] = 255;
      this.bitmap.data[idx + 3] = 255;
    });

    const logoX = bgX + padding;
    const logoY = bgY + padding;

    qrImage.composite(logoImage, logoX, logoY);

    return await qrImage.getBufferAsync(Jimp.MIME_PNG);
  } catch (err) {
    console.error("Failed to add logo to QR:", err);
    return pngBuffer;
  }
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
  buildOttEnrollUrl,
  buildPreferenceUrl,
  generateDisplayQrDataUrl,
  generateDownloadPng,
};
