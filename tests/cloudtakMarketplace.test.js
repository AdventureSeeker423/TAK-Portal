"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const marketplace = require("../services/cloudtakMarketplace.service");
const store = require("../services/cloudtakMarketplace.store");

const catalogPath = path.join(__dirname, "..", "catalog", "cloudtak-plugins.json");
const raw = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const normalized = marketplace.normalizeCatalog(raw);

assert.strictEqual(normalized.version, 1);
assert.ok(normalized.plugins.length >= 10, "seed catalog should include example plugins");

for (const p of normalized.plugins) {
  assert.ok(p.id, "plugin id");
  assert.ok(p.name, "plugin name");
  assert.ok(p.repo, "plugin repo");
  assert.ok(p.web && p.web.dest, "plugin web.dest");
}

const ids = normalized.plugins.map((p) => p.id);
assert.ok(ids.includes("quick-point-dropper"));
assert.ok(ids.includes("helloworld"));
assert.ok(ids.includes("dispatcher"));
assert.ok(ids.includes("lightning"));

const gh = marketplace.parseGitHubRepo(
  "https://github.com/AdventureSeeker423/cloudtak-plugin-quick-point-dropper.git"
);
assert.deepStrictEqual(gh, {
  owner: "AdventureSeeker423",
  repo: "cloudtak-plugin-quick-point-dropper",
});

const qpd = normalized.plugins.find((p) => p.id === "quick-point-dropper");
assert.ok(qpd && /install\.sh/.test(qpd.installScript || ""), "QPD should use install.sh");
const matchDest = marketplace.matchCatalogPlugin({ dest: "quick-point-dropper" }, normalized.plugins);
assert.strictEqual(matchDest && matchDest.id, "quick-point-dropper");

const matchRepoFolder = marketplace.matchCatalogPlugin(
  { dest: "cloudtak-plugin-quick-point-dropper" },
  normalized.plugins
);
assert.strictEqual(matchRepoFolder && matchRepoFolder.id, "quick-point-dropper");

const matchSpaced = marketplace.matchCatalogPlugin({ dest: "Quick Point Dropper" }, normalized.plugins);
assert.strictEqual(matchSpaced && matchSpaced.id, "quick-point-dropper");

const matchAlias = marketplace.matchCatalogPlugin({ dest: "ping" }, normalized.plugins);
assert.strictEqual(matchAlias && matchAlias.id, "cellphone");

const matchRepo = marketplace.matchCatalogPlugin(
  { dest: "unexpected", gitRemote: qpd.repo },
  normalized.plugins
);
assert.strictEqual(matchRepo && matchRepo.id, "quick-point-dropper");

const unknown = marketplace.matchCatalogPlugin({ dest: "totally-unknown" }, normalized.plugins);
assert.strictEqual(unknown, null);

assert.ok(marketplace.isHostPluginNoise("example.ts"));
assert.ok(marketplace.isHostPluginNoise("README.md"));
assert.ok(marketplace.isHostPluginNoise("readme.md"));
assert.ok(!marketplace.isHostPluginNoise("quick-point-dropper"));

const bundled = store.readBundledCatalog();
assert.ok(Array.isArray(bundled.plugins) && bundled.plugins.length >= 10);

console.log("cloudtakMarketplace tests passed");
