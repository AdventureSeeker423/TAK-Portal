const assert = require("assert");
const {
  contentHash,
  parseMissionBbox,
  missionContentsList,
} = require("../services/missionContents.util");
const { boundsToImageCoordinates } = require("../services/missionRaster.service");

assert.strictEqual(
  contentHash({ Hash: "abc", name: "x.tif" }),
  "abc"
);
assert.strictEqual(
  contentHash({ uid: "def-uid", filename: "map.kml" }),
  "def-uid"
);

const bbox = parseMissionBbox({ bbox: "-85.3,35.0,-85.1,35.2" });
assert.ok(bbox);
assert.strictEqual(bbox[0], -85.3);
assert.strictEqual(bbox[1], 35.0);
assert.strictEqual(bbox[2], -85.1);
assert.strictEqual(bbox[3], 35.2);

const contents = missionContentsList({
  contents: [{ hash: "h1", name: "a.tif" }],
});
assert.strictEqual(contents.length, 1);

const coords = boundsToImageCoordinates([-85.3, 35.0, -85.1, 35.2]);
assert.strictEqual(coords[0][0], -85.3);
assert.strictEqual(coords[0][1], 35.2);

console.log("missionContents.test.js: all assertions passed");
