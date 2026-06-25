const assert = require("assert");
const {
  looksLikeGeographicBounds,
  resolveRasterPlacement,
  boundsToImageCoordinates,
} = require("../services/missionRaster.service");

assert.strictEqual(looksLikeGeographicBounds([-85.3, 35.0, -85.1, 35.2]), true);
assert.strictEqual(looksLikeGeographicBounds([680000, 3880000, 690000, 3890000]), false);

(async function runTests() {
  const placement = await resolveRasterPlacement(
    {
      north: 35.2,
      south: 35.0,
      east: -85.1,
      west: -85.3,
    },
    null,
    { missionBbox: [-86, 34, -84, 36], featureBounds: [-87, 33, -83, 37] }
  );
  assert.strictEqual(placement.source, "entry-bounds");
  assert.deepStrictEqual(placement.bounds, [-85.3, 35.0, -85.1, 35.2]);

  const cornerPlacement = await resolveRasterPlacement(
    {
      upperLeft: { lat: 35.2, lon: -85.3 },
      upperRight: { lat: 35.2, lon: -85.1 },
      lowerRight: { lat: 35.0, lon: -85.1 },
      lowerLeft: { lat: 35.0, lon: -85.3 },
    },
    null,
    { missionBbox: [-86, 34, -84, 36] }
  );
  assert.strictEqual(cornerPlacement.source, "entry-corners");
  assert.strictEqual(cornerPlacement.coordinates.length, 4);

  const tiffMagic = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00]);
  const geotiffPlacement = await resolveRasterPlacement(
    { name: "overlay.tif" },
    tiffMagic,
    { missionBbox: [-86, 34, -84, 36], featureBounds: [-87, 33, -83, 37] }
  );
  assert.strictEqual(geotiffPlacement, null, "invalid geotiff should not use mission bbox");

  const pngPlacement = await resolveRasterPlacement(
    { name: "overlay.png" },
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    { missionBbox: [-85.3, 35.0, -85.1, 35.2] }
  );
  assert.strictEqual(pngPlacement.source, "mission-fallback");
  assert.deepStrictEqual(
    pngPlacement.coordinates,
    boundsToImageCoordinates([-85.3, 35.0, -85.1, 35.2])
  );

  console.log("missionRaster.test.js: all assertions passed");
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
