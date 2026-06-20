/**
 * Server-side map icon tinting and stable mapImageId generation.
 */
const crypto = require("crypto");
const path = require("path");
const Jimp = require("jimp");
const { getInt } = require("./env");
const mapIcon = require("./mapIcon.service");

const CACHE_MAX = getInt("MAP_ICON_CACHE_SIZE", 4096);
const COLORED_ICON_SUFFIX = "-colored-";

/** @type {Map<string, { buffer: Buffer, contentType: string, at: number }>} */
const renderCache = new Map();

const BATCH_MAX = getInt("MAP_ICON_BATCH_MAX", 120);
const BATCH_CONCURRENCY = getInt("MAP_ICON_BATCH_CONCURRENCY", 8);

const stats = {
  hits: 0,
  misses: 0,
  lastRenderMs: 0,
  batchCount: 0,
  batchIconsTotal: 0,
  batchMsTotal: 0,
  lastBatchMs: 0,
  lastBatchIcons: 0,
};

function normalizeColorHex(color) {
  const s = String(color || "")
    .replace(/^#/, "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(s)) return "00ff00";
  return s;
}

function iconSkipsRecolor(marker, apiIconId) {
  if (String(apiIconId || "").startsWith("2525D:")) return true;
  if (String(marker?.iconSource || "").toLowerCase() === "type2525b") return true;
  return false;
}

function computeMapImageId(marker, apiIconId, colorHex) {
  const id = String(apiIconId || "").trim();
  if (!id) return "";
  const skip = iconSkipsRecolor(marker, id);
  const color = skip ? "raw" : normalizeColorHex(colorHex);
  const hash = crypto
    .createHash("sha256")
    .update(id + "|" + color + "|" + (skip ? "1" : "0"))
    .digest("hex")
    .slice(0, 16);
  return "mimg-" + hash;
}

function cacheGet(key) {
  const hit = renderCache.get(key);
  if (!hit) {
    stats.misses++;
    return null;
  }
  stats.hits++;
  hit.at = Date.now();
  return hit;
}

function cacheSet(key, buffer, contentType) {
  if (renderCache.size >= CACHE_MAX) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [k, v] of renderCache.entries()) {
      if (v.at < oldestAt) {
        oldestAt = v.at;
        oldestKey = k;
      }
    }
    if (oldestKey) renderCache.delete(oldestKey);
  }
  renderCache.set(key, { buffer, contentType, at: Date.now() });
}

function isWhitePixel(r, g, b) {
  return r > 200 && g > 200 && b > 200;
}

async function tintImageBuffer(inputBuffer, colorHex) {
  const image = await Jimp.read(inputBuffer);
  const rgb = hexToRgb(colorHex);
  image.scan(0, 0, image.bitmap.width, image.bitmap.height, function (x, y, idx) {
    const alpha = this.bitmap.data[idx + 3];
    if (alpha === 0) return;
    const r = this.bitmap.data[idx];
    const g = this.bitmap.data[idx + 1];
    const b = this.bitmap.data[idx + 2];
    if (isWhitePixel(r, g, b)) {
      this.bitmap.data[idx] = rgb.r;
      this.bitmap.data[idx + 1] = rgb.g;
      this.bitmap.data[idx + 2] = rgb.b;
    }
  });
  return image.getBufferAsync(Jimp.MIME_PNG);
}

function hexToRgb(colorHex) {
  const s = normalizeColorHex(colorHex);
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
  };
}

async function renderIconForMarker(marker) {
  const mapRender = require("./mapRender.service");
  const apiIconId = marker?.iconId ? String(marker.iconId) : "";
  if (!apiIconId || !mapRender.markerUsesMapIcon(marker)) {
    return { mapImageId: "", apiIconId: "", skipRecolor: true, buffer: null };
  }

  const color = mapRender.markerDisplayColor(marker);
  const skipRecolor = iconSkipsRecolor(marker, apiIconId);
  const mapImageId = computeMapImageId(marker, apiIconId, color);
  const cached = cacheGet(mapImageId);
  if (cached) {
    return {
      mapImageId,
      apiIconId,
      skipRecolor,
      buffer: cached.buffer,
      contentType: cached.contentType,
    };
  }

  const filePath = mapIcon.getIconFilePath(apiIconId);
  if (!filePath) {
    return { mapImageId: "", apiIconId, skipRecolor, buffer: null };
  }

  const started = Date.now();
  const fs = require("fs");
  const inputBuffer = fs.readFileSync(path.resolve(filePath));
  let outBuffer = inputBuffer;
  if (!skipRecolor && color) {
    outBuffer = await tintImageBuffer(inputBuffer, color);
  }
  stats.lastRenderMs = Date.now() - started;
  cacheSet(mapImageId, outBuffer, "image/png");
  return {
    mapImageId,
    apiIconId,
    skipRecolor,
    buffer: outBuffer,
    contentType: "image/png",
  };
}

async function getRenderedBuffer(mapImageId) {
  const id = String(mapImageId || "").trim();
  if (!id) return null;
  const cached = cacheGet(id);
  if (cached) return cached;
  return null;
}

function manifestEntryToMarker(entry) {
  const apiIconId = String(entry?.apiIconId || entry?.iconId || "").trim();
  if (!apiIconId) return null;
  return {
    iconId: apiIconId,
    iconSource: String(entry?.iconSource || ""),
    origin: String(entry?.origin || "feed"),
    type: String(entry?.type || ""),
    affiliation: String(entry?.affiliation || "friend"),
    teamColor: entry?.color || entry?.teamColor || null,
  };
}

async function runPool(items, concurrency, worker) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workers }, runWorker));
  return results;
}

async function renderIconBatch(entries, options = {}) {
  const started = Date.now();
  const maxItems = options.maxItems != null ? options.maxItems : BATCH_MAX;
  const concurrency = options.concurrency != null ? options.concurrency : BATCH_CONCURRENCY;
  const list = Array.isArray(entries) ? entries : [];
  const byId = new Map();

  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    const mapImageId = String(entry?.mapImageId || "").trim();
    if (!mapImageId || !mapImageId.startsWith("mimg-")) continue;
    if (!byId.has(mapImageId)) byId.set(mapImageId, entry);
  }

  const unique = Array.from(byId.values()).slice(0, maxItems);
  const icons = {};
  const missing = [];

  const rendered = await runPool(unique, concurrency, async function (entry) {
    const mapImageId = String(entry.mapImageId || "").trim();
    const marker = manifestEntryToMarker(entry);
    if (!marker) {
      missing.push(mapImageId);
      return null;
    }
    const result = await renderIconForMarker(marker);
    if (!result.buffer || result.mapImageId !== mapImageId) {
      missing.push(mapImageId);
      return null;
    }
    icons[mapImageId] = result.buffer.toString("base64");
    return mapImageId;
  });

  const elapsed = Date.now() - started;
  stats.batchCount++;
  stats.batchIconsTotal += rendered.filter(Boolean).length;
  stats.batchMsTotal += elapsed;
  stats.lastBatchMs = elapsed;
  stats.lastBatchIcons = rendered.filter(Boolean).length;

  return {
    icons,
    missing,
    requested: unique.length,
    rendered: Object.keys(icons).length,
    elapsedMs: elapsed,
  };
}

async function prewarmIconManifest(entries, options = {}) {
  return renderIconBatch(entries, {
    maxItems: options.maxItems,
    concurrency: options.concurrency,
  });
}

function getStats() {
  return {
    hits: stats.hits,
    misses: stats.misses,
    size: renderCache.size,
    maxSize: CACHE_MAX,
    lastRenderMs: stats.lastRenderMs,
    batchCount: stats.batchCount,
    batchIconsTotal: stats.batchIconsTotal,
    batchMsTotal: stats.batchMsTotal,
    lastBatchMs: stats.lastBatchMs,
    lastBatchIcons: stats.lastBatchIcons,
    batchMax: BATCH_MAX,
  };
}

module.exports = {
  computeMapImageId,
  iconSkipsRecolor,
  renderIconForMarker,
  renderIconBatch,
  prewarmIconManifest,
  getRenderedBuffer,
  getStats,
  COLORED_ICON_SUFFIX,
  BATCH_MAX,
};
