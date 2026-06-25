/**
 * GeoTIFF / raster mission attachments → georeferenced PNG for MapLibre.
 */
const sharp = require("sharp");
const geotiff = require("geotiff");
const dataSyncSvc = require("./dataSync.service");
const {
  listMissionAttachmentEntries,
  contentHash,
  contentName,
  contentMime,
  parseMissionBbox,
  looksLikeLatLonBbox,
} = require("./missionContents.util");

const RASTER_EXT = /\.(tif|tiff|geotiff|grg|png|jpg|jpeg)$/i;
const KML_EXT = /\.(kml|kmz)$/i;

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
  if (entry?._attachmentSource === "baseLayer" || entry?._attachmentSource === "mapLayer") {
    return true;
  }
  return RASTER_EXT.test(name);
}

function bufferLooksLikeKml(buf) {
  const sample = buf.slice(0, Math.min(buf.length, 800)).toString("utf8").toLowerCase();
  return sample.includes("<kml") || (sample.includes("<?xml") && sample.includes("kml"));
}

function bufferLooksLikeZip(buf) {
  return buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b;
}

function bufferLooksLikeTiff(buf) {
  if (buf.length < 4) return false;
  const le = buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00;
  const be = buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a;
  return le || be;
}

function bufferLooksLikeRaster(buf) {
  if (!buf || buf.length < 4) return false;
  if (bufferLooksLikeKml(buf) || bufferLooksLikeZip(buf)) return false;
  if (bufferLooksLikeTiff(buf)) return true;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf[0] === 0xff && buf[1] === 0xd8) return true;
  return false;
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

function normalizeBounds(bounds) {
  if (!bounds || bounds.length < 4) return null;
  let a = Number(bounds[0]);
  let b = Number(bounds[1]);
  let c = Number(bounds[2]);
  let d = Number(bounds[3]);
  if (![a, b, c, d].every(Number.isFinite)) return null;
  let west;
  let south;
  let east;
  let north;
  if (looksLikeLatLonBbox(a, b, c, d)) {
    south = Math.min(a, c);
    north = Math.max(a, c);
    west = Math.min(b, d);
    east = Math.max(b, d);
  } else {
    west = Math.min(a, c);
    east = Math.max(a, c);
    south = Math.min(b, d);
    north = Math.max(b, d);
  }
  if (east <= west || north <= south) return null;
  return [west, south, east, north];
}

function boundsToImageCoordinates(bounds) {
  const normalized = normalizeBounds(bounds);
  if (!normalized) return null;
  const [west, south, east, north] = normalized;
  return [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ];
}

function extendBounds(bounds, lon, lat) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return bounds;
  if (!bounds) return [lon, lat, lon, lat];
  return [
    Math.min(bounds[0], lon),
    Math.min(bounds[1], lat),
    Math.max(bounds[2], lon),
    Math.max(bounds[3], lat),
  ];
}

function boundsFromGeometry(bounds, geom) {
  if (!geom || !geom.coordinates) return bounds;
  const type = String(geom.type || "");
  if (type === "Point") {
    const [lon, lat] = geom.coordinates;
    return extendBounds(bounds, lon, lat);
  }
  if (type === "LineString") {
    for (const coord of geom.coordinates) {
      bounds = extendBounds(bounds, coord[0], coord[1]);
    }
    return bounds;
  }
  if (type === "Polygon") {
    for (const ring of geom.coordinates) {
      for (const coord of ring) {
        bounds = extendBounds(bounds, coord[0], coord[1]);
      }
    }
    return bounds;
  }
  if (type === "MultiPolygon") {
    for (const poly of geom.coordinates) {
      for (const ring of poly) {
        for (const coord of ring) {
          bounds = extendBounds(bounds, coord[0], coord[1]);
        }
      }
    }
  }
  return bounds;
}

function boundsFromFeatures(features) {
  let bounds = null;
  for (const feature of features || []) {
    bounds = boundsFromGeometry(bounds, feature?.geometry);
  }
  if (!bounds) return null;
  const [west, south, east, north] = bounds;
  if (east <= west || north <= south) return null;
  return bounds;
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

async function classifyRasterEntry(entry) {
  if (isRasterContent(entry)) return true;
  const name = contentName(entry).toLowerCase();
  if (KML_EXT.test(name)) return false;
  const mime = contentMime(entry);
  if (mime.includes("kml") || mime.includes("xml")) return false;
  const hash = contentHash(entry);
  if (!hash) return false;
  try {
    const buf = await loadRasterBuffer(hash);
    return bufferLooksLikeRaster(buf);
  } catch (_) {
    return false;
  }
}

async function findRasterContents(missionPayload) {
  const entries = listMissionAttachmentEntries(missionPayload);
  const results = [];
  for (const entry of entries) {
    const hash = contentHash(entry);
    if (!hash) continue;
    if (await classifyRasterEntry(entry)) {
      results.push(entry);
    }
  }
  return results;
}

async function buildRasterOverlays(missionName, missionPayload, options = {}) {
  const mission = missionPayload || {};
  const missionBbox = parseMissionBbox(mission);
  const featureBounds = boundsFromFeatures(options.features || []);
  const overlays = [];

  for (const entry of await findRasterContents(mission)) {
    const hash = contentHash(entry);
    const name = contentName(entry) || hash;
    let bounds = normalizeBounds(missionBbox) || normalizeBounds(featureBounds);
    if (!bounds) {
      try {
        const buf = await loadRasterBuffer(hash);
        bounds = normalizeBounds(await readBoundsFromBuffer(buf));
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
  normalizeBounds,
  boundsToImageCoordinates,
  boundsFromFeatures,
  bufferLooksLikeRaster,
  buildRasterOverlays,
};
