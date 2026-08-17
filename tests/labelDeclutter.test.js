/**
 * Label declutter: hide colliding callsigns at every zoom, not just overview.
 */
const assert = require("assert");
const path = require("path");
const esbuild = require("esbuild");

async function loadDeclutter() {
  const entry = path.join(__dirname, "..", "client", "map", "labelDeclutter.ts");
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    target: "node18",
  });
  const code = result.outputFiles[0].text;
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  Function("module", "exports", "require", code)(mod, mod.exports, require);
  return mod.exports;
}

function marker(uid, callsign, lon, lat, origin, type) {
  return {
    uid,
    callsign,
    lon,
    lat,
    origin: origin || "feed",
    type: type || "a-f-G-U-C",
  };
}

function countShown(map) {
  let shown = 0;
  map.forEach((v) => {
    if (v === 1) shown += 1;
  });
  return shown;
}

async function main() {
  const { computeLabelVisibility, computeLabelSortKey } = await loadDeclutter();

  const loose = [];
  for (let i = 0; i < 10; i++) {
    loose.push(marker("u" + i, "H" + (200 + i), -85.25 + i * 0.01, 35.05, "feed"));
  }
  const at14 = computeLabelVisibility(loose, { zoom: 14 });
  at14.forEach((v) => assert.strictEqual(v, 1));

  const tight = [];
  for (let i = 0; i < 12; i++) {
    tight.push(
      marker(
        "t" + i,
        "H" + (200 + i) + " - Disorder Prevention",
        -85.25 + (i % 3) * 0.0002,
        35.05 + Math.floor(i / 3) * 0.0002,
        "feed"
      )
    );
  }

  const at14tight = computeLabelVisibility(tight, { zoom: 14 });
  const shown14 = countShown(at14tight);
  assert.ok(shown14 >= 1, "expected at least one label at z14, got " + shown14);
  assert.ok(shown14 < tight.length, "cluster at z14 should hide colliding labels, got " + shown14);

  const at11 = computeLabelVisibility(tight, { zoom: 11 });
  const shown11 = countShown(at11);
  assert.ok(shown11 >= 1, "expected at least one label at z11, got " + shown11);
  assert.ok(shown11 < tight.length, "cluster at z11 should hide colliding labels, got " + shown11);

  const at8 = computeLabelVisibility(tight, { zoom: 8 });
  const shown8 = countShown(at8);
  assert.ok(shown8 >= 1, "expected some labels at z8, got " + shown8);
  assert.ok(shown8 <= tight.length, "label count in range");

  const overview = computeLabelVisibility(loose, { zoom: 5, selectedUid: "u3" });
  assert.strictEqual(overview.get("u3"), 1);
  assert.strictEqual(overview.get("u0"), 0);

  const selectedInCluster = computeLabelVisibility(tight, {
    zoom: 14,
    selectedUid: "t11",
  });
  assert.strictEqual(selectedInCluster.get("t11"), 1);

  const spi = marker("spi1", "ACC2", -85.25, 35.05, "feed", "b-m-p-s-p-i");
  assert.ok(computeLabelSortKey(spi) < computeLabelSortKey(loose[0]));

  console.log("labelDeclutter.test.js ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
