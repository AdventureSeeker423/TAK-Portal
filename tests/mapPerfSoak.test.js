/**
 * Synthetic soak: build paint features + GeoJSONSourceDiff-style updates for N markers.
 * Guards against O(n²) regressions in the worker feature path.
 */
const assert = require("assert");

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

function buildPaintFeature(marker) {
  return {
    type: "Feature",
    id: vectorId(marker.uid),
    geometry: { type: "Point", coordinates: [marker.lon, marker.lat] },
    properties: {
      kind: "marker",
      uid: marker.uid,
      callsign: marker.callsign,
      color: marker.color || "#38bdf8",
      iconId: "",
      showCircle: 1,
      drawTier: 1,
      selected: false,
      locked: false,
      showLabel: 0,
      channelKeys: marker.channelKeys || "ops",
    },
  };
}

function soak(count) {
  const markers = [];
  for (let i = 0; i < count; i++) {
    markers.push({
      uid: "soak-" + i,
      callsign: "UNIT-" + i,
      lat: 39 + (i % 100) * 0.001,
      lon: -84.5 + (i % 100) * 0.001,
      color: "#22c55e",
      channelKeys: "ops",
    });
  }
  const t0 = Date.now();
  const features = markers.map(buildPaintFeature);
  const t1 = Date.now();
  const diff = {
    add: features.slice(0, Math.min(200, count)),
    update: features.slice(0, Math.min(800, count)).map(function (f) {
      return {
        id: f.id,
        newGeometry: {
          type: "Point",
          coordinates: [f.geometry.coordinates[0] + 0.0001, f.geometry.coordinates[1]],
        },
        addOrUpdateProperties: [
          { key: "callsign", value: f.properties.callsign },
          { key: "color", value: f.properties.color },
        ],
      };
    }),
    remove: [],
  };
  const t2 = Date.now();
  assert.strictEqual(features.length, count);
  assert.ok(diff.update.length > 0);
  return { buildMs: t1 - t0, diffMs: t2 - t1, count };
}

for (const n of [1000, 3000, 5000]) {
  const r = soak(n);
  // Generous CI bound — catches catastrophic regressions, not machine variance.
  assert.ok(
    r.buildMs < 2000,
    "build " + n + " features took " + r.buildMs + "ms (limit 2000)"
  );
  assert.ok(
    r.diffMs < 2000,
    "diff " + n + " took " + r.diffMs + "ms (limit 2000)"
  );
  console.log("ok - soak", n, "buildMs=" + r.buildMs, "diffMs=" + r.diffMs);
}
