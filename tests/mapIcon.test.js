/**
 * Map icon resolution and display regression tests.
 * Run: npm test
 */
const assert = require("assert");
const mapIcon = require("../services/mapIcon.service");
const mapIconResolve = require("../services/mapIcon.resolve");
const mapIconRender = require("../services/mapIconRender.service");
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

  // EUD ground uses dots; EUD air keeps type2525b/milsym symbology
  const eudAir = {
    type: "a-f-A-C-H",
    origin: "eud",
    iconId: rotor.iconId,
    iconSource: rotor.source,
  };
  assert.strictEqual(mapRender.markerUsesMapIcon(eudAir), true);

  const eudGround = {
    type: "a-f-G-U-C",
    origin: "eud",
    iconId: "34ae1613-9645-4222-a9d2-e5f243dea2865:People/walk.png",
    iconSource: "usericon",
  };
  assert.strictEqual(mapRender.markerUsesMapIcon(eudGround), true);

  // Bare a-f-G-U-C must not pick FalconView A-F-G.png (ATAK shows a team dot)
  const bareEud = mapIcon.resolveIcon({ type: "a-f-G-U-C", affiliation: "friend" });
  assert.strictEqual(bareEud, null, "bare ground EUD should not resolve a type2525b PNG");
  const bareEudAsync = await mapIcon.resolveIconAsync({
    type: "a-f-G-U-C",
    affiliation: "friend",
  });
  assert.strictEqual(bareEudAsync, null, "bare ground EUD should not fall back to milsym");
  assert.strictEqual(
    mapRender.markerUsesMapIcon({
      type: "a-f-G-U-C",
      origin: "feed",
      iconId: "6d180afb-89a6-4c07-b2b3-a89748b6a38f:FalconView/A-F-G.png",
      iconSource: "type2525b",
    }),
    false,
    "ground EUD stays a team dot even if origin is misclassified as feed"
  );

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

  const aircraftDetail = {
    remarks: {
      _text:
        "Callsign: TBI-Specter\nRegistration: N563MG\nType: PC12\nAltitude (MSL): 10325 ft\nSpeed: 169 kt\nHeading: 98\nSource: tak-solutions\nHEX: A73329",
    },
    source: {
      _attributes: {
        type: "dataFeed",
        name: "aircraftemergency",
        uid: "eecb9a16-5f0c-4661-a800-c7bb14e612bc",
      },
    },
  };
  const aircraftIcon = mapIcon.resolveIcon({
    type: "a-f-A-M-F",
    affiliation: "friend",
    detail: aircraftDetail,
    usericon: {},
  });
  assert.ok(aircraftIcon, "aircraft emergency feed should resolve from CoT type");
  assert.strictEqual(aircraftIcon.source, "type2525b");
  assert.ok(/a-f-A-M-F/i.test(aircraftIcon.relPath || aircraftIcon.iconId));
  const aircraftMarker = {
    uid: "EMERG-ICAO-A73329",
    type: "a-f-A-M-F",
    affiliation: "friend",
    origin: "feed",
    iconId: aircraftIcon.iconId,
    iconSource: aircraftIcon.source,
    teamColor: null,
  };
  assert.strictEqual(mapRender.markerUsesMapIcon(aircraftMarker), true);
  assert.strictEqual(
    mapIconRender.iconSkipsRecolor(aircraftMarker, aircraftIcon.iconId),
    true
  );

  const psaPathIcon = mapIcon.resolveIcon({
    type: "a-f-A-M-F",
    affiliation: "friend",
    usericon: {
      iconsetpath:
        "66f14976-4b62-4023-8edb-d8d2ebeaa336/Public Safety Air/FED_FIXED_WING.png",
    },
  });
  assert.ok(psaPathIcon, "Public Safety Air dashed UUID path should resolve");
  assert.strictEqual(psaPathIcon.source, "path");
  assert.ok(/FED_FIXED_WING\.png/i.test(psaPathIcon.relPath || psaPathIcon.iconId));

  const swatCab = mapIcon.resolveIcon({
    type: "a-f-G-E-V",
    affiliation: "friend",
    usericon: {
      iconsetpath: "ad78aafb-83a6-4c07-b2b9-a897a8b6a38f/Shapes/cabs.png",
    },
  });
  assert.ok(swatCab, "Generic Icons Shapes/cabs path should resolve");
  assert.strictEqual(swatCab.source, "path");
  const swatFeedMarker = {
    type: "a-f-G-E-V",
    origin: "feed",
    iconId: swatCab.iconId,
    iconSource: swatCab.source,
  };
  assert.strictEqual(
    mapRender.markerUsesMapIcon(swatFeedMarker),
    true,
    "integration/feed ground vehicles with usericon should use PNG icon"
  );

  // Default affiliation icons
  const defaults = mapIcon.getDefaultIconIds();
  assert.ok(defaults.friend, "default friendly icon");
  assert.ok(mapIcon.getIconFilePath(defaults.friend));

  const spiIcon = mapIcon.resolveIcon({ type: "b-m-p-s-p-i", affiliation: "other" });
  assert.ok(spiIcon, "SPI type should resolve");
  assert.strictEqual(spiIcon.source, "type-override");
  assert.ok(
    /Hunting\/crosshair\.png/i.test(spiIcon.relPath || spiIcon.iconId),
    "SPI should use Default Hunting/crosshair.png, got " + spiIcon.iconId
  );
  assert.ok(mapIcon.getIconFilePath(spiIcon.iconId), "SPI crosshair icon file must exist");
  assert.strictEqual(
    mapRender.markerUsesMapIcon({
      type: "b-m-p-s-p-i",
      origin: "spi",
      iconId: spiIcon.iconId,
      iconSource: spiIcon.source,
    }),
    true,
    "SPI markers should render with map icons"
  );

  const sensorLocIcon = mapIcon.resolveIcon({ type: "b-m-p-s-p-loc", affiliation: "other" });
  assert.ok(sensorLocIcon, "sensor location type should resolve");
  assert.strictEqual(sensorLocIcon.source, "type-override");
  assert.ok(
    /Shapes\/camera\.png/i.test(sensorLocIcon.relPath || sensorLocIcon.iconId),
    "sensor location should use camera icon, got " + sensorLocIcon.iconId
  );
  assert.ok(
    mapIcon.getIconFilePath(sensorLocIcon.iconId),
    "sensor location camera icon file must exist"
  );

  console.log("mapIcon.test.js: all assertions passed");
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
