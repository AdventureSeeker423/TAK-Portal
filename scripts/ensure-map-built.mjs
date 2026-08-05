/**
 * prestart helper: use existing public/dist when present (Docker image build),
 * otherwise run build:map. Avoids requiring esbuild in production runtime.
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

const required = [
  path.join(root, "public", "dist", "map.js"),
  path.join(root, "public", "dist", "map.worker.js"),
  path.join(root, "public", "vendor", "maplibre-gl", "maplibre-gl.js"),
  path.join(root, "public", "vendor", "maplibre-gl", "maplibre-gl.css"),
];

function distReady() {
  return required.every((p) => fs.existsSync(p) && fs.statSync(p).size > 0);
}

if (distReady()) {
  console.log("[ensure-map-built] public/dist + vendor maplibre present — skip rebuild");
  process.exit(0);
}

let hasEsbuild = false;
try {
  require.resolve("esbuild");
  hasEsbuild = true;
} catch (_) {
  hasEsbuild = false;
}

if (!hasEsbuild) {
  console.error(
    "[ensure-map-built] Map bundle missing and esbuild is not installed.\n" +
      "  Docker: rebuild the image (Dockerfile runs npm run build:map before prune).\n" +
      "  Local:  npm install && npm run build:map"
  );
  process.exit(1);
}

console.log("[ensure-map-built] building map client…");
const result = spawnSync(
  process.execPath,
  [path.join(root, "scripts", "generate-map-app.mjs")],
  { stdio: "inherit", cwd: root }
);
if (result.status !== 0) process.exit(result.status || 1);

const build = spawnSync(
  process.execPath,
  [path.join(root, "scripts", "build-map.mjs")],
  { stdio: "inherit", cwd: root }
);
if (build.status !== 0) process.exit(build.status || 1);

if (!distReady()) {
  console.error("[ensure-map-built] build finished but dist artifacts are still missing");
  process.exit(1);
}
