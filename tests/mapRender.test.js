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

const boundsOnly = mapRender.buildGeoJson(sampleMarkers, {
  bounds: { west: -85.205, south: 35.035, east: -85.195, north: 35.045 },
  markerRevision: 21,
});
assert.strictEqual(boundsOnly.features.length, 1);
assert.strictEqual(boundsOnly.features[0].properties.uid, "eud-1");

const boundsKeepSelected = mapRender.buildGeoJson(sampleMarkers, {
  bounds: { west: -85.205, south: 35.035, east: -85.195, north: 35.045 },
  selectedUid: "feed-1",
  markerRevision: 22,
});
assert.strictEqual(boundsKeepSelected.features.length, 2);
assert.ok(
  boundsKeepSelected.features.some(function (f) {
    return f.properties.uid === "feed-1";
  }),
  "selected marker stays visible outside bounds"
);

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

const mapMeta = require("../services/mapMeta.service");
const sampleDetail = {
  link: {
    _attributes: {
      url: "https://maps.google.com/?q=35.11686,-85.21141",
      remarks: "Vehicle Location",
    },
  },
};
const parsedLinks = mapMeta.parseDetailLinks(sampleDetail);
assert.strictEqual(parsedLinks.length, 1);
assert.strictEqual(parsedLinks[0].url, "https://maps.google.com/?q=35.11686,-85.21141");
assert.strictEqual(parsedLinks[0].label, "Vehicle Location");

assert.strictEqual(
  mapMeta.parseTakPlatform({
    takv: { _attributes: { platform: "ATAK-CIV", device: "SAMSUNG SM-S938U" } },
  }),
  "ATAK-CIV"
);
assert.strictEqual(
  mapMeta.parseTakPlatform({
    takv: { _attributes: { platform: "TAKAware-CIV", os: "iOS" } },
  }),
  "TAKAware-CIV"
);
assert.strictEqual(
  mapMeta.parseBatteryPercent({
    status: { _attributes: { battery: "60" } },
  }),
  60
);
assert.strictEqual(
  mapMeta.parseBatteryPercent({
    status: { _attributes: { battery: "95" } },
  }),
  95
);

const slimWithLink = mapRender.toSlimMarker({
  ...sampleMarkers[0],
  links: parsedLinks,
});
assert.deepStrictEqual(slimWithLink.links, parsedLinks);

const unassignedMarker = {
  uid: "fed-eud-1",
  callsign: "FED-EUD-1",
  type: "a-f-G-U-C",
  lat: 35.04,
  lon: -85.2,
  groups: [mapMeta.UNASSIGNED_GROUP],
  affiliation: "friend",
  origin: "federation",
};
assert.deepStrictEqual(mapRender.markerChannelKeys(unassignedMarker), [
  mapMeta.UNASSIGNED_CHANNEL_KEY,
]);
assert.strictEqual(
  mapRender.markerVisible(unassignedMarker, {
    enabledChannelKeys: new Set([mapMeta.UNASSIGNED_CHANNEL_KEY]),
  }),
  true
);
assert.strictEqual(mapRender.markerUsesMapIcon(unassignedMarker), false);

const fedAirMarker = {
  uid: "790HP_COT_THP-AirBear1",
  callsign: "THP-AirBear1",
  type: "a-f-A-C-F",
  lat: 36.104548,
  lon: -86.672572,
  affiliation: "friend",
  origin: "federation",
  iconId: "34ae1613-9645-4222-a9d2-e5f243dea2865:Air/air_fixedwing.png",
  iconSource: "type2525b",
  flowTagUids: [
    "TAK-Server-cd849cb30b00485db3593a605b56c53b",
    "TAK-Server-e4b70029ff1a499197b40d11438e3647",
  ],
};
assert.strictEqual(
  mapMeta.classifyMarkerOrigin(fedAirMarker),
  "federation",
  "multi-hop flow tags still classify as federation"
);
assert.strictEqual(
  mapRender.markerUsesMapIcon(fedAirMarker),
  true,
  "federated aircraft should still use map icons"
);
assert.strictEqual(
  mapRender.markerUsesMapIcon({
    ...fedAirMarker,
    type: "a-f-G-U-C",
    iconSource: "type2525b",
  }),
  false,
  "federated ground EUD still uses team dots"
);

const slimGroundEud = mapRender.toSlimMarker({
  uid: "tn-humphreysso-102-edwards",
  callsign: "TN-HUMPHREYSSO-102-EDWARDS",
  type: "a-f-G-U-C",
  lat: 36.1,
  lon: -86.67,
  affiliation: "friend",
  origin: "federation",
  iconId: "2525D:10031000001209000000",
  iconSource: "milsym",
  teamColor: "#0000ff",
});
assert.strictEqual(slimGroundEud.usesMapIcon, 0);
assert.strictEqual(slimGroundEud.mapImageId, "");
assert.strictEqual(slimGroundEud.iconId, null);
assert.strictEqual(slimGroundEud.iconSource, null);
assert.strictEqual(slimGroundEud.showCircle, 1);

const spiMarker = {
  uid: "spi-1",
  callsign: "SPI-1",
  type: "b-m-p-s-p-i",
  lat: 36.1,
  lon: -86.67,
  groups: ["tak_Channel Alpha"],
  affiliation: "other",
  origin: "spi",
  iconId: "34ae1613-9645-4222-a9d2-e5f243dea2865:Hunting/crosshair.png",
  iconSource: "type-override",
};
assert.strictEqual(mapRender.markerUsesMapIcon(spiMarker), true);
assert.strictEqual(mapMeta.classifyMarkerOrigin(spiMarker), "spi");

const cotStream = require("../services/cotStream.service");
const spiFeature = cotStream.parseSpiOverlayFeature(
  {
    raw: {
      event: {
        detail: {
          shape: {
            polyline: {
              _attributes: { closed: "true", fillColor: "0", color: "-1" },
              vertex: [
                { _attributes: { lat: "36.105099", lon: "-86.672736" } },
                { _attributes: { lat: "36.105099", lon: "-86.672717" } },
                { _attributes: { lat: "36.105141", lon: "-86.672719" } },
                { _attributes: { lat: "36.105141", lon: "-86.67274" } },
              ],
            },
          },
        },
      },
    },
  },
  spiMarker
);
assert.ok(spiFeature, "SPI FOV feature should parse");
assert.strictEqual(spiFeature.geometry.type, "Polygon");
assert.strictEqual(spiFeature.properties.kind, "spi-fov");
assert.strictEqual(spiFeature.properties.fill, "#ffffff");
assert.strictEqual(spiFeature.properties.stroke, "#ffffff");
assert.ok(spiFeature.properties["fill-opacity"] < 0.2, "SPI fill should be lighter than before");
assert.ok(spiFeature.geometry.coordinates[0].length >= 4);

console.log("mapRender.test.js: all assertions passed");
