const assert = require("assert");
const mapMeta = require("../services/mapMeta.service");

assert.deepStrictEqual(mapMeta.resolveGroupsForMarker({ uid: "ab" }), [mapMeta.UNASSIGNED_GROUP]);

const shortUid = mapMeta.resolveGroupsForMarker({ uid: "ab", groups: [] });
assert.deepStrictEqual(shortUid, [mapMeta.UNASSIGNED_GROUP]);

console.log("mapMeta.test.js OK");
