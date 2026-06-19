#!/usr/bin/env node
/**
 * One-time / offline vendor of CloudTAK-Data iconsets into assets/map-icons/.
 * Run: npm run vendor:icons  (uses --use-system-ca for GitHub TLS)
 * @see https://github.com/dfpc-coe/CloudTAK-Data
 */
const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const axios = require("axios");
const unzipper = require("unzipper");

const CLOUDTAK_TAG = "v1.1.0";
const CLOUDTAK_RAW = `https://raw.githubusercontent.com/dfpc-coe/CloudTAK-Data/${CLOUDTAK_TAG}`;

const ICONSET_ARCHIVES = [
  "Public Safety Air.zip",
  "Responder Icons.zip",
  "FEMA Icons.zip",
  "Incident Management Icons.zip",
  "FalconView.zip",
  "Generic Icons.zip",
  "GeoOps.zip",
  "Google.zip",
  "OSM.zip",
  "Default.zip",
];

const ROOT = path.join(__dirname, "..", "assets", "map-icons");

async function sha256File(filePath) {
  const buf = await fsp.readFile(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function extractZip(buf, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  await new Promise((resolve, reject) => {
    const stream = unzipper.Parse();
    stream.on("entry", (entry) => {
      const name = entry.path.replace(/\\/g, "/");
      const outPath = path.join(destDir, name);
      if (entry.type === "Directory") {
        entry.autodrain();
        return;
      }
      const dir = path.dirname(outPath);
      fs.mkdirSync(dir, { recursive: true });
      entry.pipe(fs.createWriteStream(outPath));
    });
    stream.on("close", resolve);
    stream.on("error", reject);
    stream.end(buf);
  });
}

async function main() {
  await fsp.mkdir(ROOT, { recursive: true });

  const iconsets = [];
  for (const zipName of ICONSET_ARCHIVES) {
    const dirName = zipName.replace(/\.zip$/i, "");
    const destDir = path.join(ROOT, dirName);
    const xmlPath = path.join(destDir, "iconset.xml");

    console.log(`Fetching ${zipName}...`);
    const url = `${CLOUDTAK_RAW}/iconsets/${encodeURIComponent(zipName)}`;
    const resp = await axios.get(url, { responseType: "arraybuffer", timeout: 180000 });

    if (fs.existsSync(destDir)) {
      await fsp.rm(destDir, { recursive: true, force: true });
    }
    await extractZip(Buffer.from(resp.data), destDir);

    if (!fs.existsSync(xmlPath)) {
      throw new Error(`Missing iconset.xml after extract: ${dirName}`);
    }

    const xmlHash = await sha256File(xmlPath);
    const xml = await fsp.readFile(xmlPath, "utf8");
    const uidMatch = xml.match(/uid="([^"]+)"/i);
    const nameMatch = xml.match(/name="([^"]+)"/i);

    iconsets.push({
      dirName,
      zipName,
      uid: uidMatch ? uidMatch[1] : null,
      name: nameMatch ? nameMatch[1] : dirName,
      iconsetXmlSha256: xmlHash,
    });
    console.log(`  OK ${dirName} (${uidMatch ? uidMatch[1] : "?"})`);
  }

  const manifest = {
    source: "https://github.com/dfpc-coe/CloudTAK-Data",
    tag: CLOUDTAK_TAG,
    vendoredAt: new Date().toISOString(),
    iconsets,
  };

  await fsp.writeFile(
    path.join(ROOT, "MANIFEST.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8"
  );

  const attribution = `# Map Iconsets

These iconsets are vendored from [CloudTAK-Data](https://github.com/dfpc-coe/CloudTAK-Data) tag **${CLOUDTAK_TAG}**.

They are bundled in TAK-Portal for stable offline map symbology. Do not edit manually.
To refresh, run \`node scripts/vendor-cloudtak-icons.js\` and commit the result intentionally.

Source: dfpc-coe/CloudTAK-Data (${CLOUDTAK_TAG})
`;

  await fsp.writeFile(path.join(ROOT, "ATTRIBUTION.md"), attribution, "utf8");
  console.log(`\nDone. ${iconsets.length} iconsets in ${ROOT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
