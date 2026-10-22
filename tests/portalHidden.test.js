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
assert.strictEqual(
  portalHidden.isUserHidden({
    username: "nodered-global-x",
    tak_portal_hidden: true,
    attributes: { tak_portal_hidden: "true" },
  }),
  true
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

console.log("portalHidden.test.js: ok");
