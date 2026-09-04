const pgCache = require("./pgCache");

const FILE = null;

function load() {
  return Array.isArray(pgCache.caches.mutualAid) ? pgCache.caches.mutualAid : [];
}

function save(items) {
  pgCache.replaceMutualAid(Array.isArray(items) ? items : []);
}

/** Mutual aid records whose Authentik group was created by the MA workflow (not linked existing groups). */
function listCreatedGroupItems() {
  return load().filter((item) => {
    const mode = String(item?.groupMode || "new").trim().toLowerCase();
    return item?.groupWasCreated === true || mode !== "existing";
  });
}

function getCreatedGroupIdSet() {
  const ids = new Set();
  for (const item of listCreatedGroupItems()) {
    const gid = String(item?.groupId || "").trim();
    if (gid) ids.add(gid);
  }
  return ids;
}

/** All Authentik group IDs referenced by active mutual aid records (created or linked). */
function getMutualAidGroupIdSet() {
  const ids = new Set();
  for (const item of load()) {
    const gid = String(item?.groupId || "").trim();
    if (gid) ids.add(gid);
  }
  return ids;
}

function getCreatedGroupNameSet() {
  const names = new Set();
  for (const item of listCreatedGroupItems()) {
    const name = String(item?.groupName || "").trim().toLowerCase();
    if (name) names.add(name);
  }
  return names;
}

function getCreatedGroupNames() {
  const names = [];
  const seen = new Set();
  for (const item of listCreatedGroupItems()) {
    const name = String(item?.groupName || "").trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function isCreatedGroupName(groupName) {
  const key = String(groupName || "").trim().toLowerCase();
  return key ? getCreatedGroupNameSet().has(key) : false;
}

function stripCreatedGroupNames(groupNames) {
  const blocked = getCreatedGroupNameSet();
  return (Array.isArray(groupNames) ? groupNames : [])
    .map((g) => String(g || "").trim())
    .filter(Boolean)
    .filter((g) => !blocked.has(g.toLowerCase()));
}

module.exports = {
  FILE,
  load,
  save,
  listCreatedGroupItems,
  getCreatedGroupIdSet,
  getMutualAidGroupIdSet,
  getCreatedGroupNameSet,
  getCreatedGroupNames,
  isCreatedGroupName,
  stripCreatedGroupNames,
};
