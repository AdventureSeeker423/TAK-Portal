/**
 * Orchestrates agency full name renames for a single agency row.
 * Scoped by agency suffix + index; discovers users/groups by old name from agencies.json.
 */

const api = require("./authentik");
const { getString } = require("./env");
const agenciesStore = require("./agencies.service");
const userRequestsStore = require("./userRequests.store");
const groupsService = require("./groups.service");
const accessSvc = require("./access.service");
const usersService = require("./users.service");

const MAX_AGENCY_NAME_LENGTH = 200;

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

function getTakGroupPrefix(groupName) {
  const n = String(groupName || "").trim();
  const withoutTak = n.toLowerCase().startsWith("tak_") ? n.slice(4) : n;
  let base = withoutTak;
  if (base.endsWith("_READ")) base = base.slice(0, -5);
  else if (base.endsWith("_WRITE")) base = base.slice(0, -6);
  const dashIdx = base.indexOf(" - ");
  if (dashIdx > 0) return base.slice(0, dashIdx).trim().toUpperCase();
  const spaceIdx = base.indexOf(" ");
  if (spaceIdx > 0) return base.slice(0, spaceIdx).trim().toUpperCase();
  return base.trim().toUpperCase();
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
  if (!name) throw new Error("Agency abbreviation (groupPrefix) is required");

  const fullName = String(agency?.name || "").trim();
  const attributes = {
    created_at: new Date().toISOString(),
    created_type: "Agency",
    created_type_detail: fullName || null,
    description: `Agency admin group for ${fullName}`,
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

function validateNewAgencyName(raw, agencies, excludeIndex) {
  const name = String(raw || "").trim();
  if (!name) return "Agency name is required";
  if (name.length > MAX_AGENCY_NAME_LENGTH) {
    return `Agency name must be at most ${MAX_AGENCY_NAME_LENGTH} characters`;
  }
  if (agencies) {
    return agenciesStore.assertUniqueAgencyName(agencies, name, excludeIndex);
  }
  return null;
}

async function updateUsersAgencyName(oldName, newName, agencySuffix) {
  const oldN = String(oldName || "").trim();
  const newN = String(newName || "").trim();
  const sfx = String(agencySuffix || "").trim().toLowerCase();
  if (!oldN || !newN || !sfx) return { matched: 0, updated: 0 };

  const directoryRepo = require("./directoryRepo.service");
  const authentikOutbox = require("./authentikOutbox.service");
  const rows = await directoryRepo.updateUsersAgencyNameColumn(oldN, newN, sfx);
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

async function updateAgencyAdminGroupMetadata(agency) {
  const fullName = String(agency?.name || "").trim();
  const candidateNames = accessSvc.getAllAgencyAdminGroupNames(agency);
  let adminGroupUpdated = false;
  let adminGroupName = getAgencyAdminGroupName(agency);

  for (const groupName of candidateNames) {
    const g = await getGroupByNameUnfiltered(groupName);
    if (!g || g.pk == null) continue;

    adminGroupName = String(g.name || groupName).trim();
    await groupsService.patchGroupNameAndCn(g.pk, adminGroupName, {
      skipActionLock: true,
      bulk: true,
      attributes: {
        created_type: "Agency",
        created_type_detail: fullName || null,
        description: `Agency admin group for ${fullName}`,
      },
    });
    adminGroupUpdated = true;
    break;
  }

  if (!adminGroupUpdated) {
    await ensureAgencyAdminGroupExists(agency);
    adminGroupName = getAgencyAdminGroupName(agency);
  }

  return { adminGroupUpdated, adminGroupName };
}

async function updateAgencyTakGroupsCreatedTypeDetail(oldName, newName, groupPrefix) {
  const oldN = String(oldName || "").trim();
  const newN = String(newName || "").trim();
  const gp = agenciesStore.normalizeGroupPrefix(groupPrefix);
  if (!oldN || !newN) return { groupsUpdated: 0 };

  const r = await require("./directoryRepo.service").searchGroupsPaged({
    createdTypeDetail: oldN,
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
    if (detail !== oldN) return false;

    if (gp) {
      const prefix = getTakGroupPrefix(gn);
      if (prefix && prefix.toUpperCase() !== gp.toUpperCase()) return false;
    }
    return true;
  });

  let groupsUpdated = 0;

  for (const g of candidates) {
    const groupName = String(g?.name || "").trim();
    const gid = String(g?.pk ?? g?.id ?? "").trim();
    if (!gid || !groupName) continue;

    const attrs = g?.attributes && typeof g.attributes === "object" ? g.attributes : {};
    if (String(attrs.created_type_detail || "").trim() === newN) continue;

    await groupsService.patchGroupNameAndCn(gid, groupName, {
      skipActionLock: true,
      bulk: true,
      attributes: {
        created_type: attrs.created_type,
        created_type_detail: newN,
        description: attrs.description,
        private: attrs.private,
      },
    });
    groupsUpdated += 1;
  }

  return { groupsUpdated };
}

function updateUserRequestsAgencyName(agencySuffix, newName) {
  const sfx = String(agencySuffix || "").trim().toLowerCase();
  const name = String(newName || "").trim();
  if (!sfx || !name) return { requestsUpdated: 0 };

  const requests = userRequestsStore.load();
  let requestsUpdated = 0;

  const next = requests.map((r) => {
    if (String(r?.agencySuffix || "").trim().toLowerCase() !== sfx) return r;
    if (String(r?.agencyName || "").trim() === name) return r;
    requestsUpdated += 1;
    return { ...r, agencyName: name };
  });

  if (requestsUpdated > 0) {
    userRequestsStore.save(next);
  }

  return { requestsUpdated };
}

/**
 * @param {number} agencyIndex - index in agencies.json
 * @param {string} newName - new full agency name
 */
async function renameAgencyName(agencyIndex, newName) {
  const idx = Number(agencyIndex);
  const agencies = agenciesStore.load();
  if (!Number.isInteger(idx) || !agencies[idx]) {
    throw new Error("Agency not found");
  }

  const err = validateNewAgencyName(newName, agencies, idx);
  if (err) throw new Error(err);

  const agency = agencies[idx];
  const oldName = String(agency.name || "").trim();
  const newN = String(newName || "").trim();
  const suffix = String(agency.suffix || "").trim().toLowerCase();

  if (oldName === newN) {
    return {
      success: true,
      skipped: true,
      oldName,
      newName: newN,
      suffix,
      usersUpdated: 0,
      usersMatched: 0,
      adminGroupUpdated: false,
      groupsUpdated: 0,
      requestsUpdated: 0,
    };
  }

  const agencyForAdmin = { ...agency, name: newN };

  const userStats = await updateUsersAgencyName(oldName, newN, suffix);
  const adminStats = await updateAgencyAdminGroupMetadata(agencyForAdmin);
  const groupStats = await updateAgencyTakGroupsCreatedTypeDetail(
    oldName,
    newN,
    agency.groupPrefix
  );

  agencies[idx] = { ...agency, name: newN };
  agenciesStore.save(agencies);

  const requestStats = updateUserRequestsAgencyName(suffix, newN);

  usersService.invalidateUsersCache();
  groupsService.invalidateGroupsCache();

  return {
    success: true,
    skipped: false,
    oldName,
    newName: newN,
    suffix,
    usersMatched: userStats.matched,
    usersUpdated: userStats.updated,
    adminGroupUpdated: adminStats.adminGroupUpdated,
    adminGroupName: adminStats.adminGroupName,
    groupsUpdated: groupStats.groupsUpdated,
    requestsUpdated: requestStats.requestsUpdated,
  };
}

module.exports = {
  validateNewAgencyName,
  renameAgencyName,
};
