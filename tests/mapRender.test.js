const assert = require("assert");
const mapRender = require("../services/mapRender.service");
const mapIconRender = require("../services/mapIconRender.service");

const sampleMarkers = [
  {
    uid: "eud-1",
    callsign: "EUD-1",
    type: "a-f-G-U-C",
    lat: 35.04,
    lon: -85.2,
    groups: ["HCSO Main"],
    affiliation: "friend",
    origin: "eud",
    iconId: "some:icon.png",
    iconSource: "type2525b",
    teamColor: "#1e88e5",
  },
  {
    uid: "feed-1",
    callsign: "W62",
    type: "a-f-G-E-V",
    lat: 35.05,
    lon: -85.21,
    groups: ["Hamilton Co AVL LAW"],
    affiliation: "friend",
    origin: "feed",
    iconId: "uuid:path/vehicle.png",
    iconSource: "usericon",
    teamColor: "#ff0000",
  },
];

assert.strictEqual(mapRender.markerUsesMapIcon(sampleMarkers[0]), false);
assert.strictEqual(mapRender.markerUsesMapIcon(sampleMarkers[1]), true);

const scoped = mapRender.buildGeoJson(sampleMarkers, {
  scopeChannelKeys: new Set(["hcso main"]),
  markerRevision: 1,
});
assert.strictEqual(scoped.features.length, 1);
assert.strictEqual(scoped.features[0].properties.uid, "eud-1");

const filtered = mapRender.buildGeoJson(sampleMarkers, {
  enabledChannelKeys: new Set(["hamilton co avl law"]),
  markerRevision: 2,
});
assert.strictEqual(filtered.features.length, 1);
assert.strictEqual(filtered.features[0].properties.uid, "feed-1");

const feedFeature = filtered.features[0].properties;
assert.ok(feedFeature.iconId.startsWith("mimg-"));
assert.strictEqual(feedFeature.showCircle, 0);
assert.strictEqual(feedFeature.usesMapIcon, 1);
assert.ok(feedFeature.channelKeys.includes("hamilton co avl law"));
assert.strictEqual(feedFeature.drawTier, 0);
assert.ok(Number.isFinite(feedFeature.renderSort));
assert.ok(Array.isArray(filtered.meta.iconManifest));
assert.strictEqual(filtered.meta.iconManifest.length, 1);
assert.strictEqual(filtered.meta.iconManifest[0].mapImageId, feedFeature.iconId);
assert.strictEqual(filtered.meta.iconManifest[0].apiIconId, sampleMarkers[1].iconId);

const mapImageId = mapIconRender.computeMapImageId(
  sampleMarkers[1],
  sampleMarkers[1].iconId,
  mapRender.markerDisplayColor(sampleMarkers[1])
);
assert.ok(mapImageId.startsWith("mimg-"));

const decluttered = mapRender.buildGeoJson(sampleMarkers, {
  declutterLabels: true,
  zoom: 12,
  selectedUid: "feed-1",
  markerRevision: 3,
});
assert.strictEqual(decluttered.features.length, 2);
const selected = decluttered.features.find(function (f) {
  return f.properties.uid === "feed-1";
});
assert.strictEqual(selected.properties.showLabel, 1);

const slimFeed = mapRender.toSlimMarker(sampleMarkers[1]);
assert.ok(slimFeed.mapImageId.startsWith("mimg-"));
assert.strictEqual(slimFeed.usesMapIcon, 1);
assert.ok(slimFeed.channelKeys.includes("hamilton co avl law"));
assert.strictEqual(slimFeed.showCircle, 0);

const rendered = mapRender.toRenderedFeature(sampleMarkers[1], {});
assert.strictEqual(rendered.properties.iconId, slimFeed.mapImageId);
assert.strictEqual(rendered.properties.apiIconId, sampleMarkers[1].iconId);
assert.strictEqual(rendered.properties.usesMapIcon, 1);

console.log("mapRender.test.js: all assertions passed");
