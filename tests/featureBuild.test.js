/**
 * Live-map paint features: ground EUDs stay team dots even with leftover milsym ids.
 */
const assert = require("assert");
const path = require("path");
const esbuild = require("esbuild");

async function loadFeatureBuild() {
  const entry = path.join(__dirname, "..", "client", "map", "featureBuild.ts");
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    target: "node18",
  });
  const code = result.outputFiles[0].text;
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  Function("module", "exports", "require", code)(mod, mod.exports, require);
  return mod.exports;
}

function groundEud(overrides) {
  return {
    uid: "android-humphreys",
    callsign: "TN-HUMPHREYSSO-102-EDWARDS",
    type: "a-f-G-U-C",
    lat: 36.1,
    lon: -86.67,
    affiliation: "friend",
    origin: "federation",
    iconId: "2525D:10031000001209000000",
    iconSource: "milsym",
    mapImageId: "mimg-0123456789abcdef",
    usesMapIcon: 1,
    color: "#0000ff",
    ...overrides,
  };
}

async function run() {
  const {
    buildPaintFeature,
    markerPaintsMapIcon,
    effectiveMapImageId,
    isStandardGroundEudType,
  } = await loadFeatureBuild();

  assert.strictEqual(isStandardGroundEudType("a-f-G-U-C"), true);
  assert.strictEqual(isStandardGroundEudType("a-f-A-C-F"), false);

  assert.strictEqual(markerPaintsMapIcon(groundEud()), false);
  assert.strictEqual(effectiveMapImageId(groundEud()), "");

  const feat = buildPaintFeature(groundEud());
  assert.ok(feat);
  assert.strictEqual(feat.properties.iconId, "");
  assert.strictEqual(feat.properties.showCircle, 1);
  assert.strictEqual(feat.properties.usesMapIcon, 0);

  const custom = buildPaintFeature(
    groundEud({
      iconSource: "usericon",
      iconId: "34ae1613-9645-4222-a9d2-e5f243dea2865:People/walk.png",
    })
  );
  assert.strictEqual(custom.properties.iconId, "mimg-0123456789abcdef");
  assert.strictEqual(custom.properties.usesMapIcon, 1);

  const forcedOff = buildPaintFeature(
    groundEud({
      type: "a-f-G-E-V",
      usesMapIcon: 0,
    })
  );
  assert.strictEqual(forcedOff.properties.iconId, "");
  assert.strictEqual(forcedOff.properties.showCircle, 1);

  const aviationSidcNoType = buildPaintFeature({
    uid: "sidc-only",
    callsign: "TN-HUMPHREYSSO-102-EDWARDS",
    type: "",
    lat: 36.1,
    lon: -86.67,
    affiliation: "friend",
    origin: "federation",
    iconId: "2525D:10031000001209000000",
    iconSource: "milsym",
    mapImageId: "mimg-0123456789abcdef",
    usesMapIcon: 1,
    color: "#1b5e20",
  });
  assert.strictEqual(aviationSidcNoType.properties.iconId, "");
  assert.strictEqual(aviationSidcNoType.properties.showCircle, 1);

  const air = buildPaintFeature({
    uid: "air-1",
    callsign: "AIRBEAR",
    type: "a-f-A-C-F",
    lat: 36.1,
    lon: -86.67,
    affiliation: "friend",
    origin: "feed",
    iconId: "uuid:Air/fed_fixed_wing.png",
    iconSource: "type2525b",
    mapImageId: "mimg-abcdef0123456789",
    usesMapIcon: 1,
    color: "#00ff00",
  });
  assert.strictEqual(air.properties.iconId, "mimg-abcdef0123456789");

  console.log("ok - featureBuild ground EUD team dots");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
