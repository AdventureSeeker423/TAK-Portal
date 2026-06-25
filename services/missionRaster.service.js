/**
 * GeoTIFF / raster mission attachments → georeferenced PNG for MapLibre.
 */
const sharp = require("sharp");
const geotiff = require("geotiff");
const dataSyncSvc = require("./dataSync.service");
const {
  missionContentsList,
  contentHash,
  contentName,
  contentMime,
  parseMissionBbox,
} = require("./missionContents.util");

const RASTER_EXT = /\.(tif|tiff|geotiff|grg|png|jpg|jpeg)$/i;

function isRasterContent(entry) {
  const mime = contentMime(entry);
  const name = contentName(entry).toLowerCase();
  if (
    mime === "image/tiff" ||
    mime === "image/geotiff" ||
    mime === "image/png" ||
    mime === "image/jpeg" ||
    mime === "application/geotiff"
  ) {
    return true;
  }
  if (mime === "application/octet-stream" && RASTER_EXT.test(name)) return true;
  return RASTER_EXT.test(name);
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

async function readBoundsFromBuffer(buf) {
  try {
    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const tiff = await geotiff.fromArrayBuffer(arrayBuffer);
    const image = await tiff.getImage();
    const bbox = image.getBoundingBox();
    if (!bbox || bbox.length < 4) return null;
    const west = Number(bbox[0]);
    const south = Number(bbox[1]);
    const east = Number(bbox[2]);
    const north = Number(bbox[3]);
    if (![west, south, east, north].every(Number.isFinite)) return null;
    if (east <= west || north <= south) return null;
    return [west, south, east, north];
  } catch (_) {
    return null;
  }
}

function boundsToImageCoordinates(bounds) {
  const [west, south, east, north] = bounds;
  return [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ];
}

/**
 * Render raster to PNG with optional georeferencing bounds.
 */
async function renderRasterPng(hash, options = {}) {
  const buf = await loadRasterBuffer(hash);
  const maxDim = options.maxDim != null ? options.maxDim : 4096;
  let bounds = options.bounds || null;
  if (!bounds) {
    bounds = await readBoundsFromBuffer(buf);
  }

  const out = await sharp(buf, { limitInputPixels: 536870912 })
    .rotate()
    .resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  const meta = await sharp(buf).metadata();

  return {
    buffer: out,
    contentType: "image/png",
    width: meta.width || null,
    height: meta.height || null,
    bounds,
    coordinates: bounds ? boundsToImageCoordinates(bounds) : null,
  };
}

function findRasterContents(missionPayload) {
  return missionContentsList(missionPayload).filter(
    (e) => isRasterContent(e) && contentHash(e)
  );
}

async function buildRasterOverlays(missionName, missionPayload) {
  const mission = missionPayload || {};
  const missionBbox = parseMissionBbox(mission);
  const overlays = [];

  for (const entry of findRasterContents(mission)) {
    const hash = contentHash(entry);
    const name = contentName(entry) || hash;
    let bounds = missionBbox;
    if (!bounds) {
      try {
        const buf = await loadRasterBuffer(hash);
        bounds = await readBoundsFromBuffer(buf);
      } catch (err) {
        console.warn("[mission-raster] bounds read failed", hash, err?.message || err);
      }
    }
    if (!bounds) continue;

    overlays.push({
      hash,
      name,
      bounds,
      coordinates: boundsToImageCoordinates(bounds),
      url:
        "/api/map/missions/" +
        encodeURIComponent(missionName) +
        "/raster/" +
        encodeURIComponent(hash) +
        "?bounds=" +
        encodeURIComponent(bounds.join(",")),
    });
  }

  return overlays;
}

module.exports = {
  isRasterContent,
  contentHash,
  findRasterContents,
  renderRasterPng,
  readBoundsFromBuffer,
  parseMissionBbox,
  boundsToImageCoordinates,
  buildRasterOverlays,
};
