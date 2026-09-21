"use strict";

const crypto = require("crypto");
const axios = require("axios");
const { getString, getInt, getBool } = require("./env");
const emailSvc = require("./email.service");
const store = require("./cloudtakMarketplace.store");
const ssh = require("./cloudtakMarketplace.ssh");
const settingsSvc = require("./settings.service");

const NEW_DAYS = 14;
const SCAN_INTERVAL_MS = 5 * 60 * 1000;

let _jobRunning = false;
let _lastBackgroundAt = 0;

function isEnabled() {
  return getBool("CLOUDTAK_MARKETPLACE_ENABLED", false);
}

function notifyEnabled() {
  return isEnabled() && getBool("CLOUDTAK_MARKETPLACE_NOTIFY_ENABLED", false) && emailSvc.isEmailEnabled();
}

function pollIntervalMs() {
  const minutes = getInt("CLOUDTAK_MARKETPLACE_POLL_MINUTES", 60) || 60;
  return Math.max(5, minutes) * 60 * 1000;
}

function defaultCatalogUrl() {
  const override = String(getString("CLOUDTAK_MARKETPLACE_CATALOG_URL", "")).trim();
  if (override) return override;
  const repo = process.env.GITHUB_REPO || "AdventureSeeker423/TAK-Portal";
  const ref = String(getString("CLOUDTAK_MARKETPLACE_CATALOG_REF", "main") || "main").trim() || "main";
  return `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/catalog/cloudtak-plugins.json`;
}

function repoBasename(repo) {
  return String(repo || "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean)
    .pop() || "";
}

function pluginMatchKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\.git$/i, "")
    .replace(/^(cloudtak-plugin-|cloudtak-|plugin-)/, "")
    .replace(/[^a-z0-9]+/g, "");
}

function isHostPluginNoise(dest) {
  const name = String(dest || "")
    .trim()
    .replace(/^.*\//, "");
  if (!name || name === "." || name === ".." || name.startsWith(".")) return true;
  const lower = name.toLowerCase();
  if (/^example\.(ts|js|tsx|jsx)$/.test(lower)) return true;
  if (/\.(md|markdown|txt|rst)$/.test(lower)) return true;
  if (/^(readme|license|licence|changelog|contributing|copying|notice|authors|credits)(\.|$)/.test(lower)) {
    return true;
  }
  if (lower === "package.json" || lower === "tsconfig.json" || lower === "dockerfile") return true;
  return false;
}

function parseGitHubRepo(repoUrl) {
  const s = String(repoUrl || "").trim();
  let m = s.match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (m) return { owner: m[1], repo: m[2].replace(/\.git$/i, "") };
  return null;
}

function normalizeCatalog(doc) {
  const plugins = Array.isArray(doc && doc.plugins) ? doc.plugins : [];
  const out = [];
  for (const p of plugins) {
    if (!p || typeof p !== "object") continue;
    const id = String(p.id || "").trim();
    const name = String(p.name || "").trim();
    const repo = String(p.repo || "").trim();
    const web = p.web && typeof p.web === "object" ? p.web : null;
    if (!id || !name || !repo || !web || !web.dest) continue;
    out.push({
      ...p,
      id,
      name,
      repo,
      ref: String(p.ref || "main").trim() || "main",
      web: {
        source: String(web.source || ".").trim() || ".",
        dest: String(web.dest).trim(),
      },
      routes: p.routes && p.routes.source ? { source: String(p.routes.source).trim() } : null,
      exclude: Array.isArray(p.exclude) ? p.exclude.map((x) => String(x)) : [],
      detect: Array.isArray(p.detect) ? p.detect.map((x) => String(x)) : [],
      detectAliases: Array.isArray(p.detectAliases) ? p.detectAliases.map((x) => String(x)) : [],
      notes: String(p.notes || ""),
      description: String(p.description || ""),
      maintainer: String(p.maintainer || ""),
      added: String(p.added || ""),
      installScript: String(p.installScript || "").trim(),
      composeService: String(p.composeService || "").trim(),
      sidecars: Array.isArray(p.sidecars) ? p.sidecars : [],
    });
  }
  return { version: Number(doc && doc.version) || 1, plugins: out, fetchedAt: doc && doc.fetchedAt ? doc.fetchedAt : null };
}

function loadCatalog() {
  const bundled = normalizeCatalog(store.readBundledCatalog());
  const cached = store.readPluginsCache();
  if (!cached || !Array.isArray(cached.plugins) || !cached.plugins.length) {
    return bundled;
  }
  const normalized = normalizeCatalog(cached);
  const bundledById = new Map(bundled.plugins.map((p) => [p.id, p]));
  normalized.plugins = normalized.plugins.map((p) => {
    const seed = bundledById.get(p.id);
    if (seed && seed.installScript && !p.installScript) {
      return { ...p, installScript: seed.installScript };
    }
    return p;
  });
  return normalized;
}

function isNewPlugin(plugin, now = Date.now()) {
  const added = Date.parse(String(plugin.added || ""));
  if (Number.isFinite(added) && now - added <= NEW_DAYS * 24 * 60 * 60 * 1000) return true;
  const state = store.readNotifyState();
  const seen = Array.isArray(state.seenPluginIds) ? state.seenPluginIds : [];
  if (seen.length && !seen.includes(plugin.id)) return true;
  return false;
}

function matchCatalogPlugin(hostPlugin, catalogPlugins) {
  const dest = String(hostPlugin.dest || "").toLowerCase();
  const destKey = pluginMatchKey(hostPlugin.dest);
  const pkgName = String(hostPlugin.packageName || "").toLowerCase();
  const pkgKey = pluginMatchKey(hostPlugin.packageName);
  const remote = String(hostPlugin.gitRemote || "")
    .replace(/\.git$/i, "")
    .toLowerCase();
  const remoteKey = pluginMatchKey(repoBasename(hostPlugin.gitRemote));
  const routeFiles = Array.isArray(hostPlugin.routeFiles) ? hostPlugin.routeFiles : [];

  for (const p of catalogPlugins) {
    if ((p.detect || []).some((d) => hostPlugin.detectHits && hostPlugin.detectHits.includes(d))) {
      return p;
    }
  }
  for (const p of catalogPlugins) {
    const aliases = [p.web.dest, p.id, repoBasename(p.repo), ...(p.detectAliases || [])]
      .map((x) => String(x || "").toLowerCase())
      .filter(Boolean);
    if (aliases.includes(dest)) return p;
    const aliasKeys = aliases.map(pluginMatchKey).filter((k) => k.length >= 4);
    if (destKey && destKey.length >= 4 && aliasKeys.includes(destKey)) return p;
  }
  for (const p of catalogPlugins) {
    if (pkgName && (pkgName === p.id.toLowerCase() || pkgName === repoBasename(p.repo).toLowerCase())) {
      return p;
    }
    const idKey = pluginMatchKey(p.id);
    const repoKey = pluginMatchKey(repoBasename(p.repo));
    if (pkgKey && pkgKey.length >= 4 && (pkgKey === idKey || pkgKey === repoKey)) return p;
  }
  for (const p of catalogPlugins) {
    const want = String(p.repo || "")
      .replace(/\.git$/i, "")
      .toLowerCase();
    if (remote && want && (remote === want || remote.endsWith("/" + repoBasename(p.repo).toLowerCase()))) {
      return p;
    }
    if (remoteKey && remoteKey.length >= 4 && remoteKey === pluginMatchKey(p.id)) return p;
  }
  for (const p of catalogPlugins) {
    if (!p.routes) continue;
    const prefix = `plugin-${p.id}`;
    if (routeFiles.some((f) => String(f).toLowerCase().includes(p.id.toLowerCase()) || String(f).toLowerCase().startsWith(prefix))) {
      return p;
    }
  }
  return null;
}

async function fetchCatalog() {
  const url = defaultCatalogUrl();
  try {
    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        Accept: "application/json",
        "User-Agent": "TAK-Portal",
      },
      transformResponse: [(data) => data],
      validateStatus: (s) => s >= 200 && s < 300,
    });
    const parsed = JSON.parse(String(response.data || ""));
    const normalized = normalizeCatalog(parsed);
    normalized.fetchedAt = new Date().toISOString();
    normalized.source = url;
    store.writePluginsCache(normalized);
    const state = store.readNotifyState();
    state.lastCatalogAt = Date.now();
    store.writeNotifyState(state);
    return { ok: true, catalog: normalized, url };
  } catch (err) {
    const fallback = loadCatalog();
    return {
      ok: false,
      message: err?.message || String(err),
      catalog: fallback,
      url,
    };
  }
}

function isEnabledValue(v) {
  return ["1", "true", "yes", "on"].includes(String(v || "").trim().toLowerCase());
}

async function persistDetectedPath(detected, { overwritePath = false } = {}) {
  if (!detected || !detected.ok || !detected.path) return detected;
  const current = settingsSvc.getSettings() || {};
  const next = { ...current };
  let changed = false;
  const curPath = String(current.CLOUDTAK_MARKETPLACE_PATH || "").trim();
  if (overwritePath || !curPath) {
    if (String(next.CLOUDTAK_MARKETPLACE_PATH || "") !== detected.path) {
      next.CLOUDTAK_MARKETPLACE_PATH = detected.path;
      changed = true;
    }
  }
  const curSvc = String(current.CLOUDTAK_MARKETPLACE_COMPOSE_SERVICE || "").trim();
  if (!curSvc && detected.composeService) {
    next.CLOUDTAK_MARKETPLACE_COMPOSE_SERVICE = detected.composeService;
    changed = true;
  }
  if (changed) settingsSvc.saveSettings(next);
  return detected;
}

async function detectAndPersist({ overwritePath = true } = {}) {
  const detected = await ssh.detectCheckout();
  return persistDetectedPath(detected, { overwritePath });
}

async function ensureCheckoutPath() {
  let ct = ssh.resolvedCheckoutPath();
  if (ct) return { ok: true, path: ct, composeService: ssh.resolvedComposeService() };
  const detected = await ssh.detectCheckout();
  if (!detected.ok) return detected;
  await persistDetectedPath(detected, { overwritePath: false });
  return {
    ok: true,
    path: detected.path,
    composeService: detected.composeService || "api",
    composeFile: detected.composeFile,
  };
}

function scanRemoteScript(ctPath, catalogPlugins) {
  const ct = String(ctPath || "").replace(/'/g, "");
  return `
set -eu
CT='${ct}'
if [ ! -d "$CT/api" ]; then echo SCAN_FAIL missing api/; exit 1; fi
printf 'SCAN_BEGIN\\n'
emit_plugin() {
  local p="$1"
  [ -e "$p" ] || return 0
  local name kind target has_index pkg remote head
  name=$(basename "$p")
  case "$name" in
    example.ts|example.js|example.tsx|README.md|readme.md|README|LICENSE|LICENSE.md|.gitkeep|.DS_Store|package.json|tsconfig.json) return 0 ;;
  esac
  case "$name" in
    *.md|*.markdown|*.txt) return 0 ;;
  esac
  kind=dir
  target=""
  if [ -L "$p" ]; then
    kind=symlink
    target=$(readlink "$p" || true)
  elif [ -f "$p" ]; then
    kind=file
  fi
  has_index=0
  if [ -f "$p/index.ts" ] || [ -f "$p/plugin/index.ts" ] || [ -f "$p/src/index.ts" ] || [ -f "$p/index.js" ]; then has_index=1; fi
  pkg=""
  if [ -f "$p/package.json" ]; then
    pkg=$(grep -m1 '"name"' "$p/package.json" | sed 's/.*"name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/' || true)
  elif [ -f "$p/plugin/package.json" ]; then
    pkg=$(grep -m1 '"name"' "$p/plugin/package.json" | sed 's/.*"name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/' || true)
  fi
  remote=""
  head=""
  if [ -d "$p/.git" ]; then
    remote=$(git -C "$p" remote get-url origin 2>/dev/null || true)
    head=$(git -C "$p" rev-parse HEAD 2>/dev/null || true)
  elif [ -d "$p/plugin/.git" ]; then
    remote=$(git -C "$p/plugin" remote get-url origin 2>/dev/null || true)
    head=$(git -C "$p/plugin" rev-parse HEAD 2>/dev/null || true)
  fi
  printf 'PLUGIN\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$name" "$kind" "$has_index" "$pkg" "$remote" "$head" "$target"
}
scan_plugin_dir() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  local p
  for p in "$dir"/*; do
    [ -e "$p" ] || continue
    emit_plugin "$p"
  done
}
scan_plugin_dir "$CT/api/web/plugins"
scan_plugin_dir "$CT/api/web/src/plugins"
if [ -d "$CT/api/stateless/routes" ]; then
  for f in "$CT/api/stateless/routes"/*.ts; do
    [ -f "$f" ] || continue
    printf 'ROUTE %s\\n' "$(basename "$f")"
  done
fi
web_plugins=""
for f in "$CT/docker-compose.yml" "$CT/docker-compose.yaml" "$CT/docker-compose.override.yml" "$CT/.env"; do
  if [ -f "$f" ]; then
    line=$(grep -E '^[[:space:]]*WEB_PLUGINS=' "$f" | tail -n 1 || true)
    if [ -n "$line" ]; then web_plugins="$web_plugins $line"; fi
  fi
done
printf 'WEB_PLUGINS %s\\n' "$web_plugins"
${(catalogPlugins || [])
  .flatMap((p) => p.detect || [])
  .filter((d) => /^[A-Za-z0-9._/-]+$/.test(String(d)))
  .map((d) => `if [ -e "$CT/${String(d).replace(/"/g, "")}" ]; then printf 'DETECT_HIT %s\\n' "${String(d).replace(/"/g, "")}"; fi`)
  .join("\n")}
if command -v docker >/dev/null 2>&1; then
  while IFS= read -r c; do
    [ -n "$c" ] || continue
    echo "$c" | grep -qiE 'cloudtak|takwerx' || continue
    for inner in web/plugins /home/node/web/plugins /usr/src/app/web/plugins /opt/app/web/plugins api/web/plugins; do
      listing=$(docker exec "$c" sh -c "ls -1 $inner 2>/dev/null" || true)
      [ -n "$listing" ] || continue
      printf 'CONTAINER %s dir=%s\\n' "$c" "$inner"
      echo "$listing" | while IFS= read -r name; do
        [ -n "$name" ] || continue
        case "$name" in
          example.ts|example.js|README.md|readme.md|README|LICENSE|.gitkeep|.DS_Store) continue ;;
        esac
        case "$name" in
          *.md|*.txt) continue ;;
        esac
        printf 'PLUGIN\\t%s\\tdir\\t1\\t\\t\\t\\t\\n' "$name"
      done
    done
  done <<CONTAINERS
$(docker ps --format '{{.Names}}' 2>/dev/null || true)
CONTAINERS
fi
printf 'SCAN_END\\n'
`.trim();
}

function parseScanStdout(stdout, catalogPlugins) {
  const plugins = [];
  const seenDest = new Set();
  const routeFiles = [];
  let webPluginsRaw = "";
  const pushPlugin = (row) => {
    const dest = String(row.dest || "").trim();
    if (!dest || dest === "*" || dest === "." || dest === ".." || isHostPluginNoise(dest)) return;
    const key = dest.toLowerCase();
    if (seenDest.has(key)) return;
    seenDest.add(key);
    plugins.push({
      dest,
      kind: row.kind || "dir",
      hasIndex: row.hasIndex === true || row.hasIndex === "1",
      packageName: row.packageName || "",
      gitRemote: row.gitRemote || "",
      gitHead: row.gitHead || "",
      symlinkTarget: row.symlinkTarget || "",
      routeFiles: [],
      detectHits: [],
    });
  };
  for (const line of String(stdout || "").split("\n")) {
    const t = line.trim();
    if (t.startsWith("PLUGIN\t")) {
      const parts = t.split("\t");
      pushPlugin({
        dest: parts[1] || "",
        kind: parts[2] || "dir",
        hasIndex: parts[3] === "1",
        packageName: parts[4] || "",
        gitRemote: parts[5] || "",
        gitHead: parts[6] || "",
        symlinkTarget: parts[7] || "",
      });
    } else if (t.startsWith("PLUGIN ")) {
      const get = (key) => {
        const m = t.match(new RegExp(`(?:^|\\s)${key}=(\\S*)`));
        return m ? m[1] : "";
      };
      pushPlugin({
        dest: get("dest"),
        kind: get("kind"),
        hasIndex: get("index") === "1",
        packageName: get("pkg"),
        gitRemote: get("remote"),
        gitHead: get("head"),
        symlinkTarget: get("target"),
      });
    } else if (t.startsWith("DETECT_HIT ")) {
      const hit = t.slice(11).trim();
      const destFromDetect = String(hit).includes("plugins/")
        ? String(hit).split("plugins/")[1].split("/")[0]
        : "";
      if (destFromDetect) {
        pushPlugin({ dest: destFromDetect, kind: "detect", hasIndex: true });
        const row = plugins.find((p) => p.dest === destFromDetect);
        if (row) {
          row.detectHits = row.detectHits || [];
          if (!row.detectHits.includes(hit)) row.detectHits.push(hit);
        }
      }
    } else if (t.startsWith("ROUTE ")) {
      routeFiles.push(t.slice(6).trim());
    } else if (t.startsWith("WEB_PLUGINS ")) {
      webPluginsRaw += t.slice(12);
    }
  }
  for (const p of plugins) p.routeFiles = routeFiles;

  const detectHitsByDest = {};
  for (const cat of catalogPlugins) {
    for (const d of cat.detect || []) {
      const destFromDetect = String(d).includes("plugins/")
        ? String(d).split("plugins/")[1].split("/")[0]
        : "";
      if (destFromDetect) {
        detectHitsByDest[destFromDetect] = detectHitsByDest[destFromDetect] || [];
        detectHitsByDest[destFromDetect].push(d);
      }
    }
  }
  for (const p of plugins) {
    p.detectHits = [...new Set([...(p.detectHits || []), ...(detectHitsByDest[p.dest] || [])])];
  }

  const webUrls = [];
  const urlRe = /https?:\/\/[^\s,#]+/gi;
  let m;
  while ((m = urlRe.exec(webPluginsRaw))) webUrls.push(m[0].replace(/"/g, ""));

  return { plugins, routeFiles, webPluginUrls: webUrls };
}

async function scanHost() {
  const catalog = loadCatalog();
  const loc = await ensureCheckoutPath();
  if (!loc.ok) {
    const prev = store.readScanCache();
    const err = {
      ok: false,
      message: loc.message || "Could not resolve CloudTAK path.",
      scannedAt: new Date().toISOString(),
      stale: true,
      path: "",
      plugins: (prev && prev.plugins) || [],
    };
    store.writeScanCache(err);
    return err;
  }
  const result = await ssh.runCommand(`bash -lc ${ssh.shellQuote(scanRemoteScript(loc.path, catalog.plugins))}`, 60000);
  if (!result.ok) {
    const prev = store.readScanCache();
    const err = {
      ok: false,
      message: result.message || "Host scan failed.",
      scannedAt: new Date().toISOString(),
      stale: true,
      path: loc.path,
      plugins: (prev && prev.plugins) || [],
    };
    store.writeScanCache(err);
    return err;
  }
  const parsed = parseScanStdout(result.stdout, catalog.plugins);
  const installedRec = store.readInstalled();
  const found = [];

  for (const host of parsed.plugins) {
    const match = matchCatalogPlugin(host, catalog.plugins);
    found.push({
      dest: host.dest,
      kind: host.kind,
      gitHead: host.gitHead || "",
      gitRemote: host.gitRemote || "",
      onDisk: true,
      inWebPlugins: false,
      catalogId: match ? match.id : null,
      origin: match
        ? installedRec.plugins[match.id]
          ? "marketplace"
          : "host"
        : "unknown",
    });
  }

  for (const url of parsed.webPluginUrls) {
    const match = catalog.plugins.find((p) => {
      const a = String(p.repo || "").replace(/\.git$/i, "").toLowerCase();
      const b = String(url).split("#")[0].replace(/\.git$/i, "").toLowerCase();
      return a && b && a === b;
    });
    if (!match) continue;
    if (found.some((f) => f.catalogId === match.id)) {
      const row = found.find((f) => f.catalogId === match.id);
      row.inWebPlugins = true;
      continue;
    }
    found.push({
      dest: match.web.dest,
      kind: "web_plugins",
      gitHead: "",
      gitRemote: url,
      onDisk: false,
      inWebPlugins: true,
      catalogId: match.id,
      origin: "web_plugins",
    });
  }

  const cache = {
    scannedAt: new Date().toISOString(),
    path: loc.path,
    composeService: loc.composeService || ssh.resolvedComposeService(),
    ok: true,
    plugins: found,
    routeFiles: parsed.routeFiles,
  };
  store.writeScanCache(cache);
  const state = store.readNotifyState();
  state.lastScanAt = Date.now();
  store.writeNotifyState(state);
  return cache;
}

function githubHeaders() {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "TAK-Portal",
  };
}

async function remoteShaForPlugin(plugin) {
  const gh = parseGitHubRepo(plugin.repo);
  if (gh) {
    try {
      const url = `https://api.github.com/repos/${gh.owner}/${gh.repo}/commits/${encodeURIComponent(plugin.ref)}`;
      const response = await axios.get(url, { timeout: 10000, headers: githubHeaders() });
      const sha = response.data && (response.data.sha || (response.data.commit && response.data.sha));
      if (sha) return String(sha);
    } catch (_) {
      /* fall through to host ls-remote */
    }
  }
  const loc = ssh.resolvedCheckoutPath();
  const result = await ssh.runCommand(
    `git ls-remote ${ssh.shellQuote(plugin.repo)} ${ssh.shellQuote(plugin.ref)} | awk '{print $1}' | head -n 1`,
    20000
  );
  if (!result.ok) return "";
  return String(result.stdout || "").trim().split(/\s+/)[0] || "";
}

async function enrichUpdateShas(uiPlugins) {
  const installed = store.readInstalled();
  const out = [];
  for (const row of uiPlugins) {
    const next = { ...row };
    if (row.installed && row.catalog) {
      const remoteSha = await remoteShaForPlugin(row.catalog);
      const localSha =
        (installed.plugins[row.id] && installed.plugins[row.id].sha) ||
        row.scan.gitHead ||
        "";
      next.remoteSha = remoteSha || "";
      next.installedSha = localSha;
      next.updateAvailable = !!(remoteSha && localSha && remoteSha !== localSha) || !!(remoteSha && !localSha && row.installed);
      if (!localSha && remoteSha) next.updateAvailable = true;
      if (localSha && remoteSha && localSha.startsWith(remoteSha.slice(0, 7))) next.updateAvailable = false;
      if (localSha && remoteSha && remoteSha.startsWith(localSha.slice(0, 7))) next.updateAvailable = false;
    } else {
      next.updateAvailable = false;
    }
    out.push(next);
  }
  return out;
}

function buildUiPlugins(options = {}) {
  const catalog = loadCatalog();
  const scan = store.readScanCache();
  const installedRec = store.readInstalled();
  const scanPlugins = ((scan && Array.isArray(scan.plugins) ? scan.plugins : []) || []).filter(
    (s) => s && !isHostPluginNoise(s.dest)
  );
  const now = Date.now();

  const byId = new Map();
  for (const p of catalog.plugins) {
    const scanHit = scanPlugins.find((s) => s.catalogId === p.id);
    const installed = !!(scanHit || installedRec.plugins[p.id]);
    byId.set(p.id, {
      id: p.id,
      name: p.name,
      description: p.description,
      maintainer: p.maintainer,
      repo: p.repo,
      ref: p.ref,
      notes: p.notes,
      added: p.added,
      isNew: isNewPlugin(p, now),
      installed,
      origin: scanHit ? scanHit.origin : installedRec.plugins[p.id] ? "marketplace" : "",
      layout: {
        web: true,
        routes: !!p.routes,
        sidecar: Array.isArray(p.sidecars) && p.sidecars.length > 0,
      },
      dest: p.web.dest,
      catalog: p,
      scan: scanHit || null,
      unknown: false,
    });
  }
  for (const s of scanPlugins) {
    if (s.catalogId && byId.has(s.catalogId)) continue;
    const id = s.catalogId || `unknown:${s.dest}`;
    byId.set(id, {
      id,
      name: s.dest,
      description: "Found on the CloudTAK host, not in the catalog.",
      maintainer: "",
      repo: s.gitRemote || "",
      ref: "",
      notes: "",
      added: "",
      isNew: false,
      installed: true,
      origin: "unknown",
      layout: { web: true, routes: false, sidecar: false },
      dest: s.dest,
      catalog: null,
      scan: s,
      unknown: true,
    });
  }

  const shaCache = store.readShaCache();
  const shaById = shaCache && shaCache.byId && typeof shaCache.byId === "object" ? shaCache.byId : {};
  const plugins = [...byId.values()]
    .map((row) => {
      const sha = shaById[row.id];
      if (!sha) return { ...row, updateAvailable: false, remoteSha: "", installedSha: "" };
      return {
        ...row,
        updateAvailable: !!sha.updateAvailable,
        remoteSha: sha.remoteSha || "",
        installedSha: sha.installedSha || "",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    plugins,
    catalogFetchedAt: catalog.fetchedAt || null,
    scannedAt: scan && scan.scannedAt ? scan.scannedAt : null,
    scanOk: !!(scan && scan.ok),
    scanStale: !!(scan && scan.stale) || (scan && scan.scannedAt && now - Date.parse(scan.scannedAt) > SCAN_INTERVAL_MS * 2),
    scanError: scan && !scan.ok ? String(scan.message || "") : "",
    scanPath: scan && scan.path,
    shaUpdatedAt: shaCache && shaCache.updatedAt ? shaCache.updatedAt : null,
    skipRemoteSha: !!options.skipRemoteSha,
  };
}

async function refreshShaCache() {
  const base = buildUiPlugins();
  const enriched = await enrichUpdateShas(base.plugins);
  const byId = {};
  for (const row of enriched) {
    byId[row.id] = {
      remoteSha: row.remoteSha || "",
      installedSha: row.installedSha || "",
      updateAvailable: !!row.updateAvailable,
    };
  }
  store.writeShaCache({ updatedAt: new Date().toISOString(), byId });
  return byId;
}

async function getSnapshot() {
  const base = buildUiPlugins();
  let plugins = base.plugins;
  try {
    plugins = await enrichUpdateShas(base.plugins);
  } catch (err) {
    console.warn("[cloudtak-marketplace] sha enrich:", err?.message || err);
  }
  return { ...base, plugins };
}

function enqueueJob({ kind, pluginId, createdBy, extra }) {
  const id = crypto.randomUUID();
  const job = {
    id,
    kind: String(kind || "").trim(),
    pluginId: pluginId || null,
    status: "queued",
    createdBy: createdBy || null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    log: [],
    error: null,
    extra: extra || null,
  };
  store.withJobs((jobs) => [job, ...jobs].slice(0, store.MAX_JOBS));
  return job;
}

function enqueueJobOnce(kind, createdBy) {
  const existing = store
    .readJobs()
    .jobs.find((j) => j.kind === kind && (j.status === "queued" || j.status === "running"));
  if (existing) return existing;
  return enqueueJob({ kind, createdBy });
}

async function onEnabled(opts = {}) {
  const createdBy = opts.createdBy || "settings";
  rememberSeenCatalog();
  enqueueJobOnce("refresh-catalog", createdBy);
  try {
    await detectAndPersist({ overwritePath: false });
  } catch (err) {
    console.warn("[cloudtak-marketplace] detect on enable:", err?.message || err);
  }
  enqueueJobOnce("scan", createdBy);
  return { ok: true };
}

function appendJobLog(jobId, line) {
  const text = String(line || "").trimEnd();
  if (!text) return;
  store.withJobs((jobs) =>
    jobs.map((j) => {
      if (j.id !== jobId) return j;
      const log = Array.isArray(j.log) ? j.log.slice() : [];
      log.push(`${new Date().toISOString()} ${text}`);
      if (log.length > 400) log.splice(0, log.length - 400);
      return { ...j, log };
    })
  );
}

function updateJob(jobId, patch) {
  store.withJobs((jobs) => jobs.map((j) => (j.id === jobId ? { ...j, ...patch } : j)));
}

function listJobs() {
  return store.readJobs().jobs;
}

function isActiveJob(job) {
  const status = String((job && job.status) || "");
  return status === "queued" || status === "running";
}

function clearIdleJobs() {
  const jobs = store.readJobs().jobs;
  if (jobs.some(isActiveJob)) return jobs;
  return store.withJobs((current) => {
    if (current.some(isActiveJob)) return current;
    return [];
  }).jobs;
}

function pluginById(id) {
  return loadCatalog().plugins.find((p) => p.id === id) || null;
}

function safeDestName(name) {
  return /^[A-Za-z0-9._-]+$/.test(String(name || ""));
}

function installRemoteScript(ct, plugin) {
  const dest = plugin.web.dest;
  const source = plugin.web.source === "." ? "." : plugin.web.source;
  const routes = plugin.routes ? plugin.routes.source : "";
  const excludes = (plugin.exclude || []).join("\n");
  const installScript = plugin.installScript || "";
  const repoName = repoBasename(plugin.repo) || plugin.id;
  return `
set -euo pipefail
CT=${ssh.shellQuote(ct)}
ID=${ssh.shellQuote(plugin.id)}
REPO=${ssh.shellQuote(plugin.repo)}
REF=${ssh.shellQuote(plugin.ref)}
DEST=${ssh.shellQuote(dest)}
SRC=${ssh.shellQuote(source)}
ROUTES=${ssh.shellQuote(routes)}
INSTALL=${ssh.shellQuote(installScript)}
WANT=${ssh.shellQuote(repoName)}
CACHE="$HOME/.cache/cloudtak-marketplace/$ID"
mkdir -p "$(dirname "$CACHE")"
git_ok() {
  git -c "safe.directory=$CACHE" -c safe.directory=* "$@"
}
reset_cache() {
  rm -rf "$CACHE" 2>/dev/null || true
  if [ -e "$CACHE" ]; then
    sudo -n rm -rf "$CACHE" 2>/dev/null || true
  fi
  if [ -e "$CACHE" ]; then
    echo "ERROR: cannot replace plugin cache $CACHE (owned by another user)." >&2
    exit 1
  fi
}

cloudtak_owner() {
  stat -c '%U' "$CT" 2>/dev/null || stat -f '%Su' "$CT" 2>/dev/null || true
}

can_write_plugins() {
  local plugins="$CT/api/web/plugins"
  [ -d "$plugins" ] && [ -w "$plugins" ] || return 1
  if [ -e "$plugins/$DEST" ] && [ ! -w "$plugins/$DEST" ]; then return 1; fi
  return 0
}

run_as_writer() {
  local cmd="$1"
  if can_write_plugins; then
    bash -lc "$cmd"
    return 0
  fi
  local owner
  owner=$(cloudtak_owner)
  echo "Plugin files are not writable by $(id -un) (CloudTAK owner: $owner)"
  if [ -n "$owner" ] && [ "$(id -un)" != "$owner" ] && sudo -n -u "$owner" true >/dev/null 2>&1; then
    echo "Running installer as $owner"
    sudo -n -u "$owner" bash -lc "$cmd"
    return 0
  fi
  if sudo -n true >/dev/null 2>&1; then
    echo "Running installer with sudo"
    sudo -n bash -lc "$cmd"
    return 0
  fi
  local img=""
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    img=$(cd "$CT" && docker compose ps -q 2>/dev/null | head -n 1 | xargs -r docker inspect -f '{{.Config.Image}}' 2>/dev/null || true)
    if [ -z "$img" ]; then
      img=$(docker ps --format '{{.Image}}' 2>/dev/null | head -n 1 || true)
    fi
  fi
  if [ -n "$img" ]; then
    echo "Writing plugin files via docker image $img (root)"
    docker run --rm -u 0 \
      -v "$REPO_DIR:$REPO_DIR" \
      -v "$CT:$CT" \
      -w "$REPO_DIR" \
      --entrypoint /bin/sh \
      "$img" \
      -c "if command -v bash >/dev/null 2>&1; then bash -lc $(printf '%q' "$cmd"); else sh -c $(printf '%q' "$cmd"); fi"
    return 0
  fi
  echo "ERROR: cannot write $CT/api/web/plugins as $(id -un). Point CloudTAK SSH at the account that owns that checkout (likely $owner)." >&2
  exit 1
}

echo "Fetching plugin source"
if [ -d "$CACHE/.git" ]; then
  cache_owner=$(stat -c '%U' "$CACHE" 2>/dev/null || stat -f '%Su' "$CACHE" 2>/dev/null || true)
  if [ -n "$cache_owner" ] && [ "$cache_owner" != "$(id -un)" ]; then
    echo "Replacing plugin cache owned by $cache_owner"
    reset_cache
  fi
fi
if [ -d "$CACHE/.git" ]; then
  git_ok -C "$CACHE" fetch --depth 1 origin "$REF"
  git_ok -C "$CACHE" checkout --force FETCH_HEAD
else
  reset_cache
  git_ok clone --depth 1 --branch "$REF" "$REPO" "$CACHE"
fi
REPO_DIR="$CACHE"
SHA=$(git_ok -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || true)
echo "Plugin source $REPO_DIR @ $SHA"

if [ -f "$REPO_DIR/install.sh" ]; then
  INSTALL="./install.sh --no-pull"
fi

if [ -n "$INSTALL" ]; then
  echo "Installing the same way the plugin repo documents: cd $REPO_DIR && $INSTALL $CT"
  run_as_writer "cd $(printf '%q' "$REPO_DIR") && $INSTALL $(printf '%q' "$CT")"
else
  WEBSRC="$REPO_DIR"
  if [ "$SRC" != "." ]; then WEBSRC="$REPO_DIR/$SRC"; fi
  if [ ! -d "$WEBSRC" ]; then echo "Missing web source $WEBSRC" >&2; exit 1; fi
  PLUGIN_ROOT="$CT/api/web/plugins"
  TARGET="$PLUGIN_ROOT/$DEST"
  case "$TARGET" in
    */api/web/plugins/$DEST) ;;
    *) echo "Refusing dest $TARGET" >&2; exit 1 ;;
  esac
  run_as_writer "mkdir -p $(printf '%q' "$TARGET") && cp -a $(printf '%q' "$WEBSRC")/. $(printf '%q' "$TARGET")/"
  cat <<'EXCL' > /tmp/ctak-marketplace-excludes-$ID
${excludes}
EXCL
  if [ -s /tmp/ctak-marketplace-excludes-$ID ]; then
    while IFS= read -r pat; do
      [ -n "$pat" ] || continue
      base=$(echo "$pat" | sed 's#^\\*\\*/##' | sed 's#/$##')
      run_as_writer "rm -rf $(printf '%q' "$TARGET/$base")" || true
    done < /tmp/ctak-marketplace-excludes-$ID
  fi
  if [ -n "$ROUTES" ] && [ -d "$REPO_DIR/$ROUTES" ]; then
    run_as_writer "mkdir -p $(printf '%q' "$CT/api/stateless/routes") && cp -a $(printf '%q' "$REPO_DIR/$ROUTES")/*.ts $(printf '%q' "$CT/api/stateless/routes")/" || true
  fi
fi
printf 'INSTALL_SHA %s\\n' "$SHA"
`.trim();
}

function uninstallRemoteScript(ct, dest, routeFiles) {
  const files = (routeFiles || []).filter((f) => /^[A-Za-z0-9._-]+\.ts$/.test(f));
  const routeRm = files
    .map((f) => `rm -f "$CT/api/stateless/routes/${f}"`)
    .join("\n");
  return `
set -euo pipefail
CT=${ssh.shellQuote(ct)}
DEST=${ssh.shellQuote(dest)}
TARGET="$CT/api/web/plugins/$DEST"
case "$TARGET" in
  */api/web/plugins/$DEST) ;;
  *) echo "Refusing dest $TARGET" >&2; exit 1 ;;
esac
rm -rf "$TARGET"
${routeRm}
echo UNINSTALL_OK
`.trim();
}

function rebuildRemoteScript(ct, service) {
  return `
set -euo pipefail
CT=${ssh.shellQuote(ct)}
SVC=${ssh.shellQuote(service || "api")}
cd "$CT"
CF=""
if [ -f docker-compose.yml ]; then CF=docker-compose.yml
elif [ -f docker-compose.yaml ]; then CF=docker-compose.yaml
elif [ -f compose.yml ]; then CF=compose.yml
elif [ -f compose.yaml ]; then CF=compose.yaml
else echo "No compose file in $CT" >&2; exit 1
fi
docker compose -f "$CF" build --no-cache --progress=plain "$SVC"
docker compose -f "$CF" up -d --force-recreate "$SVC"
echo REBUILD_OK
`.trim();
}

async function runLogged(jobId, command, timeoutMs) {
  appendJobLog(jobId, `$ ${command.slice(0, 180)}`);
  let streamed = false;
  const result = await ssh.runCommand(command, timeoutMs, (line) => {
    streamed = true;
    appendJobLog(jobId, line);
  });
  if (!streamed) {
    if (result.stdout) {
      String(result.stdout)
        .split("\n")
        .forEach((line) => line.trim() && appendJobLog(jobId, line.trim()));
    }
    if (!result.ok && result.stderr) {
      String(result.stderr)
        .split("\n")
        .forEach((line) => line.trim() && appendJobLog(jobId, line.trim()));
    }
  }
  if (!result.ok) {
    throw new Error(result.message || "SSH command failed");
  }
  return result;
}

async function performInstall(job, plugin) {
  if (!safeDestName(plugin.web.dest)) throw new Error("Invalid plugin dest folder");
  const loc = await ensureCheckoutPath();
  if (!loc.ok) throw new Error(loc.message || "CloudTAK path not found");
  appendJobLog(job.id, `Using CloudTAK at ${loc.path}`);
  const result = await runLogged(
    job.id,
    `bash -lc ${ssh.shellQuote(installRemoteScript(loc.path, plugin))}`,
    20 * 60 * 1000
  );
  const shaLine = String(result.stdout || "")
    .split("\n")
    .find((l) => l.startsWith("INSTALL_SHA "));
  const sha = shaLine ? shaLine.slice(12).trim() : "";
  const rec = store.readInstalled();
  rec.plugins[plugin.id] = {
    sha,
    dest: plugin.web.dest,
    installedAt: new Date().toISOString(),
    repo: plugin.repo,
    ref: plugin.ref,
  };
  store.writeInstalled(rec);
  const out = String(result.stdout || "") + "\n" + String(result.stderr || "");
  const skipRebuild =
    /Rebuilding CloudTAK API image/i.test(out) ||
    (/Plugin installed/i.test(out) && !/Skipped rebuild/i.test(out));
  return {
    sha,
    path: loc.path,
    composeService: loc.composeService || ssh.resolvedComposeService(),
    skipRebuild,
  };
}

async function performUninstall(job, dest, plugin) {
  if (!safeDestName(dest)) throw new Error("Invalid plugin dest folder");
  const loc = await ensureCheckoutPath();
  if (!loc.ok) throw new Error(loc.message || "CloudTAK path not found");
  const routeGuess = [];
  if (plugin && plugin.routes) {
    routeGuess.push(`plugin-${plugin.id}.ts`);
  }
  await runLogged(job.id, `bash -lc ${ssh.shellQuote(uninstallRemoteScript(loc.path, dest, routeGuess))}`, 60000);
  if (plugin) {
    const rec = store.readInstalled();
    delete rec.plugins[plugin.id];
    store.writeInstalled(rec);
  }
  return { path: loc.path, composeService: loc.composeService || ssh.resolvedComposeService() };
}

async function performRebuild(job, ctPath, service) {
  appendJobLog(job.id, `Rebuilding CloudTAK API service ${service} with --no-cache (usually 5–15 minutes)`);
  await runLogged(job.id, `bash -lc ${ssh.shellQuote(rebuildRemoteScript(ctPath, service))}`, 20 * 60 * 1000);
}

async function runInstallBatch(jobs) {
  let lastLoc = null;
  let needsRebuild = false;
  for (const job of jobs) {
    updateJob(job.id, { status: "running", startedAt: new Date().toISOString() });
    try {
      const plugin = pluginById(job.pluginId);
      if (!plugin) throw new Error(`Plugin ${job.pluginId} is not in the catalog`);
      const loc = await performInstall(job, plugin);
      lastLoc = loc;
      if (!loc.skipRebuild) needsRebuild = true;
      updateJob(job.id, { extra: { ...(job.extra || {}), sha: loc.sha } });
    } catch (err) {
      updateJob(job.id, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: err.message || String(err),
      });
      appendJobLog(job.id, `FAILED ${err.message || err}`);
    }
  }
  const succeeded = store
    .readJobs()
    .jobs.filter((j) => jobs.some((x) => x.id === j.id) && j.status === "running");
  if (succeeded.length && lastLoc && needsRebuild) {
    try {
      await performRebuild(succeeded[0], lastLoc.path, lastLoc.composeService);
      for (const j of succeeded) {
        updateJob(j.id, { status: "complete", finishedAt: new Date().toISOString() });
        appendJobLog(j.id, "Complete. In CloudTAK use Settings → Refresh App.");
      }
    } catch (err) {
      for (const j of succeeded) {
        updateJob(j.id, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: err.message || String(err),
        });
        appendJobLog(j.id, `Rebuild failed: ${err.message || err}`);
      }
    }
  } else if (succeeded.length) {
    for (const j of succeeded) {
      updateJob(j.id, { status: "complete", finishedAt: new Date().toISOString() });
      appendJobLog(j.id, "Complete. In CloudTAK use Settings → Refresh App.");
    }
  }
  try {
    await scanHost();
    await refreshShaCache();
  } catch (err) {
    console.warn("[cloudtak-marketplace] rescan:", err?.message || err);
  }
}

async function runUninstallBatch(jobs) {
  let lastLoc = null;
  for (const job of jobs) {
    updateJob(job.id, { status: "running", startedAt: new Date().toISOString() });
    try {
      const plugin = job.pluginId ? pluginById(job.pluginId) : null;
      const dest = (job.extra && job.extra.dest) || (plugin && plugin.web.dest);
      if (!dest) throw new Error("Missing dest folder");
      lastLoc = await performUninstall(job, dest, plugin);
    } catch (err) {
      updateJob(job.id, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: err.message || String(err),
      });
      appendJobLog(job.id, `FAILED ${err.message || err}`);
    }
  }
  const succeeded = store
    .readJobs()
    .jobs.filter((j) => jobs.some((x) => x.id === j.id) && j.status === "running");
  if (succeeded.length && lastLoc) {
    try {
      await performRebuild(succeeded[0], lastLoc.path, lastLoc.composeService);
      for (const j of succeeded) {
        updateJob(j.id, { status: "complete", finishedAt: new Date().toISOString() });
        appendJobLog(j.id, "Complete. In CloudTAK use Settings → Refresh App.");
      }
    } catch (err) {
      for (const j of succeeded) {
        updateJob(j.id, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: err.message || String(err),
        });
      }
    }
  }
  try {
    await scanHost();
    await refreshShaCache();
  } catch (_) {}
}

async function claimAndRunJobs() {
  if (_jobRunning) return;
  if (!isEnabled()) return;
  const queued = store.readJobs().jobs.filter((j) => j.status === "queued");
  if (!queued.length) return;
  _jobRunning = true;
  try {
    const installs = queued.filter((j) => j.kind === "install" || j.kind === "update" || j.kind === "update-all");
    const uninstalls = queued.filter((j) => j.kind === "uninstall");
    const scans = queued.filter((j) => j.kind === "scan");
    const catalogs = queued.filter((j) => j.kind === "refresh-catalog");

    for (const job of catalogs) {
      updateJob(job.id, { status: "running", startedAt: new Date().toISOString() });
      appendJobLog(job.id, "Refreshing catalog…");
      const result = await fetchCatalog();
      if (result.ok) {
        appendJobLog(job.id, `Catalog updated (${result.catalog.plugins.length} plugins)`);
        updateJob(job.id, { status: "complete", finishedAt: new Date().toISOString() });
      } else {
        appendJobLog(job.id, `Fetch failed, using cached/bundled catalog: ${result.message}`);
        updateJob(job.id, {
          status: "complete",
          finishedAt: new Date().toISOString(),
          error: result.message,
        });
      }
    }

    for (const job of scans) {
      updateJob(job.id, { status: "running", startedAt: new Date().toISOString() });
      appendJobLog(job.id, "Scanning CloudTAK host…");
      const result = await scanHost();
      if (result.ok) {
        appendJobLog(job.id, `Scan complete (${(result.plugins || []).length} plugins on host)`);
        updateJob(job.id, { status: "complete", finishedAt: new Date().toISOString() });
      } else {
        updateJob(job.id, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: result.message,
        });
        appendJobLog(job.id, result.message || "Scan failed");
      }
    }

    if (installs.length) {
      const expanded = [];
      for (const job of installs) {
        if (job.kind === "update-all") {
          updateJob(job.id, { status: "running", startedAt: new Date().toISOString() });
          const snap = await getSnapshot();
          const pending = snap.plugins.filter((p) => p.installed && p.updateAvailable && p.catalog);
          if (!pending.length) {
            appendJobLog(job.id, "No updates available.");
            updateJob(job.id, { status: "complete", finishedAt: new Date().toISOString() });
            continue;
          }
          for (const p of pending) {
            appendJobLog(job.id, `Updating ${p.name}`);
          }
          let lastLoc = null;
          let needsRebuild = false;
          try {
            for (const p of pending) {
              lastLoc = await performInstall(job, p.catalog);
              if (lastLoc && !lastLoc.skipRebuild) needsRebuild = true;
            }
            if (lastLoc && needsRebuild) await performRebuild(job, lastLoc.path, lastLoc.composeService);
            updateJob(job.id, { status: "complete", finishedAt: new Date().toISOString() });
            appendJobLog(job.id, "Update all complete. In CloudTAK use Settings → Refresh App.");
            await scanHost();
            await refreshShaCache();
          } catch (err) {
            updateJob(job.id, {
              status: "failed",
              finishedAt: new Date().toISOString(),
              error: err.message || String(err),
            });
            appendJobLog(job.id, `FAILED ${err.message || err}`);
          }
        } else {
          expanded.push(job);
        }
      }
      const single = expanded.filter((j) => j.kind !== "update-all");
      if (single.length) await runInstallBatch(single);
    }

    if (uninstalls.length) await runUninstallBatch(uninstalls);
  } finally {
    _jobRunning = false;
  }
}

function notifyRecipients() {
  const explicit = String(getString("CLOUDTAK_MARKETPLACE_NOTIFY_TO", "")).trim();
  if (explicit) return explicit;
  const cc = String(getString("EMAIL_ALWAYS_CC", "")).trim();
  if (cc) return cc;
  return String(getString("SMTP_FROM", "")).trim();
}

async function maybeNotify() {
  if (!notifyEnabled()) return { sent: false, skipped: true };
  const to = notifyRecipients();
  if (!to) return { sent: false, skipped: true, message: "No notify recipients" };

  const catalog = loadCatalog();
  const state = store.readNotifyState();
  const seen = new Set(Array.isArray(state.seenPluginIds) ? state.seenPluginIds : []);
  const mailedNew = state.mailedNewIds && typeof state.mailedNewIds === "object" ? state.mailedNewIds : {};
  const mailedUp = state.mailedUpdateShas && typeof state.mailedUpdateShas === "object" ? state.mailedUpdateShas : {};

  const newPlugins = [];
  if (getBool("CLOUDTAK_MARKETPLACE_NOTIFY_NEW", true)) {
    for (const p of catalog.plugins) {
      if (seen.size && !seen.has(p.id) && !mailedNew[p.id]) newPlugins.push(p);
    }
  }

  const updates = [];
  if (getBool("CLOUDTAK_MARKETPLACE_NOTIFY_UPDATES", true)) {
    try {
      const snap = await getSnapshot();
      for (const row of snap.plugins) {
        if (!row.updateAvailable || !row.catalog) continue;
        const key = `${row.id}:${row.remoteSha || "unknown"}`;
        if (mailedUp[key]) continue;
        updates.push(row);
      }
    } catch (err) {
      console.warn("[cloudtak-marketplace] notify sha:", err?.message || err);
    }
  }

  const lines = [];
  if (newPlugins.length) {
    lines.push("New CloudTAK plugins in the catalog:");
    newPlugins.forEach((p) => lines.push(`- ${p.name} (${p.id})`));
  }
  if (updates.length) {
    if (lines.length) lines.push("");
    lines.push("Updates available for installed CloudTAK plugins:");
    updates.forEach((p) => lines.push(`- ${p.name} (${p.id})`));
  }
  if (!lines.length) {
    state.seenPluginIds = catalog.plugins.map((p) => p.id);
    state.lastNotifyAt = Date.now();
    store.writeNotifyState(state);
    return { sent: false, skipped: true };
  }

  const text = lines.join("\n");
  const result = await emailSvc.sendMail({
    to,
    subject: "CloudTAK Plugin Marketplace",
    text,
    html: `<pre style="font-family:sans-serif">${text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</pre>`,
  });

  if (result.sent) {
    for (const p of newPlugins) mailedNew[p.id] = true;
    for (const p of updates) mailedUp[`${p.id}:${p.remoteSha || "unknown"}`] = true;
    state.mailedNewIds = mailedNew;
    state.mailedUpdateShas = mailedUp;
    state.seenPluginIds = catalog.plugins.map((p) => p.id);
    state.lastNotifyAt = Date.now();
    store.writeNotifyState(state);
  }
  return result;
}

async function sendTestEmail() {
  const to = notifyRecipients();
  if (!emailSvc.isEmailEnabled()) {
    return { sent: false, message: "Email is disabled. Enable it under Settings → Email." };
  }
  if (!to) {
    return { sent: false, message: "Set notify recipients, Always CC, or SMTP From." };
  }
  const result = await emailSvc.sendMail({
    to,
    subject: "TAK Portal - CloudTAK Plugin Marketplace test",
    text: "CloudTAK Plugin Marketplace email alerts are working.",
  });
  if (result.skipped) return { sent: false, message: "Email is disabled." };
  if (!result.sent) return { sent: false, message: result.error || "Send failed." };
  return { sent: true };
}

async function workerTick() {
  if (!isEnabled()) return;
  try {
    await claimAndRunJobs();
  } catch (err) {
    console.warn("[cloudtak-marketplace] job tick:", err?.message || err);
  }
}

async function workerBackground() {
  if (!isEnabled()) return;
  const now = Date.now();
  if (now - _lastBackgroundAt < 15000) return;
  _lastBackgroundAt = now;
  const state = store.readNotifyState();
  if (!ssh.resolvedCheckoutPath()) {
    try {
      await detectAndPersist({ overwritePath: false });
    } catch (err) {
      console.warn("[cloudtak-marketplace] background detect:", err?.message || err);
    }
  }
  try {
    if (!state.lastCatalogAt || now - Number(state.lastCatalogAt || 0) > pollIntervalMs()) {
      await fetchCatalog();
      await maybeNotify();
    }
  } catch (err) {
    console.warn("[cloudtak-marketplace] catalog poll:", err?.message || err);
  }
  try {
    if (!state.lastScanAt || now - Number(state.lastScanAt || 0) > SCAN_INTERVAL_MS) {
      await scanHost();
      await refreshShaCache();
    }
  } catch (err) {
    console.warn("[cloudtak-marketplace] scan poll:", err?.message || err);
  }
}

function rememberSeenCatalog() {
  const catalog = loadCatalog();
  const state = store.readNotifyState();
  if (!Array.isArray(state.seenPluginIds) || !state.seenPluginIds.length) {
    state.seenPluginIds = catalog.plugins.map((p) => p.id);
    store.writeNotifyState(state);
  }
}

module.exports = {
  NEW_DAYS,
  isEnabled,
  notifyEnabled,
  defaultCatalogUrl,
  parseGitHubRepo,
  repoBasename,
  pluginMatchKey,
  isHostPluginNoise,
  normalizeCatalog,
  matchCatalogPlugin,
  loadCatalog,
  fetchCatalog,
  scanHost,
  getSnapshot,
  buildUiPlugins,
  refreshShaCache,
  enqueueJob,
  enqueueJobOnce,
  listJobs,
  clearIdleJobs,
  isActiveJob,
  claimAndRunJobs,
  workerTick,
  workerBackground,
  sendTestEmail,
  maybeNotify,
  rememberSeenCatalog,
  notifyRecipients,
  isEnabledValue,
  detectAndPersist,
  persistDetectedPath,
  onEnabled,
};
