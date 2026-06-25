/**
 * GeoTIFF / raster mission attachments → georeferenced PNG for MapLibre.
 */
const sharp = require("sharp");
const geotiff = require("geotiff");
const proj4 = require("proj4");
const geokeysToProj4 = require("geotiff-geokeys-to-proj4");
const dataSyncSvc = require("./dataSync.service");
const {
  listMissionAttachmentEntries,
  contentHash,
  contentName,
  contentMime,
  parseMissionBbox,
  looksLikeLatLonBbox,
  parseContentEntryBounds,
  parseContentEntryCoordinates,
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

function looksLikeGeographicBounds(bounds) {
  if (!bounds || bounds.length < 4) return false;
  const [minX, minY, maxX, maxY] = bounds;
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return false;
  if (Math.abs(minX) > 180 || Math.abs(maxX) > 180) return false;
  if (Math.abs(minY) > 90 || Math.abs(maxY) > 90) return false;
  return true;
}

function boundsFromLonLatCorners(corners) {
  if (!Array.isArray(corners) || corners.length < 4) return null;
  const lons = [];
  const lats = [];
  for (const corner of corners) {
    const lon = Number(corner?.[0]);
    const lat = Number(corner?.[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    lons.push(lon);
    lats.push(lat);
  }
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

function getPixelCornerCoords(image) {
  const width = image.getWidth();
  const height = image.getHeight();
  const fd = image.getFileDirectory();
  const modelTransformation = fd.getValue("ModelTransformation");
  const pixelCorners = [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ];

  if (modelTransformation) {
    const [a, b, , d, e, f, , h] = modelTransformation;
    return pixelCorners.map(([col, row]) => [d + a * col + b * row, h + e * col + f * row]);
  }

  const origin = image.getOrigin();
  const resolution = image.getResolution();
  return pixelCorners.map(([col, row]) => [
    origin[0] + col * resolution[0],
    origin[1] + row * resolution[1],
  ]);
}

function buildProjectionForImage(image) {
  const geoKeys = image.getGeoKeys();
  if (!geoKeys) return null;

  if (geoKeys.GeographicTypeGeoKey === 4326) {
    return { projection: null, projObj: null, isWgs84: true };
  }

  try {
    const projObj = geokeysToProj4.toProj4(geoKeys);
    if (!projObj?.proj4) return null;
    return {
      projection: proj4(projObj.proj4, "EPSG:4326"),
      projObj,
      isWgs84: false,
    };
  } catch (_) {
    const epsg = geoKeys.ProjectedCSTypeGeoKey || geoKeys.GeographicTypeGeoKey;
    if (!epsg) return null;
    try {
      return {
        projection: proj4(`EPSG:${epsg}`, "EPSG:4326"),
        projObj: null,
        isWgs84: false,
      };
    } catch (err) {
      return null;
    }
  }
}

function projectNativeCorner(nativeX, nativeY, projectionInfo) {
  if (!projectionInfo || projectionInfo.isWgs84 || !projectionInfo.projection) {
    return [nativeX, nativeY];
  }

  let x = nativeX;
  let y = nativeY;
  const params = projectionInfo.projObj?.coordinatesConversionParameters;
  if (params) {
    const converted = geokeysToProj4.convertCoordinates(nativeX, nativeY, 0, params);
    x = converted.x;
    y = converted.y;
  }

  const out = projectionInfo.projection.forward([x, y]);
  return [out[0], out[1]];
}

async function readGeorefFromImage(image) {
  let nativeCorners;
  try {
    nativeCorners = getPixelCornerCoords(image);
  } catch (_) {
    return null;
  }
  if (!nativeCorners || nativeCorners.length < 4) return null;

  const nativeBbox = image.getBoundingBox();
  const projectionInfo = buildProjectionForImage(image);

  if (
    !projectionInfo &&
    looksLikeGeographicBounds(nativeBbox)
  ) {
    const coordinates = nativeCorners.map(([x, y]) => [x, y]);
    const bounds = boundsFromLonLatCorners(coordinates);
    if (!bounds) return null;
    return { bounds: normalizeBounds(bounds), coordinates, crs: "native-geographic" };
  }

  const coordinates = nativeCorners.map(([x, y]) =>
    projectNativeCorner(x, y, projectionInfo)
  );
  const bounds = boundsFromLonLatCorners(coordinates);
  if (!bounds) return null;

  return {
    bounds: normalizeBounds(bounds),
    coordinates,
    crs: projectionInfo?.isWgs84 ? "EPSG:4326" : "reprojected",
  };
}

async function readGeorefFromBuffer(buf) {
  try {
    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const tiff = await geotiff.fromArrayBuffer(arrayBuffer);
    const image = await tiff.getImage();
    return readGeorefFromImage(image);
  } catch (_) {
    return null;
  }
}

async function readBoundsFromBuffer(buf) {
  const georef = await readGeorefFromBuffer(buf);
  return georef?.bounds || null;
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
function clampByte(value, maxVal) {
  let n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (maxVal > 255) n = (n / maxVal) * 255;
  if (n < 0) return 0;
  if (n > 255) return 255;
  return Math.round(n);
}

async function renderGeotiffToPng(buf, maxDim, bounds) {
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const tiff = await geotiff.fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  if (!width || !height) {
    throw new Error("GeoTIFF image has no dimensions");
  }

  let outBounds = bounds;
  let outCoordinates = bounds ? boundsToImageCoordinates(bounds) : null;
  if (!outBounds) {
    const georef = await readGeorefFromImage(image);
    outBounds = georef?.bounds || normalizeBounds(image.getBoundingBox());
    outCoordinates =
      georef?.coordinates || (outBounds ? boundsToImageCoordinates(outBounds) : null);
  }
  const scale = Math.min(1, maxDim / Math.max(width, height));
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  const samples = image.getSamplesPerPixel();
  const bits = image.getBitsPerSample();
  const maxVal = Math.max(...(Array.isArray(bits) ? bits : [bits]).map((b) => (1 << b) - 1), 255);

  const data = await image.readRasters({
    width: outW,
    height: outH,
    interleave: true,
    resampleMethod: "bilinear",
  });

  const pixels = outW * outH;
  const rgba = Buffer.alloc(pixels * 4);
  if (samples >= 3) {
    for (let i = 0; i < pixels; i++) {
      const base = i * samples;
      rgba[i * 4] = clampByte(data[base], maxVal);
      rgba[i * 4 + 1] = clampByte(data[base + 1], maxVal);
      rgba[i * 4 + 2] = clampByte(data[base + 2], maxVal);
      rgba[i * 4 + 3] = samples >= 4 ? clampByte(data[base + 3], maxVal) : 255;
    }
  } else {
    for (let i = 0; i < pixels; i++) {
      const v = clampByte(data[i], maxVal);
      rgba[i * 4] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
    }
  }

  const out = await sharp(rgba, {
    raw: { width: outW, height: outH, channels: 4 },
  })
    .png()
    .toBuffer();

  return {
    buffer: out,
    contentType: "image/png",
    width: outW,
    height: outH,
    bounds: outBounds,
    coordinates: outCoordinates,
  };
}

async function renderRasterPng(hash, options = {}) {
  const buf = await loadRasterBuffer(hash);
  const maxDim = options.maxDim != null ? options.maxDim : 4096;
  let bounds = normalizeBounds(options.bounds);
  let coordinates = bounds ? boundsToImageCoordinates(bounds) : null;

  if (bufferLooksLikeTiff(buf)) {
    const georef = await readGeorefFromBuffer(buf);
    if (georef?.bounds) {
      if (!bounds || !looksLikeGeographicBounds(bounds)) {
        bounds = georef.bounds;
        coordinates = georef.coordinates;
      }
    }
    return renderGeotiffToPng(buf, maxDim, bounds);
  }

  if (!bounds) {
    bounds = normalizeBounds(await readBoundsFromBuffer(buf));
    coordinates = bounds ? boundsToImageCoordinates(bounds) : null;
  }

  try {
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
  } catch (err) {
    if (bufferLooksLikeTiff(buf)) {
      return renderGeotiffToPng(buf, maxDim, bounds);
    }
    throw err;
  }
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

async function resolveRasterPlacement(entry, buf, fallbacks = {}) {
  const entryCoordinates = parseContentEntryCoordinates(entry);
  const entryBounds = normalizeBounds(parseContentEntryBounds(entry));
  if (entryCoordinates) {
    const bounds = entryBounds || boundsFromLonLatCorners(entryCoordinates);
    if (bounds) {
      return {
        bounds: normalizeBounds(bounds),
        coordinates: entryCoordinates,
        source: "entry-corners",
      };
    }
  }
  if (entryBounds) {
    return {
      bounds: entryBounds,
      coordinates: boundsToImageCoordinates(entryBounds),
      source: "entry-bounds",
    };
  }

  if (buf && bufferLooksLikeTiff(buf)) {
    const georef = await readGeorefFromBuffer(buf);
    if (georef?.bounds) {
      return {
        bounds: georef.bounds,
        coordinates: georef.coordinates || boundsToImageCoordinates(georef.bounds),
        source: "geotiff",
      };
    }
    return null;
  }

  const fallbackBounds =
    normalizeBounds(fallbacks.missionBbox) || normalizeBounds(fallbacks.featureBounds);
  if (!fallbackBounds) return null;
  return {
    bounds: fallbackBounds,
    coordinates: boundsToImageCoordinates(fallbackBounds),
    source: "mission-fallback",
  };
}

async function buildRasterOverlays(missionName, missionPayload, options = {}) {
  const mission = missionPayload || {};
  const missionBbox = parseMissionBbox(mission);
  const featureBounds = boundsFromFeatures(options.features || []);
  const entries = await findRasterContents(mission);

  const overlays = await Promise.all(
    entries.map(async function (entry) {
      const hash = contentHash(entry);
      const name = contentName(entry) || hash;
      let buf = null;
      try {
        buf = await loadRasterBuffer(hash);
      } catch (err) {
        console.warn("[mission-raster] load failed", hash, err?.message || err);
      }

      const placement = await resolveRasterPlacement(entry, buf, {
        missionBbox,
        featureBounds,
      });
      if (!placement?.bounds) {
        console.warn("[mission-raster] no georeferencing for", name || hash);
        return null;
      }

      const bounds = placement.bounds;
      return {
        hash,
        name,
        bounds,
        coordinates: placement.coordinates || boundsToImageCoordinates(bounds),
        georefSource: placement.source,
        url:
          "/api/map/missions/" +
          encodeURIComponent(missionName) +
          "/raster/" +
          encodeURIComponent(hash) +
          "?bounds=" +
          encodeURIComponent(bounds.join(",")),
      };
    })
  );

  return overlays.filter(Boolean);
}

module.exports = {
  isRasterContent,
  contentHash,
  findRasterContents,
  renderRasterPng,
  readBoundsFromBuffer,
  readGeorefFromBuffer,
  parseMissionBbox,
  normalizeBounds,
  boundsToImageCoordinates,
  boundsFromFeatures,
  bufferLooksLikeRaster,
  buildRasterOverlays,
  resolveRasterPlacement,
  looksLikeGeographicBounds,
};
