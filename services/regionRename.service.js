/**
 * Rename Authentik Region groups when a region is renamed in the registry.
 */

const groupsService = require("./groups.service");
const regionsSvc = require("./regions.service");

function stripTakPrefix(name) {
  const n = String(name || "").trim();
  return n.toLowerCase().startsWith("tak_") ? n.slice(4) : n;
}

function withTakPrefix(name, hadTak) {
  const n = String(name || "").trim();
  if (!n) return "";
  if (!hadTak) return n;
  return n.toLowerCase().startsWith("tak_") ? n : `tak_${n}`;
}

function computeRenamedRegionGroupName(groupName, oldRegion, newRegion) {
  const raw = String(groupName || "").trim();
  if (!raw) return null;

  const hadTak = raw.toLowerCase().startsWith("tak_");
  const withoutTak = stripTakPrefix(raw);

  let behaviorSuffix = "";
  let base = withoutTak;
  if (base.endsWith("_READ")) {
    behaviorSuffix = "_READ";
    base = base.slice(0, -5);
  } else if (base.endsWith("_WRITE")) {
    behaviorSuffix = "_WRITE";
    base = base.slice(0, -6);
  }

  const oldR = regionsSvc.normalizeName(oldRegion);
  const newR = regionsSvc.normalizeName(newRegion);
  if (!oldR || !newR) return null;

  const prefix = `${oldR} `;
  if (base.toLowerCase().startsWith(prefix.toLowerCase())) {
    const rest = base.slice(prefix.length);
    return withTakPrefix(`${newR} ${rest}${behaviorSuffix}`, hadTak);
  }

  return null;
}

function isAgencyAdminGroupName(name) {
  return /-agencyadmin$/i.test(String(name || "").trim());
}

async function renameRegionTakGroups(oldRegion, newRegion) {
  const oldR = regionsSvc.normalizeName(oldRegion);
  const newR = regionsSvc.normalizeName(newRegion);
  if (!oldR || !newR || oldR.toLowerCase() === newR.toLowerCase()) {
    return { groupsRenamed: 0 };
  }

  const allGroups = await groupsService.getAllGroups({ includeHidden: true });
  let groupsRenamed = 0;

  for (const g of Array.isArray(allGroups) ? allGroups : []) {
    const gn = String(g?.name || "").trim();
    const gid = String(g?.pk ?? g?.id ?? "").trim();
    if (!gn || !gid) continue;
    if (isAgencyAdminGroupName(gn)) continue;

    const attrs = g?.attributes && typeof g.attributes === "object" ? g.attributes : {};
    const createdType = String(attrs.created_type || "").trim().toLowerCase();
    const detail = String(attrs.created_type_detail || "").trim();
    const nextName = computeRenamedRegionGroupName(gn, oldR, newR);
    const isRegionByAttr =
      createdType === "region" && detail.toLowerCase() === oldR.toLowerCase();
    const isRegionByName = !!nextName;

    if (!isRegionByAttr && !isRegionByName) continue;

    const finalName = nextName || gn;
    const nextAttrs = { ...attrs };
    if (isRegionByAttr) {
      nextAttrs.created_type = attrs.created_type || "Region";
      nextAttrs.created_type_detail = newR;
    }

    const nameChanged = finalName !== gn;
    const detailChanged =
      isRegionByAttr &&
      String(nextAttrs.created_type_detail || "").trim().toLowerCase() !==
        detail.toLowerCase();
    if (!nameChanged && !detailChanged) continue;

    await groupsService.patchGroupNameAndCn(gid, finalName, {
      skipActionLock: true,
      attributes: {
        created_type: nextAttrs.created_type,
        created_type_detail: nextAttrs.created_type_detail,
        description: nextAttrs.description,
        private: nextAttrs.private,
      },
    });
    groupsRenamed += 1;
  }

  return { groupsRenamed };
}

/**
 * Rename region in store + Authentik Region groups.
 */
async function renameRegion(id, newNameRaw) {
  const { region, oldName, newName } = regionsSvc.renameInStore(id, newNameRaw);
  let groupsRenamed = 0;
  if (oldName.toLowerCase() !== newName.toLowerCase()) {
    const result = await renameRegionTakGroups(oldName, newName);
    groupsRenamed = result.groupsRenamed || 0;
  }
  return { region, oldName, newName, groupsRenamed };
}

module.exports = {
  computeRenamedRegionGroupName,
  renameRegionTakGroups,
  renameRegion,
};
