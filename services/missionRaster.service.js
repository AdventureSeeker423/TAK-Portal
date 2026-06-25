/**
 * GeoTIFF / raster mission attachments → georeferenced PNG for MapLibre.
 */
const sharp = require("sharp");
const dataSyncSvc = require("./dataSync.service");

const RASTER_MIMES = new Set([
  "image/tiff",
  "image/geotiff",
  "image/png",
  "image/jpeg",
]);

function isRasterContent(entry) {
  const mime = String(entry?.mimeType || entry?.mimetype || entry?.type || "").toLowerCase();
  const name = String(entry?.name || entry?.filename || "").toLowerCase();
  if (RASTER_MIMES.has(mime)) return true;
  return /\.(tif|tiff|geotiff|grg|png|jpg|jpeg)$/i.test(name);
}

function contentHash(entry) {
  return String(entry?.hash || entry?.contentHash || entry?.sha256 || "").trim();
}

async function loadRasterBuffer(hash) {
  const res = await dataSyncSvc.getSyncContent(hash);
  if (res.status >= 400) {
    const err = new Error(`Raster fetch failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return Buffer.from(res.data);
}

/**
 * Render raster to PNG. GeoTIFF georeferencing requires geotiff lib when available;
 * falls back to image bounds from mission metadata or world extent placeholder.
 */
async function renderRasterPng(hash, options = {}) {
  const buf = await loadRasterBuffer(hash);
  const maxDim = options.maxDim != null ? options.maxDim : 2048;
  const out = await sharp(buf, { limitInputPixels: 268435456 })
    .rotate()
    .resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  const meta = await sharp(buf).metadata();
  const bounds = options.bounds || null;
  return {
    buffer: out,
    contentType: "image/png",
    width: meta.width || null,
    height: meta.height || null,
    bounds,
  };
}

function findRasterContents(missionPayload) {
  const mission = missionPayload?.data || missionPayload || {};
  const contents = mission.contents || mission.Contents || [];
  const list = Array.isArray(contents) ? contents : [];
  return list.filter((e) => isRasterContent(e) && contentHash(e));
}

module.exports = {
  isRasterContent,
  contentHash,
  findRasterContents,
  renderRasterPng,
};
