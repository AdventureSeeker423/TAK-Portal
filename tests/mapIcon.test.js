/**
 * Map icon resolution and display regression tests.
 * Run: npm test
 */
const assert = require("assert");
const mapIcon = require("../services/mapIcon.service");
const mapRender = require("../services/mapRender.service");

async function runTests() {
  await mapIcon.ensureIconsets();
  const status = mapIcon.getStatus();
  assert.strictEqual(status.ready, true, "iconsets should load");
  assert.strictEqual(
    status.iconsetCount,
    status.requiredIconsetCount,
    "all bundled iconsets should load"
  );

  // Aircraft feed — civilian fixed-wing (not FIRE_SEAT)
  const fixed = mapIcon.resolveIcon({ type: "a-f-A-C-F", affiliation: "friend" });
  assert.ok(fixed, "a-f-A-C-F should resolve");
  assert.ok(
    /fed_fixed_wing/i.test(fixed.relPath || fixed.iconId),
    "civilian fixed-wing should use 2525 FED_FIXED_WING art, got " + fixed.iconId
  );
  assert.ok(mapIcon.getIconFilePath(fixed.iconId), "icon file must exist");

  // Aircraft feed — civilian rotor
  const rotor = mapIcon.resolveIcon({ type: "a-f-A-C-H", affiliation: "friend" });
  assert.ok(rotor, "a-f-A-C-H should resolve");
  assert.ok(
    /fed_rotor/i.test(rotor.relPath || rotor.iconId),
    "civilian rotor should use 2525 FED_ROTOR art, got " + rotor.iconId
  );

  const airHit = mapIcon.findBestTypeMatch("a-f-A-C-F");
  assert.strictEqual(
    airHit.iconsetUid,
    mapIcon.PUBLIC_SAFETY_AIR_UID,
    "bare a-f-A-C-F should use Public Safety Air framed symbology"
  );
  assert.ok(/fed_fixed_wing/i.test(airHit.iconName || airHit.relPath || ""));

  // EUD always dots
  const eudAir = {
    type: "a-f-A-C-H",
    origin: "eud",
    iconId: rotor.iconId,
    iconSource: rotor.source,
  };
  assert.strictEqual(mapRender.markerUsesMapIcon(eudAir), false);

  const eudGround = {
    type: "a-f-G-U-C",
    origin: "eud",
    iconId: "34ae1613-9645-4222-a9d2-e5f243dea2865:People/walk.png",
    iconSource: "usericon",
  };
  assert.strictEqual(mapRender.markerUsesMapIcon(eudGround), false);

  // Feed air uses PNG
  const feedAir = {
    type: "a-f-A-C-H",
    origin: "feed",
    iconId: rotor.iconId,
    iconSource: rotor.source,
  };
  assert.strictEqual(mapRender.markerUsesMapIcon(feedAir), true);

  // COT_MAPPING_2525B override
  const mapped = mapIcon.resolveIcon({
    type: "a-f-G-E-V",
    affiliation: "friend",
    usericon: { iconsetpath: "COT_MAPPING_2525B/a/f/A/C/H" },
  });
  assert.ok(mapped, "COT_MAPPING_2525B path should resolve");
  assert.ok(/fed_rotor/i.test(mapped.relPath || mapped.iconId));

  // Default affiliation icons
  const defaults = mapIcon.getDefaultIconIds();
  assert.ok(defaults.friend, "default friendly icon");
  assert.ok(mapIcon.getIconFilePath(defaults.friend));

  console.log("mapIcon.test.js: all assertions passed");
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
