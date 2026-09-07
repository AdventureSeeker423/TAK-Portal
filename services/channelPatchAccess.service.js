/**
 * Agency-scoped access for channel patches.
 *
 * Agency admins may create/edit patches using the same groups they can manage
 * on the Groups page (agency-owned + allowedAdminGroupIds). A patch is visible
 * only when every channel in it is in that allowlist; mixed/out-of-scope
 * patches are hidden entirely.
 */

const accessSvc = require("./access.service");
const groupsSvc = require("./groups.service");
const mapMeta = require("./mapMeta.service");
const mutualAidStore = require("./mutualAid.store");
const { getString } = require("./env");

const MUTUAL_AID_GROUP_PREFIX = "ma -";

function isAuthentikAgencyAdminGroupName(name) {
  return /-AgencyAdmin$/i.test(String(name || "").trim());
}

function getHiddenGroupPrefixes({ includeMutualAid = false } = {}) {
  const prefixes = String(getString("GROUPS_HIDDEN_PREFIXES", "") || "")
    .split(",")
    .map((p) => String(p || "").trim().toLowerCase())
    .filter(Boolean);
  if (!includeMutualAid) return prefixes;
  return prefixes.filter((p) => p !== MUTUAL_AID_GROUP_PREFIX);
}

function isHiddenGroupName(name, { includeMutualAid = false } = {}) {
  const raw = String(name || "").trim().toLowerCase();
  if (!raw) return true;
  const withoutTak = raw.startsWith("tak_") ? raw.slice(4) : raw;
  if (withoutTak.startsWith("_")) return true;
  const hiddenPrefixes = getHiddenGroupPrefixes({ includeMutualAid });
  return hiddenPrefixes.some(
    (prefix) => raw.startsWith(prefix) || withoutTak.startsWith(prefix)
  );
}

/**
 * Add MA-workflow-created channels to a picker list (global admins only).
 * Existing/reused MA groups are already visible as normal channels.
 * @param {Array<{ name: string, displayName: string, baseKey: string, count?: number }>} channels
 * @param {string[]|null} [groupNames] - defaults to created groups from the MA store
 */
function mergeCreatedMutualAidPickerChannels(channels, groupNames) {
  const list = Array.isArray(channels) ? channels : [];
  const names = Array.isArray(groupNames)
    ? groupNames
    : mutualAidStore.getCreatedGroupNames();
  const seen = new Set();
  for (const c of list) {
    if (c?.baseKey) seen.add(c.baseKey);
  }
  for (const rawName of names) {
    const displayName = groupsSvc.stripTakPrefix(rawName);
    const name = groupsSvc.ensureTakPrefix(displayName || rawName);
    if (!name || isAuthentikAgencyAdminGroupName(name)) continue;
    const baseKey = mapMeta.channelBaseKey(name);
    if (!baseKey || baseKey === mapMeta.UNASSIGNED_CHANNEL_KEY || seen.has(baseKey)) {
      continue;
    }
    seen.add(baseKey);
    list.push({
      name,
      displayName: displayName || name,
      baseKey,
      count: 0,
    });
  }
  return list;
}

function patchGroupKeys(patch) {
  const keys = new Set();
  for (const name of patch?.groups || []) {
    const k = mapMeta.channelBaseKey(name);
    if (k && k !== mapMeta.UNASSIGNED_CHANNEL_KEY) keys.add(k);
  }
  return keys;
}

function toAllowSet(allowedKeys) {
  if (allowedKeys instanceof Set) return allowedKeys;
  return new Set(Array.isArray(allowedKeys) ? allowedKeys.filter(Boolean) : []);
}

function patchFullyInScope(patch, allow) {
  const keys = patchGroupKeys(patch);
  if (!keys.size) return false;
  for (const k of keys) {
    if (!allow.has(k)) return false;
  }
  return true;
}

/**
 * Global admins see every patch. Agency admins see a patch only when every
 * group in it is in their allowlist.
 */
function filterPatchesForAccess(access, patches, allowedKeys) {
  const list = Array.isArray(patches) ? patches : [];
  if (access?.isGlobalAdmin) return list;
  const allow = toAllowSet(allowedKeys);
  if (!allow.size) return [];
  return list.filter((p) => patchFullyInScope(p, allow));
}

function assertGroupsInScope(access, groups, allowedKeys) {
  if (access?.isGlobalAdmin) return;
  const allow = toAllowSet(allowedKeys);
  const names = Array.isArray(groups) ? groups : [];
  for (const n of names) {
    const k = mapMeta.channelBaseKey(n);
    if (!k || k === mapMeta.UNASSIGNED_CHANNEL_KEY || !allow.has(k)) {
      const err = new Error(`Group not in your agency scope: ${n}`);
      err.status = 403;
      throw err;
    }
  }
}

function toPickerChannel(entry) {
  return {
    name: entry.name,
    displayName: entry.displayName || entry.name,
    baseKey: entry.baseKey,
    count: entry.count || 0,
  };
}

/**
 * Authentik groups this user may patch (Groups-page access).
 * @returns {Array<{ name: string, displayName: string, baseKey: string }>}
 */
async function listAgencyScopedGroups(authUser) {
  const access = accessSvc.getAgencyAccess(authUser);
  if (access.isGlobalAdmin) return [];

  let authentikGroups = [];
  try {
    authentikGroups = await groupsSvc.getGroupsForAuthUser(authUser);
  } catch (_) {
    return [];
  }

  const visible = accessSvc.filterGroupsForUser(authUser, authentikGroups);
  const out = [];
  const seen = new Set();

  for (const g of visible) {
    const name = String(g?.name || "").trim();
    if (!name || isAuthentikAgencyAdminGroupName(name) || isHiddenGroupName(name)) {
      continue;
    }
    const baseKey = mapMeta.channelBaseKey(name);
    if (!baseKey || baseKey === mapMeta.UNASSIGNED_CHANNEL_KEY || seen.has(baseKey)) {
      continue;
    }
    seen.add(baseKey);
    const displayName = groupsSvc.stripTakPrefix(name);
    out.push({
      name: groupsSvc.ensureTakPrefix(displayName || name),
      displayName: displayName || name,
      baseKey,
    });
  }

  return out;
}

/**
 * @returns {Promise<Set<string>|null>} null = unrestricted (global admin)
 */
async function resolveAllowedChannelKeySet(authUser) {
  const access = accessSvc.getAgencyAccess(authUser);
  if (access.isGlobalAdmin) return null;
  const groups = await listAgencyScopedGroups(authUser);
  return new Set(groups.map((g) => g.baseKey));
}

/**
 * Channel picker + allowlist for the Channel Patch page/API.
 * Global admins: live map catalog plus mutual-aid-created groups.
 * Agency admins: Groups-page access, enriched with catalog display names /
 * live counts when present (MA-created groups stay hidden).
 */
async function buildScopedChannelPicker(authUser, catalogGroups) {
  const access = accessSvc.getAgencyAccess(authUser);
  const catalogByKey = new Map();
  for (const g of Array.isArray(catalogGroups) ? catalogGroups : []) {
    if (!g?.baseKey || g.baseKey === mapMeta.UNASSIGNED_CHANNEL_KEY) continue;
    catalogByKey.set(g.baseKey, g);
  }

  if (access.isGlobalAdmin) {
    return {
      access,
      channels: mergeCreatedMutualAidPickerChannels(
        [...catalogByKey.values()].map(toPickerChannel)
      ),
      channelScope: "all",
      allowedChannelKeys: null,
    };
  }

  const scoped = await listAgencyScopedGroups(authUser);
  const channels = scoped.map((g) => {
    const cat = catalogByKey.get(g.baseKey);
    return toPickerChannel({
      name: cat?.name || g.name,
      displayName: cat?.displayName || g.displayName,
      baseKey: g.baseKey,
      count: cat?.count || 0,
    });
  });

  return {
    access,
    channels,
    channelScope: "agency",
    allowedChannelKeys: channels.map((c) => c.baseKey),
  };
}

function allowedKeySetFromPicker(scoped) {
  if (!scoped || scoped.allowedChannelKeys == null) return null;
  return new Set(
    (Array.isArray(scoped.allowedChannelKeys) ? scoped.allowedChannelKeys : []).filter(
      Boolean
    )
  );
}

module.exports = {
  patchGroupKeys,
  patchFullyInScope,
  filterPatchesForAccess,
  assertGroupsInScope,
  listAgencyScopedGroups,
  resolveAllowedChannelKeySet,
  buildScopedChannelPicker,
  allowedKeySetFromPicker,
  isHiddenGroupName,
  mergeCreatedMutualAidPickerChannels,
};
