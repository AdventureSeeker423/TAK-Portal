/**
 * TAKwerx plugin catalog — fully discovery-based.
 * Seeds from takwerx/atak-plugins `plugins/` folders, resolves each folder's
 * public release repo under the takwerx GitHub user, and lists CIV APKs by ATAK version.
 * No hardcoded plugin/repo lists.
 *
 * No GitHub auth — stays under the unauthenticated API limit by caching,
 * coalescing concurrent refreshes, and serving stale cache on failure.
 */

const pluginsSvc = require("./plugins.service");

const GITHUB_API = "https://api.github.com";
const GITHUB_RAW = "https://raw.githubusercontent.com";
const USER_AGENT = "TAK-Portal-TAKwerx-Plugins";
const MONOREPO = "takwerx/atak-plugins";
const TAKWERX_OWNER = "takwerx";
/** Full catalog refresh interval — short enough to pick up newly published plugins. */
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** @type {{ expiry: number, entries: object[] } | null} */
let catalogCache = null;
/** @type {Promise<{ success: boolean, entries?: object[], error?: string }> | null} */
let catalogRefreshInFlight = null;

const APK_ASSET_RE = /^ATAK-Plugin-.+?--(\d+\.\d+\.\d+)-civ-release\.apk$/i;

/** PascalCase / acronym folder → kebab guess (EvacZone → evac-zone, PLSS → plss). */
function folderToKebabGuess(folderName) {
  return String(folderName || "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

function folderToDisplayName(folderName) {
  const name = String(folderName || "").trim();
  if (!name) return "Plugin";
  if (/^[A-Z0-9]+$/.test(name) && name.length <= 5) return name;
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

/** Fallback when build.gradle namespace cannot be read. */
function folderToPackageNameGuess(folderName) {
  return `com.atakmap.android.${String(folderName || "").toLowerCase()}.plugin`;
}

/**
 * Prefer a human title from the release name (e.g. "Evac Zone 0.4" → "Evac Zone").
 * @param {object} release
 * @param {string} folderName
 */
function displayNameFromRelease(release, folderName) {
  const raw = String(release?.name || "").trim();
  if (raw) {
    const stripped = raw.replace(/\s+v?\d+(?:\.\d+)*\s*$/i, "").trim();
    if (stripped) return stripped;
  }
  return folderToDisplayName(folderName);
}

/**
 * @param {string} assetName
 * @returns {string|null} e.g. "5.8.0"
 */
function parseAtakVersionFromAsset(assetName) {
  const m = String(assetName || "").match(APK_ASSET_RE);
  return m ? m[1] : null;
}

/**
 * Validate download URL is a GitHub release asset under takwerx/.
 * @param {string} url
 * @returns {boolean}
 */
function isAllowedTakwerxApkUrl(url) {
  try {
    const u = new URL(String(url || "").trim());
    if (u.protocol !== "https:") return false;
    if (u.hostname !== "github.com") return false;
    // /takwerx/<repo>/releases/download/<tag>/<file>
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 6) return false;
    if (parts[0] !== TAKWERX_OWNER) return false;
    if (parts[2] !== "releases" || parts[3] !== "download") return false;
    const file = parts[parts.length - 1] || "";
    return /\.apk$/i.test(file);
  } catch (_) {
    return false;
  }
}

async function githubGetJson(path) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const res = await fetch(`${GITHUB_API}${path}`, { headers });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    data = { message: text.slice(0, 200) };
  }
  if (!res.ok) {
    const msg = data.message || `GitHub returned ${res.status}`;
    const err = new Error(msg);
    err.statusCode = res.status;
    throw err;
  }
  return data;
}

/**
 * List plugin directories from the takwerx/atak-plugins monorepo.
 * @returns {Promise<string[]>}
 */
async function listMonorepoPluginFolders() {
  const items = await githubGetJson(`/repos/${MONOREPO}/contents/plugins`);
  if (!Array.isArray(items)) return [];
  return items
    .filter((it) => it && it.type === "dir" && it.name)
    .map((it) => String(it.name))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * List public repos under the takwerx GitHub user (paginated).
 * @returns {Promise<object[]>}
 */
async function listTakwerxPublicRepos() {
  const repos = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await githubGetJson(
      `/users/${TAKWERX_OWNER}/repos?per_page=100&page=${page}&type=public&sort=full_name`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const r of batch) {
      if (r && r.name && !r.private) repos.push(r);
    }
    if (batch.length < 100) break;
  }
  return repos;
}

/**
 * Ordered candidate public-repo slugs for a monorepo folder.
 * Uses naming guesses plus any org repos that share the folder prefix
 * (e.g. PLSS → plss-grid, plss-data). No hardcoded overrides.
 * @param {string} folderName
 * @param {object[]} orgRepos
 * @returns {string[]}
 */
function candidateRepoSlugs(folderName, orgRepos) {
  const lower = String(folderName || "").trim().toLowerCase();
  const kebab = folderToKebabGuess(folderName);
  const ordered = [];
  const seen = new Set();
  const add = (slug) => {
    const s = String(slug || "").trim().toLowerCase();
    if (!s || seen.has(s)) return;
    seen.add(s);
    ordered.push(s);
  };

  add(kebab);
  add(lower);

  const prefixHits = (orgRepos || [])
    .map((r) => String(r.name || "").toLowerCase())
    .filter(
      (n) =>
        n &&
        (n === lower ||
          n === kebab ||
          n.startsWith(`${lower}-`) ||
          (kebab && n.startsWith(`${kebab}-`)))
    )
    .sort((a, b) => a.length - b.length || a.localeCompare(b));

  for (const n of prefixHits) add(n);
  return ordered;
}

/**
 * True when a release has CIV APKs built from this monorepo folder
 * (asset name contains the folder, e.g. ATAK-Plugin-PLSS-… or ATAK-Plugin-EvacZone-…).
 * @param {object} release
 * @param {string} folderName
 */
function releaseMatchesFolder(release, folderName) {
  const needle = String(folderName || "").trim().toLowerCase();
  if (!needle) return false;
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  return assets.some((a) => {
    const name = String(a?.name || "").toLowerCase();
    if (!name.includes(needle)) return false;
    return !!parseAtakVersionFromAsset(a.name);
  });
}

/**
 * Read Android namespace from the monorepo plugin's app/build.gradle (raw, not API quota).
 * @param {string} folderName
 * @returns {Promise<string>}
 */
async function discoverPackageName(folderName) {
  const fallback = folderToPackageNameGuess(folderName);
  try {
    const url = `${GITHUB_RAW}/${MONOREPO}/main/plugins/${encodeURIComponent(folderName)}/app/build.gradle`;
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) return fallback;
    const text = await res.text();
    const m = text.match(/namespace\s+['"]([^'"]+)['"]/);
    return m && m[1] ? m[1] : fallback;
  } catch (_) {
    return fallback;
  }
}

function cleanRepoDescription(repoMeta, displayName) {
  let description = "";
  if (repoMeta && typeof repoMeta.description === "string") {
    description = repoMeta.description
      .replace(/^ATAK Plugin:\s*/i, "")
      .replace(/\s*—\s*/, " — ")
      .replace(/\s*Downloads, guide and issues here\.?\s*$/i, "")
      .trim();
  }
  if (!description) description = `${displayName} ATAK plugin from takwerx`;
  return description;
}

/**
 * Normalize CIV APK assets from a GitHub release.
 * @param {object} release
 * @returns {object[]}
 */
function civAssetsFromRelease(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const civAssets = [];
  for (const a of assets) {
    const name = a.name || "";
    const atakVersion = parseAtakVersionFromAsset(name);
    if (!atakVersion) continue;
    const apkUrl = a.browser_download_url;
    if (!apkUrl || !isAllowedTakwerxApkUrl(apkUrl)) continue;
    civAssets.push({
      atakVersion,
      apk_url: apkUrl,
      size: typeof a.size === "number" ? a.size : null,
      filename: name,
    });
  }
  civAssets.sort((a, b) =>
    String(b.atakVersion).localeCompare(String(a.atakVersion), undefined, { numeric: true })
  );
  return civAssets;
}

/**
 * Resolve a monorepo folder to its public release repo + latest CIV assets.
 * Tries candidate slugs against the org; accepts the first release whose APKs
 * match the folder name (skips data-only repos like plss-data).
 * @param {string} folderName
 * @param {object[]} orgRepos
 * @returns {Promise<object|null>}
 */
async function resolveFolderToCatalogEntry(folderName, orgRepos) {
  const byName = new Map(
    (orgRepos || []).map((r) => [String(r.name || "").toLowerCase(), r])
  );
  const candidates = candidateRepoSlugs(folderName, orgRepos);

  for (const slug of candidates) {
    if (!byName.has(slug)) continue;
    let release;
    try {
      release = await githubGetJson(`/repos/${TAKWERX_OWNER}/${slug}/releases/latest`);
    } catch (err) {
      if (err?.statusCode === 404) continue;
      throw err;
    }
    if (!releaseMatchesFolder(release, folderName)) continue;

    const civAssets = civAssetsFromRelease(release);
    if (civAssets.length === 0) continue;

    const repoMeta = byName.get(slug);
    const displayName = displayNameFromRelease(release, folderName);
    const packageName = await discoverPackageName(folderName);
    const tag = (release.tag_name || release.name || "").replace(/^v/i, "") || null;

    return {
      id: slug,
      repo: slug,
      folder: folderName,
      display_name: displayName,
      description: cleanRepoDescription(repoMeta, displayName),
      package_name: packageName,
      version: tag,
      repo_url: repoMeta?.html_url || `https://github.com/${TAKWERX_OWNER}/${slug}`,
      release_url: release.html_url || `https://github.com/${TAKWERX_OWNER}/${slug}/releases`,
      source: "takwerx",
      assets: civAssets,
    };
  }

  return null;
}

/**
 * Discover catalog entries from monorepo folders + public takwerx release repos.
 * @returns {Promise<object[]>}
 */
async function discoverCatalogEntries() {
  const [folders, orgRepos] = await Promise.all([
    listMonorepoPluginFolders(),
    listTakwerxPublicRepos(),
  ]);

  const results = await Promise.allSettled(
    folders.map((folderName) => resolveFolderToCatalogEntry(folderName, orgRepos))
  );

  const entries = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value) {
      entries.push(r.value);
    } else if (r.status === "rejected") {
      console.warn(
        "[takwerxPlugins] resolve failed for",
        folders[i],
        r.reason?.message || r.reason
      );
    }
  });

  entries.sort((a, b) =>
    String(a.display_name || a.id).localeCompare(String(b.display_name || b.id))
  );
  return entries;
}

/** @deprecated Use discoverCatalogEntries. */
async function discoverCatalogSeeds() {
  return discoverCatalogEntries();
}

async function refreshCatalogFromGithub() {
  let entries;
  try {
    entries = await discoverCatalogEntries();
  } catch (err) {
    return {
      success: false,
      error: err?.message || "Failed to discover TAKwerx plugins from GitHub.",
    };
  }

  if (!entries.length) {
    return {
      success: false,
      error: "No TAKwerx plugins with published CIV release APKs were found.",
    };
  }

  catalogCache = { entries, expiry: Date.now() + CACHE_TTL_MS };
  return { success: true, entries };
}

/**
 * Load full catalog (all plugins + all CIV assets). Shared cache; one GitHub refresh at a time.
 * @returns {Promise<{ success: boolean, entries?: object[], error?: string }>}
 */
async function loadCatalogEntries() {
  if (catalogCache && catalogCache.expiry > Date.now()) {
    return { success: true, entries: catalogCache.entries };
  }

  if (catalogRefreshInFlight) {
    return catalogRefreshInFlight;
  }

  catalogRefreshInFlight = (async () => {
    try {
      const result = await refreshCatalogFromGithub();
      if (!result.success && catalogCache?.entries?.length) {
        console.warn("[takwerxPlugins] refresh failed; serving stale cache:", result.error);
        catalogCache = {
          entries: catalogCache.entries,
          expiry: Date.now() + Math.min(CACHE_TTL_MS, 15 * 60 * 1000),
        };
        return { success: true, entries: catalogCache.entries };
      }
      return result;
    } finally {
      catalogRefreshInFlight = null;
    }
  })();

  return catalogRefreshInFlight;
}

/**
 * Collect ATAK CIV versions present across catalog assets (desc).
 * Only versions that have at least one CIV release APK.
 * @param {object[]} entries
 * @returns {string[]}
 */
function collectAvailableVersions(entries) {
  const set = new Set();
  for (const e of entries || []) {
    for (const a of e.assets || []) {
      if (a.atakVersion && a.apk_url) set.add(normalizeAtakVersion(a.atakVersion));
    }
  }
  return Array.from(set).sort((a, b) =>
    String(b).localeCompare(String(a), undefined, { numeric: true })
  );
}

/** Normalize ATAK version strings to major.minor.patch (e.g. 5.8 → 5.8.0). */
function normalizeAtakVersion(version) {
  const s = String(version || "").trim();
  const m = s.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return s;
  return `${m[1]}.${m[2]}.${m[3] != null ? m[3] : "0"}`;
}

/**
 * List TAKwerx plugins for a given ATAK CIV product version.
 * Plugins without a CIV APK for that exact ATAK version are omitted.
 * @param {string} [productVersion] e.g. "5.8.0"
 * @returns {Promise<{ success: boolean, plugins?: object[], versions?: string[], error?: string }>}
 */
async function fetchTakwerxPlugins(productVersion) {
  const loaded = await loadCatalogEntries();
  if (!loaded.success) return loaded;

  const versions = collectAvailableVersions(loaded.entries);
  let want = normalizeAtakVersion((productVersion || "").trim());
  if (!want && versions.length) want = versions[0];
  if (want && versions.length && !versions.includes(want)) {
    return { success: true, plugins: [], versions };
  }

  const plugins = [];
  for (const e of loaded.entries) {
    const asset = (e.assets || []).find(
      (a) => a.apk_url && normalizeAtakVersion(a.atakVersion) === want
    );
    if (!asset) continue;
    plugins.push({
      id: e.id,
      repo: e.repo,
      display_name: e.display_name,
      description: e.description,
      package_name: e.package_name,
      version: e.version,
      apk_url: asset.apk_url,
      apk_size_bytes: asset.size,
      filename: asset.filename,
      atakVersion: normalizeAtakVersion(asset.atakVersion),
      atak_version: normalizeAtakVersion(asset.atakVersion),
      product: "ATAK-CIV",
      repo_url: e.repo_url,
      release_url: e.release_url,
      source: "takwerx",
    });
  }

  return { success: true, plugins, versions };
}

/**
 * Download a TAKwerx plugin APK into the portal catalog.
 * @param {object} pluginItem
 * @returns {Promise<{ success: boolean, plugin?: object, error?: string }>}
 */
async function downloadTakwerxPlugin(pluginItem) {
  const apkUrl = pluginItem?.apk_url;
  if (!apkUrl || typeof apkUrl !== "string") {
    return { success: false, error: "Plugin apk_url is required." };
  }
  if (!isAllowedTakwerxApkUrl(apkUrl)) {
    return { success: false, error: "Invalid TAKwerx download URL." };
  }

  const atakVersion =
    pluginItem.atakVersion || pluginItem.atak_version || pluginItem.product_version || null;

  return pluginsSvc.addPluginFromUrl(apkUrl, {
    name: pluginItem.display_name || pluginItem.name || undefined,
    description: pluginItem.description || undefined,
    source: "takwerx",
    atakFlavor: pluginItem.product || "ATAK-CIV",
    atakVersion: atakVersion || undefined,
    package_name: pluginItem.package_name || undefined,
    version: pluginItem.version || undefined,
  });
}

/**
 * Map installed TAKwerx plugin ids -> whether a newer GitHub release exists for their ATAK version.
 * @param {object[]} installed
 * @returns {Promise<Record<string, boolean>>}
 */
async function getUpdateStatusForInstalled(installed) {
  const loaded = await loadCatalogEntries();
  if (!loaded.success) return {};
  const out = {};
  for (const p of installed || []) {
    if (!p || !p.id || !p.package_name) continue;
    const want = normalizeAtakVersion(
      p.atakVersion || p.atak_version || pluginsSvc.getAtakVersionValue(p) || ""
    );
    const entry = (loaded.entries || []).find((e) => e.package_name === p.package_name);
    if (!entry) {
      out[p.id] = false;
      continue;
    }
    const asset = (entry.assets || []).find(
      (a) => a.apk_url && normalizeAtakVersion(a.atakVersion) === want
    );
    if (!asset) {
      out[p.id] = false;
      continue;
    }
    out[p.id] = pluginsSvc.isNewerVersion(p, { version: entry.version });
  }
  return out;
}

/**
 * Re-download the latest matching TAKwerx release for an installed plugin.
 * @param {object} plugin - manifest plugin entry
 */
async function updateInstalledPlugin(plugin) {
  if (!plugin || !plugin.package_name) {
    return { success: false, error: "Plugin package name is required." };
  }
  const productVersion = normalizeAtakVersion(
    plugin.atakVersion || plugin.atak_version || pluginsSvc.getAtakVersionValue(plugin) || ""
  );
  const listResult = await fetchTakwerxPlugins(productVersion || undefined);
  if (!listResult.success) {
    return { success: false, error: listResult.error || "Failed to load TAKwerx catalog." };
  }
  const remote = (listResult.plugins || []).find((r) => r.package_name === plugin.package_name);
  if (!remote || !remote.apk_url) {
    return { success: false, error: "Plugin not found in TAKwerx releases for this ATAK version." };
  }
  if (!pluginsSvc.isNewerVersion(plugin, remote)) {
    return { success: false, error: "Plugin is already up to date." };
  }
  return downloadTakwerxPlugin(remote);
}

module.exports = {
  fetchTakwerxPlugins,
  downloadTakwerxPlugin,
  getUpdateStatusForInstalled,
  updateInstalledPlugin,
  isAllowedTakwerxApkUrl,
  discoverCatalogEntries,
  discoverCatalogSeeds,
  loadCatalogEntries,
};
