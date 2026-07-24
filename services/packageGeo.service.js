/**
 * Data package ZIP → GeoJSON for map overlays (read-only).
 * List visibility matches Data Package Manager (missionpackage / ARCHIVED_MISSION + data_package kind).
 * Rasters (GeoTIFF/PNG/JPEG) reuse missionRaster placement + PNG render logic.
 */
const crypto = require("crypto");
const unzipper = require("unzipper");
const { getInt } = require("./env");
const dataPackagesSvc = require("./dataPackages.service");
const packageKind = require("./packageKind.service");
const missionKml = require("./missionKml.service");
const missionGeo = require("./missionGeo.service");
const missionRaster = require("./missionRaster.service");
const mapRender = require("./mapRender.service");

const CACHE_TTL_MS = getInt("PACKAGE_GEO_CACHE_TTL_MS", 120000);
const MAX_PACKAGE_BYTES = getInt("PACKAGE_GEO_MAX_BYTES", 64 * 1024 * 1024);
const geoCache = new Map();
/** @type {Map<string, { at: number, entries: Map<string, { name: string, buffer: Buffer }> }>} */
const rasterEntryCache = new Map();
/** @type {Map<string, Promise<object>>} */
const geoInFlight = new Map();

const KML_EXT = /\.(kml|kmz)$/i;
const COT_EXT = /\.(cot|xml)$/i;
const RASTER_EXT = /\.(tif|tiff|geotiff|grg|png|jpg|jpeg)$/i;
const SKIP_PATH = /(^|\/)(MANIFEST\/|certs\/|\.pref$)/i;

function cacheGet(key) {
  const hit = geoCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    geoCache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  geoCache.set(key, { at: Date.now(), value });
}

function rasterCacheGet(packageHash) {
  const hit = rasterEntryCache.get(packageHash);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    rasterEntryCache.delete(packageHash);
    return null;
  }
  return hit.entries;
}

function rasterCacheSet(packageHash, entriesMap) {
  rasterEntryCache.set(packageHash, { at: Date.now(), entries: entriesMap });
}

function packageKeywords(pkg) {
  if (Array.isArray(pkg && pkg.keywords)) {
    return pkg.keywords.map((k) => String(k || "").trim()).filter(Boolean);
  }
  return [];
}

function hasKeyword(pkg, keyword) {
  const target = String(keyword || "")
    .trim()
    .toLowerCase();
  if (!target) return false;
  return packageKeywords(pkg).some((k) => k.toLowerCase() === target);
}

/** Same visibility rules as views/data-package.ejs active/archived tables. */
function isMapVisibleDataPackage(pkg) {
  if (!pkg || !packageKind.isDataPackageRecord(pkg)) return false;
  return (
    hasKeyword(pkg, packageKind.PACKAGE_ACTIVE_KEYWORD) ||
    hasKeyword(pkg, packageKind.ARCHIVED_KEYWORD)
  );
}

function isArchivedDataPackage(pkg) {
  return hasKeyword(pkg, packageKind.ARCHIVED_KEYWORD);
}

function slimPackageForMap(pkg) {
  const hash = String(pkg.hash || "").trim();
  const filename = String(pkg.filename || pkg.name || hash || "").trim();
  return {
    hash,
    filename,
    size: pkg.size != null ? pkg.size : "",
    creator: pkg.creator || "",
    keywords: packageKeywords(pkg),
    archived: isArchivedDataPackage(pkg),
    portalKind: pkg.portalKind || packageKind.PORTAL_KIND.DATA_PACKAGE,
  };
}

async function listMapPackages() {
  const data = await dataPackagesSvc.listDataPackages({});
  const items = Array.isArray(data.items) ? data.items : [];
  return items.filter(isMapVisibleDataPackage).map(slimPackageForMap).filter((p) => p.hash);
}

function entryBasename(entryPath) {
  const parts = String(entryPath || "").split(/[/\\]/);
  return parts[parts.length - 1] || entryPath;
}

function shouldSkipZipEntry(entryPath) {
  const p = String(entryPath || "");
  if (!p || p.endsWith("/")) return true;
  if (SKIP_PATH.test(p)) return true;
  return false;
}

function bufferLooksLikeCot(buf) {
  const sample = buf.slice(0, Math.min(buf.length, 1200)).toString("utf8");
  return /<event[\s>]/i.test(sample);
}

function contentHashHex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function stampPackageFeature(feature, meta) {
  const props = feature.properties || {};
  const uid = String(feature.id || props.uid || props.id || "").trim();
  // Keep origin from normalize/augment (usually "mission") so icon mapImageIds
  // stay consistent with batch icon rendering. kind marks package ownership.
  return {
    ...feature,
    id: uid || feature.id,
    properties: {
      ...props,
      kind: "package-feature",
      packageHash: meta.hash,
      packageName: meta.filename,
      missionName: meta.filename,
      id: uid || props.id || feature.id,
      uid: uid || props.uid || "",
    },
  };
}

function buildIconManifest(features) {
  const iconManifest = [];
  const manifestKeys = new Set();
  for (const f of features) {
    const p = f.properties || {};
    if (p.geometryType === "point" && p.iconId && p.apiIconId) {
      if (!manifestKeys.has(p.iconId)) {
        manifestKeys.add(p.iconId);
        const cotType = p.cotType || p.type || "";
        const affiliation =
          p.affiliation ||
          (function () {
            const parts = String(cotType || "")
              .trim()
              .split("-");
            if (parts.length < 2) return "other";
            const aff = parts[1].toLowerCase();
            if (aff === "f") return "friend";
            if (aff === "h") return "hostile";
            if (aff === "n") return "neutral";
            if (aff === "u") return "unknown";
            return "other";
          })();
        const marker = {
          type: cotType,
          affiliation,
          origin: p.origin || "mission",
          iconId: p.apiIconId,
          iconSource: p.iconSource || "",
          teamColor: p.teamColor || null,
          color: p.color || null,
        };
        iconManifest.push({
          mapImageId: p.iconId,
          apiIconId: p.apiIconId,
          color: p.color || mapRender.markerDisplayColor(marker),
          teamColor: marker.teamColor != null ? marker.teamColor : null,
          iconSource: p.iconSource || "",
          origin: marker.origin,
          type: cotType,
          affiliation,
        });
      }
    }
  }
  return iconManifest;
}

async function extractFeaturesFromZipBuffer(buf, meta) {
  const directory = await unzipper.Open.buffer(buf);
  const cotChunks = [];
  const kmlFeatures = [];
  const rasterItems = [];
  const rasterEntries = new Map();
  let kmlCount = 0;
  let cotFileCount = 0;

  for (const entry of directory.files) {
    const entryPath = String(entry.path || "");
    if (shouldSkipZipEntry(entryPath)) continue;
    const base = entryBasename(entryPath);
    const lower = base.toLowerCase();

    try {
      if (KML_EXT.test(lower)) {
        const fileBuf = await entry.buffer();
        const xml = await missionKml.extractKmlXmlFromBuffer(fileBuf, base);
        if (!xml) continue;
        const feats = missionKml.kmlToFeatures(xml.toString("utf8"), meta.filename, {
          hash: `${meta.hash}:${base}`,
          name: base,
        });
        for (const f of feats) {
          kmlFeatures.push(stampPackageFeature(f, meta));
        }
        kmlCount += feats.length;
        continue;
      }

      if (COT_EXT.test(lower)) {
        const fileBuf = await entry.buffer();
        if (!bufferLooksLikeCot(fileBuf)) continue;
        cotChunks.push(fileBuf.toString("utf8"));
        cotFileCount += 1;
        continue;
      }

      if (RASTER_EXT.test(lower)) {
        const fileBuf = await entry.buffer();
        if (!fileBuf || !fileBuf.length) continue;
        // Skip KML/zip disguised with image extension.
        if (!missionRaster.bufferLooksLikeRaster(fileBuf) && !missionRaster.bufferLooksLikeTiff(fileBuf)) {
          continue;
        }
        const entryHash = contentHashHex(fileBuf);
        rasterItems.push({ hash: entryHash, name: base, buffer: fileBuf });
        rasterEntries.set(entryHash, { name: base, buffer: fileBuf });
        rasterEntries.set(entryHash.toLowerCase(), { name: base, buffer: fileBuf });
      }
    } catch (err) {
      console.warn("[package-geo] entry failed", entryPath, err?.message || err);
    }
  }

  let cotFeatures = [];
  if (cotChunks.length) {
    const mod = await import("./missionCotConvert.mjs");
    const combined = cotChunks.join("\n");
    const rawFc = await mod.missionCotXmlToFeatureCollection(combined, meta.filename);
    const normalized = await missionGeo.normalizeFeatureCollection(rawFc, meta.filename);
    cotFeatures = (normalized.features || []).map((f) => stampPackageFeature(f, meta));
  }

  const features = [...cotFeatures, ...kmlFeatures];

  const rasterOverlays = await missionRaster.buildRasterOverlaysFromBuffers(rasterItems, {
    features,
    urlFor: function (item, bounds) {
      return (
        "/api/map/packages/" +
        encodeURIComponent(meta.hash) +
        "/raster/" +
        encodeURIComponent(item.hash) +
        "?bounds=" +
        encodeURIComponent(bounds.join(","))
      );
    },
  });

  rasterCacheSet(meta.hash, rasterEntries);

  return {
    features,
    rasterOverlays,
    attachmentSummary: {
      kml: kmlCount,
      cotFiles: cotFileCount,
      raster: rasterOverlays.length,
    },
  };
}

async function ensurePackageRasterEntries(packageHash) {
  const h = String(packageHash || "").trim();
  const cached = rasterCacheGet(h);
  if (cached) return cached;

  // Rebuild via geojson path (also fills raster cache).
  await getPackageGeoJson(h, { refresh: true });
  return rasterCacheGet(h) || new Map();
}

async function getPackageRasterPng(packageHash, entryHash, options = {}) {
  const h = String(packageHash || "").trim();
  const eHash = String(entryHash || "").trim();
  if (!h || !eHash) {
    const err = new Error("Package hash and raster hash are required.");
    err.code = "INVALID_HASH";
    err.status = 400;
    throw err;
  }

  const entries = await ensurePackageRasterEntries(h);
  const hit =
    entries.get(eHash) ||
    entries.get(eHash.toLowerCase()) ||
    null;
  if (!hit || !hit.buffer) {
    const err = new Error("Raster not found in data package.");
    err.code = "NOT_FOUND";
    err.status = 404;
    throw err;
  }

  return missionRaster.renderRasterPngFromBuffer(hit.buffer, {
    bounds: options.bounds || null,
    maxDim: options.maxDim,
  });
}

async function buildPackageGeoJson(hash, options = {}) {
  const h = String(hash || "").trim();
  if (!h) {
    const err = new Error("Package hash is required.");
    err.code = "INVALID_HASH";
    err.status = 400;
    throw err;
  }

  let filename = String(options.filename || "").trim();
  if (!filename) {
    try {
      const meta = await dataPackagesSvc.getDataPackageMetadata(h);
      filename =
        String(meta?.filename || meta?.name || meta?.Hash || "").trim() || h.slice(0, 12);
    } catch (_) {
      filename = h.slice(0, 12);
    }
  }

  const buf = await dataPackagesSvc.downloadDataPackageBuffer(h, {
    maxBytes: MAX_PACKAGE_BYTES,
  });
  if (!buf || buf.length < 4) {
    const err = new Error("Data package content is empty.");
    err.code = "PACKAGE_EMPTY";
    err.status = 404;
    throw err;
  }

  const meta = { hash: h, filename };
  const extracted = await extractFeaturesFromZipBuffer(buf, meta);
  const iconManifest = buildIconManifest(extracted.features);

  return {
    type: "FeatureCollection",
    features: extracted.features,
    meta: {
      packageHash: h,
      packageName: filename,
      featureCount: extracted.features.length,
      attachmentSummary: extracted.attachmentSummary,
      iconManifest,
      rasterOverlays: extracted.rasterOverlays || [],
    },
  };
}

async function getPackageGeoJson(hash, options = {}) {
  const h = String(hash || "").trim();
  const refresh = !!options.refresh;
  const cacheKey = h;

  if (!refresh) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
    const pending = geoInFlight.get(cacheKey);
    if (pending) return pending;
  }

  const promise = buildPackageGeoJson(h, options)
    .then((geojson) => {
      cacheSet(cacheKey, geojson);
      return geojson;
    })
    .finally(() => {
      geoInFlight.delete(cacheKey);
    });

  geoInFlight.set(cacheKey, promise);
  return promise;
}

function clearCache() {
  geoCache.clear();
  geoInFlight.clear();
  rasterEntryCache.clear();
}

module.exports = {
  CACHE_TTL_MS,
  MAX_PACKAGE_BYTES,
  isMapVisibleDataPackage,
  isArchivedDataPackage,
  hasKeyword,
  listMapPackages,
  getPackageGeoJson,
  getPackageRasterPng,
  clearCache,
};
