const assert = require("assert");
const engine = require("../services/channelPatch.engine");
const store = require("../services/channelPatch.store");

assert.strictEqual(
  engine.toMartiGroupName("tak_CPD Main"),
  "CPD Main",
  "strips Authentik tak_ prefix for Marti dest"
);
assert.strictEqual(engine.toMartiGroupName("DAVIS Main"), "DAVIS Main");

const patch = {
  id: "p1",
  groups: ["tak_CPD Main", "tak_DAVIS Main", "tak_SPD Main"],
  enabled: true,
};

assert.deepStrictEqual(
  engine.destinationsForSource(patch, "cpd main").sort(),
  ["tak_DAVIS Main", "tak_SPD Main"].sort(),
  "source fans out to every other channel"
);
assert.deepStrictEqual(
  engine.destinationsForSource(patch, "davis main").sort(),
  ["tak_CPD Main", "tak_SPD Main"].sort(),
  "mesh is bidirectional"
);
assert.deepStrictEqual(
  engine.destinationsForSource(patch, "mutual aid"),
  [],
  "unrelated channel does not match patch"
);

// Legacy hub/spokes migrate to flat groups
const migrated = store.normalizePatch({
  id: "legacy-1",
  name: "Law Family Patch",
  enabled: true,
  hubGroup: "tak_CPD Main",
  spokes: [{ group: "tak_DAVIS Main", direction: "both" }],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
assert.ok(migrated);
assert.deepStrictEqual(
  migrated.groups.sort(),
  ["tak_CPD Main", "tak_DAVIS Main"].sort()
);
assert.strictEqual(migrated.hubGroup, undefined);
assert.strictEqual(migrated.spokes, undefined);

assert.strictEqual(
  store.normalizePatch({
    id: "bad",
    groups: ["tak_Only One"],
  }),
  null,
  "requires at least two channels"
);

assert.strictEqual(
  engine.patchedUid("ANDROID-abc", "tak_CPD Main", "HCSO-DAVIS-3598"),
  "HCSO-DAVIS-3598.takportal.cpd-main"
);

// Patched copies must keep callsign on <contact> (ATAK shows "NO CALLSIGN" otherwise)
// while dropping endpoint so the copy is not a routable ClientEndpoint advertise.
const detailWithEndpoint = {
  contact: {
    _attributes: {
      callsign: "HCSO-DAVIS-3598",
      endpoint: "192.168.1.10:4242:tcp",
    },
  },
  takv: { _attributes: { platform: "ATAK" } },
  __group: { _attributes: { name: "Cyan" } },
  remarks: { _text: "keep me" },
};
assert.strictEqual(
  engine.neutralizeAsInjectedCopy(detailWithEndpoint),
  "HCSO-DAVIS-3598"
);
assert.deepStrictEqual(detailWithEndpoint.contact, {
  _attributes: { callsign: "HCSO-DAVIS-3598" },
});
assert.strictEqual(detailWithEndpoint.takv, undefined);
assert.strictEqual(detailWithEndpoint.__group, undefined);
assert.deepStrictEqual(detailWithEndpoint.remarks, { _text: "keep me" });

assert.strictEqual(
  engine.neutralizeAsInjectedCopy({}, "MARKER-CS"),
  "MARKER-CS",
  "falls back to marker callsign when contact is missing"
);

console.log("channelPatch.engine.test.js OK");
