/**
 * Update state code for agencies sharing the same state, county, and county abbreviation.
 */

const agenciesStore = require("./agencies.service");
const groupsService = require("./groups.service");
const { normalizeCountyName } = require("./countyNameRename.service");

const ALLOWED_STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID",
  "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS",
  "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
  "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
  "WI", "WY", "FED", "OTHER",
]);

function normalizeStateCode(raw) {
  return String(raw || "").trim().toUpperCase();
}

function agencyScopeKey(state, county, countyAbbrev) {
  return [
    normalizeStateCode(state),
    String(normalizeCountyName(county) || "").trim().toLowerCase(),
    String(countyAbbrev || "").trim().toUpperCase(),
  ].join("|");
}

function agencyMatchesScope(ag, targetState, targetCounty, targetCountyAbbrev) {
  return (
    agencyScopeKey(ag?.state, ag?.county, ag?.countyAbbrev) ===
    agencyScopeKey(targetState, targetCounty, targetCountyAbbrev)
  );
}

function stripTakPrefix(name) {
  const n = String(name || "").trim();
  return n.toLowerCase().startsWith("tak_") ? n.slice(4) : n;
}

function withTakPrefix(name, hadTak) {
  const n = String(name || "").trim();
  if (!n) return "";
  if (!hadTak) return n;
  return n.toLowerCase().startsWith("tak_") ? n : `tak_${n}`;
}

function computeRenamedStateGroupName(groupName, oldState, newState) {
  const raw = String(groupName || "").trim();
  if (!raw) return null;

  const hadTak = raw.toLowerCase().startsWith("tak_");
  const withoutTak = stripTakPrefix(raw);

  let behaviorSuffix = "";
  let base = withoutTak;
  if (base.endsWith("_READ")) {
    behaviorSuffix = "_READ";
    base = base.slice(0, -5);
  } else if (base.endsWith("_WRITE")) {
    behaviorSuffix = "_WRITE";
    base = base.slice(0, -6);
  }

  const oldS = normalizeStateCode(oldState);
  const newS = normalizeStateCode(newState);
  if (!oldS || !newS) return null;

  const legacyPrefix = `${oldS} - `;
  if (base.toUpperCase().startsWith(legacyPrefix)) {
    const rest = base.slice(legacyPrefix.length);
    return withTakPrefix(`${newS} - ${rest}${behaviorSuffix}`, hadTak);
  }

  const modernPrefix = `${oldS} `;
  if (base.toUpperCase().startsWith(modernPrefix)) {
    const rest = base.slice(modernPrefix.length);
    if (rest.toLowerCase().startsWith("co ") || rest.toLowerCase().startsWith("co -")) {
      return null;
    }
    return withTakPrefix(`${newS} ${rest}${behaviorSuffix}`, hadTak);
  }

  return null;
}

function isAgencyAdminGroupName(name) {
  return /-agencyadmin$/i.test(String(name || "").trim());
}

async function renameStateTakGroups(oldState, newState) {
  const oldS = normalizeStateCode(oldState);
  const newS = normalizeStateCode(newState);
  if (!oldS || !newS || oldS === newS) {
    return { groupsRenamed: 0 };
  }

  const allGroups = await groupsService.getAllGroups({ includeHidden: true });
  let groupsRenamed = 0;

  for (const g of Array.isArray(allGroups) ? allGroups : []) {
    const gn = String(g?.name || "").trim();
    const gid = String(g?.pk ?? g?.id ?? "").trim();
    if (!gn || !gid) continue;
    if (isAgencyAdminGroupName(gn)) continue;

    const attrs = g?.attributes && typeof g.attributes === "object" ? g.attributes : {};
    const createdType = String(attrs.created_type || "").trim().toLowerCase();
    const detail = normalizeStateCode(attrs.created_type_detail);
    const nextName = computeRenamedStateGroupName(gn, oldS, newS);
    const isStateByAttr = createdType === "state" && detail === oldS;
    const isStateByName = !!nextName;

    if (!isStateByAttr && !isStateByName) continue;

    const finalName = nextName || gn;
    const nextAttrs = { ...attrs };
    if (isStateByAttr) {
      nextAttrs.created_type = attrs.created_type || "State";
      nextAttrs.created_type_detail = newS;
    }

    const nameChanged = finalName !== gn;
    const detailChanged = isStateByAttr && detail !== newS;
    if (!nameChanged && !detailChanged) continue;

    await groupsService.patchGroupNameAndCn(gid, finalName, {
      skipActionLock: true,
      attributes: {
        created_type: nextAttrs.created_type,
        created_type_detail: nextAttrs.created_type_detail,
        description: nextAttrs.description,
        private: nextAttrs.private,
      },
    });
    groupsRenamed += 1;
  }

  return { groupsRenamed };
}

function anyAgencyUsesState(agencies, stateCode) {
  const code = normalizeStateCode(stateCode);
  return (Array.isArray(agencies) ? agencies : []).some(
    (ag) => normalizeStateCode(ag?.state) === code
  );
}

/**
 * @param {number} agencyIndex - index in agencies.json
 * @param {string} newStateRaw - new state code
 */
async function renameStateCode(agencyIndex, newStateRaw) {
  const idx = Number(agencyIndex);
  const agencies = agenciesStore.load();
  if (!Number.isInteger(idx) || !agencies[idx]) {
    throw new Error("Agency not found");
  }

  const agency = agencies[idx];
  const oldState = normalizeStateCode(agency.state);
  const targetCounty = normalizeCountyName(agency.county);
  const targetCountyAbbrev = String(agency.countyAbbrev || "").trim().toUpperCase();
  const newState = normalizeStateCode(newStateRaw);

  if (!oldState) {
    throw new Error("Agency state is missing");
  }
  if (!targetCounty) {
    throw new Error("Agency county is missing");
  }
  if (!targetCountyAbbrev) {
    throw new Error("Agency county abbreviation is missing");
  }
  if (!newState) {
    throw new Error("State is required");
  }
  if (!ALLOWED_STATES.has(newState)) {
    throw new Error(`Invalid state code: ${newState}`);
  }

  const matchingIndexes = [];
  for (let i = 0; i < agencies.length; i++) {
    const ag = agencies[i];
    if (!ag) continue;
    if (agencyMatchesScope(ag, oldState, targetCounty, targetCountyAbbrev)) {
      matchingIndexes.push(i);
    }
  }

  if (!matchingIndexes.length) {
    throw new Error("No matching agencies found for this state, county, and county abbreviation");
  }

  const allAlreadySet = matchingIndexes.every(
    (i) => normalizeStateCode(agencies[i]?.state) === newState
  );
  if (allAlreadySet) {
    return {
      success: true,
      skipped: true,
      oldState,
      newState,
      county: targetCounty,
      countyAbbrev: targetCountyAbbrev,
      updatedIndexes: matchingIndexes,
      groupsRenamed: 0,
      stateGroupsRenamed: false,
    };
  }

  for (const i of matchingIndexes) {
    agencies[i] = { ...agencies[i], state: newState };
  }

  const renameStateGroups = !anyAgencyUsesState(agencies, oldState) && oldState !== newState;
  let groupsRenamed = 0;
  if (renameStateGroups) {
    const groupStats = await renameStateTakGroups(oldState, newState);
    groupsRenamed = groupStats.groupsRenamed;
  }

  agenciesStore.save(agencies);
  groupsService.invalidateGroupsCache();

  return {
    success: true,
    skipped: false,
    oldState,
    newState,
    county: targetCounty,
    countyAbbrev: targetCountyAbbrev,
    updatedIndexes: matchingIndexes,
    groupsRenamed,
    stateGroupsRenamed: renameStateGroups && groupsRenamed > 0,
  };
}

module.exports = {
  ALLOWED_STATES,
  normalizeStateCode,
  agencyScopeKey,
  renameStateCode,
};
