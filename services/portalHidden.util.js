const { getString } = require("./env");

const ATTR_KEY = "tak_portal_hidden";
const MUTUAL_AID_GROUP_PREFIX = "ma -";

/**
 * Always-on hide prefixes (former settings.example defaults). Kept after
 * HIDDEN_PREFIX_ATTR_MIGRATION clears USERS_/GROUPS_HIDDEN_PREFIXES so
 * Authentik system/service accounts (e.g. ak-outpost-*) stay hidden even when
 * Authentik rejects or omits the tak_portal_hidden attribute on inbound sync.
 */
const BUILTIN_USER_HIDDEN_PREFIXES = ["ak-", "akadmin", "adm_", "nodered-", "ma-"];
const BUILTIN_GROUP_HIDDEN_PREFIXES = ["authentik", "ma -"];

function isTruthyHiddenAttr(value) {
  if (value === true) return true;
  const s = String(value == null ? "" : value)
    .trim()
    .toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

function markHiddenAttributes(attrs) {
  const next = attrs && typeof attrs === "object" ? { ...attrs } : {};
  next[ATTR_KEY] = "true";
  return next;
}

function parsePrefixList(raw) {
  return String(raw || "")
    .split(",")
    .map((p) => String(p || "").trim().toLowerCase())
    .filter(Boolean);
}

function normalizePrefixList(list) {
  return [
    ...new Set(
      (Array.isArray(list) ? list : [])
        .map((p) => String(p || "").trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
}

function hiddenUserPrefixes() {
  return normalizePrefixList([
    ...BUILTIN_USER_HIDDEN_PREFIXES,
    ...parsePrefixList(getString("USERS_HIDDEN_PREFIXES", "")),
  ]);
}

function hiddenGroupPrefixes({ includeMutualAid = false } = {}) {
  const prefixes = normalizePrefixList([
    ...BUILTIN_GROUP_HIDDEN_PREFIXES,
    ...parsePrefixList(getString("GROUPS_HIDDEN_PREFIXES", "")),
  ]);
  if (!includeMutualAid) return prefixes;
  return prefixes.filter((p) => p !== MUTUAL_AID_GROUP_PREFIX);
}

function usernameMatchesHiddenPrefix(username, prefixes) {
  const u = String(username || "")
    .trim()
    .toLowerCase();
  if (!u) return false;
  const list = Array.isArray(prefixes) ? prefixes : hiddenUserPrefixes();
  if (!list.length) return false;
  return list.some((p) => u.startsWith(p));
}

function groupNameWithoutTak(groupName) {
  const raw = String(groupName || "")
    .trim()
    .toLowerCase();
  return raw.startsWith("tak_") ? raw.slice(4) : raw;
}

function isMutualAidGroupName(groupName) {
  const withoutTak = groupNameWithoutTak(groupName);
  return withoutTak.startsWith(MUTUAL_AID_GROUP_PREFIX) || withoutTak.startsWith("ma-");
}

function groupNameMatchesHiddenPrefix(groupName, prefixes) {
  const raw = String(groupName || "")
    .trim()
    .toLowerCase();
  if (!raw) return false;
  const list = Array.isArray(prefixes) ? prefixes : hiddenGroupPrefixes();
  if (!list.length) return false;
  const withoutTak = groupNameWithoutTak(groupName);
  return list.some((p) => raw.startsWith(p) || withoutTak.startsWith(p));
}

/** Exact names from PORTAL_AUTH_REQUIRED_GROUP (global admin). */
function portalAuthRequiredGroupNames() {
  return [
    ...new Set(
      String(getString("PORTAL_AUTH_REQUIRED_GROUP", "") || "")
        .split(",")
        .map((s) => String(s || "").trim())
        .filter(Boolean)
    ),
  ];
}

function namesMatchIgnoreTak(a, b) {
  const left = groupNameWithoutTak(a);
  const right = groupNameWithoutTak(b);
  if (!left || !right) return false;
  return left === right || String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

/**
 * AgencyAdmin / authentik* / global-admin / PORTAL_AUTH_REQUIRED_GROUP names.
 * Used server-side so chips, /api/groups, and sync agree even when Authentik
 * never stores tak_portal_hidden on the group object.
 */
function isInternalPortalGroupName(groupName) {
  const raw = String(groupName || "")
    .trim()
    .toLowerCase();
  if (!raw) return false;
  const withoutTak = groupNameWithoutTak(groupName);
  if (withoutTak.startsWith("authentik")) return true;
  if (withoutTak.includes("agencyadmin")) return true;
  if (/global[\s_-]*admin/.test(raw) || /global[\s_-]*admin/.test(withoutTak)) return true;
  for (const configured of portalAuthRequiredGroupNames()) {
    if (namesMatchIgnoreTak(raw, configured) || namesMatchIgnoreTak(withoutTak, configured)) {
      return true;
    }
  }
  return false;
}

function attrsOf(entity) {
  if (!entity) return {};
  if (entity.attributes && typeof entity.attributes === "object") return entity.attributes;
  return {};
}

function entityHasHiddenAttr(entity) {
  if (!entity) return false;
  if (entity.tak_portal_hidden === true) return true;
  return isTruthyHiddenAttr(attrsOf(entity)[ATTR_KEY]);
}

/**
 * True when the user should be hidden from normal portal lists/counts.
 * Attribute/column wins; builtin + settings prefixes remain as dual-mode fallback
 * (builtins always apply after prefix settings are cleared by migration).
 */
function isUserHidden(user, { includeHidden = false } = {}) {
  if (includeHidden) return false;
  if (entityHasHiddenAttr(user)) return true;
  return usernameMatchesHiddenPrefix(user?.username);
}

/**
 * True when the group should be hidden from normal portal lists/counts.
 * When includeMutualAid is true, MA-named groups are visible even if attribute-hidden
 * (matches prior GROUPS_HIDDEN_PREFIXES "ma -" stripping behavior).
 */
function isGroupHidden(groupOrName, opts = {}) {
  const options = opts && typeof opts === "object" ? opts : {};
  if (options.includeHidden) return false;

  let name = groupOrName;
  let entity = null;
  if (groupOrName && typeof groupOrName === "object") {
    entity = groupOrName;
    name = groupOrName.name;
  }

  if (options.includeMutualAid && isMutualAidGroupName(name)) return false;

  if (entity && entityHasHiddenAttr(entity)) return true;
  if (!entity && options.attributes && isTruthyHiddenAttr(options.attributes[ATTR_KEY])) {
    return true;
  }

  if (isInternalPortalGroupName(name)) return true;

  return groupNameMatchesHiddenPrefix(
    name,
    hiddenGroupPrefixes({ includeMutualAid: !!options.includeMutualAid })
  );
}

module.exports = {
  ATTR_KEY,
  MUTUAL_AID_GROUP_PREFIX,
  BUILTIN_USER_HIDDEN_PREFIXES,
  BUILTIN_GROUP_HIDDEN_PREFIXES,
  isTruthyHiddenAttr,
  markHiddenAttributes,
  normalizePrefixList,
  hiddenUserPrefixes,
  hiddenGroupPrefixes,
  usernameMatchesHiddenPrefix,
  groupNameMatchesHiddenPrefix,
  isMutualAidGroupName,
  isInternalPortalGroupName,
  portalAuthRequiredGroupNames,
  entityHasHiddenAttr,
  isUserHidden,
  isGroupHidden,
};
