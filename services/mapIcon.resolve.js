/**
 * CloudTAK-aligned icon resolution (type2525b index, domain priority, usericon paths).
 * Used by mapIcon.service.js with bundled offline iconsets.
 */
const fs = require("fs");
const path = require("path");

const DEFAULT_ICONSET_UID = "34ae1613-9645-4222-a9d2-e5f243dea2865";
const GENERIC_ICONS_UID = "ad78aafb-83a6-4c07-b2b9-a897a8b6a38f";
const PUBLIC_SAFETY_AIR_UID = "66f14976-4b62-4023-8edb-d8d2ebeaa336";
const RESPONDER_ICONS_UID = "de450cbf-2ffc-47fb-bd2b-ba2db89b035e";
const FEMA_ICONS_UID = "f8f7f666-8b28-4b57-9fbb-e48e61d33b79";
const INCIDENT_MGMT_UID = "db450cbe-2fec-47fb-bd2b-ba2db89b035e";
const FALCONVIEW_UID = "6d180afb-89a6-4c07-b2b3-a89748b6a38f";
const GEOOPS_UID = "83198b4872a8c34eb9c549da8a4de5a28f07821185b39a2277948f66c24ac17a";
const GOOGLE_UID = "f7f71666-8b28-4b57-9fbb-e48e61d33b79";
const OSM_UID = "6d781afb-89a6-4c07-b2b9-a89748b6a38f";

const DOMAIN_ICONSET_PRIORITY = {
  air: [
    PUBLIC_SAFETY_AIR_UID,
    GENERIC_ICONS_UID,
    DEFAULT_ICONSET_UID,
    RESPONDER_ICONS_UID,
    FEMA_ICONS_UID,
    INCIDENT_MGMT_UID,
    FALCONVIEW_UID,
    GEOOPS_UID,
    GOOGLE_UID,
    OSM_UID,
  ],
  ground: [
    RESPONDER_ICONS_UID,
    GENERIC_ICONS_UID,
    DEFAULT_ICONSET_UID,
    FEMA_ICONS_UID,
    INCIDENT_MGMT_UID,
    OSM_UID,
    GOOGLE_UID,
    FALCONVIEW_UID,
    GEOOPS_UID,
    PUBLIC_SAFETY_AIR_UID,
  ],
  other: [
    GENERIC_ICONS_UID,
    RESPONDER_ICONS_UID,
    DEFAULT_ICONSET_UID,
    FEMA_ICONS_UID,
    INCIDENT_MGMT_UID,
    OSM_UID,
    GOOGLE_UID,
    FALCONVIEW_UID,
    GEOOPS_UID,
    PUBLIC_SAFETY_AIR_UID,
  ],
};

const ICON_PATH_ALIASES = new Map([
  [
    `${GENERIC_ICONS_UID}|Shapes/walkingpersonnel.png`,
    { iconsetUid: DEFAULT_ICONSET_UID, relPath: "People/walk.png" },
  ],
  ["walkingpersonnel.png", { iconsetUid: DEFAULT_ICONSET_UID, relPath: "People/walk.png" }],
]);

const BARE_CIVILIAN_AIR_PREFERRED_ICONS = {
  "a-f-a-c-f": ["fed_fixed_wing.png"],
  "a-f-a-c-h": ["fed_rotor.png"],
  "a-f-a-c-l": [
    "civ_lta_tethered.png",
    "civ_lta_airship.png",
    "civ_lta_balloon.png",
  ],
};

function cotTypeSegments(cotType) {
  return String(cotType || "")
    .trim()
    .toLowerCase()
    .split("-")
    .filter(Boolean);
}

function iconBaseName(iconName) {
  return String(iconName || "")
    .trim()
    .replace(/\.png$/i, "")
    .toLowerCase();
}

function cotDomain(cotType) {
  const segments = cotTypeSegments(cotType);
  if (segments.length >= 3 && segments[2] === "a") return "air";
  if (segments.length >= 3 && segments[2] === "g") return "ground";
  return "other";
}

function domainPriorityList(cotType, iconsetsByUid) {
  const domain = cotDomain(cotType);
  const list = DOMAIN_ICONSET_PRIORITY[domain] || DOMAIN_ICONSET_PRIORITY.other;
  const seen = new Set();
  const out = [];
  for (const uid of list) {
    if (seen.has(uid)) continue;
    seen.add(uid);
    out.push(uid);
  }
  for (const iconset of iconsetsByUid.values()) {
    if (!seen.has(iconset.uid)) out.push(iconset.uid);
  }
  return out;
}

function isBareCivilianAirType(cotType) {
  const segments = cotTypeSegments(cotType);
  return segments.length === 5 && segments[2] === "a" && segments[3] === "c";
}

function isSpecialtyAirIconName(iconName) {
  return /^(CIV_FIXED_(CAP|ISR)|CIV_ROTOR_ISR|FIRE_|EMS_|LE_|MIL_)/i.test(
    String(iconName || "")
  );
}

function iconsetPriorityRank(iconsetUid, cotType, iconsetsByUid) {
  const list = domainPriorityList(cotType, iconsetsByUid);
  const idx = list.indexOf(String(iconsetUid || ""));
  return idx >= 0 ? idx : list.length + 1;
}

function pickBestWithinIconset(entries, cotType) {
  const t = String(cotType || "").trim().toLowerCase();
  const segments = cotTypeSegments(t);
  const dimension = segments[3] || "";
  const role = segments[4] || "";

  let best = null;
  for (const entry of entries || []) {
    const base = iconBaseName(entry.iconName);
    const nameLower = String(entry.iconName || "").toLowerCase();
    let score = 0;

    if (base === t) score += 5000;
    else if (base.replace(/_/g, "-") === t) score += 4500;

    if (isBareCivilianAirType(t)) {
      const preferred = BARE_CIVILIAN_AIR_PREFERRED_ICONS[t];
      if (preferred) {
        const prefIdx = preferred.indexOf(nameLower);
        if (prefIdx >= 0) score += 4000 - prefIdx * 10;
      }
      if (isSpecialtyAirIconName(entry.iconName)) score -= 1500;
    } else if (dimension === "c") {
      if (/^civ_/i.test(entry.iconName) && !isSpecialtyAirIconName(entry.iconName)) {
        score += 800;
      }
      if (isSpecialtyAirIconName(entry.iconName)) score -= 1200;
      if (/^(fire_|ems_|le_|mil_)/i.test(entry.iconName)) score -= 600;
    } else if (dimension === "m") {
      if (/^fed_/i.test(entry.iconName)) score += 400;
      if (/^mil_/i.test(entry.iconName)) score += 300;
      if (/^a-f-a-m/i.test(base)) score += 500;
      if (/^(fire_|ems_|civ_)/i.test(entry.iconName)) score -= 300;
    }

    if (role === "f" && /fixed/i.test(entry.iconName)) score += 150;
    if (role === "h" && /rotor|helo/i.test(entry.iconName)) score += 150;
    if (role === "l" && /lta|balloon|airship/i.test(entry.iconName)) score += 150;
    if (role === "q" && /uas|uav/i.test(entry.iconName)) score += 150;

    if (!dimension && /^a-[a-z]-a-/i.test(base)) score += 200;

    if (
      !best ||
      score > best.score ||
      (score === best.score && nameLower < best.nameLower)
    ) {
      best = { score, entry, nameLower };
    }
  }
  return best?.entry || entries?.[0] || null;
}

function pickBestFromEntries(entries, cotType, iconsetsByUid) {
  if (!entries || !entries.length) return null;
  const priority = domainPriorityList(cotType, iconsetsByUid);
  const byIconset = new Map();
  for (const entry of entries) {
    const list = byIconset.get(entry.iconsetUid) || [];
    list.push(entry);
    byIconset.set(entry.iconsetUid, list);
  }
  for (const uid of priority) {
    const list = byIconset.get(uid);
    if (!list || !list.length) continue;
    const picked = pickBestWithinIconset(list, cotType);
    if (picked) return picked;
  }
  return pickBestWithinIconset(entries, cotType);
}

function makeIconId(iconsetUid, relPath) {
  return `${iconsetUid}:${relPath.replace(/\\/g, "/")}`;
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

function findBestTypeMatch(cotType, typesByPrefix, iconsetsByUid) {
  const t = String(cotType || "").trim().toLowerCase();
  if (!t) return null;

  const exactList = typesByPrefix.get(t);
  if (exactList && exactList.length) {
    return pickBestFromEntries(exactList, t, iconsetsByUid);
  }

  let bestPrefix = null;
  let bestEntry = null;
  for (const [prefix, entries] of typesByPrefix) {
    if (!t.startsWith(prefix)) continue;
    if (bestPrefix && prefix.length < bestPrefix.length) continue;
    const entry = pickBestFromEntries(entries, t, iconsetsByUid);
    if (!entry) continue;
    if (!bestPrefix || prefix.length > bestPrefix.length) {
      bestPrefix = prefix;
      bestEntry = entry;
    } else if (prefix.length === bestPrefix.length) {
      const curRank = iconsetPriorityRank(entry.iconsetUid, t, iconsetsByUid);
      const bestRank = iconsetPriorityRank(bestEntry.iconsetUid, t, iconsetsByUid);
      if (curRank < bestRank) bestEntry = entry;
    }
  }
  return bestEntry;
}

function resolveFromIconset(
  iconset,
  { cotType, iconName, groupHint, affiliation },
  typesByPrefix,
  iconsetsByUid
) {
  if (iconName) {
    const rel = resolveRelativePath(iconset, iconName, groupHint);
    const hit = buildIconResult(iconset, rel, "usericon");
    if (hit) return hit;
  }

  const typeHit = findBestTypeMatch(cotType, typesByPrefix, iconsetsByUid);
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

function resolveAliasedIcon(alias, iconsetsByUid) {
  if (!alias) return null;
  const iconset = iconsetsByUid.get(alias.iconsetUid);
  if (!iconset) return null;
  const rel = String(alias.relPath || "").replace(/\\/g, "/");
  return buildIconResult(iconset, rel, "alias");
}

function isIconsetUidToken(uid) {
  const s = String(uid || "").trim();
  return /^[0-9a-f]{36}$/i.test(s) || /^[0-9a-f]{64}$/i.test(s);
}

function parseIconsetPath(iconsetpath) {
  const raw = String(iconsetpath || "").trim();
  if (!raw) return null;

  if (/^COT_MAPPING_2525B\//i.test(raw)) {
    const parts = raw.split("/").filter(Boolean);
    const cotType = parts.length > 1 ? parts.slice(1).join("-") : "";
    return { mode: "type", cotType };
  }

  if (/^COT_MAPPING_2525C\//i.test(raw)) {
    const parts = raw.split("/").filter(Boolean);
    const iconName = parts.length > 1 ? parts[parts.length - 1] : "";
    const group = parts.length > 2 ? parts.slice(1, -1).join("/") : "";
    return { mode: "usericon", iconName, group };
  }

  if (/^COT_MAPPING_SPOTMAP\//i.test(raw)) {
    const parts = raw.split("/").filter(Boolean);
    const cotType = parts.length > 1 ? parts.slice(1).join("-") : "";
    return { mode: "type", cotType };
  }

  if (/^a-[a-z]-/i.test(raw) && raw.indexOf("/") === -1) {
    return { mode: "type", cotType: raw };
  }

  const slash = raw.indexOf("/");
  if (slash <= 0) return null;
  const uid = raw.slice(0, slash);
  const rel = raw.slice(slash + 1);
  if (!isIconsetUidToken(uid)) return null;
  return { mode: "path", iconsetUid: uid, relPath: rel };
}

function prefersMilSym2525C(iconsetpath) {
  return prefersMilSymIconPath(iconsetpath);
}

function prefersMilSymIconPath(iconsetpath) {
  const raw = String(iconsetpath || "").trim();
  if (/^COT_MAPPING_2525C\//i.test(raw)) return true;
  if (/^a-[a-z]-/i.test(raw) && raw.indexOf("/") === -1) return true;
  return false;
}

function parseUserIcon(detail) {
  const attrs = detail?.usericon?._attributes || detail?.usericon || {};
  const iconsetpath = attrs.iconsetpath || attrs.iconsetPath || "";
  let name = attrs.name || "";
  let group = attrs.group || attrs.groupName || "";
  if (iconsetpath) {
    const parsed = parseIconsetPath(iconsetpath);
    if (!name) {
      if (parsed?.mode === "path") {
        name = path.basename(parsed.relPath);
      } else if (parsed?.mode === "usericon" && parsed.iconName) {
        name = parsed.iconName;
      }
    }
    if (!group && parsed?.mode === "usericon" && parsed.group) {
      group = parsed.group;
    }
  }
  return {
    iconsetpath,
    group,
    name,
  };
}

/**
 * Resolve bundled PNG icon (no 2525D fallback — caller adds milsym when needed).
 */
function resolvePngIcon(
  { type, affiliation, detail, usericon },
  { iconsetsByUid, typesByPrefix }
) {
  let ui = usericon || parseUserIcon(detail);
  let cotType = String(type || "").trim();
  let directPath = null;

  const parsedPath = parseIconsetPath(ui.iconsetpath);
  if (parsedPath?.mode === "type") {
    cotType = parsedPath.cotType || cotType;
  } else if (parsedPath?.mode === "path") {
    directPath = parsedPath;
  } else if (parsedPath?.mode === "usericon") {
    ui = {
      ...ui,
      name: parsedPath.iconName || ui.name,
      group: parsedPath.group || ui.group,
    };
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
        resolveIconPathAlias(directPath.iconsetUid, rel),
        iconsetsByUid
      );
      if (aliasHit) return aliasHit;
    } else {
      const aliasHit = resolveAliasedIcon(
        resolveIconPathAlias(directPath.iconsetUid, directPath.relPath),
        iconsetsByUid
      );
      if (aliasHit) return aliasHit;
    }
  }

  if (parsedPath?.mode === "usericon" && (ui.name || ui.group)) {
    for (const iconset of iconsetsByUid.values()) {
      const hit = resolveFromIconset(
        iconset,
        {
          cotType,
          iconName: ui.name,
          groupHint: ui.group,
          affiliation,
        },
        typesByPrefix,
        iconsetsByUid
      );
      if (hit && String(hit.source || "").toLowerCase() === "usericon") return hit;
    }
  }

  if (prefersMilSymIconPath(ui.iconsetpath)) {
    return null;
  }

  const globalTypeHit = findBestTypeMatch(cotType, typesByPrefix, iconsetsByUid);
  if (globalTypeHit) {
    const iconset = iconsetsByUid.get(globalTypeHit.iconsetUid);
    if (iconset) {
      const hit = buildIconResult(iconset, globalTypeHit.relPath, "type2525b");
      if (hit) return hit;
    }
  }

  const defaultIconset = iconsetsByUid.get(DEFAULT_ICONSET_UID);
  if (defaultIconset) {
    const hit = resolveFromIconset(
      defaultIconset,
      {
        cotType,
        iconName: ui.name,
        groupHint: ui.group,
        affiliation,
      },
      typesByPrefix,
      iconsetsByUid
    );
    if (hit) return hit;
  }

  for (const iconset of iconsetsByUid.values()) {
    if (iconset.uid === DEFAULT_ICONSET_UID) continue;
    const hit = resolveFromIconset(
      iconset,
      {
        cotType,
        iconName: ui.name,
        groupHint: ui.group,
        affiliation,
      },
      typesByPrefix,
      iconsetsByUid
    );
    if (hit) return hit;
  }

  return null;
}

module.exports = {
  DEFAULT_ICONSET_UID,
  PUBLIC_SAFETY_AIR_UID,
  GENERIC_ICONS_UID,
  ICON_PATH_ALIASES,
  DOMAIN_ICONSET_PRIORITY,
  cotDomain,
  domainPriorityList,
  findBestTypeMatch,
  pickBestFromEntries,
  pickBestWithinIconset,
  parseUserIcon,
  parseIconsetPath,
  isIconsetUidToken,
  prefersMilSym2525C,
  prefersMilSymIconPath,
  resolvePngIcon,
  resolveRelativePath,
  defaultIconNameForAffiliation,
  buildIconResult,
  makeIconId,
  inferType2525bFromIconName: function inferType2525bFromIconName(iconName) {
    const base = String(iconName || "")
      .trim()
      .replace(/\.png$/i, "");
    if (/^a-[a-z]-/i.test(base)) return base.toLowerCase();
    return "";
  },
};
