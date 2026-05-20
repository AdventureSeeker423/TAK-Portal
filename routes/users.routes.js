const router = require("express").Router();
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const users = require("../services/users.service");
const groupsSvc = require("../services/groups.service");
const accessSvc = require("../services/access.service");
const userRequestsSvc = require("../services/userRequests.service");
const qrSvc = require("../services/qr.service");
const tokensSvc = require("../services/authentikTokens.service");
const { getString, getBool } = require("../services/env");
const auditSvc = require("../services/auditLog.service");
const { toSafeApiError } = require("../services/apiErrorPayload.service");

// Cache resolved Global Admin group PKs (from PORTAL_AUTH_REQUIRED_GROUP)
// so we can cheaply hide global-admin users from agency-admin views.
// Keep TTL short so changes in settings take effect quickly.
const GLOBAL_ADMIN_GROUP_CACHE_TTL_MS = 5 * 60 * 1000;
let _globalAdminGroupPkCache = {
  key: "",
  loadedAt: 0,
  pks: [],
};

// Cache group-name lookup for agency admin group-role labeling.
// This endpoint can be hit at page load; caching the "includeHidden groups"
// name->pk mapping avoids re-downloading/parsing all groups repeatedly.
const AGENCY_ADMIN_GROUP_NAME_PK_CACHE_TTL_MS = (parseInt(process.env.AGENCY_ADMIN_GROUP_NAME_PK_CACHE_TTL_MS, 10) || (5 * 60 * 1000));
let _agencyAdminGroupsNameLowerToPkCache = {
  loadedAt: 0,
  map: new Map(), // nameLower -> pk
};

async function getAllHiddenGroupsNameLowerToPk() {
  const now = Date.now();
  const cacheValid =
    _agencyAdminGroupsNameLowerToPkCache &&
    _agencyAdminGroupsNameLowerToPkCache.loadedAt &&
    now - _agencyAdminGroupsNameLowerToPkCache.loadedAt < AGENCY_ADMIN_GROUP_NAME_PK_CACHE_TTL_MS &&
    _agencyAdminGroupsNameLowerToPkCache.map &&
    _agencyAdminGroupsNameLowerToPkCache.map.size > 0;

  if (cacheValid) return _agencyAdminGroupsNameLowerToPkCache.map;

  const allGroups = await groupsSvc.getAllGroups({ includeHidden: true });
  const nameLowerToPk = new Map(
    (Array.isArray(allGroups) ? allGroups : []).map((g) => [
      String(g?.name || "").trim().toLowerCase(),
      String(g?.pk ?? g?.id ?? "").trim() || null,
    ])
  );

  _agencyAdminGroupsNameLowerToPkCache = {
    loadedAt: now,
    map: nameLowerToPk,
  };

  return nameLowerToPk;
}

function parseGroupList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((g) => String(g || "").trim().toLowerCase())
    .filter(Boolean);
}

async function getGlobalAdminGroupPks() {
  const raw = String(getString("PORTAL_AUTH_REQUIRED_GROUP", "").trim());
  const namesLower = parseGroupList(raw);
  const key = namesLower.join(",");

  if (!namesLower.length) return [];

  const now = Date.now();
  if (
    _globalAdminGroupPkCache.key === key &&
    now - _globalAdminGroupPkCache.loadedAt < GLOBAL_ADMIN_GROUP_CACHE_TTL_MS
  ) {
    return _globalAdminGroupPkCache.pks.slice();
  }

  // Resolve group names -> PKs (including hidden groups).
  const allGroups = await groupsSvc.getAllGroups({ includeHidden: true });
  const byNameLower = new Map(
    (Array.isArray(allGroups) ? allGroups : []).map((g) => [
      String(g?.name || "").trim().toLowerCase(),
      String(g?.pk),
    ])
  );

  const pks = [];
  for (const nm of namesLower) {
    const pk = byNameLower.get(nm);
    if (pk) pks.push(String(pk));
  }

  _globalAdminGroupPkCache = { key, loadedAt: now, pks };
  return pks.slice();
}

// -------------------- CSV import progress (in-memory) --------------------
// Lightweight job store for progress reporting.
// Polling this does NOT tax the system (just reads memory).
const importJobs = new Map();

function newJobId() {
  // Simple unique ID: time + random
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Small helper to keep error responses consistent and safe (no raw HTML from Authentik)
function toErrorPayload(err) {
  return toSafeApiError(err);
}

router.get("/meta", async (req, res) => {
  try {
    const agencySuffix = req.query.agencySuffix || "";
    const authUser = req.authentikUser || null;

    if (agencySuffix && !accessSvc.isSuffixAllowed(authUser, agencySuffix)) {
      return res.status(403).json({ error: "You do not have access to that agency." });
    }

    const dynamic = users.getTemplatesForAgency(agencySuffix);
    const allGroups = await groupsSvc.getAllGroups({});
    let groups = accessSvc.filterGroupsForUser(authUser, allGroups);

    const templates = [
      // index 0 = Manual, as the EJS expects
      {
        key: "manual",
        label: "Manual Group Selection",
        groups: [],
      },
      ...dynamic.map((t, idx) => ({
        // pick something stable/unique for key; name is fine if unique per agency
        key: t.name || `tpl-${idx}`,
        label: t.name || `Template ${idx + 1}`,
        agencySuffix: t.agencySuffix,
        role: String(t.role || "Team Member"),
        groups: t.groups,
        isDefault: t.isDefault,
      })),
    ];
    groups.sort((a, b) => {
      const an = String(a?.name || "").toLowerCase();
      const bn = String(b?.name || "").toLowerCase();
      return an.localeCompare(bn, undefined, { numeric: true, sensitivity: "base" });
    });

    // Apply hidden prefix filtering (final pass)
    const hiddenRaw = String(getString("GROUPS_HIDDEN_PREFIXES", "") || "");
    const hiddenPrefixes = hiddenRaw
      .split(",")
      .map(p => String(p || "").trim().toLowerCase())
      .filter(Boolean);

    if (hiddenPrefixes.length) {
      groups = groups.filter(g => {
        const raw = String(g?.name || "").trim().toLowerCase();
        const withoutTak = raw.startsWith("tak_") ? raw.slice(4) : raw;

        return !hiddenPrefixes.some(prefix =>
          raw.startsWith(prefix) || withoutTak.startsWith(prefix)
        );
      });
    }

    res.json({
      groups,
      templates,
    });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

// Lookup a group by exact name, INCLUDING groups hidden from the portal UI.
// Used for permission toggles like: authentik-<Agency Abbreviation>-AgencyAdmin
router.get("/group-lookup", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);

    const name = String(req.query.name || "").trim();
    if (!name) {
      return res.status(400).json({ error: "Group name is required" });
    }

    // Global admins can resolve any group name (including hidden).
    // Agency admins may ONLY resolve their own computed AgencyAdmin group(s)
    // so the Manage Users UI can:
    //  - show the friendly group name in "Current Groups"
    //  - compute the Role column (User/Admin)
    // without exposing arbitrary hidden groups.
    if (!access.isGlobalAdmin) {
      const access = accessSvc.getAgencyAccess(authUser);
      const allowedSuffixes = Array.isArray(access.allowedAgencySuffixes)
        ? access.allowedAgencySuffixes.map((s) => String(s || "").trim().toLowerCase()).filter(Boolean)
        : [];

      const agencies = require("../services/agencies.service").load();
      const allowedNames = new Set();
      for (const a of agencies) {
        const sfx = String(a?.suffix || "").toLowerCase();
        if (!sfx || !allowedSuffixes.includes(sfx)) continue;
        const groupName = accessSvc.getAgencyAdminGroupName(a);
        if (groupName) {
          allowedNames.add(groupName.toLowerCase());
        }
      }

      const target = name.toLowerCase();
      if (!allowedNames.has(target)) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    // Bypass GROUPS_HIDDEN_PREFIXES by requesting all groups (including hidden).
    // groups.service.getAllGroups supports includeHidden=true.
    const allGroups = await groupsSvc.getAllGroups({ includeHidden: true });
    const target = name.toLowerCase();
    const found = (Array.isArray(allGroups) ? allGroups : []).find(
      (g) => String(g?.name || "").trim().toLowerCase() === target
    );

    if (!found) {
      return res.status(404).json({ error: "Group not found" });
    }

    res.json({ pk: found.pk, name: found.name });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});


router.get("/groups", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const all = await groupsSvc.getAllGroups({});
    const filtered = accessSvc.filterGroupsForUser(authUser, all);
    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

// All Authentik groups, including those normally hidden from the portal UI (e.g. authentik-*).
// Restricted to global admins, used by the Manage Users page to resolve AgencyAdmin roles.
router.get("/all-groups-hidden", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);
    if (!access.isGlobalAdmin) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const all = await groupsSvc.getAllGroups({ includeHidden: true });
    res.json(Array.isArray(all) ? all : []);
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

// Return Authentik group PK(s) for each agency abbreviation's "-AgencyAdmin" group.
// This is safe for agency admins because we filter agencies by allowed suffixes server-side,
// then resolve only the computed "-AgencyAdmin" groups for those agencies.
//
// Query:
//   abbreviations=CPD,CFD  (these are "agency abbreviation" / groupPrefix values)
//
// Response:
//   { CPD: ["<pk>", ...], CFD: [] }
router.get("/agency-admin-group-ids", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);

    const abbreviationsRaw = String(req.query.abbreviations || "");
    const abbreviations = abbreviationsRaw
      .split(",")
      .map(s => String(s || "").trim().toUpperCase())
      .filter(Boolean);

    if (!abbreviations.length) {
      return res.status(400).json({ error: "abbreviations is required" });
    }

    const agencies = require("../services/agencies.service").load();
    const allowedSuffixes = access.isGlobalAdmin
      ? null
      : Array.isArray(access.allowedAgencySuffixes)
        ? access.allowedAgencySuffixes.map(s => String(s || "").trim().toLowerCase()).filter(Boolean)
        : [];

    // Select only the agencies the viewer is allowed to manage (agency suffix),
    // then only those whose groupPrefix matches one of the requested abbreviations.
    const matchingAgencies = agencies.filter(a => {
      const sfx = String(a?.suffix || "").trim().toLowerCase();
      if (!access.isGlobalAdmin) {
        if (!sfx || !allowedSuffixes.includes(sfx)) return false;
      }
      const gp = String(a?.groupPrefix || "").trim().toUpperCase();
      return gp && abbreviations.includes(gp);
    });

    // Build expected Authentik group names for those agencies.
    // Include both:
    // - computed name using county abbreviation if present
    // - legacy county-less name as fallback
    const expectedNameLowerToAbbrs = new Map(); // nameLower -> Set<ABBR>
    const addExpected = (groupName, abbrUpper) => {
      const n = String(groupName || "").trim();
      const lower = n.toLowerCase();
      if (!n || !abbrUpper) return;
      if (!expectedNameLowerToAbbrs.has(lower)) expectedNameLowerToAbbrs.set(lower, new Set());
      expectedNameLowerToAbbrs.get(lower).add(abbrUpper);
    };

    for (const a of matchingAgencies) {
      const abbrUpper = String(a?.groupPrefix || "").trim().toUpperCase();
      if (!abbrUpper) continue;

      const computed = accessSvc.getAgencyAdminGroupName(a);
      addExpected(computed, abbrUpper);

      // Legacy fallback: authentik-<ABBR>-AgencyAdmin
      addExpected(`authentik-${abbrUpper}-AgencyAdmin`, abbrUpper);
    }

    const nameLowerToPk = await getAllHiddenGroupsNameLowerToPk();

    const out = {};
    for (const abbr of abbreviations) out[abbr] = [];

    for (const [nameLower, abbrSet] of expectedNameLowerToAbbrs.entries()) {
      const pk = nameLowerToPk.get(nameLower);
      if (!pk) continue;
      for (const abbrUpper of abbrSet) {
        if (!Array.isArray(out[abbrUpper])) out[abbrUpper] = [];
        out[abbrUpper].push(pk);
      }
    }

    // Dedup
    for (const abbr of Object.keys(out)) {
      out[abbr] = Array.from(new Set(out[abbr]));
    }

    res.json(out);
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

router.post("/", async (req, res) => {
  try {
    const payload = req.body || {};
    const authUser = req.authentikUser || null;

    // Disabled <select name="agencySuffix"> is omitted from multipart FormData; default
    // the sole agency for single-scope agency admins.
    if (!String(payload.agencySuffix ?? "").trim()) {
      const access = accessSvc.getAgencyAccess(authUser);
      if (!access.isGlobalAdmin && access.isAgencyAdmin) {
        const allowed = access.allowedAgencySuffixes || [];
        if (allowed.length === 1) {
          payload.agencySuffix = String(allowed[0] || "").trim();
        }
      }
    }

    if (payload.agencySuffix && !accessSvc.isSuffixAllowed(authUser, payload.agencySuffix)) {
      return res.status(403).json({ error: "You do not have access to that agency." });
    }

    // FormData/JSON may send "" or omit the field; ?? only replaces null/undefined, not "".
    let permRaw = payload.permissions;
    if (Array.isArray(permRaw)) permRaw = permRaw[0];
    permRaw = String(permRaw ?? "user").trim().toLowerCase();
    if (!permRaw) permRaw = "user";
    const allowedPerm = ["user", "agency_admin", "global_admin"];
    if (!allowedPerm.includes(permRaw)) {
      return res.status(400).json({ error: "Invalid permissions value." });
    }
    if (permRaw === "global_admin" && !authUser?.isGlobalAdmin) {
      return res.status(403).json({ error: "You do not have permission to create Global Admins." });
    }
    payload.permissions = permRaw;

    const createdBy = authUser
      ? {
          username: authUser.username,
          displayName: authUser.displayName || authUser.username,
        }
      : null;

    const result = await users.createUser(payload, {
      createdBy,
      creationMethod: "manual",
    });

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "CREATE_USER",
      targetType: "user",
      targetId: String(result?.user?.pk || ""),
      details: {
        username: result?.user?.username,
        email: result?.user?.email,
        name: result?.user?.name,
        groups: Array.isArray(result?.groups)
          ? result.groups.map((g) => g?.name).filter(Boolean)
          : [],
        created_method: "manual",
      },
    });

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.post("/import-csv", upload.single("file"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "No CSV file uploaded" });
    }

    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);
    const allowedAgencySuffixes = access.isGlobalAdmin ? null : (access.allowedAgencySuffixes || []);

    const createdBy = authUser
      ? {
          username: authUser.username,
          displayName: authUser.displayName || authUser.username,
        }
      : null;

    const startedAt = Date.now();
    const result = await users.importUsersFromCsvBuffer(req.file.buffer, {
      allowedAgencySuffixes,
      createdBy,
      creationMethod: "csv",
    });
    const durationMs = Date.now() - startedAt;

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "IMPORT_USERS_CSV",
      targetType: "user",
      targetId: "bulk",
      details: {
        created: Array.isArray(result?.created) ? result.created.length : result?.created || 0,
        skipped: Array.isArray(result?.skipped) ? result.skipped.length : result?.skipped || 0,
        failed: Array.isArray(result?.failed) ? result.failed.length : result?.failed || 0,
        durationMs,
      },
    });

    res.json({
      success: true,
      ...result,
      durationMs,
      durationSeconds: Math.round((durationMs / 1000) * 10) / 10,
    });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

// NEW: start an async CSV import job (progress via polling)
router.post("/import-csv/start", upload.single("file"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "No CSV file uploaded" });
    }

    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);
    const allowedAgencySuffixes = access.isGlobalAdmin ? null : (access.allowedAgencySuffixes || []);

    const createdBy = authUser
      ? {
          username: authUser.username,
          displayName: authUser.displayName || authUser.username,
        }
      : null;

    const jobId = newJobId();
    const startedAt = Date.now();

    // Initialize job state
    importJobs.set(jobId, {
      jobId,
      status: "running", // running | done | failed
      phase: "queued",   // queued | parsing | validating | creating | done
      total: 0,
      processed: 0,
      created: 0,
      skipped: 0,
      startedAt,
      finishedAt: null,
      durationMs: null,
      durationSeconds: null,
      error: null,
      result: null,
    });

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "IMPORT_USERS_CSV_STARTED",
      targetType: "user",
      targetId: "bulk",
      details: { jobId },
    });

    // Kick off the import without blocking the HTTP response
    (async () => {
      try {
        const result = await users.importUsersFromCsvBuffer(req.file.buffer, {
          allowedAgencySuffixes,
          createdBy,
          creationMethod: "csv",
          onProgress: (p) => {
            const job = importJobs.get(jobId);
            if (!job || job.status !== "running") return;
            job.phase = String(p?.phase || job.phase);
            if (Number.isFinite(Number(p?.total))) job.total = Number(p.total);
            if (Number.isFinite(Number(p?.processed))) job.processed = Number(p.processed);
            if (Number.isFinite(Number(p?.created))) job.created = Number(p.created);
            if (Number.isFinite(Number(p?.skipped))) job.skipped = Number(p.skipped);
          }
        });

        const finishedAt = Date.now();
        const durationMs = finishedAt - startedAt;
        const job = importJobs.get(jobId);
        if (job) {
          job.status = "done";
          job.phase = "done";
          job.finishedAt = finishedAt;
          job.durationMs = durationMs;
          job.durationSeconds = Math.round((durationMs / 1000) * 10) / 10;
          job.result = result;
          job.total = job.total || Number(result?.created?.length || 0) + Number(result?.skipped?.length || 0);
          job.processed = job.total;
          job.created = Number(result?.created?.length || 0);
          job.skipped = Number(result?.skipped?.length || 0);

          const usernamesCreated = (result && result.created) ? result.created.map((c) => c.username).filter(Boolean) : [];
          const createdDetails = (result && result.created) ? result.created.map((c) => ({ username: c.username, templateName: c.templateName || "" })) : [];
          const templatesUsed = [...new Set(createdDetails.map((d) => d.templateName).filter(Boolean))];
          const skippedUsernames = (result && result.skipped) ? result.skipped.map((s) => s.username).filter(Boolean) : [];
          const firstUsername = usernamesCreated[0] || null;
          const bulkAgency = firstUsername ? auditSvc.inferAgencyFromUsername(firstUsername) : null;

          auditSvc.logEvent({
            actor: authUser,
            request: { method: "JOB", path: "/api/users/import-csv/start", ip: req.ip },
            action: "IMPORT_USERS_CSV_COMPLETED",
            targetType: "user",
            targetId: "bulk",
            agencySuffix: bulkAgency?.agencySuffix || undefined,
            agencyName: bulkAgency?.agencyName || undefined,
            details: {
              jobId,
              created: job.created,
              skipped: job.skipped,
              failed: Array.isArray(result?.failed) ? result.failed.length : 0,
              durationMs,
              usernamesCreated,
              createdDetails,
              templatesUsed,
              skippedUsernames,
            },
          });
        }
      } catch (e) {
        const finishedAt = Date.now();
        const durationMs = finishedAt - startedAt;
        const job = importJobs.get(jobId);
        if (job) {
          job.status = "failed";
          job.phase = "failed";
          job.finishedAt = finishedAt;
          job.durationMs = durationMs;
          job.durationSeconds = Math.round((durationMs / 1000) * 10) / 10;
          job.error = toErrorPayload(e);
        }

        auditSvc.logEvent({
          actor: authUser,
          request: { method: "JOB", path: "/api/users/import-csv/start", ip: req.ip },
          action: "IMPORT_USERS_CSV_FAILED",
          targetType: "user",
          targetId: "bulk",
          details: { jobId, error: toErrorPayload(e) },
        });
      }
    })();

    // Auto-clean this job after 1 hour to avoid unbounded memory usage
    setTimeout(() => {
      importJobs.delete(jobId);
    }, 60 * 60 * 1000).unref?.();

    res.json({ success: true, jobId });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

// NEW: poll an import job's progress
router.get("/import-csv/status/:jobId", (req, res) => {
  const jobId = String(req.params.jobId || "");
  const job = importJobs.get(jobId);
  if (!job) return res.status(404).json({ error: "Import job not found" });

  // Return a safe subset
  res.json({
    success: true,
    jobId: job.jobId,
    status: job.status,
    phase: job.phase,
    total: job.total,
    processed: job.processed,
    created: job.created,
    skipped: job.skipped,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationMs: job.durationMs,
    durationSeconds: job.durationSeconds,
    error: job.error,
    result: job.result,
  });
});

/**
 * FIXED: /search
 *
 * - Global admins: unchanged (still use users.searchUsersPaged -> Authentik pagination).
 * - Non-global (agency) admins: deterministic in-memory paging over the
 *   fully filtered set using users.findUsers + accessSvc.isUserInAllowedAgencies.
 *
 * This ensures:
 *   - total is exact for what the agency admin can see
 *   - there are no blank pages beyond the last page with data
 *   - hasNext / hasPrev are accurate
 */
router.get("/search", async (req, res) => {
  try {
    const q = req.query.q || "";
    const requestedPage = parseInt(req.query.page, 10) || 1;
    const pageSize = parseInt(req.query.pageSize, 10) || 50;

    const sortKey = String(req.query.sortKey || "name");
    const sortDir = String(req.query.sortDir || "asc").toLowerCase() === "desc"
      ? "desc"
      : "asc";

    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);

    // ---------------- AUTHENTIK-DELEGATED FAST PATH ----------------
    // Major win: let Authentik do ordering + pagination server-side
    // (instead of fetching all users into Node and sorting/paging in-memory).
    const qVal = String(q || "").trim();
    const requestedGlobalAgencySuffix = String(req.query.agencySuffix || "")
      .trim()
      .toLowerCase();
    const requestedCurrentTemplate = String(req.query.currentTemplate || "").trim();
    const requestedTemplateAgencySuffix = String(req.query.templateAgencySuffix || "")
      .trim()
      .toLowerCase();
    // Authentik can order by the underlying user fields, but our UI's "name"
    // sort uses a last-name-first derived value (see `lastNameForSort()` in
    // users-manage.ejs). For empty search we allow delegation (page order is
    // less confusing); for non-empty search we restrict delegation to avoid
    // "looks wrong" paging/sorting issues.
    const sortableKeysForAuthentikEmptyQ = new Set(["username", "name", "email", "status"]);
    // When q is non-empty, we still delegate to Authentik to avoid loading + sorting
    // large user sets in Node. Ordering for "name" uses Authentik's `name`
    // field, which is close to the UI's last-name derived sorting.
    const sortableKeysForAuthentikWithQ = new Set(["username", "name", "email", "status"]);
    const sortableKeysForAuthentik = qVal ? sortableKeysForAuthentikWithQ : sortableKeysForAuthentikEmptyQ;

    // If global admin is filtering by agency, we must not delegate to
    // Authentik's pagination because it doesn't apply that attribute filter.
    if (
      access.isGlobalAdmin &&
      !requestedGlobalAgencySuffix &&
      !requestedTemplateAgencySuffix &&
      sortableKeysForAuthentik.has(sortKey)
    ) {
      try {
        const delegated = await users.searchUsersPaged({
          q: qVal,
          page: requestedPage,
          pageSize,
          sortKey,
          sortDir,
          currentTemplate: requestedCurrentTemplate,
        });
        return res.json(delegated);
      } catch (e) {
        // Fall back to the legacy in-memory implementation below.
      }
    }

    // Global-admin delegated fast path when filtering by a specific agency.
    // This avoids loading/sorting all users in-memory for large datasets.
    if (access.isGlobalAdmin && requestedGlobalAgencySuffix && sortableKeysForAuthentik.has(sortKey)) {
      try {
        const agencies = require("../services/agencies.service").load();
        const agencyForSuffix = (Array.isArray(agencies) ? agencies : []).find(
          (a) =>
            String(a?.suffix || "")
              .trim()
              .toLowerCase() === String(requestedGlobalAgencySuffix).trim().toLowerCase()
        );
        const agencyNameToDelegate = agencyForSuffix
          ? String(agencyForSuffix.name || "").trim()
          : "";
        if (
          requestedTemplateAgencySuffix &&
          requestedTemplateAgencySuffix !== requestedGlobalAgencySuffix
        ) {
          return res.json({
            users: [],
            total: 0,
            page: 1,
            pageSize,
            hasNext: false,
            hasPrev: false,
          });
        }

        if (agencyNameToDelegate) {
          const delegatedByAgency = await users.searchUsersByAgencyNamePaged({
            agencyName: agencyNameToDelegate,
            q: qVal,
            page: requestedPage,
            pageSize,
            sortKey,
            sortDir,
            includeRoles: false,
            includeGroups: true,
            currentTemplate: requestedCurrentTemplate,
          });
          return res.json(delegatedByAgency);
        }
      } catch (e) {
        // Fall back to the legacy in-memory implementation below.
      }
    }

    // Agency-admin delegated fast path:
    // - Empty search box (to preserve semantics)
    // - Supported sorts (to safely delegate ordering)
    // - Filter by Authentik user attribute `attributes.agency_abbreviation`
    //   (set on user creation and generally present on older users too)
    if (!access.isGlobalAdmin && access.isAgencyAdmin && sortableKeysForAuthentik.has(sortKey)) {
      const allowedSuffixes = Array.isArray(access.allowedAgencySuffixes)
        ? access.allowedAgencySuffixes.map((s) => String(s || "").trim().toLowerCase()).filter(Boolean)
        : [];

      const requestedAgencySuffix = String(req.query.agencySuffix || "")
        .trim()
        .toLowerCase();

      const agencySuffixToDelegate =
        (requestedAgencySuffix && allowedSuffixes.includes(requestedAgencySuffix))
          ? requestedAgencySuffix
          : (allowedSuffixes.length === 1 ? allowedSuffixes[0] : "");

      if (agencySuffixToDelegate) {
        if (requestedTemplateAgencySuffix && requestedTemplateAgencySuffix !== agencySuffixToDelegate) {
          return res.json({
            users: [],
            total: 0,
            page: 1,
            pageSize,
            hasNext: false,
            hasPrev: false,
          });
        }
        try {
          const currentPageRequested = requestedPage < 1 ? 1 : requestedPage;

          const agencies = require("../services/agencies.service").load();
          const agencyForSuffix = (Array.isArray(agencies) ? agencies : []).find(
            a =>
              String(a?.suffix || "")
                .trim()
                .toLowerCase() === String(agencySuffixToDelegate).trim().toLowerCase()
          );
          const agencyAbbreviationToDelegate = agencyForSuffix
            ? String(agencyForSuffix.groupPrefix || "").trim()
            : "";
          const agencyNameToDelegate = agencyForSuffix
            ? String(agencyForSuffix.name || "").trim()
            : "";

          if (!agencyNameToDelegate) {
            throw new Error("Could not map agency suffix to agency name");
          }

          // Search semantics in the legacy path include matching the user's
          // agency abbreviation. Authentik's `search` does not search user
          // attributes, so typing an exact agency token (suffix/groupPrefix/name)
          // would otherwise return 0 even though the legacy path would match.
          //
          // If the search string equals an agency token exactly, treat it as
          // "empty field search" so attribute filtering still returns the full
          // agency slice.
          const qLower = String(qVal || "").trim().toLowerCase();
          const agencyTokensLower = [
            String(agencySuffixToDelegate || "").trim().toLowerCase(),
            String(agencyAbbreviationToDelegate || "").trim().toLowerCase(),
            String(agencyNameToDelegate || "").trim().toLowerCase(),
          ].filter(Boolean);
          const qForAuthentik = (qLower && agencyTokensLower.includes(qLower)) ? "" : qVal;

          const globalAdminGroupPks = await getGlobalAdminGroupPks();
          const globalAdminSet = new Set(globalAdminGroupPks.map(String));

          // Total across the agency set (includes global admins).
          const tTotalAgencyAllStart = Date.now();
          const totalAgencyAllRes = await users.searchUsersByAgencyNamePaged({
            agencyName: agencyNameToDelegate,
            q: qForAuthentik,
            page: 1,
            pageSize: 1,
            sortKey,
            sortDir,
            includeRoles: false,
            currentTemplate: requestedCurrentTemplate,
          });
          const tTotalAgencyAllMs = Date.now() - tTotalAgencyAllStart;

          const totalAgencyAll = Number(totalAgencyAllRes?.total || 0);
          // Safety: if Authentik returns 0 for the attribute-filtered query,
          // the portal attributes might not exist on existing users.
          // Fall back to the legacy username-suffix filtering to avoid omissions.
          if (totalAgencyAll === 0) {
            throw new Error("Delegated agency filter returned no results; falling back");
          }

          // If total differs from a username-suffix search, our `attributes.agency_abbreviation`
          // filter is likely under-matching (e.g., older users missing the attribute).
          // In that case, fall back to the legacy in-memory paging for correctness.
          // Only run the extra check when the attribute-filtered total is
          // suspiciously small for the requested page size.
          if (!qVal && totalAgencyAll <= pageSize) {
            // Validate against full user visibility (Authentik attributes, then username tail).
            const allMatching = await users.findUsers({ q: "", forceRefresh: false });
            const visibleApprox = (Array.isArray(allMatching) ? allMatching : []).filter(
              (u) => accessSvc.isUserInAllowedAgencies(authUser, u)
            );
            const totalApprox = visibleApprox.length;

            if (totalApprox > totalAgencyAll) {
              throw new Error("Delegated agency filter under-matched; falling back");
            }
          }

          let totalVisible = totalAgencyAll;

          // Exact exclusion count: global admins in this agency.
          let globalAdminsCount = 0;
          if (globalAdminGroupPks.length) {
            const tGlobalStart = Date.now();
            const totalGlobalAdminsRes = await users.searchUsersByAgencyNamePaged({
              agencyName: agencyNameToDelegate,
              q: qForAuthentik,
              page: 1,
              pageSize: 1,
              sortKey,
              sortDir,
              groupsByPk: globalAdminGroupPks,
              includeRoles: false,
              currentTemplate: requestedCurrentTemplate,
            });
            const tGlobalMs = Date.now() - tGlobalStart;

            globalAdminsCount = Number(totalGlobalAdminsRes?.total || 0);
            totalVisible = Math.max(0, totalVisible - globalAdminsCount);

          }

          const totalPages = Math.max(1, Math.ceil(totalVisible / pageSize));
          const page = Math.min(currentPageRequested, totalPages);

          // If there are no global admins in this agency slice, we can avoid the
          // "fill while skipping" loop entirely and just return Authentik's
          // server-side page directly.
          if (globalAdminsCount === 0) {
            const tPageResStart = Date.now();
            const pageRes = await users.searchUsersByAgencyNamePaged({
              agencyName: agencyNameToDelegate,
              q: qForAuthentik,
              page,
              pageSize,
              sortKey,
              sortDir,
              includeRoles: false,
              includeGroups: true,
              currentTemplate: requestedCurrentTemplate,
            });
            const tPageResMs = Date.now() - tPageResStart;

            return res.json({
              users: Array.isArray(pageRes?.users) ? pageRes.users : [],
              total: totalVisible,
              page: Number(pageRes?.page || page),
              pageSize,
              hasNext: !!pageRes?.hasNext,
              hasPrev: !!pageRes?.hasPrev,
            });
          }

          const startFiltered = (page - 1) * pageSize;
          const endFilteredExclusive = startFiltered + pageSize;

          // Fill the requested page, skipping global-admin users in order.
          const internalPageSize = Math.max(pageSize * 4, 100);
          let unfilteredPage = 1;
          let filteredIndex = 0; // counts non-global-admin users only
          const returned = [];
          let fillIters = 0;

          while (returned.length < pageSize) {
            fillIters++;
            const pageRes = await users.searchUsersByAgencyNamePaged({
              agencyName: agencyNameToDelegate,
              q: qForAuthentik,
              page: unfilteredPage,
              pageSize: internalPageSize,
              sortKey,
              sortDir,
              includeRoles: false,
              currentTemplate: requestedCurrentTemplate,
            });

            const rows = Array.isArray(pageRes?.users) ? pageRes.users : [];
            if (!rows.length) break;

            for (const u of rows) {
              const uGroups = Array.isArray(u?.groups) ? u.groups.map(String) : [];
              const isGlobal = uGroups.some((gid) => globalAdminSet.has(gid));
              if (isGlobal) continue;

              if (filteredIndex >= startFiltered && filteredIndex < endFilteredExclusive) {
                returned.push(u);
              }
              filteredIndex += 1;

              if (returned.length >= pageSize) break;
            }

            if (!pageRes?.hasNext) break;
            unfilteredPage += 1;
          }

          return res.json({
            users: returned,
            total: totalVisible,
            page,
            pageSize,
            hasNext: page < totalPages,
            hasPrev: page > 1,
          });
        } catch (e) {
          // Fall back to the legacy in-memory implementation below.
        }
      }
    }

    // ----- ROLE + SORT HELPERS -----
    // Cache resolved Global Admin group PKs so we don't have to re-fetch all
    // groups on every page load.
    const globalAdminGroupPks = await getGlobalAdminGroupPks();
    const globalAdminSet = new Set(globalAdminGroupPks.map(String));

    // Only needed when sorting by "role" so we can detect "*-AgencyAdmin"
    // groups by name.
    let groupNameByPk = new Map();
    if (sortKey === "role") {
      const allGroups = await groupsSvc.getAllGroups({ includeHidden: true });
      const groupList = Array.isArray(allGroups) ? allGroups : [];
      groupNameByPk = new Map(
        groupList.map((g) => [String(g.pk), String(g.name || "").toLowerCase()])
      );
    }

    function computeRole(user) {
      const groups = Array.isArray(user?.groups)
        ? user.groups.map(String)
        : [];

      if (groups.some(g => globalAdminSet.has(g))) {
        return "0-global";
      }

      for (const gid of groups) {
        const name = groupNameByPk.get(gid);
        if (name && name.endsWith("-agencyadmin")) {
          return "1-agency";
        }
      }

      return "2-user";
    }

    function getAgencyAbbr(user) {
      const attrs = user?.attributes || {};
      const raw = attrs.agency_abbreviation || attrs.agencyAbbreviation || attrs.agencyAbbr || attrs.agencyabbr || "";
      return String(raw || "").trim().toLowerCase();
    }

    function getSortValue(user) {
      if (!user) return "";

      if (sortKey === "username") return String(user.username || "").toLowerCase();
      if (sortKey === "agency") return getAgencyAbbr(user);
      if (sortKey === "name") return String(user.name || "").toLowerCase();
      if (sortKey === "email") return String(user.email || "").toLowerCase();
      if (sortKey === "status") return user.is_active ? "enabled" : "disabled";
      if (sortKey === "role") return computeRole(user) + "-" + String(user.name || "").toLowerCase();

      return String(user.name || "").toLowerCase();
    }

    function applySort(arr) {
      arr.sort((a, b) => {
        const av = getSortValue(a);
        const bv = getSortValue(b);

        let cmp = String(av).localeCompare(String(bv), undefined, {
          numeric: true,
          sensitivity: "base"
        });

        // When sorting by agency, tiebreak by name (not username)
        if (cmp === 0 && sortKey === "agency") {
          const aName = String(a?.name || "").toLowerCase();
          const bName = String(b?.name || "").toLowerCase();
          cmp = aName.localeCompare(bName, undefined, { numeric: true, sensitivity: "base" });
        }

        return sortDir === "desc" ? -cmp : cmp;
      });
    }


    // ---------------- GLOBAL ADMINS ----------------
    if (access.isGlobalAdmin) {

      const currentPageRequested = requestedPage < 1 ? 1 : requestedPage;

      // Get ALL matching users (not paged)
      const allMatching = await users.findUsers({ q, forceRefresh: false });

      let visible = Array.isArray(allMatching) ? allMatching.slice() : [];

      // Optional: filter to a single agency slice for global admins.
      // UI sends `agencySuffix` from /api/agencies (value is suffix).
      if (requestedGlobalAgencySuffix) {
        const agencies = require("../services/agencies.service").load();
        const agencyForSuffix = (Array.isArray(agencies) ? agencies : []).find(
          (a) =>
            String(a?.suffix || "")
              .trim()
              .toLowerCase() === String(requestedGlobalAgencySuffix).trim().toLowerCase()
        );

        const agencyAbbreviationToMatch = agencyForSuffix
          ? String(agencyForSuffix.groupPrefix || "").trim().toLowerCase()
          : "";

        visible = agencyAbbreviationToMatch
          ? visible.filter((u) => getAgencyAbbr(u) === agencyAbbreviationToMatch)
          : [];
      }

      if (requestedTemplateAgencySuffix) {
        visible = visible.filter(
          (u) =>
            String((u?.attributes || {}).agency || "")
              .trim()
              .toLowerCase() === requestedTemplateAgencySuffix
        );
      }
      if (requestedCurrentTemplate) {
        const wanted = requestedCurrentTemplate.toLowerCase();
        visible = visible.filter(
          (u) => String((u?.attributes || {}).current_template || "").trim().toLowerCase() === wanted
        );
      }

      // Sort entire dataset BEFORE pagination
      applySort(visible);

      const total = visible.length;

      if (total === 0) {
        return res.json({
          users: [],
          total: 0,
          page: 1,
          pageSize,
          hasNext: false,
          hasPrev: false,
        });
      }

      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(currentPageRequested, totalPages);

      const start = (page - 1) * pageSize;
      const end = start + pageSize;
      const pageItems = visible.slice(start, end);

      return res.json({
        users: pageItems,
        total,
        page,
        pageSize,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      });
    }

    // ---------------- AGENCY ADMINS ----------------

    const currentPageRequested = requestedPage < 1 ? 1 : requestedPage;

    const allMatching = await users.findUsers({ q, forceRefresh: false });

    let visible = allMatching.filter((u) =>
      accessSvc.isUserInAllowedAgencies(authUser, u)
    );

    if (requestedTemplateAgencySuffix) {
      visible = visible.filter(
        (u) =>
          String((u?.attributes || {}).agency || "")
            .trim()
            .toLowerCase() === requestedTemplateAgencySuffix
      );
    }
    if (requestedCurrentTemplate) {
      const wanted = requestedCurrentTemplate.toLowerCase();
      visible = visible.filter(
        (u) => String((u?.attributes || {}).current_template || "").trim().toLowerCase() === wanted
      );
    }

    if (access.isAgencyAdmin && globalAdminSet.size) {
      visible = visible.filter((u) => {
        const gs = Array.isArray(u?.groups) ? u.groups.map(String) : [];
        return !gs.some((gid) => globalAdminSet.has(gid));
      });
    }

    applySort(visible);

    const total = visible.length;

    if (total === 0) {
      return res.json({
        users: [],
        total: 0,
        page: 1,
        pageSize,
        hasNext: false,
        hasPrev: false,
      });
    }

    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(currentPageRequested, totalPages);

    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const pageItems = visible.slice(start, end);

    return res.json({
      users: pageItems,
      total,
      page,
      pageSize,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    });

  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

router.get("/roles/backfill-status", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);
    if (!access.isGlobalAdmin) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const out = await users.getMissingUserRoleStats();
    res.json({ success: true, ...out });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.get("/export-csv", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    if (!authUser) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const access = accessSvc.getAgencyAccess(authUser);
    if (!access.isGlobalAdmin && !access.isAgencyAdmin) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const globalAdminGroupPks = await getGlobalAdminGroupPks();
    const globalAdminSet = new Set(globalAdminGroupPks.map(String));

    const allGroups = await groupsSvc.getAllGroups({ includeHidden: true });
    const groupNameByPk = new Map(
      (Array.isArray(allGroups) ? allGroups : []).map((g) => [
        String(g.pk),
        String(g.name || "").toLowerCase(),
      ])
    );

    let visible = await users.findUsers({ q: "", forceRefresh: false });

    if (!access.isGlobalAdmin) {
      visible = visible.filter((u) => accessSvc.isUserInAllowedAgencies(authUser, u));
      if (globalAdminSet.size) {
        visible = visible.filter((u) => {
          const gs = Array.isArray(u?.groups) ? u.groups.map(String) : [];
          return !gs.some((gid) => globalAdminSet.has(gid));
        });
      }
    }

    visible.sort((a, b) =>
      String(a?.username || "").localeCompare(String(b?.username || ""), undefined, {
        numeric: true,
        sensitivity: "base",
      })
    );

    const agencies = require("../services/agencies.service").load();
    const agencyNameByAbbr = new Map();
    for (const agency of Array.isArray(agencies) ? agencies : []) {
      const abbr = String(agency?.groupPrefix || "").trim().toLowerCase();
      if (!abbr) continue;
      agencyNameByAbbr.set(abbr, String(agency?.name || "").trim());
    }

    const csv = users.buildUsersExportCsv(visible, {
      groupNameByPk,
      globalAdminGroupPks,
      agencyNameByAbbr,
    });

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "EXPORT_USERS_CSV",
      targetType: "user",
      targetId: "bulk",
      details: {
        rowCount: visible.length,
        scope: access.isGlobalAdmin ? "global" : "agency",
      },
    });

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="tak-portal-users-${stamp}.csv"`
    );
    return res.send(csv);
  } catch (err) {
    return res.status(500).json({ error: toErrorPayload(err) });
  }
});

/**
 * Full user record (including group memberships) for the edit modal.
 * List/search endpoints often omit or strip groups; this avoids stale UI.
 */
router.get("/:userId", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    if (!authUser) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const user = await users.getUserById(req.params.userId).catch(() => null);
    if (!user || user.pk == null) {
      return res.status(404).json({ error: "User not found" });
    }

    if (getBool(accessSvc.SHADOW_ENV, false)) {
      const cmp = accessSvc.compareAgencyResolutionToUsernameInference(user);
      if (cmp.mismatch && (cmp.resolved || cmp.inferred)) {
        console.warn(
          "[ACCESS] GET /api/users/:id shadow: attribute resolution differs from username-only inference",
          { userId: user.pk, username: user.username, resolved: cmp.resolved, inferred: cmp.inferred }
        );
      }
    }

    if (!accessSvc.isUserInAllowedAgencies(authUser, user)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    res.json(user);
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

router.post("/:userId/reset-password", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    await users.resetPassword(req.params.userId, req.body?.password);
    const user = await users.getUserById(req.params.userId).catch(() => null);

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "RESET_USER_PASSWORD",
      targetType: "user",
      targetId: String(req.params.userId),
      details: { username: user?.username ?? null },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.post("/:userId/resend-onboarding", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;

    const result = await users.resendOnboardingEmail(req.params.userId);

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "RESEND_ONBOARDING_EMAIL",
      targetType: "user",
      targetId: String(req.params.userId),
      details: {
        username: result?.username || null,
        email: result?.email || null
      },
    });

    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.put("/:userId/email", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    await users.updateEmail(req.params.userId, req.body?.email);
    const user = await users.getUserById(req.params.userId).catch(() => null);

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "UPDATE_USER_EMAIL",
      targetType: "user",
      targetId: String(req.params.userId),
      details: { username: user?.username ?? null, email: user?.email ?? null },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

// NEW: update name
router.put("/:userId/name", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    await users.updateName(req.params.userId, req.body?.name);
    const user = await users.getUserById(req.params.userId).catch(() => null);
    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "UPDATE_USER_NAME",
      targetType: "user",
      targetId: String(req.params.userId),
      details: { username: user?.username ?? null, name: user?.name ?? null },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.put("/:userId/role", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const role = String(req.body?.role || "").trim() || "Team Member";
    await users.updateUserAttributes(req.params.userId, {
      role,
    });
    const user = await users.getUserById(req.params.userId).catch(() => null);
    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "UPDATE_USER_ROLE",
      targetType: "user",
      targetId: String(req.params.userId),
      details: { username: user?.username ?? null, role },
    });
    res.json({ success: true, role });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.put("/:userId/radio-callsign", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const radioCallsign = String(req.body?.radioCallsign ?? "").trim();
    await users.updateRadioCallsign(req.params.userId, radioCallsign);
    const user = await users.getUserById(req.params.userId).catch(() => null);
    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "UPDATE_USER_RADIO_CALLSIGN",
      targetType: "user",
      targetId: String(req.params.userId),
      details: {
        username: user?.username ?? null,
        radio_callsign: radioCallsign || null,
      },
    });
    res.json({ success: true, radioCallsign: radioCallsign || null });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.post("/roles/backfill", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);
    if (!access.isGlobalAdmin) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const dryRun = String(req.body?.dryRun ?? "true").toLowerCase() !== "false";
    const out = await users.backfillMissingUserRoles({ dryRun });
    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "BACKFILL_USER_ROLES",
      targetType: "user",
      targetId: "bulk",
      details: out,
    });
    res.json({ success: true, ...out });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.get("/current-template/backfill-status", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);
    if (!access.isGlobalAdmin) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const out = await users.getCurrentTemplateBackfillStats();
    res.json({ success: true, ...out });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.post("/current-template/backfill", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);
    if (!access.isGlobalAdmin) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const dryRun = String(req.body?.dryRun ?? "true").toLowerCase() !== "false";
    const out = await users.backfillCurrentTemplateAttributes({ dryRun });
    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "BACKFILL_USER_CURRENT_TEMPLATE",
      targetType: "user",
      targetId: "bulk",
      details: out,
    });
    res.json({ success: true, ...out });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.get("/current-template/backfill-preview.csv", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);
    if (!access.isGlobalAdmin) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const rows = await users.getCurrentTemplateBackfillPreviewRows();
    const csvEscape = (v) => {
      const s = String(v == null ? "" : v);
      return `"${s.replace(/"/g, '""')}"`;
    };
    const header = [
      "username",
      "display_name",
      "user_id",
      "agency_suffix",
      "current_template_existing",
      "current_template_computed",
      "action",
    ].join(",");
    const body = rows.map((r) => ([
      csvEscape(r.username),
      csvEscape(r.displayName),
      csvEscape(r.userId),
      csvEscape(r.agencySuffix),
      csvEscape(r.currentTemplate),
      csvEscape(r.computedTemplate),
      csvEscape(r.action),
    ].join(","))).join("\n");
    const csv = `${header}\n${body}\n`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="current-template-backfill-preview-${Date.now()}.csv"`
    );
    return res.send(csv);
  } catch (err) {
    return res.status(400).json({ error: toErrorPayload(err) });
  }
});

// Overwrite groups
router.put("/:userId/groups", async (req, res) => {
  try {
    const groupIds = Array.isArray(req.body?.groupIds) ? req.body.groupIds : [];
    const hasCurrentTemplate = Object.prototype.hasOwnProperty.call(req.body || {}, "currentTemplate");
    const currentTemplate = hasCurrentTemplate ? String(req.body?.currentTemplate || "").trim() : undefined;
    const authUser = req.authentikUser || null;
    await users.setUserGroups(req.params.userId, groupIds, {
      ...(hasCurrentTemplate ? { currentTemplate } : {}),
    });
    const user = await users.getUserById(req.params.userId).catch(() => null);

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "SET_USER_GROUPS",
      targetType: "user",
      targetId: String(req.params.userId),
      details: {
        username: user?.username ?? null,
        groups: groupIds,
      },
    });
    res.json({ success: true, groups: groupIds });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.post("/:userId/groups", async (req, res) => {
  try {
    const groupIds = Array.isArray(req.body?.groupIds) ? req.body.groupIds : [];
    const hasCurrentTemplate = Object.prototype.hasOwnProperty.call(req.body || {}, "currentTemplate");
    const currentTemplate = hasCurrentTemplate ? String(req.body?.currentTemplate || "").trim() : undefined;
    const authUser = req.authentikUser || null;
    await users.setUserGroups(req.params.userId, groupIds, {
      ...(hasCurrentTemplate ? { currentTemplate } : {}),
    });
    const user = await users.getUserById(req.params.userId).catch(() => null);
    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "SET_USER_GROUPS",
      targetType: "user",
      targetId: String(req.params.userId),
      details: {
        username: user?.username ?? null,
        groups: groupIds,
      },
    });
    res.json({ success: true, groups: groupIds });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

// Add groups
router.post("/:userId/groups/add", async (req, res) => {
  try {
    const groupIds = Array.isArray(req.body?.groupIds) ? req.body.groupIds : [];
    const hasCurrentTemplate = Object.prototype.hasOwnProperty.call(req.body || {}, "currentTemplate");
    const currentTemplate = hasCurrentTemplate ? String(req.body?.currentTemplate || "").trim() : undefined;
    const authUser = req.authentikUser || null;
    const out = await users.addUserGroups(req.params.userId, groupIds, {
      ...(hasCurrentTemplate ? { currentTemplate } : {}),
    });
    const user = await users.getUserById(req.params.userId).catch(() => null);

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "ADD_USER_GROUPS",
      targetType: "user",
      targetId: String(req.params.userId),
      details: {
        username: user?.username ?? null,
        groups: Array.isArray(out) ? out : groupIds,
      },
    });
    res.json({ success: true, groups: out });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

// Remove groups
router.post("/:userId/groups/remove", async (req, res) => {
  try {
    const groupIds = Array.isArray(req.body?.groupIds) ? req.body.groupIds : [];
    const hasCurrentTemplate = Object.prototype.hasOwnProperty.call(req.body || {}, "currentTemplate");
    const currentTemplate = hasCurrentTemplate ? String(req.body?.currentTemplate || "").trim() : undefined;
    const authUser = req.authentikUser || null;
    const out = await users.removeUserGroups(req.params.userId, groupIds, {
      ...(hasCurrentTemplate ? { currentTemplate } : {}),
    });
    const user = await users.getUserById(req.params.userId).catch(() => null);

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "REMOVE_USER_GROUPS",
      targetType: "user",
      targetId: String(req.params.userId),
      details: {
        username: user?.username ?? null,
        groups: Array.isArray(out) ? out : groupIds,
      },
    });
    res.json({ success: true, groups: out });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.put("/:userId/active", async (req, res) => {
  try {
    const isActive = !!req.body?.is_active;
    const authUser = req.authentikUser || null;
    await users.toggleUserActive(req.params.userId, isActive);
    const user = await users.getUserById(req.params.userId).catch(() => null);

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "SET_USER_ACTIVE",
      targetType: "user",
      targetId: String(req.params.userId),
      details: { username: user?.username ?? null, is_active: !!isActive },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.delete("/:userId", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const before = await users.getUserById(req.params.userId).catch(() => null);
    await users.deleteUser(req.params.userId);

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "DELETE_USER",
      targetType: "user",
      targetId: String(req.params.userId),
      details: { username: before?.username || null },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});


// Generate an enrollment QR for a specific user (admin-only)
router.post("/enroll-qr", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;

    // Require an authenticated admin (global or agency admin)
    const access = accessSvc.getAgencyAccess(authUser);
    if (!authUser || (!access.isGlobalAdmin && !access.isAgencyAdmin)) {
      return res.status(403).json({ ok: false, error: "Admin access required" });
    }

    const userId = String(req.body?.userId || req.body?.pk || "").trim();
    const username = String(req.body?.username || "").trim();

    if (!userId || !username) {
      return res.status(400).json({ ok: false, error: "Missing userId or username" });
    }

    const targetUser = await users.getUserById(userId).catch(() => null);
    if (!targetUser || targetUser.pk == null) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }
    if (String(targetUser.username || "").trim() !== username) {
      return res.status(400).json({
        ok: false,
        error: "Username does not match the selected user.",
      });
    }

    // Enforce agency-scoped admins can only generate for their allowed agencies
    if (!access.isGlobalAdmin && !accessSvc.isUserInAllowedAgencies(authUser, targetUser)) {
      return res.status(403).json({ ok: false, error: "You do not have access to that user." });
    }

    const takUrl = qrSvc.getTakUrl();
    if (!takUrl) {
      return res.status(500).json({
        ok: false,
        error:
          "TAK_URL is not configured. Set it in Settings (TAK URL) or via the TAK_URL environment variable.",
      });
    }

    const { identifier, key, expiresAt } =
      await tokensSvc.getOrCreateEnrollmentAppPassword({
        username: String(targetUser.username || "").trim(),
        userId,
      });

    const canonicalUsername = String(targetUser.username || "").trim();
    const enrollUrl = qrSvc.buildEnrollUrl({ username: canonicalUsername, token: key });
    const qrCode = await qrSvc.generateDisplayQrDataUrl(enrollUrl);

    // Audit (never store token/key)
    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "GENERATE_ENROLLMENT_QR",
      targetType: "user",
      targetId: String(userId),
      details: { username: canonicalUsername, tokenIdentifier: identifier, expiresAt },
    });

    return res.json({
      ok: true,
      username: canonicalUsername,
      tokenIdentifier: identifier,
      token: key,
      expiresAt,
      enrollUrl,
      qrCode,
    });
  } catch (err) {
    console.error("[users] Failed to create enrollment QR:", err?.message || err);
    return res.status(500).json({
      ok: false,
      error:
        err?.response?.status
          ? `Authentik API error (HTTP ${err.response.status})`
          : (err?.message || "Failed to generate enrollment QR"),
    });
  }
});


module.exports = router;
