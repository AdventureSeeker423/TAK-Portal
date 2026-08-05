/**
 * Build the TypeScript map client → public/dist/
 * Also vendors MapLibre GL into public/vendor/maplibre-gl/
 */
import * as esbuild from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "public", "dist");
const vendorDir = path.join(root, "public", "vendor", "maplibre-gl");
const watch = process.argv.includes("--watch");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function vendorMapLibre() {
  const pkgRoot = path.join(root, "node_modules", "maplibre-gl");
  const dist = path.join(pkgRoot, "dist");
  if (!fs.existsSync(dist)) {
    console.warn("[build-map] maplibre-gl not installed; skip vendor copy");
    return;
  }
  ensureDir(vendorDir);
  const cssSrc = path.join(dist, "maplibre-gl.css");
  if (fs.existsSync(cssSrc)) {
    fs.copyFileSync(cssSrc, path.join(vendorDir, "maplibre-gl.css"));
  }
  const outJs = path.join(vendorDir, "maplibre-gl.js");
  const umdJs = path.join(dist, "maplibre-gl.js");
  if (fs.existsSync(umdJs)) {
    fs.copyFileSync(umdJs, outJs);
  } else {
    // MapLibre 6+ ships ESM-only (.mjs); bundle to IIFE for <script src> + maplibregl global.
    const esmJs = path.join(dist, "maplibre-gl.mjs");
    if (!fs.existsSync(esmJs)) {
      console.warn("[build-map] no maplibre-gl.js/.mjs to vendor");
      return;
    }
    await esbuild.build({
      absWorkingDir: root,
      entryPoints: [esmJs],
      outfile: outJs,
      bundle: true,
      format: "iife",
      globalName: "maplibregl",
      platform: "browser",
      target: ["es2022"],
      logLevel: "info",
      footer: {
        js: "maplibregl = maplibregl.default || maplibregl;",
      },
    });
  }
  console.log("[build-map] vendored maplibre-gl -> public/vendor/maplibre-gl/");
}

ensureDir(distDir);
await vendorMapLibre();

/** Copy shared non-TS assets that overlays still need at runtime via same-origin URLs */
function copyPublicHelpers() {
  // shapeDecorFilter stays in public/ for server require(); client bundles its own copy.
}

const shared = {
  absWorkingDir: root,
  bundle: true,
  format: "iife",
  target: ["es2022"],
  sourcemap: true,
  logLevel: "info",
  define: {
    "process.env.NODE_ENV": watch ? '"development"' : '"production"',
  },
};

const mainOptions = {
  ...shared,
  entryPoints: [path.join(root, "client/map/main.ts")],
  outfile: path.join(distDir, "map.js"),
  platform: "browser",
  globalName: "TakPortalMap",
};

const workerOptions = {
  ...shared,
  entryPoints: [path.join(root, "client/map/worker/cotStore.worker.ts")],
  outfile: path.join(distDir, "map.worker.js"),
  platform: "browser",
  format: "iife",
};

copyPublicHelpers();

if (watch) {
  const ctxMain = await esbuild.context(mainOptions);
  const ctxWorker = await esbuild.context(workerOptions);
  await Promise.all([ctxMain.watch(), ctxWorker.watch()]);
  console.log("[build-map] watching client/map …");
} else {
  await Promise.all([esbuild.build(mainOptions), esbuild.build(workerOptions)]);
  console.log("[build-map] wrote public/dist/map.js + map.worker.js");
}
