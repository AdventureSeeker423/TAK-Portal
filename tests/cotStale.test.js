const assert = require("assert");
const stale = require("../services/cotStale.util");

const now = Date.parse("2026-09-07T14:09:50Z");
const eud = {
  uid: "11927918-E536-425E-888C-D53C43AD5121",
  type: "a-f-G-U-C",
  stale: "2026-09-07T14:14:43Z",
};

assert.strictEqual(stale.isLiveSaPresenceType("a-f-G-U-C"), true);
assert.strictEqual(stale.isLiveSaPresenceType("a-h-G-U-C"), true);
assert.strictEqual(stale.isLiveSaPresenceType("a-f-G-E-V-C"), true);
assert.strictEqual(stale.isLiveSaPresenceType("a-f-A-C-F"), true);
assert.strictEqual(stale.isLiveSaPresenceType("a-f-G-E-V"), false);
assert.strictEqual(stale.isLiveSaPresenceType("a-u-G"), false);
assert.strictEqual(stale.isLiveSaPresenceType("b-m-p-s-m"), false);

assert.strictEqual(stale.shouldKeepUntilStale(eud, now), true);
assert.strictEqual(
  stale.shouldKeepUntilStale(eud, Date.parse("2026-09-07T14:15:20Z")),
  false
);
assert.strictEqual(
  stale.shouldKeepUntilStale(
    { ...eud, uid: "takportal.locator.abc" },
    now
  ),
  false
);

const lastGasp = { ...eud, stale: "2026-09-07T14:09:50Z" };
assert.strictEqual(stale.shouldIgnoreIncomingSa(eud, lastGasp, now), true);
assert.strictEqual(
  stale.shouldIgnoreIncomingSa(eud, { ...eud, stale: "2026-09-07T14:14:50Z" }, now),
  false
);

assert.strictEqual(stale.isCotStale(eud, now), false);
assert.strictEqual(stale.isCotStale(eud, Date.parse("2026-09-07T14:14:44Z")), true);
assert.strictEqual(stale.isMarkerExpired(eud, now), false);
assert.strictEqual(
  stale.isMarkerExpired(eud, Date.parse("2026-09-07T14:15:20Z")),
  true
);

console.log("cotStale.test.js: ok");
