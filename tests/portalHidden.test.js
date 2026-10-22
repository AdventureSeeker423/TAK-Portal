const assert = require("assert");

const portalHidden = require("../services/portalHidden.util");
const { extractUserColumns, extractGroupColumns } = require("../services/userAttributes.util");

assert.strictEqual(portalHidden.ATTR_KEY, "tak_portal_hidden");

assert.deepStrictEqual(
  portalHidden.markHiddenAttributes({ role: "Team Member" }),
  { role: "Team Member", tak_portal_hidden: "true" }
);

assert.strictEqual(extractUserColumns({ tak_portal_hidden: "true" }).tak_portal_hidden, true);
assert.strictEqual(extractUserColumns({}).tak_portal_hidden, false);
assert.strictEqual(extractGroupColumns({ tak_portal_hidden: "yes" }).tak_portal_hidden, true);
assert.strictEqual(extractGroupColumns({ private: "yes" }).tak_portal_hidden, false);

assert.strictEqual(
  portalHidden.isUserHidden({ username: "normal.user", attributes: {} }),
  false
);
// Builtin ak- prefix must hide Authentik outpost service accounts even with no attr/column
// (after HIDDEN_PREFIX_ATTR_MIGRATION clears USERS_HIDDEN_PREFIXES).
assert.strictEqual(
  portalHidden.isUserHidden({
    username: "ak-outpost-26c4e320065142f1978bd298748ef09c",
    tak_portal_hidden: false,
    attributes: {},
  }),
  true
);
assert.strictEqual(
  portalHidden.isUserHidden({
    username: "nodered-global-x",
    tak_portal_hidden: true,
    attributes: { tak_portal_hidden: "true" },
  }),
  true
);
assert.ok(
  portalHidden.hiddenUserPrefixes().includes("ak-"),
  "builtin ak- prefix always present after settings cleared"
);
assert.strictEqual(
  portalHidden.isUserHidden(
    { username: "nodered-global-x", tak_portal_hidden: true },
    { includeHidden: true }
  ),
  false
);

assert.strictEqual(
  portalHidden.isGroupHidden({ name: "tak_SO Main", attributes: {} }),
  false
);
assert.strictEqual(
  portalHidden.isGroupHidden({
    name: "MA - Drill",
    tak_portal_hidden: true,
    attributes: { tak_portal_hidden: "true" },
  }),
  true
);
assert.strictEqual(
  portalHidden.isGroupHidden(
    {
      name: "MA - Drill",
      tak_portal_hidden: true,
      attributes: { tak_portal_hidden: "true" },
    },
    { includeMutualAid: true }
  ),
  false
);

assert.ok(portalHidden.isMutualAidGroupName("MA - Drill"));
assert.ok(portalHidden.isMutualAidGroupName("tak_MA - Drill"));
assert.ok(!portalHidden.isMutualAidGroupName("SO Main"));

assert.ok(portalHidden.isInternalPortalGroupName("authentik-SHPD-AgencyAdmin"));
assert.ok(portalHidden.isInternalPortalGroupName("tak_authentik-FOO-AgencyAdmin"));
assert.ok(
  portalHidden.isGroupHidden({ name: "authentik-SHPD-AgencyAdmin", attributes: {} }),
  "AgencyAdmin must be hidden even without tak_portal_hidden attr"
);
assert.ok(!portalHidden.isInternalPortalGroupName("SO Main"));

// AgencyAdmin create paths must stamp tak_portal_hidden after prefix migration clears.
const fs = require("fs");
const path = require("path");
for (const rel of [
  "routes/agencies.routes.js",
  "services/agencyAbbrevRename.service.js",
  "services/agencyNameRename.service.js",
]) {
  const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  assert.ok(
    src.includes("markHiddenAttributes") && src.includes("ensureAgencyAdminGroupExists"),
    `${rel} must stamp AgencyAdmin groups with markHiddenAttributes`
  );
}

const usersEjs = fs.readFileSync(
  path.join(__dirname, "..", "views", "users.ejs"),
  "utf8"
);
assert.ok(
  usersEjs.includes("shouldOmitFromGroupChips") &&
    usersEjs.includes("groupIndex.get(key)") &&
    usersEjs.includes("visibleGroupIds.has"),
  "edit-modal chips must use picker-visible groupIndex names only"
);

console.log("portalHidden.test.js: ok");
