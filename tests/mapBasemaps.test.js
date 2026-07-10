const assert = require("assert");
const mapBasemaps = require("../config/mapBasemaps");

assert.strictEqual(mapBasemaps.isValidBasemapId("dark-matter"), true);
assert.strictEqual(mapBasemaps.isValidBasemapId("invalid-basemap"), false);
assert.strictEqual(mapBasemaps.normalizeBasemapId("dark"), "dark-matter");
assert.strictEqual(mapBasemaps.normalizeBasemapId("light"), "voyager");
assert.strictEqual(
  mapBasemaps.getDefaultMapSource({ DEFAULT_MAP_SOURCE: "positron" }),
  "positron"
);
assert.strictEqual(
  mapBasemaps.getDefaultMapSource({ DEFAULT_MAP_SOURCE: "not-real" }),
  "dark-matter"
);
assert.ok(mapBasemaps.BASEMAP_OPTIONS.length >= 10);

console.log("mapBasemaps.test.js OK");
