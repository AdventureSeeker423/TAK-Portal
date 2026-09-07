/**
 * After-action PDF for a live locator: branding, collected form data, and ping history.
 */

const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const Jimp = require("jimp");
const settingsSvc = require("./settings.service");
const locatorForm = require("./locatorForm.service");

const INK = "#0f172a";
const MUTED = "#64748b";
const LINE = "#cbd5e1";
const RULE = "#94a3b8";
const TILE_SIZE = 256;
const MAP_MAX_TILES = 12;
const PIN_FIRST = "#15803d";
const PIN_MIDDLE = "#94a3b8";
const PIN_LAST = "#dc2626";
const MAP_LAYERS = {
  street: {
    label: "Street",
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    attribution: "Map data © OpenStreetMap contributors",
  },
  satellite: {
    label: "Satellite",
    url: (z, x, y) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
  },
};

function pdfSafe(value) {
  return String(value ?? "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^\t\n\r\x20-\x7e]/g, "");
}

function defaultBrandLogoPath() {
  try {
    const settings = settingsSvc.getSettings() || {};
    const logoUrl = settings.BRAND_LOGO_URL;
    if (!logoUrl || typeof logoUrl !== "string") return "";
    const logoFsPath = path.join(__dirname, "..", "data", logoUrl.replace(/^\//, ""));
    return fs.existsSync(logoFsPath) ? logoFsPath : "";
  } catch (_) {
    return "";
  }
}

function serverNameFromSettings() {
  try {
    const settings = settingsSvc.getSettings() || {};
    return String(settings.SERVER_NAME || "").trim() || "TAK Portal";
  } catch (_) {
    return "TAK Portal";
  }
}

function reportFileName(locator, generatedAt) {
  const slug = String(locator?.slug || locator?.title || "locator")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "locator";
  const dt = generatedAt instanceof Date ? generatedAt : new Date(generatedAt || Date.now());
  const stamp = dt.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `locate-report-${slug}-${stamp}.pdf`;
}

function formatUtcStamp(d, options) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "—";
  const text = dt.toLocaleString(undefined, {
    ...options,
    timeZone: "UTC",
  });
  return /\bUTC\b/i.test(text) ? text : `${text} UTC`;
}

function formatReportWhen(d) {
  return formatUtcStamp(d, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatLogWhen(d) {
  return formatUtcStamp(d, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function pinStyleForIndex(index, total) {
  const n = Number(total) || 0;
  const i = Number(index);
  if (n <= 1) return { hex: PIN_LAST, radius: 7 };
  if (i === 0) return { hex: PIN_FIRST, radius: 7 };
  if (i === n - 1) return { hex: PIN_LAST, radius: 7 };
  return { hex: PIN_MIDDLE, radius: 4 };
}

function haversineMeters(a, b) {
  const lat1 = Number(a?.latitude);
  const lon1 = Number(a?.longitude);
  const lat2 = Number(b?.latitude);
  const lon2 = Number(b?.longitude);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return 0;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function numberedFixes(history) {
  return (Array.isArray(history) ? history : [])
    .map((h) => ({
      ...h,
      latitude: h?.latitude == null ? null : Number(h.latitude),
      longitude: h?.longitude == null ? null : Number(h.longitude),
    }))
    .filter((h) => Number.isFinite(h.latitude) && Number.isFinite(h.longitude));
}

function formatDistance(meters) {
  const n = Number(meters);
  if (!Number.isFinite(n) || n <= 0) return "0 m";
  if (n < 1000) return `${Math.round(n)} m`;
  return `${(n / 1000).toFixed(n >= 10000 ? 1 : 2)} km`;
}

function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "—";
  const sec = Math.round(n / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function summarizeTrack(history) {
  const rows = Array.isArray(history) ? history.slice() : [];
  const fixes = numberedFixes(rows);
  let distanceMeters = 0;
  for (let i = 1; i < fixes.length; i += 1) {
    distanceMeters += haversineMeters(fixes[i - 1], fixes[i]);
  }
  const first = fixes[0] || null;
  const last = fixes.length ? fixes[fixes.length - 1] : null;
  const firstAt = first?.at ? new Date(first.at) : null;
  const lastAt = last?.at ? new Date(last.at) : null;
  const accuracies = fixes
    .map((h) => Number(h.accuracyMeters))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return {
    pingCount: rows.length,
    fixCount: fixes.length,
    firstFixAt: firstAt && !Number.isNaN(firstAt.getTime()) ? firstAt.toISOString() : null,
    lastFixAt: lastAt && !Number.isNaN(lastAt.getTime()) ? lastAt.toISOString() : null,
    durationMs:
      firstAt && lastAt && !Number.isNaN(firstAt.getTime()) && !Number.isNaN(lastAt.getTime())
        ? Math.max(0, lastAt.getTime() - firstAt.getTime())
        : 0,
    distanceMeters,
    bestAccuracyMeters: accuracies.length ? Math.min(...accuracies) : null,
    worstAccuracyMeters: accuracies.length ? Math.max(...accuracies) : null,
  };
}

function locatorStatusLabel(locator) {
  if (locator?.archived) return "Archived";
  if (!locator?.active) return "Disabled";
  if (locator?.sharingStoppedByUser) return "Stopped by user";
  return "Active";
}

function intervalLabel(seconds) {
  const n = Number(seconds);
  if (n === 0) return "One-time";
  if (!Number.isFinite(n)) return "—";
  return `${n} seconds`;
}

function collectFormAnswers(form, history) {
  const normalized = locatorForm.normalizeForm(form || {});
  const fields = Array.isArray(normalized.fields) ? normalized.fields : [];
  const latest = {};
  for (const row of Array.isArray(history) ? history : []) {
    const answers = row?.answers && typeof row.answers === "object" ? row.answers : null;
    if (!answers) continue;
    for (const [key, value] of Object.entries(answers)) {
      const text = String(value ?? "").trim();
      if (text) latest[key] = text;
    }
  }
  const seen = new Set();
  const items = fields.map((field) => {
    seen.add(field.id);
    return {
      label: field.label,
      required: !!field.required,
      value: latest[field.id] || "",
    };
  });
  for (const [key, value] of Object.entries(latest)) {
    if (seen.has(key)) continue;
    items.push({ label: key, required: false, value });
  }
  return items;
}

function lon2tile(lon, zoom) {
  return ((Number(lon) + 180) / 360) * 2 ** zoom;
}

function lat2tile(lat, zoom) {
  const rad = (Number(lat) * Math.PI) / 180;
  return (
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** zoom
  );
}

function fitMapView(fixes) {
  const pts = numberedFixes(fixes);
  if (!pts.length) return null;
  let minLat = pts[0].latitude;
  let maxLat = pts[0].latitude;
  let minLon = pts[0].longitude;
  let maxLon = pts[0].longitude;
  for (const p of pts) {
    minLat = Math.min(minLat, p.latitude);
    maxLat = Math.max(maxLat, p.latitude);
    minLon = Math.min(minLon, p.longitude);
    maxLon = Math.max(maxLon, p.longitude);
  }
  const padLat = Math.max((maxLat - minLat) * 0.18, 0.002);
  const padLon = Math.max((maxLon - minLon) * 0.18, 0.002);
  minLat -= padLat;
  maxLat += padLat;
  minLon -= padLon;
  maxLon += padLon;
  let zoom = 15;
  for (let z = 16; z >= 3; z -= 1) {
    const x0 = lon2tile(minLon, z);
    const x1 = lon2tile(maxLon, z);
    const y0 = lat2tile(maxLat, z);
    const y1 = lat2tile(minLat, z);
    const tilesX = Math.ceil(x1) - Math.floor(x0);
    const tilesY = Math.ceil(y1) - Math.floor(y0);
    if (tilesX * tilesY <= MAP_MAX_TILES && tilesX <= 4 && tilesY <= 4) {
      zoom = z;
      break;
    }
  }
  const x0 = Math.floor(lon2tile(minLon, zoom));
  const x1 = Math.floor(lon2tile(maxLon, zoom));
  const y0 = Math.floor(lat2tile(maxLat, zoom));
  const y1 = Math.floor(lat2tile(minLat, zoom));
  return { zoom, x0, x1, y0, y1, minLat, maxLat, minLon, maxLon };
}

function hexToRgb(hex) {
  const s = String(hex || "").replace("#", "");
  const n = parseInt(s.length === 3 ? s.split("").map((c) => c + c).join("") : s, 16);
  if (!Number.isFinite(n)) return { r: 8, g: 145, b: 178 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function drawPin(img, px, py, hex, radius) {
  const rgb = hexToRgb(hex);
  const r = radius;
  const x0 = Math.max(0, Math.floor(px - r - 2));
  const y0 = Math.max(0, Math.floor(py - r - 2));
  const w = Math.min(img.bitmap.width - x0, Math.ceil(r * 2 + 4));
  const h = Math.min(img.bitmap.height - y0, Math.ceil(r * 2 + 4));
  img.scan(x0, y0, w, h, function (x, y, idx) {
    const dx = x - px;
    const dy = y - py;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= r && d >= r - 1.4) {
      this.bitmap.data[idx] = 255;
      this.bitmap.data[idx + 1] = 255;
      this.bitmap.data[idx + 2] = 255;
      this.bitmap.data[idx + 3] = 255;
    } else if (d < r - 1.4) {
      this.bitmap.data[idx] = rgb.r;
      this.bitmap.data[idx + 1] = rgb.g;
      this.bitmap.data[idx + 2] = rgb.b;
      this.bitmap.data[idx + 3] = 255;
    }
  });
}

async function fetchMapTile(layerId, z, x, y) {
  const layer = MAP_LAYERS[layerId] || MAP_LAYERS.street;
  const max = 2 ** z;
  const xx = ((x % max) + max) % max;
  const url = layer.url(z, xx, y);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        Accept: "image/png,image/jpeg",
        "User-Agent": "TAK-Portal/1.0 (locator after-action report)",
      },
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function buildTrackMapPng(history, { layer = "street" } = {}) {
  const fixes = numberedFixes(history);
  if (!fixes.length) return null;
  const view = fitMapView(fixes);
  if (!view) return null;
  const { zoom, x0, x1, y0, y1 } = view;
  const width = (x1 - x0 + 1) * TILE_SIZE;
  const height = (y1 - y0 + 1) * TILE_SIZE;
  if (width <= 0 || height <= 0 || width > 2048 || height > 2048) return null;

  const canvas = new Jimp(width, height, 0xffe2e8f0);
  const jobs = [];
  for (let ty = y0; ty <= y1; ty += 1) {
    for (let tx = x0; tx <= x1; tx += 1) {
      jobs.push({ tx, ty, buf: fetchMapTile(layer, zoom, tx, ty) });
    }
  }
  const tiles = await Promise.all(jobs.map((j) => j.buf));
  let anyTile = false;
  for (let i = 0; i < jobs.length; i += 1) {
    const buf = tiles[i];
    if (!buf) continue;
    try {
      const tile = await Jimp.read(buf);
      canvas.composite(tile, (jobs[i].tx - x0) * TILE_SIZE, (jobs[i].ty - y0) * TILE_SIZE);
      anyTile = true;
    } catch (_) {
      /* skip broken tile */
    }
  }
  if (!anyTile) return null;

  fixes.forEach((pt, i) => {
    const px = (lon2tile(pt.longitude, zoom) - x0) * TILE_SIZE;
    const py = (lat2tile(pt.latitude, zoom) - y0) * TILE_SIZE;
    const pin = pinStyleForIndex(i, fixes.length);
    drawPin(canvas, px, py, pin.hex, pin.radius);
  });
  return canvas.getBufferAsync(Jimp.MIME_PNG);
}

async function loadLogoPng(logoPath) {
  if (!logoPath) return null;
  try {
    const image = await Jimp.read(logoPath);
    return await image.getBufferAsync(Jimp.MIME_PNG);
  } catch (_) {
    return null;
  }
}

function contentWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function ensureSpace(doc, need) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + need > bottom) {
    doc.addPage({ size: "LETTER", margin: 50 });
  }
  doc.x = doc.page.margins.left;
}

function sectionHeading(doc, title) {
  ensureSpace(doc, 36);
  doc.moveDown(0.6);
  doc.font("Helvetica-Bold").fontSize(12).fillColor(INK).text(pdfSafe(title));
  const y = doc.y + 4;
  doc
    .moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .strokeColor(RULE)
    .lineWidth(0.8)
    .stroke();
  doc.y = y + 10;
}

function kvGrid(doc, pairs) {
  const colGap = 16;
  const colW = (contentWidth(doc) - colGap) / 2;
  let i = 0;
  while (i < pairs.length) {
    ensureSpace(doc, 32);
    const y = doc.y;
    const left = pairs[i];
    const right = pairs[i + 1];
    drawKv(doc, left, doc.page.margins.left, y, colW);
    const leftH = doc.y - y;
    doc.y = y;
    if (right) drawKv(doc, right, doc.page.margins.left + colW + colGap, y, colW);
    const rightH = doc.y - y;
    doc.y = y + Math.max(leftH, rightH, 22) + 6;
    i += 2;
  }
  doc.x = doc.page.margins.left;
}

function drawKv(doc, pair, x, y, width) {
  if (!pair) return;
  doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(pdfSafe(pair.label).toUpperCase(), x, y, {
    width,
  });
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor(INK)
    .text(pdfSafe(pair.value || "—"), x, y + 11, { width });
}

function drawHeader(doc, { serverName, generatedAt, logoPng }) {
  const left = doc.page.margins.left;
  const top = doc.page.margins.top;
  const textX = logoPng ? left + 68 : left;
  const width = contentWidth(doc) - (logoPng ? 68 : 0);
  if (logoPng) {
    try {
      doc.image(logoPng, left, top, { fit: [56, 56] });
    } catch (_) {
      /* ignore bad logo */
    }
  }
  doc.font("Helvetica-Bold").fontSize(16).fillColor(INK).text(pdfSafe(serverName), textX, top + 2, {
    width,
  });
  doc
    .font("Helvetica")
    .fontSize(12)
    .fillColor("#334155")
    .text("Locate After-Action Report", textX, top + 24, { width });
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(MUTED)
    .text(`Report generated ${formatReportWhen(generatedAt)}`, textX, top + 42, { width });
  doc.y = Math.max(top + 64, doc.y);
  const ruleY = doc.y + 6;
  doc
    .moveTo(left, ruleY)
    .lineTo(doc.page.width - doc.page.margins.right, ruleY)
    .strokeColor(INK)
    .lineWidth(1.4)
    .stroke();
  doc.y = ruleY + 14;
  doc.x = doc.page.margins.left;
}

function renderPdf(doc, payload) {
  const {
    locator,
    history,
    serverName,
    generatedAt,
    logoPng,
    streetMapPng,
    satelliteMapPng,
  } = payload;
  const form = locatorForm.normalizeForm(locator?.form || {});
  const stats = summarizeTrack(history);
  const answers = collectFormAnswers(form, history);
  const latestAnswerMap = {};
  for (const row of Array.isArray(history) ? history : []) {
    if (!row?.answers || typeof row.answers !== "object") continue;
    Object.assign(latestAnswerMap, row.answers);
  }
  const title = String(locator?.title || "Untitled locator");

  drawHeader(doc, { serverName, generatedAt, logoPng });
  doc.font("Helvetica-Bold").fontSize(18).fillColor(INK).text(pdfSafe(title), {
    width: contentWidth(doc),
  });
  doc.moveDown(0.25);
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(MUTED)
    .text("Summary of location sharing and information collected from the tracked device.", {
      width: contentWidth(doc),
    });

  sectionHeading(doc, "Locator");
  kvGrid(doc, [
    { label: "Status", value: locatorStatusLabel(locator) },
    { label: "Assigned channel", value: locator?.channelDisplay || locator?.channel || "—" },
    { label: "Data sync mission", value: locator?.mission || "None" },
    { label: "Marker Color", value: locator?.color || "—" },
    { label: "Interval", value: intervalLabel(locator?.pingIntervalSeconds) },
    { label: "Drop points", value: locator?.dropPoints ? "On" : "Off" },
    { label: "Created", value: locator?.createdAt ? formatReportWhen(locator.createdAt) : "—" },
    { label: "Last updated", value: locator?.updatedAt ? formatReportWhen(locator.updatedAt) : "—" },
    { label: "Public slug", value: locator?.slug || "—" },
    { label: "Callsign", value: locatorForm.formatLiveCallsign(title, form, latestAnswerMap) },
  ]);

  sectionHeading(doc, "Track summary");
  kvGrid(doc, [
    { label: "Position reports", value: String(stats.fixCount) },
    { label: "Total history rows", value: String(stats.pingCount) },
    { label: "First fix", value: stats.firstFixAt ? formatReportWhen(stats.firstFixAt) : "None" },
    { label: "Last fix", value: stats.lastFixAt ? formatReportWhen(stats.lastFixAt) : "None" },
    { label: "Time spanned", value: formatDuration(stats.durationMs) },
    { label: "Distance traveled", value: formatDistance(stats.distanceMeters) },
    {
      label: "Best accuracy",
      value: stats.bestAccuracyMeters != null ? `${Math.round(stats.bestAccuracyMeters)} m` : "—",
    },
    {
      label: "Worst accuracy",
      value: stats.worstAccuracyMeters != null ? `${Math.round(stats.worstAccuracyMeters)} m` : "—",
    },
  ]);

  sectionHeading(doc, "Information collected");
  if (!answers.length) {
    doc.font("Helvetica").fontSize(10).fillColor(MUTED).text("No additional fields were configured.");
  } else {
    const filled = answers.filter((a) => a.value);
    if (!filled.length) {
      doc.font("Helvetica").fontSize(10).fillColor(MUTED).text("No form answers were recorded.");
    }
    for (const item of answers) {
      ensureSpace(doc, 28);
      const req = item.required ? " (required)" : "";
      doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(pdfSafe(`${item.label}${req}`), {
        width: contentWidth(doc),
      });
      doc
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor(INK)
        .text(pdfSafe(item.value || "Not provided"), { width: contentWidth(doc) });
      doc.moveDown(0.25);
    }
  }

  doc.addPage({ size: "LETTER", margin: 50 });
  sectionHeading(doc, "Position log");
  const rows = Array.isArray(history) ? history : [];
  if (!rows.length) {
    doc.font("Helvetica").fontSize(10).fillColor(MUTED).text("No location history was recorded.");
  } else {
    drawLogTable(doc, rows, form);
  }

  if (streetMapPng || satelliteMapPng) {
    doc.addPage({ size: "LETTER", margin: 50 });
    drawMapsPage(doc, { streetMapPng, satelliteMapPng });
  }
}

function drawMapsPage(doc, { streetMapPng, satelliteMapPng }) {
  sectionHeading(doc, "Track maps");
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(MUTED)
    .text("First fix is dark green. Later pings are grey. The last fix is red.", {
      width: contentWidth(doc),
    });
  doc.moveDown(0.35);
  const maps = [
    { png: streetMapPng, title: "Street", attribution: MAP_LAYERS.street.attribution },
    { png: satelliteMapPng, title: "Satellite", attribution: MAP_LAYERS.satellite.attribution },
  ].filter((m) => m.png);
  const maxW = contentWidth(doc);
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  maps.forEach((map, idx) => {
    const captionH = 22;
    let avail = bottom() - doc.y - captionH - 8;
    if (idx > 0 && avail < 150) {
      doc.addPage({ size: "LETTER", margin: 50 });
      avail = bottom() - doc.y - captionH - 8;
    }
    const fitH = Math.max(120, Math.min(260, avail));
    doc.x = doc.page.margins.left;
    doc.font("Helvetica-Bold").fontSize(10).fillColor(INK).text(map.title, {
      width: maxW,
    });
    try {
      const imgY = doc.y + 2;
      doc.image(map.png, doc.page.margins.left, imgY, {
        fit: [maxW, fitH],
        align: "center",
      });
      doc.y = Math.min(imgY + fitH + 4, bottom() - 12);
      doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(map.attribution, {
        width: maxW,
        height: 12,
        lineBreak: false,
      });
    } catch (_) {
      doc.font("Helvetica").fontSize(10).fillColor(MUTED).text(`${map.title} map could not be embedded.`);
    }
  });
}

function drawLogTable(doc, rows, form) {
  const left = doc.page.margins.left;
  const widths = [28, 140, 64, 72, 42, 48];
  const detailsW = contentWidth(doc) - widths.reduce((a, b) => a + b, 0);
  const cols = [...widths, detailsW];
  const headers = ["#", "Time", "Latitude", "Longitude", "Acc.", "Source", "Details"];

  function headerRow() {
    ensureSpace(doc, 22);
    const y = doc.y;
    let x = left;
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED);
    headers.forEach((h, i) => {
      doc.text(h, x, y, {
        width: cols[i] - 4,
        lineBreak: false,
      });
      x += cols[i];
    });
    doc.x = left;
    doc.y = y + 12;
    doc
      .moveTo(left, doc.y)
      .lineTo(doc.page.width - doc.page.margins.right, doc.y)
      .strokeColor(LINE)
      .lineWidth(0.6)
      .stroke();
    doc.y += 6;
    doc.x = left;
  }

  headerRow();
  rows.forEach((row, idx) => {
    const lat = Number(row.latitude);
    const lon = Number(row.longitude);
    const acc = Number(row.accuracyMeters);
    const details = [
      row.callsign || row.name || "",
      row.remarks || "",
      formatAnswerLine(form, row.answers),
    ]
      .map((s) => String(s || "").trim())
      .filter(Boolean)
      .join(" | ");
    const cells = [
      String(idx + 1),
      row.at ? formatLogWhen(row.at) : "—",
      Number.isFinite(lat) ? lat.toFixed(6) : "—",
      Number.isFinite(lon) ? lon.toFixed(6) : "—",
      Number.isFinite(acc) ? `${Math.round(acc)} m` : "—",
      row.kind === "manual" ? "Manual" : "Ping",
      details || "—",
    ];
    doc.font("Helvetica").fontSize(7.5).fillColor(INK);
    const heights = cells.map((text, i) =>
      doc.heightOfString(pdfSafe(text), { width: cols[i] - 4 })
    );
    const rowH = Math.max(14, ...heights) + 6;
    if (doc.y + rowH > doc.page.height - doc.page.margins.bottom) {
      doc.addPage({ size: "LETTER", margin: 50 });
      headerRow();
    }
    const y = doc.y;
    if (idx % 2 === 1) {
      doc
        .rect(left, y - 1, contentWidth(doc), rowH)
        .fillColor("#f8fafc")
        .fill();
    }
    let x = left;
    cells.forEach((text, i) => {
      doc.font("Helvetica").fontSize(7.5).fillColor(INK).text(pdfSafe(text), x, y, {
        width: cols[i] - 4,
      });
      x += cols[i];
    });
    doc.x = left;
    doc.y = y + rowH;
  });
}

function formatAnswerLine(form, answers) {
  if (!answers || typeof answers !== "object") return "";
  const fields = form?.fields || [];
  const parts = [];
  for (const field of fields) {
    const value = String(answers[field.id] ?? "").trim();
    if (value) parts.push(`${field.label}: ${value}`);
  }
  return parts.join("; ");
}

function stampPageNumbers(doc, serverName) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(i);
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 34;
    doc.font("Helvetica").fontSize(8).fillColor(MUTED);
    doc.text(pdfSafe(serverName), doc.page.margins.left, y, {
      width: contentWidth(doc) / 2,
      lineBreak: false,
      height: 10,
    });
    doc.text(`Page ${i + 1} of ${range.count}`, doc.page.margins.left, y, {
      width: contentWidth(doc),
      align: "right",
      lineBreak: false,
      height: 10,
    });
    doc.page.margins.bottom = savedBottom;
  }
}

function collectPdfBuffer(drawFn) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      size: "LETTER",
      margin: 50,
      bufferPages: true,
      info: {
        Title: "Locate After-Action Report",
        Author: "TAK Portal",
      },
    });
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    Promise.resolve()
      .then(() => drawFn(doc))
      .then(() => doc.end())
      .catch(reject);
  });
}

async function generateLocatorReportPdf(locator, history, options = {}) {
  const generatedAt = options.generatedAt instanceof Date ? options.generatedAt : new Date();
  const serverName = String(options.serverName || serverNameFromSettings()).trim() || "TAK Portal";
  const logoPath = options.logoPath !== undefined ? options.logoPath : defaultBrandLogoPath();
  const logoPng = await loadLogoPng(logoPath);
  let streetMapPng = options.streetMapPng !== undefined ? options.streetMapPng : null;
  let satelliteMapPng = options.satelliteMapPng !== undefined ? options.satelliteMapPng : null;
  if (options.includeMap !== false && options.streetMapPng === undefined && options.satelliteMapPng === undefined) {
    const [street, satellite] = await Promise.all([
      buildTrackMapPng(history, { layer: "street" }).catch(() => null),
      buildTrackMapPng(history, { layer: "satellite" }).catch(() => null),
    ]);
    streetMapPng = street;
    satelliteMapPng = satellite;
  }
  const buffer = await collectPdfBuffer(async (doc) => {
    renderPdf(doc, {
      locator,
      history: Array.isArray(history) ? history : [],
      serverName,
      generatedAt,
      logoPng,
      streetMapPng,
      satelliteMapPng,
    });
    stampPageNumbers(doc, serverName);
  });
  return {
    buffer,
    fileName: reportFileName(locator, generatedAt),
  };
}

module.exports = {
  haversineMeters,
  summarizeTrack,
  collectFormAnswers,
  reportFileName,
  formatReportWhen,
  formatLogWhen,
  formatDistance,
  formatDuration,
  locatorStatusLabel,
  intervalLabel,
  fitMapView,
  pinStyleForIndex,
  generateLocatorReportPdf,
};
