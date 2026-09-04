const { getBool, getString, getInt } = require("./env");
const agenciesStore = require("./agencies.service");
const autoCreateGroupsSvc = require("./autoCreateGroups.service");
const dataSyncSvc = require("./dataSync.service");
const groupsService = require("./groups.service");
const pgCache = require("./pgCache");

const LEDGER_PATH = null;

function ensureDirExists() {}

function emptyLedger() {
  return { county: {}, state: {} };
}

function loadLedger() {
  const parsed = pgCache.caches.autoCreateDataSync;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return emptyLedger();
  }
  return {
    county:
      parsed.county && typeof parsed.county === "object" && !Array.isArray(parsed.county)
        ? parsed.county
        : {},
    state:
      parsed.state && typeof parsed.state === "object" && !Array.isArray(parsed.state)
        ? parsed.state
        : {},
  };
}

function saveLedger(ledger) {
  const next = {
    county: ledger?.county && typeof ledger.county === "object" ? ledger.county : {},
    state: ledger?.state && typeof ledger.state === "object" ? ledger.state : {},
  };
  pgCache.replaceAutoCreateDataSync(next);
  return next;
}

function normalizeTitle(raw) {
  return String(raw || "").trim();
}

function titleKeyPart(title) {
  return normalizeTitle(title).toLowerCase();
}

function countyKey(detail, title) {
  return `${String(detail || "").trim().toLowerCase()}|${titleKeyPart(title)}`;
}

function stateKey(detail, title) {
  return `${String(detail || "").trim().toUpperCase()}|${titleKeyPart(title)}`;
}

function getLinkedGroupTitle(scope, groupTitles) {
  const prefix =
    scope === "county"
      ? "AUTO_CREATE_COUNTY"
      : scope === "state"
        ? "AUTO_CREATE_STATE"
        : "AUTO_CREATE_AGENCY";
  let index = getInt(`${prefix}_DATA_SYNC_GROUP_INDEX`, 1);
  if (!Number.isFinite(index) || index < 1) index = 1;
  if (index > 3) index = 3;
  const slotTitle = normalizeTitle(
    getString(`${prefix}_GROUP_TITLE_${index}`, "")
  );
  if (slotTitle) return slotTitle;
  const list = Array.isArray(groupTitles) ? groupTitles : [];
  return list[0] || null;
}

function getMissionTitle(scope) {
  const key =
    scope === "county"
      ? "AUTO_CREATE_COUNTY_DATA_SYNC_TITLE"
      : scope === "state"
        ? "AUTO_CREATE_STATE_DATA_SYNC_TITLE"
        : "AUTO_CREATE_AGENCY_DATA_SYNC_TITLE";
  return normalizeTitle(getString(key, "Active Incident")) || "Active Incident";
}

function getAutoCreateDataSyncConfig() {
  const groups = autoCreateGroupsSvc.getAutoCreateConfig();
  return {
    groups,
    agency: {
      enabled: getBool("AUTO_CREATE_AGENCY_DATA_SYNC_ENABLED", false),
      missionTitle: getMissionTitle("agency"),
      groupTitle: getLinkedGroupTitle("agency", groups.agencyTitles),
      groupIndex: getInt("AUTO_CREATE_AGENCY_DATA_SYNC_GROUP_INDEX", 1),
    },
    county: {
      enabled: getBool("AUTO_CREATE_COUNTY_DATA_SYNC_ENABLED", false),
      missionTitle: getMissionTitle("county"),
      groupTitle: getLinkedGroupTitle("county", groups.countyTitles),
      groupIndex: getInt("AUTO_CREATE_COUNTY_DATA_SYNC_GROUP_INDEX", 1),
    },
    state: {
      enabled: getBool("AUTO_CREATE_STATE_DATA_SYNC_ENABLED", false),
      missionTitle: getMissionTitle("state"),
      groupTitle: getLinkedGroupTitle("state", groups.stateTitles),
      groupIndex: getInt("AUTO_CREATE_STATE_DATA_SYNC_GROUP_INDEX", 1),
    },
  };
}

function buildAgencyMissionName(groupPrefix, missionTitle) {
  const prefix = agenciesStore.normalizeGroupPrefix(groupPrefix);
  const t = normalizeTitle(missionTitle);
  if (!prefix || !t) return null;
  return `${prefix} ${t}`;
}

function buildCountyMissionName(county, missionTitle) {
  const c = String(county || "").trim();
  const t = normalizeTitle(missionTitle);
  if (!c || !t) return null;
  return `${c} Co ${t}`;
}

function buildStateMissionName(state, missionTitle) {
  const s = String(state || "").trim().toUpperCase();
  const t = normalizeTitle(missionTitle);
  if (!s || !t) return null;
  return `${s} ${t}`;
}

function buildMissionBody(missionName, groupName) {
  // TAK Marti uses LDAP CN without tak_; Authentik stores tak_<CN>.
  const takGroupCn = groupsService.stripTakPrefix(String(groupName || "").trim());
  return {
    name: missionName,
    tool: "public",
    description: "",
    defaultRole: {
      type: "MISSION_SUBSCRIBER",
      permissions: ["MISSION_WRITE", "MISSION_READ"],
    },
    groups: [takGroupCn],
    keywords: [],
    inviteOnly: false,
  };
}

function markLedger(ledger, scope, key, entry) {
  const bucket = scope === "state" ? "state" : "county";
  if (!ledger[bucket] || typeof ledger[bucket] !== "object") {
    ledger[bucket] = {};
  }
  if (ledger[bucket][key]) return false;
  ledger[bucket][key] = {
    detail: entry.detail,
    title: entry.title,
    missionName: entry.missionName,
    groupName: entry.groupName || null,
    provisionedAt: entry.provisionedAt || new Date().toISOString(),
  };
  return true;
}

async function assertLinkedGroupExists(groupName) {
  const name = String(groupName || "").trim();
  if (!name) {
    return { ok: false, error: "Linked group name is required" };
  }
  const group = await autoCreateGroupsSvc.getGroupByNameUnfiltered(name);
  if (!group) {
    return {
      ok: false,
      error: `Linked group "${name}" was not found; create groups before Data Sync`,
    };
  }
  return { ok: true, group };
}

async function createMissionIfMissing(missionName, groupName) {
  const groupCheck = await assertLinkedGroupExists(groupName);
  if (!groupCheck.ok) {
    return {
      created: false,
      skipped: true,
      reason: "error",
      missionName,
      groupName,
      error: groupCheck.error,
    };
  }
  const exists = await dataSyncSvc.missionExists(missionName);
  if (exists) {
    return { created: false, skipped: true, reason: "exists", missionName, groupName };
  }
  const data = await dataSyncSvc.putMission(
    missionName,
    buildMissionBody(missionName, groupName)
  );
  return {
    created: true,
    skipped: false,
    missionName,
    groupName,
    data,
  };
}

async function ensureGeoMission({
  scope,
  detail,
  missionTitle,
  missionName,
  groupName,
  ledger,
}) {
  const key = scope === "state" ? stateKey(detail, missionTitle) : countyKey(detail, missionTitle);
  const bucket = scope === "state" ? "state" : "county";

  if (ledger[bucket] && ledger[bucket][key]) {
    return {
      created: false,
      skipped: true,
      reason: "ledger",
      scope,
      missionName,
      groupName,
      ledgerKey: key,
    };
  }

  const groupCheck = await assertLinkedGroupExists(groupName);
  if (!groupCheck.ok) {
    return {
      created: false,
      skipped: true,
      reason: "error",
      scope,
      missionName,
      groupName,
      error: groupCheck.error,
      ledgerKey: key,
    };
  }

  const exists = await dataSyncSvc.missionExists(missionName);
  if (exists) {
    const dirty = markLedger(ledger, scope, key, {
      detail,
      title: missionTitle,
      missionName,
      groupName,
    });
    return {
      created: false,
      skipped: true,
      reason: "exists",
      scope,
      missionName,
      groupName,
      ledgerKey: key,
      ledgerDirty: dirty,
    };
  }

  const data = await dataSyncSvc.putMission(
    missionName,
    buildMissionBody(missionName, groupName)
  );
  const dirty = markLedger(ledger, scope, key, {
    detail,
    title: missionTitle,
    missionName,
    groupName,
  });
  return {
    created: true,
    skipped: false,
    scope,
    missionName,
    groupName,
    data,
    ledgerKey: key,
    ledgerDirty: dirty,
  };
}

/**
 * After groups are ensured for a new agency, create configured Data Sync missions.
 * Soft errors are returned in results; callers should not fail agency create.
 */
async function ensureAutoCreateDataSyncForAgency(agency) {
  const config = getAutoCreateDataSyncConfig();
  const groupsCfg = config.groups;
  const results = [];
  const createdMissions = [];
  let ledger = loadLedger();
  let ledgerDirty = false;

  // Agency
  if (
    config.agency.enabled &&
    groupsCfg.agencyEnabled &&
    config.agency.missionTitle &&
    config.agency.groupTitle
  ) {
    const missionName = buildAgencyMissionName(
      agency?.groupPrefix,
      config.agency.missionTitle
    );
    const groupName = autoCreateGroupsSvc.buildAgencyGroupName(
      agency?.groupPrefix,
      config.agency.groupTitle
    );
    if (missionName && groupName) {
      try {
        const result = await createMissionIfMissing(missionName, groupName);
        result.scope = "agency";
        results.push(result);
        if (result.created) createdMissions.push(result);
      } catch (err) {
        results.push({
          created: false,
          skipped: true,
          reason: "error",
          scope: "agency",
          missionName,
          groupName,
          error: err?.message || String(err),
        });
      }
    }
  }

  // County
  const county = String(agency?.county || "").trim();
  const stateFederal = !!agency?.stateFederalAgency;
  if (
    config.county.enabled &&
    groupsCfg.countyEnabled &&
    county &&
    !stateFederal &&
    config.county.missionTitle &&
    config.county.groupTitle
  ) {
    const missionName = buildCountyMissionName(county, config.county.missionTitle);
    const groupName = autoCreateGroupsSvc.buildCountyGroupName(
      county,
      config.county.groupTitle
    );
    if (missionName && groupName) {
      try {
        const result = await ensureGeoMission({
          scope: "county",
          detail: county,
          missionTitle: config.county.missionTitle,
          missionName,
          groupName,
          ledger,
        });
        results.push(result);
        if (result.ledgerDirty) ledgerDirty = true;
        if (result.created) createdMissions.push(result);
      } catch (err) {
        results.push({
          created: false,
          skipped: true,
          reason: "error",
          scope: "county",
          missionName,
          groupName,
          error: err?.message || String(err),
        });
      }
    }
  }

  // State
  const state = String(agency?.state || "").trim().toUpperCase();
  if (
    config.state.enabled &&
    groupsCfg.stateEnabled &&
    state &&
    config.state.missionTitle &&
    config.state.groupTitle
  ) {
    const missionName = buildStateMissionName(state, config.state.missionTitle);
    const groupName = autoCreateGroupsSvc.buildStateGroupName(
      state,
      config.state.groupTitle
    );
    if (missionName && groupName) {
      try {
        const result = await ensureGeoMission({
          scope: "state",
          detail: state,
          missionTitle: config.state.missionTitle,
          missionName,
          groupName,
          ledger,
        });
        results.push(result);
        if (result.ledgerDirty) ledgerDirty = true;
        if (result.created) createdMissions.push(result);
      } catch (err) {
        results.push({
          created: false,
          skipped: true,
          reason: "error",
          scope: "state",
          missionName,
          groupName,
          error: err?.message || String(err),
        });
      }
    }
  }

  if (ledgerDirty) {
    saveLedger(ledger);
  }

  return { createdMissions, results, config };
}

module.exports = {
  LEDGER_PATH,
  getAutoCreateDataSyncConfig,
  ensureAutoCreateDataSyncForAgency,
  buildAgencyMissionName,
  buildCountyMissionName,
  buildStateMissionName,
  loadLedger,
  saveLedger,
};
