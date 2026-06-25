/**
 * Map icon resolution and display regression tests.
 * Run: npm test
 */
const assert = require("assert");
const mapIcon = require("../services/mapIcon.service");
const mapIconResolve = require("../services/mapIcon.resolve");
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

  // Milsym / 2525D display gate
  const milsymMarker = {
    type: "a-f-G-E-V",
    origin: "feed",
    iconId: "2525D:10031000001211000000",
    iconSource: "milsym",
  };
  assert.strictEqual(mapRender.markerUsesMapIcon(milsymMarker), true);

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

  // COT_MAPPING_2525C → milsym filled symbols
  const mapped2525cSync = mapIcon.resolveIcon({
    type: "a-h-G",
    affiliation: "hostile",
    usericon: { iconsetpath: "COT_MAPPING_2525C/a-h/a-h-G" },
  });
  assert.strictEqual(mapped2525cSync, null, "COT_MAPPING_2525C should defer to milsym");
  const mapped2525c = await mapIcon.resolveIconAsync({
    type: "a-h-G",
    affiliation: "hostile",
    usericon: { iconsetpath: "COT_MAPPING_2525C/a-h/a-h-G" },
  });
  assert.ok(mapped2525c, "COT_MAPPING_2525C path should resolve via milsym");
  assert.strictEqual(mapped2525c.source, "milsym");

  const bareTypeSync = mapIcon.resolveIcon({
    type: "a-h-G",
    affiliation: "hostile",
    usericon: { iconsetpath: "a-h-G" },
  });
  assert.strictEqual(bareTypeSync, null, "bare CoT type usericon should defer to milsym");
  const bareType = await mapIcon.resolveIconAsync({
    type: "a-h-G",
    affiliation: "hostile",
    usericon: { iconsetpath: "a-h-G" },
  });
  assert.ok(bareType, "bare CoT type usericon should resolve via milsym");
  assert.strictEqual(bareType.source, "milsym");

  // GeoOps iconset uses 64-char content hash UIDs in usericon paths
  const geoOpsCamp = mapIcon.resolveIcon({
    type: "a-n-G",
    affiliation: "neutral",
    usericon: {
      iconsetpath:
        "83198b4872a8c34eb9c549da8a4de5a28f07821185b39a2277948f66c24ac17a/WildFire/Camp.png",
    },
  });
  assert.ok(geoOpsCamp, "GeoOps hash UID path should resolve");
  assert.strictEqual(geoOpsCamp.source, "path");
  assert.ok(/WildFire\/Camp\.png/i.test(geoOpsCamp.relPath || geoOpsCamp.iconId));
  assert.ok(mapIcon.getIconFilePath(geoOpsCamp.iconId), "GeoOps Camp file must exist");

  const geoOpsMedical = mapIcon.resolveIcon({
    type: "a-n-G",
    affiliation: "neutral",
    usericon: {
      iconsetpath:
        "83198b4872a8c34eb9c549da8a4de5a28f07821185b39a2277948f66c24ac17a/WildFire/Medical.png",
    },
  });
  assert.ok(geoOpsMedical, "GeoOps Medical path should resolve");
  assert.ok(/WildFire\/Medical\.png/i.test(geoOpsMedical.relPath || geoOpsMedical.iconId));

  // Standard dashed UUID iconset paths (e.g. OSM / CAD feeds)
  const osmCamp = mapIcon.resolveIcon({
    type: "a-u-G-E-S-R",
    affiliation: "unknown",
    usericon: {
      iconsetpath: "6d781afb-89a6-4c07-b2b9-a89748b6a38f/Misc/Camp.png",
    },
  });
  assert.ok(osmCamp, "OSM dashed UUID Camp path should resolve");
  assert.strictEqual(osmCamp.source, "path");
  assert.ok(/Misc\/Camp\.png/i.test(osmCamp.relPath || osmCamp.iconId));
  assert.ok(mapIcon.getIconFilePath(osmCamp.iconId), "OSM Camp file must exist");

  assert.strictEqual(
    mapIconResolve.isIconsetUidToken("6d781afb-89a6-4c07-b2b9-a89748b6a38f"),
    true,
    "dashed UUID iconset uid"
  );
  assert.strictEqual(
    mapIconResolve.isIconsetUidToken(
      "83198b4872a8c34eb9c549da8a4de5a28f07821185b39a2277948f66c24ac17a"
    ),
    true,
    "64-char hash iconset uid"
  );

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
