/**
 * Mission GeoJSON conversion tests.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const missionGeo = require("../services/missionGeo.service");

const SAMPLE_XML = fs.readFileSync(
  path.join(__dirname, "fixtures", "mission-cot-sample.xml"),
  "utf8"
);

async function runTests() {
  const mod = await import("../services/missionCotConvert.mjs");
  const chunks = mod.splitMissionCotXml(SAMPLE_XML);
  assert.strictEqual(chunks.length, 4, "should split 4 event blocks");

  const fc = await mod.missionCotXmlToFeatureCollection(SAMPLE_XML, "TestMission");
  assert.ok(fc.features.length >= 3, "chat should be filtered out");
  assert.strictEqual(fc.meta.missionName, "TestMission");

  const types = new Set(
    fc.features.map((f) => f.geometry && f.geometry.type).filter(Boolean)
  );
  assert.ok(types.has("Point"), "expected point geometry");
  assert.ok(types.has("LineString") || types.has("Polygon"), "expected line or polygon");

  const normalized = await missionGeo.normalizeFeatureCollection(fc, "TestMission");
  for (const f of normalized.features) {
    assert.strictEqual(f.properties.kind, "mission-feature");
    assert.strictEqual(f.properties.missionName, "TestMission");
    assert.ok(f.properties.geometryType);
  }

  const layerTree = missionGeo.normalizeLayerTree(
    [
      {
        type: "GROUP",
        name: "Ops",
        children: [
          {
            type: "UID",
            uids: ["point-1", "route-1"],
          },
        ],
      },
    ],
    normalized.features.map((f) => String(f.id))
  );
  assert.strictEqual(layerTree.folders.length, 1);
  assert.ok(layerTree.folders[0].uids.includes("point-1"));
  assert.ok(layerTree.orphaned.includes("poly-1"));

  const missionOrigin = {
    type: "a-f-G-E-V",
    origin: "mission",
    iconId: "2525D:10031000001211000000",
    iconSource: "milsym",
  };
  const mapRender = require("../services/mapRender.service");
  assert.strictEqual(mapRender.markerUsesMapIcon(missionOrigin), true);

  const circleFc = {
    type: "FeatureCollection",
    features: [
      {
        id: "circle-poly",
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [-85.3, 35.1],
              [-85.29, 35.11],
              [-85.28, 35.1],
              [-85.29, 35.09],
              [-85.3, 35.1],
            ],
          ],
        },
        properties: { type: "u-d-c-c", how: "h-e", callsign: "Range Ring" },
      },
      {
        id: "vertex-1",
        type: "Feature",
        geometry: { type: "Point", coordinates: [-85.29, 35.11] },
        properties: { type: "u-d-f-p", how: "h-e", callsign: "" },
      },
      {
        id: "vehicle-1",
        type: "Feature",
        geometry: { type: "Point", coordinates: [-85.25, 35.12] },
        properties: { type: "a-f-G-E-V", how: "h-g", callsign: "1A05" },
      },
    ],
  };
  const circleNormalized = await missionGeo.normalizeFeatureCollection(circleFc, "CircleMission");
  const circleIds = circleNormalized.features.map((f) => String(f.id));
  assert.ok(circleIds.includes("circle-poly"), "polygon should remain");
  assert.ok(circleIds.includes("vehicle-1"), "tactical marker should remain");
  assert.ok(!circleIds.includes("vertex-1"), "shape vertex point should be filtered");

  console.log("missionGeo.test.js: all assertions passed");
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
