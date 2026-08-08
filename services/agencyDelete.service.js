/**
 * Irreversible agency deletion: users, groups, templates, and related records.
 */

const agenciesStore = require("./agencies.service");
const accessSvc = require("./access.service");
const groupsService = require("./groups.service");
const templatesStore = require("./templates.service");
const usersService = require("./users.service");
const userRequestsService = require("./userRequests.service");
const dataSyncSvc = require("./dataSync.service");
const dataSyncAccess = require("./dataSyncAccess.service");
const { isTakConfigured } = require("./tak.service");
const { getBool } = require("./env");
const { normalizeCountyName } = require("./countyNameRename.service");
const { normalizeStateCode } = require("./stateCodeRename.service");

function stripTakPrefix(name) {
  const n = String(name || "").trim();
  return n.toLowerCase().startsWith("tak_") ? n.slice(4) : n;
}

function canonicalGroupKey(name) {
  return stripTakPrefix(name).toLowerCase().replace(/\s+/g, " ").trim();
}

function unwrapMissionList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

/**
 * Map canonical group key → scope for every group that will be deleted
 * (agency-specific, and county/state when this is the last agency in that geo).
 */
function collectDeletedGroupKeyScopes(plan) {
  const keyToScope = new Map();
  const buckets = [
    ["agency", plan?.agencyGroups],
    ["county", plan?.countyGroups],
    ["state", plan?.stateGroups],
  ];
  for (const [scope, groups] of buckets) {
    for (const group of Array.isArray(groups) ? groups : []) {
      const key = canonicalGroupKey(group?.name);
      if (key && !keyToScope.has(key)) keyToScope.set(key, scope);
    }
  }
  return keyToScope;
}

/**
 * Data Sync missions whose single assigned group is among groups being deleted
 * (agency, and county/state groups when those are included in the delete plan).
 */
async function findDataSyncMissionsForDeletedGroups(plan) {
  if (getBool("TAK_BYPASS_ENABLED", false) || !isTakConfigured()) {
    return [];
  }

  const keyToScope = collectDeletedGroupKeyScopes(plan);
  if (!keyToScope.size) return [];

  let raw;
  try {
    raw = await dataSyncSvc.listMissions();
  } catch (err) {
    console.warn(
      "[agencyDelete] Failed to list Data Sync missions:",
      err?.message || err
    );
    return [];
  }

  const matched = [];
  const seen = new Set();
  for (const mission of unwrapMissionList(raw)) {
    const groupName = dataSyncAccess.missionSingleGroupName(mission);
    if (!groupName) continue;
    const scope = keyToScope.get(canonicalGroupKey(groupName));
    if (!scope) continue;
    const missionName = String(mission?.name || mission?.missionName || "").trim();
    if (!missionName || seen.has(missionName.toLowerCase())) continue;
    seen.add(missionName.toLowerCase());
    matched.push({ name: missionName, groupName, scope });
  }
  return matched;
}

function summarizeDataSyncMissionsByScope(missions) {
  const summary = { agency: 0, county: 0, state: 0, total: 0 };
  for (const mission of Array.isArray(missions) ? missions : []) {
    if (mission?.scope === "agency") summary.agency += 1;
    else if (mission?.scope === "county") summary.county += 1;
    else if (mission?.scope === "state") summary.state += 1;
    summary.total += 1;
  }
  return summary;
}

/**
 * Delete matching Data Sync missions before their groups are removed.
 * Soft-fails so a TAK outage does not block agency delete.
 */
async function deleteDataSyncMissionsForPlan(plan) {
  const missions = await findDataSyncMissionsForDeletedGroups(plan);
  let deleted = 0;
  const failures = [];

  for (const mission of missions) {
    try {
      await dataSyncSvc.deleteMission(mission.name);
      deleted += 1;
    } catch (err) {
      if (err?.code === "TAK_BYPASS" || err?.code === "TAK_NOT_CONFIGURED") {
        break;
      }
      failures.push({
        missionName: mission.name,
        groupName: mission.groupName,
        error: err?.message || String(err),
      });
      console.warn(
        "[agencyDelete] Failed to delete Data Sync mission",
        mission.name,
        err?.message || err
      );
    }
  }

  return {
    attempted: missions.length,
    deleted,
    failures,
    missions,
  };
}

function matchesAgencyGroup(group, agencyName) {
  const name = String(agencyName || "").trim();
  if (!name) return false;

  const attrs =
    group && typeof group.attributes === "object" && group.attributes
      ? group.attributes
      : {};
  const createdType = String(attrs.created_type || "").trim().toLowerCase();
  const detail = String(attrs.created_type_detail || "").trim();
  return createdType === "agency" && detail.toLowerCase() === name.toLowerCase();
}

function matchesCountyGroup(group, countyName) {
  const county = normalizeCountyName(countyName);
  if (!county) return false;

  const attrs =
    group && typeof group.attributes === "object" && group.attributes
      ? group.attributes
      : {};
  const createdType = String(attrs.created_type || "").trim().toLowerCase();
  const detail = String(attrs.created_type_detail || "").trim();
  if (createdType === "county" && detail.toLowerCase() === county.toLowerCase()) {
    return true;
  }

  const gn = stripTakPrefix(group?.name);
  const cLower = county.toLowerCase();
  if (gn.toLowerCase().startsWith(`${cLower} co `)) return true;
  if (gn.startsWith(`${county} Co - `)) return true;
  return false;
}

function matchesStateGroup(group, stateCode) {
  const state = normalizeStateCode(stateCode);
  if (!state) return false;

  const attrs =
    group && typeof group.attributes === "object" && group.attributes
      ? group.attributes
      : {};
  const createdType = String(attrs.created_type || "").trim().toLowerCase();
  if (createdType === "county") return false;

  const detail = normalizeStateCode(attrs.created_type_detail);
  if (createdType === "state" && detail === state) return true;

  let base = stripTakPrefix(group?.name);
  if (base.endsWith("_READ")) base = base.slice(0, -5);
  else if (base.endsWith("_WRITE")) base = base.slice(0, -6);

  const upper = base.toUpperCase();
  if (upper.startsWith(`${state} - `)) {
    const rest = base.slice(`${state} - `.length);
    if (rest.toLowerCase().startsWith("co ") || rest.toLowerCase().startsWith("co -")) {
      return false;
    }
    return true;
  }

  if (upper.startsWith(`${state} `)) {
    const rest = base.slice(state.length + 1);
    if (rest.toLowerCase().startsWith("co ") || rest.toLowerCase().startsWith("co -")) {
      return false;
    }
    return true;
  }

  return false;
}

function remainingAgenciesAfterDelete(allAgencies, agencyIndex) {
  return (Array.isArray(allAgencies) ? allAgencies : []).filter(
    (_, i) => i !== agencyIndex
  );
}

function shouldDeleteCountyGroups(agency, remainingAgencies) {
  const state = normalizeStateCode(agency?.state);
  const countyKey = normalizeCountyName(agency?.county).toLowerCase();
  if (!state || !countyKey) return false;

  return !remainingAgencies.some((ag) => {
    return (
      normalizeStateCode(ag?.state) === state &&
      normalizeCountyName(ag?.county).toLowerCase() === countyKey
    );
  });
}

function shouldDeleteStateGroups(agency, remainingAgencies) {
  const state = normalizeStateCode(agency?.state);
  if (!state) return false;
  return !remainingAgencies.some((ag) => normalizeStateCode(ag?.state) === state);
}

function classifyGroupsForAgencyDelete(agency, allGroups, remainingAgencies) {
  const agencyName = String(agency?.name || "").trim();
  const deleteCountyGroups = shouldDeleteCountyGroups(agency, remainingAgencies);
  const deleteStateGroups = shouldDeleteStateGroups(agency, remainingAgencies);

  const adminNames = new Set(
    accessSvc.getAllAgencyAdminGroupNames(agency).map((n) => n.toLowerCase())
  );

  const agencyGroups = [];
  const countyGroups = [];
  const stateGroups = [];
  const seen = new Set();

  for (const group of Array.isArray(allGroups) ? allGroups : []) {
    const pk = String(group?.pk ?? group?.id ?? "").trim();
    const name = String(group?.name || "").trim();
    if (!pk || !name || seen.has(pk)) continue;

    if (adminNames.has(name.toLowerCase()) || matchesAgencyGroup(group, agencyName)) {
      seen.add(pk);
      agencyGroups.push(group);
      continue;
    }

    if (deleteCountyGroups && matchesCountyGroup(group, agency.county)) {
      seen.add(pk);
      countyGroups.push(group);
      continue;
    }

    if (deleteStateGroups && matchesStateGroup(group, agency.state)) {
      seen.add(pk);
      stateGroups.push(group);
    }
  }

  return {
    agencyGroups,
    countyGroups,
    stateGroups,
    deleteCountyGroups,
    deleteStateGroups,
  };
}

function countTemplatesForAgencySuffix(suffix) {
  const sfx = String(suffix || "").trim().toLowerCase();
  if (!sfx) return 0;
  return templatesStore.load().filter(
    (t) => String(t?.agencySuffix || "").trim().toLowerCase() === sfx
  ).length;
}

function removeTemplatesForAgencySuffix(suffix) {
  const sfx = String(suffix || "").trim().toLowerCase();
  if (!sfx) return 0;

  const templates = templatesStore.load();
  const remaining = templates.filter(
    (t) => String(t?.agencySuffix || "").trim().toLowerCase() !== sfx
  );
  const removed = templates.length - remaining.length;
  if (removed > 0) templatesStore.save(remaining);
  return removed;
}

async function buildAgencyDeletePlan(agencyIndex) {
  const idx = Number(agencyIndex);
  const agencies = agenciesStore.load();
  if (!Number.isInteger(idx) || !agencies[idx]) {
    throw new Error("Agency not found");
  }

  const agency = agencies[idx];
  const agencyName = String(agency.name || "").trim();
  if (!agencyName) throw new Error("Agency name is missing");

  const remainingAgencies = remainingAgenciesAfterDelete(agencies, idx);
  const allGroups = await groupsService.getAllGroups({ includeHidden: true });
  const groupPlan = classifyGroupsForAgencyDelete(agency, allGroups, remainingAgencies);
  const suffix = String(agency.suffix || "").trim().toLowerCase();
  const allAgencyUsers = await usersService.listAllUsersByAgencyName(agencyName);
  const agencyIntegrations = await usersService.findAgencyIntegrationUsersForSuffix(suffix);
  const integrationIds = new Set(
    agencyIntegrations
      .map((u) => String(u?.pk ?? u?.id ?? "").trim())
      .filter(Boolean)
  );
  const users = allAgencyUsers.filter((u) => {
    const id = String(u?.pk ?? u?.id ?? "").trim();
    return id && !integrationIds.has(id);
  });

  return {
    agencyIndex: idx,
    agency,
    agencyName,
    agencySuffix: suffix,
    userCount: users.length,
    integrationCount: agencyIntegrations.length,
    agencyGroupCount: groupPlan.agencyGroups.length,
    countyGroupCount: groupPlan.countyGroups.length,
    stateGroupCount: groupPlan.stateGroups.length,
    templateCount: countTemplatesForAgencySuffix(suffix),
    pendingRequestCount: userRequestsService.countPendingRequestsForAgencySuffix(suffix),
    willDeleteCountyGroups: groupPlan.deleteCountyGroups,
    willDeleteStateGroups: groupPlan.deleteStateGroups,
    county: normalizeCountyName(agency.county),
    state: normalizeStateCode(agency.state),
    users,
    agencyIntegrations,
    ...groupPlan,
  };
}

async function getAgencyDeletePreview(agencyIndex) {
  const plan = await buildAgencyDeletePlan(agencyIndex);
  const dataSyncMissions = await findDataSyncMissionsForDeletedGroups(plan);
  const dataSyncByScope = summarizeDataSyncMissionsByScope(dataSyncMissions);
  return {
    agencyName: plan.agencyName,
    agencySuffix: plan.agencySuffix,
    userCount: plan.userCount,
    integrationCount: plan.integrationCount,
    agencyGroupCount: plan.agencyGroupCount,
    countyGroupCount: plan.countyGroupCount,
    stateGroupCount: plan.stateGroupCount,
    dataSyncMissionCount: dataSyncByScope.total,
    agencyDataSyncMissionCount: dataSyncByScope.agency,
    countyDataSyncMissionCount: dataSyncByScope.county,
    stateDataSyncMissionCount: dataSyncByScope.state,
    templateCount: plan.templateCount,
    pendingRequestCount: plan.pendingRequestCount,
    willDeleteCountyGroups: plan.willDeleteCountyGroups,
    willDeleteStateGroups: plan.willDeleteStateGroups,
    county: plan.county,
    state: plan.state,
  };
}

async function deleteGroupsInPlan(groups) {
  const failures = [];
  let deleted = 0;

  for (const group of Array.isArray(groups) ? groups : []) {
    const pk = String(group?.pk ?? group?.id ?? "").trim();
    const name = String(group?.name || "").trim();
    if (!pk) continue;

    try {
      await groupsService.deleteGroupWithCleanup(pk, { ignoreLocks: true });
      deleted += 1;
    } catch (err) {
      failures.push({
        groupId: pk,
        groupName: name,
        error: err?.message || String(err),
      });
    }
  }

  if (failures.length) {
    const detail = failures
      .slice(0, 5)
      .map((f) => `${f.groupName || f.groupId}: ${f.error}`)
      .join(" | ");
    throw new Error(
      `Failed to delete ${failures.length} group(s). ${detail}${
        failures.length > 5 ? " | …" : ""
      }`
    );
  }

  return deleted;
}

async function deleteAgencyIntegrations(integrations) {
  const list = Array.isArray(integrations) ? integrations : [];
  if (!list.length) return 0;

  const failures = [];
  let deleted = 0;

  for (const user of list) {
    const userId = String(user?.pk ?? user?.id ?? "").trim();
    const username = String(user?.username || "").trim();
    try {
      await usersService.deleteIntegrationUser(user);
      deleted += 1;
    } catch (err) {
      failures.push({
        userId,
        username,
        error: err?.message || String(err),
      });
    }
  }

  if (failures.length) {
    const detail = failures
      .slice(0, 5)
      .map((f) => `${f.username || f.userId}: ${f.error}`)
      .join(" | ");
    throw new Error(
      `Failed to delete ${failures.length} integration(s). ${detail}${
        failures.length > 5 ? " | …" : ""
      }`
    );
  }

  return deleted;
}

async function deleteAgency(agencyIndex) {
  const plan = await buildAgencyDeletePlan(agencyIndex);
  const idx = plan.agencyIndex;
  const agencies = agenciesStore.load();
  const agency = agencies[idx];
  if (!agency) throw new Error("Agency not found");

  const userResult = await usersService.bulkDeleteUsersForAgency(plan.users);
  const integrationsDeleted = await deleteAgencyIntegrations(plan.agencyIntegrations);

  // Delete Data Sync missions tied to groups that will be removed (before groups go away).
  const dataSyncResult = await deleteDataSyncMissionsForPlan(plan);

  const groupsDeleted =
    (await deleteGroupsInPlan(plan.agencyGroups)) +
    (await deleteGroupsInPlan(plan.countyGroups)) +
    (await deleteGroupsInPlan(plan.stateGroups));

  const templatesRemoved = removeTemplatesForAgencySuffix(plan.agencySuffix);
  const pendingRequestsRemoved = userRequestsService.deleteRequestsForAgencySuffix(
    plan.agencySuffix
  );

  agencies.splice(idx, 1);
  agenciesStore.save(agencies);

  groupsService.invalidateGroupsCache();

  return {
    success: true,
    agencyName: plan.agencyName,
    agencySuffix: plan.agencySuffix,
    usersDeleted: userResult.deletedIds.length,
    integrationsDeleted,
    dataSyncMissionsDeleted: dataSyncResult.deleted,
    dataSyncMissionsAttempted: dataSyncResult.attempted,
    agencyGroupsDeleted: plan.agencyGroups.length,
    countyGroupsDeleted: plan.countyGroups.length,
    stateGroupsDeleted: plan.stateGroups.length,
    groupsDeleted,
    templatesRemoved,
    pendingRequestsRemoved,
    deletedCountyGroups: plan.deleteCountyGroups,
    deletedStateGroups: plan.deleteStateGroups,
  };
}

module.exports = {
  getAgencyDeletePreview,
  deleteAgency,
};
