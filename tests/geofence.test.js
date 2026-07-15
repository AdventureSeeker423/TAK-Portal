const assert = require("assert");

const {
  pointInGeometry,
  validateGeometry,
  fenceToGeoJsonFeature,
  haversineMeters,
} = require("../services/geofence.geometry");
const { computeTransitions } = require("../services/geofence.engine");

// --- geometry ---

const circle = { type: "circle", center: [-85.3, 35.05], radiusMeters: 1000 };
assert.strictEqual(pointInGeometry(-85.3, 35.05, circle), true, "center inside circle");
assert.strictEqual(
  pointInGeometry(-85.3, 35.08, circle),
  false,
  "point ~3km north outside 1km circle"
);

const rect = {
  type: "rectangle",
  sw: [-85.31, 35.04],
  ne: [-85.29, 35.06],
};
assert.strictEqual(pointInGeometry(-85.3, 35.05, rect), true, "inside rect");
assert.strictEqual(pointInGeometry(-85.32, 35.05, rect), false, "outside rect");

const poly = {
  type: "polygon",
  coordinates: [
    [-85.31, 35.04],
    [-85.29, 35.04],
    [-85.3, 35.06],
  ],
};
assert.strictEqual(pointInGeometry(-85.3, 35.045, poly), true, "inside triangle");
assert.strictEqual(pointInGeometry(-85.32, 35.05, poly), false, "outside triangle");

const bad = validateGeometry({ type: "circle", center: [-85, 35], radiusMeters: -1 });
assert.strictEqual(bad.ok, false);

const okCircle = validateGeometry({
  type: "circle",
  center: [-85.3, 35.05],
  radiusMeters: 50,
});
assert.strictEqual(okCircle.ok, true);
assert.strictEqual(okCircle.geometry.type, "circle");

const feat = fenceToGeoJsonFeature({
  id: "f1",
  name: "Test",
  active: true,
  geometry: okCircle.geometry,
});
assert.strictEqual(feat.type, "Feature");
assert.strictEqual(feat.geometry.type, "Polygon");
assert.ok(feat.geometry.coordinates[0].length > 4);

const d = haversineMeters(-85.3, 35.05, -85.3, 35.05);
assert.ok(d < 0.01);

// --- transitions ---

{
  const t = computeTransitions({
    fenceId: "f1",
    active: true,
    wasActive: true,
    insideClientUids: ["a"],
    previousInsideUids: [],
  });
  assert.deepStrictEqual(t.enters, ["a"], "come online already inside → enter");
  assert.deepStrictEqual(t.exits, []);
}

{
  const t = computeTransitions({
    fenceId: "f1",
    active: true,
    wasActive: false,
    insideClientUids: ["a", "b"],
    previousInsideUids: ["a"],
  });
  assert.deepStrictEqual(t.enters.sort(), ["a", "b"], "activate → enter all currently inside");
}

{
  const t = computeTransitions({
    fenceId: "f1",
    active: true,
    wasActive: true,
    insideClientUids: [],
    previousInsideUids: ["a"],
  });
  assert.deepStrictEqual(t.exits, ["a"], "walk out → exit");
  assert.deepStrictEqual(t.enters, []);
}

{
  const t = computeTransitions({
    fenceId: "f1",
    active: false,
    wasActive: true,
    insideClientUids: ["a"],
    previousInsideUids: ["a"],
  });
  assert.deepStrictEqual(t.drops, ["a"], "deactivate drops membership");
  assert.deepStrictEqual(t.enters, []);
  assert.deepStrictEqual(t.exits, []);
}

// --- store round-trip in a temp dir via file path override is heavy;
// exercise normalize helpers through create/update with isolated paths by
// writing to the real data paths only if data/ is writable; use store API
// carefully: createFence will write under project data/. Prefer unit of
// channel/mission apply gating via stubbed logic below.

const takGroupControl = require("../services/takGroupControl.service");
const engine = require("../services/geofence.engine");

async function testActionApply() {
  const calls = { channels: [], missions: [] };
  const origSet = takGroupControl.setClientGroupActive;
  const origInvite = takGroupControl.sendClientDataSyncInvite;
  const origGroups = takGroupControl.getClientGroupControlState;

  takGroupControl.getClientGroupControlState = async () => ({
    groups: [
      { name: "FOO", accessMode: "BOTH", active: false },
      { name: "BAR", accessMode: "READ", active: true },
    ],
  });
  takGroupControl.setClientGroupActive = async (clientUid, authUser, opts) => {
    calls.channels.push({ clientUid, ...opts });
    return { ok: true };
  };
  takGroupControl.sendClientDataSyncInvite = async (clientUid, authUser, opts) => {
    calls.missions.push({ clientUid, ...opts });
    return { ok: true };
  };

  try {
    const fence = {
      id: "t1",
      owner: { isGlobalAdmin: true },
      actions: {
        channels: [
          { groupName: "tak_FOO", accessMode: "BOTH", enterAction: "enable", exitAction: "disable" },
          { groupName: "tak_BAR", accessMode: "READ", enterAction: "", exitAction: "enable" },
        ],
        missions: [{ missionName: "Mission A" }],
      },
    };

    await engine.applyChannelActions("uid1", fence.owner, fence.actions.channels, "enter");
    assert.strictEqual(calls.channels.length, 1);
    assert.strictEqual(calls.channels[0].groupName, "FOO", "resolves tak_ catalog name to Marti CN");
    assert.strictEqual(calls.channels[0].active, true);

    calls.channels = [];
    await engine.applyChannelActions("uid1", fence.owner, fence.actions.channels, "exit");
    assert.strictEqual(calls.channels.length, 2);
    assert.strictEqual(calls.channels[0].groupName, "FOO");
    assert.strictEqual(calls.channels[0].active, false, "FOO disable on exit");
    assert.strictEqual(calls.channels[1].groupName, "BAR");
    assert.strictEqual(calls.channels[1].active, true, "BAR enable on exit");

    await engine.applyMissionEnter("uid1", fence.owner, fence.actions.missions);
    assert.strictEqual(calls.missions.length, 1);
    assert.strictEqual(calls.missions[0].missionName, "Mission A");

    calls.missions = [];
    await engine.handleExit(fence, "uid1");
    assert.strictEqual(calls.missions.length, 0, "exit never sends Data Sync invite");
  } finally {
    takGroupControl.setClientGroupActive = origSet;
    takGroupControl.sendClientDataSyncInvite = origInvite;
    takGroupControl.getClientGroupControlState = origGroups;
  }
}

testActionApply()
  .then(() => {
    console.log("geofence.test.js OK");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
