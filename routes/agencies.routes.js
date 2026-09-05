const router = require("express").Router();
const multer = require("multer");
const store = require("../services/agencies.service");
const agencyTypesSvc = require("../services/agencyTypes.service");
const regionsSvc = require("../services/regions.service");
const accessSvc = require("../services/access.service");
const usersService = require("../services/users.service");
const groupsService = require("../services/groups.service");
const directoryRepo = require("../services/directoryRepo.service");
const auditSvc = require("../services/auditLog.service");
const agencyAbbrevRenameSvc = require("../services/agencyAbbrevRename.service");
const agencyNameRenameSvc = require("../services/agencyNameRename.service");
const countyNameRenameSvc = require("../services/countyNameRename.service");
const stateCodeRenameSvc = require("../services/stateCodeRename.service");
const agencyActiveSvc = require("../services/agencyActive.service");
const agencyDeleteSvc = require("../services/agencyDelete.service");
const userRequestsSvc = require("../services/userRequests.service");
const autoCreateGroupsSvc = require("../services/autoCreateGroups.service");
const autoCreateDataSyncSvc = require("../services/autoCreateDataSync.service");
const upload = multer({ storage: multer.memoryStorage() });

function getAgencyAdminGroupName(agency) {
  const abbr = store.normalizeGroupPrefix(agency?.groupPrefix);
  const countyAbbrev = String(agency?.countyAbbrev || "").trim().toUpperCase();
  if (!abbr) return null;
  if (countyAbbrev) {
    return `authentik-${countyAbbrev}-${abbr}-AgencyAdmin`;
  }
  // Legacy pattern (no county abbreviation stored yet)
  return `authentik-${abbr}-AgencyAdmin`;
}

async function ensureAgencyAdminGroupExists(agency) {
  const name = getAgencyAdminGroupName(agency);
  if (!name) throw new Error("Agency abbreviation / short name is required");

  // Create (idempotent-ish): if the group already exists, Authentik will reject.
  // We treat "already exists" as success.
  const attributes = {
    created_at: new Date().toISOString(),
    created_type: "Agency",
    created_type_detail: String(agency?.name || agency?.groupPrefix || "").trim() || null,
    description: `Agency admin group for ${String(agency?.name || agency?.groupPrefix || "").trim()}`,
  };

  try {
    await groupsService.createGroup(name, { attributes });
    return { created: true, name };
  } catch (err) {
    const msg = String(err?.response?.data?.detail || err?.response?.data || err?.message || "");
    // Common Authentik duplicate patterns include "unique" / "already exists".
    const lower = msg.toLowerCase();
    if (lower.includes("already") || lower.includes("exists") || lower.includes("unique")) {
      try {
        const existing = await getGroupByNameUnfiltered(name);
        if (existing && store.isAgencyOwnedGroup(existing, agency)) {
          return { created: false, name };
        }
      } catch (_) {
        // fall through
      }
      throw new Error(
        `Authentik group "${name}" already exists and is not owned by this agency`
      );
    }
    throw err;
  }
}

// Hidden prefixes (often including "authentik-") apply to paged /api/groups search.
// Agency admin groups still need an exact name lookup against local Postgres.
async function getGroupByNameUnfiltered(groupName) {
  const name = String(groupName || "").trim();
  if (!name) throw new Error("Group name is required");
  return directoryRepo.getGroupById(name);
}

function normalizeAgency(a) {
  const sfRaw = String(a?.stateFederalAgency ?? "").trim().toLowerCase();
  const stateFederalAgency =
    sfRaw === "yes" ||
    sfRaw === "true" ||
    sfRaw === "1" ||
    a?.stateFederalAgency === true;
  const normalized = {
    name: String(a.name || "").trim(),
    type: String(a.type || "").trim(),
    county: String(a.county || "").trim(),
    countyAbbrev: String(a.countyAbbrev || "").trim().toUpperCase(),
    state: String(a.state || "").trim().toUpperCase(),
    suffix: String(a.suffix || "").trim().toLowerCase(),
    groupPrefix: store.normalizeGroupPrefix(a.groupPrefix),
    color: String(a.color || "").trim(),
    stateFederalAgency: !!stateFederalAgency,
    usernameTokenPlacement: accessSvc.normalizeUsernameTokenPlacement(
      a.usernameTokenPlacement ?? a.usernameSuffixPlacement ?? "suffix"
    ),
  };
  // Preserve allowedAdminGroupIds (extra groups agency admins can access)
  const raw = a?.allowedAdminGroupIds;
  if (Array.isArray(raw)) {
    normalized.allowedAdminGroupIds = raw.map((id) => String(id).trim()).filter(Boolean);
  } else {
    normalized.allowedAdminGroupIds = [];
  }
  if (a?.isActive === false) {
    normalized.isActive = false;
  }
  if (Array.isArray(a?.agencyDisabledUserIds)) {
    normalized.agencyDisabledUserIds = a.agencyDisabledUserIds
      .map((id) => String(id).trim())
      .filter(Boolean);
  }
  // Optional region assignment (registry id). Empty clears.
  if ("regionId" in (a || {}) || "region" in (a || {})) {
    const rawRegion =
      a.regionId != null && String(a.regionId).trim() !== ""
        ? a.regionId
        : a.region;
    try {
      const resolved = regionsSvc.resolveRegionId(rawRegion);
      if (resolved) normalized.regionId = resolved;
    } catch (_) {
      // Leave unset; validateAgency / callers handle unknown regions.
      const fallback = String(rawRegion || "").trim();
      if (fallback) normalized.regionId = fallback;
    }
  }
  // County lock wins: locked counties always use their region.
  const lockedId = regionsSvc.lockedRegionIdForAgency(normalized);
  if (lockedId) {
    normalized.regionId = lockedId;
  }
  return normalized;
}

function validateAgency(a) {
  if (!a.name) return "Name is required";
  if (!a.state) return "State is required";
  if (!a.suffix) return "Username suffix is required";
  const gpErr = store.validateGroupPrefix(a.groupPrefix);
  if (gpErr) return gpErr;
  if (!a.color) return "Agency color is required";
  const isStateFederal = !!a.stateFederalAgency;
  if (!isStateFederal) {
    if (!a.county) return "County is required";
    if (!a.countyAbbrev) return "County abbreviation is required";
  }
  if (a.countyAbbrev && a.countyAbbrev.length < 2) {
    return "County abbreviation must be at least 2 characters";
  }
  if (a.countyAbbrev && !/^[A-Z0-9]+$/.test(a.countyAbbrev)) {
    return "County abbreviation must contain only letters and numbers";
  }
  if (a.regionId) {
    if (!regionsSvc.findById(a.regionId)) {
      return "Invalid region";
    }
  }
  const rawPlacement = String(
    a.usernameTokenPlacement ?? a.usernameSuffixPlacement ?? ""
  )
    .trim()
    .toLowerCase();
  if (
    rawPlacement &&
    !["suffix", "prefix", "start", "before", "leading", "end", "after"].includes(
      rawPlacement
    )
  ) {
    return "Username token placement must be suffix or prefix";
  }
  return null;
}

function toTitleCaseWords(str) {
  return String(str || "")
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function normalizeCountyName(raw) {
  let v = String(raw || "").trim().replace(/\s+/g, " ");
  if (!v) return "";
  const lower = v.toLowerCase();
  if (lower.endsWith(" county")) {
    const base = v.slice(0, lower.lastIndexOf(" county"));
    return toTitleCaseWords(base);
  }
  return toTitleCaseWords(v);
}

const ALLOWED_STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DC", "DE", "FL", "GA", "HI", "ID",
  "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS",
  "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
  "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
  "WI", "WY", "FED", "OTHER",
]);

// Basic agencies list (raw)
router.get("/", (req, res) => {
  const agencies = store.load();
  const filtered = accessSvc.filterAgenciesForUser(req.authentikUser, agencies);
  res.json(filtered);
});

// Agencies (no user counts anymore). id/_id = backend index for API calls.
router.get("/with-counts", async (req, res) => {
  try {
    const agencies = store.load();
    const visible = accessSvc.filterAgenciesForUser(req.authentikUser, agencies);

    const result = visible.map((a) => {
      const idx = agencies.findIndex(
        (ag) => ag === a || (String(ag.suffix || "").toLowerCase() === String(a.suffix || "").toLowerCase() && String(ag.name || "") === String(a.name || ""))
      );
      const id = idx >= 0 ? idx : 0;
      return {
        ...a,
        id,
        _id: id,
        autoApproveRequests: a.autoApproveRequests === true,
        hasDefaultTemplate: store.agencyHasDefaultTemplate(a?.suffix),
      };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

function csvEscapeCell(value) {
  const s = String(value ?? "");
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Minimal CSV line parser (supports quotes / escaped quotes). */
function parseCsvLine(line) {
  const raw = String(line ?? "");
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function buildAgenciesExportCsv(agencies) {
  const header = [
    "Agency Full Name",
    "Agency Abbreviation / Short Name",
    "Username Agency Identifier",
    "Username Identifier",
    "State",
    "State/Federal Agency",
    "County",
    "County Abbreviation",
    "Agency Type",
    "Agency Color",
    "Region",
  ];
  const lines = [header.map(csvEscapeCell).join(",")];
  const sorted = (Array.isArray(agencies) ? agencies : [])
    .slice()
    .sort((a, b) =>
      String(a?.name || "").localeCompare(String(b?.name || ""), undefined, {
        sensitivity: "base",
      })
    );

  for (const a of sorted) {
    const placement =
      String(a?.usernameTokenPlacement || "suffix").toLowerCase() === "prefix"
        ? "prefix"
        : "suffix";
    const stateFederal = a?.stateFederalAgency === true ? "Yes" : "No";
    const regionName = regionsSvc.getRegionName(a?.regionId) || "";
    lines.push(
      [
        a?.name || "",
        a?.groupPrefix || "",
        placement,
        a?.suffix || "",
        a?.state || "",
        stateFederal,
        a?.county || "",
        a?.countyAbbrev || "",
        a?.type || "",
        a?.color || "",
        regionName,
      ]
        .map(csvEscapeCell)
        .join(",")
    );
  }

  return `${lines.join("\r\n")}\r\n`;
}

router.get("/export-csv", (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    if (!authUser) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const all = store.load();
    const visible = accessSvc.filterAgenciesForUser(authUser, all);
    const csv = buildAgenciesExportCsv(visible);

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "EXPORT_AGENCIES_CSV",
      targetType: "agency",
      targetId: "bulk",
      details: {
        agencyCount: visible.length,
      },
    });

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="tak-portal-agencies-${stamp}.csv"`
    );
    return res.send(csv);
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Export failed" });
  }
});

// Get/set extra groups that this agency's admins can access (besides their own agency groups).
router.get("/:index/access-groups", (req, res) => {
  const idx = Number(req.params.index);
  const agencies = store.load();
  if (!Number.isInteger(idx) || !agencies[idx]) return res.status(404).json({ error: "Not found" });
  const a = agencies[idx];
  const list = Array.isArray(a.allowedAdminGroupIds) ? a.allowedAdminGroupIds : [];
  return res.json({ allowedAdminGroupIds: list });
});

router.put("/:index/access-groups", (req, res) => {
  const access = accessSvc.getAgencyAccess(req.authentikUser || null);
  if (!access.isGlobalAdmin) {
    return res.status(403).json({ error: "Only global admins can set agency access groups." });
  }
  const idx = Number(req.params.index);
  const agencies = store.load();
  if (!Number.isInteger(idx) || !agencies[idx]) return res.status(404).json({ error: "Not found" });
  const raw = req.body?.allowedAdminGroupIds;
  const list = Array.isArray(raw)
    ? raw.map((id) => String(id).trim()).filter(Boolean)
    : [];
  const before = Array.isArray(agencies[idx].allowedAdminGroupIds)
    ? agencies[idx].allowedAdminGroupIds.slice()
    : [];
  agencies[idx].allowedAdminGroupIds = list;
  store.save(agencies);
  const agency = agencies[idx];
  auditSvc.logEvent({
    actor: req.authentikUser || null,
    request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
    action: "UPDATE_AGENCY_ACCESS_GROUPS",
    targetType: "agency",
    targetId: String(agency?.suffix || ""),
    details: {
      agencyName: String(agency?.name || ""),
      beforeCount: before.length,
      afterCount: list.length,
      beforeGroupIds: before,
      afterGroupIds: list,
      summary: `Updated extra admin-access groups for agency ${agency?.name || agency?.suffix || ""}.`,
    },
  });
  return res.json({ allowedAdminGroupIds: list });
});

// Resolve the computed admin group for an agency, even if the group is hidden from /api/groups.
// Returns: { group: { pk, name, ... } }
router.get("/:index/admin-group", async (req, res) => {
  try {
    const idx = Number(req.params.index);
    const agencies = store.load();
    if (!Number.isInteger(idx) || !agencies[idx]) return res.status(404).json({ error: "Not found" });

    const a = agencies[idx];
    const groupName = getAgencyAdminGroupName(a);
    if (!groupName) return res.status(400).json({ error: "Agency abbreviation is missing" });

    const g = await getGroupByNameUnfiltered(groupName);
    if (!g) return res.status(404).json({ error: `Admin group \"${groupName}\" was not found in Authentik.` });

    return res.json({ group: g });
  } catch (err) {
    return res.status(500).json({ error: err?.response?.data || err?.message || "Failed to resolve admin group" });
  }
});

function agencyErrorMessage(err, fallback) {
  const data = err?.response?.data;
  if (typeof data === "string" && data.trim()) return data;
  if (data && typeof data === "object") {
    if (typeof data.detail === "string" && data.detail.trim()) return data.detail;
    if (typeof data.error === "string" && data.error.trim()) return data.error;
  }
  return err?.message || fallback;
}

async function createAgencyFromPayload(body, opts = {}) {
  const actor = opts.actor || null;
  const requestInfo = opts.request || {};
  const agencies = store.load();
  const a = normalizeAgency(body || {});
  const sourceUserRequestId = String(body?.sourceUserRequestId || "").trim();
  let autoCreateResult = null;

  const err = validateAgency(a);
  if (err) {
    const e = new Error(err);
    e.statusCode = 400;
    throw e;
  }

  if (sourceUserRequestId) {
    const sourceRequest = userRequestsSvc.getById(sourceUserRequestId);
    if (!sourceRequest || String(sourceRequest.agencySuffix || "") !== "__other__") {
      const e = new Error("The pending Other agency request was not found");
      e.statusCode = 400;
      throw e;
    }
  }

  if (agencies.some((x) => String(x.suffix || "").toLowerCase() === a.suffix)) {
    const e = new Error("Suffix already exists");
    e.statusCode = 400;
    throw e;
  }

  const dupPrefix = store.assertUniqueGroupPrefix(agencies, a.groupPrefix);
  if (dupPrefix) {
    const e = new Error(dupPrefix);
    e.statusCode = 400;
    throw e;
  }

  const dupName = store.assertUniqueAgencyName(agencies, a.name);
  if (dupName) {
    const e = new Error(dupName);
    e.statusCode = 400;
    throw e;
  }

  try {
    await ensureAgencyAdminGroupExists(a);
    autoCreateResult = await autoCreateGroupsSvc.ensureAutoCreateGroupsForAgency(
      a,
      actor
    );
  } catch (groupErr) {
    const e = new Error(
      agencyErrorMessage(groupErr, "Failed to create required agency groups")
    );
    e.statusCode = 400;
    throw e;
  }

  let dsResult = null;
  try {
    dsResult = await autoCreateDataSyncSvc.ensureAutoCreateDataSyncForAgency(a);
  } catch (dsErr) {
    console.warn(
      "[agencies] Auto Create Data Sync failed:",
      dsErr?.message || dsErr
    );
  }

  agencies.push(a);
  store.save(agencies);

  const mainGroupResult = autoCreateResult?.mainGroup || null;

  const linkedRequest = sourceUserRequestId
    ? userRequestsSvc.markAgencyCreated(
        sourceUserRequestId,
        a,
        mainGroupResult?.name
      )
    : null;

  const newlyCreated = Array.isArray(autoCreateResult?.createdGroups)
    ? autoCreateResult.createdGroups
    : [];
  for (const created of newlyCreated) {
    const createdGroup = created.group || {};
    auditSvc.logEvent({
      actor,
      request: requestInfo,
      action: "CREATE_GROUP",
      targetType: "group",
      targetId: String(createdGroup.pk || createdGroup.id || ""),
      details: {
        name: createdGroup.name || created.name,
        description: null,
        private: "no",
        created_type: created.created_type || null,
        created_type_detail: created.created_type_detail || null,
      },
    });
  }

  const createdMissions = Array.isArray(dsResult?.createdMissions)
    ? dsResult.createdMissions
    : [];
  for (const m of createdMissions) {
    auditSvc.logEvent({
      actor,
      request: requestInfo,
      action: "DATA_SYNC_MISSION_CREATED",
      targetType: "data_sync_mission",
      targetId: String(m.missionName || ""),
      details: {
        missionName: m.missionName || null,
        groupName: m.groupName || null,
        scope: m.scope || null,
        autoCreate: true,
      },
    });
  }
  const dsErrors = (Array.isArray(dsResult?.results) ? dsResult.results : []).filter(
    (r) => r && r.reason === "error"
  );
  if (dsErrors.length) {
    console.warn(
      "[agencies] Auto Create Data Sync errors:",
      dsErrors.map((e) => e.error || e.missionName).join("; ")
    );
  }

  auditSvc.logEvent({
    actor,
    request: requestInfo,
    action: "CREATE_AGENCY",
    targetType: "agency",
    targetId: String(a?.suffix || ""),
    details: a,
  });

  const mainGroup = mainGroupResult
    ? {
        name: mainGroupResult.name,
        pk: mainGroupResult.group?.pk ?? mainGroupResult.group?.id ?? null,
        created: !!mainGroupResult.created,
      }
    : null;

  return {
    success: true,
    mainGroup,
    createdAgency: linkedRequest?.createdAgency || null,
  };
}

router.post("/", async (req, res) => {
  try {
    const result = await createAgencyFromPayload(req.body || {}, {
      actor: req.authentikUser || null,
      request: {
        method: req.method,
        path: req.originalUrl || req.path,
        ip: req.ip,
      },
    });
    return res.json({
      success: true,
      mainGroup: result.mainGroup,
      createdAgency: result.createdAgency,
    });
  } catch (err) {
    return res.status(err.statusCode || 400).json({
      error: err?.message || "Failed to create agency",
    });
  }
});

/** Must match the create-agency color dropdown in views/agencies.ejs */
const ALLOWED_AGENCY_COLORS = new Set([
  "Blue",
  "Dark Blue",
  "Brown",
  "Cyan",
  "Green",
  "Dark Green",
  "Magenta",
  "Maroon",
  "Orange",
  "Purple",
  "Red",
  "Teal",
  "White",
  "Yellow",
]);

router.post("/import-csv", upload.single("file"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "No CSV file uploaded" });
    }

    const rawText = String(req.file.buffer.toString("utf8") || "");
    const text = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;
    const lines = text
      .split(/\r?\n/)
      .map((l) => String(l || "").trim())
      .filter(Boolean);

    if (lines.length < 2) {
      return res.status(400).json({
        error: "CSV must include a header row and at least one data row",
      });
    }

    const header = parseCsvLine(lines[0]).map((h) => String(h || "").trim());
    const normalizedHeader = header.map((h) => h.toLowerCase());
    const requiredColumns = [
      { key: "name", label: "Agency Full Name", aliases: ["agency full name", "name"] },
      {
        key: "groupPrefix",
        label: "Agency Abbreviation / Short Name",
        aliases: [
          "agency abbreviation / short name",
          "agency abbreviation",
          "agency short name",
          "groupprefix",
          "abbreviation",
          "short name",
        ],
      },
      {
        key: "suffix",
        label: "Username Identifier",
        aliases: [
          "username identifier",
          "username suffix",
          "username prefix",
          "suffix",
          "prefix",
        ],
      },
      { key: "state", label: "State", aliases: ["state"] },
      { key: "county", label: "County", aliases: ["county"] },
      {
        key: "countyAbbrev",
        label: "County Abbreviation",
        aliases: ["county abbreviation", "countyabbrev", "county abbrev"],
      },
      { key: "type", label: "Agency Type", aliases: ["agency type", "type"] },
      { key: "color", label: "Agency Color", aliases: ["agency color", "color"] },
    ];
    const optionalColumns = [
      {
        key: "usernameTokenPlacement",
        label: "Username Agency Identifier",
        aliases: [
          "username agency identifier",
          "username token placement",
          "usernametokenplacement",
          "token placement",
          "placement",
        ],
      },
      {
        key: "stateFederalAgency",
        label: "State/Federal Agency",
        aliases: [
          "state/federal agency",
          "state federal agency",
          "statefederalagency",
          "state/federal",
          "state federal",
        ],
      },
      {
        key: "region",
        label: "Region",
        aliases: ["region", "region name", "regionid", "region id"],
      },
    ];

    const columnIndexes = new Map();
    for (const col of requiredColumns) {
      const idx = normalizedHeader.findIndex((h) => col.aliases.includes(h));
      if (idx < 0) {
        return res.status(400).json({ error: `Missing required column: ${col.label}` });
      }
      columnIndexes.set(col.key, idx);
    }
    for (const col of optionalColumns) {
      const idx = normalizedHeader.findIndex((h) => col.aliases.includes(h));
      if (idx >= 0) columnIndexes.set(col.key, idx);
    }

    function get(parts, key) {
      const idx = columnIndexes.get(key);
      return Number.isInteger(idx) ? String(parts[idx] ?? "").trim() : "";
    }

    const allAgencyTypes = new Set(agencyTypesSvc.getAgencyTypeOptions());
    const allAgencies = store.load();
    const visibleAgencies = accessSvc.filterAgenciesForUser(req.authentikUser, allAgencies);
    const allowedSuffixes = new Set(
      visibleAgencies.map((a) => String(a?.suffix || "").trim().toLowerCase()).filter(Boolean)
    );

    const existingSuffixes = new Set(
      allAgencies.map((a) => String(a?.suffix || "").trim().toLowerCase()).filter(Boolean)
    );
    const seenIncomingSuffixes = new Set();
    const existingPrefixes = new Set(
      allAgencies.map((a) => store.groupPrefixKey(a?.groupPrefix)).filter(Boolean)
    );
    const seenIncomingPrefixes = new Set();
    const existingNames = new Set(
      allAgencies.map((a) => store.agencyNameKey(a?.name)).filter(Boolean)
    );
    const seenIncomingNames = new Set();

    const created = [];
    const skipped = [];
    const failed = [];

    for (let i = 1; i < lines.length; i++) {
      const parts = parseCsvLine(lines[i]);
      const line = i + 1;

      const name = get(parts, "name");
      const groupPrefix = store.normalizeGroupPrefix(get(parts, "groupPrefix"));
      const suffix = get(parts, "suffix").toLowerCase();
      const state = get(parts, "state").toUpperCase();
      const county = normalizeCountyName(get(parts, "county"));
      const countyAbbrev = get(parts, "countyAbbrev").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const type = get(parts, "type");
      const color = get(parts, "color");
      const usernameTokenPlacement = get(parts, "usernameTokenPlacement") || "suffix";
      const stateFederalAgency = get(parts, "stateFederalAgency") || "no";
      const region = get(parts, "region");

      const candidate = normalizeAgency({
        name,
        groupPrefix,
        suffix,
        state,
        county,
        countyAbbrev,
        type,
        color,
        usernameTokenPlacement,
        stateFederalAgency,
        region,
      });

      const rowErrors = [];
      const baseErr = validateAgency(candidate);
      if (baseErr) rowErrors.push(baseErr);
      if (candidate.suffix && !/^[a-z0-9_-]+$/.test(candidate.suffix)) {
        rowErrors.push(
          "Username identifier can only contain lowercase letters, numbers, dashes, and underscores"
        );
      }
      if (candidate.state && !ALLOWED_STATES.has(candidate.state)) {
        rowErrors.push(`Invalid state "${candidate.state}"`);
      }
      if (candidate.type && !allAgencyTypes.has(candidate.type)) {
        rowErrors.push(`Invalid agency type "${candidate.type}"`);
      }
      if (candidate.color && !ALLOWED_AGENCY_COLORS.has(candidate.color)) {
        rowErrors.push(`Invalid agency color "${candidate.color}"`);
      }
      const placementRaw = String(usernameTokenPlacement || "").trim().toLowerCase();
      if (
        placementRaw &&
        !["suffix", "prefix", "start", "before", "leading", "end", "after"].includes(placementRaw)
      ) {
        rowErrors.push(
          'Username Agency Identifier must be "suffix" or "prefix"'
        );
      }
      const sfRaw = String(stateFederalAgency || "").trim().toLowerCase();
      if (
        sfRaw &&
        !["yes", "no", "true", "false", "1", "0", "y", "n"].includes(sfRaw)
      ) {
        rowErrors.push('State/Federal Agency must be "Yes" or "No"');
      }

      if (rowErrors.length) {
        failed.push({
          line,
          suffix: candidate.suffix || undefined,
          messages: rowErrors,
        });
        continue;
      }

      if (!accessSvc.isSuffixAllowed(req.authentikUser, candidate.suffix)) {
        failed.push({
          line,
          suffix: candidate.suffix,
          messages: [`You do not have access to create agency suffix "${candidate.suffix}"`],
        });
        continue;
      }

      if (existingSuffixes.has(candidate.suffix)) {
        skipped.push({
          line,
          suffix: candidate.suffix,
          reason: "Suffix already exists",
        });
        continue;
      }

      if (seenIncomingSuffixes.has(candidate.suffix)) {
        skipped.push({
          line,
          suffix: candidate.suffix,
          reason: "Duplicate suffix in CSV",
        });
        continue;
      }

      const prefixKey = store.groupPrefixKey(candidate.groupPrefix);
      if (existingPrefixes.has(prefixKey)) {
        skipped.push({
          line,
          suffix: candidate.suffix,
          reason: "Agency abbreviation / short name already exists",
        });
        continue;
      }
      if (seenIncomingPrefixes.has(prefixKey)) {
        skipped.push({
          line,
          suffix: candidate.suffix,
          reason: "Duplicate agency abbreviation / short name in CSV",
        });
        continue;
      }

      const nameKey = store.agencyNameKey(candidate.name);
      if (existingNames.has(nameKey)) {
        skipped.push({
          line,
          suffix: candidate.suffix,
          reason: "Agency name already exists",
        });
        continue;
      }
      if (seenIncomingNames.has(nameKey)) {
        skipped.push({
          line,
          suffix: candidate.suffix,
          reason: "Duplicate agency name in CSV",
        });
        continue;
      }

      try {
        await ensureAgencyAdminGroupExists(candidate);
        // Groups must exist before Data Sync missions are created.
        await autoCreateGroupsSvc.ensureAutoCreateGroupsForAgency(
          candidate,
          req.authentikUser || null
        );
        try {
          await autoCreateDataSyncSvc.ensureAutoCreateDataSyncForAgency(candidate);
        } catch (dsErr) {
          console.warn(
            "[agencies/import-csv] Auto Create Data Sync failed for",
            candidate.suffix,
            dsErr?.message || dsErr
          );
        }
        allAgencies.push(candidate);
        existingSuffixes.add(candidate.suffix);
        seenIncomingSuffixes.add(candidate.suffix);
        existingPrefixes.add(prefixKey);
        seenIncomingPrefixes.add(prefixKey);
        existingNames.add(nameKey);
        seenIncomingNames.add(nameKey);
        created.push({
          line,
          suffix: candidate.suffix,
          name: candidate.name,
        });
      } catch (err) {
        failed.push({
          line,
          suffix: candidate.suffix,
          messages: [
            err?.response?.data?.detail ||
              err?.response?.data ||
              err?.message ||
              "Failed to create agency groups",
          ],
        });
      }
    }

    if (created.length) {
      store.save(allAgencies);
      auditSvc.logEvent({
        actor: req.authentikUser || null,
        request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
        action: "IMPORT_AGENCIES_CSV",
        targetType: "agency",
        targetId: "bulk",
        details: {
          created: created.length,
          skipped: skipped.length,
          failed: failed.length,
          createdSuffixes: created.map((x) => x.suffix),
        },
      });
    }

    return res.json({
      success: true,
      count: created.length,
      created,
      skipped,
      failed,
    });
  } catch (err) {
    return res.status(400).json({
      error: err?.response?.data?.detail || err?.response?.data || err?.message || "CSV import failed",
    });
  }
});

router.patch("/:index/color", (req, res) => {
  const idx = Number(req.params.index);
  const agencies = store.load();
  if (!Number.isInteger(idx) || !agencies[idx]) {
    return res.status(404).json({ error: "Not found" });
  }

  const agency = agencies[idx];
  if (!accessSvc.isSuffixAllowed(req.authentikUser, agency.suffix)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const raw = String(req.body?.color ?? "").trim();
  if (!raw || !ALLOWED_AGENCY_COLORS.has(raw)) {
    return res.status(400).json({ error: "Invalid color" });
  }

  const before = String(agency.color || "").trim();
  if (before === raw) {
    return res.json({ success: true, color: raw });
  }

  agencies[idx] = { ...agency, color: raw };
  store.save(agencies);

  auditSvc.logEvent({
    actor: req.authentikUser || null,
    request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
    action: "UPDATE_AGENCY_COLOR",
    targetType: "agency",
    targetId: String(agency.suffix || ""),
    details: { before, after: raw },
  });

  res.json({ success: true, color: raw });
});

router.patch("/:index/type", (req, res) => {
  const idx = Number(req.params.index);
  const agencies = store.load();
  if (!Number.isInteger(idx) || !agencies[idx]) {
    return res.status(404).json({ error: "Not found" });
  }

  const agency = agencies[idx];
  if (!accessSvc.isSuffixAllowed(req.authentikUser, agency.suffix)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const allowed = new Set(agencyTypesSvc.getAgencyTypeOptions());
  const raw = String(req.body?.type ?? "").trim();
  if (!raw || !allowed.has(raw)) {
    return res.status(400).json({ error: "Invalid agency type" });
  }

  const before = String(agency.type || "").trim();
  if (before === raw) {
    return res.json({ success: true, type: raw });
  }

  agencies[idx] = { ...agency, type: raw };
  store.save(agencies);

  auditSvc.logEvent({
    actor: req.authentikUser || null,
    request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
    action: "UPDATE_AGENCY_TYPE",
    targetType: "agency",
    targetId: String(agency.suffix || ""),
    details: { before, after: raw },
  });

  res.json({ success: true, type: raw });
});

router.patch("/:index/region", (req, res) => {
  const idx = Number(req.params.index);
  const agencies = store.load();
  if (!Number.isInteger(idx) || !agencies[idx]) {
    return res.status(404).json({ error: "Not found" });
  }

  const agency = agencies[idx];
  if (!accessSvc.isSuffixAllowed(req.authentikUser, agency.suffix)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const lockedId = regionsSvc.lockedRegionIdForAgency(agency);
  if (lockedId) {
    return res.status(400).json({
      error: "Region is assigned for this agency's location",
      regionId: lockedId,
      regionName: regionsSvc.getRegionName(lockedId) || null,
      locked: true,
    });
  }

  let nextId = null;
  const raw =
    req.body?.regionId != null ? req.body.regionId : req.body?.region;
  try {
    nextId = regionsSvc.resolveRegionId(raw);
  } catch (err) {
    return res.status(400).json({ error: err?.message || "Invalid region" });
  }

  const before = String(agency.regionId || "").trim() || null;
  if (before === nextId) {
    return res.json({
      success: true,
      regionId: nextId,
      regionName: nextId ? regionsSvc.getRegionName(nextId) : null,
    });
  }

  const next = { ...agency };
  if (nextId) next.regionId = nextId;
  else delete next.regionId;
  agencies[idx] = next;
  store.save(agencies);

  auditSvc.logEvent({
    actor: req.authentikUser || null,
    request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
    action: "UPDATE_AGENCY_REGION",
    targetType: "agency",
    targetId: String(agency.suffix || ""),
    details: {
      before,
      after: nextId,
      regionName: nextId ? regionsSvc.getRegionName(nextId) : null,
    },
  });

  res.json({
    success: true,
    regionId: nextId,
    regionName: nextId ? regionsSvc.getRegionName(nextId) : null,
  });
});

router.patch("/:index/state-federal", (req, res) => {
  const idx = Number(req.params.index);
  const agencies = store.load();
  if (!Number.isInteger(idx) || !agencies[idx]) {
    return res.status(404).json({ error: "Not found" });
  }

  const agency = agencies[idx];
  if (!accessSvc.isSuffixAllowed(req.authentikUser, agency.suffix)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const sfRaw = String(req.body?.stateFederalAgency ?? "").trim().toLowerCase();
  const next =
    req.body?.stateFederalAgency === true ||
    sfRaw === "yes" ||
    sfRaw === "true" ||
    sfRaw === "1";

  const before = !!agency.stateFederalAgency;
  if (before === next) {
    return res.json({ success: true, stateFederalAgency: next });
  }

  agencies[idx] = { ...agency, stateFederalAgency: next };
  store.save(agencies);

  auditSvc.logEvent({
    actor: req.authentikUser || null,
    request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
    action: "UPDATE_AGENCY_STATE_FEDERAL",
    targetType: "agency",
    targetId: String(agency.suffix || ""),
    details: { before, after: next },
  });

  return res.json({ success: true, stateFederalAgency: next });
});

router.post("/:index/rename-agency-name", async (req, res) => {
  try {
    const idx = Number(req.params.index);
    const agencies = store.load();
    if (!Number.isInteger(idx) || !agencies[idx]) {
      return res.status(404).json({ error: "Not found" });
    }

    const agency = agencies[idx];
    if (!accessSvc.isSuffixAllowed(req.authentikUser, agency.suffix)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const validationErr = agencyNameRenameSvc.validateNewAgencyName(
      req.body?.name,
      agencies,
      idx
    );
    if (validationErr) {
      return res.status(400).json({ error: validationErr });
    }

    const beforeName = String(agency.name || "").trim();
    const result = await agencyNameRenameSvc.renameAgencyName(idx, req.body.name);

    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "RENAME_AGENCY_NAME",
      targetType: "agency",
      targetId: String(agency.suffix || ""),
      details: {
        suffix: agency.suffix,
        before: beforeName,
        after: result.newName,
        usersUpdated: result.usersUpdated,
        adminGroupUpdated: result.adminGroupUpdated,
        groupsUpdated: result.groupsUpdated,
        requestsUpdated: result.requestsUpdated,
        skipped: !!result.skipped,
      },
    });

    return res.json({
      success: true,
      usersUpdated: result.usersUpdated,
      usersMatched: result.usersMatched,
      adminGroupUpdated: result.adminGroupUpdated,
      groupsUpdated: result.groupsUpdated,
      requestsUpdated: result.requestsUpdated,
      oldName: result.oldName,
      newName: result.newName,
      skipped: !!result.skipped,
    });
  } catch (err) {
    const msg =
      err?.response?.data?.detail ||
      err?.response?.data ||
      err?.message ||
      "Failed to rename agency";
    return res.status(500).json({ error: msg });
  }
});

router.post("/:index/rename-group-prefix", async (req, res) => {
  try {
    const idx = Number(req.params.index);
    const agencies = store.load();
    if (!Number.isInteger(idx) || !agencies[idx]) {
      return res.status(404).json({ error: "Not found" });
    }

    const agency = agencies[idx];
    if (!accessSvc.isSuffixAllowed(req.authentikUser, agency.suffix)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const validationErr = agencyAbbrevRenameSvc.validateNewGroupPrefix(req.body?.groupPrefix);
    if (validationErr) {
      return res.status(400).json({ error: validationErr });
    }

    const beforeAbbr = store.normalizeGroupPrefix(agency.groupPrefix);
    const result = await agencyAbbrevRenameSvc.renameAgencyGroupPrefix(
      idx,
      req.body.groupPrefix
    );

    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "RENAME_AGENCY_GROUP_PREFIX",
      targetType: "agency",
      targetId: String(agency.suffix || ""),
      details: {
        agencyName: result.agencyName || agency.name,
        before: beforeAbbr,
        after: result.newPrefix,
        usersUpdated: result.usersUpdated,
        adminGroupRenamed: result.adminGroupRenamed,
        groupsRenamed: result.groupsRenamed,
        templatesUpdated: result.templatesUpdated,
        currentTemplatesReconciled: result.currentTemplatesReconciled,
        skipped: !!result.skipped,
      },
    });

    return res.json({
      success: true,
      usersUpdated: result.usersUpdated,
      usersMatched: result.usersMatched,
      adminGroupRenamed: result.adminGroupRenamed,
      groupsRenamed: result.groupsRenamed,
      templatesUpdated: result.templatesUpdated,
      currentTemplatesReconciled: result.currentTemplatesReconciled,
      oldPrefix: result.oldPrefix,
      newPrefix: result.newPrefix,
      skipped: !!result.skipped,
    });
  } catch (err) {
    const msg =
      err?.response?.data?.detail ||
      err?.response?.data ||
      err?.message ||
      "Failed to rename agency abbreviation";
    return res.status(500).json({ error: msg });
  }
});

router.put("/:index", async (req, res) => {
  const idx = Number(req.params.index);
  const agencies = store.load();
  if (!Number.isInteger(idx) || !agencies[idx]) return res.status(404).json({ error: "Not found" });

  const existing = agencies[idx];
  const a = normalizeAgency(req.body || {});
  // Preserve allowedAdminGroupIds if not sent in body (main edit form does not send them)
  if (!Array.isArray(req.body?.allowedAdminGroupIds)) {
    a.allowedAdminGroupIds = Array.isArray(existing.allowedAdminGroupIds) ? existing.allowedAdminGroupIds : [];
  }
  const body = req.body || {};
  if (!("lookupEnabled" in body)) a.lookupEnabled = existing.lookupEnabled;
  if (!("lookupDomain" in body)) a.lookupDomain = existing.lookupDomain;
  if (!("autoApproveRequests" in body)) a.autoApproveRequests = existing.autoApproveRequests === true;
  if (!("isActive" in body)) a.isActive = existing.isActive;
  if (!("usernameTokenPlacement" in body) && !("usernameSuffixPlacement" in body)) {
    a.usernameTokenPlacement = accessSvc.normalizeUsernameTokenPlacement(
      existing.usernameTokenPlacement ?? existing.usernameSuffixPlacement ?? "suffix"
    );
  }
  if (!("agencyDisabledUserIds" in body)) {
    a.agencyDisabledUserIds = Array.isArray(existing.agencyDisabledUserIds)
      ? existing.agencyDisabledUserIds
      : [];
  }
  if (!("regionId" in body) && !("region" in body)) {
    if (existing.regionId) a.regionId = existing.regionId;
  }
  const lockedId = regionsSvc.lockedRegionIdForAgency(a);
  if (lockedId) a.regionId = lockedId;
  const err = validateAgency(a);
  if (err) return res.status(400).json({ error: err });

  // uniqueness check excluding itself
  if (agencies.some((x, i) =>
    i !== idx && String(x.suffix || "").toLowerCase() === a.suffix
  )) {
    return res.status(400).json({ error: "Suffix already exists" });
  }

  const dupPrefix = store.assertUniqueGroupPrefix(agencies, a.groupPrefix, idx);
  if (dupPrefix) return res.status(400).json({ error: dupPrefix });

  const dupName = store.assertUniqueAgencyName(agencies, a.name, idx);
  if (dupName) return res.status(400).json({ error: dupName });

  try {
    // If the abbreviation changed (or group is missing), create the new admin group.
    await ensureAgencyAdminGroupExists(a);
  } catch (err) {
    return res.status(400).json({
      error: err?.response?.data || err?.message || "Failed to ensure agency admin group",
    });
  }

  const before = agencies[idx];
  agencies[idx] = a;
  store.save(agencies);

  auditSvc.logEvent({
    actor: req.authentikUser || null,
    request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
    action: "UPDATE_AGENCY",
    targetType: "agency",
    targetId: String(a?.suffix || before?.suffix || ""),
    details: { before, after: a },
  });

  res.json({ success: true });
});

// Update county abbreviation for an agency and rename its admin group accordingly.
router.put("/:index/county-abbrev", async (req, res) => {
  try {
    const idx = Number(req.params.index);
    const agencies = store.load();
    if (!Number.isInteger(idx) || !agencies[idx]) {
      return res.status(404).json({ error: "Not found" });
    }

    const raw = String(req.body?.countyAbbrev || "").trim().toUpperCase();
    const agency = agencies[idx];
    const allowEmpty = !!agency?.stateFederalAgency;
    if (!raw) {
      if (!allowEmpty) {
        return res.status(400).json({ error: "County abbreviation is required" });
      }
    } else if (raw.length < 2) {
      return res.status(400).json({ error: "County abbreviation must be at least 2 characters" });
    } else if (!/^[A-Z0-9]+$/.test(raw)) {
      return res.status(400).json({ error: "County abbreviation must contain only letters and numbers" });
    }

    const abbr = store.normalizeGroupPrefix(agency?.groupPrefix);
    if (!abbr) {
      return res.status(400).json({ error: "Agency abbreviation / short name is missing" });
    }

    const oldCountyAbbrev = String(agency.countyAbbrev || "").trim().toUpperCase();
    const newCountyAbbrev = raw;

    // Normalize target county/state for matching
    const targetCounty = String(agency.county || "").trim().toLowerCase();
    const targetState = String(agency.state || "").trim().toUpperCase();

    const matchingIndexes = [];
    if (!newCountyAbbrev) {
      // Clearing abbrev (State/Federal only): update this agency alone so peers keep theirs.
      matchingIndexes.push(idx);
    } else {
      for (let i = 0; i < agencies.length; i++) {
        const ag = agencies[i];
        if (!ag) continue;
        const c = String(ag.county || "").trim().toLowerCase();
        const s = String(ag.state || "").trim().toUpperCase();
        if (c === targetCounty && s === targetState) matchingIndexes.push(i);
      }
    }

    const allAlreadySet = matchingIndexes.every((i) => {
      const prev = String(agencies[i]?.countyAbbrev || "").trim().toUpperCase();
      return prev === newCountyAbbrev;
    });
    if (allAlreadySet) {
      return res.json({
        success: true,
        skipped: true,
        countyAbbrev: newCountyAbbrev,
        updatedIndexes: matchingIndexes,
      });
    }

    let anyRenamed = false;
    const updatedIndexes = [];
    const failedEnsures = [];

    // For each agency with the same county+state, update countyAbbrev and rename/ensure its admin group.
    for (const i of matchingIndexes) {
      const ag = agencies[i];
      if (!ag) continue;

      const gp = store.normalizeGroupPrefix(ag.groupPrefix);
      if (!gp) continue;

      const prevCountyAbbrev = String(ag.countyAbbrev || "").trim().toUpperCase();
      const desiredName = newCountyAbbrev
        ? `authentik-${newCountyAbbrev}-${gp}-AgencyAdmin`
        : `authentik-${gp}-AgencyAdmin`;

      if (prevCountyAbbrev !== newCountyAbbrev) {
        const candidates = [];
        if (prevCountyAbbrev) {
          candidates.push(`authentik-${prevCountyAbbrev}-${gp}-AgencyAdmin`);
        }
        // Legacy pattern with no county abbreviation in name
        candidates.push(`authentik-${gp}-AgencyAdmin`);

        let renamedThis = false;
        for (const oldName of candidates) {
          if (oldName === desiredName) continue;
          const g = await getGroupByNameUnfiltered(oldName);
          if (g && g.pk != null) {
            try {
              const detail = String(ag?.name || "").trim();
              await groupsService.patchGroupNameAndCn(g.pk, desiredName, {
                skipActionLock: true,
                attributes: {
                  created_type: "Agency",
                  created_type_detail: detail || null,
                  description: `Agency admin group for ${detail || gp}`,
                },
              });
              renamedThis = true;
              anyRenamed = true;
              break;
            } catch (e) {
              // If rename fails, fall through to create/ensure below.
            }
          }
        }

        if (!renamedThis) {
          // Ensure the admin group exists for this agency (idempotent, best-effort).
          try {
            await ensureAgencyAdminGroupExists({ ...ag, countyAbbrev: newCountyAbbrev });
          } catch (err) {
            failedEnsures.push({
              index: i,
              suffix: String(ag.suffix || ""),
              error: err?.response?.data || err?.message || "Failed to ensure agency admin group",
            });
          }
        }
      }

      // Update JSON with new county abbreviation for this agency
      ag.countyAbbrev = newCountyAbbrev;
      agencies[i] = ag;
      updatedIndexes.push(i);
    }

    store.save(agencies);
    groupsService.invalidateGroupsCache();

    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "UPDATE_AGENCY_COUNTY_ABBREV",
      targetType: "agency",
      targetId: String(agency?.suffix || ""),
      details: {
        before: { countyAbbrev: oldCountyAbbrev || null },
        after: { countyAbbrev: newCountyAbbrev },
        groupRenamed: anyRenamed,
        failedEnsures,
        updatedIndexes,
      },
    });

    return res.json({
      success: true,
      groupRenamed: anyRenamed,
      countyAbbrev: newCountyAbbrev,
      failedEnsures,
    });
  } catch (err) {
    return res.status(500).json({
      error: err?.response?.data || err?.message || "Failed to update county abbreviation",
    });
  }
});

// Update county full name for all agencies in the same state and rename county TAK groups.
router.put("/:index/county-name", async (req, res) => {
  try {
    const idx = Number(req.params.index);
    const agencies = store.load();
    if (!Number.isInteger(idx) || !agencies[idx]) {
      return res.status(404).json({ error: "Not found" });
    }

    const result = await countyNameRenameSvc.renameCountyName(idx, req.body?.county);

    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "UPDATE_AGENCY_COUNTY_NAME",
      targetType: "agency",
      targetId: String(agencies[idx]?.suffix || ""),
      details: {
        before: { county: result.oldCounty || null, state: result.state || null },
        after: { county: result.newCounty || null, state: result.state || null },
        groupsRenamed: result.groupsRenamed ?? 0,
        updatedIndexes: result.updatedIndexes || [],
        skipped: !!result.skipped,
      },
    });

    return res.json({
      success: true,
      skipped: !!result.skipped,
      county: result.newCounty,
      state: result.state,
      groupsRenamed: result.groupsRenamed ?? 0,
      updatedIndexes: result.updatedIndexes || [],
    });
  } catch (err) {
    return res.status(400).json({
      error: err?.response?.data || err?.message || "Failed to update county name",
    });
  }
});

router.get("/:index/active-preview", async (req, res) => {
  try {
    const idx = Number(req.params.index);
    const agencies = store.load();
    if (!Number.isInteger(idx) || !agencies[idx]) {
      return res.status(404).json({ error: "Not found" });
    }

    const preview = await agencyActiveSvc.getAgencyActiveChangePreview(idx);
    return res.json(preview);
  } catch (err) {
    return res.status(400).json({
      error: err?.response?.data || err?.message || "Failed to preview agency status change",
    });
  }
});

router.put("/:index/active", async (req, res) => {
  try {
    const idx = Number(req.params.index);
    const agencies = store.load();
    if (!Number.isInteger(idx) || !agencies[idx]) {
      return res.status(404).json({ error: "Not found" });
    }

    const isActive = !!req.body?.is_active;
    const before = agencies[idx];
    const result = await agencyActiveSvc.setAgencyActive(idx, isActive);

    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: isActive ? "ENABLE_AGENCY" : "DISABLE_AGENCY",
      targetType: "agency",
      targetId: String(before?.suffix || ""),
      details: {
        agencyName: String(before?.name || "").trim(),
        beforeActive: store.isAgencyActive(before),
        afterActive: !!result.isActive,
        usersUpdated: result.usersUpdated ?? 0,
        skipped: !!result.skipped,
      },
    });

    return res.json({
      success: true,
      skipped: !!result.skipped,
      is_active: !!result.isActive,
      usersUpdated: result.usersUpdated ?? 0,
    });
  } catch (err) {
    return res.status(400).json({
      error: err?.response?.data || err?.message || "Failed to update agency status",
    });
  }
});

// Update state code for agencies matching the same state, county, and county abbreviation.
router.put("/:index/state", async (req, res) => {
  try {
    const idx = Number(req.params.index);
    const agencies = store.load();
    if (!Number.isInteger(idx) || !agencies[idx]) {
      return res.status(404).json({ error: "Not found" });
    }

    const result = await stateCodeRenameSvc.renameStateCode(idx, req.body?.state);

    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "UPDATE_AGENCY_STATE",
      targetType: "agency",
      targetId: String(agencies[idx]?.suffix || ""),
      details: {
        before: {
          state: result.oldState || null,
          county: result.county || null,
          countyAbbrev: result.countyAbbrev || null,
        },
        after: { state: result.newState || null },
        groupsRenamed: result.groupsRenamed ?? 0,
        stateGroupsRenamed: !!result.stateGroupsRenamed,
        updatedIndexes: result.updatedIndexes || [],
        skipped: !!result.skipped,
      },
    });

    return res.json({
      success: true,
      skipped: !!result.skipped,
      state: result.newState,
      county: result.county,
      countyAbbrev: result.countyAbbrev,
      groupsRenamed: result.groupsRenamed ?? 0,
      stateGroupsRenamed: !!result.stateGroupsRenamed,
      updatedIndexes: result.updatedIndexes || [],
    });
  } catch (err) {
    return res.status(400).json({
      error: err?.response?.data || err?.message || "Failed to update state",
    });
  }
});

router.get("/:index/delete-preview", async (req, res) => {
  try {
    const idx = Number(req.params.index);
    const agencies = store.load();
    if (!Number.isInteger(idx) || !agencies[idx]) {
      return res.status(404).json({ error: "Not found" });
    }

    const preview = await agencyDeleteSvc.getAgencyDeletePreview(idx);
    return res.json(preview);
  } catch (err) {
    return res.status(400).json({
      error: err?.response?.data || err?.message || "Failed to preview agency deletion",
    });
  }
});

router.delete("/:index", async (req, res) => {
  try {
    const idx = Number(req.params.index);
    const agencies = store.load();
    if (!Number.isInteger(idx) || !agencies[idx]) {
      return res.status(404).json({ error: "Not found" });
    }

    const before = agencies[idx];
    const result = await agencyDeleteSvc.deleteAgency(idx);

    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "DELETE_AGENCY",
      targetType: "agency",
      targetId: String(before?.suffix || ""),
      details: {
        agencyName: result.agencyName,
        usersDeleted: result.usersDeleted,
        integrationsDeleted: result.integrationsDeleted,
        agencyGroupsDeleted: result.agencyGroupsDeleted,
        countyGroupsDeleted: result.countyGroupsDeleted,
        stateGroupsDeleted: result.stateGroupsDeleted,
        templatesRemoved: result.templatesRemoved,
        pendingRequestsRemoved: result.pendingRequestsRemoved,
        deletedCountyGroups: result.deletedCountyGroups,
        deletedStateGroups: result.deletedStateGroups,
        before,
      },
    });

    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({
      error: err?.response?.data || err?.message || "Failed to delete agency",
    });
  }
});


// Save approved email domains only (same JSON field lookupDomain; comma-separated). Does not change lookupEnabled.
router.post("/:index/lookup/domain", (req, res) => {
  const idx = Number(req.params.index);
  if (!Number.isInteger(idx)) {
    return res.status(400).json({ error: "Invalid agency index" });
  }

  const agencies = store.load();
  if (!agencies[idx]) {
    return res.status(404).json({ error: "Agency not found" });
  }

  let normalized;
  try {
    normalized = store.normalizeLookupDomainString(req.body?.lookupDomain ?? "");
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Invalid domain list" });
  }

  const agency = agencies[idx];
  const beforeDomain = String(agency.lookupDomain || "");
  agencies[idx].lookupDomain = normalized;

  store.save(agencies);

  auditSvc.logEvent({
    actor: req.authentikUser || null,
    request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
    action: "UPDATE_AGENCY_LOOKUP_DOMAIN",
    targetType: "agency",
    targetId: String(agency?.suffix || ""),
    details: {
      beforeDomain,
      afterDomain: normalized,
      lookupEnabled: agency.lookupEnabled === true,
    },
  });

  return res.json({ success: true, lookupDomain: normalized });
});

// Enable Lookup (by index). Domains from body.lookupDomain or legacy body.domain (comma-separated).
router.post("/:index/lookup/enable", (req, res) => {
  const idx = Number(req.params.index);
  const raw = req.body?.lookupDomain ?? req.body?.domain;

  if (!Number.isInteger(idx)) {
    return res.status(400).json({ error: "Invalid agency index" });
  }

  let normalized;
  try {
    normalized = store.normalizeLookupDomainString(raw ?? "");
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Invalid domain list" });
  }

  if (!normalized) {
    return res.status(400).json({ error: "At least one valid domain is required to enable lookup" });
  }

  const agencies = store.load();

  if (!agencies[idx]) {
    return res.status(404).json({ error: "Agency not found" });
  }

  const agency = agencies[idx];
  if (!store.isAgencyPublicEnrollmentEligible(agency)) {
    return res.status(400).json({
      error: "Enable the agency before enabling account lookup.",
    });
  }

  agencies[idx].lookupEnabled = true;
  agencies[idx].lookupDomain = normalized;

  store.save(agencies);

  auditSvc.logEvent({
    actor: req.authentikUser || null,
    request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
    action: "ENABLE_AGENCY_LOOKUP",
    targetType: "agency",
    targetId: String(agency?.suffix || ""),
    details: {
      lookupDomain: normalized,
      summary: `Enabled enrollment lookup for agency ${agency?.name || agency?.suffix || ""}.`,
    },
  });

  return res.json({ success: true });
});


// Disable Lookup (by index). Keeps lookupDomain for request-access restrictions and future re-enable.
router.post("/:index/lookup/disable", (req, res) => {
  const idx = Number(req.params.index);

  if (!Number.isInteger(idx)) {
    return res.status(400).json({ error: "Invalid agency index" });
  }

  const agencies = store.load();

  if (!agencies[idx]) {
    return res.status(404).json({ error: "Agency not found" });
  }

  const agency = agencies[idx];
  agencies[idx].lookupEnabled = false;

  store.save(agencies);

  auditSvc.logEvent({
    actor: req.authentikUser || null,
    request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
    action: "DISABLE_AGENCY_LOOKUP",
    targetType: "agency",
    targetId: String(agency?.suffix || ""),
    details: {
      lookupDomain: String(agency.lookupDomain || ""),
      summary: `Disabled enrollment lookup for agency ${agency?.name || agency?.suffix || ""}.`,
    },
  });

  return res.json({ success: true });
});


// Enable auto-approve of matching Request Access submissions (requires a default template).
router.post("/:index/auto-approve/enable", (req, res) => {
  const idx = Number(req.params.index);
  if (!Number.isInteger(idx)) {
    return res.status(400).json({ error: "Invalid agency index" });
  }

  const agencies = store.load();
  if (!agencies[idx]) {
    return res.status(404).json({ error: "Agency not found" });
  }

  const agency = agencies[idx];
  try {
    store.assertAgencyCanEnableAutoApprove(agency);
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Cannot enable auto-approve" });
  }

  agencies[idx].autoApproveRequests = true;
  store.save(agencies);

  auditSvc.logEvent({
    actor: req.authentikUser || null,
    request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
    action: "ENABLE_AGENCY_AUTO_APPROVE",
    targetType: "agency",
    targetId: String(agency?.suffix || ""),
    details: {
      lookupDomain: String(agency.lookupDomain || ""),
      summary: `Enabled auto-approve of access requests for agency ${agency?.name || agency?.suffix || ""}.`,
    },
  });

  return res.json({ success: true, autoApproveRequests: true });
});


// Disable auto-approve of Request Access submissions.
router.post("/:index/auto-approve/disable", (req, res) => {
  const idx = Number(req.params.index);
  if (!Number.isInteger(idx)) {
    return res.status(400).json({ error: "Invalid agency index" });
  }

  const agencies = store.load();
  if (!agencies[idx]) {
    return res.status(404).json({ error: "Agency not found" });
  }

  const agency = agencies[idx];
  agencies[idx].autoApproveRequests = false;
  store.save(agencies);

  auditSvc.logEvent({
    actor: req.authentikUser || null,
    request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
    action: "DISABLE_AGENCY_AUTO_APPROVE",
    targetType: "agency",
    targetId: String(agency?.suffix || ""),
    details: {
      lookupDomain: String(agency.lookupDomain || ""),
      summary: `Disabled auto-approve of access requests for agency ${agency?.name || agency?.suffix || ""}.`,
    },
  });

  return res.json({ success: true, autoApproveRequests: false });
});

module.exports = router;
module.exports.createAgencyFromPayload = createAgencyFromPayload;
