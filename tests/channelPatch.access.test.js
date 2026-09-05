"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const registry = require("../services/permissions.registry");
const access = require("../services/channelPatchAccess.service");
const store = require("../services/channelPatch.store");

assert.ok(
  registry.getDefaultSetForRole("agency_admin").has("page.channel_patch"),
  "agency admins get channel patch by default"
);
assert.deepStrictEqual(
  registry.getRequiredPermissionsForRequest("/channel-patch", "GET"),
  ["page.channel_patch"]
);
assert.deepStrictEqual(
  registry.getRequiredPermissionsForRequest("/api/channel-patch", "POST"),
  ["page.channel_patch"]
);

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
assert.ok(
  /\/api\/channel-patch[\s\S]{0,180}requirePermission\("page\.channel_patch"\)/.test(
    serverSrc
  ),
  "channel-patch API is permission-gated, not global-admin-only"
);
assert.ok(
  /\/channel-patch", requirePermission\("page\.channel_patch"\)/.test(serverSrc),
  "channel-patch page is permission-gated, not global-admin-only"
);

const agencyAccess = { isGlobalAdmin: false, isAgencyAdmin: true };
const globalAccess = { isGlobalAdmin: true };
const allowed = new Set(["hcso ops", "hcso tac"]);

const patches = [
  { id: "1", name: "Agency only", groups: ["tak_HCSO Ops", "tak_HCSO Tac"] },
  { id: "2", name: "Mixed", groups: ["tak_HCSO Ops", "tak_County Law"] },
  { id: "3", name: "Out of scope", groups: ["tak_County Law", "tak_State"] },
  { id: "4", name: "Empty", groups: [] },
];

const visible = access.filterPatchesForAccess(agencyAccess, patches, allowed);
assert.deepStrictEqual(
  visible.map((p) => p.id),
  ["1"],
  "agency admins only see patches fully inside their allowlist"
);

const all = access.filterPatchesForAccess(globalAccess, patches, allowed);
assert.strictEqual(all.length, patches.length, "global admins see every patch");

assert.deepStrictEqual(
  access.filterPatchesForAccess(agencyAccess, patches, new Set()).map((p) => p.id),
  [],
  "empty allowlist hides every patch"
);

assert.doesNotThrow(() =>
  access.assertGroupsInScope(agencyAccess, ["tak_HCSO Ops", "HCSO Tac"], allowed)
);
assert.throws(
  () => access.assertGroupsInScope(agencyAccess, ["tak_HCSO Ops", "County Law"], allowed),
  (err) => err && err.status === 403
);
assert.doesNotThrow(() =>
  access.assertGroupsInScope(globalAccess, ["County Law", "State"], allowed)
);

const keys = access.patchGroupKeys({
  groups: ["tak_HCSO Ops_READ", "HCSO Tac"],
});
assert.ok(keys.has("hcso ops"));
assert.ok(keys.has("hcso tac"));

const picker = access.allowedKeySetFromPicker({
  allowedChannelKeys: ["hcso ops", "hcso tac"],
});
assert.ok(picker instanceof Set);
assert.ok(picker.has("hcso ops"));
assert.strictEqual(access.allowedKeySetFromPicker({ allowedChannelKeys: null }), null);

const annotated = store.annotateGroupsWithPatchPeers(
  [{ name: "tak_HCSO Ops" }, { name: "tak_County Law" }],
  [{ enabled: true, groups: ["tak_HCSO Ops", "tak_HCSO Tac"] }]
);
assert.deepStrictEqual(annotated[0].patchedWith, ["HCSO Tac"]);
assert.strictEqual(annotated[1].patchedWith, undefined);

console.log("channelPatch.access.test.js: ok");
