const assert = require("assert");
const mapMeta = require("../services/mapMeta.service");

assert.deepStrictEqual(mapMeta.resolveGroupsForMarker({ uid: "ab" }), [mapMeta.UNASSIGNED_GROUP]);

const shortUid = mapMeta.resolveGroupsForMarker({ uid: "ab", groups: [] });
assert.deepStrictEqual(shortUid, [mapMeta.UNASSIGNED_GROUP]);

// Flow-tag UUID forms: TAK-Server-<32hex> must match hyphenated Marti connection ids.
const keys = mapMeta.connectionUidLookupKeys(
  "TAK-Server-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
);
assert.ok(keys.includes("tak-server-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
assert.ok(keys.includes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
assert.ok(keys.includes("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"));
assert.ok(keys.includes("tak-server-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"));

mapMeta.rebuildConnectionGroupIndex([]);
mapMeta.registerConnectionGroups(
  ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
  ["tak_Channel Alpha"]
);

assert.deepStrictEqual(
  mapMeta.lookupConnectionGroups("TAK-Server-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
  ["tak_Channel Alpha"]
);

assert.deepStrictEqual(
  mapMeta.resolveGroupsFromFlowTags({
    flowTagUids: [
      "TAK-Server-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "TAK-Server-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ],
  }),
  ["tak_Channel Alpha"]
);

assert.strictEqual(mapMeta.channelBaseKey(mapMeta.UNASSIGNED_GROUP), mapMeta.UNASSIGNED_CHANNEL_KEY);
assert.strictEqual(mapMeta.channelBaseKey("__unassigned__"), mapMeta.UNASSIGNED_CHANNEL_KEY);

const catalog = mapMeta.buildGroupsCatalogWithCounts([
  {
    uid: "fed-1",
    callsign: "FED-EUD-1",
    groups: [mapMeta.UNASSIGNED_GROUP],
  },
]);
const unassignedEntry = catalog.find((g) => g.baseKey === mapMeta.UNASSIGNED_CHANNEL_KEY);
assert.ok(unassignedEntry, "Unassigned should appear in channel catalog when markers exist");
assert.strictEqual(unassignedEntry.markerCount, 1);

assert.strictEqual(
  mapMeta.classifyMarkerOrigin({
    type: "a-f-G-U-C",
    flowTagUids: [
      "TAK-Server-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "TAK-Server-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ],
  }),
  "federation"
);

// Multi-hop flow with no hop match: use federation subscription groups.
mapMeta.rebuildConnectionGroupIndex([
  {
    username: "aa:bb:cc:dd:ee:ff:11:22:33:44:55:66",
    uid: "fed-conn-1",
    groups: [{ name: "tak_Channel Bravo", direction: "IN", active: true }],
  },
]);
assert.deepStrictEqual(
  mapMeta.resolveGroupsFromFlowTags({
    flowTagUids: [
      "TAK-Server-cccccccccccccccccccccccccccccccc",
      "TAK-Server-dddddddddddddddddddddddddddddddd",
    ],
  }),
  ["tak_Channel Bravo"]
);

const federatedMarker = mapMeta.resolveGroupsForMarker(
  {
    uid: "11111111-2222-3333-4444-555555555555",
    callsign: "FED-EUD-1",
    type: "a-f-G-U-C",
    flowTagUids: [
      "TAK-Server-cccccccccccccccccccccccccccccccc",
      "TAK-Server-dddddddddddddddddddddddddddddddd",
    ],
  },
  {
    "_flow-tags_": {
      _attributes: {
        "TAK-Server-cccccccccccccccccccccccccccccccc": "2026-01-01T00:00:00Z",
        "TAK-Server-dddddddddddddddddddddddddddddddd": "2026-01-01T00:00:01Z",
      },
    },
  }
);
assert.deepStrictEqual(federatedMarker, ["tak_Channel Bravo"]);

// Marti LDAP DN group names (cn=...) must resolve like bare tak_* names.
mapMeta.rebuildConnectionGroupIndex([
  {
    username: "11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00",
    callsign: "FedHub",
    protocol: "FIGFed_FedHub_c5283deb7284410cb9d1104b19789d17",
    uid: null,
    groups: [
      { name: "cn=tak_Channel Charlie", direction: "IN", active: true },
      { name: "cn=tak_Channel Charlie", direction: "OUT", active: true },
    ],
  },
]);
assert.deepStrictEqual(mapMeta.getFederationSubscriptionGroups(), ["tak_Channel Charlie"]);
assert.deepStrictEqual(
  mapMeta.resolveGroupsFromFlowTags({
    flowTagUids: [
      "TAK-Server-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      "TAK-Server-ffffffffffffffffffffffffffffffff",
    ],
  }),
  ["tak_Channel Charlie"]
);

assert.strictEqual(
  mapMeta.sanitizeCallsign("TN\uFFFC\uFFFCHumphsheriff\uFFFC-102\uFFFCi"),
  "TN Humphsheriff -102 i"
);
assert.strictEqual(mapMeta.sanitizeCallsign("  ALPHA\u200B-1  "), "ALPHA-1");
assert.strictEqual(mapMeta.sanitizeCallsign(""), "");

console.log("mapMeta.test.js OK");
