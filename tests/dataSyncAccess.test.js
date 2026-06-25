const assert = require("assert");
const {
  resolveMutualAidAllowedGroups,
  filterMissionsForAccess,
  canonicalGroupKey,
} = require("../services/dataSyncAccess.service");

const maRecords = [
  {
    id: "ma-1",
    groupId: "uuid-ma-disaster",
    groupName: "MA - Disaster Response",
    username: "ma-disaster",
  },
  {
    id: "ma-2",
    groupId: "uuid-ma-linked",
    groupName: "HCSO Shared Channel",
    username: "ma-event",
  },
];

const allowed = resolveMutualAidAllowedGroups(
  ["tak_MA - Disaster Response", "authentik-HCSO-AgencyAdmin"],
  maRecords
);
assert.strictEqual(allowed.length, 1);
assert.strictEqual(allowed[0].canonicalKey, canonicalGroupKey("MA - Disaster Response"));
assert.strictEqual(allowed[0].mutualAid, true);

const allowedById = resolveMutualAidAllowedGroups(["uuid-ma-linked"], maRecords);
assert.strictEqual(allowedById.length, 1);
assert.strictEqual(allowedById[0].takDisplayName, "HCSO Shared Channel");

const allowedKeySet = new Set([
  canonicalGroupKey("HCSO Main"),
  canonicalGroupKey("MA - Disaster Response"),
]);
const missions = [
  { name: "Agency Mission", groups: ["HCSO Main"] },
  { name: "MA Mission", groups: ["MA - Disaster Response"] },
  { name: "Other Mission", groups: ["Other Group"] },
];
const visible = filterMissionsForAccess(missions, allowedKeySet);
assert.deepStrictEqual(
  visible.map((m) => m.name),
  ["Agency Mission", "MA Mission"]
);

console.log("dataSyncAccess.test.js: ok");
