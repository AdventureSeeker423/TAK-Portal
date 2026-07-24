/**
 * Camera / SPI CoT conversion — keep sensor points, drop video sidecars.
 */
const assert = require("assert");

const CAMERA_XML = `
<event version="2.0" uid="cam-1" type="b-m-p-s-p-loc" how="m-p"
  time="2026-01-01T00:00:00.000Z" start="2026-01-01T00:00:00.000Z" stale="2026-01-02T00:00:00.000Z">
  <point lat="35.01" lon="-85.19" hae="9999999.0" ce="9999999" le="9999999"/>
  <detail>
    <__video uid="vid-1" url="https://example.test/cam/playlist.m3u8">
      <ConnectionEntry protocol="raw" address="https://example.test/cam/playlist.m3u8"
        alias="I-75 Test Cam" uid="vid-1" />
    </__video>
    <sensor fov="45" hideFov="true" range="0" azimuth="0"/>
    <contact callsign="I-75 Test Cam"/>
  </detail>
</event>
<event version="2.0" uid="vid-1" type="b-i-v" how="m-g"
  time="2026-01-01T00:00:00.000Z" start="2026-01-01T00:00:00.000Z" stale="2026-01-02T00:00:00.000Z">
  <point lat="0" lon="0" hae="9999999.0" ce="9999999" le="9999999"/>
  <detail>
    <contact callsign="I-75 Test Cam"/>
    <__video>
      <ConnectionEntry protocol="raw" address="https://example.test/cam/playlist.m3u8" alias="I-75 Test Cam"/>
    </__video>
  </detail>
</event>
<event version="2.0" uid="spi-1" type="b-m-p-s-p-i" how="h-e"
  time="2026-01-01T00:00:00.000Z" start="2026-01-01T00:00:00.000Z" stale="2026-01-02T00:00:00.000Z">
  <point lat="35.05" lon="-85.25" hae="0" ce="9999999" le="9999999"/>
  <detail>
    <contact callsign="SPI-1"/>
  </detail>
</event>
`;

async function run() {
  const mod = await import("../services/missionCotConvert.mjs");
  const missionGeo = require("../services/missionGeo.service");

  const chunks = mod.splitMissionCotXml(CAMERA_XML);
  assert.strictEqual(chunks.length, 3, "expected 3 events");

  const fc = await mod.missionCotXmlToFeatureCollection(CAMERA_XML, "CamPkg");
  const uids = fc.features.map((f) => String(f.id || f.properties?.uid || ""));
  assert.ok(uids.includes("cam-1"), "camera sensor point must be kept");
  assert.ok(uids.includes("spi-1"), "SPI point must be kept");
  assert.ok(!uids.includes("vid-1"), "video-only b-i-v sidecar must be skipped");

  const cam = fc.features.find((f) => String(f.id) === "cam-1");
  assert.ok(cam, "camera feature present");
  assert.strictEqual(cam.geometry.type, "Point");
  assert.ok(
    Math.abs(cam.geometry.coordinates[0] + 85.19) < 0.001,
    "camera longitude"
  );
  assert.ok(
    String(cam.properties?.videoUrl || "").includes("playlist.m3u8"),
    "camera should carry stream URL"
  );

  const normalized = await missionGeo.normalizeFeatureCollection(fc, "CamPkg");
  const normCam = normalized.features.find((f) => String(f.id) === "cam-1");
  assert.ok(normCam, "normalized camera present");
  assert.strictEqual(normCam.properties.geometryType, "point");
  assert.ok(
    String(normCam.properties.videoUrl || "").includes("playlist.m3u8"),
    "videoUrl must survive normalize"
  );

  console.log("missionCotCamera.test.js: all assertions passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
