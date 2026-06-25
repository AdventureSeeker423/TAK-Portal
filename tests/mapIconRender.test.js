const assert = require("assert");
const mapIcon = require("../services/mapIcon.service");
const mapRender = require("../services/mapRender.service");
const mapIconRender = require("../services/mapIconRender.service");

async function runTests() {
  await mapIcon.ensureIconsets();

  const rotor = mapIcon.resolveIcon({ type: "a-f-A-C-H", affiliation: "friend" });
  assert.ok(rotor && rotor.iconId, "rotor icon should resolve");

  const marker = {
    uid: "feed-batch-1",
    callsign: "W62",
    type: "a-f-A-C-H",
    lat: 35.05,
    lon: -85.21,
    groups: ["Hamilton Co AVL LAW"],
    affiliation: "friend",
    origin: "feed",
    iconId: rotor.iconId,
    iconSource: rotor.source,
    teamColor: "#ff0000",
  };

  assert.strictEqual(mapRender.markerUsesMapIcon(marker), true);

  const color = mapRender.markerDisplayColor(marker);
  const mapImageId = mapIconRender.computeMapImageId(marker, marker.iconId, color);
  assert.ok(mapImageId.startsWith("mimg-"));

  const rendered = await mapIconRender.renderIconForMarker(marker);
  assert.ok(rendered.buffer, "renderIconForMarker should return PNG bytes");
  assert.strictEqual(rendered.mapImageId, mapImageId);

  const batch = await mapIconRender.renderIconBatch([
    {
      mapImageId,
      apiIconId: marker.iconId,
      color,
      teamColor: marker.teamColor,
      iconSource: marker.iconSource,
      origin: marker.origin,
      type: marker.type,
      affiliation: marker.affiliation,
    },
    {
      mapImageId,
      apiIconId: marker.iconId,
      color,
      teamColor: marker.teamColor,
      iconSource: marker.iconSource,
      origin: marker.origin,
      type: marker.type,
      affiliation: marker.affiliation,
    },
  ]);

  assert.strictEqual(batch.requested, 1, "duplicate mapImageId entries should dedupe");
  assert.strictEqual(batch.rendered, 1);
  assert.ok(batch.icons[mapImageId], "batch should include base64 PNG");
  assert.strictEqual(batch.missing.length, 0);

  const missingBatch = await mapIconRender.renderIconBatch([
    {
      mapImageId: "mimg-deadbeef00000001",
      apiIconId: "definitely-not-a-real-icon-id:missing.png",
      color: "#ffffff",
      iconSource: "usericon",
      origin: "feed",
      type: marker.type,
      affiliation: marker.affiliation,
    },
  ]);
  assert.strictEqual(missingBatch.rendered, 0);
  assert.ok(missingBatch.missing.includes("mimg-deadbeef00000001"));

  const camp = mapIcon.resolveIcon({
    type: "a-u-G-E-S-R",
    affiliation: "unknown",
    usericon: {
      iconsetpath: "6d781afb-89a6-4c07-b2b9-a89748b6a38f/Misc/Camp.png",
    },
  });
  assert.ok(camp && camp.iconId, "Camp usericon should resolve");
  const campMarker = {
    uid: "camp-1",
    type: "a-u-G-E-S-R",
    lat: 35.14,
    lon: -85.31,
    affiliation: "unknown",
    origin: "feed",
    iconId: camp.iconId,
    iconSource: camp.source,
    teamColor: null,
  };
  const campDisplayColor = mapRender.markerDisplayColor(campMarker);
  assert.strictEqual(campDisplayColor, "#f97316", "unknown affiliation display color");
  assert.strictEqual(
    mapIconRender.iconSkipsRecolor(campMarker, camp.iconId),
    true,
    "path icons without explicit team color should skip recolor"
  );
  const campMapImageId = mapIconRender.computeMapImageId(
    campMarker,
    camp.iconId,
    campDisplayColor
  );
  const campBatch = await mapIconRender.renderIconBatch([
    {
      mapImageId: campMapImageId,
      apiIconId: camp.iconId,
      color: campDisplayColor,
      teamColor: null,
      iconSource: camp.source,
      origin: campMarker.origin,
      type: campMarker.type,
      affiliation: campMarker.affiliation,
    },
  ]);
  assert.strictEqual(campBatch.rendered, 1, "Camp batch should render raw icon");
  assert.strictEqual(campBatch.missing.length, 0);

  const stats = mapIconRender.getStats();
  assert.ok(stats.batchCount >= 2);
  assert.ok(stats.batchMax >= 120);

  assert.strictEqual(
    mapIconRender.normalizeMapImageId("wing-3bac1b2482d4d6d1"),
    "mimg-3bac1b2482d4d6d1"
  );
  assert.strictEqual(
    mapIconRender.normalizeMapImageId("mimg-3bac1b2482d4d6d1"),
    "mimg-3bac1b2482d4d6d1"
  );

  const mapMilSym = require("../services/mapMilSym.service");
  const milId = await mapMilSym.cotTypeTo2525DIconId("a-f-G-E-V");
  if (milId) {
    const milMarker = {
      uid: "milsym-1",
      type: "a-f-G-E-V",
      lat: 35.05,
      lon: -85.21,
      affiliation: "friend",
      origin: "feed",
      iconId: milId,
      iconSource: "milsym",
    };
    const milRendered = await mapIconRender.renderIconForMarker(milMarker);
    assert.ok(milRendered.buffer, "2525D milsym should render PNG bytes");
    assert.strictEqual(milRendered.mapImageId, mapIconRender.computeMapImageId(
      milMarker,
      milId,
      mapRender.markerDisplayColor(milMarker)
    ));
  }

  console.log("mapIconRender.test.js: all assertions passed");
}

runTests().catch(function (err) {
  console.error(err);
  process.exit(1);
});
