const assert = require("assert");
const tak = require("../services/tak.service");
const {
  loginStatusLabel,
  hasStoredLastLogin,
  parseAuthentikLastLogin,
  statusSortRank,
  compareUsersByStatus,
} = require("../services/userLoginStatus.service");

assert.strictEqual(
  loginStatusLabel({ is_active: false, takCertsKnown: true }),
  "Disabled"
);
assert.strictEqual(
  loginStatusLabel({
    is_active: true,
    hasActiveTakCert: true,
    hasAuthentikLogin: false,
    takCertsKnown: true,
  }),
  "Enabled"
);
assert.strictEqual(
  loginStatusLabel({
    is_active: true,
    hasActiveTakCert: false,
    hasAuthentikLogin: true,
    takCertsKnown: true,
  }),
  "Enabled"
);
assert.strictEqual(
  loginStatusLabel({
    is_active: true,
    hasActiveTakCert: false,
    hasAuthentikLogin: false,
    takCertsKnown: true,
  }),
  "Enabled - No Logins"
);
assert.strictEqual(
  loginStatusLabel({
    is_active: true,
    hasActiveTakCert: false,
    hasAuthentikLogin: false,
    takCertsKnown: false,
  }),
  "Enabled"
);

assert.strictEqual(hasStoredLastLogin(null), false);
assert.strictEqual(hasStoredLastLogin(""), false);
assert.strictEqual(hasStoredLastLogin("2026-09-14T12:00:00.000Z"), true);
assert.ok(parseAuthentikLastLogin("2026-09-14T12:00:00.000Z"));

const set = tak.buildActiveCertUsernameSet([
  { id: "1", creatorDn: "2888hs" },
  { id: "2", creatorDn: "revoked-user", revoked: true },
  { id: "3", creatorDn: "expired-user", expirationDate: "2000-01-01T00:00:00.000Z" },
  { id: "4", creatorDn: "2888HS", status: "valid" },
  { id: "5", creatorDn: "other-user", status: "REVOKED" },
]);
assert.strictEqual(set.has("2888hs"), true);
assert.strictEqual(set.has("revoked-user"), false);
assert.strictEqual(set.has("expired-user"), false);
assert.strictEqual(set.has("other-user"), false);

assert.strictEqual(
  tak.isActiveUnrevokedCert({ creatorDn: "ok", status: "expired" }),
  false
);

assert.strictEqual(statusSortRank({ is_active: false, takCertsKnown: true }), 0);
assert.strictEqual(
  statusSortRank({
    is_active: true,
    hasActiveTakCert: false,
    hasAuthentikLogin: false,
    takCertsKnown: true,
  }),
  1
);
assert.strictEqual(
  statusSortRank({
    is_active: true,
    hasActiveTakCert: true,
    hasAuthentikLogin: false,
    takCertsKnown: true,
  }),
  2
);

const ordered = [
  { username: "zulu", is_active: true, hasAuthentikLogin: true, takCertsKnown: true },
  { username: "alpha", is_active: false, takCertsKnown: true },
  { username: "mike", is_active: true, takCertsKnown: true },
].sort(compareUsersByStatus);
assert.deepStrictEqual(
  ordered.map((u) => u.username),
  ["alpha", "mike", "zulu"]
);

console.log("userLoginStatus.test.js: ok");
