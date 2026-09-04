/**
 * Rename / delete Authentik Region groups when a region changes in the registry.
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

function isRegionGroupMatch(group, regionName) {
  const region = regionsSvc.normalizeName(regionName);
  if (!region) return false;

  const gn = String(group?.name || "").trim();
  if (!gn || isAgencyAdminGroupName(gn)) return false;

  const attrs = group?.attributes && typeof group.attributes === "object" ? group.attributes : {};
  const createdType = String(attrs.created_type || "").trim().toLowerCase();
  const detail = String(attrs.created_type_detail || "").trim();
  if (createdType === "region" && detail.toLowerCase() === region.toLowerCase()) {
    return true;
  }

  // Name-based: tak_{Region} Title[_READ|_WRITE]
  return !!computeRenamedRegionGroupName(gn, region, region);
}

async function renameRegionTakGroups(oldRegion, newRegion) {
  const oldR = regionsSvc.normalizeName(oldRegion);
  const newR = regionsSvc.normalizeName(newRegion);
  if (!oldR || !newR || oldR.toLowerCase() === newR.toLowerCase()) {
    return { groupsRenamed: 0 };
  }

  const repo = require("./directoryRepo.service");
  const byDetail = await repo.searchGroupsPaged({
    createdTypeDetail: oldR,
    includeHidden: true,
    page: 1,
    pageSize: 500,
  });
  const byQ = await repo.searchGroupsPaged({
    q: oldR,
    includeHidden: true,
    page: 1,
    pageSize: 500,
  });
  const merged = new Map();
  for (const g of [...byDetail.groups, ...byQ.groups]) merged.set(String(g.pk), g);
  const allGroups = [...merged.values()];
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
      bulk: true,
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
 * Delete Authentik Region groups for a region name.
 */
async function deleteRegionTakGroups(regionName) {
  const region = regionsSvc.normalizeName(regionName);
  if (!region) return { groupsDeleted: 0, groupNames: [] };

  const repo = require("./directoryRepo.service");
  const byDetail = await repo.searchGroupsPaged({
    createdTypeDetail: region,
    includeHidden: true,
    page: 1,
    pageSize: 500,
  });
  const byQ = await repo.searchGroupsPaged({
    q: region,
    includeHidden: true,
    page: 1,
    pageSize: 500,
  });
  const merged = new Map();
  for (const g of [...byDetail.groups, ...byQ.groups]) merged.set(String(g.pk), g);
  const allGroups = [...merged.values()];
  const targets = (Array.isArray(allGroups) ? allGroups : []).filter((g) =>
    isRegionGroupMatch(g, region)
  );

  const groupNames = [];
  let groupsDeleted = 0;
  for (const g of targets) {
    const gid = String(g?.pk ?? g?.id ?? "").trim();
    const gn = String(g?.name || "").trim();
    if (!gid) continue;
    await groupsService.deleteGroupWithCleanup(gid, { ignoreLocks: true });
    groupsDeleted += 1;
    if (gn) groupNames.push(gn);
  }

  if (groupsDeleted > 0) {
    try {
      groupsService.invalidateGroupsCache();
    } catch (_) {}
  }

  return { groupsDeleted, groupNames };
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

/**
 * Delete region from store and Authentik Region groups.
 */
async function deleteRegion(id) {
  const result = regionsSvc.remove(id);
  const regionName = regionsSvc.normalizeName(result?.region?.name);
  let groupsDeleted = 0;
  let groupNames = [];
  if (regionName) {
    const deleted = await deleteRegionTakGroups(regionName);
    groupsDeleted = deleted.groupsDeleted || 0;
    groupNames = deleted.groupNames || [];
  }
  return { ...result, groupsDeleted, groupNames };
}

module.exports = {
  computeRenamedRegionGroupName,
  isRegionGroupMatch,
  renameRegionTakGroups,
  deleteRegionTakGroups,
  renameRegion,
  deleteRegion,
};
