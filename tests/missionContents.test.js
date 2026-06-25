const assert = require("assert");
const {
  contentHash,
  parseMissionBbox,
  missionContentsList,
  listMissionAttachmentEntries,
  normalizeContentEntry,
} = require("../services/missionContents.util");
const {
  boundsToImageCoordinates,
  bufferLooksLikeRaster,
} = require("../services/missionRaster.service");

assert.strictEqual(
  contentHash({ Hash: "abc", name: "x.tif" }),
  "abc"
);
assert.strictEqual(
  contentHash({ uid: "def-uid", filename: "map.kml" }),
  "def-uid"
);
assert.strictEqual(
  contentHash({ data: { hash: "nested-hash", name: "overlay.tif" } }),
  "nested-hash"
);

const bbox = parseMissionBbox({ bbox: "-85.3,35.0,-85.1,35.2" });
assert.ok(bbox);
assert.strictEqual(bbox[0], -85.3);
assert.strictEqual(bbox[1], 35.0);
assert.strictEqual(bbox[2], -85.1);
assert.strictEqual(bbox[3], 35.2);

const bboxLatLon = parseMissionBbox({ bbox: "35.0,-85.3,35.2,-85.1" });
assert.ok(bboxLatLon);
assert.strictEqual(bboxLatLon[0], -85.3);
assert.strictEqual(bboxLatLon[1], 35.0);
assert.strictEqual(bboxLatLon[2], -85.1);
assert.strictEqual(bboxLatLon[3], 35.2);

const contents = missionContentsList({
  contents: [{ hash: "h1", name: "a.tif" }],
});
assert.strictEqual(contents.length, 1);

const nested = listMissionAttachmentEntries({
  contents: [{ data: { hash: "nested", name: "map.tif" } }],
  baseLayer: "base-hash",
});
assert.strictEqual(nested.length, 2);
assert.ok(nested.some((e) => contentHash(e) === "nested"));
assert.ok(nested.some((e) => contentHash(e) === "base-hash"));

const tiffMagic = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00]);
assert.strictEqual(bufferLooksLikeRaster(tiffMagic), true);
const kmlMagic = Buffer.from("<?xml version=\"1.0\"?><kml xmlns=\"http://www.opengis.net/kml/2.2\">");
assert.strictEqual(bufferLooksLikeRaster(kmlMagic), false);

const coords = boundsToImageCoordinates([-85.3, 35.0, -85.1, 35.2]);
assert.strictEqual(coords[0][0], -85.3);
assert.strictEqual(coords[0][1], 35.2);

console.log("missionContents.test.js: all assertions passed");
