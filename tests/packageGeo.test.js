const assert = require("assert");
const packageGeo = require("../services/packageGeo.service");
const packageKind = require("../services/packageKind.service");

const activePkg = {
  hash: "abc",
  filename: "layers.zip",
  keywords: ["missionpackage"],
  tool: "public",
  size: 5 * 1024 * 1024,
};
assert.strictEqual(packageKind.isDataPackageRecord(activePkg), true);
assert.strictEqual(packageGeo.isMapVisibleDataPackage(activePkg), true);
assert.strictEqual(packageGeo.isArchivedDataPackage(activePkg), false);

const archivedPkg = {
  hash: "def",
  filename: "old-layers.zip",
  keywords: ["ARCHIVED_MISSION"],
  tool: "public",
  size: 2 * 1024 * 1024,
};
assert.strictEqual(packageGeo.isMapVisibleDataPackage(archivedPkg), true);
assert.strictEqual(packageGeo.isArchivedDataPackage(archivedPkg), true);

const dataSyncRow = {
  hash: "ghi",
  filename: "Incident Alpha",
  keywords: ["datasync", "ARCHIVED_MISSION"],
  size: 1024,
  groups: "Alpha",
};
assert.strictEqual(packageKind.isDataSyncRecord(dataSyncRow), true);
assert.strictEqual(packageGeo.isMapVisibleDataPackage(dataSyncRow), false);

const noKeyword = {
  hash: "jkl",
  filename: "mystery.zip",
  keywords: [],
  tool: "public",
  size: 3 * 1024 * 1024,
};
assert.strictEqual(packageGeo.isMapVisibleDataPackage(noKeyword), false);

console.log("packageGeo.test.js: all assertions passed");
