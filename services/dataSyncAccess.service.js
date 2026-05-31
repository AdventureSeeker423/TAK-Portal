/**
 * Access rules for Data Sync missions — single-group missions only;
 * agency admins scoped to agency-specific groups (not county/state extras).
 */

const accessSvc = require("./access.service");
const agenciesSvc = require("./agencies.service");
const groupsSvc = require("./groups.service");
const dataSyncSvc = require("./dataSync.service");

function normalizeTakGroupName(name) {
  return String(name || "").trim().toLowerCase();
}

function entryToGroupName(entry) {
  if (entry == null) return "";
  if (typeof entry === "string") return String(entry).trim();
  if (typeof entry === "object") {
    return String(
      entry.name || entry.groupName || entry.group || entry.title || ""
    ).trim();
  }
  return String(entry).trim();
}

function extractMissionGroupNames(mission) {
  const groups = mission && Array.isArray(mission.groups) ? mission.groups : [];
  return groups.map(entryToGroupName).filter(Boolean);
}

function missionSingleGroupName(mission) {
  const names = extractMissionGroupNames(mission);
  if (names.length !== 1) return null;
  return names[0];
}

function unwrapMission(payload) {
  if (!payload) return null;
  if (payload.data != null) {
    if (Array.isArray(payload.data) && payload.data.length) return payload.data[0];
    if (typeof payload.data === "object" && !Array.isArray(payload.data)) return payload.data;
  }
  if (payload.Mission && typeof payload.Mission === "object") return payload.Mission;
  return payload;
}

function unwrapMissionList(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

function takGroupNameAllowed(name, allowedSet) {
  if (allowedSet === null) return true;
  const n = normalizeTakGroupName(name);
  if (allowedSet.has(n)) return true;
  const stripped = n.startsWith("tak_") ? n.slice(4) : n;
  const prefixed = n.startsWith("tak_") ? n : `tak_${n}`;
  return allowedSet.has(stripped) || allowedSet.has(prefixed);
}

async function getAllowedTakGroupNameSet(authUser) {
  const access = accessSvc.getAgencyAccess(authUser);
  if (access.isGlobalAdmin) return null;

  const authentikGroups = await groupsSvc.getAllGroups({});
  const allowedSuffixes = access.allowedAgencySuffixes || [];
  const agencies = agenciesSvc.load();
  const nameSet = new Set();

  for (const sfx of allowedSuffixes) {
    const norm = accessSvc.normalizeSuffix(sfx);
    const agency = agencies.find((a) => accessSvc.normalizeSuffix(a?.suffix) === norm);
    if (!agency) continue;
    const gp = String(agency.groupPrefix || "").trim();
    if (!gp) continue;
    const filtered = accessSvc.filterAgencySpecificGroupsForDashboard(authentikGroups, gp);
    for (const g of filtered) {
      const raw = String(g?.name || "").trim();
      if (!raw) continue;
      nameSet.add(normalizeTakGroupName(raw));
      nameSet.add(normalizeTakGroupName(groupsSvc.ensureTakPrefix(raw)));
      nameSet.add(normalizeTakGroupName(groupsSvc.stripTakPrefix(raw)));
    }
  }
  return nameSet;
}

function filterMissionsForAccess(missions, allowedSet) {
  const list = Array.isArray(missions) ? missions : [];
  return list.filter((m) => {
    const g = missionSingleGroupName(m);
    if (!g) return false;
    return takGroupNameAllowed(g, allowedSet);
  });
}

function filterGroupsPayload(payload, allowedSet) {
  if (allowedSet === null) return payload;

  const keepEntry = (entry) => {
    const n = entryToGroupName(entry);
    return n && takGroupNameAllowed(n, allowedSet);
  };

  if (Array.isArray(payload)) {
    return payload.filter(keepEntry);
  }
  if (payload && typeof payload === "object" && Array.isArray(payload.data)) {
    return { ...payload, data: payload.data.filter(keepEntry) };
  }
  return payload;
}

function filterMissionsPayload(payload, allowedSet) {
  if (allowedSet === null) {
    if (Array.isArray(payload)) return filterMissionsForAccess(payload, null);
    if (payload && Array.isArray(payload.data)) {
      return { ...payload, data: filterMissionsForAccess(payload.data, null) };
    }
    return payload;
  }

  if (Array.isArray(payload)) return filterMissionsForAccess(payload, allowedSet);
  if (payload && Array.isArray(payload.data)) {
    return { ...payload, data: filterMissionsForAccess(payload.data, allowedSet) };
  }
  return payload;
}

function assertSingleGroupBody(body) {
  const groups = Array.isArray(body?.groups) ? body.groups : [];
  if (groups.length > 1) {
    const err = new Error("Only one group is allowed per Data Sync mission.");
    err.code = "MULTIPLE_GROUPS";
    throw err;
  }
}

function assertGroupAllowed(body, allowedSet) {
  if (allowedSet === null) return;
  const groups = Array.isArray(body?.groups) ? body.groups : [];
  if (!groups.length) return;
  for (const g of groups) {
    const name = entryToGroupName(g);
    if (!takGroupNameAllowed(name, allowedSet)) {
      const err = new Error("Forbidden");
      err.code = "FORBIDDEN";
      throw err;
    }
  }
}

async function assertMissionReadable(authUser, missionName) {
  const allowedSet = await getAllowedTakGroupNameSet(authUser);
  const raw = await dataSyncSvc.getMission(missionName);
  const mission = unwrapMission(raw);
  const g = missionSingleGroupName(mission);
  if (!g || !takGroupNameAllowed(g, allowedSet)) {
    const err = new Error("Forbidden");
    err.code = "FORBIDDEN";
    throw err;
  }
  return raw;
}

module.exports = {
  entryToGroupName,
  extractMissionGroupNames,
  missionSingleGroupName,
  getAllowedTakGroupNameSet,
  filterMissionsForAccess,
  filterGroupsPayload,
  filterMissionsPayload,
  assertSingleGroupBody,
  assertGroupAllowed,
  assertMissionReadable,
  takGroupNameAllowed,
};
