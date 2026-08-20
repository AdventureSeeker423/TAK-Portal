const fs = require("fs");
const path = require("path");
const { getBool, getString } = require("./env");
const groupsService = require("./groups.service");
const agenciesStore = require("./agencies.service");
const api = require("./authentik");

const LEDGER_PATH = path.join(__dirname, "..", "data", "autoCreateGroups.json");
const MAX_TITLES = 3;

function ensureDirExists(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function emptyLedger() {
  return { county: {}, state: {}, region: {} };
}

function loadLedger() {
  try {
    if (!fs.existsSync(LEDGER_PATH)) return emptyLedger();
    const parsed = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
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
      region:
        parsed.region && typeof parsed.region === "object" && !Array.isArray(parsed.region)
          ? parsed.region
          : {},
    };
  } catch (err) {
    console.warn(
      "[autoCreateGroups] Failed to read ledger:",
      err.message || err
    );
    return emptyLedger();
  }
}

function saveLedger(ledger) {
  ensureDirExists(LEDGER_PATH);
  const next = {
    county: ledger?.county && typeof ledger.county === "object" ? ledger.county : {},
    state: ledger?.state && typeof ledger.state === "object" ? ledger.state : {},
    region: ledger?.region && typeof ledger.region === "object" ? ledger.region : {},
  };
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(next, null, 2));
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

function regionKey(detail, title) {
  return `${String(detail || "").trim().toLowerCase()}|${titleKeyPart(title)}`;
}

function readTitles(prefix) {
  const titles = [];
  const seen = new Set();
  for (let i = 1; i <= MAX_TITLES; i += 1) {
    const t = normalizeTitle(getString(`${prefix}_${i}`, ""));
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push(t);
  }
  return titles;
}

function getAutoCreateConfig() {
  return {
    agencyEnabled: getBool("AUTO_CREATE_AGENCY_GROUPS_ENABLED", true),
    countyEnabled: getBool("AUTO_CREATE_COUNTY_GROUPS_ENABLED", false),
    regionEnabled: getBool("AUTO_CREATE_REGION_GROUPS_ENABLED", false),
    stateEnabled: getBool("AUTO_CREATE_STATE_GROUPS_ENABLED", false),
    agencyTitles: readTitles("AUTO_CREATE_AGENCY_GROUP_TITLE"),
    countyTitles: readTitles("AUTO_CREATE_COUNTY_GROUP_TITLE"),
    regionTitles: readTitles("AUTO_CREATE_REGION_GROUP_TITLE"),
    stateTitles: readTitles("AUTO_CREATE_STATE_GROUP_TITLE"),
  };
}

function buildAgencyGroupName(groupPrefix, title) {
  const prefix = agenciesStore.normalizeGroupPrefix(groupPrefix);
  const t = normalizeTitle(title);
  if (!prefix || !t) return null;
  return groupsService.ensureTakPrefix(`${prefix} ${t}`);
}

function buildCountyGroupName(county, title) {
  const c = String(county || "").trim();
  const t = normalizeTitle(title);
  if (!c || !t) return null;
  return groupsService.ensureTakPrefix(`${c} Co ${t}`);
}

function buildRegionGroupName(regionName, title) {
  const r = String(regionName || "").trim().replace(/\s+/g, " ");
  const t = normalizeTitle(title);
  if (!r || !t) return null;
  return groupsService.ensureTakPrefix(`${r} ${t}`);
}

function buildStateGroupName(state, title) {
  const s = String(state || "").trim().toUpperCase();
  const t = normalizeTitle(title);
  if (!s || !t) return null;
  return groupsService.ensureTakPrefix(`${s} ${t}`);
}

async function getGroupByNameUnfiltered(groupName) {
  const name = String(groupName || "").trim();
  if (!name) return null;

  try {
    const res = await api.get(`/core/groups/?name=${encodeURIComponent(name)}`);
    const results = Array.isArray(res?.data?.results) ? res.data.results : [];
    const exact = results.find(
      (g) => String(g?.name || "").trim().toLowerCase() === name.toLowerCase()
    );
    if (exact) return exact;
  } catch (_) {
    // fall through to search
  }

  try {
    const res2 = await api.get(`/core/groups/?search=${encodeURIComponent(name)}`);
    const results2 = Array.isArray(res2?.data?.results) ? res2.data.results : [];
    return (
      results2.find(
        (g) => String(g?.name || "").trim().toLowerCase() === name.toLowerCase()
      ) || null
    );
  } catch (_) {
    return null;
  }
}

function isDuplicateNameError(err) {
  const msg = String(
    err?.response?.data?.detail || err?.response?.data || err?.message || ""
  ).toLowerCase();
  return (
    msg.includes("already") || msg.includes("exists") || msg.includes("unique")
  );
}

function actorAttributes(actor) {
  if (!actor) return {};
  return {
    created_by_username: String(actor.username || "").trim() || null,
    created_by_display_name:
      String(actor.displayName || actor.username || "").trim() || null,
  };
}

function markLedger(ledger, scope, key, entry) {
  const bucket =
    scope === "state" ? "state" : scope === "region" ? "region" : "county";
  if (!ledger[bucket] || typeof ledger[bucket] !== "object") {
    ledger[bucket] = {};
  }
  if (ledger[bucket][key]) return false;
  ledger[bucket][key] = {
    detail: entry.detail,
    title: entry.title,
    groupName: entry.groupName,
    provisionedAt: entry.provisionedAt || new Date().toISOString(),
  };
  return true;
}

async function ensureAgencyTitleGroup(agency, title, actor) {
  const name = buildAgencyGroupName(agency?.groupPrefix, title);
  if (!name) throw new Error("Agency abbreviation / short name is required");

  const attributes = {
    created_at: new Date().toISOString(),
    private: "no",
    created_type: "Agency",
    created_type_detail:
      String(agency?.name || agency?.groupPrefix || "").trim() || null,
    ...actorAttributes(actor),
  };

  try {
    const group = await groupsService.createGroup(name, { attributes });
    return {
      created: true,
      skipped: false,
      name,
      group,
      created_type: "Agency",
      created_type_detail: attributes.created_type_detail,
      title,
    };
  } catch (err) {
    if (!isDuplicateNameError(err)) throw err;
    const existing = await getGroupByNameUnfiltered(name);
    if (existing && agenciesStore.isAgencyOwnedGroup(existing, agency)) {
      return {
        created: false,
        skipped: true,
        name,
        group: existing,
        created_type: "Agency",
        created_type_detail: attributes.created_type_detail,
        title,
      };
    }
    throw new Error(
      `Authentik group "${name}" already exists and is not owned by this agency`
    );
  }
}

async function ensureGeoTitleGroup({
  scope,
  detail,
  title,
  name,
  actor,
  ledger,
}) {
  const key =
    scope === "state"
      ? stateKey(detail, title)
      : scope === "region"
        ? regionKey(detail, title)
        : countyKey(detail, title);
  const bucket =
    scope === "state" ? "state" : scope === "region" ? "region" : "county";
  const createdType =
    scope === "state" ? "State" : scope === "region" ? "Region" : "County";

  if (ledger[bucket] && ledger[bucket][key]) {
    return {
      created: false,
      skipped: true,
      reason: "ledger",
      name,
      group: null,
      created_type: createdType,
      created_type_detail: detail,
      title,
      ledgerKey: key,
    };
  }

  const existing = await getGroupByNameUnfiltered(name);
  if (existing) {
    const dirty = markLedger(ledger, scope, key, {
      detail,
      title,
      groupName: existing.name || name,
    });
    return {
      created: false,
      skipped: true,
      reason: "exists",
      name: existing.name || name,
      group: existing,
      created_type: createdType,
      created_type_detail: detail,
      title,
      ledgerKey: key,
      ledgerDirty: dirty,
    };
  }

  const attributes = {
    created_at: new Date().toISOString(),
    private: "no",
    created_type: createdType,
    created_type_detail: detail,
    ...actorAttributes(actor),
  };

  try {
    const group = await groupsService.createGroup(name, { attributes });
    const dirty = markLedger(ledger, scope, key, {
      detail,
      title,
      groupName: group?.name || name,
    });
    return {
      created: true,
      skipped: false,
      name: group?.name || name,
      group,
      created_type: createdType,
      created_type_detail: detail,
      title,
      ledgerKey: key,
      ledgerDirty: dirty,
    };
  } catch (err) {
    if (!isDuplicateNameError(err)) throw err;
    // Race / concurrent create: treat as exists and ledger it.
    const raced = await getGroupByNameUnfiltered(name);
    const dirty = markLedger(ledger, scope, key, {
      detail,
      title,
      groupName: raced?.name || name,
    });
    return {
      created: false,
      skipped: true,
      reason: "exists",
      name: raced?.name || name,
      group: raced,
      created_type: createdType,
      created_type_detail: detail,
      title,
      ledgerKey: key,
      ledgerDirty: dirty,
    };
  }
}

/**
 * Ensure configured auto-create groups for a newly created agency.
 * Agency titles use ownership checks. County/State use the provisioned ledger.
 */
async function ensureAutoCreateGroupsForAgency(agency, actor) {
  const config = getAutoCreateConfig();
  const results = [];
  const createdGroups = [];
  let mainGroup = null;
  let ledger = loadLedger();
  let ledgerDirty = false;

  if (config.agencyEnabled) {
    const titles = config.agencyTitles.length
      ? config.agencyTitles
      : ["Main"];
    for (const title of titles) {
      const result = await ensureAgencyTitleGroup(agency, title, actor);
      results.push(result);
      if (!mainGroup) mainGroup = result;
      if (result.created) createdGroups.push(result);
    }
  }

  const county = String(agency?.county || "").trim();
  const stateFederal = !!agency?.stateFederalAgency;
  if (config.countyEnabled && county && !stateFederal) {
    const titles = config.countyTitles.length
      ? config.countyTitles
      : ["Interop"];
    for (const title of titles) {
      const name = buildCountyGroupName(county, title);
      if (!name) continue;
      const result = await ensureGeoTitleGroup({
        scope: "county",
        detail: county,
        title,
        name,
        actor,
        ledger,
      });
      results.push(result);
      if (result.ledgerDirty) ledgerDirty = true;
      if (result.created) createdGroups.push(result);
    }
  }

  const regionsSvc = require("./regions.service");
  const regionName = regionsSvc.getRegionName(agency?.regionId);
  if (config.regionEnabled && regionName) {
    const titles = config.regionTitles.length
      ? config.regionTitles
      : ["Interop"];
    for (const title of titles) {
      const name = buildRegionGroupName(regionName, title);
      if (!name) continue;
      const result = await ensureGeoTitleGroup({
        scope: "region",
        detail: regionName,
        title,
        name,
        actor,
        ledger,
      });
      results.push(result);
      if (result.ledgerDirty) ledgerDirty = true;
      if (result.created) createdGroups.push(result);
    }
  }

  const state = String(agency?.state || "").trim().toUpperCase();
  if (config.stateEnabled && state) {
    const titles = config.stateTitles.length
      ? config.stateTitles
      : ["Interop"];
    for (const title of titles) {
      const name = buildStateGroupName(state, title);
      if (!name) continue;
      const result = await ensureGeoTitleGroup({
        scope: "state",
        detail: state,
        title,
        name,
        actor,
        ledger,
      });
      results.push(result);
      if (result.ledgerDirty) ledgerDirty = true;
      if (result.created) createdGroups.push(result);
    }
  }

  if (ledgerDirty) {
    saveLedger(ledger);
  }

  return {
    mainGroup,
    createdGroups,
    results,
    config,
  };
}

module.exports = {
  MAX_TITLES,
  LEDGER_PATH,
  getAutoCreateConfig,
  ensureAutoCreateGroupsForAgency,
  buildAgencyGroupName,
  buildCountyGroupName,
  buildRegionGroupName,
  buildStateGroupName,
  getGroupByNameUnfiltered,
  loadLedger,
  saveLedger,
};
