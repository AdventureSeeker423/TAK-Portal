const fs = require("fs");
const path = require("path");

const MAP_JS = path.join(__dirname, "..", "public", "map.js");
const MAP_MISSIONS_JS = path.join(__dirname, "..", "public", "map-missions.js");
const MAP_SHAPE_DECOR_JS = path.join(__dirname, "..", "public", "shapeDecorFilter.js");
const MAP_CSS = path.join(__dirname, "..", "public", "map.css");

function fileMtimeToken(filePath) {
  try {
    return String(Math.trunc(fs.statSync(filePath).mtimeMs));
  } catch (_) {
    return "0";
  }
}

/** Fresh URLs for map page assets; busts cache when map.js/map.css change on disk. */
function getRenderLocals() {
  return {
    mapJsUrl: `/map.js?v=${fileMtimeToken(MAP_JS)}`,
    mapMissionsJsUrl: `/map-missions.js?v=${fileMtimeToken(MAP_MISSIONS_JS)}`,
    shapeDecorFilterJsUrl: `/shapeDecorFilter.js?v=${fileMtimeToken(MAP_SHAPE_DECOR_JS)}`,
    mapBasemapsJsUrl: `/mapBasemaps.js?v=${fileMtimeToken(path.join(__dirname, "..", "public", "mapBasemaps.js"))}`,
    dashboardMiniMapJsUrl: `/dashboardMiniMap.js?v=${fileMtimeToken(path.join(__dirname, "..", "public", "dashboardMiniMap.js"))}`,
    mapCssUrl: `/map.css?v=${fileMtimeToken(MAP_CSS)}`,
  };
}

module.exports = {
  getRenderLocals,
};
