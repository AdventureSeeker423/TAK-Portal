const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Jimp = require("jimp"); // Jimp 0.22.x
const settingsSvc = require("./settings.service");
const { addLogoToQrPng, logoCacheIdentity } = require("./qrLogoOverlay.service");

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
 * Build ATAK device preference URL for callsign, team (color), role, and
 * Plugin Update Server settings when TAK host is known.
 * Format: tak://com.atakmap.app/preference?key1=...&type1=...&value1=...&key2=...
 */
function buildPreferenceUrl({ callsign, teamLabel, roleLabel }) {
  const c = String(callsign || "").trim();
  const t = String(teamLabel || "").trim();
  const r = String(roleLabel || "Team Member").trim();

  const entries = [];
  if (c) entries.push({ key: "locationCallsign", type: "string", value: c });
  if (t) entries.push({ key: "locationTeam", type: "string", value: t });
  if (r) entries.push({ key: "atakRoleType", type: "string", value: r });

  const host = getTakHost();
  if (host) {
    entries.push(
      { key: "appMgmtEnableUpdateServer", type: "boolean", value: "true" },
      {
        key: "atakUpdateServerUrl",
        type: "string",
        value: `https://${host}:8443/update`,
      },
      { key: "repoStartupSync", type: "boolean", value: "true" }
    );
  }

  if (!entries.length) return null;

  const params = entries.map((entry, i) => {
    const n = i + 1;
    return (
      `key${n}=${encodeURIComponent(entry.key)}` +
      `&type${n}=${encodeURIComponent(entry.type)}` +
      `&value${n}=${encodeURIComponent(entry.value)}`
    );
  });

  return `tak://com.atakmap.app/preference?${params.join("&")}`;
}

const QR_PNG_CACHE_MAX = 250;
/** @type {Map<string, Buffer>} */
const qrPngCache = new Map();
let _sans64BlackFont = null;

function defaultBrandLogoPath() {
  const settings = settingsSvc.getSettings() || {};
  const logoUrl = settings.BRAND_LOGO_URL;
  if (!logoUrl || typeof logoUrl !== "string") return "";
  const logoFsPath = path.join(__dirname, "..", "data", logoUrl.replace(/^\//, ""));
  return fs.existsSync(logoFsPath) ? logoFsPath : "";
}

function qrPngCacheKey(content, options = {}) {
  const width = Number(options.width) > 0 ? Number(options.width) : 512;
  const margin = options.margin != null ? Number(options.margin) : 2;
  const logoPath =
    options.logoPath != null ? String(options.logoPath || "") : defaultBrandLogoPath();
  const logoId = logoPath ? logoCacheIdentity(logoPath) || logoPath : "nologo";
  const logoRatio = options.logoRatio != null ? String(options.logoRatio) : "";
  const username = String(options.usernameLabel || "")
    .trim()
    .toUpperCase();
  return crypto
    .createHash("sha256")
    .update(
      [String(content || ""), width, margin, logoId, logoRatio, username].join("\0")
    )
    .digest("hex");
}

function displayQrCacheKey(content) {
  return qrPngCacheKey(content, { width: 512, margin: 2 });
}

function getCachedQrPng(key) {
  const hit = qrPngCache.get(key);
  if (!hit) return null;
  qrPngCache.delete(key);
  qrPngCache.set(key, hit);
  return hit;
}

function setCachedQrPng(key, buf) {
  if (qrPngCache.has(key)) qrPngCache.delete(key);
  qrPngCache.set(key, buf);
  while (qrPngCache.size > QR_PNG_CACHE_MAX) {
    const oldest = qrPngCache.keys().next().value;
    qrPngCache.delete(oldest);
  }
}

async function addLogoToPng(pngBuffer, options = {}) {
  const logoFsPath = defaultBrandLogoPath();
  if (!logoFsPath) return pngBuffer;
  return addLogoToQrPng(pngBuffer, logoFsPath, options);
}

async function getSans64BlackFont() {
  if (!_sans64BlackFont) {
    _sans64BlackFont = await Jimp.loadFont(Jimp.FONT_SANS_64_BLACK);
  }
  return _sans64BlackFont;
}

// Add username label underneath the QR image (for downloaded image only)
async function addUsernameLabel(pngBuffer, username) {
  try {
    const qrImage = await Jimp.read(pngBuffer);
    const font = await getSans64BlackFont();

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

/**
 * Generate a QR PNG with optional logo overlay and username label.
 * Results are cached in-memory by content + size + logo identity.
 */
async function generateQrPngBuffer(content, options = {}) {
  const text = String(content || "");
  if (!text) return Buffer.alloc(0);
  const width = Number(options.width) > 0 ? Number(options.width) : 512;
  const margin = options.margin != null ? Number(options.margin) : 2;
  const key = qrPngCacheKey(text, options);
  const cached = getCachedQrPng(key);
  if (cached) return cached;

  const basePng = await QRCode.toBuffer(text, {
    errorCorrectionLevel: "H",
    type: "png",
    width,
    margin,
    color: {
      dark: "#000000",
      light: "#FFFFFF",
    },
  });

  const overlayOpts =
    options.logoRatio != null ? { logoRatio: options.logoRatio } : {};
  let finalPng = basePng;
  if (options.logoPath) {
    finalPng = await addLogoToQrPng(finalPng, options.logoPath, overlayOpts);
  } else if (options.logoPath !== "") {
    finalPng = await addLogoToPng(finalPng, overlayOpts);
  }

  if (options.usernameLabel) {
    finalPng = await addUsernameLabel(finalPng, options.usernameLabel);
  }

  setCachedQrPng(key, finalPng);
  return finalPng;
}

async function generateDisplayQrDataUrl(enrollUrl, options = {}) {
  const content = String(enrollUrl || "");
  if (!content) return "";
  const buf = await generateQrPngBuffer(content, {
    width: 512,
    margin: 2,
    ...options,
  });
  return "data:image/png;base64," + buf.toString("base64");
}

async function generateDownloadPng(enrollUrl, username) {
  return generateQrPngBuffer(enrollUrl, {
    width: 1200,
    margin: 3,
    usernameLabel: username,
  });
}

module.exports = {
  getTakUrl,
  getTakHost,
  buildEnrollUrl,
  buildItakEnrollPayload,
  buildPreferenceUrl,
  generateDisplayQrDataUrl,
  generateDownloadPng,
  generateQrPngBuffer,
  displayQrCacheKey,
};
