const assert = require("assert");
const { missionPath } = require("../services/dataSync.service");

assert.strictEqual(
  missionPath("Test Fire Mission"),
  "/api/missions/Test%20Fire%20Mission"
);
assert.strictEqual(
  missionPath("Op/Alpha"),
  "/api/missions/Op%2FAlpha"
);

try {
  missionPath("");
  assert.fail("expected empty mission name to throw");
} catch (err) {
  assert.strictEqual(err.code, "INVALID_MISSION_NAME");
}

console.log("dataSync.invite.test.js OK");
