const assert = require("assert");
const tak = require("../services/tak.service");
const status = require("../services/mutualAid.status");

const counts = tak.countActiveUnrevokedCertsByUsername([
  { id: "new-1", creatorDn: "ma-fair" },
  { id: "new-2", creatorDn: "MA-Fair" },
  { id: "old-1", creatorDn: "ma-fair", revoked: true },
  { id: "old-2", creatorDn: "ma-fair", status: "REVOKED" },
  { id: "new-1", creatorDn: "ma-fair" },
  { id: "expired", creatorDn: "ma-fair", expirationDate: "2000-01-01T00:00:00.000Z" },
  { id: "other", creatorDn: "ma-search" },
]);

assert.strictEqual(counts.get("ma-fair"), 2);
assert.strictEqual(counts.get("ma-search"), 1);
assert.strictEqual(counts.has("ma-fair".toUpperCase()), false);

const inactive = status.certStatusForUsername("ma-fair", {
  ok: true,
  counts: new Map([["ma-other", 1]]),
});
assert.strictEqual(inactive.certStatusLabel, "Inactive");
assert.strictEqual(inactive.certStatus, "inactive");

const active = status.certStatusForUsername("MA-Fair", {
  ok: true,
  counts,
});
assert.strictEqual(active.certStatusLabel, "Active - 2 Users");
assert.strictEqual(active.activeUserCount, 2);

const unknown = status.certStatusForUsername("ma-fair", { ok: false, counts: new Map() });
assert.strictEqual(unknown.certStatusKnown, false);
assert.strictEqual(unknown.certStatusLabel, "");

const now = Date.parse("2026-10-05T12:00:00.000Z");
const banners = status.summarizeMutualAidBanners(
  [
    { type: "INCIDENT", activeUserCount: 1, certStatusKnown: true },
    { type: "INCIDENT", activeUserCount: 3, certStatusKnown: true },
    { type: "INCIDENT", activeUserCount: 2, certStatusKnown: true },
    { type: "EVENT", activeUserCount: 4, certStatusKnown: true },
    { type: "EVENT", activeUserCount: 1, certStatusKnown: true },
    { type: "STANDBY", activeUserCount: 5, certStatusKnown: true },
    { type: "SUB-INCIDENT", activeUserCount: 6, certStatusKnown: true },
    {
      type: "INCIDENT",
      activeUserCount: 9,
      certStatusKnown: true,
      expireEnabled: true,
      expireAt: "2026-10-01T00:00:00.000Z",
    },
    { type: "INCIDENT", activeUserCount: 8, certStatusKnown: false },
  ],
  now
);

assert.strictEqual(banners.activeIncidents, 2);
assert.strictEqual(banners.incidentUsers, 5);
assert.strictEqual(banners.activeEvents, 1);
assert.strictEqual(banners.eventUsers, 4);

const promote = status.standbysToPromote(
  [
    { id: "a", type: "STANDBY", username: "ma-fair" },
    { id: "b", type: "STANDBY", username: "ma-quiet" },
    { id: "c", type: "INCIDENT", username: "ma-fair" },
    { id: "d", type: "SUB-STANDBY", username: "ma-fair-1" },
  ],
  counts
);
assert.deepStrictEqual(
  promote.map((item) => item.id),
  ["a"]
);

console.log("mutualAid.status.test.js passed");
