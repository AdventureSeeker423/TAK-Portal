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

assert.strictEqual(marketplace.normalizeInstallScript("install.sh --no-build"), "./install.sh --no-build");
assert.strictEqual(marketplace.normalizeInstallScript("./setup.sh"), "./setup.sh");

const qpd = normalized.plugins.find((p) => p.id === "quick-point-dropper");
assert.ok(qpd && qpd.web && qpd.web.dest === "quick-point-dropper");
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

const print = normalized.plugins.find((p) => p.id === "print");
assert.ok(print.additionalActions.some((a) => /caddy/i.test(JSON.stringify(a))));
assert.ok(print.additionalActions.some((a) => a.snippet && /print-api/.test(a.snippet)));
assert.ok(!print.additionalActions.some((a) => /Deploy the print plugin Docker/i.test(JSON.stringify(a))));
const printScript = marketplace.installRemoteScript("/root/CloudTAK", print);
assert.match(printScript, /Starting plugin Docker service/);
assert.match(printScript, /cloudtak-marketplace-plugins/);
assert.match(printScript, /Cleaning plugin runtime/);
assert.match(printScript, /docker rmi/);
assert.match(printScript, /docker image prune -f/);

const uninstallPrint = marketplace.uninstallRemoteScript("/root/CloudTAK", "print", [], "print");
assert.match(uninstallPrint, /Cleaning plugin runtime/);
assert.match(uninstallPrint, /docker rmi/);
assert.match(uninstallPrint, /docker image prune -f/);
assert.match(uninstallPrint, /cloudtak-marketplace-plugins/);
assert.match(uninstallPrint, /\.cache\/cloudtak-marketplace/);
assert.doesNotMatch(uninstallPrint, /docker compose -f "\$CF" -f "\$OVERRIDE" stop \)/);

const udash = normalized.plugins.find((p) => p.id === "udash");
assert.ok(udash.additionalActions.some((a) => /webhook sidecar/i.test(JSON.stringify(a))));
assert.ok(!udash.additionalActions.some((a) => /does not start/i.test(JSON.stringify(a))));
const udashScript = marketplace.installRemoteScript("/root/CloudTAK", udash);
assert.match(udashScript, /plugin node sidecar/);

assert.deepStrictEqual(
  marketplace.normalizeAdditionalActions({
    sidecars: [{ note: "Add Caddy /example" }],
  }).map((a) => a.text),
  ["Add Caddy /example"]
);
assert.deepStrictEqual(
  marketplace.normalizeAdditionalActions({
    sidecars: [{ note: "Marketplace does not start that sidecar." }],
  }),
  []
);

const bundled = store.readBundledCatalog();
assert.ok(Array.isArray(bundled.plugins) && bundled.plugins.length >= 10);

const os = require("os");
const lightning = normalized.plugins.find((p) => p.id === "lightning");
assert.ok(lightning);
assert.ok(lightning.csp && lightning.csp["connect-src"].some((s) => /blitzortung/.test(s)));
assert.ok(!lightning.additionalActions.some((a) => /nginx/i.test(JSON.stringify(a))));
const installScript = marketplace.installRemoteScript("/root/CloudTAK", lightning);
assert.match(installScript, /Normalizing flat plugin into lib/);
assert.match(installScript, /index\.ts imports \.\/lib\//);
assert.match(installScript, /rm -rf "\$target\/\.git"/);
assert.match(installScript, /NGINX_CSP_/);
assert.match(installScript, /docker-compose.marketplace.yml/);
assert.match(installScript, /Updating CloudTAK CSP overlay/);

const livewx = normalized.plugins.find((p) => p.id === "livewx");
assert.ok(livewx);
assert.ok(livewx.csp && livewx.csp["img-src"].includes("https://mesonet.agron.iastate.edu"));
assert.ok(livewx.csp["connect-src"].includes("https://api.weather.gov"));
assert.ok(!livewx.additionalActions.some((a) => /nginx/i.test(JSON.stringify(a))));
const livewxScript = marketplace.installRemoteScript("/root/CloudTAK", livewx);
assert.match(livewxScript, /mesonet\.agron\.iastate\.edu/);
assert.match(livewxScript, /apply_plugin_csp/);

assert.deepStrictEqual(
  marketplace.normalizeCsp({ csp: ["wss://*.example.org", "https://tiles.example.com"] }),
  {
    "connect-src": ["wss://*.example.org", "https://tiles.example.com"],
    "img-src": ["https://tiles.example.com"],
  }
);
assert.deepStrictEqual(
  marketplace.normalizeCsp({
    csp: { connect: "https://api.example.com", img: ["https://cdn.example.com"] },
  })["connect-src"],
  ["https://api.example.com"]
);
assert.ok(
  marketplace.normalizeCsp({
    additionalActions: [{ kind: "nginx-csp", snippet: "wss://*.blitzortung.org" }],
  })["connect-src"].includes("wss://*.blitzortung.org")
);
assert.deepStrictEqual(
  marketplace.normalizeCsp({
    additionalActions: [{ kind: "caddy", snippet: "handle_path /print-api* {\n\treverse_proxy cloudtak-print:5010\n}" }],
  }),
  {}
);

assert.match(uninstallPrint, /apply_plugin_csp/);
assert.match(uninstallPrint, /docker-compose.marketplace.yml/);

function writeFlatPluginFixture(dir, opts) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "index.ts"),
    opts.entrySource || "import x from './lib/foo.ts';\nexport default class P {}\n"
  );
  fs.writeFileSync(path.join(dir, "foo.ts"), "export const x = 1;\n");
  fs.writeFileSync(path.join(dir, "MenuTemplate.vue"), "<template></template>\n");
  fs.writeFileSync(path.join(dir, "icon.svg"), "<svg></svg>\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# plugin\n");
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "config"), "dummy\n");
}

const flatDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctak-flat-"));
writeFlatPluginFixture(flatDir, {});
const flatResult = marketplace.normalizeFlatSamplePluginTree(flatDir);
assert.strictEqual(flatResult.ok, true);
assert.strictEqual(flatResult.changed, true);
assert.ok(fs.existsSync(path.join(flatDir, "index.ts")), "index.ts stays at dest root");
assert.ok(fs.existsSync(path.join(flatDir, "lib", "foo.ts")));
assert.ok(fs.existsSync(path.join(flatDir, "lib", "MenuTemplate.vue")));
assert.ok(fs.existsSync(path.join(flatDir, "lib", "icon.svg")));
assert.ok(fs.existsSync(path.join(flatDir, "README.md")), "README stays at dest root");
assert.ok(!fs.existsSync(path.join(flatDir, "foo.ts")));
assert.ok(!fs.existsSync(path.join(flatDir, ".git")));
fs.rmSync(flatDir, { recursive: true, force: true });

const libExistsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctak-lib-"));
writeFlatPluginFixture(libExistsDir, {});
fs.mkdirSync(path.join(libExistsDir, "lib"), { recursive: true });
fs.writeFileSync(path.join(libExistsDir, "lib", "already.ts"), "export {}\n");
const libExistsResult = marketplace.normalizeFlatSamplePluginTree(libExistsDir);
assert.strictEqual(libExistsResult.reason, "lib-exists");
assert.ok(fs.existsSync(path.join(libExistsDir, "foo.ts")), "do not nest when lib/ already exists");
assert.ok(!fs.existsSync(path.join(libExistsDir, ".git")), "still strip .git");
fs.rmSync(libExistsDir, { recursive: true, force: true });

const noLibImportDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctak-nolib-"));
writeFlatPluginFixture(noLibImportDir, {
  entrySource: "import Menu from './MenuTemplate.vue';\nexport default class P {}\n",
});
const noLibResult = marketplace.normalizeFlatSamplePluginTree(noLibImportDir);
assert.strictEqual(noLibResult.changed, false);
assert.ok(fs.existsSync(path.join(noLibImportDir, "foo.ts")), "do not nest without ./lib/ imports");
assert.ok(!fs.existsSync(path.join(noLibImportDir, "lib")));
fs.rmSync(noLibImportDir, { recursive: true, force: true });

assert.ok(marketplace.pluginEntryImportsLib("import x from './lib/foo.ts'"));
assert.ok(!marketplace.pluginEntryImportsLib("import x from './foo.ts'"));

const ssh = require("../services/cloudtakMarketplace.ssh");
assert.strictEqual(typeof ssh.onboardWithPassword, "function");
assert.strictEqual(typeof ssh.ensureCloudtakSshKeyPair, "function");

async function assertOnboardValidation() {
  await assert.rejects(
    () => ssh.onboardWithPassword({ host: "", username: "cloudtak", password: "x" }),
    /host is required/i
  );
  await assert.rejects(
    () => ssh.onboardWithPassword({ host: "10.0.0.1", username: "cloudtak", password: "" }),
    /password is required/i
  );
}

assertOnboardValidation()
  .then(() => {
    console.log("cloudtakMarketplace tests passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
