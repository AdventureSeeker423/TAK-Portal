const assert = require("assert");
const {
  isRemoteActionsSubscription,
  isPreferenceConfigSubscription,
  findCollapsedGroupForMission,
  isMissionGroupChannelActive,
  REMOTE_ACTIONS_TAK_CLIENTS,
  PREFERENCE_CONFIG_TAK_CLIENTS,
} = require("../services/takGroupControl.service");

assert.strictEqual(REMOTE_ACTIONS_TAK_CLIENTS.has("ATAK-CIV"), true);
assert.strictEqual(REMOTE_ACTIONS_TAK_CLIENTS.has("ITAK"), true);

assert.strictEqual(isRemoteActionsSubscription({ takClient: "ATAK-CIV" }), true);
assert.strictEqual(isRemoteActionsSubscription({ takClient: "iTAK" }), true);
assert.strictEqual(isRemoteActionsSubscription({ platform: "ATAK-CIV" }), true);
assert.strictEqual(isRemoteActionsSubscription({ takClient: "ATAK-GOV" }), false);
assert.strictEqual(isRemoteActionsSubscription({ takClient: "TAKAware-CIV" }), false);

assert.strictEqual(PREFERENCE_CONFIG_TAK_CLIENTS.has("ATAK-CIV"), true);
assert.strictEqual(PREFERENCE_CONFIG_TAK_CLIENTS.has("ITAK"), false);
assert.strictEqual(isPreferenceConfigSubscription({ takClient: "ATAK-CIV" }), true);
assert.strictEqual(isPreferenceConfigSubscription({ takClient: "iTAK" }), false);

const collapsed = [
  { name: "TAK_FOO Bar", accessMode: "BOTH", active: true, inActive: true, outActive: true },
  { name: "TAK_BAZ Qux", accessMode: "READ", active: false },
];

assert.deepStrictEqual(
  findCollapsedGroupForMission(collapsed, "tak_foo bar"),
  collapsed[0]
);
assert.strictEqual(findCollapsedGroupForMission(collapsed, "missing"), null);
assert.strictEqual(isMissionGroupChannelActive(collapsed[0]), true);
assert.strictEqual(isMissionGroupChannelActive(collapsed[1]), false);
assert.strictEqual(isMissionGroupChannelActive(null), false);

console.log("takGroupControl.test.js OK");
