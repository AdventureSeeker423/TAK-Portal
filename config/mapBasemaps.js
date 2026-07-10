/**
 * Server-side basemap catalog (ids + labels). Style URLs live in public/mapBasemaps.js.
 */
const BASEMAP_OPTIONS = [
  { id: "dark-matter", label: "CARTO Dark Matter" },
  { id: "positron", label: "CARTO Positron" },
  { id: "voyager", label: "CARTO Voyager" },
  { id: "satellite", label: "Esri Satellite" },
  { id: "topo", label: "OpenTopoMap Topographic" },
  { id: "google-maps", label: "Google Maps" },
  { id: "google-satellite", label: "Google Satellite" },
  { id: "google-hybrid", label: "Google Hybrid" },
  { id: "google-terrain", label: "Google Terrain" },
  { id: "google-traffic", label: "Google Traffic" },
];

const DEFAULT_BASEMAP_ID = "dark-matter";

const BASEMAP_IDS = new Set(BASEMAP_OPTIONS.map((o) => o.id));

function isValidBasemapId(id) {
  return BASEMAP_IDS.has(String(id || "").trim());
}

function normalizeBasemapId(id) {
  let saved = String(id || "").trim() || DEFAULT_BASEMAP_ID;
  if (saved === "dark" || saved === "light") {
    saved = saved === "light" ? "voyager" : DEFAULT_BASEMAP_ID;
  } else if (/-nolabels$/.test(saved)) {
    saved = saved.replace(/-nolabels$/, "");
  }
  if (!isValidBasemapId(saved)) saved = DEFAULT_BASEMAP_ID;
  return saved;
}

function getDefaultMapSource(settings) {
  const raw =
    settings && settings.DEFAULT_MAP_SOURCE != null
      ? settings.DEFAULT_MAP_SOURCE
      : DEFAULT_BASEMAP_ID;
  return normalizeBasemapId(raw);
}

module.exports = {
  BASEMAP_OPTIONS,
  DEFAULT_BASEMAP_ID,
  isValidBasemapId,
  normalizeBasemapId,
  getDefaultMapSource,
};
