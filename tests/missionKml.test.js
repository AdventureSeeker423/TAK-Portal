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

const pointKml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark id="b23a3d0b-b942-47d7-8ad1-7d2d2a1d3f60">
      <name>R.25.133312</name>
      <description>Type: a-h-G&lt;br&gt; Time: 20 hours ago&lt;br&gt; 35.74928, -87.00052, 209</description>
      <styleUrl>#a-h-G</styleUrl>
      <Point><coordinates>-87.0005192,35.7492835,209.47</coordinates></Point>
    </Placemark>
  </Document>
</kml>`;

const points = missionKml.kmlToFeatures(pointKml, "Mill Thrill TEST", {
  hash: "mill",
  name: "Mill Thrill TEST.kml",
});
assert.strictEqual(points.length, 1);
assert.strictEqual(points[0].id, "b23a3d0b-b942-47d7-8ad1-7d2d2a1d3f60");
assert.strictEqual(points[0].properties.cotType, "a-h-G");
assert.strictEqual(points[0].properties.type, "a-h-G");
assert.ok(!points[0].properties.remarks.includes("<br"));
assert.ok(points[0].properties.remarks.includes("Type: a-h-G"));
assert.ok(points[0].properties.cotRawXml.includes('uid="b23a3d0b-b942-47d7-8ad1-7d2d2a1d3f60"'));
assert.ok(points[0].properties.cotRawXml.includes('type="a-h-G"'));
assert.ok(points[0].properties.cotRawXml.includes('callsign="R.25.133312"'));

const missionGeo = require("../services/missionGeo.service");
missionGeo
  .normalizeFeatureCollection({ type: "FeatureCollection", features: points }, "Mill Thrill TEST")
  .then((normalized) => {
    const point = normalized.features[0];
    assert.ok(point.properties.iconId, "a-h-G KML point should resolve a map icon");
    assert.strictEqual(point.properties.iconSource, "type2525b");
    assert.ok(point.properties.cotRawXml.includes('type="a-h-G"'));
    console.log("missionKml.test.js: all assertions passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
