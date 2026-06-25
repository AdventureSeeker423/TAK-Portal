const assert = require("assert");
const fs = require("fs");
const path = require("path");
const missionKml = require("../services/missionKml.service");

const kmlXml = fs.readFileSync(
  path.join(__dirname, "fixtures", "mission-sample.kml"),
  "utf8"
);

const features = missionKml.kmlToFeatures(kmlXml, "KmlMission", {
  hash: "abc123",
  name: "sample.kml",
});

assert.ok(features.length >= 1, "KML should produce features");
assert.strictEqual(features[0].properties.contentSource, "kml");
assert.strictEqual(features[0].properties.kind, "mission-feature");
assert.ok(
  features[0].geometry.type === "Polygon" || features[0].geometry.type === "LineString"
);

console.log("missionKml.test.js: all assertions passed");
