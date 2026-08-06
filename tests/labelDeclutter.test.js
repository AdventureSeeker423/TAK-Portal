/**
 * Label visibility: at city zoom all in-view markers request labels;
 * MapLibre collision hides the rest.
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

async function main() {
  const { computeLabelVisibility, computeLabelSortKey } = await loadDeclutter();

  const cluster = [];
  for (let i = 0; i < 16; i++) {
    cluster.push(
      marker("u" + i, "H" + (200 + i), -85.25 + i * 0.0002, 35.05, "feed")
    );
  }

  const at13 = computeLabelVisibility(cluster, { zoom: 13 });
  assert.strictEqual(at13.size, 16);
  at13.forEach((v) => assert.strictEqual(v, 1));

  const overview = computeLabelVisibility(cluster, { zoom: 5, selectedUid: "u3" });
  assert.strictEqual(overview.get("u3"), 1);
  assert.strictEqual(overview.get("u0"), 0);

  const spi = marker("spi1", "ACC2", -85.25, 35.05, "feed", "b-m-p-s-p-i");
  assert.ok(computeLabelSortKey(spi) < computeLabelSortKey(cluster[0]));
  assert.strictEqual(computeLabelSortKey(cluster[0], "u0"), 0);

  console.log("labelDeclutter.test.js ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
