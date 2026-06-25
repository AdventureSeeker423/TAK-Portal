"use strict";

const assert = require("assert");
const access = require("../services/access.service");

assert.strictEqual(access.normalizeUsernameTokenPlacement("prefix"), "prefix");
assert.strictEqual(access.normalizeUsernameTokenPlacement("suffix"), "suffix");
assert.strictEqual(access.normalizeUsernameTokenPlacement("start"), "prefix");
assert.strictEqual(access.normalizeUsernameTokenPlacement(undefined), "suffix");

assert.strictEqual(
  access.buildUsernameWithAgencyToken("1234", { suffix: "hs", usernameTokenPlacement: "suffix" }),
  "1234hs"
);
assert.strictEqual(
  access.buildUsernameWithAgencyToken("1234", { suffix: "hs", usernameTokenPlacement: "prefix" }),
  "hs1234"
);

assert.strictEqual(access.stripAgencyTokenFromUsername("1234hs", "hs"), "1234");
assert.strictEqual(access.stripAgencyTokenFromUsername("hs1234", "hs"), "1234");
assert.strictEqual(
  access.stripAgencyTokenFromUsername("hs1234", "hs", "prefix"),
  "1234"
);
assert.strictEqual(
  access.stripAgencyTokenFromUsername("1234hs", "hs", "prefix"),
  "1234hs"
);

assert.strictEqual(
  access.stripAgencyTokenFromBadge("1234hs", "hs", { suffix: "hs", usernameTokenPlacement: "suffix" }),
  "1234"
);
assert.strictEqual(
  access.stripAgencyTokenFromBadge("hs1234", "hs", { suffix: "hs", usernameTokenPlacement: "prefix" }),
  "1234"
);

assert.strictEqual(access.usernameHasAgencySuffixToken("johnhs", "hs"), true);
assert.strictEqual(access.usernameHasAgencySuffixToken("hsjohn", "hs"), true);
assert.strictEqual(access.usernameHasAgencySuffixToken("other", "hs"), false);

console.log("usernameToken.test.js: ok");
