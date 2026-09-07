const assert = require("assert");
const cot = require("../services/locatorCot.service");

assert.strictEqual(cot.liveTrackUid("abc"), "takportal.locator.abc");
assert.ok(cot.dropTrackUid("abc", "2026-09-07T01:02:03.000Z").startsWith("takportal.locator.abc.drop."));
assert.strictEqual(cot.toMartiGroupName("tak_HCSO Main"), "HCSO Main");
assert.strictEqual(cot.staleAfterMs(15), 45000);
assert.strictEqual(cot.staleAfterMs(20), 60000);
assert.strictEqual(cot.staleAfterMs(0), 120000);

const now = new Date("2026-09-07T12:00:00.000Z");
const live = cot.buildEventJs({
  uid: cot.liveTrackUid("id1"),
  type: cot.LIVE_TYPE,
  lat: 35.1,
  lon: -85.2,
  ce: 12,
  callsign: "LOCATOR - Hiker",
  color: "Cyan",
  remarks: "Hello",
  destGroup: "HCSO Main",
  now,
  staleDate: new Date(now.getTime() + 45000),
});
assert.strictEqual(live.event._attributes.uid, "takportal.locator.id1");
assert.strictEqual(live.event._attributes.type, "a-f-G-U-C");
assert.strictEqual(live.event.detail.contact._attributes.callsign, "LOCATOR - Hiker");
assert.strictEqual(live.event.detail.__group._attributes.name, "Cyan");
assert.strictEqual(live.event.detail.marti.dest[0]._attributes.group, "HCSO Main");
assert.ok(!live.event.detail.contact._attributes.endpoint);

const drop = cot.buildEventJs({
  uid: cot.dropTrackUid("id1", now),
  type: cot.DROP_TYPE,
  lat: 35.1,
  lon: -85.2,
  callsign: "LOCATOR - Hiker",
  color: "Red",
  destMission: "Search Alpha",
  now,
  staleDate: new Date(now.getTime() + 1000),
});
assert.strictEqual(drop.event._attributes.type, "b-m-p-s-m");
assert.strictEqual(drop.event.detail.marti.dest[0]._attributes.mission, "Search Alpha");
assert.ok(!drop.event.detail.filtergroup);

const del = cot.buildDeleteEventJs({
  uid: cot.liveTrackUid("id1"),
  destGroup: "HCSO Main",
  now,
});
assert.strictEqual(del.event._attributes.type, "t-x-d-d");
assert.strictEqual(del.event.detail.link._attributes.uid, "takportal.locator.id1");

console.log("locatorCot.test.js: ok");
