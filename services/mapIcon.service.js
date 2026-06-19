/**
 * TAK icon resolution using CloudTAK-Data iconsets.
 * @see https://github.com/dfpc-coe/CloudTAK-Data
 */
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const axios = require("axios");
const unzipper = require("unzipper");

const CLOUDTAK_RAW =
  "https://raw.githubusercontent.com/dfpc-coe/CloudTAK-Data/main";

const ICONSET_ARCHIVES = [
  "Public Safety Air.zip",
  "Responder Icons.zip",
  "FEMA Icons.zip",
  "Incident Management Icons.zip",
  "FalconView.zip",
  "Generic Icons.zip",
  "GeoOps.zip",
  "Google.zip",
  "OSM.zip",
  "Default.zip",
];

const DEFAULT_ICONSET_UID = "34ae1613-9645-4222-a9d2-e5f243dea2865";
/** Generic Icons — ATAK paths missing from CloudTAK-Data zip. */
const GENERIC_ICONS_UID = "ad78aafb-83a6-4c07-b2b9-a897a8b6a38f";
const PUBLIC_SAFETY_AIR_UID = "66f14976-4b62-4023-8edb-d8d2ebeaa336";

/** Lower index = preferred when multiple iconsets share a type2525b mapping. */
const ICONSET_LOOKUP_PRIORITY = [
  PUBLIC_SAFETY_AIR_UID,
  GENERIC_ICONS_UID,
  DEFAULT_ICONSET_UID,
];
const DATA_ROOT = path.join(__dirname, "..", "data", "map-icons");
const SUPPLEMENT_ROOT = path.join(__dirname, "..", "data", "map-icon-supplement");

/** iconsetUid|relPath or basename -> alternate icon location */
const ICON_PATH_ALIASES = new Map([
  [
    `${GENERIC_ICONS_UID}|Shapes/walkingpersonnel.png`,
    { iconsetUid: DEFAULT_ICONSET_UID, relPath: "People/walk.png" },
  ],
  ["walkingpersonnel.png", { iconsetUid: DEFAULT_ICONSET_UID, relPath: "People/walk.png" }],
]);

/** @type {Map<string, object>} */
const iconsetsByUid = new Map();
/** @type {Map<string, { iconsetUid: string, iconName: string, relPath: string, type2525b: string }[]>} */
const typesByPrefix = new Map();
/** @type {Map<string, Promise<void>>} */
const initPromise = { current: null };

function decodeXmlAttr(tag, name) {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`, "i"));
  return m ? m[1] : "";
}

function parseIconsetXml(xml, dirName) {
  const header = xml.match(/<iconset[^>]*>/i);
  if (!header) return null;

  const tag = header[0];
  const uid = decodeXmlAttr(tag, "uid");
  if (!uid) return null;

  const iconset = {
    uid,
    name: decodeXmlAttr(tag, "name") || dirName,
    dirName,
    rootDir: path.join(DATA_ROOT, dirName),
    defaultGroup: decodeXmlAttr(tag, "defaultGroup") || "",
    defaultFriendly: decodeXmlAttr(tag, "defaultFriendly") || "",
    defaultHostile: decodeXmlAttr(tag, "defaultHostile") || "",
    defaultNeutral: decodeXmlAttr(tag, "defaultNeutral") || "",
    defaultUnknown: decodeXmlAttr(tag, "defaultUnknown") || "",
    icons: [],
    fileByBase: new Map(),
  };

  for (const m of xml.matchAll(/<icon\s+([^>]+?)\/?>/gi)) {
    const attrs = m[1];
    const name = decodeXmlAttr(attrs, "name");
    if (!name) continue;
    iconset.icons.push({
      name,
      type2525b: decodeXmlAttr(attrs, "type2525b") || "",
      group: decodeXmlAttr(attrs, "group") || "",
    });
  }

  return iconset;
}

async function walkPngFiles(dir, out = []) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkPngFiles(full, out);
    } else if (/\.png$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

async function buildFileIndex(iconset) {
  iconset.fileByBase.clear();
  const files = await walkPngFiles(iconset.rootDir);
  for (const abs of files) {
    const rel = path.relative(iconset.rootDir, abs).replace(/\\/g, "/");
    const base = path.basename(rel).toLowerCase();
    if (!iconset.fileByBase.has(base)) iconset.fileByBase.set(base, rel);
  }
}

function registerTypeIndex(iconset, iconName, relPath, type2525b) {
  if (!type2525b) return;
  const key = type2525b.toLowerCase();
  const list = typesByPrefix.get(key) || [];
  list.push({ iconsetUid: iconset.uid, iconName, relPath, type2525b: key });
  typesByPrefix.set(key, list);
}

function iconsetLookupRank(iconsetUid) {
  const idx = ICONSET_LOOKUP_PRIORITY.indexOf(String(iconsetUid || ""));
  if (idx >= 0) return ICONSET_LOOKUP_PRIORITY.length - idx;
  return 1;
}

function pickBestTypeEntry(entries, cotType) {
  const t = String(cotType || "").trim().toLowerCase();
  let best = null;
  for (const entry of entries || []) {
    const exact = entry.type2525b === t;
    const score = iconsetLookupRank(entry.iconsetUid) * 100 + (exact ? 50 : 0);
    if (!best || score > best.score) best = { score, entry };
  }
  return best?.entry || null;
}

function inferType2525bFromIconName(iconName) {
  const base = String(iconName || "")
    .trim()
    .replace(/\.png$/i, "");
  if (/^a-[a-z]-/i.test(base)) return base;
  return "";
}

function resolveRelativePath(iconset, iconName, groupHint) {
  const base = String(iconName || "").trim();
  if (!base) return null;

  const fromIndex = iconset.fileByBase.get(base.toLowerCase());
  if (fromIndex) return fromIndex;

  const group = String(groupHint || iconset.defaultGroup || "").trim();
  if (group) {
    const candidate = `${group}/${base}`.replace(/\\/g, "/");
    const abs = path.join(iconset.rootDir, candidate);
    if (fs.existsSync(abs)) return candidate;
  }

  for (const rel of iconset.fileByBase.values()) {
    if (rel.toLowerCase().endsWith("/" + base.toLowerCase())) return rel;
  }

  return null;
}

function makeIconId(iconsetUid, relPath) {
  return `${iconsetUid}:${relPath.replace(/\\/g, "/")}`;
}

function parseIconsetPath(iconsetpath) {
  const raw = String(iconsetpath || "").trim();
  if (!raw) return null;

  if (/^COT_MAPPING_2525B\//i.test(raw)) {
    const parts = raw.split("/").filter(Boolean);
    const cotType = parts.length > 1 ? parts.slice(1).join("-") : "";
    return { mode: "type", cotType };
  }

  if (/^COT_MAPPING_SPOTMAP\//i.test(raw)) {
    const parts = raw.split("/").filter(Boolean);
    const cotType = parts.length > 1 ? parts.slice(1).join("-") : "";
    return { mode: "type", cotType };
  }

  const slash = raw.indexOf("/");
  if (slash <= 0) return null;
  const uid = raw.slice(0, slash);
  const rel = raw.slice(slash + 1);
  if (!/^[0-9a-f-]{36}$/i.test(uid)) return null;
  return { mode: "path", iconsetUid: uid, relPath: rel };
}

function findBestTypeMatch(cotType) {
  const t = String(cotType || "").trim().toLowerCase();
  if (!t) return null;

  const exactList = typesByPrefix.get(t);
  if (exactList && exactList.length) {
    return pickBestTypeEntry(exactList, t);
  }

  let best = null;
  for (const [prefix, entries] of typesByPrefix) {
    if (!t.startsWith(prefix)) continue;
    const entry = pickBestTypeEntry(entries, t);
    if (!entry) continue;
    const score = prefix.length * 1000 + iconsetLookupRank(entry.iconsetUid);
    if (!best || score > best.score) {
      best = { score, entry };
    }
  }
  return best?.entry || null;
}

function defaultIconNameForAffiliation(iconset, affiliation) {
  switch (affiliation) {
    case "friend":
      return iconset.defaultFriendly;
    case "hostile":
      return iconset.defaultHostile;
    case "neutral":
      return iconset.defaultNeutral;
    case "unknown":
      return iconset.defaultUnknown;
    default:
      return iconset.defaultUnknown || iconset.defaultFriendly;
  }
}

function buildIconResult(iconset, relPath, source) {
  if (!relPath) return null;
  const abs = path.join(iconset.rootDir, relPath);
  if (!fs.existsSync(abs)) return null;
  return {
    iconId: makeIconId(iconset.uid, relPath),
    iconsetUid: iconset.uid,
    relPath,
    source,
  };
}

function resolveFromIconset(iconset, { cotType, iconName, groupHint, affiliation }) {
  if (iconName) {
    const rel = resolveRelativePath(iconset, iconName, groupHint);
    const hit = buildIconResult(iconset, rel, "usericon");
    if (hit) return hit;
  }

  const typeHit = findBestTypeMatch(cotType);
  if (typeHit && typeHit.iconsetUid === iconset.uid) {
    const hit = buildIconResult(iconset, typeHit.relPath, "type2525b");
    if (hit) return hit;
  }

  const fallbackName = defaultIconNameForAffiliation(iconset, affiliation);
  if (fallbackName) {
    const rel = resolveRelativePath(iconset, fallbackName, iconset.defaultGroup);
    const hit = buildIconResult(iconset, rel, "default");
    if (hit) return hit;
  }

  return null;
}

function resolveIconPathAlias(iconsetUid, relPath) {
  const normalized = String(relPath || "").replace(/\\/g, "/");
  const uid = String(iconsetUid || "");
  const keyed = ICON_PATH_ALIASES.get(`${uid}|${normalized}`);
  if (keyed) return keyed;
  const base = path.basename(normalized).toLowerCase();
  return ICON_PATH_ALIASES.get(base) || null;
}

function resolveAliasedIcon(alias) {
  if (!alias) return null;
  const iconset = iconsetsByUid.get(alias.iconsetUid);
  if (!iconset) return null;
  const rel = String(alias.relPath || "").replace(/\\/g, "/");
  return buildIconResult(iconset, rel, "alias");
}

function parseUserIcon(detail) {
  const attrs = detail?.usericon?._attributes || detail?.usericon || {};
  const iconsetpath = attrs.iconsetpath || attrs.iconsetPath || "";
  let name = attrs.name || "";
  if (!name && iconsetpath) {
    const parsed = parseIconsetPath(iconsetpath);
    if (parsed?.mode === "path") {
      name = path.basename(parsed.relPath);
    }
  }
  return {
    iconsetpath,
    group: attrs.group || attrs.groupName || "",
    name,
  };
}

function resolveIcon({ type, affiliation, detail, usericon }) {
  const ui = usericon || parseUserIcon(detail);
  let cotType = String(type || "").trim();
  let directPath = null;

  const parsedPath = parseIconsetPath(ui.iconsetpath);
  if (parsedPath?.mode === "type") {
    cotType = parsedPath.cotType || cotType;
  } else if (parsedPath?.mode === "path") {
    directPath = parsedPath;
  }

  if (directPath) {
    const iconset = iconsetsByUid.get(directPath.iconsetUid);
    if (iconset) {
      const rel = directPath.relPath.replace(/\\/g, "/");
      const abs = path.join(iconset.rootDir, rel);
      if (fs.existsSync(abs)) {
        return buildIconResult(iconset, rel, "path");
      }
      const base = path.basename(rel);
      const resolved = resolveRelativePath(iconset, base, path.dirname(rel));
      const hit = buildIconResult(iconset, resolved, "path");
      if (hit) return hit;
      const aliasHit = resolveAliasedIcon(
        resolveIconPathAlias(directPath.iconsetUid, rel)
      );
      if (aliasHit) return aliasHit;
    } else {
      const aliasHit = resolveAliasedIcon(
        resolveIconPathAlias(directPath.iconsetUid, directPath.relPath)
      );
      if (aliasHit) return aliasHit;
    }
  }

  const globalTypeHit = findBestTypeMatch(cotType);
  if (globalTypeHit) {
    const iconset = iconsetsByUid.get(globalTypeHit.iconsetUid);
    if (iconset) {
      const hit = buildIconResult(iconset, globalTypeHit.relPath, "type2525b");
      if (hit) return hit;
    }
  }

  const defaultIconset = iconsetsByUid.get(DEFAULT_ICONSET_UID);
  if (defaultIconset) {
    const hit = resolveFromIconset(defaultIconset, {
      cotType,
      iconName: ui.name,
      groupHint: ui.group,
      affiliation,
    });
    if (hit) return hit;
  }

  for (const iconset of iconsetsByUid.values()) {
    if (iconset.uid === DEFAULT_ICONSET_UID) continue;
    const hit = resolveFromIconset(iconset, {
      cotType,
      iconName: ui.name,
      groupHint: ui.group,
      affiliation,
    });
    if (hit) return hit;
  }

  return null;
}

function getIconFilePath(iconId) {
  const raw = String(iconId || "").trim();
  const colon = raw.indexOf(":");
  if (colon <= 0) return null;
  const uid = raw.slice(0, colon);
  const rel = raw.slice(colon + 1).replace(/\\/g, "/");
  const iconset = iconsetsByUid.get(uid);
  if (!iconset) return null;
  const abs = path.join(iconset.rootDir, rel);
  if (!abs.startsWith(iconset.rootDir)) return null;
  if (!fs.existsSync(abs)) return null;
  return abs;
}

function getDefaultIconIds() {
  const iconset = iconsetsByUid.get(DEFAULT_ICONSET_UID);
  if (!iconset) return {};
  const out = {};
  for (const aff of ["friend", "hostile", "neutral", "unknown"]) {
    const name = defaultIconNameForAffiliation(iconset, aff);
    const rel = resolveRelativePath(iconset, name, iconset.defaultGroup);
    const hit = buildIconResult(iconset, rel, "default");
    if (hit) out[aff] = hit.iconId;
  }
  return out;
}

async function downloadAndExtract(zipName) {
  const dirName = zipName.replace(/\.zip$/i, "");
  const destDir = path.join(DATA_ROOT, dirName);
  const xmlPath = path.join(destDir, "iconset.xml");
  if (fs.existsSync(xmlPath)) return destDir;

  await fsp.mkdir(destDir, { recursive: true });
  const url = `${CLOUDTAK_RAW}/iconsets/${encodeURIComponent(zipName)}`;
  const resp = await axios.get(url, { responseType: "arraybuffer", timeout: 120000 });
  const buf = Buffer.from(resp.data);

  await new Promise((resolve, reject) => {
    const stream = unzipper.Parse();
    stream.on("entry", (entry) => {
      const name = entry.path.replace(/\\/g, "/");
      const outPath = path.join(destDir, name);
      if (entry.type === "Directory") {
        entry.autodrain();
        return;
      }
      const dir = path.dirname(outPath);
      fs.mkdirSync(dir, { recursive: true });
      entry.pipe(fs.createWriteStream(outPath));
    });
    stream.on("close", resolve);
    stream.on("error", reject);
    stream.end(buf);
  });

  return destDir;
}

async function loadIconsetDir(dirName) {
  const rootDir = path.join(DATA_ROOT, dirName);
  const xmlPath = path.join(rootDir, "iconset.xml");
  if (!fs.existsSync(xmlPath)) return null;

  const xml = await fsp.readFile(xmlPath, "utf8");
  const iconset = parseIconsetXml(xml, dirName);
  if (!iconset) return null;

  await buildFileIndex(iconset);
  iconsetsByUid.set(iconset.uid, iconset);

  for (const icon of iconset.icons) {
    const rel = resolveRelativePath(iconset, icon.name, icon.group || iconset.defaultGroup);
    if (!rel) continue;
    const type2525b = icon.type2525b || inferType2525bFromIconName(icon.name);
    if (type2525b) {
      registerTypeIndex(iconset, icon.name, rel, type2525b);
    }
  }

  return iconset;
}

async function mergeIconSupplements() {
  if (!fs.existsSync(SUPPLEMENT_ROOT)) return;
  let entries;
  try {
    entries = await fsp.readdir(SUPPLEMENT_ROOT, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;
    const iconset = [...iconsetsByUid.values()].find((set) => set.dirName === dirName);
    if (!iconset) continue;
    const supplementDir = path.join(SUPPLEMENT_ROOT, dirName);
    const files = await walkPngFiles(supplementDir);
    for (const abs of files) {
      const rel = path.relative(supplementDir, abs).replace(/\\/g, "/");
      const dest = path.join(iconset.rootDir, rel);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      try {
        await fsp.copyFile(abs, dest);
      } catch (_) {}
    }
    await buildFileIndex(iconset);
  }
}

async function countIconsetDirsOnDisk() {
  let count = 0;
  try {
    const entries = await fsp.readdir(DATA_ROOT, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (fs.existsSync(path.join(DATA_ROOT, entry.name, "iconset.xml"))) count++;
    }
  } catch (_) {}
  return count;
}

async function ensureIconsets() {
  const dirsOnDisk = await countIconsetDirsOnDisk();
  if (
    initPromise.current &&
    iconsetsByUid.size > 0 &&
    (dirsOnDisk === 0 || iconsetsByUid.size >= dirsOnDisk)
  ) {
    return initPromise.current;
  }

  initPromise.current = (async () => {
    await fsp.mkdir(DATA_ROOT, { recursive: true });

    for (const zip of ICONSET_ARCHIVES) {
      const dirName = zip.replace(/\.zip$/i, "");
      const xmlPath = path.join(DATA_ROOT, dirName, "iconset.xml");
      if (fs.existsSync(xmlPath)) continue;
      try {
        await downloadAndExtract(zip);
      } catch (err) {
        console.warn("[map-icon] failed to fetch iconset", zip, err?.message || err);
      }
    }

    typesByPrefix.clear();
    iconsetsByUid.clear();

    for (const zip of ICONSET_ARCHIVES) {
      const dirName = zip.replace(/\.zip$/i, "");
      try {
        await loadIconsetDir(dirName);
      } catch (err) {
        console.warn("[map-icon] failed to load iconset", dirName, err?.message || err);
      }
    }

    await mergeIconSupplements();
  })();

  return initPromise.current;
}

function getStatus() {
  return {
    ready: iconsetsByUid.size > 0,
    iconsetCount: iconsetsByUid.size,
    typeMappings: typesByPrefix.size,
    defaultIcons: getDefaultIconIds(),
  };
}

module.exports = {
  ensureIconsets,
  resolveIcon,
  parseUserIcon,
  getIconFilePath,
  getDefaultIconIds,
  getStatus,
  DEFAULT_ICONSET_UID,
};
