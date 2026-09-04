const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { retireFile } = require("../services/jsonImport.service");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tak-json-import-"));
const src = path.join(tmp, "agencies.json");
fs.writeFileSync(src, JSON.stringify([{ name: "Test" }]));

const migratedDir = path.join(__dirname, "..", "data", "migrated");
const before = fs.existsSync(migratedDir)
  ? new Set(fs.readdirSync(migratedDir))
  : new Set();

retireFile(src, "agencies.json");
assert.strictEqual(fs.existsSync(src), false);

assert.ok(fs.existsSync(migratedDir), "migrated dir should exist after retire");
const after = fs.readdirSync(migratedDir);
const created = after.filter((n) => !before.has(n) && n.startsWith("agencies.json."));
assert.strictEqual(created.length, 1);
assert.ok(/agencies\.json\.\d{4}-.*\.json$/.test(created[0]));

fs.unlinkSync(path.join(migratedDir, created[0]));
try {
  fs.rmdirSync(tmp);
} catch (_) {}

console.log("jsonImport.retire.test.js: ok");
