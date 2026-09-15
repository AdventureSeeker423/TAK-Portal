const assert = require("assert");
const tak = require("../services/tak.service");
const {
  loginStatusLabel,
  hasStoredLastLogin,
  parseAuthentikLastLogin,
  statusSortRank,
  compareUsersByStatus,
  annotateUsersLoginStatus,
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
  "User"
);
assert.strictEqual(
  loginStatusLabel({
    is_active: true,
    hasActiveTakCert: false,
    hasAuthentikLogin: true,
    takCertsKnown: true,
    permissionLabel: "Agency Admin",
  }),
  "Agency Admin"
);
assert.strictEqual(
  loginStatusLabel({
    is_active: true,
    hasActiveTakCert: false,
    hasAuthentikLogin: false,
    takCertsKnown: true,
    permissionLabel: "Global Admin",
  }),
  "Global Admin - No Logins"
);
assert.strictEqual(
  loginStatusLabel({
    is_active: true,
    hasActiveTakCert: false,
    hasAuthentikLogin: false,
    takCertsKnown: false,
    permissionLabel: "Multi-Agency Admin",
  }),
  "Multi-Agency Admin"
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
    permissionLabel: "User",
    hasActiveTakCert: false,
    hasAuthentikLogin: false,
    takCertsKnown: true,
  }),
  1
);
assert.strictEqual(
  statusSortRank({
    is_active: true,
    permissionLabel: "User",
    hasActiveTakCert: true,
    hasAuthentikLogin: false,
    takCertsKnown: true,
  }),
  2
);
assert.strictEqual(
  statusSortRank({
    is_active: true,
    permissionLabel: "Agency Admin",
    hasAuthentikLogin: true,
    takCertsKnown: true,
  }),
  4
);

const ordered = [
  { username: "zulu", is_active: true, hasAuthentikLogin: true, takCertsKnown: true, permissionLabel: "User" },
  { username: "alpha", is_active: false, takCertsKnown: true },
  { username: "mike", is_active: true, takCertsKnown: true, permissionLabel: "User" },
].sort(compareUsersByStatus);
assert.deepStrictEqual(
  ordered.map((u) => u.username),
  ["alpha", "mike", "zulu"]
);

const annotated = annotateUsersLoginStatus([
  {
    username: "2888hs",
    is_active: true,
    portal_role: "Agency Admin",
    statusLabel: "Agency Admin - No Logins",
    last_login: null,
    hasActiveTakCert: false,
  },
]);
assert.strictEqual(annotated[0].permissionLabel, "Agency Admin");
assert.strictEqual(annotated[0].statusLabel, "Agency Admin - No Logins");

console.log("userLoginStatus.test.js: ok");
