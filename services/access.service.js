// services/access.service.js
// Centralized helper for per-agency access rules.
//
// Agency admin rights are derived from Authentik group membership.
// For each agency we compute the expected admin group name:
//   authentik-<AGENCY_ABBREVIATION>-AgencyAdmin
//
// NOTE: For backwards compatibility, we *also* support the legacy
// `adminGroups` field that may still exist in agencies.json.
// Global admins still come from PORTAL_AUTH_REQUIRED_GROUP via portalAuth.middleware.

const agenciesStore = require("./agencies.service");
const { getBool, getString } = require("./env");

/**
 * Set to true/1/yes/on (env or Settings key) to log when a user's agency suffix
 * is inferred from username tail after attributes did not yield a match.
 */
const LOG_FALLBACK_ENV = "PORTAL_USER_ACCESS_LOG_FALLBACK";
/**
 * Set to true on GET /api/users/:id to log when resolveAgencySuffixFromUser(user)
 * disagrees with inferAgencySuffixFromUsername(user.username) (rollout diagnostics).
 */
const SHADOW_ENV = "PORTAL_USER_ACCESS_SHADOW_COMPARE";

function normalizeSuffix(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeGroupList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[;,]/)
    .map((g) => String(g || "").trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Infer agency suffix from a username by selecting the longest known
 * agency suffix that matches the username tail.
 *
 * This prevents overlap bugs such as:
 * - allowed: "ppd"
 * - username: "...uppd"
 * where a plain endsWith("ppd") would incorrectly match.
 */
function inferAgencySuffixFromUsernameTail(username) {
  const un = String(username || "").trim().toLowerCase();
  if (!un) return "";

  const agencies = agenciesStore.load();
  let bestSuffix = "";

  for (const agency of agencies) {
    const sfx = normalizeSuffix(agency && agency.suffix);
    if (!sfx) continue;
    if (!un.endsWith(sfx)) continue;
    if (!bestSuffix || sfx.length > bestSuffix.length) {
      bestSuffix = sfx;
    }
  }

  return bestSuffix;
}

/**
 * Infer agency suffix from a username when the suffix is a prefix (badge-after-suffix
 * agencies). Longest known suffix wins (same rule as tail matching).
 */
function inferAgencySuffixFromUsernamePrefix(username) {
  const un = String(username || "").trim().toLowerCase();
  if (!un) return "";

  const agencies = agenciesStore.load();
  let bestSuffix = "";

  for (const agency of agencies) {
    const sfx = normalizeSuffix(agency && agency.suffix);
    if (!sfx) continue;
    if (!un.startsWith(sfx)) continue;
    if (!bestSuffix || sfx.length > bestSuffix.length) {
      bestSuffix = sfx;
    }
  }

  return bestSuffix;
}

/**
 * Infer agency suffix from username tail, then prefix (never both on one account).
 * Tail match is preferred when both would match (legacy default).
 */
function inferAgencySuffixFromUsername(username) {
  const fromTail = inferAgencySuffixFromUsernameTail(username);
  if (fromTail) return fromTail;
  return inferAgencySuffixFromUsernamePrefix(username);
}

/**
 * True when the agency suffix token appears at the start or end of a username.
 */
function usernameHasAgencySuffixToken(username, suffix) {
  const u = String(username || "").trim().toLowerCase();
  const sfx = normalizeSuffix(suffix);
  if (!u || !sfx) return false;
  return u.endsWith(sfx) || u.startsWith(sfx);
}

const USERNAME_TOKEN_PLACEMENT_SUFFIX = "suffix";
const USERNAME_TOKEN_PLACEMENT_PREFIX = "prefix";

/**
 * Normalize agency username token placement (badge before or after the agency token).
 * Default: suffix (badge + token, e.g. 1234hs).
 */
function normalizeUsernameTokenPlacement(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (
    v === USERNAME_TOKEN_PLACEMENT_PREFIX ||
    v === "start" ||
    v === "before" ||
    v === "leading"
  ) {
    return USERNAME_TOKEN_PLACEMENT_PREFIX;
  }
  return USERNAME_TOKEN_PLACEMENT_SUFFIX;
}

function getAgencyUsernameTokenPlacement(agency) {
  if (!agency || typeof agency !== "object") return USERNAME_TOKEN_PLACEMENT_SUFFIX;
  return normalizeUsernameTokenPlacement(
    agency.usernameTokenPlacement ?? agency.usernameSuffixPlacement
  );
}

/**
 * Build a portal username from badge + agency token using the agency's configured placement.
 */
function buildUsernameWithAgencyToken(badge, agencyOrSuffix, placement) {
  const badgeNorm = String(badge || "").trim();
  const agency =
    agencyOrSuffix && typeof agencyOrSuffix === "object" ? agencyOrSuffix : null;
  const sfx = agency
    ? normalizeSuffix(agency.suffix)
    : normalizeSuffix(agencyOrSuffix);
  if (!badgeNorm || !sfx) return "";

  const loc =
    placement != null
      ? normalizeUsernameTokenPlacement(placement)
      : agency
        ? getAgencyUsernameTokenPlacement(agency)
        : USERNAME_TOKEN_PLACEMENT_SUFFIX;

  return loc === USERNAME_TOKEN_PLACEMENT_PREFIX
    ? `${sfx}${badgeNorm}`
    : `${badgeNorm}${sfx}`;
}

/**
 * Remove the agency token from a username (tail or prefix). When placement is unknown,
 * tail is tried first, then prefix (same order as inferAgencySuffixFromUsername).
 */
function stripAgencyTokenFromUsername(username, agencySuffix, placement) {
  const user = String(username || "").trim();
  if (!user) return "";

  let sfx = normalizeSuffix(agencySuffix);
  const loc =
    placement != null ? normalizeUsernameTokenPlacement(placement) : null;

  if (!sfx) {
    sfx = inferAgencySuffixFromUsername(user);
    if (!sfx) return user;
  }

  const lower = user.toLowerCase();
  const sfxLower = sfx.toLowerCase();

  if (loc === USERNAME_TOKEN_PLACEMENT_PREFIX) {
    return lower.startsWith(sfxLower) ? user.slice(sfx.length) : user;
  }
  if (loc === USERNAME_TOKEN_PLACEMENT_SUFFIX) {
    return lower.endsWith(sfxLower) ? user.slice(0, user.length - sfx.length) : user;
  }

  if (lower.endsWith(sfxLower)) return user.slice(0, user.length - sfx.length);
  if (lower.startsWith(sfxLower)) return user.slice(sfx.length);
  return user;
}

/**
 * Normalize badge input: strip a leading/trailing agency token when the user pasted a full username.
 */
function stripAgencyTokenFromBadge(badgeNumber, agencySuffix, placementOrAgency) {
  const badge = String(badgeNumber || "").trim();
  const sfx = normalizeSuffix(agencySuffix);
  if (!badge || !sfx || sfx === "__other__") return badge;

  let placement = null;
  let agency = null;
  if (
    placementOrAgency &&
    typeof placementOrAgency === "object" &&
    !Array.isArray(placementOrAgency)
  ) {
    if (
      "suffix" in placementOrAgency ||
      "usernameTokenPlacement" in placementOrAgency ||
      "usernameSuffixPlacement" in placementOrAgency
    ) {
      agency = placementOrAgency;
    } else {
      placement = placementOrAgency;
    }
  } else if (placementOrAgency != null) {
    placement = placementOrAgency;
  }

  const loc =
    placement != null
      ? normalizeUsernameTokenPlacement(placement)
      : agency
        ? getAgencyUsernameTokenPlacement(agency)
        : null;

  const lower = badge.toLowerCase();
  const sfxLower = sfx.toLowerCase();

  if (loc === USERNAME_TOKEN_PLACEMENT_PREFIX) {
    if (lower.startsWith(sfxLower)) {
      const trimmed = badge.slice(sfx.length);
      if (trimmed) return trimmed;
    }
    return badge;
  }
  if (loc === USERNAME_TOKEN_PLACEMENT_SUFFIX) {
    if (lower.endsWith(sfxLower)) {
      const trimmed = badge.slice(0, badge.length - sfx.length);
      if (trimmed) return trimmed;
    }
    return badge;
  }

  if (lower.endsWith(sfxLower)) {
    const trimmed = badge.slice(0, badge.length - sfx.length);
    if (trimmed) return trimmed;
  }
  if (lower.startsWith(sfxLower)) {
    const trimmed = badge.slice(sfx.length);
    if (trimmed) return trimmed;
  }
  return badge;
}

/**
 * Resolve the portal agency suffix for a user from Authentik attributes, then username.
 * Order: attributes.agency (validated) ? agency_name ? agency_abbreviation ? username tail/prefix.
 *
 * @param {object|null|undefined} user - Authentik user shape ({ username, attributes })
 * @returns {string} normalized suffix or ""
 */
function resolveAgencySuffixFromUser(user) {
  const agencies = agenciesStore.load();
  const suffixSet = new Set(
    agencies.map((a) => normalizeSuffix(a && a.suffix)).filter(Boolean)
  );

  const attrs =
    user && typeof user === "object" && user.attributes && typeof user.attributes === "object"
      ? user.attributes
      : {};

  const fromAgencyAttr = normalizeSuffix(attrs.agency);
  if (fromAgencyAttr && suffixSet.has(fromAgencyAttr)) {
    return fromAgencyAttr;
  }

  const nameVal = String(attrs.agency_name || "").trim();
  if (nameVal) {
    const lower = nameVal.toLowerCase();
    for (const a of agencies) {
      if (String(a.name || "").trim().toLowerCase() === lower) {
        return normalizeSuffix(a.suffix);
      }
    }
  }

  const abbr = String(
    attrs.agency_abbreviation ||
      attrs.agencyAbbreviation ||
      attrs.agencyAbbr ||
      attrs.agencyabbr ||
      ""
  )
    .trim()
    .toLowerCase();
  if (abbr) {
    for (const a of agencies) {
      if (String(a.groupPrefix || "").trim().toLowerCase() === abbr) {
        return normalizeSuffix(a.suffix);
      }
    }
  }

  const username = user && typeof user === "object" ? user.username : "";
  const inferred = inferAgencySuffixFromUsername(username);

  if (inferred && getBool(LOG_FALLBACK_ENV, false)) {
    console.warn(
      "[ACCESS] resolveAgencySuffixFromUser: username-tail fallback",
      { username: String(username || "").trim() || null, inferred }
    );
  }

  return inferred;
}

function getAgencyAdminGroupName(agency) {
  const abbr = agenciesStore.normalizeGroupPrefix(
    agency?.groupPrefix || agency?.suffix || ""
  );
  const countyAbbrev = String(agency?.countyAbbrev || "").trim().toUpperCase();
  if (!abbr) return null;
  if (countyAbbrev) {
    return `authentik-${countyAbbrev}-${abbr}-AgencyAdmin`;
  }
  // Legacy pattern (no county abbreviation stored yet)
  return `authentik-${abbr}-AgencyAdmin`;
}

function getAllAgencyAdminGroupNames(agency) {
  const names = [];
  const abbr = agenciesStore.normalizeGroupPrefix(
    agency?.groupPrefix || agency?.suffix || ""
  );
  const countyAbbrev = String(agency?.countyAbbrev || "").trim().toUpperCase();
  if (!abbr) return names;
  if (countyAbbrev) {
    names.push(`authentik-${countyAbbrev}-${abbr}-AgencyAdmin`);
  }
  // Always include legacy pattern as a fallback for backwards compatibility
  names.push(`authentik-${abbr}-AgencyAdmin`);
  return names;
}

function getAgencyAdminGroupNamesForAgency(agency) {
  const names = new Set();
  for (const name of getAllAgencyAdminGroupNames(agency)) {
    if (name) names.add(name);
  }
  const rawAdmin =
    agency?.adminGroups != null ? agency.adminGroups : agency?.adminGroup;
  for (const name of normalizeGroupList(rawAdmin)) {
    if (name) names.add(name);
  }
  return Array.from(names);
}

/**
 * Compute all agency suffixes the given user-groups are admin for.
 * This uses only the `adminGroups` field attached to agencies.json.
 *
 * @param {string[]|null|undefined} userGroups - array of group names
 * @returns {string[]} unique, normalized agency suffixes
 */
function getAllowedAgencySuffixesForGroups(userGroups) {
  const groupsLower = Array.isArray(userGroups)
    ? userGroups.map((g) => String(g || "").trim().toLowerCase()).filter(Boolean)
    : [];

  if (!groupsLower.length) return [];

  const agencies = agenciesStore.load();
  const allowed = new Set();

  for (const agency of agencies) {
    // Legacy (manual) admin groups stored in agencies.json
    const rawAdmin =
      agency.adminGroups != null ? agency.adminGroups : agency.adminGroup;
    const legacyAdminList = normalizeGroupList(rawAdmin);

    // New (computed) admin group name(s)  support both legacy and county-abbrev patterns
    const computedNames = getAllAgencyAdminGroupNames(agency).map((n) =>
      n.toLowerCase()
    );

    const neededGroups = [];
    if (computedNames.length) neededGroups.push(...computedNames);
    if (legacyAdminList.length) neededGroups.push(...legacyAdminList);

    if (!neededGroups.length) continue;

    const hasAny = neededGroups.some((needed) => groupsLower.includes(needed));
    if (!hasAny) continue;

    const sfx = normalizeSuffix(agency.suffix);
    if (sfx) {
      allowed.add(sfx);
    }
  }

  return Array.from(allowed);
}

/**
 * Whether any agency declares agency-admin groups at all.
 */
function hasAnyAgencyAdminsConfigured() {
  const agencies = agenciesStore.load();
  return agencies.some((agency) => {
    const computed = getAgencyAdminGroupName(agency);
    if (computed) return true;

    // Legacy support
    const rawAdmin =
      agency.adminGroups != null ? agency.adminGroups : agency.adminGroup;
    const list = normalizeGroupList(rawAdmin);
    return list.length > 0;
  });
}

/**
 * Return a unified view of the current user's access.
 *
 * - Global admins (from portalAuth) can see all agencies.
 * - Agency admins can see only agencies whose suffix they are admin for.
 *
 * @param {object|null} authUser - req.authentikUser
 * @returns {{ isGlobalAdmin: boolean, isAgencyAdmin: boolean, allowedAgencySuffixes: string[]|null }}
 */
function getAgencyAccess(authUser) {
  const isGlobalAdmin = !!(authUser && authUser.isGlobalAdmin);

  if (isGlobalAdmin) {
    return {
      isGlobalAdmin: true,
      isAgencyAdmin: false,
      // null means "all agencies"
      allowedAgencySuffixes: null,
    };
  }

  const groups =
    authUser && Array.isArray(authUser.groups) ? authUser.groups : [];
  const allowedAgencySuffixes = getAllowedAgencySuffixesForGroups(groups);

  return {
    isGlobalAdmin: false,
    isAgencyAdmin: allowedAgencySuffixes.length > 0,
    allowedAgencySuffixes,
  };
}

/**
 * Agency suffixes the user manages via agency-admin group membership,
 * regardless of global-admin status (used for MOU signing scope).
 */
function getUserManagedAgencySuffixes(authUser) {
  if (!authUser) return [];
  if (Array.isArray(authUser.allowedAgencySuffixes)) {
    return authUser.allowedAgencySuffixes.map(normalizeSuffix).filter(Boolean);
  }
  const groups = Array.isArray(authUser.groups) ? authUser.groups : [];
  return getAllowedAgencySuffixesForGroups(groups);
}

/**
 * Filter a list of agencies down to those visible for the current user.
 */
function filterAgenciesForUser(authUser, agencies) {
  const access = getAgencyAccess(authUser);
  const list = Array.isArray(agencies) ? agencies : [];

  if (access.isGlobalAdmin) {
    return list;
  }

  const allowed = access.allowedAgencySuffixes || [];
  if (!allowed.length) return [];

  const allowedSet = new Set(allowed.map(normalizeSuffix));
  return list.filter((a) => allowedSet.has(normalizeSuffix(a.suffix)));
}

/**
 * Does the user have access to a given agency suffix?
 */
function isSuffixAllowed(authUser, suffix) {
  const access = getAgencyAccess(authUser);
  if (access.isGlobalAdmin) return true;
  const sfx = normalizeSuffix(suffix);
  if (!sfx) return false;
  const allowed = access.allowedAgencySuffixes || [];
  return allowed.map(normalizeSuffix).includes(sfx);
}

/**
 * Whether the Authentik user object is in an agency the viewer may manage
 * (attributes first, then username tail).
 *
 * @param {object|null} authUser - req.authentikUser
 * @param {object|null|undefined} targetUser - Authentik user ({ username, attributes })
 */
function isUserInAllowedAgencies(authUser, targetUser) {
  const access = getAgencyAccess(authUser);
  if (access.isGlobalAdmin) return true;

  const allowed = access.allowedAgencySuffixes || [];
  if (!allowed.length) return false;

  const suffix = resolveAgencySuffixFromUser(targetUser);
  if (!suffix) return false;

  const allowedSet = new Set(allowed.map(normalizeSuffix).filter(Boolean));
  return allowedSet.has(suffix);
}

/**
 * Same as {@link isUserInAllowedAgencies} when only a username string is known
 * (e.g. TAK subscription rows). Uses username token at tail or prefix.
 */
function isUsernameInAllowedAgencies(authUser, username) {
  return isUserInAllowedAgencies(authUser, { username, attributes: {} });
}

/**
 * TAK subscription rows: resolve the username to a single agency suffix (longest
 * known match at tail, then prefix  same rules as Total Users / Users by Agency),
 * then check whether that suffix is in the viewer's allowed list.
 */
function isUsernameInAllowedAgencySuffixes(authUser, username) {
  const access = getAgencyAccess(authUser);
  if (access.isGlobalAdmin) return true;
  const allowed = access.allowedAgencySuffixes || [];
  if (!allowed.length) return false;

  const u = String(username || "").trim();
  if (!u) return false;

  const resolved = inferAgencySuffixFromUsername(u);
  if (!resolved) return false;

  const allowedSet = new Set(allowed.map(normalizeSuffix).filter(Boolean));
  return allowedSet.has(resolved);
}

/**
 * Compute the agency, county, and state prefixes that the current user is allowed to see.
 *
 * agencyPrefixes: e.g. ["CPD", "CFD"]
 * countyPrefixes: e.g. ["HAMILTON", "BRADLEY"]
 * statePrefixes: e.g. ["TN", "GA"]
 */
function collectManagedAgencyScope(authUser) {
  const access = getAgencyAccess(authUser);
  if (access.isGlobalAdmin) {
    return {
      agencyPrefixes: null,
      agencyNames: null,
      countyPrefixes: null,
      statePrefixes: null,
    };
  }

  const allowed = Array.isArray(access.allowedAgencySuffixes)
    ? access.allowedAgencySuffixes.map(normalizeSuffix).filter(Boolean)
    : [];
  if (!allowed.length) {
    return {
      agencyPrefixes: [],
      agencyNames: [],
      countyPrefixes: [],
      statePrefixes: [],
    };
  }

  const allowedSet = new Set(allowed);
  const agencies = agenciesStore.load();

  const agencyPrefixes = [];
  const agencyNames = [];
  const countyPrefixes = [];
  const statePrefixes = [];

  for (const agency of agencies) {
    const sfx = normalizeSuffix(agency && agency.suffix);
    if (!sfx || !allowedSet.has(sfx)) continue;

    const an = String(agency.name || "").trim();
    if (
      an &&
      !agencyNames.some((n) => n.toLowerCase() === an.toLowerCase())
    ) {
      agencyNames.push(an);
    }

    const gp = agenciesStore.normalizeGroupPrefix(agency.groupPrefix);
    if (
      gp &&
      !agencyPrefixes.some((p) => p.toLowerCase() === gp.toLowerCase())
    ) {
      agencyPrefixes.push(gp);
    }

    const county = String(agency.county || "").trim().toUpperCase();
    if (county && !countyPrefixes.includes(county)) {
      countyPrefixes.push(county);
    }

    const state = String(agency.state || "").trim().toUpperCase();
    if (state && !statePrefixes.includes(state)) {
      statePrefixes.push(state);
    }
  }

  return { agencyPrefixes, agencyNames, countyPrefixes, statePrefixes };
}

function getAgencyCountyAndStatePrefixesForUser(authUser) {
  return collectManagedAgencyScope(authUser);
}

// Backwards-compatible alias (older callers expect this name).
// Also returns agencyNames for attribute-based ownership.
function getAgencyAndCountyPrefixesForUser(authUser) {
  return collectManagedAgencyScope(authUser);
}

/** Agencies the user administers (from allowed suffixes). */
function getManagedAgenciesForUser(authUser) {
  const access = getAgencyAccess(authUser);
  if (access.isGlobalAdmin) return null;
  const allowed = Array.isArray(access.allowedAgencySuffixes)
    ? access.allowedAgencySuffixes.map(normalizeSuffix).filter(Boolean)
    : [];
  if (!allowed.length) return [];
  const allowedSet = new Set(allowed);
  return agenciesStore
    .load()
    .filter((a) => allowedSet.has(normalizeSuffix(a?.suffix)));
}

/**
 * Set of group PKs that agency admins are allowed to see in addition to their
 * own agency-prefixed groups (configured per agency by global admins on Agencies page).
 */
function getAllowedAdminGroupIdsForUser(authUser) {
  const access = getAgencyAccess(authUser);
  if (access.isGlobalAdmin) return null; // no restriction
  const allowedSuffixes = access.allowedAgencySuffixes || [];
  if (!allowedSuffixes.length) return new Set();
  const agencies = agenciesStore.load();
  const allowedSet = new Set(allowedSuffixes.map(normalizeSuffix));
  const out = new Set();
  for (const agency of agencies) {
    const sfx = normalizeSuffix(agency?.suffix);
    if (!sfx || !allowedSet.has(sfx)) continue;
    const ids = agency.allowedAdminGroupIds;
    if (Array.isArray(ids)) {
      for (const id of ids) {
        const s = String(id).trim();
        if (s) out.add(s);
      }
    }
  }
  return out;
}

/**
 * Whether the user is allowed to modify (e.g. mass assign/unassign) this group.
 * Global admins: yes. Agency admins: owned groups (created_type_detail) or allowedAdminGroupIds.
 */
function canUserModifyGroup(authUser, group) {
  const access = getAgencyAccess(authUser);
  if (access.isGlobalAdmin) return true;
  if (!group || group.pk == null) return false;
  const pk = String(group.pk).trim();
  const allowedExtraIds = getAllowedAdminGroupIdsForUser(authUser);
  if (allowedExtraIds && pk && allowedExtraIds.has(pk)) return true;
  const managed = getManagedAgenciesForUser(authUser);
  if (!Array.isArray(managed) || !managed.length) return false;
  return managed.some((a) => agenciesStore.isAgencyOwnedGroup(group, a));
}

function isGroupMarkedPrivate(group) {
  const privateFlag = String(group?.attributes?.private || "")
    .trim()
    .toLowerCase();
  return privateFlag === "yes" || privateFlag === "true" || privateFlag === "1";
}

/** Uppercase name prefix before first space (after optional tak_ strip); empty for global-style names. */
function getGroupNamePrefixUpper(group) {
  let name = String(group?.name || "").trim();
  if (!name) return "";
  if (name.toLowerCase().startsWith("tak_")) {
    name = name.slice(4);
  }
  const upper = name.toUpperCase();
  const spaceIdx = upper.indexOf(" ");
  if (spaceIdx <= 0) return "";
  return upper.slice(0, spaceIdx).trim();
}

/**
 * Agency dashboard group total: groups owned by this agency via created_type_detail.
 * Excludes private groups and does not count county/state/global groups from allowedAdminGroupIds.
 *
 * @param {object[]} groups
 * @param {string} agencyNameOrPrefix - preferred: full agency name; groupPrefix still accepted
 */
function filterAgencySpecificGroupsForDashboard(groups, agencyNameOrPrefix) {
  const key = String(agencyNameOrPrefix || "").trim();
  if (!key) return [];
  const keyLower = key.toLowerCase();
  const agencies = agenciesStore.load();
  const agency =
    agencies.find(
      (a) => String(a?.name || "").trim().toLowerCase() === keyLower
    ) ||
    agencies.find(
      (a) =>
        agenciesStore.normalizeGroupPrefix(a?.groupPrefix).toLowerCase() ===
        keyLower
    ) ||
    null;

  return (Array.isArray(groups) ? groups : []).filter((g) => {
    if (isGroupMarkedPrivate(g)) return false;
    if (agency) return agenciesStore.isAgencyOwnedGroup(g, agency);
    const attrs =
      g?.attributes && typeof g.attributes === "object" ? g.attributes : {};
    if (String(attrs.created_type || "").trim().toLowerCase() !== "agency") {
      return false;
    }
    return (
      String(attrs.created_type_detail || "").trim().toLowerCase() === keyLower
    );
  });
}

/**
 * Filter a list of Authentik groups for the current user.
 *
 * - Global admins: see all groups (after GROUPS_HIDDEN_PREFIXES is applied).
 * - Agency admins: see only
 *   - their own agency's groups (created_type=Agency + created_type_detail=full name),
 *   - plus groups explicitly granted via the agency's allowedAdminGroupIds (set on Agencies page).
 * County, region, and state groups are NOT shown by default; only if added to allowedAdminGroupIds.
 */
function filterGroupsForUser(authUser, groups) {
  const access = getAgencyAccess(authUser);
  const list = Array.isArray(groups) ? groups : [];

  if (access.isGlobalAdmin) {
    return list;
  }

  const managed = getManagedAgenciesForUser(authUser);
  const allowedExtraIds = getAllowedAdminGroupIdsForUser(authUser);
  const hasManaged = Array.isArray(managed) && managed.length > 0;

  return list.filter((g) => {
    if (isGroupMarkedPrivate(g)) return false;

    const pk = String(g?.pk ?? g?.id ?? "").trim();
    if (allowedExtraIds && pk && allowedExtraIds.has(pk)) return true;

    if (hasManaged && managed.some((a) => agenciesStore.isAgencyOwnedGroup(g, a))) {
      return true;
    }

    return false;
  });
}

/**
 * Agency-only page titles (Users, Groups, Templates): single managed agency ? groupPrefix (e.g. "HCSO").
 * Multiple agencies or global admin ? null (views use generic "Agency " or default title).
 */
function getAgencyPageTitleAbbrev(authUser) {
  const access = getAgencyAccess(authUser);
  if (access.isGlobalAdmin) return null;

  const allowed = access.allowedAgencySuffixes || [];
  if (!allowed.length) return null;

  const agencies = agenciesStore.load();
  const prefixes = [];
  const seen = new Set();

  for (const sfx of allowed) {
    const norm = normalizeSuffix(sfx);
    if (!norm) continue;
    const agency = agencies.find((a) => normalizeSuffix(a && a.suffix) === norm);
    if (!agency) continue;
    const gp = agenciesStore.normalizeGroupPrefix(agency.groupPrefix);
    const key = gp.toLowerCase();
    if (!gp || seen.has(key)) continue;
    seen.add(key);
    prefixes.push(gp);
  }

  return prefixes.length === 1 ? prefixes[0] : null;
}

/**
 * Compare attribute-first resolution vs username-only (for rollout diagnostics).
 * @returns {{ resolved: string, inferred: string, mismatch: boolean }}
 */
function compareAgencyResolutionToUsernameInference(user) {
  const resolved = resolveAgencySuffixFromUser(user);
  const inferred = inferAgencySuffixFromUsername(
    user && typeof user === "object" ? user.username : ""
  );
  return {
    resolved,
    inferred,
    mismatch: normalizeSuffix(resolved) !== normalizeSuffix(inferred),
  };
}

function buildGroupLookupMaps(allGroups) {
  const list = Array.isArray(allGroups) ? allGroups : [];
  const groupNameById = new Map(
    list.map((g) => [String(g?.pk || ""), String(g?.name || "")])
  );
  const groupsByNameLower = new Map(
    list.map((g) => [String(g?.name || "").trim().toLowerCase(), String(g?.pk || "")])
  );
  return { groupNameById, groupsByNameLower };
}

function getGlobalAdminGroupIds(groupsByNameLower) {
  const globalGroupNames = String(getString("PORTAL_AUTH_REQUIRED_GROUP", ""))
    .split(",")
    .map((x) => String(x || "").trim().toLowerCase())
    .filter(Boolean);
  return globalGroupNames
    .map((n) => groupsByNameLower.get(n))
    .filter(Boolean);
}

/**
 * All Authentik group PKs that grant agency-admin rights for any configured agency.
 */
function getAllKnownAgencyAdminGroupIds(allGroups) {
  const { groupsByNameLower } = buildGroupLookupMaps(allGroups);
  const ids = new Set();
  const agencies = agenciesStore.load();

  for (const agency of agencies) {
    const computedNames = getAllAgencyAdminGroupNames(agency).map((n) =>
      String(n || "").trim().toLowerCase()
    );
    for (const name of computedNames) {
      const pk = groupsByNameLower.get(name);
      if (pk) ids.add(String(pk));
    }

    const rawAdmin =
      agency.adminGroups != null ? agency.adminGroups : agency.adminGroup;
    for (const legacyName of normalizeGroupList(rawAdmin)) {
      const pk = groupsByNameLower.get(legacyName);
      if (pk) ids.add(String(pk));
    }
  }

  return ids;
}

/**
 * Resolve AgencyAdmin group PKs for the given agency suffixes.
 */
function resolveAgencyAdminGroupIdsForSuffixes(suffixes, allGroups) {
  const { groupsByNameLower } = buildGroupLookupMaps(allGroups);
  const agencies = agenciesStore.load();
  const wanted = new Set(
    (Array.isArray(suffixes) ? suffixes : [])
      .map((s) => normalizeSuffix(s))
      .filter(Boolean)
  );
  const ids = new Set();

  for (const agency of agencies) {
    const sfx = normalizeSuffix(agency?.suffix);
    if (!sfx || !wanted.has(sfx)) continue;

    for (const name of getAllAgencyAdminGroupNames(agency)) {
      const pk = groupsByNameLower.get(String(name || "").trim().toLowerCase());
      if (pk) ids.add(String(pk));
    }

    const rawAdmin =
      agency.adminGroups != null ? agency.adminGroups : agency.adminGroup;
    for (const legacyName of normalizeGroupList(rawAdmin)) {
      const pk = groupsByNameLower.get(legacyName);
      if (pk) ids.add(String(pk));
    }
  }

  return ids;
}

/**
 * Normalize and validate managed agency suffixes against agencies.json.
 * When allowedForActor is provided, filters to suffixes the actor may assign.
 */
function normalizeManagedAgencySuffixes(raw, { allowedForActor = null } = {}) {
  const agencies = agenciesStore.load();
  const valid = new Set(
    agencies.map((a) => normalizeSuffix(a?.suffix)).filter(Boolean)
  );
  const out = [];
  const seen = new Set();
  for (const rawSuffix of Array.isArray(raw) ? raw : []) {
    const sfx = normalizeSuffix(rawSuffix);
    if (!sfx || !valid.has(sfx) || seen.has(sfx)) continue;
    seen.add(sfx);
    out.push(sfx);
  }

  if (Array.isArray(allowedForActor) && allowedForActor.length) {
    const allowedSet = new Set(
      allowedForActor.map((s) => normalizeSuffix(s)).filter(Boolean)
    );
    return out.filter((s) => allowedSet.has(s));
  }

  return out;
}

/**
 * User's home agency is always included for multi-agency admins; picker lists only additional agencies.
 */
function mergeManagedAgencySuffixesWithHome(rawSuffixes, userOrHomeSuffix) {
  const home =
    typeof userOrHomeSuffix === "string"
      ? normalizeSuffix(userOrHomeSuffix)
      : resolveAgencySuffixFromUser(userOrHomeSuffix);
  const merged = normalizeManagedAgencySuffixes(rawSuffixes);
  if (!home) return merged;
  const out = [];
  const seen = new Set();
  const push = (sfx) => {
    const norm = normalizeSuffix(sfx);
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    out.push(norm);
  };
  push(home);
  merged.forEach(push);
  return out;
}

function additionalManagedAgencySuffixes(rawSuffixes, userOrHomeSuffix) {
  const home =
    typeof userOrHomeSuffix === "string"
      ? normalizeSuffix(userOrHomeSuffix)
      : resolveAgencySuffixFromUser(userOrHomeSuffix);
  if (!home) return normalizeManagedAgencySuffixes(rawSuffixes);
  return normalizeManagedAgencySuffixes(rawSuffixes).filter((s) => s !== home);
}

/**
 * Compute Authentik group add/remove sets for a portal role change.
 */
function computePortalRoleGroupDelta({
  role,
  managedAgencySuffixes = [],
  currentGroupIds = [],
  allGroups = [],
}) {
  const desiredRole = String(role || "").trim().toLowerCase();
  if (!["user", "agency_admin", "global_admin"].includes(desiredRole)) {
    throw new Error("Invalid role.");
  }

  const { groupsByNameLower } = buildGroupLookupMaps(allGroups);
  const currentGroups = new Set(
    (Array.isArray(currentGroupIds) ? currentGroupIds : [])
      .map((id) => String(id))
      .filter(Boolean)
  );

  const allAgencyAdminIds = getAllKnownAgencyAdminGroupIds(allGroups);
  const globalIds = new Set(getGlobalAdminGroupIds(groupsByNameLower));

  const desiredAgencyAdminIds = new Set();
  if (desiredRole === "agency_admin") {
    const suffixes = normalizeManagedAgencySuffixes(managedAgencySuffixes);
    if (!suffixes.length) {
      throw new Error("At least one managed agency is required for Agency Admin.");
    }
    for (const id of resolveAgencyAdminGroupIdsForSuffixes(suffixes, allGroups)) {
      desiredAgencyAdminIds.add(String(id));
    }
    if (!desiredAgencyAdminIds.size) {
      throw new Error(
        "Cannot assign Agency Admin: agency admin group(s) were not found in Authentik."
      );
    }
  }

  const desiredGlobalIds = desiredRole === "global_admin" ? globalIds : new Set();
  if (desiredRole === "global_admin" && !desiredGlobalIds.size) {
    throw new Error("Global admin groups are not configured.");
  }

  const toAdd = new Set();
  const toRemove = new Set();

  for (const id of desiredAgencyAdminIds) {
    if (!currentGroups.has(id)) toAdd.add(id);
  }
  for (const id of allAgencyAdminIds) {
    if (!desiredAgencyAdminIds.has(id) && currentGroups.has(id)) toRemove.add(id);
  }

  for (const id of desiredGlobalIds) {
    if (!currentGroups.has(id)) toAdd.add(id);
  }
  for (const id of globalIds) {
    if (!desiredGlobalIds.has(id) && currentGroups.has(id)) toRemove.add(id);
  }

  return {
    toAdd: Array.from(toAdd),
    toRemove: Array.from(toRemove),
    managedAgencySuffixes:
      desiredRole === "agency_admin"
        ? normalizeManagedAgencySuffixes(managedAgencySuffixes)
        : [],
  };
}

/**
 * Sync Authentik group membership for portal role / managed agencies.
 * Returns { toAdd, toRemove, managedAgencySuffixes }.
 */
async function syncPortalRoleGroups(userId, opts = {}) {
  const uid = String(userId || "").trim();
  if (!uid) throw new Error("Missing user id.");

  const usersSvc = require("./users.service");
  const target = await usersSvc.getUserById(uid);
  if (!target) throw new Error("User not found.");

  const groupsSvc = require("./groups.service");
  const allGroups = opts.allGroups || (await groupsSvc.getAllGroups({ includeHidden: true }));
  const currentGroupIds = Array.isArray(opts.currentGroupIds)
    ? opts.currentGroupIds
    : Array.isArray(target.groups)
    ? target.groups
    : [];

  const delta = computePortalRoleGroupDelta({
    role: opts.role,
    managedAgencySuffixes: opts.managedAgencySuffixes,
    currentGroupIds,
    allGroups,
  });

  if (delta.toAdd.length) {
    await usersSvc.addUserGroups(uid, delta.toAdd);
  }
  if (delta.toRemove.length) {
    await usersSvc.removeUserGroups(uid, delta.toRemove);
  }

  return delta;
}

function getManagedAgencySuffixesFromGroupNames(groupNames) {
  return getAllowedAgencySuffixesForGroups(groupNames);
}

/**
 * Refresh agency-admin scope from live Authentik group membership.
 * Forward-auth headers can lag after managed-agency changes; the API is authoritative.
 */
async function enrichAuthUserFromAuthentik(authUser) {
  if (!authUser || authUser.isGlobalAdmin) return authUser;

  const uid = String(authUser.uid || "").trim();
  if (!uid) return authUser;

  const usersSvc = require("./users.service");
  const groupsSvc = require("./groups.service");

  const liveUser = await usersSvc.getUserById(uid).catch(() => null);
  if (!liveUser) return authUser;

  const allGroups = await groupsSvc.getAllGroups({ includeHidden: true });
  const { groupNameById } = buildGroupLookupMaps(allGroups);

  const groupIds = Array.isArray(liveUser.groups) ? liveUser.groups.map(String) : [];
  const namesFromIds = groupIds
    .map((id) => groupNameById.get(id))
    .filter(Boolean);

  const headerNames = Array.isArray(authUser.groups) ? authUser.groups : [];
  const mergedNames = [];
  const seen = new Set();
  for (const raw of [...headerNames, ...namesFromIds]) {
    const name = String(raw || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    mergedNames.push(name);
  }

  const allowedAgencySuffixes = getAllowedAgencySuffixesForGroups(
    mergedNames.map((n) => n.toLowerCase())
  );

  authUser.groups = mergedNames;
  authUser.allowedAgencySuffixes = allowedAgencySuffixes;
  authUser.isAgencyAdmin = allowedAgencySuffixes.length > 0;

  return authUser;
}

module.exports = {
  normalizeSuffix,
  normalizeGroupList,
  getAgencyAdminGroupName,
  getAllAgencyAdminGroupNames,
  getAgencyAdminGroupNamesForAgency,
  inferAgencySuffixFromUsername,
  inferAgencySuffixFromUsernameTail,
  inferAgencySuffixFromUsernamePrefix,
  usernameHasAgencySuffixToken,
  USERNAME_TOKEN_PLACEMENT_SUFFIX,
  USERNAME_TOKEN_PLACEMENT_PREFIX,
  normalizeUsernameTokenPlacement,
  getAgencyUsernameTokenPlacement,
  buildUsernameWithAgencyToken,
  stripAgencyTokenFromUsername,
  stripAgencyTokenFromBadge,
  resolveAgencySuffixFromUser,
  getAllowedAgencySuffixesForGroups,
  hasAnyAgencyAdminsConfigured,
  getAgencyAccess,
  getUserManagedAgencySuffixes,
  filterAgenciesForUser,
  isSuffixAllowed,
  isUserInAllowedAgencies,
  isUsernameInAllowedAgencies,
  isUsernameInAllowedAgencySuffixes,
  compareAgencyResolutionToUsernameInference,
  LOG_FALLBACK_ENV,
  SHADOW_ENV,
  getAllowedAdminGroupIdsForUser,
  canUserModifyGroup,
  // Export both names; older routes use getAgencyAndCountyPrefixesForUser.
  getAgencyCountyAndStatePrefixesForUser,
  getAgencyAndCountyPrefixesForUser,
  getManagedAgenciesForUser,
  filterGroupsForUser,
  isGroupMarkedPrivate,
  getGroupNamePrefixUpper,
  filterAgencySpecificGroupsForDashboard,
  getAgencyPageTitleAbbrev,
  buildGroupLookupMaps,
  getGlobalAdminGroupIds,
  getAllKnownAgencyAdminGroupIds,
  resolveAgencyAdminGroupIdsForSuffixes,
  normalizeManagedAgencySuffixes,
  mergeManagedAgencySuffixesWithHome,
  additionalManagedAgencySuffixes,
  computePortalRoleGroupDelta,
  syncPortalRoleGroups,
  getManagedAgencySuffixesFromGroupNames,
  enrichAuthUserFromAuthentik,
};
