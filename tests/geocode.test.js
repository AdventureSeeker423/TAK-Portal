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

assert.strictEqual(merged.length, 3);
assert.strictEqual(merged[0].source, "geocod.io");
assert.ok(merged.some(function (r) { return r.source === "census"; }));
assert.ok(merged.some(function (r) { return r.source === "photon"; }));

const deduped = geocode.mergeHits(
  [
    [
      { lat: 35.04, lon: -85.2, label: "123 Main St, Chattanooga, TN", source: "census", score: 82 },
      { lat: 35.04, lon: -85.2, label: "123 Main St, Chattanooga, TN", source: "geocod.io", score: 98 },
    ],
  ],
  5
);
assert.strictEqual(deduped.length, 1);
assert.strictEqual(deduped[0].source, "geocod.io");

const byDistance = geocode.sortHits(
  [
    { lat: 35.05, lon: -85.31, label: "Near", source: "census", score: 90 },
    { lat: 36.16, lon: -86.78, label: "Far", source: "photon", score: 95 },
  ],
  { nearLat: 35.0456, nearLon: -85.3097 }
);
assert.strictEqual(byDistance[0].label, "Near");

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

console.log("geocode.test.js: all assertions passed");
