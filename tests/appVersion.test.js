"use strict";

const assert = require("assert");
const {
  stripVersionPrefix,
  isNewerVersion,
  runningVersion,
  isUpdateAvailable,
} = require("../services/appVersion.service");

assert.strictEqual(stripVersionPrefix("v2.0.2"), "2.0.2");
assert.strictEqual(isNewerVersion("2.0.2", "2.0.2"), false);
assert.strictEqual(isNewerVersion("2.0.3", "2.0.2"), true);
assert.strictEqual(isNewerVersion("2.0.2", "2.0.3"), false);

assert.strictEqual(runningVersion({ version: "2.0.2" }), "2.0.2");
assert.strictEqual(
  runningVersion({ version: "2.0.2", "beta-version": "2.0.3" }),
  "2.0.3"
);
assert.strictEqual(
  runningVersion({ version: "2.0.3", "beta-version": "2.0.3" }),
  "2.0.3"
);

assert.strictEqual(
  isUpdateAvailable("v2.0.2", { version: "2.0.2", "beta-version": "2.0.3" }),
  false,
  "stable GitHub latest must not flag an update when beta is already newer"
);
assert.strictEqual(
  isUpdateAvailable("2.0.2", { version: "2.0.1" }),
  true
);
assert.strictEqual(
  isUpdateAvailable("2.0.4", { version: "2.0.2", "beta-version": "2.0.3" }),
  true,
  "pill only when installed beta is behind a newer stable"
);
assert.strictEqual(
  isUpdateAvailable("2.0.4-beta", { version: "2.0.2", "beta-version": "2.0.3" }),
  false,
  "never flag a newer beta tag"
);
assert.strictEqual(
  isUpdateAvailable("v2.0.4-rc.1", { version: "2.0.2" }),
  false
);

console.log("appVersion.test.js: ok");
