/**
 * Live session group control for connected TAK clients (Marti activeForce API).
 */
const { buildTakAxios, isTakBypassed, isTakConfigured } = require("./tak.service");
const {
  getSubscriptionsAll,
  isExcludedConnectedUserSubscription,
} = require("./takMetrics.service");
const accessSvc = require("./access.service");

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

function rowKey(name, direction) {
  return `${safeStr(name).trim().toLowerCase()}\0${normalizeDirection(direction)}`;
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
  const groups = await fetchGroupsForUser(ctx.username);
  groups.sort((a, b) => {
    const nameCmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    if (nameCmp !== 0) return nameCmp;
    return a.direction.localeCompare(b.direction);
  });

  return {
    configured: true,
    clientUid: ctx.clientUid,
    username: ctx.username,
    callsign: ctx.callsign,
    groups,
  };
}

async function setClientGroupActive(clientId, authUser, { groupName, direction, active }) {
  const ctx = await resolveSubscriptionForControl(clientId, authUser);
  const name = safeStr(groupName).trim();
  const dir = normalizeDirection(direction);
  if (!name || !dir) {
    const err = new Error("groupName and direction (IN or OUT) are required.");
    err.status = 400;
    throw err;
  }
  if (typeof active !== "boolean") {
    const err = new Error("active must be a boolean.");
    err.status = 400;
    throw err;
  }

  const current = await fetchGroupsForUser(ctx.username);
  const key = rowKey(name, dir);
  let found = false;
  const next = current.map((row) => {
    if (rowKey(row.name, row.direction) !== key) return row;
    found = true;
    return { ...row, active };
  });

  if (!found) {
    const err = new Error("Group not found for this user.");
    err.status = 404;
    throw err;
  }

  const groups = await putActiveForceGroups(ctx.username, next);
  return {
    configured: true,
    clientUid: ctx.clientUid,
    username: ctx.username,
    callsign: ctx.callsign,
    groups,
    changed: { groupName: name, direction: dir, active },
  };
}

module.exports = {
  fetchGroupsForUser,
  getClientGroupControlState,
  setClientGroupActive,
  cleanGroupForTakPayload,
  normalizeGroupRow,
  findSubscriptionByClientId,
};
