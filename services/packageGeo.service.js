/**
 * Data package ZIP → GeoJSON for map overlays (read-only).
 * List visibility matches Data Package Manager (missionpackage / ARCHIVED_MISSION + data_package kind).
 */
const unzipper = require("unzipper");
const { getInt } = require("./env");
const dataPackagesSvc = require("./dataPackages.service");
const packageKind = require("./packageKind.service");
const missionKml = require("./missionKml.service");
const missionGeo = require("./missionGeo.service");
const mapRender = require("./mapRender.service");
const CACHE_TTL_MS = getInt("PACKAGE_GEO_CACHE_TTL_MS", 120000);
const MAX_PACKAGE_BYTES = getInt("PACKAGE_GEO_MAX_BYTES", 64 * 1024 * 1024);
const geoCache = new Map();
/** @type {Map<string, Promise<object>>} */
const geoInFlight = new Map();

const KML_EXT = /\.(kml|kmz)$/i;
const COT_EXT = /\.(cot|xml)$/i;
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

function stampPackageFeature(feature, meta) {
  const props = feature.properties || {};
  const uid = String(feature.id || props.uid || props.id || "").trim();
  return {
    ...feature,
    id: uid || feature.id,
    properties: {
      ...props,
      kind: "package-feature",
      packageHash: meta.hash,
      packageName: meta.filename,
      missionName: meta.filename,
      origin: "package",
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
        const marker = {
          type: p.cotType || "",
          affiliation: p.affiliation || "",
          origin: "package",
          iconId: p.apiIconId,
          iconSource: p.iconSource || "",
          teamColor: p.teamColor || null,
        };
        iconManifest.push({
          mapImageId: p.iconId,
          apiIconId: p.apiIconId,
          color: mapRender.markerDisplayColor(marker),
          teamColor: marker.teamColor != null ? marker.teamColor : null,
          iconSource: p.iconSource,
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

  // KML features from missionKml are already mission-feature shaped; stamp overrides kind.
  const features = [...cotFeatures, ...kmlFeatures];
  return {
    features,
    attachmentSummary: { kml: kmlCount, cotFiles: cotFileCount },
  };
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
      rasterOverlays: [],
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
}

module.exports = {
  CACHE_TTL_MS,
  MAX_PACKAGE_BYTES,
  isMapVisibleDataPackage,
  isArchivedDataPackage,
  hasKeyword,
  listMapPackages,
  getPackageGeoJson,
  clearCache,
};
