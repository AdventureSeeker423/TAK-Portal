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
              [-85.33353, 35.09087],
              [-85.332, 35.092],
              [-85.3305, 35.09087],
              [-85.332, 35.0895],
              [-85.33353, 35.09087],
            ],
          ],
        },
        properties: { type: "u-d-c-c", how: "h-e", callsign: "Range Ring" },
      },
      {
        id: "vertex-handle",
        type: "Feature",
        geometry: { type: "Point", coordinates: [-85.332, 35.092] },
        properties: { type: "a-n-G", how: "h-e", callsign: "" },
      },
      {
        id: "team-building",
        type: "Feature",
        geometry: { type: "Point", coordinates: [-85.3335302, 35.0908716] },
        properties: {
          type: "a-n-G",
          how: "h-g-i-g-o",
          callsign: "Team Building 1",
          icon: "83198b4872a8c34eb9c549da8a4de5a28f07821185b39a2277948f66c24ac17a/WildFire/Camp.png",
        },
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
  assert.ok(circleIds.includes("team-building"), "point with explicit usericon should remain");
  assert.ok(circleIds.includes("vehicle-1"), "tactical marker should remain");
  assert.ok(!circleIds.includes("vertex-handle"), "bare a-n-G vertex handle should be filtered");

  const ringFc = {
    type: "FeatureCollection",
    features: [
      {
        id: "range-ring",
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [-85.33353, 35.09087],
              [-85.332, 35.092],
              [-85.3305, 35.09087],
              [-85.332, 35.0895],
              [-85.33353, 35.09087],
            ],
          ],
        },
        properties: { type: "u-d-c-c", how: "h-e", callsign: "Range Ring" },
      },
      {
        id: "ring-control",
        type: "Feature",
        geometry: { type: "Point", coordinates: [-85.3315, 35.0912] },
        properties: { type: "u-d-p-c-c", how: "m-g", callsign: "" },
      },
      {
        id: "air-monitor",
        type: "Feature",
        geometry: { type: "Point", coordinates: [-85.3331501, 35.0915009] },
        properties: {
          type: "a-h-G",
          how: "h-g-i-g-o",
          callsign: "Air Monitor",
          icon: "ad78aafb-83a6-4c07-b2b9-a897a8b6a38f/Shapes/square.png",
        },
      },
    ],
  };
  const ringNormalized = await missionGeo.normalizeFeatureCollection(ringFc, "RingMission");
  const ringIds = ringNormalized.features.map((f) => String(f.id));
  assert.ok(ringIds.includes("range-ring"), "polygon ring should remain");
  assert.ok(ringIds.includes("air-monitor"), "usericon marker should remain");
  assert.ok(!ringIds.includes("ring-control"), "shape control point should be filtered");
  const airMonitor = ringNormalized.features.find((f) => String(f.id) === "air-monitor");
  assert.strictEqual(airMonitor.properties.showCircle, 0);
  assert.ok(airMonitor.properties.iconId, "air monitor should have map icon");

  const BAYLOR_TFR_XML = `<event version='2.0' uid='1e77fed5-d04a-45b2-b297-0ad9c54f4eed' type='u-d-c-c' time='2026-06-06T18:25:16Z' start='2026-06-06T18:25:16Z' stale='2026-06-07T18:25:08Z' how='h-e'><point lat='35.0909273' lon='-85.3333797' hae='174.465' ce='9999999.0' le='9999999.0' /><detail><contact callsign="Baylor TFR"/><shape><ellipse major="1850.7456" minor="1850.7456" angle="360"/><link uid="1e77fed5-d04a-45b2-b297-0ad9c54f4eed.Style" type="b-x-KmlStyle" relation="p-c"><Style><LineStyle><color>ffff0000</color><width>3.3</width></LineStyle><PolyStyle><color>00ff0000</color></PolyStyle></Style></link></shape></detail></event>`;
  const baylorFc = await mod.missionCotXmlToFeatureCollection(BAYLOR_TFR_XML, "Baylor");
  assert.strictEqual(baylorFc.features.length, 1, "Baylor TFR should convert to one polygon");
  const ring = baylorFc.features[0].geometry.coordinates[0];
  const ringDecor = ring.slice(0, -1).map((coord, i) => ({
    id: "ring-handle-" + i,
    type: "Feature",
    geometry: { type: "Point", coordinates: [coord[0] + 0.00008, coord[1] + 0.00008] },
    properties: { type: "a-n-G", how: "h-e", callsign: "" },
  }));
  const baylorNormalized = await missionGeo.normalizeFeatureCollection(
    { type: "FeatureCollection", features: [baylorFc.features[0], ...ringDecor] },
    "Baylor"
  );
  const baylorPoints = baylorNormalized.features.filter(
    (f) => f.properties.geometryType === "point"
  );
  assert.strictEqual(baylorPoints.length, 0, "ring editor handles should be filtered");
  assert.ok(
    baylorNormalized.features.some((f) => String(f.id) === "1e77fed5-d04a-45b2-b297-0ad9c54f4eed"),
    "circle polygon should remain"
  );

  const linkedHandle = {
    id: "1e77fed5-d04a-45b2-b297-0ad9c54f4eed.17",
    type: "Feature",
    geometry: { type: "Point", coordinates: [-85.3325, 35.0925] },
    properties: { type: "a-n-G", how: "h-e", callsign: "handle" },
  };
  const linkedNormalized = await missionGeo.normalizeFeatureCollection(
    { type: "FeatureCollection", features: [baylorFc.features[0], linkedHandle] },
    "Baylor"
  );
  assert.ok(
    !linkedNormalized.features.some((f) => String(f.id) === linkedHandle.id),
    "uid linked to shape owner should be filtered"
  );

  console.log("missionGeo.test.js: all assertions passed");
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
