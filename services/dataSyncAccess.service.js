/**
 * Access rules for Data Sync missions — single-group missions only;
 * agency admins scoped to agency-specific groups (not county/state extras).
 *
 * TAK Marti uses LDAP CN (no tak_ prefix). Authentik stores tak_<CN>.
 * All matching compares canonical keys after stripping tak_.
 */

const accessSvc = require("./access.service");
const agenciesSvc = require("./agencies.service");
const groupsSvc = require("./groups.service");
const dataSyncSvc = require("./dataSync.service");
const dataPackagesSvc = require("./dataPackages.service");
const packageKind = require("./packageKind.service");
const mutualAidStore = require("./mutualAid.store");
const { getString } = require("./env");

/** Authentik / TAK display prefix for MA-created channels (not hidden on Data Sync for global admins). */
const MUTUAL_AID_GROUP_PREFIX = "ma -";

function canonicalGroupKey(name) {
  let n = String(name || "").trim().toLowerCase();
  if (n.startsWith("tak_")) n = n.slice(4);
  return n.replace(/\s+/g, " ").trim();
}

function takDisplayName(name) {
  return groupsSvc.stripTakPrefix(String(name || "").trim());
}

/** Global admin dropdown: hide internal / LDAP-prefixed TAK group names. */
function isHiddenGlobalAdminGroupName(name) {
  const n = String(name || "").trim();
  if (!n) return true;
  if (n.startsWith("_")) return true;
  return n.toLowerCase().startsWith("tak_");
}

function filterGlobalAdminGroupNames(names) {
  return (Array.isArray(names) ? names : []).filter((n) => !isHiddenGlobalAdminGroupName(n));
}

function isAuthentikAgencyAdminGroupName(name) {
  return /-AgencyAdmin$/i.test(String(name || "").trim());
}

function getDataSyncHiddenPrefixes() {
  return String(getString("GROUPS_HIDDEN_PREFIXES", "") || "")
    .split(",")
    .map((p) => String(p || "").trim().toLowerCase())
    .filter(Boolean)
    .filter((p) => p !== MUTUAL_AID_GROUP_PREFIX);
}

/** Match Groups page visibility for global admins; MA channels remain selectable on Data Sync. */
function filterAuthentikGroupsForGlobalAdminDataSync(authUser, allGroups) {
  let filtered = accessSvc.filterGroupsForUser(authUser, allGroups);

  const hiddenPrefixes = getDataSyncHiddenPrefixes();

  if (hiddenPrefixes.length) {
    filtered = filtered.filter((g) => {
      const raw = String(g?.name || "").trim().toLowerCase();
      const withoutTak = raw.startsWith("tak_") ? raw.slice(4) : raw;
      return !hiddenPrefixes.some(
        (prefix) => raw.startsWith(prefix) || withoutTak.startsWith(prefix)
      );
    });
  }

  return filtered;
}

/**
 * All portal-managed groups for global admin (agency, county, state, global, private agency).
 * Uses Authentik as source of truth; TAK CN display names (no tak_ prefix).
 */
async function getGlobalAdminGroupDisplayNames(authUser) {
  const authentikGroups = await groupsSvc.getAllGroups({});
  const visible = filterAuthentikGroupsForGlobalAdminDataSync(authUser, authentikGroups);
  const out = [];
  const seen = new Set();

  for (const g of visible) {
    const authentikName = String(g?.name || "").trim();
    if (!authentikName || isAuthentikAgencyAdminGroupName(authentikName)) continue;
    const display = takDisplayName(authentikName);
    if (!display || display.startsWith("_")) continue;
    const key = canonicalGroupKey(display);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(display);
  }

  return out;
}

/** Ensure every group referenced by mutual aid appears in the global-admin Data Sync dropdown. */
function mergeMutualAidGroupNames(byKey, takByKey) {
  const seenNames = new Set();
  for (const item of mutualAidStore.load()) {
    const name = String(item?.groupName || "").trim();
    if (!name) continue;
    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey)) continue;
    seenNames.add(nameKey);

    const k = canonicalGroupKey(name);
    if (!k || byKey.has(k)) continue;
    const display = takByKey.get(k) || takDisplayName(name) || name;
    byKey.set(k, display);
  }
}

/**
 * Mutual aid channel groups the user belongs to (from mutual-aid.json groupName / groupId).
 * @returns {Array<{ authentikName, takDisplayName, canonicalKey, agencySuffix, groupPrefix, mutualAid }>}
 */
function resolveMutualAidAllowedGroups(userGroupNames, maRecords) {
  const byKey = new Map();
  const byId = new Map();
  for (const item of Array.isArray(maRecords) ? maRecords : []) {
    const name = String(item?.groupName || "").trim();
    if (!name) continue;
    const canonicalKey = canonicalGroupKey(name);
    if (!canonicalKey) continue;
    const entry = {
      authentikName: name,
      takDisplayName: takDisplayName(name),
      canonicalKey,
      agencySuffix: null,
      groupPrefix: null,
      mutualAid: true,
    };
    byKey.set(canonicalKey, entry);
    const gid = String(item?.groupId || "").trim();
    if (gid) byId.set(gid, entry);
  }
  if (!byKey.size) return [];

  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(userGroupNames) ? userGroupNames : []) {
    const token = String(raw || "").trim();
    if (!token) continue;
    let entry = byKey.get(canonicalGroupKey(token));
    if (!entry && byId.has(token)) entry = byId.get(token);
    if (!entry || seen.has(entry.canonicalKey)) continue;
    seen.add(entry.canonicalKey);
    out.push(entry);
  }
  return out;
}

function getMutualAidAllowedGroupsForUser(authUser) {
  return resolveMutualAidAllowedGroups(authUser?.groups, mutualAidStore.load());
}

function entryToGroupName(entry) {
  if (entry == null) return "";
  if (typeof entry === "string") return String(entry).trim();
  if (typeof entry === "object") {
    return String(
      entry.name || entry.groupName || entry.group || entry.title || entry.cn || ""
    ).trim();
  }
  return String(entry).trim();
}

function extractGroupEntries(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "object") return [];

  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.groups)) return payload.groups;

  const inner = payload.data;
  if (inner && typeof inner === "object" && Array.isArray(inner.groups)) {
    return inner.groups;
  }

  return [];
}

function extractTakGroupNameList(payload) {
  return extractGroupEntries(payload).map(entryToGroupName).filter(Boolean);
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

function resolveAssignmentMetaForGroup(rawGroupName) {
  const raw = String(rawGroupName || "").trim();
  if (!raw) {
    return { assignedGroup: null, assignedAgencyName: null };
  }
  const groupDisplay = takDisplayName(raw) || raw;
  const agency = agenciesSvc.findAgencyForGroupName(groupDisplay, agenciesSvc.load());
  const agencyName = agency ? String(agency.name || "").trim() || null : null;
  return {
    assignedGroup: groupDisplay,
    assignedAgencyName: agencyName,
  };
}

function enrichMissionAssignmentMeta(mission) {
  if (!mission || typeof mission !== "object") return mission;
  const groupName = missionSingleGroupName(mission);
  if (!groupName) return mission;
  return { ...mission, ...resolveAssignmentMetaForGroup(groupName) };
}

function enrichMissionListAssignmentMeta(list) {
  return (Array.isArray(list) ? list : []).map(enrichMissionAssignmentMeta);
}

function enrichMissionsPayloadAssignmentMeta(payload) {
  if (Array.isArray(payload)) {
    return payload.map(enrichMissionAssignmentMeta);
  }
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.data)) {
      return { ...payload, data: payload.data.map(enrichMissionAssignmentMeta) };
    }
    if (Array.isArray(payload.missions)) {
      return { ...payload, missions: payload.missions.map(enrichMissionAssignmentMeta) };
    }
  }
  return payload;
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

function takGroupNameAllowed(name, allowedKeySet) {
  if (allowedKeySet === null) return true;
  const key = canonicalGroupKey(name);
  if (!key) return false;
  return allowedKeySet.has(key);
}

/**
 * Agency-specific Authentik groups the user may use for Data Sync.
 * @returns {null} global admin — all groups
 * @returns {Array<{ authentikName, takDisplayName, canonicalKey, agencySuffix, groupPrefix }>}
 */
async function buildAgencyAllowedGroups(authUser) {
  const access = accessSvc.getAgencyAccess(authUser);
  if (access.isGlobalAdmin) return null;

  const authentikGroups = await groupsSvc.getAllGroups({});
  const allowedSuffixes = access.allowedAgencySuffixes || [];
  const agencies = agenciesSvc.load();
  const out = [];
  const seenKeys = new Set();

  for (const sfx of allowedSuffixes) {
    const norm = accessSvc.normalizeSuffix(sfx);
    const agency = agencies.find((a) => accessSvc.normalizeSuffix(a?.suffix) === norm);
    if (!agency) continue;
    const gp = String(agency.groupPrefix || "").trim();
    const agencyName = String(agency.name || "").trim();
    if (!agencyName && !gp) continue;
    const filtered = accessSvc.filterAgencySpecificGroupsForDashboard(
      authentikGroups,
      agencyName || gp
    );
    for (const g of filtered) {
      const authentikName = String(g?.name || "").trim();
      if (!authentikName) continue;
      const canonicalKey = canonicalGroupKey(authentikName);
      if (!canonicalKey || seenKeys.has(canonicalKey)) continue;
      seenKeys.add(canonicalKey);
      out.push({
        authentikName,
        takDisplayName: takDisplayName(authentikName),
        canonicalKey,
        agencySuffix: norm,
        groupPrefix: gp,
      });
    }
  }

  return out;
}

/** Map overlay: agency groups plus mutual aid channels the user belongs to. */
const MAP_MISSION_ACCESS = { includeMutualAid: true };

async function getAllowedCanonicalKeySet(authUser, options = {}) {
  const allowed = await buildAgencyAllowedGroups(authUser);
  if (allowed === null) return null;
  const keys = new Set(allowed.map((g) => g.canonicalKey));
  if (options.includeMutualAid) {
    for (const ma of getMutualAidAllowedGroupsForUser(authUser)) {
      keys.add(ma.canonicalKey);
    }
  }
  return keys;
}

/** @deprecated name retained for callers — returns canonical key Set */
async function getAllowedTakGroupNameSet(authUser) {
  return getAllowedCanonicalKeySet(authUser);
}

/**
 * Group names for the create/edit dropdown.
 * Agency admins: agency-specific groups; prefer TAK server spelling when present.
 */
async function resolveGroupsForUser(authUser, takPayload) {
  const access = accessSvc.getAgencyAccess(authUser);
  const takNames = extractTakGroupNameList(takPayload);
  const takByKey = new Map();
  for (const t of takNames) {
    const k = canonicalGroupKey(t);
    if (k && !takByKey.has(k)) takByKey.set(k, t);
  }

  if (access.isGlobalAdmin) {
    const authentikNames = await getGlobalAdminGroupDisplayNames(authUser);
    const byKey = new Map();

    for (const name of authentikNames) {
      const k = canonicalGroupKey(name);
      if (!k) continue;
      byKey.set(k, takByKey.get(k) || name);
    }

    // Include any TAK-only groups not mirrored in Authentik (exclude _ / tak_ raw names).
    for (const t of filterGlobalAdminGroupNames(takNames)) {
      const k = canonicalGroupKey(t);
      if (k && !byKey.has(k)) byKey.set(k, t);
    }

    const beforeMaMerge = byKey.size;
    mergeMutualAidGroupNames(byKey, takByKey);

    const groups = Array.from(byKey.values()).sort((a, b) => a.localeCompare(b));
    return {
      groups,
      debug: {
        scope: "global",
        authentikGroupCount: authentikNames.length,
        takGroupCount: takNames.length,
        mutualAidGroupsAdded: byKey.size - beforeMaMerge,
        visibleGroupCount: groups.length,
      },
    };
  }

  const allowed = await buildAgencyAllowedGroups(authUser);
  const resolved = [];
  const matchDetails = [];

  for (const ag of allowed) {
    const fromTak = takByKey.get(ag.canonicalKey);
    const chosen = fromTak || ag.takDisplayName;
    resolved.push(chosen);
    matchDetails.push({
      authentikName: ag.authentikName,
      takDisplayName: ag.takDisplayName,
      canonicalKey: ag.canonicalKey,
      matchedTakName: fromTak || null,
      chosenForUi: chosen,
    });
  }

  const groups = [...new Set(resolved)].sort((a, b) => a.localeCompare(b));

  return {
    groups,
    debug: {
      scope: "agency",
      allowedAgencySuffixes: access.allowedAgencySuffixes || [],
      authentikAllowedCount: allowed.length,
      takGroupCount: takNames.length,
      takSample: takNames.slice(0, 12),
      resolvedGroupCount: groups.length,
      matches: matchDetails,
    },
  };
}

function filterMissionsForAccess(missions, allowedKeySet) {
  const list = Array.isArray(missions) ? missions : [];
  return list.filter((m) => {
    const g = missionSingleGroupName(m);
    if (!g) return false;
    return takGroupNameAllowed(g, allowedKeySet);
  });
}

function filterGroupsPayload(payload, allowedKeySet) {
  if (allowedKeySet === null) return payload;

  const keepEntry = (entry) => {
    const n = entryToGroupName(entry);
    return n && takGroupNameAllowed(n, allowedKeySet);
  };

  if (Array.isArray(payload)) {
    return payload.filter(keepEntry);
  }
  if (payload && typeof payload === "object" && Array.isArray(payload.data)) {
    return { ...payload, data: payload.data.filter(keepEntry) };
  }
  if (payload && typeof payload === "object" && Array.isArray(payload.groups)) {
    return { ...payload, groups: payload.groups.filter(keepEntry) };
  }
  return [];
}

function filterMissionsPayload(payload, allowedKeySet) {
  if (allowedKeySet === null) {
    if (Array.isArray(payload)) return filterMissionsForAccess(payload, null);
    if (payload && Array.isArray(payload.data)) {
      return { ...payload, data: filterMissionsForAccess(payload.data, null) };
    }
    return payload;
  }

  if (Array.isArray(payload)) return filterMissionsForAccess(payload, allowedKeySet);
  if (payload && Array.isArray(payload.data)) {
    return { ...payload, data: filterMissionsForAccess(payload.data, allowedKeySet) };
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

function assertGroupAllowed(body, allowedKeySet) {
  if (allowedKeySet === null) return;
  const groups = Array.isArray(body?.groups) ? body.groups : [];
  if (!groups.length) return;
  for (const g of groups) {
    const name = entryToGroupName(g);
    if (!takGroupNameAllowed(name, allowedKeySet)) {
      const err = new Error("Forbidden");
      err.code = "FORBIDDEN";
      throw err;
    }
  }
}

async function assertMissionReadable(authUser, missionName, options = {}) {
  const allowedKeySet = await getAllowedCanonicalKeySet(authUser, options);
  const raw = await dataSyncSvc.getMission(missionName);
  const mission = unwrapMission(raw);
  const g = missionSingleGroupName(mission);
  if (!g || !takGroupNameAllowed(g, allowedKeySet)) {
    const err = new Error("Forbidden");
    err.code = "FORBIDDEN";
    throw err;
  }
  return raw;
}

function parsePackageGroupsField(groupsRaw) {
  const raw = String(groupsRaw || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);
}

function extractPackageGroupNames(record) {
  if (!record || typeof record !== "object") return [];
  const raw =
    record.groups != null && record.groups !== ""
      ? record.groups
      : record.Groups != null && record.Groups !== ""
        ? record.Groups
        : record.group != null && record.group !== ""
          ? record.group
          : record.Group;
  if (Array.isArray(raw)) {
    return raw.map(entryToGroupName).filter(Boolean);
  }
  return parsePackageGroupsField(raw);
}

function packageAllowedForAccess(record, allowedKeySet) {
  if (allowedKeySet === null) return true;
  const groups = extractPackageGroupNames(record);
  if (!groups.length) return false;
  return groups.some((g) => takGroupNameAllowed(g, allowedKeySet));
}

function filterFileSyncPackagesForAccess(packages, allowedKeySet) {
  const list = Array.isArray(packages) ? packages : [];
  return list.filter((pkg) => {
    if (!packageKind.isDataSyncRecord(pkg)) return false;
    return packageAllowedForAccess(pkg, allowedKeySet);
  });
}

async function listFileSyncPackagesForUser(authUser) {
  const allowedKeySet = await getAllowedCanonicalKeySet(authUser);
  const data = await dataPackagesSvc.listDataPackages({});
  const items = filterFileSyncPackagesForAccess(data.items || [], allowedKeySet);
  return {
    items,
    source: data.source || "marti_files_metadata",
  };
}

async function assertFileSyncPackageAllowed(authUser, hash) {
  const h = String(hash || "").trim();
  if (!h) {
    const err = new Error("Forbidden");
    err.code = "FORBIDDEN";
    throw err;
  }
  const data = await listFileSyncPackagesForUser(authUser);
  const record = (data.items || []).find(
    (x) => String(x.hash || "").trim().toLowerCase() === h.toLowerCase()
  );
  if (!record) {
    const err = new Error("Forbidden");
    err.code = "FORBIDDEN";
    throw err;
  }
  return record;
}

function normalizeArchiveName(name) {
  return String(name || "")
    .trim()
    .replace(/\.zip$/i, "")
    .toLowerCase();
}

function normalizePackageKeywords(record) {
  if (Array.isArray(record && record.keywords)) {
    return record.keywords.map((k) => String(k || "").trim()).filter(Boolean);
  }
  const raw =
    record && record.Keywords != null && record.Keywords !== ""
      ? record.Keywords
      : record && record.keyword != null
        ? record.keyword
        : "";
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

function packageHasKeyword(record, keyword) {
  const target = String(keyword || "").trim().toLowerCase();
  return normalizePackageKeywords(record).some(
    (k) => String(k).trim().toLowerCase() === target
  );
}

function packageFilename(record) {
  return String(
    record?.filename ||
      record?.Filename ||
      record?.name ||
      record?.Name ||
      record?.original_filename ||
      ""
  ).trim();
}

function packageHash(record) {
  return String(
    record?.hash || record?.Hash || record?.sha256 || record?.uid || record?.id || ""
  ).trim();
}

function isPermanentDeleteFileSyncRecord(record) {
  return (
    packageKind.isDataSyncRecord(record) ||
    packageHasKeyword(record, packageKind.ARCHIVED_KEYWORD) ||
    packageHasKeyword(record, packageKind.DATA_SYNC_KEYWORD)
  );
}

function fileSyncNameMatchesMission(missionName, filename) {
  const want = normalizeArchiveName(missionName);
  const fileKey = normalizeArchiveName(filename);
  if (!want || !fileKey) return false;
  if (fileKey === want) return true;
  if (fileKey.startsWith(want) || want.startsWith(fileKey)) return true;
  const rawWant = String(missionName || "")
    .trim()
    .replace(/\.zip$/i, "")
    .toLowerCase();
  const rawFile = String(filename || "")
    .trim()
    .replace(/\.zip$/i, "")
    .toLowerCase();
  if (rawWant && rawFile && (rawFile.includes(rawWant) || rawWant.includes(rawFile))) {
    return true;
  }
  return false;
}

function findMatchingFileSyncPackagesForMission(missionName, mission, packages, allowedKeySet, opts) {
  opts = opts || {};
  const broad = !!opts.broad;
  const hashes = new Set();
  const contents = mission && Array.isArray(mission.contents) ? mission.contents : [];
  for (const item of contents) {
    const data = item && item.data ? item.data : item;
    const h = data && (data.hash || data.Hash || data.uid)
      ? String(data.hash || data.Hash || data.uid).trim().toLowerCase()
      : "";
    if (h) hashes.add(h);
  }

  const out = [];
  const seen = new Set();
  for (const pkg of Array.isArray(packages) ? packages : []) {
    const hash = packageHash(pkg).toLowerCase();
    const filename = packageFilename(pkg);
    if (!hash || seen.has(hash)) continue;
    if (!packageAllowedForAccess(pkg, allowedKeySet)) continue;

    let match = false;
    if (hashes.has(hash)) match = true;
    if (fileSyncNameMatchesMission(missionName, filename)) match = true;

    if (!match) continue;
    if (!broad && !isPermanentDeleteFileSyncRecord(pkg)) continue;
    seen.add(hash);
    out.push(pkg);
  }
  return out;
}

async function deleteMatchingFileSyncPackages(missionName, mission, allowedKeySet, opts) {
  const data = await dataPackagesSvc.listDataPackages({});
  const targets = findMatchingFileSyncPackagesForMission(
    missionName,
    mission,
    data.items || [],
    allowedKeySet,
    opts
  );
  let deletedFiles = 0;
  for (const pkg of targets) {
    const hash = packageHash(pkg);
    if (!hash) continue;
    await dataPackagesSvc.deleteDataPackage(hash);
    deletedFiles += 1;
  }
  return deletedFiles;
}

async function permanentlyDeleteMissionForUser(authUser, missionName) {
  const name = String(missionName || "").trim();
  if (!name) {
    const err = new Error("Mission name is required.");
    err.code = "INVALID_MISSION_NAME";
    throw err;
  }

  const allowedKeySet = await getAllowedCanonicalKeySet(authUser);
  let mission = null;
  let missionExisted = false;

  try {
    const raw = await dataSyncSvc.getMission(name);
    mission = unwrapMission(raw);
    missionExisted = !!mission;
    const g = missionSingleGroupName(mission);
    if (!g || !takGroupNameAllowed(g, allowedKeySet)) {
      const err = new Error("Forbidden");
      err.code = "FORBIDDEN";
      throw err;
    }
  } catch (err) {
    const status = err?.response?.status;
    if (err?.code === "FORBIDDEN") throw err;
    if (status && status !== 404) throw err;
  }

  let deletedFiles = 0;

  // Remove any existing file-sync copies before deleting the active mission.
  deletedFiles += await deleteMatchingFileSyncPackages(name, mission, allowedKeySet, { broad: true });

  if (missionExisted) {
    try {
      await dataSyncSvc.deleteMission(name);
    } catch (err) {
      const status = err?.response?.status;
      if (!status || status !== 404) throw err;
    }
  }

  // TAK often writes a new ARCHIVED_MISSION file-sync row when a mission is deleted.
  deletedFiles += await deleteMatchingFileSyncPackages(name, mission, allowedKeySet, { broad: true });

  return {
    ok: true,
    missionName: name,
    deletedFiles,
    deletedMission: missionExisted,
  };
}

async function buildAccessDebug(authUser) {
  const access = accessSvc.getAgencyAccess(authUser);
  let takGroupsRaw = [];
  let takError = null;
  try {
    const data = await dataSyncSvc.listGroupsAll();
    takGroupsRaw = extractTakGroupNameList(data);
  } catch (err) {
    takError = err?.message || String(err);
  }

  let missionsRaw = [];
  let missionsError = null;
  try {
    const data = await dataSyncSvc.listMissions({});
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    missionsRaw = list.map((m) => ({
      name: m?.name,
      groups: extractMissionGroupNames(m),
      singleGroup: missionSingleGroupName(m),
      singleGroupKey: canonicalGroupKey(missionSingleGroupName(m) || ""),
    }));
  } catch (err) {
    missionsError = err?.message || String(err);
  }

  const allowed = await buildAgencyAllowedGroups(authUser);
  const allowedKeySet = allowed === null ? null : new Set(allowed.map((g) => g.canonicalKey));
  const mapMissionKeySet = await getAllowedCanonicalKeySet(authUser, MAP_MISSION_ACCESS);
  const mutualAidAllowed = getMutualAidAllowedGroupsForUser(authUser);
  const resolved = await resolveGroupsForUser(authUser, takGroupsRaw);

  const missionFilterPreview = missionsRaw.map((m) => ({
    ...m,
    allowed: takGroupNameAllowed(m.singleGroup || "", allowedKeySet),
    allowedOnMap: takGroupNameAllowed(m.singleGroup || "", mapMissionKeySet),
  }));

  return {
    user: {
      username: authUser?.username || null,
      isGlobalAdmin: access.isGlobalAdmin,
      isAgencyAdmin: access.isAgencyAdmin,
      allowedAgencySuffixes: access.allowedAgencySuffixes,
    },
    takGroups: {
      count: takGroupsRaw.length,
      sample: takGroupsRaw.slice(0, 20),
      error: takError,
    },
    authentikAllowedGroups: allowed,
    mutualAidAllowedGroups: mutualAidAllowed,
    resolvedUiGroups: resolved.groups,
    resolvedDebug: resolved.debug,
    missions: {
      count: missionsRaw.length,
      preview: missionFilterPreview,
      error: missionsError,
    },
  };
}

module.exports = {
  canonicalGroupKey,
  takDisplayName,
  entryToGroupName,
  extractTakGroupNameList,
  extractMissionGroupNames,
  missionSingleGroupName,
  resolveAssignmentMetaForGroup,
  enrichMissionAssignmentMeta,
  enrichMissionListAssignmentMeta,
  enrichMissionsPayloadAssignmentMeta,
  buildAgencyAllowedGroups,
  MAP_MISSION_ACCESS,
  getMutualAidAllowedGroupsForUser,
  resolveMutualAidAllowedGroups,
  getAllowedTakGroupNameSet,
  getAllowedCanonicalKeySet,
  resolveGroupsForUser,
  filterMissionsForAccess,
  filterGroupsPayload,
  filterMissionsPayload,
  filterFileSyncPackagesForAccess,
  listFileSyncPackagesForUser,
  assertFileSyncPackageAllowed,
  permanentlyDeleteMissionForUser,
  extractPackageGroupNames,
  assertSingleGroupBody,
  assertGroupAllowed,
  assertMissionReadable,
  unwrapMission,
  takGroupNameAllowed,
  buildAccessDebug,
  isHiddenGlobalAdminGroupName,
  filterGlobalAdminGroupNames,
};
