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

function isAtakCivSubscription(subscription) {
  return resolveSubscriptionTakClient(subscription).toUpperCase() === "ATAK-CIV";
}

function assertAtakCivSubscription(subscription) {
  if (!isAtakCivSubscription(subscription)) {
    const err = new Error("Send Configuration is only available for ATAK-CIV clients.");
    err.status = 403;
    throw err;
  }
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

async function getClientPreferenceConfig(clientId, authUser) {
  const ctx = await resolveSubscriptionForControl(clientId, authUser);
  assertAtakCivSubscription(ctx.subscription);
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
  assertAtakCivSubscription(ctx.subscription);
  const built = await prefPkgSvc.buildPreferencePackageZip({
    callsign,
    teamLabel,
    roleLabel,
  });

  await takMissionPkgSvc.sendMissionPackageToContact({
    clientUid: ctx.clientUid,
    buffer: built.buffer,
    filename: built.packageName,
    packageHash: built.hash,
  });

  takMissionPkgSvc.scheduleSentPackageCleanup({
    hash: built.hash,
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
    packageHash: built.hash,
  };
}

module.exports = {
  fetchGroupsForUser,
  getClientGroupControlState,
  setClientGroupActive,
  getClientPreferenceConfig,
  sendClientPreferenceConfig,
  collapseGroupsForDisplay,
  cleanGroupForTakPayload,
  normalizeGroupRow,
  findSubscriptionByClientId,
};
