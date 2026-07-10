const assert = require("assert");
const mapMeta = require("../services/mapMeta.service");

assert.strictEqual(mapMeta.normalizeFeedIdentityKey("Lightbug SWAT"), "lightbugswat");
assert.strictEqual(mapMeta.normalizeFeedIdentityKey("lightbug-swat"), "lightbugswat");

const lightbugCandidates = mapMeta.buildDataFeedIdentityCandidates({
  uid: "lightbug-swat-40002573",
  callsign: "SWAT Truck",
});
assert.ok(lightbugCandidates.includes("lightbug-swat-40002573"));
assert.ok(lightbugCandidates.includes("lightbug-swat"));
assert.ok(lightbugCandidates.includes("lightbugswat"));
assert.ok(lightbugCandidates.includes("swattruck"));

assert.strictEqual(mapMeta.feedIdentityOverlaps("lightbug", "lightbugswat"), true);
assert.strictEqual(mapMeta.feedIdentityOverlaps("totallydifferent", "lightbugswat"), false);

const shortUid = mapMeta.buildDataFeedIdentityCandidates({ uid: "ab" });
assert.strictEqual(shortUid.length, 0);

console.log("mapMeta.test.js OK");
