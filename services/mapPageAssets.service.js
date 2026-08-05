const fs = require("fs");
const path = require("path");

const MAP_DIST_JS = path.join(__dirname, "..", "public", "dist", "map.js");
const MAP_DIST_WORKER = path.join(__dirname, "..", "public", "dist", "map.worker.js");
const MAP_CSS = path.join(__dirname, "..", "public", "map.css");
const MAP_BASEMAPS_JS = path.join(__dirname, "..", "public", "mapBasemaps.js");
const SHAPE_DECOR_JS = path.join(__dirname, "..", "public", "shapeDecorFilter.js");
const MAPLIBRE_JS = path.join(__dirname, "..", "public", "vendor", "maplibre-gl", "maplibre-gl.js");
const MAPLIBRE_CSS = path.join(__dirname, "..", "public", "vendor", "maplibre-gl", "maplibre-gl.css");
const DASHBOARD_MINI = path.join(__dirname, "..", "public", "dashboardMiniMap.js");

function fileMtimeToken(filePath) {
  try {
    return String(Math.trunc(fs.statSync(filePath).mtimeMs));
  } catch (_) {
    return "0";
  }
}

/** Fresh URLs for map page assets; busts cache when dist/css change on disk. */
function getRenderLocals() {
  const mapToken = fileMtimeToken(MAP_DIST_JS);
  return {
    mapJsUrl: `/dist/map.js?v=${mapToken}`,
    mapWorkerJsUrl: `/dist/map.worker.js?v=${fileMtimeToken(MAP_DIST_WORKER)}`,
    mapBasemapsJsUrl: `/mapBasemaps.js?v=${fileMtimeToken(MAP_BASEMAPS_JS)}`,
    shapeDecorFilterJsUrl: `/shapeDecorFilter.js?v=${fileMtimeToken(SHAPE_DECOR_JS)}`,
    mapCssUrl: `/map.css?v=${fileMtimeToken(MAP_CSS)}`,
    // Prefer vendored UMD (MapLibre 5.13). Fallback CDN matches that pin.
    maplibreJsUrl: fs.existsSync(MAPLIBRE_JS)
      ? `/vendor/maplibre-gl/maplibre-gl.js?v=${fileMtimeToken(MAPLIBRE_JS)}`
      : "https://unpkg.com/maplibre-gl@5.13.0/dist/maplibre-gl.js",
    maplibreCssUrl: fs.existsSync(MAPLIBRE_CSS)
      ? `/vendor/maplibre-gl/maplibre-gl.css?v=${fileMtimeToken(MAPLIBRE_CSS)}`
      : "https://unpkg.com/maplibre-gl@5.13.0/dist/maplibre-gl.css",
    dashboardMiniMapJsUrl: `/dashboardMiniMap.js?v=${fileMtimeToken(DASHBOARD_MINI)}`,
    // Overlays are bundled into dist/map.js
    mapMissionsJsUrl: "",
    mapPackagesJsUrl: "",
    mapGeofencesJsUrl: "",
  };
}

module.exports = {
  getRenderLocals,
};
