/**
 * Orchestrates agency abbreviation (groupPrefix) renames for a single agency row.
 * Scoped by agency full name — not by shared abbreviation or username suffix.
 */

const api = require("./authentik");
const { getString } = require("./env");
const agenciesStore = require("./agencies.service");
const templatesStore = require("./templates.service");
const groupsService = require("./groups.service");
const accessSvc = require("./access.service");
const usersService = require("./users.service");

function getAgencyAdminGroupName(agency) {
  const abbr = agenciesStore.normalizeGroupPrefix(agency?.groupPrefix);
  const countyAbbrev = String(agency?.countyAbbrev || "").trim().toUpperCase();
  if (!abbr) return null;
  if (countyAbbrev) {
    return `authentik-${countyAbbrev}-${abbr}-AgencyAdmin`;
  }
  return `authentik-${abbr}-AgencyAdmin`;
}

function isAgencyAdminGroupName(name) {
  return /-agencyadmin$/i.test(String(name || "").trim());
}

async function getGroupByNameUnfiltered(groupName) {
  const name = String(groupName || "").trim();
  if (!name) return null;

  try {
    const res = await api.get(`/core/groups/?name=${encodeURIComponent(name)}`);
    const results = Array.isArray(res?.data?.results) ? res.data.results : [];
    const exact = results.find(
      (g) => String(g?.name || "").trim().toLowerCase() === name.toLowerCase()
    );
    if (exact) return exact;
  } catch (_) {
    // fall through
  }

  const res2 = await api.get(`/core/groups/?search=${encodeURIComponent(name)}`);
  const results2 = Array.isArray(res2?.data?.results) ? res2.data.results : [];
  return (
    results2.find(
      (g) => String(g?.name || "").trim().toLowerCase() === name.toLowerCase()
    ) || null
  );
}

async function ensureAgencyAdminGroupExists(agency) {
  const name = getAgencyAdminGroupName(agency);
  if (!name) throw new Error("Agency abbreviation / short name is required");

  const attributes = {
    created_at: new Date().toISOString(),
    created_type: "Agency",
    created_type_detail: String(agency?.name || "").trim() || null,
    description: `Agency admin group for ${String(agency?.name || "").trim()}`,
  };

  try {
    await groupsService.createGroup(name, { attributes });
    return { created: true, name };
  } catch (err) {
    const msg = String(err?.response?.data?.detail || err?.response?.data || err?.message || "");
    const lower = msg.toLowerCase();
    if (lower.includes("already") || lower.includes("exists") || lower.includes("unique")) {
      const existing = await getGroupByNameUnfiltered(name);
      if (existing && agenciesStore.isAgencyOwnedGroup(existing, agency)) {
        return { created: false, name };
      }
      throw new Error(
        `Authentik group "${name}" already exists and is not owned by this agency`
      );
    }
    throw err;
  }
}

function validateNewGroupPrefix(raw) {
  return agenciesStore.validateGroupPrefix(raw);
}

async function updateUsersAgencyAbbreviation(agencyName, newAbbrev) {
  const name = String(agencyName || "").trim();
  const abbr = agenciesStore.normalizeGroupPrefix(newAbbrev);
  if (!name || !abbr) return { matched: 0, updated: 0 };

  const directoryRepo = require("./directoryRepo.service");
  const authentikOutbox = require("./authentikOutbox.service");
  const rows = await directoryRepo.updateUsersAgencyAbbreviationColumn(name, abbr);
  for (const row of rows) {
    if (!row.authentik_pk) continue;
    await authentikOutbox.enqueue({
      kind: "patch_user",
      entityType: "user",
      entityId: row.id,
      authentikPk: row.authentik_pk,
      username: row.username,
      payload: { authentikPk: row.authentik_pk, patch: { attributes: row.attributes } },
    });
  }
  if (rows.length) usersService.invalidateUsersCache();
  return { matched: rows.length, updated: rows.length };
}

async function renameAgencyAdminGroup(agencyOld, agencyNew) {
  const desiredName = getAgencyAdminGroupName(agencyNew);
  if (!desiredName) {
    throw new Error("Could not compute agency admin group name");
  }

  const candidateNames = accessSvc.getAllAgencyAdminGroupNames(agencyOld);
  let renamed = false;

  for (const oldName of candidateNames) {
    const g = await getGroupByNameUnfiltered(oldName);
    if (!g || g.pk == null) continue;

    const detail = String(agencyNew?.name || "").trim();
    await groupsService.patchGroupNameAndCn(g.pk, desiredName, {
      skipActionLock: true,
      bulk: true,
      attributes: {
        created_type: "Agency",
        created_type_detail: detail || null,
        description: `Agency admin group for ${detail}`,
      },
    });
    renamed = true;
    break;
  }

  if (!renamed) {
    await ensureAgencyAdminGroupExists(agencyNew);
  }

  return { adminGroupRenamed: renamed, adminGroupName: desiredName };
}

async function renameAgencyTakGroups(agencyName, oldPrefix, newPrefix) {
  const targetName = String(agencyName || "").trim();
  const r = await require("./directoryRepo.service").searchGroupsPaged({
    createdTypeDetail: targetName,
    includeHidden: true,
    page: 1,
    pageSize: 500,
  });
  const allGroups = r.groups;

  const candidates = (Array.isArray(allGroups) ? allGroups : []).filter((g) => {
    const gn = String(g?.name || "").trim();
    if (isAgencyAdminGroupName(gn)) return false;

    const attrs = g?.attributes && typeof g.attributes === "object" ? g.attributes : {};
    const detail = String(attrs.created_type_detail || "").trim();
    // Portal agency groups use full agency name on created_type_detail.
    // Legacy rows with only the abbreviation are out of scope for this migration.
    if (detail !== targetName) return false;
    return true;
  });

  let groupsRenamed = 0;
  const groupNameMap = new Map();

  for (const g of candidates) {
    const oldGroupName = String(g?.name || "").trim();
    const newGroupName = groupsService.rewriteTakGroupNamePrefix(
      oldGroupName,
      oldPrefix,
      newPrefix
    );
    if (!newGroupName || newGroupName === oldGroupName) continue;

    const gid = String(g?.pk ?? g?.id ?? "").trim();
    if (!gid) continue;

    const attrs =
      g?.attributes && typeof g.attributes === "object" ? g.attributes : {};
    await groupsService.patchGroupNameAndCn(gid, newGroupName, {
      skipActionLock: true,
      bulk: true,
      attributes: {
        created_type: attrs.created_type,
        created_type_detail: targetName,
        description: attrs.description,
        private: attrs.private,
      },
    });
    groupNameMap.set(oldGroupName, newGroupName);
    groupNameMap.set(oldGroupName.toLowerCase(), newGroupName);
    groupsRenamed += 1;
  }

  return { groupsRenamed, groupNameMap };
}

function mapTemplateGroupName(groupName, oldPrefix, newPrefix, groupNameMap) {
  const raw = String(groupName || "").trim();
  if (!raw) return raw;
  const fromMap =
    groupNameMap.get(raw) || groupNameMap.get(raw.toLowerCase());
  if (fromMap) return fromMap;
  return groupsService.rewriteTakGroupNamePrefix(raw, oldPrefix, newPrefix);
}

function updateAgencyTemplatesGroupNames(agencySuffix, oldPrefix, newPrefix, groupNameMap) {
  const sfx = String(agencySuffix || "").trim().toLowerCase();
  const templates = templatesStore.load();
  let templatesUpdated = 0;

  const next = templates.map((t) => {
    if (String(t.agencySuffix || "").trim().toLowerCase() !== sfx) return t;

    const groupsArr = Array.isArray(t.groups) ? t.groups : [];
    let rowChanged = false;
    const nextGroups = groupsArr.map((g) => {
      const rewritten = mapTemplateGroupName(g, oldPrefix, newPrefix, groupNameMap);
      if (rewritten !== g) rowChanged = true;
      return rewritten;
    });

    if (rowChanged) templatesUpdated += 1;
    return rowChanged ? { ...t, groups: nextGroups } : t;
  });

  if (templatesUpdated > 0) {
    templatesStore.save(next);
  }

  return { templatesUpdated };
}

/**
 * @param {number} agencyIndex - index in agencies.json
 * @param {string} newGroupPrefix - new abbreviation / short name (exact casing preserved)
 */
async function renameAgencyGroupPrefix(agencyIndex, newGroupPrefix) {
  const idx = Number(agencyIndex);
  const agencies = agenciesStore.load();
  if (!Number.isInteger(idx) || !agencies[idx]) {
    throw new Error("Agency not found");
  }

  const err = validateNewGroupPrefix(newGroupPrefix);
  if (err) throw new Error(err);

  const newPrefix = agenciesStore.normalizeGroupPrefix(newGroupPrefix);
  const dup = agenciesStore.assertUniqueGroupPrefix(agencies, newPrefix, idx);
  if (dup) throw new Error(dup);

  const agency = agencies[idx];
  const oldPrefix = agenciesStore.normalizeGroupPrefix(agency.groupPrefix);

  if (oldPrefix === newPrefix) {
    return {
      success: true,
      skipped: true,
      oldPrefix,
      newPrefix,
      usersUpdated: 0,
      usersMatched: 0,
      adminGroupRenamed: false,
      groupsRenamed: 0,
      templatesUpdated: 0,
    };
  }

  const agencyName = String(agency.name || "").trim();
  const agencyOld = { ...agency, groupPrefix: oldPrefix };
  const agencyNew = { ...agency, groupPrefix: newPrefix };

  // Authentik groups first, then templates (names must exist in Authentik before template JSON references them).
  const adminStats = await renameAgencyAdminGroup(agencyOld, agencyNew);
  const groupStats = await renameAgencyTakGroups(agencyName, oldPrefix, newPrefix);

  groupsService.invalidateGroupsCache();

  const templateStats = updateAgencyTemplatesGroupNames(
    agency.suffix,
    oldPrefix,
    newPrefix,
    groupStats.groupNameMap
  );

  const templateReconcile = await usersService.reconcileCurrentTemplateForAgencySuffix(
    agency.suffix
  );

  const userStats = await updateUsersAgencyAbbreviation(agencyName, newPrefix);

  agencies[idx] = { ...agency, groupPrefix: newPrefix };
  agenciesStore.save(agencies);

  usersService.invalidateUsersCache();
  groupsService.invalidateGroupsCache();

  return {
    success: true,
    skipped: false,
    agencyName,
    oldPrefix,
    newPrefix,
    usersMatched: userStats.matched,
    usersUpdated: userStats.updated,
    adminGroupRenamed: adminStats.adminGroupRenamed,
    adminGroupName: adminStats.adminGroupName,
    groupsRenamed: groupStats.groupsRenamed,
    templatesUpdated: templateStats.templatesUpdated,
    currentTemplatesReconciled: templateReconcile.updated,
  };
}

module.exports = {
  validateNewGroupPrefix,
  renameAgencyGroupPrefix,
};
