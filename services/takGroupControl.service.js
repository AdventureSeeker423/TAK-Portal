/**
 * Live session group control for connected TAK clients (Marti activeForce API).
 */
const { buildTakAxios, isTakBypassed, isTakConfigured } = require("./tak.service");
const {
  getSubscriptionsAll,
  isExcludedConnectedUserSubscription,
} = require("./takMetrics.service");
const accessSvc = require("./access.service");
const tokensSvc = require("./authentikTokens.service");
const usersSvc = require("./users.service");
const prefPkgSvc = require("./preferencePackage.service");
const takMissionPkgSvc = require("./takMissionPackage.service");
const settingsSvc = require("./settings.service");
const dataSyncSvc = require("./dataSync.service");
const dataSyncAccess = require("./dataSyncAccess.service");

const REMOTE_ACTIONS_TAK_CLIENTS = new Set(["ATAK-CIV", "ITAK"]);
const PREFERENCE_CONFIG_TAK_CLIENTS = new Set(["ATAK-CIV"]);
const DATA_SYNC_INVITE_CHANNEL_SETTLE_MS = 1500;

function safeStr(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function normalizeDirection(value) {
  const d = safeStr(value).trim().toUpperCase();
  return d === "IN" || d === "OUT" ? d : "";
}

function directionTypeLabel(direction) {
  return direction === "IN" ? "WRITE" : direction === "OUT" ? "READ" : "";
}

function cleanGroupForTakPayload(group) {
  if (!group || typeof group !== "object") return null;
  const name = safeStr(group.name).trim();
  const direction = normalizeDirection(group.direction);
  if (!name || !direction) return null;
  const out = {
    name,
    direction,
    created: safeStr(group.created).trim() || undefined,
    type: safeStr(group.type).trim() || "SYSTEM",
    bitpos: Number.isFinite(Number(group.bitpos)) ? Number(group.bitpos) : undefined,
    active: group.active === true,
  };
  if (out.created === undefined) delete out.created;
  if (out.bitpos === undefined) delete out.bitpos;
  return out;
}

function normalizeGroupRow(group) {
  const cleaned = cleanGroupForTakPayload(group);
  if (!cleaned) return null;
  return {
    ...cleaned,
    typeLabel: directionTypeLabel(cleaned.direction),
    entitled: true,
  };
}

function groupNameKey(name) {
  return safeStr(name).trim().toLowerCase();
}

function normalizeAccessMode(value) {
  const v = safeStr(value).trim().toUpperCase();
  if (v === "READ" || v === "WRITE" || v === "BOTH") return v;
  return "";
}

/**
 * Collapse raw IN/OUT rows into one UI row per logical group:
 * - OUT only → READ
 * - IN only → WRITE
 * - IN + OUT → BOTH (single checkbox toggles both directions)
 */
function collapseGroupsForDisplay(rows) {
  const byName = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const key = groupNameKey(row.name);
    if (!key) continue;
    if (!byName.has(key)) {
      byName.set(key, { name: safeStr(row.name).trim(), in: null, out: null });
    }
    const entry = byName.get(key);
    if (row.direction === "IN") entry.in = row;
    if (row.direction === "OUT") entry.out = row;
  }

  const result = [];
  for (const entry of byName.values()) {
    const hasIn = !!entry.in;
    const hasOut = !!entry.out;

    if (hasIn && hasOut) {
      const inActive = entry.in.active === true;
      const outActive = entry.out.active === true;
      result.push({
        name: entry.name,
        displayName: entry.name,
        accessMode: "BOTH",
        typeLabel: "BOTH",
        active: inActive && outActive,
        inActive,
        outActive,
        bitpos: entry.in.bitpos ?? entry.out.bitpos,
      });
    } else if (hasOut) {
      result.push({
        name: entry.name,
        displayName: `${entry.name}_READ`,
        accessMode: "READ",
        typeLabel: "READ",
        direction: "OUT",
        active: entry.out.active === true,
        bitpos: entry.out.bitpos,
      });
    } else if (hasIn) {
      result.push({
        name: entry.name,
        displayName: `${entry.name}_WRITE`,
        accessMode: "WRITE",
        typeLabel: "WRITE",
        direction: "IN",
        active: entry.in.active === true,
        bitpos: entry.in.bitpos,
      });
    }
  }

  result.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return result;
}

function resolveAccessMode({ accessMode, direction }) {
  const mode = normalizeAccessMode(accessMode);
  if (mode) return mode;
  const dir = normalizeDirection(direction);
  if (dir === "IN") return "WRITE";
  if (dir === "OUT") return "READ";
  return "";
}

function shouldUpdateRawRow(row, groupName, mode) {
  if (groupNameKey(row.name) !== groupNameKey(groupName)) return false;
  if (mode === "BOTH") return row.direction === "IN" || row.direction === "OUT";
  if (mode === "READ") return row.direction === "OUT";
  if (mode === "WRITE") return row.direction === "IN";
  return false;
}

async function fetchGroupsForUser(username) {
  if (!isTakConfigured() || isTakBypassed()) {
    const err = new Error("TAK is not configured or is bypassed.");
    err.status = 503;
    throw err;
  }

  const u = safeStr(username).trim();
  if (!u) {
    const err = new Error("Username is required.");
    err.status = 400;
    throw err;
  }

  const client = buildTakAxios();
  const res = await client.get("/api/groups/user", {
    params: { username: u },
    headers: { Accept: "application/json" },
  });

  const list = Array.isArray(res.data?.data)
    ? res.data.data
    : Array.isArray(res.data)
      ? res.data
      : [];

  return list.map(normalizeGroupRow).filter(Boolean);
}

async function putActiveForceGroups(username, groups) {
  if (!isTakConfigured() || isTakBypassed()) {
    const err = new Error("TAK is not configured or is bypassed.");
    err.status = 503;
    throw err;
  }

  const u = safeStr(username).trim();
  if (!u) {
    const err = new Error("Username is required.");
    err.status = 400;
    throw err;
  }

  const payload = (Array.isArray(groups) ? groups : [])
    .map(cleanGroupForTakPayload)
    .filter(Boolean);

  if (!payload.length) {
    const err = new Error("No groups to apply.");
    err.status = 400;
    throw err;
  }

  const client = buildTakAxios();
  await client.put("/api/groups/activeForce", payload, {
    params: { username: u },
    headers: { Accept: "application/json", "Content-Type": "application/json" },
  });

  return fetchGroupsForUser(u);
}

function findSubscriptionByClientId(subscriptions, clientId) {
  const needle = safeStr(clientId).trim();
  if (!needle) return null;
  const list = Array.isArray(subscriptions) ? subscriptions : [];
  return (
    list.find((s) => safeStr(s?.clientUid).trim() === needle) ||
    list.find((s) => safeStr(s?.subscriptionUid).trim() === needle) ||
    null
  );
}

function resolveSubscriptionTakClient(subscription) {
  return (
    safeStr(subscription?.takClient).trim() ||
    safeStr(subscription?.platform).trim()
  );
}

function isRemoteActionsSubscription(subscription) {
  const client = resolveSubscriptionTakClient(subscription).toUpperCase();
  return REMOTE_ACTIONS_TAK_CLIENTS.has(client);
}

function isPreferenceConfigSubscription(subscription) {
  const client = resolveSubscriptionTakClient(subscription).toUpperCase();
  return PREFERENCE_CONFIG_TAK_CLIENTS.has(client);
}

function assertRemoteActionsSubscription(subscription) {
  if (!isRemoteActionsSubscription(subscription)) {
    const err = new Error("Remote actions are only available for ATAK-CIV and iTAK clients.");
    err.status = 403;
    throw err;
  }
}

function assertPreferenceConfigSubscription(subscription) {
  if (!isPreferenceConfigSubscription(subscription)) {
    const err = new Error("Callsign preferences are only available for ATAK-CIV clients.");
    err.status = 403;
    throw err;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unwrapMissionList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

function buildUserEntitledGroupKeySet(rawGroups) {
  const keys = new Set();
  for (const row of Array.isArray(rawGroups) ? rawGroups : []) {
    const name = safeStr(row?.name).trim();
    const key = dataSyncAccess.canonicalGroupKey(name);
    if (key) keys.add(key);
  }
  return keys;
}

function findCollapsedGroupForMission(collapsedGroups, missionGroupName) {
  const want = dataSyncAccess.canonicalGroupKey(missionGroupName);
  if (!want) return null;
  return (
    (Array.isArray(collapsedGroups) ? collapsedGroups : []).find(
      (g) => dataSyncAccess.canonicalGroupKey(g?.name) === want
    ) || null
  );
}

function isMissionGroupChannelActive(collapsedGroup) {
  return !!(collapsedGroup && collapsedGroup.active === true);
}

function resolveMissionDisplayName(mission) {
  return safeStr(mission?.name || mission?.missionName).trim();
}

function assertCanControlSubscription(authUser, subscription, { agencyOnly = false } = {}) {
  if (!subscription) {
    const err = new Error("Connected client not found.");
    err.status = 404;
    throw err;
  }
  if (isExcludedConnectedUserSubscription(subscription)) {
    const err = new Error("This client cannot be controlled.");
    err.status = 403;
    throw err;
  }
  const username = safeStr(subscription.username).trim();
  if (agencyOnly && authUser && !accessSvc.isUsernameInAllowedAgencySuffixes(authUser, username)) {
    const err = new Error("You do not have access to this client.");
    err.status = 403;
    throw err;
  }
  return username;
}

async function resolveSubscriptionForControl(clientId, authUser) {
  const subResult = await getSubscriptionsAll();
  if (!subResult?.configured) {
    const err = new Error("TAK subscriptions are not configured.");
    err.status = 503;
    throw err;
  }

  const isAgencyOnly = !!(authUser && authUser.isAgencyAdmin && !authUser.isGlobalAdmin);
  let list = Array.isArray(subResult.data) ? subResult.data : [];
  if (isAgencyOnly) {
    list = list.filter((item) =>
      accessSvc.isUsernameInAllowedAgencySuffixes(authUser, item && item.username)
    );
  }

  const subscription = findSubscriptionByClientId(list, clientId);
  const username = assertCanControlSubscription(authUser, subscription, { agencyOnly: isAgencyOnly });

  return {
    subscription,
    username,
    clientUid: safeStr(subscription.clientUid).trim() || safeStr(clientId).trim(),
    callsign: safeStr(subscription.callsign).trim(),
  };
}

async function getClientGroupControlState(clientId, authUser) {
  const ctx = await resolveSubscriptionForControl(clientId, authUser);
  const rawGroups = await fetchGroupsForUser(ctx.username);

  const collapsed = collapseGroupsForDisplay(rawGroups);
  const groups =
    collapsed.length === 1 ? [{ ...collapsed[0], locked: true }] : collapsed;

  return {
    configured: true,
    clientUid: ctx.clientUid,
    username: ctx.username,
    callsign: ctx.callsign,
    groups,
  };
}

async function setClientGroupActive(clientId, authUser, { groupName, accessMode, direction, active }) {
  const ctx = await resolveSubscriptionForControl(clientId, authUser);
  const name = safeStr(groupName).trim();
  const mode = resolveAccessMode({ accessMode, direction });
  if (!name || !mode) {
    const err = new Error("groupName and accessMode (READ, WRITE, or BOTH) are required.");
    err.status = 400;
    throw err;
  }
  if (typeof active !== "boolean") {
    const err = new Error("active must be a boolean.");
    err.status = 400;
    throw err;
  }

  const current = await fetchGroupsForUser(ctx.username);
  const collapsedCurrent = collapseGroupsForDisplay(current);
  if (collapsedCurrent.length === 1 && active === false) {
    const err = new Error("The only assigned group cannot be disabled.");
    err.status = 400;
    throw err;
  }

  let found = false;
  const next = current.map((row) => {
    if (!shouldUpdateRawRow(row, name, mode)) return row;
    found = true;
    return { ...row, active };
  });

  if (!found) {
    const err = new Error("Group not found for this user.");
    err.status = 404;
    throw err;
  }

  const rawGroups = await putActiveForceGroups(ctx.username, next);
  const collapsed = collapseGroupsForDisplay(rawGroups);
  const groups =
    collapsed.length === 1 ? [{ ...collapsed[0], locked: true }] : collapsed;
  return {
    configured: true,
    clientUid: ctx.clientUid,
    username: ctx.username,
    callsign: ctx.callsign,
    groups,
    changed: { groupName: name, accessMode: mode, active },
  };
}

async function lookupAuthentikPreferenceData(username) {
  const u = safeStr(username).trim();
  if (!u) return null;
  try {
    const userId = await tokensSvc.getUserIdByUsername(u);
    if (!userId) return null;
    const user = await usersSvc.getUserById(userId).catch(() => null);
    if (!user || user.pk == null) return null;
    return usersSvc.getPreferenceDataForUser(user);
  } catch (_) {
    return null;
  }
}

function mergePreferencePrefills(authPref, subscription) {
  const subCallsign = safeStr(subscription?.callsign).trim();
  const subTeam = safeStr(subscription?.team).trim();
  const subRole = safeStr(subscription?.role).trim();

  const authCallsign = safeStr(authPref?.callsign).trim();
  const authTeam = safeStr(authPref?.teamLabel).trim();
  const authRole = safeStr(authPref?.roleLabel).trim();

  let source = "subscription";
  if (authPref && (authCallsign || authTeam || authRole)) {
    source = subCallsign || subTeam || subRole ? "mixed" : "authentik";
  }

  const callsign = authCallsign || subCallsign;
  const teamLabel = authTeam || subTeam;
  const roleLabel = authRole || subRole || "Team Member";

  return {
    callsign,
    teamLabel: prefPkgSvc.normalizeTeamLabel(teamLabel) || teamLabel,
    roleLabel: prefPkgSvc.normalizeRoleLabel(roleLabel),
    source,
  };
}

async function ensureMissionGroupChannelActive(clientId, authUser, missionGroupName) {
  const rawGroups = await fetchGroupsForUser(
    (await resolveSubscriptionForControl(clientId, authUser)).username
  );
  const collapsed = collapseGroupsForDisplay(rawGroups);
  const group = findCollapsedGroupForMission(collapsed, missionGroupName);
  if (!group) {
    const err = new Error(`Group "${missionGroupName}" is not assigned to this user.`);
    err.status = 404;
    throw err;
  }
  if (isMissionGroupChannelActive(group)) {
    return { changed: false, channelWasEnabled: true };
  }

  await setClientGroupActive(clientId, authUser, {
    groupName: group.name,
    accessMode: group.accessMode,
    active: true,
  });
  return { changed: true, channelWasEnabled: false };
}

async function getClientDataSyncMissions(clientId, authUser) {
  const ctx = await resolveSubscriptionForControl(clientId, authUser);
  assertRemoteActionsSubscription(ctx.subscription);

  const allowedKeySet = await dataSyncAccess.getAllowedCanonicalKeySet(authUser);
  const raw = await dataSyncSvc.listMissions({});
  const filtered = dataSyncAccess.filterMissionsPayload(raw, allowedKeySet);
  const missions = dataSyncAccess.enrichMissionListAssignmentMeta(unwrapMissionList(filtered));

  const userGroups = await fetchGroupsForUser(ctx.username);
  const userKeys = buildUserEntitledGroupKeySet(userGroups);

  const accessible = missions
    .map((mission) => {
      const groupName = dataSyncAccess.missionSingleGroupName(mission);
      const name = resolveMissionDisplayName(mission);
      if (!name || !groupName) return null;
      if (!userKeys.has(dataSyncAccess.canonicalGroupKey(groupName))) return null;
      return {
        name,
        groupName,
        assignedAgencyName: mission.assignedAgencyName || null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" }));

  return {
    configured: true,
    clientUid: ctx.clientUid,
    username: ctx.username,
    callsign: ctx.callsign,
    missions: accessible,
  };
}

async function sendClientDataSyncInvite(clientId, authUser, { missionName }) {
  const ctx = await resolveSubscriptionForControl(clientId, authUser);
  assertRemoteActionsSubscription(ctx.subscription);

  const name = safeStr(missionName).trim();
  if (!name) {
    const err = new Error("Mission name is required.");
    err.status = 400;
    throw err;
  }

  await dataSyncAccess.assertMissionReadable(authUser, name);
  const missionRaw = await dataSyncSvc.getMission(name);
  const mission = dataSyncAccess.unwrapMission(missionRaw);
  const groupName = dataSyncAccess.missionSingleGroupName(mission);
  if (!groupName) {
    const err = new Error("Mission does not have a single assigned group.");
    err.status = 400;
    throw err;
  }

  const userGroups = await fetchGroupsForUser(ctx.username);
  const userKeys = buildUserEntitledGroupKeySet(userGroups);
  if (!userKeys.has(dataSyncAccess.canonicalGroupKey(groupName))) {
    const err = new Error("This user does not have access to the selected Data Sync mission.");
    err.status = 403;
    throw err;
  }

  const channelState = await ensureMissionGroupChannelActive(clientId, authUser, groupName);
  if (!channelState.channelWasEnabled) {
    await sleep(DATA_SYNC_INVITE_CHANNEL_SETTLE_MS);
  }

  await dataSyncSvc.inviteMissionContact(name, ctx.clientUid);

  return {
    ok: true,
    missionName: name,
    groupName,
    clientUid: ctx.clientUid,
    username: ctx.username,
    callsign: ctx.callsign,
    channelWasEnabled: channelState.channelWasEnabled,
    channelEnabled: true,
  };
}

async function getClientPreferenceConfig(clientId, authUser) {
  const ctx = await resolveSubscriptionForControl(clientId, authUser);
  assertPreferenceConfigSubscription(ctx.subscription);
  const authPref = await lookupAuthentikPreferenceData(ctx.username);
  const prefills = mergePreferencePrefills(authPref, ctx.subscription);
  const settings = settingsSvc.getSettings() || {};

  return {
    configured: true,
    clientUid: ctx.clientUid,
    username: ctx.username,
    liveCallsign: ctx.callsign,
    callsign: prefills.callsign,
    teamLabel: prefills.teamLabel,
    roleLabel: prefills.roleLabel,
    source: prefills.source,
    teamOptions: prefPkgSvc.buildTeamSelectOptions(settings),
    roleOptions: prefPkgSvc.buildRoleSelectOptions(settings),
  };
}

async function sendClientPreferenceConfig(clientId, authUser, { callsign, teamLabel, roleLabel }) {
  const ctx = await resolveSubscriptionForControl(clientId, authUser);
  assertPreferenceConfigSubscription(ctx.subscription);
  const built = await prefPkgSvc.buildPreferencePackageZip({
    callsign,
    teamLabel,
    roleLabel,
  });

  const sent = await takMissionPkgSvc.sendMissionPackageToContact({
    clientUid: ctx.clientUid,
    buffer: built.buffer,
    filename: built.packageName,
    packageHash: built.hash,
  });

  takMissionPkgSvc.scheduleSentPackageCleanup({
    hash: sent.packageHash || built.hash,
    filename: built.packageName,
    label: built.packageName,
  });

  return {
    ok: true,
    clientUid: ctx.clientUid,
    username: ctx.username,
    callsign: built.callsign,
    teamLabel: built.teamLabel,
    roleLabel: built.roleLabel,
    packageName: built.packageName,
    packageHash: sent.packageHash || built.hash,
  };
}

module.exports = {
  fetchGroupsForUser,
  getClientGroupControlState,
  setClientGroupActive,
  getClientPreferenceConfig,
  sendClientPreferenceConfig,
  getClientDataSyncMissions,
  sendClientDataSyncInvite,
  collapseGroupsForDisplay,
  cleanGroupForTakPayload,
  normalizeGroupRow,
  findSubscriptionByClientId,
  isRemoteActionsSubscription,
  isPreferenceConfigSubscription,
  findCollapsedGroupForMission,
  isMissionGroupChannelActive,
  REMOTE_ACTIONS_TAK_CLIENTS,
  PREFERENCE_CONFIG_TAK_CLIENTS,
  DATA_SYNC_INVITE_CHANNEL_SETTLE_MS,
};
