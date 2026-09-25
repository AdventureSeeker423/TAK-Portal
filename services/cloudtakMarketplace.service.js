"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const { getString, getInt, getBool } = require("./env");
const emailSvc = require("./email.service");
const store = require("./cloudtakMarketplace.store");
const ssh = require("./cloudtakMarketplace.ssh");
const caddyMod = require("./cloudtakMarketplace.caddy");
const settingsSvc = require("./settings.service");

const NEW_DAYS = 14;
const SCAN_INTERVAL_MS = 5 * 60 * 1000;

let _jobRunning = false;
let _cancelRequested = false;
let _lastBackgroundAt = 0;
let _uiSnapshot = null;
let _uiSnapshotAt = 0;

function cancelledError() {
  const err = new Error("Cancelled.");
  err.cancelled = true;
  return err;
}

function isCancelledError(err) {
  if (!err) return false;
  if (err.cancelled) return true;
  return /cancelled/i.test(String(err.message || err));
}

function throwIfCancelled() {
  if (_cancelRequested) throw cancelledError();
}

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

const CSP_DIRECTIVES = new Set([
  "connect-src",
  "img-src",
  "media-src",
  "font-src",
  "worker-src",
  "style-src-elem",
  "style-src-attr",
  "default-src",
]);
const CSP_SOURCE_RE = /^[A-Za-z0-9.:/*_'~%+-]+$/;
const CSP_DIR_ALIASES = {
  connect: "connect-src",
  connectsrc: "connect-src",
  "connect-src": "connect-src",
  img: "img-src",
  image: "img-src",
  images: "img-src",
  imgsrc: "img-src",
  "img-src": "img-src",
  media: "media-src",
  "media-src": "media-src",
  font: "font-src",
  "font-src": "font-src",
  worker: "worker-src",
  "worker-src": "worker-src",
  style: "style-src-elem",
  "style-src": "style-src-elem",
  "style-src-elem": "style-src-elem",
  "style-src-attr": "style-src-attr",
  default: "default-src",
  "default-src": "default-src",
};

function cspDirectiveName(raw) {
  const key = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  return CSP_DIR_ALIASES[key] || (CSP_DIRECTIVES.has(key) ? key : "");
}

function cspSourcesFromText(text) {
  return String(text || "")
    .split(/[\s,]+/)
    .map((s) => String(s || "").trim())
    .filter((s) => CSP_SOURCE_RE.test(s) && /^(https?:|wss?:)/i.test(s));
}

function inferCspDirectives(src) {
  if (/^wss?:/i.test(src)) return ["connect-src"];
  if (/^https?:/i.test(src)) return ["connect-src", "img-src"];
  return ["connect-src"];
}

function addCspSource(out, dir, src) {
  const directive = cspDirectiveName(dir);
  const source = String(src || "").trim();
  if (!directive || !CSP_SOURCE_RE.test(source)) return;
  if (!out[directive]) out[directive] = [];
  if (!out[directive].includes(source)) out[directive].push(source);
}

function addCspSourceInferred(out, src, dirs) {
  const source = String(src || "").trim();
  const list = Array.isArray(dirs) && dirs.length ? dirs : inferCspDirectives(source);
  list.forEach((dir) => addCspSource(out, dir, source));
}

function ingestCspValue(out, value, dir) {
  if (value == null || value === "") return;
  if (Array.isArray(value)) {
    value.forEach((item) => ingestCspValue(out, item, dir));
    return;
  }
  if (typeof value === "string") {
    const sources = cspSourcesFromText(value);
    (sources.length ? sources : [value.trim()]).forEach((src) => {
      if (dir) addCspSource(out, dir, src);
      else addCspSourceInferred(out, src);
    });
    return;
  }
  if (typeof value !== "object") return;
  const src = String(value.src || value.source || value.host || value.url || "").trim();
  const nestedDirs = []
    .concat(value.directives || value.directive || value.kind || [])
    .map(cspDirectiveName)
    .filter(Boolean);
  if (src) {
    addCspSourceInferred(out, src, nestedDirs.length ? nestedDirs : dir ? [dir] : null);
    return;
  }
  Object.entries(value).forEach(([key, nested]) => {
    if (["src", "source", "host", "url", "directives", "directive", "kind"].includes(key)) return;
    const mapped = cspDirectiveName(key);
    if (mapped) ingestCspValue(out, nested, mapped);
    else if (key === "sources" || key === "hosts") ingestCspValue(out, nested, dir);
  });
}

function cspFromAdditionalActions(p) {
  const raw = p && p.additionalActions;
  const items = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const out = {};
  items.forEach((item) => {
    const action = additionalActionFromRaw(item);
    if (!action) return;
    const blob = [action.kind, action.title, action.text, action.snippet].join(" ");
    if (/\b(caddy|reverse_proxy|handle_path|Caddyfile)\b/i.test(blob)) return;
    const kind = String(action.kind || "").toLowerCase();
    const snippetSources = cspSourcesFromText(action.snippet);
    const kindIsCsp = /\b(csp|nginx)\b/.test(kind);
    const snippetIsCspOnly =
      snippetSources.length > 0 &&
      action.snippet.split(/[\s,]+/).filter(Boolean).every((t) => cspSourcesFromText(t).length > 0);
    if (!kindIsCsp && !snippetIsCspOnly) return;
    const dirs = [];
    if (/img/.test(kind) || /\bimg-src\b/i.test(blob)) dirs.push("img-src");
    if (/connect|wss|websocket/.test(kind) || /\bconnect-src\b/i.test(blob)) dirs.push("connect-src");
    snippetSources.forEach((src) => addCspSourceInferred(out, src, dirs.length ? dirs : null));
  });
  return out;
}

function normalizeCsp(p) {
  const out = {};
  ingestCspValue(out, p && p.csp);
  ingestCspValue(out, p && p.cspSources);
  ingestCspValue(out, p && p.cspHosts);
  const extra = cspFromAdditionalActions(p);
  Object.entries(extra).forEach(([dir, sources]) => {
    sources.forEach((src) => addCspSource(out, dir, src));
  });
  return out;
}

function cspSpecText(plugin) {
  const csp = normalizeCsp(plugin);
  const lines = [];
  Object.keys(csp)
    .sort()
    .forEach((dir) => {
      csp[dir].forEach((src) => lines.push(`${dir} ${src}`));
    });
  return lines.join("\n");
}

function pluginHasCsp(p) {
  return Object.keys(normalizeCsp(p)).length > 0;
}

function isProxyOperatorNote(text) {
  return /\b(caddy|nginx|csp|connect-src|reverse.?proxy|Caddyfile)\b/i.test(String(text || ""));
}

function isInstallerHandledNote(text) {
  return /\b(docker|sidecar|compose|webhook process|does not start)\b/i.test(String(text || "")) &&
    !isProxyOperatorNote(text);
}

function isInstallerHandledCsp(p, action) {
  if (!pluginHasCsp(p)) return false;
  return /\b(nginx|csp|connect-src|img-src|nginx\.conf)\b/i.test(
    [action && action.title, action && action.text, action && action.snippet].join(" ")
  );
}

function additionalActionFromRaw(item) {
  if (typeof item === "string") {
    const text = item.trim();
    if (!text) return null;
    return { kind: "note", title: "", text, instructions: [], snippet: "" };
  }
  if (!item || typeof item !== "object") return null;
  const text = String(item.text || item.note || item.action || item.label || "").trim();
  const title = String(item.title || "").trim();
  const kind = String(item.kind || item.type || "").trim() || (item.snippet ? "config" : "note");
  const instructions = Array.isArray(item.instructions)
    ? item.instructions.map((s) => String(s || "").trim()).filter(Boolean)
    : [];
  const snippet = String(item.snippet || item.config || "").trim();
  if (!text && !title && !instructions.length && !snippet) return null;
  return { kind, title, text, instructions, snippet };
}

function additionalActionKey(action) {
  return [
    action.kind,
    action.title,
    action.text,
    (action.instructions || []).join("\n"),
    action.snippet,
  ].join("\0");
}

function normalizeAdditionalActions(p) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const action = additionalActionFromRaw(raw);
    if (!action) return;
    if (isInstallerHandledNote(action.text) && !action.snippet && !action.instructions.length) return;
    if (isInstallerHandledCsp(p, action)) return;
    const key = additionalActionKey(action);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(action);
  };
  const raw = p && p.additionalActions;
  if (Array.isArray(raw)) {
    raw.forEach(push);
  } else if (typeof raw === "string") {
    String(raw)
      .split(/\n|;/)
      .forEach(push);
  }
  if (!out.length && Array.isArray(p && p.sidecars)) {
    for (const s of p.sidecars) {
      if (typeof s === "string") {
        if (isProxyOperatorNote(s)) push(s);
      } else if (s && typeof s === "object") {
        const note = s.note || s.action || s.text;
        if (note && isProxyOperatorNote(note)) push(s);
      }
    }
  }
  return out;
}

function pluginRuntimeHints(plugin) {
  const list = Array.isArray(plugin && plugin.sidecars) ? plugin.sidecars : [];
  const obj = list.find((s) => s && typeof s === "object") || {};
  return {
    composeFile: String((plugin && plugin.composeFile) || obj.file || "").trim(),
    composeService: String((plugin && plugin.composeService) || obj.service || "").trim(),
    sidecarDir: String(obj.dir || obj.path || "").trim(),
    sidecarPort: String(obj.port || "").trim(),
  };
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
      additionalActions: normalizeAdditionalActions(p),
      description: String(p.description || ""),
      maintainer: String(p.maintainer || ""),
      added: String(p.added || ""),
      installScript: String(p.installScript || "").trim(),
      composeService: String(p.composeService || "").trim(),
      composeFile: String(p.composeFile || "").trim(),
      sidecars: Array.isArray(p.sidecars) ? p.sidecars : [],
      csp: normalizeCsp(p),
    });
  }
  return { version: Number(doc && doc.version) || 1, plugins: out, fetchedAt: doc && doc.fetchedAt ? doc.fetchedAt : null };
}

function mergeCatalogPlugin(seed, remote) {
  if (seed && remote) {
    return {
      ...remote,
      ...seed,
      web: { ...(remote.web || {}), ...(seed.web || {}) },
      routes: seed.routes || remote.routes,
      installScript: seed.installScript || remote.installScript,
      detect: seed.detect && seed.detect.length ? seed.detect : remote.detect,
      detectAliases: seed.detectAliases && seed.detectAliases.length ? seed.detectAliases : remote.detectAliases,
      exclude: seed.exclude && seed.exclude.length ? seed.exclude : remote.exclude,
      additionalActions:
        seed.additionalActions && seed.additionalActions.length ? seed.additionalActions : remote.additionalActions,
      sidecars: seed.sidecars && seed.sidecars.length ? seed.sidecars : remote.sidecars,
      csp:
        seed.csp && Object.keys(seed.csp).length
          ? seed.csp
          : remote.csp && Object.keys(remote.csp).length
            ? remote.csp
            : {},
      notes: seed.notes || remote.notes,
      description: seed.description || remote.description,
      name: seed.name || remote.name,
      maintainer: seed.maintainer || remote.maintainer,
    };
  }
  return seed || remote;
}

function loadCatalog() {
  const bundled = normalizeCatalog(store.readBundledCatalog());
  const cached = store.readPluginsCache();
  if (!cached || !Array.isArray(cached.plugins) || !cached.plugins.length) {
    return bundled;
  }
  const remote = normalizeCatalog(cached);
  const bundledById = new Map(bundled.plugins.map((p) => [p.id, p]));
  const remoteById = new Map(remote.plugins.map((p) => [p.id, p]));
  const ids = [];
  const seen = new Set();
  for (const p of bundled.plugins) {
    ids.push(p.id);
    seen.add(p.id);
  }
  for (const p of remote.plugins) {
    if (seen.has(p.id)) continue;
    ids.push(p.id);
    seen.add(p.id);
  }
  return {
    version: bundled.version || remote.version,
    fetchedAt: remote.fetchedAt,
    plugins: ids.map((id) => mergeCatalogPlugin(bundledById.get(id), remoteById.get(id))),
  };
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

function caddyCacheRecord(probe) {
  return {
    available: !!(probe && probe.available),
    via: (probe && probe.via) || "",
    path: (probe && probe.hostPath) || "",
    checkedAt: (probe && probe.checkedAt) || new Date().toISOString(),
    applied: probe && Array.isArray(probe.applied) ? probe.applied : [],
    message: (probe && probe.message) || "",
  };
}

function saveCaddyCache(probe) {
  const prev = store.readScanCache();
  const record = caddyCacheRecord(probe);
  if (!prev) {
    store.writeScanCache({ plugins: [], caddy: record });
    return record;
  }
  prev.caddy = record;
  store.writeScanCache(prev);
  return record;
}

async function probeHostCaddy(opts = {}) {
  const prev = store.readScanCache();
  const checked = prev && prev.caddy ? Date.parse(prev.caddy.checkedAt || "") : NaN;
  if (!opts.force && prev && prev.caddy && Number.isFinite(checked) && Date.now() - checked < 60 * 1000) {
    return { ...prev.caddy, file: "", cached: true };
  }
  const ct = ssh.resolvedCheckoutPath() || (prev && prev.path) || "";
  const result = await ssh.runCommand(`bash -lc ${ssh.shellQuote(caddyMod.discoverScript(ct))}`, 45000);
  const checkedAt = new Date().toISOString();
  if (!result.ok) {
    const probe = {
      available: false,
      applied: [],
      message: result.message || "Could not look for Caddy.",
      checkedAt,
    };
    if (opts.persist !== false) saveCaddyCache(probe);
    return probe;
  }
  const probe = caddyMod.parseProbe(result.stdout);
  probe.checkedAt = checkedAt;
  probe.applied = probe.file ? caddyMod.appliedKeys(loadCatalog().plugins, probe.file, { host: cloudtakPublicHost() }) : [];
  if (opts.persist !== false) saveCaddyCache(probe);
  return probe;
}

const CADDY_RECHECK_MS = 2 * 60 * 1000;
let _lastCaddyRecheckAt = 0;

async function recheckCaddyFile() {
  if (!isEnabled() || hasBusyChangeJobs()) return null;
  const now = Date.now();
  if (now - _lastCaddyRecheckAt < CADDY_RECHECK_MS) return null;
  _lastCaddyRecheckAt = now;
  const prev = store.readScanCache();
  const hostPath = prev && prev.caddy && prev.caddy.path ? String(prev.caddy.path) : "";
  if (!hostPath) return null;
  const result = await ssh.runCommand(
    `bash -lc ${ssh.shellQuote(`cat -- ${ssh.shellQuote(hostPath)}`)}`,
    20000
  );
  if (!result.ok) return null;
  const applied = caddyMod.appliedKeys(loadCatalog().plugins, result.stdout || "", { host: cloudtakPublicHost() });
  saveCaddyCache({
    ...(prev.caddy || {}),
    available: true,
    applied,
    checkedAt: new Date().toISOString(),
    file: "",
  });
  refreshUiSnapshot();
  return applied;
}

function cloudtakPublicHost() {
  const raw = String(getString("CLOUDTAK_URL", "") || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch (_) {
    return "";
  }
}

async function deployPluginCaddy(pluginId) {
  const catalog = loadCatalog();
  const plugin = catalog.plugins.find((p) => p.id === pluginId);
  if (!plugin) return { ok: false, message: "Plugin is not in the catalog." };
  const actions = (plugin.additionalActions || []).filter(caddyMod.isCaddyAction);
  if (!actions.length) return { ok: false, message: "This plugin has no Caddy configuration." };
  const probe = await probeHostCaddy({ force: true, persist: false });
  if (!probe.available) return { ok: false, message: "Caddy is not running on the CloudTAK host." };
  if (!probe.hostPath || !probe.file) {
    return { ok: false, message: "Caddy is running, but its Caddyfile was not found on the host." };
  }
  const edited = caddyMod.applyCaddySnippets(
    probe.file,
    actions.map((action) => action.snippet),
    { host: cloudtakPublicHost() }
  );
  const appliedNow = caddyMod.appliedKeys(catalog.plugins, edited.ok ? edited.text : probe.file, { host: cloudtakPublicHost() });
  if (!edited.ok) {
    saveCaddyCache({ ...probe, applied: caddyMod.appliedKeys(catalog.plugins, probe.file, { host: cloudtakPublicHost() }) });
    refreshUiSnapshot();
    return { ok: false, message: edited.message };
  }
  if (!edited.changed) {
    saveCaddyCache({ ...probe, applied: appliedNow });
    refreshUiSnapshot();
    return { ok: true, changed: false, message: "Caddy already has this plugin's routes." };
  }
  const write = await ssh.runCommand(
    `bash -lc ${ssh.shellQuote(
      caddyMod.applyScript({
        b64: Buffer.from(edited.text, "utf8").toString("base64"),
        hostPath: probe.hostPath,
        via: probe.via,
        validateCmd: probe.validateCmd,
        reloadCmd: probe.reloadCmd,
      })
    )}`,
    60000
  );
  if (!write.ok || !/APPLY_OK/.test(write.stdout || "")) {
    return { ok: false, message: write.message || "Caddy update failed." };
  }
  saveCaddyCache({ ...probe, applied: appliedNow });
  refreshUiSnapshot();
  return { ok: true, changed: true, message: "Updated the CloudTAK Caddy site and reloaded Caddy." };
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

  let caddy = { available: false, applied: [], checkedAt: new Date().toISOString() };
  try {
    caddy = await probeHostCaddy({ force: true, persist: false });
  } catch (err) {
    caddy = { available: false, applied: [], message: err?.message || String(err), checkedAt: new Date().toISOString() };
  }
  const cache = {
    scannedAt: new Date().toISOString(),
    path: loc.path,
    composeService: loc.composeService || ssh.resolvedComposeService(),
    ok: true,
    plugins: found,
    routeFiles: parsed.routeFiles,
    caddy: caddyCacheRecord(caddy),
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

function pluginErrorMessage(installedRec, id, dest) {
  const plugins = (installedRec && installedRec.plugins) || {};
  const byId = id ? plugins[id] : null;
  if (byId && byId.lastError) return String(byId.lastError);
  const destKey = String(dest || "").toLowerCase();
  if (!destKey) return "";
  for (const row of Object.values(plugins)) {
    if (row && String(row.dest || "").toLowerCase() === destKey && row.lastError) {
      return String(row.lastError);
    }
  }
  return "";
}

function setInstalledError(id, dest, message) {
  const key = String(id || dest || "").trim();
  if (!key) return;
  const rec = store.readInstalled();
  const prev = rec.plugins[key] && typeof rec.plugins[key] === "object" ? rec.plugins[key] : {};
  rec.plugins[key] = {
    ...prev,
    dest: dest || prev.dest || "",
    lastError: String(message || "Install failed."),
    lastErrorAt: new Date().toISOString(),
  };
  store.writeInstalled(rec);
}

function clearInstalledError(id) {
  const key = String(id || "").trim();
  if (!key) return;
  const rec = store.readInstalled();
  if (!rec.plugins[key] || !rec.plugins[key].lastError) return;
  const next = { ...rec.plugins[key] };
  delete next.lastError;
  delete next.lastErrorAt;
  rec.plugins[key] = next;
  store.writeInstalled(rec);
}

function jobPluginIds(job) {
  const extraIds = job && job.extra && Array.isArray(job.extra.pluginIds) ? job.extra.pluginIds : null;
  if (extraIds && extraIds.length) {
    return extraIds.map((id) => String(id || "").trim()).filter(Boolean);
  }
  return job && job.pluginId ? [String(job.pluginId)] : [];
}

function markJobInstallError(job, message) {
  if (!job || job.kind === "uninstall") return;
  const ids = jobPluginIds(job);
  if (!ids.length) {
    const dest = job.extra && job.extra.dest;
    if (dest) setInstalledError(dest, dest, message);
    return;
  }
  for (const id of ids) {
    const plugin = pluginById(id);
    const dest = (job.extra && job.extra.dest) || (plugin && plugin.web && plugin.web.dest) || "";
    setInstalledError(id, dest, message);
  }
}

function clearJobInstallError(job) {
  for (const id of jobPluginIds(job)) clearInstalledError(id);
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
    const rec = installedRec.plugins[p.id];
    const errorMessage = pluginErrorMessage(installedRec, p.id, p.web.dest);
    const installed = !!(scanHit || rec);
    const extra = caddyMod.extraConfigStatus(p.additionalActions, scan && scan.caddy);
    byId.set(p.id, {
      id: p.id,
      name: p.name,
      description: p.description,
      maintainer: p.maintainer,
      repo: p.repo,
      ref: p.ref,
      notes: p.notes,
      additionalActions: Array.isArray(p.additionalActions) ? p.additionalActions : [],
      caddyOnHost: extra.caddyOnHost,
      hasCaddyActions: extra.hasCaddyActions,
      caddyPending: extra.caddyPending,
      extraConfigComplete: extra.complete,
      added: p.added,
      isNew: installed ? false : isNewPlugin(p, now),
      installed,
      error: !!errorMessage,
      errorMessage,
      origin: scanHit ? scanHit.origin : rec ? "marketplace" : "",
      layout: {
        web: true,
        routes: !!p.routes,
        sidecar: !!(p.composeFile || p.composeService || (Array.isArray(p.sidecars) && p.sidecars.length)),
      },
      dest: p.web.dest,
      catalog: p,
      scan: scanHit || null,
      unknown: false,
    });
  }
  const destListed = (dest) =>
    [...byId.values()].some((row) => String(row.dest || "").toLowerCase() === String(dest || "").toLowerCase());
  const hostOnlyPlugin = ({ id, dest, repo, scan }) => {
    const errorMessage = pluginErrorMessage(installedRec, id, dest);
    return {
      id,
      name: dest,
      description: "Installed on this CloudTAK host. Not in the marketplace catalog.",
      maintainer: "",
      repo: repo || "",
      ref: "",
      notes: "",
      additionalActions: [],
      added: "",
      isNew: false,
      installed: true,
      error: !!errorMessage,
      errorMessage,
      origin: "unknown",
      layout: { web: true, routes: false, sidecar: false },
      dest,
      catalog: null,
      scan: scan || null,
      unknown: true,
    };
  };
  for (const s of scanPlugins) {
    if (s.catalogId && byId.has(s.catalogId)) continue;
    if (!s.dest || destListed(s.dest)) continue;
    const id = s.catalogId || `unknown:${s.dest}`;
    byId.set(id, hostOnlyPlugin({ id, dest: s.dest, repo: s.gitRemote || "", scan: s }));
  }
  for (const [id, rec] of Object.entries(installedRec.plugins || {})) {
    if (byId.has(id)) continue;
    const dest = String((rec && rec.dest) || "").trim();
    if (!dest || !safeDestName(dest) || destListed(dest)) continue;
    byId.set(id, hostOnlyPlugin({ id, dest, repo: (rec && rec.repo) || "", scan: null }));
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

function refreshUiSnapshot() {
  if (!isEnabled()) {
    _uiSnapshot = null;
    _uiSnapshotAt = 0;
    return null;
  }
  _uiSnapshot = buildUiPlugins({ skipRemoteSha: true });
  _uiSnapshotAt = Date.now();
  return _uiSnapshot;
}

const UI_SNAPSHOT_MS = 20 * 1000;

function uiSnapshot() {
  if (!isEnabled()) return buildUiPlugins({ skipRemoteSha: true });
  if (_uiSnapshot && Date.now() - _uiSnapshotAt < UI_SNAPSHOT_MS) return _uiSnapshot;
  return refreshUiSnapshot();
}

function jobKey(job) {
  return String((job && job.pluginId) || (job && job.extra && job.extra.dest) || "").trim();
}

function makeJob({ kind, pluginId, createdBy, extra, status }) {
  return {
    id: crypto.randomUUID(),
    kind: String(kind || "").trim(),
    pluginId: pluginId || null,
    status: status || "queued",
    createdBy: createdBy || null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    log: [],
    error: null,
    extra: extra || null,
  };
}

function enqueueJob({ kind, pluginId, createdBy, extra, status }) {
  const job = makeJob({ kind, pluginId, createdBy, extra, status: status || "queued" });
  store.withJobs((jobs) => [job, ...jobs].slice(0, store.MAX_JOBS));
  return job;
}

function stageJob({ kind, pluginId, createdBy, extra, toggle }) {
  const incoming = makeJob({ kind, pluginId, createdBy, extra, status: "staged" });
  const key = jobKey(incoming);
  let removed = null;
  let replaced = null;
  let job = incoming;
  store.withJobs((jobs) => {
    const same = jobs.find((j) => j.status === "staged" && j.kind === kind && jobKey(j) === key);
    if (same) {
      if (toggle === false) {
        job = same;
        return jobs;
      }
      removed = same;
      return jobs.filter((j) => j.id !== same.id);
    }
    const rest = jobs.filter((j) => {
      if (j.status !== "staged") return true;
      if (jobKey(j) !== key) return true;
      replaced = j;
      return false;
    });
    return [job, ...rest].slice(0, store.MAX_JOBS);
  });
  if (removed) return { ok: true, job: null, removed: true, previous: removed };
  return { ok: true, job, removed: false, replaced: replaced || undefined };
}

function unstageJob(jobId) {
  const id = String(jobId || "").trim();
  let removed = null;
  store.withJobs((jobs) => {
    const hit = jobs.find((j) => j.id === id && j.status === "staged");
    if (!hit) return jobs;
    removed = hit;
    return jobs.filter((j) => j.id !== id);
  });
  return { ok: !!removed, job: removed };
}

function deployStaged() {
  let count = 0;
  const batchId = crypto.randomUUID();
  store.withJobs((jobs) =>
    jobs.map((j) => {
      if (j.status !== "staged") return j;
      count += 1;
      return { ...j, status: "queued", batchId, log: [] };
    })
  );
  return { ok: true, count, batchId: count ? batchId : null };
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
  refreshUiSnapshot();
  return { ok: true };
}

const MAX_JOB_LOG_LINES = 2500;

function isNoisyBuildLine(s) {
  const t = String(s || "")
    .replace(/^\s*(=>\s*)+/, "")
    .replace(/^#\s*/, "")
    .trim();
  if (!t) return true;
  if (/^dist\/(?:assets\/|\.vite\/)/.test(t) || /\/dist\/(?:assets\/|\.vite\/)/.test(t)) return true;
  if (/\bkB\b/.test(t) && /gzip:/i.test(t)) return true;
  if (/Unexpected any\. Specify a different type/.test(t)) return true;
  if (/^\d+:\d+\s+warning\b/.test(t)) return true;
  if (/^\/home\/etl\//.test(t)) return true;
  if (/^✖ \d+ problems/.test(t)) return true;
  return false;
}

function formatRemoteLogLine(line) {
  let s = String(line || "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*\u0007/g, "")
    .replace(/\s+$/, "");
  if (!s) return "";
  if (/^(UNINSTALL_OK|REBUILD_OK|INSTALL_OK)$/.test(s) || s.startsWith("INSTALL_SHA ")) return "";
  if (/^--progress is a global compose flag/.test(s)) return "";
  if (/^\$\s*bash\s+-lc/.test(s)) return "";

  let m = s.match(/^#\d+\s+(\[[^\]]+\])\s+(.*)$/);
  if (m) {
    if (/^(DONE|CACHED)\b/.test(m[2])) return ` => ${m[1]} ${m[2]}`;
    return ` => ${m[1]} ${m[2]}`;
  }
  if (/^#\d+\s+DONE\s+/.test(s) || /^#\d+\s+CACHED$/.test(s)) return "";
  m = s.match(/^#\d+\s+\d+(?:\.\d+)?\s+(.*)$/);
  if (m) s = ` => => # ${m[1]}`;
  else {
    m = s.match(/^#\d+\s+(.*)$/);
    if (m) s = ` => => # ${m[1]}`;
  }
  m = s.match(/^Image\s+(.+)\s+Building$/);
  if (m) return `[+] Building ${m[1]}`;
  if (isNoisyBuildLine(s)) return "";
  return s;
}

function summarizeCommandError(message) {
  const lines = String(message || "")
    .split(/\r?\n/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!lines.length) return "SSH command failed";
  const clip = (s) => (s.length > 220 ? s.slice(0, 217) + "..." : s);
  const interesting = /failed to solve|invalid compose|ERROR:|exit code|✖\s+\d+\s+problems|EACCES|permission denied|Could not|not found|Refusing /i;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].replace(/^#\d+\s+/, "").replace(/^(?:=>\s*)+/, "");
    if (line.length > 400) continue;
    if (/^Dockerfile:\d+$/.test(line) || /^-{3,}$/.test(line)) continue;
    if (interesting.test(line)) return clip(line);
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line.length > 240) continue;
    if (/^#\d+\b/.test(line) || /^(?:=>\s*)+/.test(line) || /^Dockerfile:/.test(line) || /^-{3,}$/.test(line)) continue;
    return clip(line);
  }
  return clip(lines[lines.length - 1]);
}

function appendJobLog(jobId, line) {
  const text = formatRemoteLogLine(line);
  if (!text) return;
  store.withJobs((jobs) =>
    jobs.map((j) => {
      if (j.id !== jobId) return j;
      const log = Array.isArray(j.log) ? j.log.slice() : [];
      log.push(text);
      if (log.length > MAX_JOB_LOG_LINES) log.splice(0, log.length - MAX_JOB_LOG_LINES);
      return { ...j, log };
    })
  );
}

function updateJob(jobId, patch) {
  store.withJobs((jobs) =>
    jobs.map((j) => {
      if (j.id !== jobId) return j;
      if (j.status === "cancelled") return j;
      return { ...j, ...patch };
    })
  );
}

function listJobs() {
  return store.readJobs().jobs;
}

function isBusyJob(job) {
  const status = String((job && job.status) || "");
  return status === "queued" || status === "running";
}

function isChangeKind(kind) {
  return ["install", "update", "uninstall", "update-all"].includes(String(kind || ""));
}

function newestJobStamp(job) {
  return String((job && (job.startedAt || job.finishedAt || job.createdAt)) || "");
}

/** Jobs whose log should be on screen: the deploy that is running, or the latest one that finished. */
function selectLogJobs(jobs) {
  const list = (Array.isArray(jobs) ? jobs : []).filter((j) => j && j.status !== "staged");
  const deploy = list.filter((j) => isChangeKind(j.kind));
  const live = deploy.filter((j) => isBusyJob(j));
  if (live.length) {
    const batch = live.map((j) => j.batchId).find(Boolean) || "";
    if (batch) return deploy.filter((j) => j.batchId === batch);
    return live;
  }
  const withBatch = deploy.filter((j) => j.batchId);
  if (withBatch.length) {
    const newest = withBatch.reduce((best, job) => (newestJobStamp(job) > newestJobStamp(best) ? job : best));
    return deploy.filter((j) => j.batchId === newest.batchId);
  }
  const finished = deploy.filter((j) => !isBusyJob(j));
  if (finished.length) return [finished[0]];
  return list.slice(0, 12);
}

function hasBusyChangeJobs() {
  return store.readJobs().jobs.some((j) => isBusyJob(j) && isChangeKind(j.kind));
}

function isKeptJob(job) {
  const status = String((job && job.status) || "");
  return isBusyJob(job) || status === "staged";
}

function clearIdleJobs() {
  const jobs = store.readJobs().jobs;
  if (jobs.some(isBusyJob)) return jobs;
  return store.withJobs((current) => {
    if (current.some(isBusyJob)) return current;
    return current.filter(isKeptJob);
  }).jobs;
}

function cancelCurrentJobs() {
  _cancelRequested = true;
  const interrupted = ssh.abortActiveCommand();
  const now = new Date().toISOString();
  let count = 0;
  const result = store.withJobs((jobs) =>
    jobs.map((j) => {
      if (!isBusyJob(j)) return j;
      count += 1;
      const log = Array.isArray(j.log) ? j.log.slice() : [];
      if (interrupted && j.status === "running") {
        log.push("Sending Ctrl+C to the running host command.");
      }
      if (!log.length || log[log.length - 1] !== "Cancelled.") log.push("Cancelled.");
      return {
        ...j,
        status: "cancelled",
        finishedAt: now,
        error: "Cancelled.",
        log,
      };
    })
  );
  if (!count) _cancelRequested = false;
  return { ok: true, count, jobs: result.jobs };
}

function pluginById(id) {
  return loadCatalog().plugins.find((p) => p.id === id) || null;
}

function safeDestName(name) {
  return /^[A-Za-z0-9._-]+$/.test(String(name || ""));
}

function normalizeInstallScript(script) {
  const raw = String(script || "").trim();
  if (!raw) return "";
  const parts = raw.split(/\s+/);
  const cmd = parts[0];
  if (cmd && !cmd.startsWith("/") && !cmd.startsWith("./") && cmd !== "bash" && cmd !== "sh") {
    parts[0] = `./${cmd}`;
  }
  return parts.join(" ");
}

/** Entry files that stay at the CloudTAK plugin dest root (Vite glob: plugins/<name>/index.ts). */
const SAMPLE_PLUGIN_ROOT_KEEP = [
  "index.ts",
  "index.js",
  "index.tsx",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "eslint.config.js",
  "eslint.config.ts",
  "env.d.ts",
  "LICENSE",
  "LICENCE",
  "COPYING",
  "README.md",
  "README",
];

/** Assets that belong under lib/ in the official CloudTAK sample layout. */
const SAMPLE_PLUGIN_NEST_EXT = [
  ".ts",
  ".tsx",
  ".vue",
  ".svg",
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".scss",
  ".sass",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".ico",
];

function pluginEntryImportsLib(source) {
  return /['"]\.\/lib\//.test(String(source || ""));
}

function shouldNestFlatPluginFile(name) {
  const base = String(name || "");
  if (!base || SAMPLE_PLUGIN_ROOT_KEEP.includes(base)) return false;
  const lower = base.toLowerCase();
  return SAMPLE_PLUGIN_NEST_EXT.some((ext) => lower.endsWith(ext));
}

function readPluginEntrySource(destDir) {
  for (const name of ["index.ts", "index.tsx", "index.js"]) {
    const full = path.join(destDir, name);
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        return { name, source: fs.readFileSync(full, "utf8") };
      }
    } catch (_) {}
  }
  return null;
}

/**
 * Official sample layout is index.ts at dest root and Vue/TS/assets in lib/.
 * Some catalog repos copy that import style but leave the files flat at repo root.
 * Nest those siblings into lib/ so vue-tsc and Vite resolve ./lib/... .
 * No-op when lib/ already exists (HelloWorld, QPD, dispatcher, etc.).
 */
function normalizeFlatSamplePluginTree(destDir) {
  const dest = String(destDir || "").trim();
  if (!dest) return { ok: false, changed: false, moved: 0 };
  let destStat = null;
  try {
    destStat = fs.statSync(dest);
  } catch (_) {
    return { ok: false, changed: false, moved: 0 };
  }
  if (!destStat.isDirectory()) return { ok: false, changed: false, moved: 0 };

  const gitDir = path.join(dest, ".git");
  try {
    if (fs.existsSync(gitDir)) fs.rmSync(gitDir, { recursive: true, force: true });
  } catch (_) {}

  const libDir = path.join(dest, "lib");
  if (fs.existsSync(libDir)) return { ok: true, changed: false, moved: 0, reason: "lib-exists" };

  const entry = readPluginEntrySource(dest);
  if (!entry || !pluginEntryImportsLib(entry.source)) {
    return { ok: true, changed: false, moved: 0 };
  }

  fs.mkdirSync(libDir, { recursive: true });
  let moved = 0;
  for (const name of fs.readdirSync(dest)) {
    if (name === "lib") continue;
    const full = path.join(dest, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch (_) {
      continue;
    }
    if (!st.isFile()) continue;
    if (!shouldNestFlatPluginFile(name)) continue;
    fs.renameSync(full, path.join(libDir, name));
    moved += 1;
  }
  return { ok: true, changed: moved > 0, moved };
}

function flatSampleLibNormalizeBash() {
  const keep = SAMPLE_PLUGIN_ROOT_KEEP.join("|");
  const glob = SAMPLE_PLUGIN_NEST_EXT.map((ext) => `*${ext}`).join("|");
  return [
    'target="$1"',
    '[ -n "$target" ] && [ -d "$target" ] || exit 0',
    'rm -rf "$target/.git" || true',
    'entry=""',
    'if [ -f "$target/index.ts" ]; then entry="$target/index.ts"',
    'elif [ -f "$target/index.tsx" ]; then entry="$target/index.tsx"',
    'elif [ -f "$target/index.js" ]; then entry="$target/index.js"',
    "fi",
    '[ -n "$entry" ] || exit 0',
    '[ -d "$target/lib" ] && exit 0',
    'if grep -q "./lib/" "$entry"; then',
    '  echo "Normalizing flat plugin into lib/ (index.ts imports ./lib/*)"',
    '  mkdir -p "$target/lib"',
    '  for f in "$target"/*; do',
    '    [ -e "$f" ] || continue',
    '    [ -f "$f" ] || continue',
    '    base=$(basename "$f")',
    '    case "$base" in',
    `      ${keep}) continue ;;`,
    "    esac",
    '    case "$base" in',
    `      ${glob})`,
    '        mv "$f" "$target/lib/"',
    "        ;;",
    "    esac",
    "  done",
    "fi",
  ].join("\n");
}

function pluginCspBash() {
  return [
    "apply_plugin_csp() {",
    '  local plugin_id="$1"',
    '  local target_ct="$2"',
    '  local api_svc="${3:-api}"',
    '  local spec_file="$4"',
    '  local remove_only="${5:-}"',
    '  [ -n "$plugin_id" ] || return 0',
    "  local d STACK CF STATE OVERRIDE dir src envn csv line had f key val",
    '  STACK=""',
    '  for d in "$target_ct" "$(dirname "$target_ct")"; do',
    '    [ -n "$d" ] && [ -d "$d" ] || continue',
    '    if [ -f "$d/docker-compose.yml" ] || [ -f "$d/docker-compose.yaml" ] || [ -f "$d/compose.yml" ] || [ -f "$d/compose.yaml" ]; then',
    '      STACK="$d"',
    "      break",
    "    fi",
    "  done",
    '  [ -n "$STACK" ] || return 0',
    '  CF=""',
    "  for f in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do",
    '    if [ -f "$STACK/$f" ]; then CF="$f"; break; fi',
    "  done",
    '  [ -n "$CF" ] || return 0',
    '  mkdir -p "$STACK/cloudtak-marketplace-plugins"',
    '  STATE="$STACK/cloudtak-marketplace-plugins/csp.tsv"',
    '  OVERRIDE="$STACK/docker-compose.marketplace.yml"',
    '  touch "$STATE"',
    '  if ! grep -q "^_host[[:space:]]" "$STATE" 2>/dev/null; then',
    "    for f in .env docker-compose.yml docker-compose.yaml compose.yml compose.yaml docker-compose.override.yml; do",
    '      [ -f "$STACK/$f" ] || continue',
    '      host_lines=$(grep -E "NGINX_CSP_[A-Z0-9_]+" "$STACK/$f" 2>/dev/null || true)',
    '      [ -n "$host_lines" ] || continue',
    '      printf "%s\\n" "$host_lines" | while IFS= read -r line; do',
    '        key=$(printf "%s\\n" "$line" | sed -n "s/.*\\(NGINX_CSP_[A-Z0-9_]*\\).*/\\1/p")',
    '        [ -n "$key" ] || continue',
    '        val=$(printf "%s\\n" "$line" | sed -E "s/.*NGINX_CSP_[A-Z0-9_]*=[[:space:]]*//; s/.*NGINX_CSP_[A-Z0-9_]*:[[:space:]]*//; s/[\\"\\047]//g")',
    '        dir=$(printf "%s\\n" "$key" | sed "s/^NGINX_CSP_//" | tr "[:upper:]" "[:lower:]" | tr "_" "-")',
    '        printf "%s\\n" "$val" | tr "," "\\n" | while IFS= read -r src; do',
    '          src=$(printf "%s" "$src" | tr -d "[:space:]")',
    '          [ -n "$src" ] || continue',
    '          printf "_host\\t%s\\t%s\\n" "$dir" "$src" >> "$STATE"',
    "        done",
    "      done",
    "    done",
    "  fi",
    "  had=$(awk -F '\\t' -v id=\"$plugin_id\" '$1==id { n++ } END { print n+0 }' \"$STATE\")",
    "  awk -F '\\t' -v id=\"$plugin_id\" '$1!=id { print }' \"$STATE\" > \"$STATE.tmp\"",
    '  mv "$STATE.tmp" "$STATE"',
    '  if [ "$remove_only" != "1" ] && [ -n "$spec_file" ] && [ -f "$spec_file" ]; then',
    '    while read -r dir src; do',
    '      [ -n "$dir" ] && [ -n "$src" ] || continue',
    '      case "$dir" in connect-src|img-src|media-src|font-src|worker-src|style-src-elem|style-src-attr|default-src) ;; *) continue ;; esac',
    "      echo \"$src\" | grep -Eq '^[A-Za-z0-9.:/*_~%+-]+$' || continue",
    "      printf '%s\\t%s\\t%s\\n' \"$plugin_id\" \"$dir\" \"$src\" >> \"$STATE\"",
    "    done < \"$spec_file\"",
    "  fi",
    '  if [ "$remove_only" = "1" ] && [ "$had" = "0" ]; then return 0; fi',
    '  if [ "$remove_only" != "1" ] && [ ! -s "$spec_file" ] && [ "$had" = "0" ]; then return 0; fi',
    '  echo "Updating CloudTAK CSP overlay $OVERRIDE"',
    '  if [ -f "$target_ct/api/nginx.conf.js" ] && ! grep -q NGINX_CSP_ "$target_ct/api/nginx.conf.js" 2>/dev/null; then',
    '    echo "Note: this CloudTAK nginx.conf.js does not read NGINX_CSP_* (needs 13.53.2+). Overlay is still saved."',
    "  fi",
    "  {",
    '    echo "# Managed by TAK Portal CloudTAK marketplace. Do not edit by hand."',
    '    echo "services:"',
    '    echo "  $api_svc:"',
    '    echo "    environment:"',
    "    csv_any=0",
    "    for dir in connect-src img-src media-src font-src worker-src style-src-elem style-src-attr default-src; do",
    "      csv=$(awk -F \"\\t\" -v d=\"$dir\" '$2==d { print $3 }' \"$STATE\" | awk 'NF && !seen[$0]++' | paste -sd, -)",
    '      [ -n "$csv" ] || continue',
    "      csv_any=1",
    "      envn=$(printf '%s' \"$dir\" | tr '[:lower:]' '[:upper:]' | tr '-' '_')",
    '      echo "      NGINX_CSP_$envn: \\"$csv\\""',
    "    done",
    '    if [ "$csv_any" = "0" ]; then',
    '      rm -f "$OVERRIDE" "$STATE.tmp" || true',
    '      : > "$STATE"',
    "    fi",
    '  } > "$OVERRIDE.tmp"',
    '  if [ -f "$OVERRIDE.tmp" ]; then',
    '    if grep -q NGINX_CSP_ "$OVERRIDE.tmp" 2>/dev/null; then',
    '      mv "$OVERRIDE.tmp" "$OVERRIDE"',
    "    else",
    '      rm -f "$OVERRIDE.tmp" "$OVERRIDE" || true',
    "    fi",
    "  fi",
    '  if ! command -v docker >/dev/null 2>&1; then return 0; fi',
    '  echo "Recreating $api_svc so CSP environment applies"',
    '  if [ -f "$OVERRIDE" ]; then',
    '    ( cd "$STACK" && COMPOSE_ANSI=never COMPOSE_PROGRESS=plain docker compose --progress=plain -f "$CF" -f "$OVERRIDE" up -d --force-recreate "$api_svc" )',
    "  else",
    '    ( cd "$STACK" && COMPOSE_ANSI=never COMPOSE_PROGRESS=plain docker compose --progress=plain -f "$CF" up -d --force-recreate "$api_svc" )',
    "  fi",
    "  return 0",
    "}",
  ].join("\n");
}

function pluginRuntimeCleanupBash() {
  return [
    "cleanup_plugin_runtime() {",
    '  local plugin_id="$1"',
    '  local target_ct="$2"',
    '  [ -n "$plugin_id" ] || return 0',
    "  local d STACK CF OVERRIDE SVCS svc cids cid img IMGS",
    '  STACK=""',
    '  for d in "$target_ct" "$(dirname "$target_ct")"; do',
    '    [ -n "$d" ] && [ -d "$d" ] || continue',
    '    if [ -f "$d/docker-compose.yml" ] || [ -f "$d/docker-compose.yaml" ] || [ -f "$d/compose.yml" ] || [ -f "$d/compose.yaml" ]; then',
    '      STACK="$d"',
    "      break",
    "    fi",
    "  done",
    '  [ -n "$STACK" ] || return 0',
    '  CF=""',
    "  for f in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do",
    '    if [ -f "$STACK/$f" ]; then CF="$f"; break; fi',
    "  done",
    '  OVERRIDE="$STACK/docker-compose.plugin-$plugin_id.yml"',
    '  PERSIST_DIR="$STACK/cloudtak-marketplace-plugins/$plugin_id"',
    '  if [ ! -f "$OVERRIDE" ] && [ ! -d "$PERSIST_DIR" ]; then return 0; fi',
    '  echo "Cleaning plugin runtime for $plugin_id"',
    '  if [ -n "$CF" ] && [ -f "$OVERRIDE" ]; then',
    "    SVCS=$(awk '",
    "      /^services:[[:space:]]*$/ { s=1; next }",
    "      s && /^[^[:space:]#]/ { s=0 }",
    '      s && /^  [A-Za-z0-9._-]+:[[:space:]]*$/ { sub(/^  /, ""); sub(/:[[:space:]]*$/, ""); print }',
    "' \"$OVERRIDE\" | tr '\\n' ' ')",
    '    IMGS=""',
    '    if command -v docker >/dev/null 2>&1; then',
    '      for svc in $SVCS; do',
    '        [ -n "$svc" ] || continue',
    '        cids=$(cd "$STACK" && docker compose -f "$CF" -f "$OVERRIDE" ps -a -q "$svc" 2>/dev/null || true)',
    "        for cid in $cids; do",
    '          [ -n "$cid" ] || continue',
    "          img=$(docker inspect -f '{{.Image}}' \"$cid\" 2>/dev/null || true)",
    '          [ -n "$img" ] && IMGS="$IMGS $img"',
    "        done",
    "      done",
    '      if [ -n "$SVCS" ]; then',
    '        echo "Stopping plugin services:$SVCS"',
    '        ( cd "$STACK" && docker compose -f "$CF" -f "$OVERRIDE" stop $SVCS ) || true',
    '        ( cd "$STACK" && docker compose -f "$CF" -f "$OVERRIDE" rm -f $SVCS ) || true',
    "      fi",
    '      cids=$(docker ps -a -q --filter "name=cloudtak-plugin-${plugin_id}" 2>/dev/null || true)',
    "      for cid in $cids; do",
    '        [ -n "$cid" ] || continue',
    "        img=$(docker inspect -f '{{.Image}}' \"$cid\" 2>/dev/null || true)",
    '        [ -n "$img" ] && IMGS="$IMGS $img"',
    '        docker rm -f "$cid" >/dev/null 2>&1 || true',
    "      done",
    "      for img in $IMGS; do",
    '        [ -n "$img" ] || continue',
    '        echo "Removing plugin image $img"',
    '        docker rmi "$img" >/dev/null 2>&1 || true',
    "      done",
    '      echo "Pruning unused Docker images"',
    "      docker image prune -f || true",
    "    fi",
    '    rm -f "$OVERRIDE" || true',
    "  fi",
    '  rm -rf "$PERSIST_DIR" || true',
    "  return 0",
    "}",
  ].join("\n");
}

function pluginRuntimeExtrasBash() {
  return [
    'target_ct="$1"',
    'repo_dir="$2"',
    'plugin_id="$3"',
    'compose_file_hint="$4"',
    'compose_svc_hint="$5"',
    'sidecar_dir_hint="$6"',
    'sidecar_port_hint="$7"',
    '[ -n "$target_ct" ] && [ -d "$repo_dir" ] && [ -n "$plugin_id" ] || exit 0',
    "set -e",
    pluginRuntimeCleanupBash(),
    'cleanup_plugin_runtime "$plugin_id" "$target_ct"',
    "find_stack() {",
    '  local d',
    '  for d in "$target_ct" "$(dirname "$target_ct")"; do',
    '    [ -n "$d" ] && [ -d "$d" ] || continue',
    '    if [ -f "$d/docker-compose.yml" ] || [ -f "$d/docker-compose.yaml" ] || [ -f "$d/compose.yml" ] || [ -f "$d/compose.yaml" ]; then',
    '      echo "$d"',
    "      return 0",
    "    fi",
    "  done",
    "  return 1",
    "}",
    "stack_compose_file() {",
    '  local d="$1"',
    "  local f",
    "  for f in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do",
    '    if [ -f "$d/$f" ]; then echo "$f"; return 0; fi',
    "  done",
    "  return 1",
    "}",
    "STACK=$(find_stack || true)",
    '[ -n "$STACK" ] || { echo "No docker compose stack next to CloudTAK; skipping plugin runtime services."; exit 0; }',
    'CF=$(stack_compose_file "$STACK" || true)',
    '[ -n "$CF" ] || { echo "No compose file in $STACK; skipping plugin runtime services."; exit 0; }',
    'PERSIST="$STACK/cloudtak-marketplace-plugins/$plugin_id"',
    'REL="cloudtak-marketplace-plugins/$plugin_id"',
    'echo "Persisting plugin runtime files to $PERSIST"',
    'rm -rf "$PERSIST" || true',
    'mkdir -p "$PERSIST"',
    'cp -a "$repo_dir/." "$PERSIST/"',
    'rm -rf "$PERSIST/.git" "$PERSIST/.ctak-normalize-plugin.sh" "$PERSIST/.ctak-runtime-plugin.sh" || true',
    'COMPOSE_SRC=""',
    'if [ -n "$compose_file_hint" ] && [ -f "$repo_dir/$compose_file_hint" ]; then',
    '  COMPOSE_SRC="$repo_dir/$compose_file_hint"',
    "else",
    "  for f in \\",
    "    deploy/compose.service.yml deploy/compose.service.yaml \\",
    "    deploy/docker-compose.yml deploy/docker-compose.yaml deploy/compose.yml \\",
    "    docker-compose.yml docker-compose.yaml compose.yml compose.yaml \\",
    "    service/docker-compose.yml service/docker-compose.yaml",
    "  do",
    '    if [ -f "$repo_dir/$f" ]; then COMPOSE_SRC="$repo_dir/$f"; break; fi',
    "  done",
    "fi",
    'OVERRIDE="$STACK/docker-compose.plugin-$plugin_id.yml"',
    'SVC="$compose_svc_hint"',
    "start_overlay() {",
    '  echo "Starting plugin Docker service${SVC:+ $SVC} from $OVERRIDE"',
    '  ( cd "$STACK" && COMPOSE_ANSI=never COMPOSE_PROGRESS=plain docker compose --progress=plain -f "$CF" -f "$OVERRIDE" up -d --build ${SVC:+$SVC} )',
    "}",
    "fix_overlay_depends() {",
    '  [ -f "$OVERRIDE" ] || return 0',
    '  local script="/tmp/ctak-marketplace-align.cjs"',
    '  [ -f "$script" ] || return 0',
    '  local base="$STACK/$CF"',
    '  local proj',
    '  proj=$(basename "$STACK")',
    '  echo "Checking plugin compose dependencies against the CloudTAK stack"',
    '  if command -v node >/dev/null 2>&1; then',
    '    node "$script" --fix-compose-depends "$OVERRIDE" "$base" --project "$proj" || echo "WARNING: could not check plugin depends_on" >&2',
    "    return 0",
    "  fi",
    '  if command -v docker >/dev/null 2>&1; then',
    '    docker run --rm -u 0 \\',
    '      -v "$script:/align.cjs:ro" \\',
    '      -v "$OVERRIDE:/overlay.yml" \\',
    '      -v "$base:/base.yml:ro" \\',
    "      node:22-alpine \\",
    '      node /align.cjs --fix-compose-depends /overlay.yml /base.yml --project "$proj" || echo "WARNING: could not check plugin depends_on" >&2',
    "  fi",
    "  return 0",
    "}",
    'if [ -n "$COMPOSE_SRC" ]; then',
    '  {',
    '    echo "# Managed by TAK Portal CloudTAK marketplace. Do not edit by hand."',
    '    if grep -qE "^[[:space:]]*services:[[:space:]]*$" "$COMPOSE_SRC"; then',
    '      cat "$COMPOSE_SRC"',
    "    else",
    '      echo "services:"',
    '      sed "s/^/  /" "$COMPOSE_SRC"',
    "    fi",
    '  } > "$OVERRIDE.tmp"',
    '  if [ -d "$PERSIST/service" ]; then',
    '    sed -E "s#(context:[[:space:]]*)[^[:space:]]+#\\1./cloudtak-marketplace-plugins/$plugin_id/service#" "$OVERRIDE.tmp" > "$OVERRIDE"',
    '  elif [ -f "$PERSIST/Dockerfile" ]; then',
    '    sed -E "s#(context:[[:space:]]*)[^[:space:]]+#\\1./cloudtak-marketplace-plugins/$plugin_id#" "$OVERRIDE.tmp" > "$OVERRIDE"',
    "  else",
    '    mv "$OVERRIDE.tmp" "$OVERRIDE"',
    '    OVERRIDE_READY=1',
    "  fi",
    '  if [ -z "${OVERRIDE_READY:-}" ]; then rm -f "$OVERRIDE.tmp"; fi',
    '  if [ -z "$SVC" ]; then',
    '    SVC=$(sed -n "s/^[[:space:]]*\\([A-Za-z0-9._-]*\\):[[:space:]]*$/\\1/p" "$OVERRIDE" | grep -vx services | head -n 1 || true)',
    "  fi",
    "  fix_overlay_depends",
    "  start_overlay",
    "  exit 0",
    "fi",
    'NODE_DIR=""',
    'if [ -n "$sidecar_dir_hint" ] && [ -d "$repo_dir/$sidecar_dir_hint" ]; then',
    '  NODE_DIR="$sidecar_dir_hint"',
    "else",
    "  for d in server sidecar backend; do",
    '    if [ -f "$repo_dir/$d/package.json" ] && { [ -f "$repo_dir/$d/server.js" ] || [ -f "$repo_dir/$d/index.js" ]; }; then',
    '      if ls "$repo_dir/$d"/*.ts >/dev/null 2>&1; then continue; fi',
    '      NODE_DIR="$d"',
    "      break",
    "    fi",
    "  done",
    "fi",
    '[ -n "$NODE_DIR" ] || exit 0',
    'PORT="$sidecar_port_hint"',
    'if [ -z "$PORT" ]; then',
    '  PORT=$(grep -Eo "listen\\([0-9]+" "$repo_dir/$NODE_DIR/server.js" "$repo_dir/$NODE_DIR/index.js" 2>/dev/null | grep -Eo "[0-9]+" | head -n 1 || true)',
    "fi",
    '[ -n "$PORT" ] || PORT=3080',
    'SVC="cloudtak-plugin-${plugin_id}-sidecar"',
    'echo "Starting plugin node sidecar $SVC (port $PORT) from $NODE_DIR/"',
    'cat > "$OVERRIDE" <<YAML',
    "# Managed by TAK Portal CloudTAK marketplace. Do not edit by hand.",
    "services:",
    '  $SVC:',
    "    image: node:22-alpine",
    '    container_name: $SVC',
    "    working_dir: /app",
    "    volumes:",
    '      - ./cloudtak-marketplace-plugins/$plugin_id/$NODE_DIR:/app',
    '    command: sh -c "npm install --omit=dev && npm start"',
    "    restart: unless-stopped",
    "    expose:",
    '      - "$PORT"',
    "YAML",
    "fix_overlay_depends",
    "start_overlay",
  ].join("\n");
}

function pluginHostAlignRunnerBash() {
  const js = fs.readFileSync(path.join(__dirname, "cloudtakMarketplace.align.js"), "utf8");
  if (js.includes("\nCTAK_PLUGIN_ALIGN_JS\n")) {
    throw new Error("plugin align script contains the heredoc delimiter");
  }
  return `
align_plugins_to_host() {
  local ct="$1"
  [ -n "$ct" ] && [ -d "$ct/api/web/src" ] && [ -d "$ct/api/web/plugins" ] || return 0
  local script="/tmp/ctak-marketplace-align.cjs"
  cat <<'CTAK_PLUGIN_ALIGN_JS' > "$script"
${js}
CTAK_PLUGIN_ALIGN_JS
  chmod a+r "$script" 2>/dev/null || true
  echo "Aligning marketplace plugins to the installed CloudTAK API"
  if command -v node >/dev/null 2>&1; then
    if declare -F run_as_writer >/dev/null 2>&1; then
      if run_as_writer "command -v node >/dev/null 2>&1 && node $(printf '%q' "$script") $(printf '%q' "$ct")"; then
        return 0
      fi
      echo "Plugin owner has no usable node; aligning via docker"
    else
      node "$script" "$ct"
      return 0
    fi
  fi
  if command -v docker >/dev/null 2>&1; then
    # Same writer as run_as_writer's docker fallback. Plugin files are often
    # owned by the SSH user (root), not by the plugins directory owner.
    echo "Aligning plugin files via docker (root)"
    docker run --rm -u 0 \\
      -v "$ct:$ct" \\
      -v "$script:/align.cjs:ro" \\
      node:22-alpine \\
      node /align.cjs "$ct"
    return 0
  fi
  echo "WARNING: skipped plugin API alignment; node and docker are unavailable" >&2
  return 0
}
`.trim();
}

function pluginPatchRunnerBash() {
  const js = fs.readFileSync(path.join(__dirname, "cloudtakMarketplace.patch.js"), "utf8");
  if (js.includes("\nCTAK_PLUGIN_PATCH_JS\n")) {
    throw new Error("plugin patch script contains the heredoc delimiter");
  }
  return `
apply_plugin_patches() {
  local ct="$1"
  local repo="$2"
  [ -n "$ct" ] && [ -n "$repo" ] && [ -d "$ct" ] && [ -d "$repo" ] || return 0
  local script="/tmp/ctak-marketplace-patch.cjs"
  cat <<'CTAK_PLUGIN_PATCH_JS' > "$script"
${js}
CTAK_PLUGIN_PATCH_JS
  chmod a+r "$script" 2>/dev/null || true
  echo "Applying plugin patches onto this CloudTAK checkout"
  if command -v node >/dev/null 2>&1; then
    if declare -F run_as_writer >/dev/null 2>&1; then
      if run_as_writer "command -v node >/dev/null 2>&1 && node $(printf '%q' "$script") $(printf '%q' "$repo") $(printf '%q' "$ct")"; then
        return 0
      fi
      echo "Plugin owner has no usable node; applying patches via docker"
    else
      node "$script" "$repo" "$ct"
      return 0
    fi
  fi
  if command -v docker >/dev/null 2>&1; then
    echo "Applying plugin patches via docker (root)"
    docker run --rm -u 0 \\
      -v "$ct:$ct" \\
      -v "$repo:$repo" \\
      -v "$script:/patch.cjs:ro" \\
      node:22-alpine \\
      node /patch.cjs "$repo" "$ct"
    return 0
  fi
  echo "ERROR: cannot apply plugin patches; node and docker are unavailable" >&2
  return 1
}
`.trim();
}

function installRemoteScript(ct, plugin, options = {}) {
  const dest = plugin.web.dest;
  const source = plugin.web.source === "." ? "." : plugin.web.source;
  const routes = plugin.routes ? plugin.routes.source : "";
  const excludes = (plugin.exclude || []).join("\n");
  const installScript = normalizeInstallScript(plugin.installScript || "");
  const repoName = repoBasename(plugin.repo) || plugin.id;
  const runtime = pluginRuntimeHints(plugin);
  const apiSvc = String((options && options.composeService) || "api").trim() || "api";
  const cspSpec = cspSpecText(plugin);
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
COMPOSE_FILE_HINT=${ssh.shellQuote(runtime.composeFile)}
COMPOSE_SVC_HINT=${ssh.shellQuote(runtime.composeService)}
SIDECAR_DIR_HINT=${ssh.shellQuote(runtime.sidecarDir)}
SIDECAR_PORT_HINT=${ssh.shellQuote(runtime.sidecarPort)}
CT_COMPOSE_SVC=${ssh.shellQuote(apiSvc)}
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

echo "Fetching latest plugin source"
echo "Cloning $REPO ($REF)"
reset_cache
GIT_TERMINAL_PROMPT=0 git_ok clone --quiet --depth 1 --single-branch --branch "$REF" "$REPO" "$CACHE"
REPO_DIR="$CACHE"
SHA=$(git_ok -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || true)
echo "Plugin source $REPO_DIR @ $SHA"

PLUGIN_ROOT="$CT/api/web/plugins"
TARGET="$PLUGIN_ROOT/$DEST"
case "$TARGET" in
  */api/web/plugins/$DEST) ;;
  *) echo "Refusing dest $TARGET" >&2; exit 1 ;;
esac
echo "Clearing previous plugin files at $TARGET"
run_as_writer "rm -rf $(printf '%q' "$TARGET")"

# Generic layouts, in order:
# 1) repo install.sh (pass --no-build / --no-pull only if that script documents them)
# 2) optional catalog installer
# 3) copy web files from catalog source, plugin/, or repo root; copy server/*.ts routes if present
${pluginPatchRunnerBash()}
if [ -f "$REPO_DIR/install.sh" ]; then
  flags=""
  if grep -q -- '--no-build' "$REPO_DIR/install.sh"; then flags="$flags --no-build"; fi
  if grep -q -- '--no-pull' "$REPO_DIR/install.sh"; then flags="$flags --no-pull"; fi
  echo "Found install.sh; running: bash ./install.sh$flags $CT"
  chmod +x "$REPO_DIR/install.sh" 2>/dev/null || true
  cat > "$REPO_DIR/.ctak-run-install.sh" <<'EOS'
#!/bin/bash
set +e
repo="$1"
ct="$2"
shift 2
cd "$repo" || exit 1
bash ./install.sh "$@" "$ct"
echo $? > "$repo/.marketplace-install-status"
exit 0
EOS
  chmod a+rX "$REPO_DIR/.ctak-run-install.sh" 2>/dev/null || true
  run_as_writer "bash $(printf '%q' "$REPO_DIR/.ctak-run-install.sh") $(printf '%q' "$REPO_DIR") $(printf '%q' "$CT")$flags"
  install_ec=1
  if [ -f "$REPO_DIR/.marketplace-install-status" ]; then
    install_ec=$(tr -cd '0-9' < "$REPO_DIR/.marketplace-install-status" || echo 1)
  fi
  rm -f "$REPO_DIR/.ctak-run-install.sh" "$REPO_DIR/.marketplace-install-status" || true
  if [ "$install_ec" != 0 ] && [ ! -d "$TARGET" ]; then
    echo "ERROR: install.sh failed before plugin files were copied" >&2
    exit 1
  fi
  if [ -d "$TARGET" ] && find "$REPO_DIR" -name '*.patch' -not -path '*/node_modules/*' -print -quit | grep -q .; then
    if [ "$install_ec" != 0 ]; then
      echo "install.sh exited $install_ec; applying patches that did not match this CloudTAK checkout"
    fi
    apply_plugin_patches "$CT" "$REPO_DIR"
  elif [ "$install_ec" != 0 ]; then
    echo "ERROR: install.sh failed" >&2
    exit 1
  fi
elif [ -n "$INSTALL" ]; then
  echo "Running installer: cd $REPO_DIR && bash $INSTALL $CT"
  run_as_writer "cd $(printf '%q' "$REPO_DIR") && bash $INSTALL $(printf '%q' "$CT")"
else
  WEBSRC="$REPO_DIR"
  if [ "$SRC" != "." ] && [ -d "$REPO_DIR/$SRC" ]; then
    WEBSRC="$REPO_DIR/$SRC"
    echo "Using catalog web source $SRC"
  elif [ -d "$REPO_DIR/plugin" ]; then
    WEBSRC="$REPO_DIR/plugin"
    echo "Detected plugin/ web layout"
  elif [ -f "$REPO_DIR/index.ts" ] || [ -f "$REPO_DIR/index.js" ]; then
    WEBSRC="$REPO_DIR"
    echo "Detected repo-root web layout"
  else
    echo "Missing web source in $REPO_DIR" >&2
    exit 1
  fi
  PLUGIN_ROOT="$CT/api/web/plugins"
  TARGET="$PLUGIN_ROOT/$DEST"
  case "$TARGET" in
    */api/web/plugins/$DEST) ;;
    *) echo "Refusing dest $TARGET" >&2; exit 1 ;;
  esac
  echo "Copying plugin files to $TARGET"
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
  ROUTES_DIR=""
  if [ -n "$ROUTES" ] && [ -d "$REPO_DIR/$ROUTES" ]; then
    ROUTES_DIR="$REPO_DIR/$ROUTES"
  elif [ -d "$REPO_DIR/server" ] && ls "$REPO_DIR/server"/*.ts >/dev/null 2>&1; then
    ROUTES_DIR="$REPO_DIR/server"
  fi
  if [ -n "$ROUTES_DIR" ]; then
    echo "Copying route files from $ROUTES_DIR"
    run_as_writer "mkdir -p $(printf '%q' "$CT/api/stateless/routes") && cp -a $(printf '%q' "$ROUTES_DIR")/*.ts $(printf '%q' "$CT/api/stateless/routes")/" || true
  fi
fi

# Official CloudTAK sample: index.ts at dest root, Vue/TS/assets in lib/.
# Some catalog repos ship those ./lib/ imports with a flat tree; nest siblings into lib/.
# Also drop .git so it is not copied into the api image build context.
cat <<'NORM' > "$REPO_DIR/.ctak-normalize-plugin.sh"
${flatSampleLibNormalizeBash()}
NORM
chmod a+rX "$REPO_DIR/.ctak-normalize-plugin.sh" 2>/dev/null || true
run_as_writer "sh $(printf '%q' "$REPO_DIR/.ctak-normalize-plugin.sh") $(printf '%q' "$TARGET")"
rm -f "$REPO_DIR/.ctak-normalize-plugin.sh" || true

# Match plugin calls and imports to this CloudTAK checkout before vue-tsc.
# Applies to every plugin already on disk, not only the one being installed.
${pluginHostAlignRunnerBash()}
align_plugins_to_host "$CT"

cat <<'RUNTIME' > "$REPO_DIR/.ctak-runtime-plugin.sh"
${pluginRuntimeExtrasBash()}
RUNTIME
chmod a+rX "$REPO_DIR/.ctak-runtime-plugin.sh" 2>/dev/null || true
bash "$REPO_DIR/.ctak-runtime-plugin.sh" "$CT" "$REPO_DIR" "$ID" "$COMPOSE_FILE_HINT" "$COMPOSE_SVC_HINT" "$SIDECAR_DIR_HINT" "$SIDECAR_PORT_HINT"
rm -f "$REPO_DIR/.ctak-runtime-plugin.sh" || true

${pluginCspBash()}
cat <<'CSPSPEC' > /tmp/ctak-csp-$ID.spec
${cspSpec}
CSPSPEC
apply_plugin_csp "$ID" "$CT" "$CT_COMPOSE_SVC" /tmp/ctak-csp-$ID.spec
rm -f /tmp/ctak-csp-$ID.spec || true
printf 'INSTALL_SHA %s\\n' "$SHA"
`.trim();
}

function uninstallRemoteScript(ct, dest, routeFiles, pluginId, options = {}) {
  const destName = String(dest || "").trim();
  const files = (routeFiles || []).filter((f) => /^[A-Za-z0-9._-]+\.ts$/.test(f));
  const guessed = destName && /^[A-Za-z0-9._-]+$/.test(destName) ? `plugin-${destName}.ts` : "";
  if (guessed && !files.includes(guessed)) files.push(guessed);
  const routeRm = files
    .map((f) => `rm -f "$CT/api/stateless/routes/${f}"`)
    .join("\n");
  const id = String(pluginId || "").trim();
  const apiSvc = String((options && options.composeService) || "api").trim() || "api";
  return `
set -euo pipefail
CT=${ssh.shellQuote(ct)}
DEST=${ssh.shellQuote(dest)}
ID=${ssh.shellQuote(id)}
CT_COMPOSE_SVC=${ssh.shellQuote(apiSvc)}
if [ -z "$ID" ]; then ID="$DEST"; fi
${pluginRuntimeCleanupBash()}
${pluginCspBash()}
if [ -n "$ID" ]; then
  cleanup_plugin_runtime "$ID" "$CT"
  apply_plugin_csp "$ID" "$CT" "$CT_COMPOSE_SVC" "" 1
  CACHE="$HOME/.cache/cloudtak-marketplace/$ID"
  if [ -f "$CACHE/install.sh" ] && grep -q -- '--remove' "$CACHE/install.sh"; then
    flags="--remove"
    if grep -q -- '--no-build' "$CACHE/install.sh"; then flags="$flags --no-build"; fi
    echo "Found install.sh; running: bash ./install.sh $flags $CT"
    ( cd "$CACHE" && bash ./install.sh $flags "$CT" ) || echo "install.sh --remove did not finish cleanly"
  fi
  rm -rf "$HOME/.cache/cloudtak-marketplace/$ID" || true
  rm -f /tmp/ctak-marketplace-excludes-$ID || true
fi
TARGET="$CT/api/web/plugins/$DEST"
case "$TARGET" in
  */api/web/plugins/$DEST) ;;
  *) echo "Refusing dest $TARGET" >&2; exit 1 ;;
esac
rm -rf "$TARGET"
SRC_TARGET="$CT/api/web/src/plugins/$DEST"
case "$SRC_TARGET" in
  */api/web/src/plugins/$DEST)
    if [ -e "$SRC_TARGET" ]; then rm -rf "$SRC_TARGET"; fi
    ;;
esac
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
# A plugin copied earlier can still fail vue-tsc and block this rebuild.
${pluginHostAlignRunnerBash()}
align_plugins_to_host "$CT"
MPF=""
if [ -f docker-compose.marketplace.yml ]; then
  MPF="-f docker-compose.marketplace.yml"
  echo "Using marketplace CSP overlay"
fi
export BUILDKIT_PROGRESS=plain
export COMPOSE_ANSI=never
export COMPOSE_PROGRESS=plain
docker compose --progress=plain -f "$CF" $MPF build --no-cache "$SVC"
echo "CloudTAK image build finished."
docker compose --progress=plain -f "$CF" $MPF up -d --force-recreate "$SVC"
echo "CloudTAK container recreate finished."
echo "Waiting for $SVC to be running"
n=0
while [ "$n" -lt 90 ]; do
  n=$((n+1))
  fmt=$(docker compose -f "$CF" ps "$SVC" --format '{{.State}} {{.Health}}' 2>/dev/null || true)
  if [ -z "$fmt" ]; then
    fmt=$(docker compose -f "$CF" ps "$SVC" 2>/dev/null | tail -n +2 || true)
  fi
  echo "  $SVC status: $fmt"
  low=$(printf '%s' "$fmt" | tr '[:upper:]' '[:lower:]')
  state=$(printf '%s' "$low" | awk '{print $1}')
  health=$(printf '%s' "$low" | awk '{print $2}')
  if [ "$state" = "running" ] && [ "$health" != "starting" ]; then
    echo "Container $SVC is running"
    break
  fi
  if printf '%s' "$low" | grep -qE '(^|[[:space:]])running([[:space:]]|$)|[[:space:]]up[[:space:]]|\\(healthy\\)'; then
    if ! printf '%s' "$low" | grep -qE 'restarting|starting|exited|dead|created|paused'; then
      echo "Container $SVC is running"
      break
    fi
  fi
  if [ "$n" -ge 90 ]; then
    echo "Timed out waiting for $SVC to be running" >&2
    exit 1
  fi
  sleep 2
done
echo REBUILD_OK
echo "Removing unused Docker images"
docker image prune -f || true
`.trim();
}

async function runLogged(jobIds, command, timeoutMs) {
  const ids = (Array.isArray(jobIds) ? jobIds : [jobIds]).filter(Boolean);
  const log = (line) => ids.forEach((id) => appendJobLog(id, line));
  let streamed = false;
  const result = await ssh.runCommand(command, timeoutMs, (line) => {
    streamed = true;
    log(line);
  });
  if (!streamed) {
    if (result.stdout) {
      String(result.stdout)
        .split("\n")
        .forEach((line) => log(line));
    }
    if (!result.ok && result.stderr) {
      String(result.stderr)
        .split("\n")
        .forEach((line) => log(line));
    }
  }
  if (result.cancelled || _cancelRequested) {
    throw cancelledError();
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
    `bash -lc ${ssh.shellQuote(installRemoteScript(loc.path, plugin, { composeService: loc.composeService }))}`,
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
  const extraRoutes = job && job.extra && Array.isArray(job.extra.routeFiles) ? job.extra.routeFiles : [];
  for (const f of extraRoutes) {
    if (/^[A-Za-z0-9._-]+\.ts$/.test(f) && !routeGuess.includes(f)) routeGuess.push(f);
  }
  const runtimeId = (plugin && plugin.id) || dest;
  appendJobLog(job.id, `$ rm -rf api/web/plugins/${dest}`);
  await runLogged(job.id, `bash -lc ${ssh.shellQuote(uninstallRemoteScript(loc.path, dest, routeGuess, runtimeId, { composeService: loc.composeService }))}`, 5 * 60 * 1000);
  const rec = store.readInstalled();
  if (plugin) {
    delete rec.plugins[plugin.id];
  } else {
    for (const [id, row] of Object.entries(rec.plugins || {})) {
      if (row && String(row.dest || "") === dest) delete rec.plugins[id];
    }
  }
  store.writeInstalled(rec);
  return { path: loc.path, composeService: loc.composeService || ssh.resolvedComposeService() };
}

async function performRebuild(jobs, ctPath, service) {
  const ids = (Array.isArray(jobs) ? jobs : [jobs]).map((j) => j.id);
  const primary = ids[0];
  ids.forEach((id) => appendJobLog(id, `$ docker compose --progress=plain build --no-cache ${service}`));
  ids.slice(1).forEach((id) => appendJobLog(id, "CloudTAK rebuild output is on the first job in this batch."));
  await runLogged(primary ? [primary] : [], `bash -lc ${ssh.shellQuote(rebuildRemoteScript(ctPath, service))}`, 20 * 60 * 1000);
}

async function runChangeBatch(jobs) {
  const expanded = [];
  for (const job of jobs) {
    if (job.kind === "update-all") {
      updateJob(job.id, { status: "running", startedAt: new Date().toISOString() });
      const snap = await getSnapshot();
      const pending = snap.plugins.filter((p) => p.installed && p.updateAvailable && p.catalog && !p.error);
      if (!pending.length) {
        appendJobLog(job.id, "No updates available.");
        updateJob(job.id, { status: "complete", finishedAt: new Date().toISOString() });
        continue;
      }
      updateJob(job.id, {
        extra: { ...(job.extra || {}), pluginIds: pending.map((p) => p.id) },
      });
      expanded.push({ job, plugins: pending });
    } else {
      const plugin = job.pluginId ? pluginById(job.pluginId) : null;
      const dest = (job.extra && job.extra.dest) || (plugin && plugin.web && plugin.web.dest) || "";
      if (job.pluginId || dest) {
        updateJob(job.id, {
          extra: {
            ...(job.extra || {}),
            dest,
            pluginIds: job.pluginId ? [job.pluginId] : [],
          },
        });
      }
      expanded.push({ job, plugins: null });
    }
  }

  let lastLoc = null;
  let needsRebuild = false;
  const uninstalls = expanded.filter((x) => x.job.kind === "uninstall");
  const installs = expanded.filter((x) => x.job.kind !== "uninstall");

  for (const item of [...uninstalls, ...installs]) {
    const job = item.job;
    const live = store.readJobs().jobs.find((j) => j.id === job.id);
    if (!live || live.status === "cancelled" || _cancelRequested) continue;
    if (job.status !== "running") updateJob(job.id, { status: "running", startedAt: new Date().toISOString() });
    try {
      throwIfCancelled();
      if (job.kind === "uninstall") {
        const plugin = job.pluginId ? pluginById(job.pluginId) : null;
        const dest = (job.extra && job.extra.dest) || (plugin && plugin.web && plugin.web.dest);
        if (!dest) throw new Error("Missing dest folder");
        lastLoc = await performUninstall(job, dest, plugin);
        needsRebuild = true;
      } else if (job.kind === "update-all") {
        for (const p of item.plugins) {
          appendJobLog(job.id, `Updating ${p.name}`);
          lastLoc = await performInstall(job, p.catalog);
          if (lastLoc && !lastLoc.skipRebuild) needsRebuild = true;
        }
      } else {
        const plugin = pluginById(job.pluginId);
        if (!plugin) throw new Error(`Plugin ${job.pluginId} is not in the catalog`);
        lastLoc = await performInstall(job, plugin);
        if (lastLoc && !lastLoc.skipRebuild) needsRebuild = true;
        if (lastLoc && lastLoc.sha) {
          updateJob(job.id, { extra: { ...(job.extra || {}), sha: lastLoc.sha } });
        }
      }
    } catch (err) {
      if (_cancelRequested || isCancelledError(err)) {
        appendJobLog(job.id, "Cancelled.");
        updateJob(job.id, {
          status: "cancelled",
          finishedAt: new Date().toISOString(),
          error: "Cancelled.",
        });
        continue;
      }
      const summary = summarizeCommandError(err.message || String(err));
      updateJob(job.id, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: summary,
      });
      appendJobLog(job.id, `FAILED ${summary}`);
      markJobInstallError(job, summary);
    }
  }

  const succeeded = store
    .readJobs()
    .jobs.filter((j) => jobs.some((x) => x.id === j.id) && j.status === "running");
  if (_cancelRequested) {
    // skip rebuild when cancelled
  } else if (succeeded.length && lastLoc && needsRebuild) {
    try {
      const msg = `Applying ${succeeded.length} change${succeeded.length === 1 ? "" : "s"} with one CloudTAK rebuild`;
      succeeded.forEach((j) => appendJobLog(j.id, msg));
      await performRebuild(succeeded, lastLoc.path, lastLoc.composeService);
      succeeded.forEach((j) => appendJobLog(j.id, "Containers recreated and running."));
      for (const j of succeeded) {
        updateJob(j.id, { status: "complete", finishedAt: new Date().toISOString() });
        appendJobLog(j.id, "Complete. In CloudTAK use Settings → Refresh App.");
        clearJobInstallError(j);
      }
    } catch (err) {
      const cancelled = _cancelRequested || isCancelledError(err);
      const summary = cancelled ? "Cancelled." : summarizeCommandError(err.message || String(err));
      for (const j of succeeded) {
        updateJob(j.id, {
          status: cancelled ? "cancelled" : "failed",
          finishedAt: new Date().toISOString(),
          error: summary,
        });
        appendJobLog(j.id, cancelled ? "Cancelled." : `Rebuild failed: ${summary}`);
        if (!cancelled) markJobInstallError(j, summary);
      }
    }
  } else if (succeeded.length) {
    for (const j of succeeded) {
      updateJob(j.id, { status: "complete", finishedAt: new Date().toISOString() });
      appendJobLog(j.id, "Complete. In CloudTAK use Settings → Refresh App.");
      clearJobInstallError(j);
    }
  }
  if (!_cancelRequested) {
    try {
      await scanHost();
      await refreshShaCache();
    } catch (err) {
      console.warn("[cloudtak-marketplace] rescan:", err?.message || err);
    }
  }
  refreshUiSnapshot();
}

async function claimAndRunJobs() {
  if (_jobRunning) return;
  if (!isEnabled()) return;
  const queued = store.readJobs().jobs.filter((j) => j.status === "queued");
  if (!queued.length) return;
  _jobRunning = true;
  try {
    const changes = queued.filter((j) =>
      ["install", "update", "update-all", "uninstall"].includes(j.kind)
    );
    const scans = queued.filter((j) => j.kind === "scan");
    const catalogs = queued.filter((j) => j.kind === "refresh-catalog");

    for (const job of catalogs) {
      if (_cancelRequested) break;
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
      if (_cancelRequested) break;
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

    if (changes.length && !_cancelRequested) await runChangeBatch(changes);
  } finally {
    _jobRunning = false;
    _cancelRequested = false;
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
  if (!isEnabled()) {
    _uiSnapshot = null;
    _uiSnapshotAt = 0;
    return;
  }
  refreshUiSnapshot();
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
  try {
    await recheckCaddyFile();
  } catch (err) {
    console.warn("[cloudtak-marketplace] caddy recheck:", err?.message || err);
  }
  refreshUiSnapshot();
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
  normalizeAdditionalActions,
  matchCatalogPlugin,
  loadCatalog,
  fetchCatalog,
  scanHost,
  probeHostCaddy,
  deployPluginCaddy,
  getSnapshot,
  buildUiPlugins,
  refreshUiSnapshot,
  uiSnapshot,
  refreshShaCache,
  enqueueJob,
  enqueueJobOnce,
  stageJob,
  unstageJob,
  deployStaged,
  selectLogJobs,
  summarizeCommandError,
  listJobs,
  clearIdleJobs,
  cancelCurrentJobs,
  isBusyJob,
  hasBusyChangeJobs,
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
  normalizeInstallScript,
  installRemoteScript,
  uninstallRemoteScript,
  rebuildRemoteScript,
  normalizeCsp,
  normalizeFlatSamplePluginTree,
  pluginEntryImportsLib,
};
