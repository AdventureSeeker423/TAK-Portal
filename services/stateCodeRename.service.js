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
    };
  }

  for (const i of matchingIndexes) {
    agencies[i] = { ...agencies[i], state: newState };
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
  };
}

module.exports = {
  ALLOWED_STATES,
  normalizeStateCode,
  agencyScopeKey,
  renameStateCode,
};
