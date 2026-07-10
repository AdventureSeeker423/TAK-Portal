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

assert.strictEqual(mapMeta.integrationTitleHyphenSlug("Lightbug SWAT"), "lightbug-swat");
assert.strictEqual(
  mapMeta.integrationUsernameTitleSlug("nodered-agency-hcso-lightbugswat"),
  "lightbugswat"
);

const swatEntry = {
  username: "nodered-agency-hcso-swatvehicletrackers",
  title: "SWAT Vehicle Trackers",
  titleSlug: "swatvehicletrackers",
  hyphenSlug: "swat-vehicle-trackers",
  usernameTitleSlug: "swatvehicletrackers",
  titleWordKeys: ["swat", "vehicle", "trackers"],
  groups: ["tak_HCSO SWAT"],
};
const swatMarker = { uid: "lightbug-swat-40002573", callsign: "SWAT Truck" };
const swatCandidates = mapMeta.buildDataFeedIdentityCandidates(swatMarker);
assert.ok(swatCandidates.includes("swat"));
assert.ok(mapMeta.integrationTitleWordKeys("SWAT Vehicle Trackers").includes("swat"));

const shortUid = mapMeta.buildDataFeedIdentityCandidates({ uid: "ab" });
assert.strictEqual(shortUid.length, 0);

console.log("mapMeta.test.js OK");
