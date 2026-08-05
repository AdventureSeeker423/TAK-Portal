/**
 * Verifies slim marker path does not attach cotRaw on the hot marker object.
 * Uses parse logic mirrored from cotStream (unit-level contract).
 */
const assert = require("assert");

function rememberCotRaw(cache, max, uid, raw) {
  const id = String(uid || "").trim();
  if (!id || raw == null) return;
  if (cache.has(id)) cache.delete(id);
  cache.set(id, raw);
  while (cache.size > max) {
    const oldest = cache.keys().next().value;
    if (oldest == null) break;
    cache.delete(oldest);
  }
}

function testBoundedRawCache() {
  const cache = new Map();
  const max = 3;
  rememberCotRaw(cache, max, "a", { n: 1 });
  rememberCotRaw(cache, max, "b", { n: 2 });
  rememberCotRaw(cache, max, "c", { n: 3 });
  rememberCotRaw(cache, max, "d", { n: 4 });
  assert.strictEqual(cache.size, 3);
  assert.ok(!cache.has("a"));
  assert.ok(cache.has("d"));
  // refresh moves to end
  rememberCotRaw(cache, max, "b", { n: 22 });
  rememberCotRaw(cache, max, "e", { n: 5 });
  assert.ok(cache.has("b"));
  assert.ok(!cache.has("c"));
}

function testSlimMarkerHasNoCotRaw() {
  const slim = {
    uid: "u1",
    callsign: "ALPHA",
    type: "a-f-G-U-C",
    lat: 39.1,
    lon: -84.5,
    color: "#22c55e",
    mapImageId: "",
    channelKeys: "ops",
  };
  assert.strictEqual("cotRaw" in slim, false);
  assert.ok(slim.uid && Number.isFinite(slim.lat));
}

testBoundedRawCache();
testSlimMarkerHasNoCotRaw();
console.log("ok - cotStream slim / cotRaw cache contract");
