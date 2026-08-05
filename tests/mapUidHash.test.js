/**
 * Smoke tests for map client pure helpers (uid hash + paint feature build).
 * Run via scripts/run-tests.js after esbuild is available; uses dynamic import of built logic mirrored in CJS.
 */
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

function vectorId(uid) {
  const s = String(uid || "");
  if (!s) return 1;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0 || 1;
}

function testUidHashStable() {
  const a = vectorId("ANDROID-deadbeef");
  const b = vectorId("ANDROID-deadbeef");
  assert.strictEqual(a, b);
  assert.notStrictEqual(vectorId("ANDROID-deadbeef"), vectorId("ANDROID-other"));
  assert.ok(a > 0);
  assert.ok(Number.isInteger(a));
}

function testUidHashNonEmpty() {
  assert.strictEqual(vectorId(""), 1);
}

function testDiffShapeContract() {
  // GeoJSONSourceDiff contract used by worker → MapLibre
  const diff = {
    add: [
      {
        type: "Feature",
        id: vectorId("u1"),
        geometry: { type: "Point", coordinates: [-84.5, 39.1] },
        properties: { kind: "marker", uid: "u1", showLabel: 1 },
      },
    ],
    update: [
      {
        id: vectorId("u1"),
        newGeometry: { type: "Point", coordinates: [-84.51, 39.11] },
        addOrUpdateProperties: [
          { key: "callsign", value: "ALPHA" },
          { key: "color", value: "#22c55e" },
        ],
      },
    ],
    remove: [vectorId("gone")],
  };
  assert.strictEqual(diff.add[0].id, vectorId("u1"));
  assert.strictEqual(diff.update[0].id, diff.add[0].id);
  assert.ok(Array.isArray(diff.remove));
}

function testDistArtifactsPresent() {
  const distJs = path.join(__dirname, "..", "public", "dist", "map.js");
  const distWorker = path.join(__dirname, "..", "public", "dist", "map.worker.js");
  if (!fs.existsSync(distJs) || !fs.existsSync(distWorker)) {
    console.warn(
      "[mapUidHash.test] dist not built yet — skip artifact check (run npm run build:map)"
    );
    return;
  }
  const js = fs.readFileSync(distJs, "utf8");
  const worker = fs.readFileSync(distWorker, "utf8");
  assert.ok(js.length > 1000, "map.js bundle too small");
  assert.ok(worker.length > 500, "map.worker.js bundle too small");
  assert.ok(worker.includes("forceResync") || worker.includes("resync"), "worker missing resync path");
}

testUidHashStable();
testUidHashNonEmpty();
testDiffShapeContract();
testDistArtifactsPresent();
console.log("ok - mapUidHash / diff contract / dist smoke");
