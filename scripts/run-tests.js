#!/usr/bin/env node
/**
 * Run unit tests in a fixed order; exit non-zero on first failure.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const TEST_FILES = [
  "mapIcon.test.js",
  "mapIconRender.test.js",
  "mapMeta.test.js",
  "mapBasemaps.test.js",
  "mapRender.test.js",
  "mapUidHash.test.js",
  "labelDeclutter.test.js",
  "featureBuild.test.js",
  "cotStreamSlim.test.js",
  "mapPerfSoak.test.js",
  "missionGeo.test.js",
  "missionKml.test.js",
  "missionContents.test.js",
  "missionRaster.test.js",
  "dataSyncAccess.test.js",
  "geocode.test.js",
  "openaddresses.test.js",
  "preferencePackage.service.test.js",
  "enrollmentPackage.service.test.js",
  "takGroupControl.test.js",
  "geofence.test.js",
  "userRequestsOtherAgency.test.js",
  "migrationGate.test.js",
  "jsonImport.retire.test.js",
  "directorySearch.sql.test.js",
  "outbox.skipLocked.test.js",
  "directorySync.deadLetter.test.js",
  "directorySync.inboundAbort.test.js",
  "health.migration.test.js",
  "mouStore.ensure.test.js",
  "directoryPkText.test.js",
  "takDashboardCache.test.js",
];

const testsDir = path.join(__dirname, "..", "tests");

for (const file of TEST_FILES) {
  const testPath = path.join(testsDir, file);
  const result = spawnSync(process.execPath, [testPath], {
    stdio: "inherit",
    cwd: path.join(__dirname, ".."),
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

console.log("All tests passed.");
