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
assert.ok(ids.includes("livewx"));
assert.ok(!ids.includes("lightning"));

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

const caddy = require("../services/cloudtakMarketplace.caddy");
const caddyFile = [
  "{",
  "\temail admin@example.com",
  "}",
  "",
  "auth.example.com {",
  "\treverse_proxy authentik:9000",
  "}",
  "",
  "cloud.example.com {",
  "\tencode gzip",
  "\treverse_proxy cloudtak-api:5000",
  "}",
  "",
].join("\n");

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
assert.match(uninstallPrint, /api\/web\/src\/plugins/);
assert.doesNotMatch(uninstallPrint, /docker compose -f "\$CF" -f "\$OVERRIDE" stop \)/);

const unknownUninstall = marketplace.uninstallRemoteScript("/root/CloudTAK", "host-only-plugin", [], "");
assert.match(unknownUninstall, /if \[ -z "\$ID" \]; then ID="\$DEST"; fi/);
assert.match(unknownUninstall, /api\/web\/plugins\/\$DEST/);
assert.match(unknownUninstall, /api\/web\/src\/plugins\/\$DEST/);
assert.match(unknownUninstall, /plugin-host-only-plugin\.ts/);
assert.match(unknownUninstall, /cleanup_plugin_runtime/);

const udash = normalized.plugins.find((p) => p.id === "udash");
const udashSnippet = udash.additionalActions.find((a) => caddy.isCaddyAction(a)).snippet;
const printSnippet = print.additionalActions.find((a) => caddy.isCaddyAction(a)).snippet;
const withUdash = caddy.applyCaddySnippets(caddyFile, [udashSnippet]);
assert.strictEqual(withUdash.ok, true);
assert.match(withUdash.text, /cloud\.example\.com \{[\s\S]*handle_path \/udash-api\*[\s\S]*reverse_proxy cloudtak-api:5000/);
assert.doesNotMatch(withUdash.text.split("cloud.example.com")[0], /udash/);
assert.strictEqual(caddy.applyCaddySnippets(withUdash.text, [udashSnippet]).changed, false);
const withPrint = caddy.applyCaddySnippets(caddyFile, [printSnippet]);
assert.strictEqual(withPrint.ok, true);
assert.match(withPrint.text, /^\(cloudtak_print\) \{/m);
assert.match(withPrint.text, /cloud\.example\.com \{[\s\S]*import cloudtak_print[\s\S]*reverse_proxy cloudtak-api:5000/);
assert.doesNotMatch(withPrint.text.split("cloud.example.com")[0], /import cloudtak_print/);
assert.strictEqual(caddy.applyCaddySnippets(withPrint.text, [printSnippet]).changed, false);
assert.strictEqual(caddy.applyCaddySnippets("a.example.com {\n\treverse_proxy other:1\n}\n\nb.example.com {\n\treverse_proxy other:2\n}\n", [udashSnippet]).ok, false);
const hostFile = [
  "{",
  "\tgrace_period 10s",
  "}",
  "",
  "portal.example.com {",
  "\trespond <<PAGE",
  "\t\t<style>body{color:#fff</style>",
  "\t\tPAGE 200",
  "}",
  "",
  "# CloudTAK Web UI",
  "map.example.com {",
  "\treverse_proxy 127.0.0.1:5000",
  "}",
  "",
  "# CloudTAK Tile Server",
  "tiles.map.example.com {",
  "\treverse_proxy 127.0.0.1:5002",
  "}",
  "",
].join("\n");
const onMap = caddy.applyCaddySnippets(hostFile, [printSnippet]);
assert.strictEqual(onMap.ok, true);
assert.match(onMap.text, /map\.example\.com \{[\s\S]*import cloudtak_print[\s\S]*reverse_proxy 127\.0\.0\.1:5000/);
assert.doesNotMatch(onMap.text.split("map.example.com")[1].split("tiles.map")[0], /body\{color/);
assert.doesNotMatch(onMap.text.split("tiles.map.example.com")[1], /import cloudtak_print/);
assert.strictEqual(caddy.applyCaddySnippets(onMap.text, [printSnippet], { host: "map.example.com" }).changed, false);
assert.match(onMap.text, /tiles\.map\.example\.com \{[\s\S]*\}\s*\(cloudtak_print\) \{/);
const marked = hostFile + [
  "# --- User-added blocks (do not remove) ---",
  "# Anything below this line survives every infra-TAK regeneration.",
  "# Add custom site blocks here (extra domains, redirects, monitors).",
  "extra.example.com {",
  "\tredir https://example.com",
  "}",
  "",
].join("\n");
const inSection = caddy.applyCaddySnippets(marked, [printSnippet]);
assert.strictEqual(inSection.ok, true);
const markerAt = inSection.text.indexOf("# --- User-added blocks (do not remove) ---");
const snippetAt = inSection.text.indexOf("(cloudtak_print)");
assert.ok(markerAt >= 0 && snippetAt > markerAt);
assert.ok(snippetAt < inSection.text.indexOf("extra.example.com"));
assert.doesNotMatch(inSection.text.slice(0, markerAt), /\(cloudtak_print\)/);
assert.strictEqual(caddy.applyCaddySnippets(inSection.text, [printSnippet]).changed, false);
const parked = marked.replace(
  "# --- User-added blocks (do not remove) ---",
  "(cloudtak_print) {\n\t@cloudtak_print path /print-api /print-api/*\n\thandle @cloudtak_print {\n\t\treverse_proxy cloudtak-print:5010\n\t}\n}\n\n# --- User-added blocks (do not remove) ---"
);
const moved = caddy.applyCaddySnippets(parked, [printSnippet]);
assert.strictEqual(moved.ok, true);
assert.ok(moved.text.indexOf("(cloudtak_print)") > moved.text.indexOf("# --- User-added blocks (do not remove) ---"));
assert.strictEqual(moved.text.split("(cloudtak_print)").length, 2);
assert.strictEqual(caddy.applyCaddySnippets(moved.text, [printSnippet]).changed, false);
const udashApplied = caddy.appliedKeys([udash, print], withUdash.text);
assert.strictEqual(caddy.extraConfigStatus(udash.additionalActions, { available: true, applied: udashApplied }).complete, true);
assert.strictEqual(caddy.extraConfigStatus(udash.additionalActions, { available: true, applied: [] }).caddyPending, true);
assert.strictEqual(caddy.extraConfigStatus(print.additionalActions, { available: true, applied: caddy.appliedKeys([print], withPrint.text) }).complete, true);
assert.strictEqual(caddy.extraConfigStatus(print.additionalActions, { available: false, applied: [] }).caddyOnHost, false);
const discover = caddy.discoverScript("/home/takwerx/CloudTAK");
assert.match(discover, /--adapter caddyfile/);
assert.match(discover, /systemctl is-active caddy/);
assert.match(discover, /\$runtime inspect/);
assert.match(discover, /Caddyfile/);
assert.doesNotMatch(discover, /incident-manager/);
const probed = caddy.parseProbe("CADDY_NONE\n");
assert.strictEqual(probed.available, false);
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
const livewx = normalized.plugins.find((p) => p.id === "livewx");
assert.ok(livewx);
assert.ok(livewx.csp && livewx.csp["img-src"].includes("https://mesonet.agron.iastate.edu"));
assert.ok(livewx.csp["connect-src"].includes("https://api.weather.gov"));
assert.ok(livewx.csp["connect-src"].includes("wss://ws1.blitzortung.org"));
assert.ok(livewx.csp["connect-src"].includes("wss://ws7.blitzortung.org"));
assert.ok(livewx.csp["connect-src"].includes("wss://ws8.blitzortung.org"));
assert.ok(livewx.csp["connect-src"].includes("wss://*.blitzortung.org"));
assert.ok(!livewx.csp["img-src"].some((s) => /blitzortung/i.test(s)));
assert.ok(!livewx.additionalActions.some((a) => /nginx/i.test(JSON.stringify(a))));
const installScript = marketplace.installRemoteScript("/root/CloudTAK", livewx);
assert.match(installScript, /Fetching latest plugin source/);
assert.match(installScript, /clone --quiet --depth 1 --single-branch --branch/);
assert.doesNotMatch(installScript, /fetch --depth 1 origin/);
assert.match(installScript, /Clearing previous plugin files at/);
assert.match(installScript, /rm -rf "\$PERSIST"/);
assert.match(installScript, /Normalizing flat plugin into lib/);
assert.match(installScript, /index\.ts imports \.\/lib\//);
assert.match(installScript, /rm -rf "\$target\/\.git"/);
assert.match(installScript, /NGINX_CSP_/);
assert.match(installScript, /docker-compose.marketplace.yml/);
assert.match(installScript, /Updating CloudTAK CSP overlay/);
assert.match(installScript, /mesonet\.agron\.iastate\.edu/);
assert.match(installScript, /wss:\/\/ws1\.blitzortung\.org/);
assert.match(installScript, /wss:\/\/\*\.blitzortung\.org/);
assert.match(installScript, /apply_plugin_csp/);
assert.match(installScript, /docker compose --progress=plain/);

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

const align = require("../services/cloudtakMarketplace.align");
assert.deepStrictEqual(
  align.readSubscriptionLoadKeys(`
    static async load(guid: string, opts: { reload?: boolean, missiontoken?: string, subscribed?: boolean } = {}) {}
  `),
  ["reload", "missiontoken", "subscribed"]
);
assert.deepStrictEqual(
  align.parseObjectProperties("{ token: await sessionToken(), missiontoken: missionAuthToken(mission), subscribed: true }").map((p) => p.key),
  ["token", "missiontoken", "subscribed"]
);

function writeAlignFixture(root, opts) {
  const webSrc = path.join(root, "api", "web", "src");
  const plugin = path.join(root, "api", "web", "plugins", "incident-manager", "src", "lib");
  fs.mkdirSync(path.join(webSrc, "base"), { recursive: true });
  fs.mkdirSync(path.join(webSrc, "workers"), { recursive: true });
  fs.mkdirSync(path.join(webSrc, "utils"), { recursive: true });
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(
    path.join(webSrc, "base", "subscription.ts"),
    opts.subscription ||
      "export default class Subscription {\n  static async load(guid: string, opts: {\n    reload?: boolean,\n    missiontoken?: string,\n    subscribed?: boolean,\n  } = {}) { return this; }\n}\n"
  );
  fs.writeFileSync(
    path.join(webSrc, "workers", "atlas-connection.ts"),
    opts.atlas ||
      "export default class AtlasConnection {\n  connect(connection: string) { return connection; }\n  private scheduleReconnect(connection: string) { return connection; }\n}\n"
  );
  fs.writeFileSync(path.join(webSrc, "utils", "coordinateFormat.ts"), "export function formatCoordPair() { return ''; }\n");
  if (opts.extraCoord) {
    fs.mkdirSync(path.join(webSrc, "base", "utils"), { recursive: true });
    fs.writeFileSync(path.join(webSrc, "base", "utils", "coordinateFormat.ts"), "export function formatCoordPair() { return ''; }\n");
  }
  fs.writeFileSync(
    path.join(plugin, "irBriefing.ts"),
    "import Subscription from '../../../../src/base/subscription.ts';\nimport { formatCoordPair } from '../../../../src/base/utils/coordinateFormat.ts';\nexport async function loadIrBriefingFromMission(missionGuid: string, missionToken?: string) {\n  const sub = await Subscription.load(missionGuid, { token: missionToken ?? '' });\n  return formatCoordPair(sub);\n}\n"
  );
  fs.writeFileSync(
    path.join(plugin, "incidentSubscription.ts"),
    "import { Preferences } from '@capacitor/preferences';\nimport Subscription from '../../../../src/base/subscription.ts';\nexport async function sessionToken() {\n  const { value } = await Preferences.get({ key: 'token' });\n  return value || '';\n}\nexport async function loadIncidentSubscription(mission: { guid: string }) {\n  const sub = await Subscription.load(mission.guid, {\n    token: await sessionToken(),\n    missiontoken: mission.guid,\n    subscribed: true,\n  });\n  return sub;\n}\n"
  );
  fs.writeFileSync(
    path.join(plugin, "missionFeatures.ts"),
    "import { Preferences } from '@capacitor/preferences';\nimport Subscription from '../../../../src/base/subscription.ts';\nasync function sessionToken() {\n  const { value } = await Preferences.get({ key: 'token' });\n  return value || '';\n}\nasync function ensureConnOpen(worker: { conn: { isOpen: boolean, reconnect: (u: string) => Promise<void> }, username: string }) {\n  if (await worker.conn.isOpen) return;\n  await worker.conn.reconnect(await worker.username);\n}\nexport async function pushFeature(worker: { conn: { isOpen: boolean, reconnect: (u: string) => Promise<void> }, username: string }, missionGuid: string) {\n  await ensureConnOpen(worker);\n  return Subscription.load(missionGuid, {\n    token: await sessionToken(),\n    missiontoken: 'm',\n    subscribed: true,\n  });\n}\n"
  );
}

const alignRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ctak-align-"));
writeAlignFixture(alignRoot, {});
const aligned = align.alignInstalledPlugins(alignRoot);
assert.ok(aligned.ok);
assert.ok(aligned.changes.some((line) => line.includes("coordinateFormat.ts") && line.includes("src/utils/coordinateFormat.ts")));
assert.ok(aligned.changes.some((line) => line.includes("token -> missiontoken")));
assert.ok(aligned.changes.some((line) => line.includes("dropped Subscription.load session token")));
assert.ok(aligned.changes.some((line) => line.includes("conn.reconnect -> conn.connect")));
const briefing = fs.readFileSync(path.join(alignRoot, "api", "web", "plugins", "incident-manager", "src", "lib", "irBriefing.ts"), "utf8");
assert.match(briefing, /from '\.\.\/\.\.\/\.\.\/\.\.\/src\/utils\/coordinateFormat\.ts'/);
assert.match(briefing, /missiontoken: missionToken \?\? ''/);
assert.doesNotMatch(briefing, /\btoken:/);
const incidentSub = fs.readFileSync(path.join(alignRoot, "api", "web", "plugins", "incident-manager", "src", "lib", "incidentSubscription.ts"), "utf8");
assert.match(incidentSub, /export async function sessionToken/);
assert.match(incidentSub, /missiontoken: mission\.guid/);
assert.doesNotMatch(incidentSub, /\btoken:/);
const features = fs.readFileSync(path.join(alignRoot, "api", "web", "plugins", "incident-manager", "src", "lib", "missionFeatures.ts"), "utf8");
assert.match(features, /worker\.conn\.connect\(/);
assert.doesNotMatch(features, /function sessionToken/);
assert.doesNotMatch(features, /Preferences/);
assert.doesNotMatch(features, /\btoken:/);
const alignedAgain = align.alignInstalledPlugins(alignRoot);
assert.deepStrictEqual(alignedAgain.changes, []);
fs.rmSync(alignRoot, { recursive: true, force: true });

const keepTokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ctak-align-keep-"));
writeAlignFixture(keepTokenRoot, {
  subscription:
    "export default class Subscription {\n  static async load(guid: string, opts: { token?: string, missiontoken?: string } = {}) { return this; }\n}\n",
  atlas: "export default class AtlasConnection {\n  connect(connection: string) {}\n  reconnect(connection: string) { this.connect(connection); }\n}\n",
  extraCoord: true,
});
const kept = align.alignInstalledPlugins(keepTokenRoot);
assert.deepStrictEqual(kept.changes, []);
const keptBrief = fs.readFileSync(path.join(keepTokenRoot, "api", "web", "plugins", "incident-manager", "src", "lib", "irBriefing.ts"), "utf8");
assert.match(keptBrief, /base\/utils\/coordinateFormat\.ts/);
assert.match(keptBrief, /\{ token: missionToken \?\? '' \}/);
const keptFeatures = fs.readFileSync(path.join(keepTokenRoot, "api", "web", "plugins", "incident-manager", "src", "lib", "missionFeatures.ts"), "utf8");
assert.match(keptFeatures, /conn\.reconnect\(/);
fs.rmSync(keepTokenRoot, { recursive: true, force: true });

const lintRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ctak-align-lint-"));
writeAlignFixture(lintRoot, {});
const lintPkg = path.join(lintRoot, "api", "web", "package.json");
fs.writeFileSync(
  lintPkg,
  JSON.stringify(
    {
      scripts: {
        lint: "eslint --config eslint.config.js ./src/ ./public/ ./plugins/",
        check: "vue-tsc",
      },
    },
    null,
    2
  ) + "\n"
);
const linted = align.alignInstalledPlugins(lintRoot);
assert.ok(linted.changes.some((line) => line.includes("image lint no longer includes marketplace plugin files")));
assert.ok(linted.changes.some((line) => line.includes("image typecheck no longer includes marketplace plugin files")));
const lintScripts = JSON.parse(fs.readFileSync(lintPkg, "utf8")).scripts;
assert.strictEqual(lintScripts.lint, "eslint --config eslint.config.js ./src/ ./public/");
assert.doesNotMatch(lintScripts.lint, /\.\/plugins/);
assert.strictEqual(lintScripts.check, "vue-tsc --project tsconfig.marketplace.json");
const checkConfig = JSON.parse(fs.readFileSync(path.join(lintRoot, "api", "web", "tsconfig.marketplace.json"), "utf8"));
assert.strictEqual(checkConfig.extends, "./tsconfig.json");
assert.ok(checkConfig.exclude.includes("plugins"));
const lintedAgain = align.alignInstalledPlugins(lintRoot);
assert.deepStrictEqual(lintedAgain.changes, []);
fs.rmSync(lintRoot, { recursive: true, force: true });

const apiLintRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ctak-align-api-lint-"));
writeAlignFixture(apiLintRoot, {
  subscription:
    "export default class Subscription {\n  static async load(guid: string, opts: { token?: string, missiontoken?: string } = {}) { return this; }\n}\n",
  atlas: "export default class AtlasConnection {\n  connect(connection: string) {}\n  reconnect(connection: string) { this.connect(connection); }\n}\n",
  extraCoord: true,
});
const routesDir = path.join(apiLintRoot, "api", "stateless", "routes");
fs.mkdirSync(routesDir, { recursive: true });
fs.writeFileSync(path.join(routesDir, "plugin-demo.ts"), "export default function demo() { return 1 }\n");
fs.writeFileSync(path.join(routesDir, "helper-sync.ts"), "// @ts-nocheck\nexport default function helper() {}\n");
fs.writeFileSync(path.join(routesDir, "video.ts"), "export default function video() { return 1 }\n");
fs.writeFileSync(
  path.join(apiLintRoot, "api", "eslint.config.js"),
  "export default tseslint.config(\n    eslint.configs.recommended,\n);\n"
);
const apiLinted = align.alignInstalledPlugins(apiLintRoot);
assert.ok(apiLinted.changes.some((line) => line.includes("image lint no longer includes marketplace server routes")));
assert.ok(apiLinted.changes.some((line) => line.includes("plugin-demo.ts") && line.includes("skips image typecheck")));
const demoRoute = fs.readFileSync(path.join(routesDir, "plugin-demo.ts"), "utf8");
assert.match(demoRoute, /^\/\/ @ts-nocheck\n/);
const helperRoute = fs.readFileSync(path.join(routesDir, "helper-sync.ts"), "utf8");
assert.strictEqual((helperRoute.match(/@ts-nocheck/g) || []).length, 1);
const videoRoute = fs.readFileSync(path.join(routesDir, "video.ts"), "utf8");
assert.doesNotMatch(videoRoute, /@ts-nocheck/);
const apiEslint = fs.readFileSync(path.join(apiLintRoot, "api", "eslint.config.js"), "utf8");
assert.match(apiEslint, /stateless\/routes\/plugin-\*\.ts/);
assert.match(apiEslint, /stateless\/routes\/helper-sync\.ts/);
assert.doesNotMatch(apiEslint, /video\.ts/);
const apiLintedAgain = align.alignInstalledPlugins(apiLintRoot);
assert.deepStrictEqual(apiLintedAgain.changes, []);
fs.rmSync(apiLintRoot, { recursive: true, force: true });

const overlay = [
  "services:",
  "  cloudtak-print:",
  "    image: print",
  "    depends_on:",
  "      - cloudtak-api",
  "      - cloudtak-tiles",
  "      - cloudtak-store",
].join("\n") + "\n";
const baseServices = ["api", "store", "media", "postgis"];
const fixed = align.rewriteComposeDepends(overlay, baseServices, "CloudTAK");
assert.match(fixed.text, /-\s+api/);
assert.match(fixed.text, /-\s+store/);
assert.doesNotMatch(fixed.text, /cloudtak-tiles/);
assert.doesNotMatch(fixed.text, /cloudtak-store/);
assert.ok(fixed.notes.some((n) => n.includes("cloudtak-api") && n.includes("api")));
assert.ok(fixed.notes.some((n) => n.includes("dropped cloudtak-tiles")));
const fixedAgain = align.rewriteComposeDepends(fixed.text, baseServices, "cloudtak");
assert.strictEqual(fixedAgain.text, fixed.text);
assert.deepStrictEqual(fixedAgain.notes, []);

const inline = align.rewriteComposeDepends(
  "services:\n  sidecar:\n    depends_on: [cloudtak-api, cloudtak-missing]\n",
  ["api"],
  "cloudtak"
);
assert.match(inline.text, /depends_on: \[api\]/);
assert.doesNotMatch(inline.text, /cloudtak-missing/);

const mapped = align.rewriteComposeDepends(
  "services:\n  worker:\n    depends_on:\n      cloudtak-store:\n        condition: service_healthy\n      other:\n        condition: service_started\n",
  ["store"],
  "cloudtak"
);
assert.match(mapped.text, /store:\n {8}condition: service_healthy/);
assert.doesNotMatch(mapped.text, /cloudtak-store/);
assert.doesNotMatch(mapped.text, /^\s+other:/m);

const solve = marketplace.summarizeCommandError(
  "Aligning marketplace plugins to the installed CloudTAK API\n#23 ERROR: process failed\n------\nfailed to solve: process \"/bin/sh -c cd web && npm run lint\" did not complete successfully: exit code: 1\n"
);
assert.match(solve, /failed to solve/);
assert.doesNotMatch(solve, /Aligning marketplace/);
const composeErr = marketplace.summarizeCommandError(
  'WARN The "CLOUDTAK_Hub_URL" variable is not set.\nservice "cloudtak-print" depends on undefined service "cloudtak-store": invalid compose project\n'
);
assert.match(composeErr, /invalid compose/);
assert.ok(composeErr.length < 240);
assert.strictEqual(marketplace.summarizeCommandError("Plugin print is not in the catalog"), "Plugin print is not in the catalog");

const installAligned = marketplace.installRemoteScript("/root/CloudTAK", livewx);
assert.match(installAligned, /align_plugins_to_host/);
assert.match(installAligned, /fix_overlay_depends/);
assert.match(installAligned, /--fix-compose-depends/);
assert.match(installAligned, /Aligning marketplace plugins to the installed CloudTAK API/);
assert.match(installAligned, /readSubscriptionLoadKeys/);
assert.doesNotMatch(installAligned, /incident-manager/);
const rebuildAligned = marketplace.rebuildRemoteScript("/root/CloudTAK", "api");
assert.match(rebuildAligned, /CloudTAK image build finished\./);
assert.match(rebuildAligned, /CloudTAK container recreate finished\./);
assert.match(rebuildAligned, /align_plugins_to_host/);
assert.match(rebuildAligned, /node:22-alpine/);
assert.match(rebuildAligned, /docker run --rm -u 0/);
assert.doesNotMatch(installAligned, /--user /);
assert.doesNotMatch(rebuildAligned, /--user /);

const done = { id: "done", kind: "install", status: "complete", batchId: "old", startedAt: "2026-09-25T12:00:00.000Z", log: ["old install"] };
const next = { id: "next", kind: "uninstall", status: "running", batchId: "new", startedAt: "2026-09-25T13:00:00.000Z", log: ["removing"] };
const sibling = { id: "sib", kind: "install", status: "queued", batchId: "new", createdAt: "2026-09-25T12:59:00.000Z", log: [] };
const scan = { id: "scan", kind: "scan", status: "complete", log: ["scanned"] };
const followed = marketplace.selectLogJobs([scan, sibling, next, done]);
assert.deepStrictEqual(followed.map((j) => j.id), ["sib", "next"]);
const after = marketplace.selectLogJobs([
  scan,
  { ...sibling, status: "complete", finishedAt: "2026-09-25T13:10:00.000Z" },
  { ...next, status: "complete", finishedAt: "2026-09-25T13:05:00.000Z" },
  done,
]);
assert.deepStrictEqual(after.map((j) => j.id), ["sib", "next"]);
const onlyFinished = marketplace.selectLogJobs([done, scan]);
assert.deepStrictEqual(onlyFinished.map((j) => j.id), ["done"]);

const ssh = require("../services/cloudtakMarketplace.ssh");
assert.strictEqual(typeof ssh.onboardWithPassword, "function");
assert.strictEqual(typeof ssh.ensureCloudtakSshKeyPair, "function");
assert.strictEqual(typeof ssh.abortActiveCommand, "function");
assert.strictEqual(ssh.abortActiveCommand(), false);
const interruptWrites = [];
const interruptSignals = [];
ssh.sendRemoteInterrupt(
  { write: (s) => interruptWrites.push(s), signal: (s) => interruptSignals.push(s) },
  "INT"
);
assert.deepStrictEqual(interruptWrites, ["\x03"]);
assert.deepStrictEqual(interruptSignals, ["INT"]);
const crProgress = ssh.feedPtyChunk("", "Counting objects: 3% (1/30)\rCounting objects: 100% (30/30), done.\n");
assert.deepStrictEqual(crProgress.lines, ["Counting objects: 100% (30/30), done."]);
assert.strictEqual(ssh.stripAnsi("\u001b[1A[+] up 3/4"), "[+] up 3/4");

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
