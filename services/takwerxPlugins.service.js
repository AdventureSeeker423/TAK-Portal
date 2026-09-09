/**
 * TAKwerx plugin catalog: curated public GitHub release repos.
 * Fetches latest release assets and maps CIV APKs by ATAK version.
 *
 * No GitHub auth — stays under the unauthenticated API limit by:
 * caching the full catalog for hours, coalescing concurrent refreshes,
 * and serving stale cache if GitHub is unreachable/rate-limited.
 */

const pluginsSvc = require("./plugins.service");

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "TAK-Portal-TAKwerx-Plugins";
/** Six repos × one request; long TTL keeps us well under GitHub's unauthenticated hourly limit. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Curated catalog matching takwerx/atak-plugins README public repos. */
const TAKWERX_CATALOG = [
  {
    id: "plss-grid",
    repo: "plss-grid",
    displayName: "PLSS Grid",
    description: "Township, range and section overlay from BLM survey data",
    packageName: "com.atakmap.android.plss.plugin",
  },
  {
    id: "traffic",
    repo: "traffic",
    displayName: "Traffic",
    description: "Live traffic over your own base map, refreshing while the map sits still",
    packageName: "com.atakmap.android.traffic.plugin",
  },
  {
    id: "map-depot",
    repo: "map-depot",
    displayName: "Map Depot",
    description: "Elevation, base maps and offline public-lands maps, downloaded from inside ATAK",
    packageName: "com.atakmap.android.mapdepot.plugin",
  },
  {
    id: "cam-depot",
    repo: "cam-depot",
    displayName: "Cam Depot",
    description: "Public traffic and wildfire cameras on the map, with live video where the agency streams",
    packageName: "com.atakmap.android.camdepot.plugin",
  },
  {
    id: "fobs",
    repo: "fobs",
    displayName: "FOBS",
    description: "Field Observation Survey: walk, draw, import, split and join a perimeter into an ATAK shape",
    packageName: "com.atakmap.android.fobs.plugin",
  },
  {
    id: "takwerx-market",
    repo: "takwerx-market",
    displayName: "TAKwerx Market",
    description: "Install and update TAKwerx plugins from inside ATAK, with a count of waiting updates on the toolbar",
    packageName: "com.atakmap.android.takwerxmarket.plugin",
  },
];

/** @type {{ expiry: number, entries: object[] } | null} */
let catalogCache = null;
/** @type {Promise<{ success: boolean, entries?: object[], error?: string }> | null} */
let catalogRefreshInFlight = null;

const APK_ASSET_RE = /^ATAK-Plugin-.+?--(\d+\.\d+\.\d+)-civ-release\.apk$/i;

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
    if (parts[0] !== "takwerx") return false;
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
 * Fetch latest release for one catalog entry and normalize assets.
 * @param {typeof TAKWERX_CATALOG[0]} seed
 */
async function fetchLatestForSeed(seed) {
  const release = await githubGetJson(`/repos/takwerx/${seed.repo}/releases/latest`);
  const assets = Array.isArray(release.assets) ? release.assets : [];
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
  civAssets.sort((a, b) => String(b.atakVersion).localeCompare(String(a.atakVersion), undefined, { numeric: true }));
  const tag = (release.tag_name || release.name || "").replace(/^v/i, "") || null;
  return {
    id: seed.id,
    repo: seed.repo,
    display_name: seed.displayName,
    description: seed.description,
    package_name: seed.packageName,
    version: tag,
    repo_url: `https://github.com/takwerx/${seed.repo}`,
    release_url: release.html_url || `https://github.com/takwerx/${seed.repo}/releases`,
    source: "takwerx",
    assets: civAssets,
  };
}

async function refreshCatalogFromGithub() {
  const results = await Promise.allSettled(TAKWERX_CATALOG.map((seed) => fetchLatestForSeed(seed)));
  const entries = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      entries.push(r.value);
    } else {
      const seed = TAKWERX_CATALOG[i];
      errors.push(`${seed.displayName}: ${r.reason?.message || "failed"}`);
      console.warn("[takwerxPlugins] fetch failed for", seed.repo, r.reason?.message || r.reason);
    }
  });

  if (entries.length === 0) {
    return {
      success: false,
      error: errors.length ? errors.join("; ") : "Failed to load TAKwerx plugins from GitHub.",
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
        // Rate limit / outage: keep serving last known catalog.
        console.warn("[takwerxPlugins] refresh failed; serving stale cache:", result.error);
        catalogCache = {
          entries: catalogCache.entries,
          expiry: Date.now() + Math.min(CACHE_TTL_MS, 30 * 60 * 1000),
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
    // Selected ATAK version has no builds in the catalog — return empty list.
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

module.exports = {
  TAKWERX_CATALOG,
  fetchTakwerxPlugins,
  downloadTakwerxPlugin,
  isAllowedTakwerxApkUrl,
};
