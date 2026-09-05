"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const catalog = require("../services/backup/catalog");
const crypto = require("../services/backup/crypto");
const jobs = require("../services/backup/jobs");
const { validateManifest } = require("../services/backup/import");

const cat = catalog.publicCatalog();
assert.strictEqual(cat.manifestVersion, 1);
assert.ok(cat.categories.some((c) => c.id === "users"));
assert.ok(cat.categories.some((c) => c.id === "settings.authentik"));
assert.ok(cat.categories.some((c) => c.id === "locate_pings"));
assert.ok(!cat.categories.some((c) => c.id === "map_icons"));

const users = catalog.getCategory("users");
assert.deepStrictEqual(users.deps.slice().sort(), ["agencies", "groups"].sort());

const resolved = catalog.resolveDependencies(["users"]);
assert.ok(resolved.selected.includes("users"));
assert.ok(resolved.selected.includes("groups"));
assert.ok(resolved.selected.includes("agencies"));
assert.ok(resolved.selected.includes("regions"));
assert.ok(resolved.autoAdded.includes("groups"));

const missing = catalog.resolveDependencies(["users"], { allowMissing: true });
assert.ok(missing.selected.includes("users"));
assert.ok(!missing.selected.includes("groups"));

assert.deepStrictEqual(catalog.unknownCategoryIds(["users", "nope"]), ["nope"]);
assert.deepStrictEqual(catalog.unknownCategoryIds(["settings"]), []);

const redacted = catalog.redactSettings(
  { AUTHENTIK_TOKEN: "secret", AUTHENTIK_URL: "http://ak", SMTP_PASS: "p" },
  false
);
assert.strictEqual(redacted.AUTHENTIK_TOKEN, "");
assert.strictEqual(redacted.SMTP_PASS, "");
assert.strictEqual(redacted.AUTHENTIK_URL, "http://ak");

const kept = catalog.redactSettings({ AUTHENTIK_TOKEN: "secret" }, true);
assert.strictEqual(kept.AUTHENTIK_TOKEN, "secret");

assert.strictEqual(catalog.naturalKey("users", { username: "AbC" }), "abc");
assert.strictEqual(
  catalog.naturalKey("templates", { agency_suffix: "pd", name: "Patrol" }),
  "pd::patrol"
);
assert.strictEqual(catalog.naturalKey("agencies", { suffix: "FD" }), "fd");

const plain = Buffer.from("hello-backup-payload");
const enc = crypto.encryptBuffer(plain, "correct horse");
assert.ok(crypto.isEncryptedBackup(enc));
assert.ok(!crypto.isEncryptedBackup(plain));
assert.strictEqual(crypto.decryptBuffer(enc, "correct horse").toString("utf8"), "hello-backup-payload");
assert.throws(() => crypto.decryptBuffer(enc, "wrong"), /Invalid passphrase|corrupt/);
assert.throws(() => crypto.encryptBuffer(plain, ""), /Passphrase is required/);

validateManifest({ version: 1, categories: ["users"] });
assert.throws(() => validateManifest({ version: 99 }), /Unsupported backup version/);
assert.throws(() => validateManifest(null), /missing/);

const redactedOpts = jobs.redactOptions({ passphrase: "hunter2", categories: ["users"] });
assert.strictEqual(redactedOpts.passphrase, "***");
assert.deepStrictEqual(redactedOpts.categories, ["users"]);

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
assert.ok(
  /\/api\/settings\/backup[\s\S]{0,180}requirePermission\("page\.settings"\)/.test(serverSrc),
  "backup routes must be mounted with page.settings"
);
assert.ok(!/\/settings\/export-data/.test(serverSrc), "legacy export-data stub should be gone");

const registry = require("../services/permissions.registry");
assert.deepStrictEqual(
  registry.getRequiredPermissionsForRequest("/api/settings/backup/catalog", "GET"),
  ["page.settings"]
);
assert.deepStrictEqual(
  registry.getRequiredPermissionsForRequest("/api/settings/backup/export", "POST"),
  ["page.settings"]
);

console.log("backup.test.js: ok");
