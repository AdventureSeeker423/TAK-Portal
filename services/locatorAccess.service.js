/**
 * Agency-scoped access for live locators.
 * Channels use Groups-page allowlist (Channel Patch). Missions use Data Sync scope
 * and must belong to the selected channel.
 */

const accessSvc = require("./access.service");
const groupsSvc = require("./groups.service");
const mapMeta = require("./mapMeta.service");
const dataSyncSvc = require("./dataSync.service");
const dataSyncAccess = require("./dataSyncAccess.service");
const locatorsSvc = require("./locators.service");

function unwrapPagedMissions(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

function missionGroupKeys(mission) {
  const m = dataSyncAccess.unwrapMission ? dataSyncAccess.unwrapMission(mission) : mission;
  const groups = m && Array.isArray(m.groups) ? m.groups : [];
  const keys = new Set();
  for (const g of groups) {
    const name =
      typeof g === "string"
        ? g
        : g && (g.name || g.groupName || g.group || g.title || g.cn);
    const k = mapMeta.channelBaseKey(name);
    if (k && k !== mapMeta.UNASSIGNED_CHANNEL_KEY) keys.add(k);
  }
  return keys;
}

function channelKeyOf(name) {
  return mapMeta.channelBaseKey(name);
}

function locatorInScope(locator, allowedKeys) {
  if (!locator || !locatorsSvc.isLiveLocator(locator)) return false;
  if (allowedKeys == null) return true;
  const key = channelKeyOf(locator.channel || locator.channelDisplay);
  if (!key || key === mapMeta.UNASSIGNED_CHANNEL_KEY) return false;
  return allowedKeys.has(key);
}

function filterLocatorsForAccess(access, locators, allowedKeys) {
  const list = Array.isArray(locators) ? locators : [];
  const live = list.filter((l) => locatorsSvc.isLiveLocator(l));
  if (access?.isGlobalAdmin) return live;
  return live.filter((l) => locatorInScope(l, allowedKeys));
}

function assertChannelInScope(access, channel, allowedKeys) {
  if (access?.isGlobalAdmin) return;
  const key = channelKeyOf(channel);
  if (!key || key === mapMeta.UNASSIGNED_CHANNEL_KEY || !allowedKeys || !allowedKeys.has(key)) {
    const err = new Error("Channel not in your agency scope.");
    err.status = 403;
    throw err;
  }
}

function assertLocatorAccessible(access, locator, allowedKeys) {
  if (!locator || !locatorsSvc.isLiveLocator(locator)) {
    const err = new Error("Locator not found.");
    err.status = 404;
    throw err;
  }
  if (access?.isGlobalAdmin) return locator;
  if (!locatorInScope(locator, allowedKeys)) {
    const err = new Error("Locator not found.");
    err.status = 404;
    throw err;
  }
  return locator;
}

async function listChannelsForUser(authUser) {
  const access = accessSvc.getAgencyAccess(authUser);
  let all = [];
  try {
    all = await groupsSvc.getGroupsForAuthUser(authUser);
  } catch (_) {
    return {
      access,
      channels: [],
      allowedChannelKeys: access.isGlobalAdmin ? null : new Set(),
    };
  }
  const filtered = accessSvc.filterGroupsForUser(authUser, all);
  const channels = [];
  const seen = new Set();
  for (const g of filtered) {
    const name = String(g?.name || "").trim();
    if (!name || /-AgencyAdmin$/i.test(name)) continue;
    const displayName = groupsSvc.stripTakPrefix(name);
    const baseKey = mapMeta.channelBaseKey(name);
    if (!baseKey || baseKey === mapMeta.UNASSIGNED_CHANNEL_KEY || seen.has(baseKey)) continue;
    seen.add(baseKey);
    channels.push({
      name,
      displayName: displayName || name,
      baseKey,
    });
  }
  channels.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return {
    access,
    channels,
    allowedChannelKeys: access.isGlobalAdmin ? null : new Set(channels.map((c) => c.baseKey)),
  };
}

async function listMissionsForChannel(authUser, channelName) {
  const channelKey = channelKeyOf(channelName);
  if (!channelKey || channelKey === mapMeta.UNASSIGNED_CHANNEL_KEY) return [];

  let raw;
  try {
    raw = await dataSyncSvc.listMissions({});
  } catch (err) {
    const code = err?.code;
    if (code === "TAK_NOT_CONFIGURED" || code === "TAK_BYPASS") return [];
    throw err;
  }

  const allowedKeySet = await dataSyncAccess.getAllowedCanonicalKeySet(authUser);
  const list = unwrapPagedMissions(raw);
  const scoped = dataSyncAccess.filterMissionsForAccess(list, allowedKeySet);
  const missions = [];
  const seen = new Set();
  for (const m of scoped) {
    const name = String(m?.name || "").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    const keys = missionGroupKeys(m);
    if (!keys.has(channelKey)) continue;
    seen.add(name.toLowerCase());
    missions.push({ name });
  }
  missions.sort((a, b) => a.name.localeCompare(b.name));
  return missions;
}

async function assertMissionOnChannel(authUser, missionName, channelName) {
  const name = String(missionName || "").trim();
  if (!name) return "";
  await dataSyncAccess.assertMissionReadable(authUser, name);
  const raw = await dataSyncSvc.getMission(name);
  const keys = missionGroupKeys(raw);
  const channelKey = channelKeyOf(channelName);
  if (!channelKey || !keys.has(channelKey)) {
    const err = new Error("Data Sync is not on the selected channel.");
    err.status = 400;
    throw err;
  }
  return name;
}

function agencyScopeForCreate(authUser) {
  const access = accessSvc.getAgencyAccess(authUser);
  if (access.isGlobalAdmin) return null;
  return Array.isArray(access.allowedAgencySuffixes)
    ? access.allowedAgencySuffixes.slice()
    : [];
}

module.exports = {
  channelKeyOf,
  locatorInScope,
  filterLocatorsForAccess,
  assertChannelInScope,
  assertLocatorAccessible,
  listChannelsForUser,
  listMissionsForChannel,
  assertMissionOnChannel,
  agencyScopeForCreate,
  missionGroupKeys,
};
