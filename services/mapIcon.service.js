/**
 * TAK icon resolution using bundled CloudTAK-Data iconsets.
 * @see assets/map-icons/ATTRIBUTION.md
 * @see docs/icon-parity.md
 */
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const mapIconResolve = require("./mapIcon.resolve");
const mapMilSym = require("./mapMilSym.service");

const DATA_ROOT = path.join(__dirname, "..", "assets", "map-icons");
const SUPPLEMENT_ROOT = path.join(__dirname, "..", "data", "map-icon-supplement");

const {
  DEFAULT_ICONSET_UID,
  PUBLIC_SAFETY_AIR_UID,
  GENERIC_ICONS_UID,
  ICON_PATH_ALIASES,
} = mapIconResolve;

/** Bundled iconset directory names (must match assets/map-icons/). */
const REQUIRED_ICONSET_DIRS = [
  "Public Safety Air",
  "Responder Icons",
  "FEMA Icons",
  "Incident Management Icons",
  "FalconView",
  "Generic Icons",
  "GeoOps",
  "Google",
  "OSM",
  "Default",
];

/** @type {Map<string, object>} */
const iconsetsByUid = new Map();
/** @type {Map<string, { iconsetUid: string, iconName: string, relPath: string, type2525b: string }[]>} */
const typesByPrefix = new Map();
/** @type {{ current: Promise<void>|null }} */
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

  return {
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

function registry() {
  return { iconsetsByUid, typesByPrefix };
}

function resolveIcon({ type, affiliation, detail, usericon }) {
  return mapIconResolve.resolvePngIcon(
    { type, affiliation, detail, usericon },
    registry()
  );
}

async function resolveIconAsync({ type, affiliation, detail, usericon }) {
  const png = mapIconResolve.resolvePngIcon(
    { type, affiliation, detail, usericon },
    registry()
  );
  if (png) return png;

  const ui = usericon || mapIconResolve.parseUserIcon(detail);
  const parsedPath = mapIconResolve.parseIconsetPath(ui.iconsetpath);
  let cotType = String(type || "").trim();
  if (
    parsedPath?.mode === "type" &&
    !mapIconResolve.isStandardGroundEudType(cotType) &&
    !mapIconResolve.isStandardGroundEudType(parsedPath.cotType)
  ) {
    cotType = parsedPath.cotType || cotType;
  }

  // Never milsym-render ground EUDs. Type2525.to2525D("a-f-G-U-C") is land aviation (bowtie).
  if (
    mapIconResolve.isStandardGroundEudType(type) ||
    mapIconResolve.isStandardGroundEudType(cotType)
  ) {
    return null;
  }

  const milId = await mapMilSym.cotTypeTo2525DIconId(cotType);
  if (milId) {
    return {
      iconId: milId,
      iconsetUid: null,
      relPath: null,
      source: "milsym",
    };
  }
  return null;
}

function explainIconResolution({ type, affiliation, detail, usericon, origin }) {
  const ui = usericon || mapIconResolve.parseUserIcon(detail);
  const cotType = String(type || "").trim();
  const resolved = resolveIcon({ type, affiliation, detail, usericon });
  const typeHit = mapIconResolve.findBestTypeMatch(cotType, typesByPrefix, iconsetsByUid);
  const filePath = resolved?.iconId ? getIconFilePath(resolved.iconId) : null;

  return {
    inputs: {
      type: cotType,
      affiliation: affiliation || null,
      origin: origin || null,
      usericon: ui,
    },
    domain: mapIconResolve.cotDomain(cotType),
    domainPriority: mapIconResolve.domainPriorityList(cotType, iconsetsByUid),
    typeMatch: typeHit
      ? {
          iconsetUid: typeHit.iconsetUid,
          iconName: typeHit.iconName,
          relPath: typeHit.relPath,
          type2525b: typeHit.type2525b,
        }
      : null,
    milsym: {
      convertable: null,
      iconId: null,
      sidc2525b: null,
    },
    resolved: resolved
      ? {
          ...resolved,
          fileExists: !!filePath,
          filePath: filePath || null,
        }
      : null,
  };
}

async function explainIconResolutionAsync({
  type,
  affiliation,
  detail,
  usericon,
  origin,
}) {
  const base = explainIconResolution({ type, affiliation, detail, usericon, origin });
  const cotType = String(type || "").trim();
  const convertable = await mapMilSym.isCotTypeConvertableAsync(cotType);
  const milId = convertable ? await mapMilSym.cotTypeTo2525DIconId(cotType) : null;
  const sidc2525b = convertable ? await mapMilSym.cotTypeTo2525B(cotType) : null;

  if (!base.resolved) {
    const asyncResolved = await resolveIconAsync({ type, affiliation, detail, usericon });
    if (asyncResolved) {
      base.resolved = {
        ...asyncResolved,
        fileExists: mapMilSym.isMilSymIconId(asyncResolved.iconId),
        filePath: null,
      };
    }
  }

  base.milsym = {
    convertable,
    iconId: milId,
    sidc2525b,
  };
  return base;
}

function getIconFilePath(iconId) {
  const raw = String(iconId || "").trim();
  if (mapMilSym.isMilSymIconId(raw)) return null;
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
    const name = mapIconResolve.defaultIconNameForAffiliation(iconset, aff);
    const rel = mapIconResolve.resolveRelativePath(iconset, name, iconset.defaultGroup);
    const hit = mapIconResolve.buildIconResult(iconset, rel, "default");
    if (hit) out[aff] = hit.iconId;
  }
  return out;
}

async function loadIconsetDir(dirName) {
  const rootDir = path.join(DATA_ROOT, dirName);
  const xmlPath = path.join(rootDir, "iconset.xml");
  if (!fs.existsSync(xmlPath)) return null;

  const xml = await fsp.readFile(xmlPath, "utf8");
  const iconset = parseIconsetXml(xml, dirName);
  if (!iconset) return null;

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

  await buildFileIndex(iconset);
  iconsetsByUid.set(iconset.uid, iconset);

  for (const icon of iconset.icons) {
    const rel = mapIconResolve.resolveRelativePath(
      iconset,
      icon.name,
      icon.group || iconset.defaultGroup
    );
    if (!rel) continue;
    const type2525b =
      icon.type2525b || mapIconResolve.inferType2525bFromIconName(icon.name);
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

async function ensureIconsets() {
  if (initPromise.current && iconsetsByUid.size > 0) {
    return initPromise.current;
  }

  initPromise.current = (async () => {
    typesByPrefix.clear();
    iconsetsByUid.clear();

    const missing = [];
    for (const dirName of REQUIRED_ICONSET_DIRS) {
      const xmlPath = path.join(DATA_ROOT, dirName, "iconset.xml");
      if (!fs.existsSync(xmlPath)) missing.push(dirName);
    }
    if (missing.length) {
      console.error(
        "[map-icon] Missing bundled iconsets:",
        missing.join(", "),
        "— run node --use-system-ca scripts/vendor-cloudtak-icons.js"
      );
    }

    for (const dirName of REQUIRED_ICONSET_DIRS) {
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
    requiredIconsetCount: REQUIRED_ICONSET_DIRS.length,
    typeMappings: typesByPrefix.size,
    dataRoot: DATA_ROOT,
    defaultIcons: getDefaultIconIds(),
  };
}

function getTypeIndexSnapshot() {
  const out = [];
  for (const [key, entries] of typesByPrefix) {
    out.push({
      type2525b: key,
      entries: entries.map((e) => ({
        iconsetUid: e.iconsetUid,
        iconName: e.iconName,
        relPath: e.relPath,
      })),
    });
  }
  return out.sort((a, b) => a.type2525b.localeCompare(b.type2525b));
}

function listIconsets() {
  return [...iconsetsByUid.values()].map((set) => ({
    uid: set.uid,
    name: set.name,
    dirName: set.dirName,
    iconCount: set.icons.length,
    pngCount: set.fileByBase.size,
  }));
}

module.exports = {
  ensureIconsets,
  resolveIcon,
  resolveIconAsync,
  explainIconResolution,
  explainIconResolutionAsync,
  parseUserIcon: mapIconResolve.parseUserIcon,
  parseIconsetPath: mapIconResolve.parseIconsetPath,
  getIconFilePath,
  getDefaultIconIds,
  getStatus,
  getTypeIndexSnapshot,
  listIconsets,
  findBestTypeMatch: (cotType) =>
    mapIconResolve.findBestTypeMatch(cotType, typesByPrefix, iconsetsByUid),
  cotDomain: mapIconResolve.cotDomain,
  domainPriorityList: (cotType) =>
    mapIconResolve.domainPriorityList(cotType, iconsetsByUid),
  ICON_PATH_ALIASES,
  REQUIRED_ICONSET_DIRS,
  DEFAULT_ICONSET_UID,
  PUBLIC_SAFETY_AIR_UID,
  DATA_ROOT,
};
