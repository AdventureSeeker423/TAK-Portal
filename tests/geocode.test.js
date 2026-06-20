const assert = require("assert");
const geocode = require("../services/geocode.service");

assert.strictEqual(
  geocode.isUnitedStatesHit("US", "United States"),
  true
);
assert.strictEqual(geocode.isUnitedStatesHit("CA", "Canada"), false);

const merged = geocode.mergeHits(
  [
    [
      { lat: 35.04, lon: -85.2, label: "123 Main St, Chattanooga, TN", source: "census", score: 82 },
    ],
    [
      { lat: 35.0401, lon: -85.2001, label: "123 Main St, Chattanooga, TN 37405", source: "geocod.io", score: 98 },
      { lat: 36.16, lon: -86.78, label: "Nashville, TN", source: "photon", score: 60 },
    ],
  ],
  5
);

assert.strictEqual(merged.length, 2);
assert.ok(merged[0].label.includes("123"));
assert.ok(merged.some(function (r) { return /Nashville/i.test(r.label); }));

const samePlace = geocode.mergeHits(
  [
    [
      {
        lat: 35.049627,
        lon: -85.309474,
        label:
          "6125, Preservation Drive, Brentwood, Chattanooga, Hamilton County, East Tennessee, Tennessee, 37416, United States",
        source: "nominatim",
        score: 70,
      },
      {
        lat: 35.049628,
        lon: -85.309475,
        label: "6125 PRESERVATION DR, CHATTANOOGA, TN, 37416",
        source: "census",
        score: 92,
      },
      {
        lat: 35.04962,
        lon: -85.30948,
        label: "6125 Preservation Drive, Chattanooga, Tennessee, 37416",
        source: "photon",
        score: 80,
      },
    ],
  ],
  5
);
assert.strictEqual(samePlace.length, 1);
assert.strictEqual(
  samePlace[0].label,
  "6125 PRESERVATION DR, CHATTANOOGA, TN, 37416"
);

const suppressVague = geocode.mergeHits(
  [
    [
      {
        lat: 35.049627,
        lon: -85.309474,
        label: "6125 PRESERVATION DR, CHATTANOOGA, TN, 37416",
        source: "census",
        score: 92,
      },
      {
        lat: 35.04961,
        lon: -85.30946,
        label: "Preservation Drive, Chattanooga, Tennessee",
        source: "photon",
        score: 72,
      },
    ],
  ],
  5
);
assert.strictEqual(suppressVague.length, 1);

const byDistance = geocode.sortHits(
  [
    { lat: 35.05, lon: -85.31, label: "Near", source: "census", score: 90 },
    { lat: 36.16, lon: -86.78, label: "Far", source: "photon", score: 95 },
  ],
  { nearLat: 35.0456, nearLon: -85.3097 }
);
assert.strictEqual(byDistance[0].label, "Near");

const distanceBeatsScore = geocode.sortHits(
  [
    { lat: 36.16, lon: -86.78, label: "Far", source: "photon", score: 99 },
    { lat: 35.05, lon: -85.31, label: "Near", source: "census", score: 50 },
  ],
  { nearLat: 35.0456, nearLon: -85.3097 }
);
assert.strictEqual(distanceBeatsScore[0].label, "Near");

const variants = geocode.buildQueryVariants("600 market street chattanooga");
assert.ok(variants.some(function (v) { return /Chattanooga,\s*TN/i.test(v); }));

const normalized = geocode.normalizeHit({
  lat: "35.5",
  lon: "-85.5",
  label: " Test ",
  source: "x",
  score: 10,
});
assert.strictEqual(normalized.lat, 35.5);
assert.strictEqual(normalized.label, "Test");

(async function () {
  const blocked = global.fetch;
  global.fetch = function () {
    return Promise.reject(new Error("blocked"));
  };
  try {
    const out = await geocode.geocodeSearch("600 market", { limit: 1 });
    assert.ok(out && typeof out === "object");
    assert.ok(Array.isArray(out.results));
    assert.strictEqual(out.results.length, 0);
    assert.strictEqual(out.lookupFailed, true);
  } finally {
    global.fetch = blocked;
  }
})().then(function () {
  console.log("geocode.test.js: all assertions passed");
});
