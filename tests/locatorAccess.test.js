const assert = require("assert");
const fs = require("fs");
const path = require("path");
const registry = require("../services/permissions.registry");
const access = require("../services/locatorAccess.service");

assert.ok(
  registry.getDefaultSetForRole("agency_admin").has("page.locate"),
  "agency admins get locate by default"
);
assert.deepStrictEqual(registry.getRequiredPermissionsForRequest("/locate", "GET"), ["page.locate"]);
assert.deepStrictEqual(
  registry.getRequiredPermissionsForRequest("/locate-legacy", "GET"),
  ["page.locate"]
);
assert.deepStrictEqual(
  registry.getRequiredPermissionsForRequest("/api/locate-legacy/config", "GET"),
  ["page.locate"]
);
assert.deepStrictEqual(
  registry.getRequiredPermissionsForRequest("/api/locate/locators", "POST"),
  ["page.locate"]
);

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
assert.ok(/\/locate-legacy", requirePermission\("page\.locate"\)/.test(serverSrc));
assert.ok(/\/api\/locate-legacy[\s\S]{0,180}requirePermission\("page\.locate"\)/.test(serverSrc));

const agency = { isGlobalAdmin: false, isAgencyAdmin: true };
const global = { isGlobalAdmin: true };
const allowed = new Set(["hcso ops"]);
const locators = [
  { id: "1", kind: "live", channel: "tak_HCSO Ops" },
  { id: "2", kind: "live", channel: "County Law" },
  { id: "3", kind: "legacy", channel: "tak_HCSO Ops" },
];
assert.deepStrictEqual(
  access.filterLocatorsForAccess(agency, locators, allowed).map((l) => l.id),
  ["1"]
);
assert.strictEqual(access.filterLocatorsForAccess(global, locators, allowed).length, 2);

assert.doesNotThrow(() => access.assertChannelInScope(global, "County Law", allowed));
assert.throws(
  () => access.assertChannelInScope(agency, "County Law", allowed),
  (err) => err && err.status === 403
);

const channelPatchAccess = require("../services/channelPatchAccess.service");
const locatorSrc = fs.readFileSync(
  path.join(__dirname, "..", "services", "locatorAccess.service.js"),
  "utf8"
);
assert.ok(
  locatorSrc.includes("mergeCreatedMutualAidPickerChannels"),
  "locate channel list merges MA-created groups for global admins"
);
assert.ok(
  locatorSrc.includes("includeMutualAid"),
  "locate hides MA-created groups from agency admins"
);

const legacySrc = fs.readFileSync(
  path.join(__dirname, "..", "routes", "locate-legacy.routes.js"),
  "utf8"
);
assert.ok(
  legacySrc.includes("locatorAccess.listChannelsForUser"),
  "legacy locate persons uses the same channel allowlist as /locate"
);

const maMerged = channelPatchAccess.mergeCreatedMutualAidPickerChannels(
  [{ name: "tak_HCSO Ops", displayName: "HCSO Ops", baseKey: "hcso ops" }],
  ["tak_MA - Event"]
);
assert.ok(maMerged.some((c) => c.baseKey === "ma - event"));

console.log("locatorAccess.test.js: ok");
