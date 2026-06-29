const assert = require("assert");
const {
  extractHashFromMartiResponse,
} = require("../services/takMissionPackage.service");

const sampleHash = "a".repeat(64);

assert.strictEqual(extractHashFromMartiResponse({ Hash: sampleHash }), sampleHash);
assert.strictEqual(extractHashFromMartiResponse({ hash: sampleHash.toUpperCase() }), sampleHash);
assert.strictEqual(
  extractHashFromMartiResponse({ data: { sha256: sampleHash } }),
  sampleHash
);
assert.strictEqual(extractHashFromMartiResponse(JSON.stringify({ hash: sampleHash })), sampleHash);
assert.strictEqual(extractHashFromMartiResponse("not-a-hash"), "");

console.log("takMissionPackage.service.test.js OK");
