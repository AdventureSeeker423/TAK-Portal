const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "services", "authentikOutbox.service.js"),
  "utf8"
);
assert.ok(
  /FOR UPDATE SKIP LOCKED/.test(src),
  "outbox claim must use SKIP LOCKED so two workers cannot take the same row"
);
assert.ok(
  /UPDATE authentik_outbox SET next_attempt_at/.test(src),
  "claim should bump next_attempt_at in the same statement as SKIP LOCKED"
);

console.log("outbox.skipLocked.test.js: ok");
