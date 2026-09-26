const assert = require("assert");
const {
  buildMissionWriteQuery,
  toMissionSearchParams,
  defaultRoleQueryValue,
} = require("../services/dataSync.service");
const {
  extractMissionGroupNames,
  missionSingleGroupName,
  filterMissionsForAccess,
  canonicalGroupKey,
} = require("../services/dataSyncAccess.service");

assert.strictEqual(defaultRoleQueryValue("MISSION_SUBSCRIBER"), "MISSION_SUBSCRIBER");
assert.strictEqual(
  defaultRoleQueryValue({ type: "MISSION_SUBSCRIBER", permissions: ["MISSION_WRITE"] }),
  "MISSION_SUBSCRIBER"
);
assert.strictEqual(defaultRoleQueryValue(null), "");

const query = buildMissionWriteQuery({
  name: "Incident Alpha",
  tool: "public",
  description: "Field test",
  defaultRole: { type: "MISSION_SUBSCRIBER", permissions: ["MISSION_WRITE", "MISSION_READ"] },
  groups: ["HCSO Ops"],
  keywords: [],
  inviteOnly: false,
});
assert.strictEqual(query.creatorUid, "takportal");
assert.strictEqual(query.tool, "public");
assert.strictEqual(query.defaultRole, "MISSION_SUBSCRIBER");
assert.strictEqual(query.inviteOnly, false);
assert.deepStrictEqual(query.group, ["HCSO Ops"]);
assert.strictEqual(query.allowGroupChange, true);
assert.strictEqual(query.description, "Field test");

const params = toMissionSearchParams(query);
assert.strictEqual(params.get("group"), "HCSO Ops");
assert.strictEqual(params.get("defaultRole"), "MISSION_SUBSCRIBER");
assert.strictEqual(params.get("creatorUid"), "takportal");
assert.strictEqual(params.get("inviteOnly"), "false");
assert.strictEqual(params.getAll("group").length, 1);

const anonDefault = buildMissionWriteQuery({});
assert.ok(!anonDefault.group, "omit group query param rather than sending empty");
assert.strictEqual(anonDefault.creatorUid, "takportal");

const duplicateGroups = extractMissionGroupNames({
  groups: [
    { name: "HCSO Ops", direction: "IN" },
    { name: "tak_HCSO Ops", direction: "OUT" },
  ],
});
assert.deepStrictEqual(duplicateGroups, ["HCSO Ops"]);
assert.strictEqual(
  missionSingleGroupName({ groups: ["HCSO Ops", "tak_HCSO Ops"] }),
  "HCSO Ops"
);
assert.strictEqual(missionSingleGroupName({ groups: "HCSO Ops" }), "HCSO Ops");
assert.strictEqual(missionSingleGroupName({ groups: ["HCSO Ops", "HCSO Tac"] }), null);

const allowedKeySet = new Set([canonicalGroupKey("HCSO Ops")]);
const visible = filterMissionsForAccess(
  [
    { name: "Single", groups: ["HCSO Ops"] },
    { name: "Dedupe", groups: ["HCSO Ops", "tak_HCSO Ops"] },
    { name: "Multi", groups: ["HCSO Ops", "HCSO Tac"] },
  ],
  allowedKeySet
);
assert.deepStrictEqual(
  visible.map((m) => m.name),
  ["Single", "Dedupe"]
);

const bothKeys = new Set([
  canonicalGroupKey("HCSO Ops"),
  canonicalGroupKey("HCSO Tac"),
]);
const visibleMulti = filterMissionsForAccess(
  [
    { name: "Single", groups: ["HCSO Ops"] },
    { name: "Multi", groups: ["HCSO Ops", "HCSO Tac"] },
    { name: "Empty", groups: [] },
  ],
  bothKeys
);
assert.deepStrictEqual(
  visibleMulti.map((m) => m.name),
  ["Single", "Multi"]
);

const visibleAll = filterMissionsForAccess(
  [
    { name: "Multi", groups: ["HCSO Ops", "HCSO Tac"] },
    { name: "Empty", groups: [] },
  ],
  null
);
assert.deepStrictEqual(
  visibleAll.map((m) => m.name),
  ["Multi"]
);

console.log("dataSync.missionWrite.test.js: ok");
