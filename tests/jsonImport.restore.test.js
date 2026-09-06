"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  parseMigratedFileName,
  pickLatestBackup,
  inspectLegacySourcesIn,
  restoreLatestBackupsIn,
} = require("../services/jsonImport.files");

const importFiles = [
  { name: "agencies.json", rel: "agencies.json" },
  { name: "mou-index.json", rel: path.join("mou", "index.json") },
];

assert.deepStrictEqual(
  parseMigratedFileName("agencies.json.2026-09-06T12-00-00-000Z.json", importFiles),
  {
    fileName: "agencies.json",
    stamp: "2026-09-06T12-00-00-000Z",
    diskName: "agencies.json.2026-09-06T12-00-00-000Z.json",
  }
);
assert.strictEqual(parseMigratedFileName("agencies.json", importFiles), null);
assert.strictEqual(parseMigratedFileName("notes.txt", importFiles), null);

const latest = pickLatestBackup([
  { stamp: "2026-09-01T00-00-00-000Z", diskName: "old" },
  { stamp: "2026-09-06T12-00-00-000Z", diskName: "new" },
  { stamp: "2026-09-05T08-00-00-000Z", diskName: "mid" },
]);
assert.strictEqual(latest.diskName, "new");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tak-json-restore-"));
const dataDir = path.join(tmp, "data");
const migratedDir = path.join(dataDir, "migrated");
fs.mkdirSync(path.join(dataDir, "mou"), { recursive: true });
fs.mkdirSync(migratedDir, { recursive: true });

fs.writeFileSync(path.join(dataDir, "agencies.json"), JSON.stringify([{ id: "live" }]));
fs.writeFileSync(
  path.join(migratedDir, "agencies.json.2026-09-01T00-00-00-000Z.json"),
  JSON.stringify([{ id: "old-backup" }])
);
fs.writeFileSync(
  path.join(migratedDir, "agencies.json.2026-09-06T12-00-00-000Z.json"),
  JSON.stringify([{ id: "latest-backup" }])
);
fs.writeFileSync(
  path.join(migratedDir, "mou-index.json.2026-09-06T12-00-00-000Z.json"),
  JSON.stringify({ streams: [{ mouId: "m1" }] })
);

const inspected = inspectLegacySourcesIn(dataDir, migratedDir, importFiles);
const agencies = inspected.find((f) => f.name === "agencies.json");
const mou = inspected.find((f) => f.name === "mou-index.json");
assert.ok(agencies.originalPresent);
assert.ok(agencies.originalBytes > 0);
assert.strictEqual(agencies.backupCount, 2);
assert.strictEqual(agencies.latestBackup, "agencies.json.2026-09-06T12-00-00-000Z.json");
assert.strictEqual(mou.originalPresent, false);
assert.strictEqual(mou.latestBackup, "mou-index.json.2026-09-06T12-00-00-000Z.json");

const first = restoreLatestBackupsIn(dataDir, migratedDir, importFiles);
assert.strictEqual(first.find((r) => r.name === "agencies.json").action, "kept_original");
assert.strictEqual(first.find((r) => r.name === "agencies.json").usable, true);
assert.strictEqual(first.find((r) => r.name === "mou-index.json").action, "restored");
assert.strictEqual(first.find((r) => r.name === "mou-index.json").usable, true);
assert.strictEqual(
  JSON.parse(fs.readFileSync(path.join(dataDir, "agencies.json"), "utf8"))[0].id,
  "live"
);
assert.strictEqual(
  JSON.parse(fs.readFileSync(path.join(dataDir, "mou", "index.json"), "utf8")).streams[0].mouId,
  "m1"
);

fs.writeFileSync(path.join(dataDir, "agencies.json"), "");
const second = restoreLatestBackupsIn(dataDir, migratedDir, importFiles);
assert.strictEqual(second.find((r) => r.name === "agencies.json").action, "replaced_empty");
assert.strictEqual(
  JSON.parse(fs.readFileSync(path.join(dataDir, "agencies.json"), "utf8"))[0].id,
  "latest-backup"
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("jsonImport.restore.test.js: ok");
