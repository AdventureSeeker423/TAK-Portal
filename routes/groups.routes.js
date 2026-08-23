const router = require("express").Router();
const groups = require("../services/groups.service");
const mutualAid = require("../services/mutualAid.service");
const agencies = require("../services/agencies.service");
const accessSvc = require("../services/access.service");
const usersService = require("../services/users.service");
const auditSvc = require("../services/auditLog.service");
const auditDetails = require("../services/auditDetails.service");
const { getString } = require("../services/env");
const { toSafeApiError } = require("../services/apiErrorPayload.service");
const mutualAidStore = require("../services/mutualAid.store");
const channelPatchStore = require("../services/channelPatch.store");

const MUTUAL_AID_GROUP_PREFIX = "ma -";

function ensureTakPrefix(name) {
  const n = String(name || "").trim();
  if (!n) return "";
  return n.toLowerCase().startsWith("tak_") ? n : `tak_${n}`;
}

function stripTakPrefix(name) {
  const n = String(name || "").trim();
  if (n.toLowerCase().startsWith("tak_")) return n.slice(4);
  return n;
}

function toErrorPayload(err) {
  return toSafeApiError(err);
}

async function getGroupNameSafe(groupId) {
  const id = String(groupId || "").trim();
  if (!id) return "";
  try {
    const g = await groups.getGroupById(id);
    return String(g?.name || "").trim();
  } catch (_) {
    return "";
  }
}

// -------------------- Mass assign/unassign progress jobs (in-memory) --------------------
const massJobs = new Map();
function newJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

router.get("/", async (req, res) => {
  try {
    const forceRefresh = req.query.forceRefresh === "true";
    const authUser = req.authentikUser || null;
    const all = await groups.getGroupsForAuthUser(authUser, { forceRefresh });

    const access = accessSvc.getAgencyAccess(authUser);
    const includeMutualAid =
      access.isGlobalAdmin && String(req.query.includeMutualAid || "") === "1";
    const filtered = filterGroupsVisibleToUser(authUser, all, {
      includeMutualAid,
    });

    const payload =
      access.isGlobalAdmin
        ? channelPatchStore.annotateGroupsWithPatchPeers(filtered)
        : filtered;

    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

async function resolveAgencyAbbreviationsForScopedExport(authUser, access) {
  if (!authUser || access.isGlobalAdmin) return [];

  const fromAgencies = groups.resolveAgencyAbbreviationsForAuthUser(authUser);
  if (fromAgencies.length) return fromAgencies;

  const allowed = access.allowedAgencySuffixes || [];
  if (allowed.length !== 1 || !authUser.uid) return [];

  try {
    const attrs = authUser?.attributes || {};
    const fallbackMe =
      !attrs || !Object.keys(attrs).length
        ? await usersService.getUserById(authUser.uid).catch(() => null)
        : null;
    const attrsResolved =
      fallbackMe && fallbackMe.attributes ? fallbackMe.attributes : attrs;
    const abbr = String(attrsResolved?.agency_abbreviation || attrs.agency_abbreviation || "").trim();
    return abbr ? [abbr] : [];
  } catch (_) {
    return [];
  }
}

function getGroupsHiddenPrefixes({ includeMutualAid = false } = {}) {
  let hiddenPrefixes = String(getString("GROUPS_HIDDEN_PREFIXES", "") || "")
    .split(",")
    .map((p) => String(p || "").trim().toLowerCase())
    .filter(Boolean);
  if (includeMutualAid) {
    hiddenPrefixes = hiddenPrefixes.filter((p) => p !== MUTUAL_AID_GROUP_PREFIX);
  }
  return hiddenPrefixes;
}

function appendMutualAidGroupsFromStore(filtered, allGroups) {
  const list = Array.isArray(filtered) ? filtered : [];
  const all = Array.isArray(allGroups) ? allGroups : [];
  const seen = new Set(
    list.map((g) => String(g?.pk ?? g?.id ?? "").trim()).filter(Boolean)
  );
  const byName = new Map();
  for (const g of all) {
    const raw = String(g?.name || "").trim().toLowerCase();
    if (!raw) continue;
    byName.set(raw, g);
    const withoutTak = raw.startsWith("tak_") ? raw.slice(4) : raw;
    if (!byName.has(withoutTak)) byName.set(withoutTak, g);
  }

  for (const item of mutualAidStore.load()) {
    const name = String(item?.groupName || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const match = byName.get(key) || byName.get(`tak_${key}`);
    if (!match) continue;
    const pk = String(match?.pk ?? match?.id ?? "").trim();
    if (!pk || seen.has(pk)) continue;
    seen.add(pk);
    list.push(match);
  }

  return list;
}

function filterGroupsVisibleToUser(authUser, all, options = {}) {
  let filtered = accessSvc.filterGroupsForUser(authUser, all);

  const hiddenPrefixes = getGroupsHiddenPrefixes({
    includeMutualAid: !!options.includeMutualAid,
  });

  if (hiddenPrefixes.length) {
    filtered = filtered.filter((g) => {
      const raw = String(g.name || "").trim().toLowerCase();
      const withoutTak = raw.startsWith("tak_") ? raw.slice(4) : raw;

      return !hiddenPrefixes.some(
        (prefix) => raw.startsWith(prefix) || withoutTak.startsWith(prefix)
      );
    });
  }

  if (options.includeMutualAid) {
    filtered = appendMutualAidGroupsFromStore(filtered, all);
  }

  return filtered;
}

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

    const all = await groups.getGroupsForAuthUser(authUser, { forceRefresh: false });
    let visible = filterGroupsVisibleToUser(authUser, all);

    visible.sort((a, b) => {
      const an = stripTakPrefix(String(a?.name || "")).toLowerCase();
      const bn = stripTakPrefix(String(b?.name || "")).toLowerCase();
      return an.localeCompare(bn, undefined, { numeric: true, sensitivity: "base" });
    });

    const agencyAbbreviations = await resolveAgencyAbbreviationsForScopedExport(authUser, access);
    const exportRows = await groups.collectGroupsExportRows(visible, {
      authUser,
      agencyAbbreviations,
    });
    const csv = groups.buildGroupsExportCsv(exportRows);

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "EXPORT_GROUPS_CSV",
      targetType: "group",
      targetId: "bulk",
      details: {
        groupCount: visible.length,
        scope: access.isGlobalAdmin ? "global" : "agency",
      },
    });

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="tak-portal-groups-${stamp}.csv"`
    );
    return res.send(csv);
  } catch (err) {
    return res.status(500).json({ error: toErrorPayload(err) });
  }
});

router.post("/", async (req, res) => {
  try {
    const rawName = String(req.body?.name || "").trim();
    const name = ensureTakPrefix(rawName);
    const nameWithoutTak = stripTakPrefix(name);
    if (!rawName) {
      return res.status(400).json({ error: "Group name is required" });
    }

    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);

    // Private groups are a global-admin-only feature
    const hasPrivate = Object.prototype.hasOwnProperty.call(req.body || {}, "private");
    const privateStatus = hasPrivate
      ? String(req.body.private || "").trim().toLowerCase()
      : undefined;

    if (!access.isGlobalAdmin && hasPrivate) {
      return res.status(403).json({ error: "You do not have permission to set group privacy." });
    }

    const allAgencies = agencies.load();

    const description = String(req.body?.description || "").trim() || null;

    const rawGroupType = String(req.body?.groupType || "").trim();
    const groupType =
      rawGroupType === "Agency" ||
      rawGroupType === "County" ||
      rawGroupType === "Region" ||
      rawGroupType === "State" ||
      rawGroupType === "Global"
        ? rawGroupType
        : "Global";

    const groupTypeDetail = String(req.body?.groupTypeDetail || "").trim() || null;

    let matchedAgency = null;
    if (groupType === "Agency" && groupTypeDetail) {
      const detailLower = groupTypeDetail.toLowerCase();
      matchedAgency =
        allAgencies.find(
          (a) => String(a?.name || "").trim().toLowerCase() === detailLower
        ) || null;
    }
    if (!matchedAgency) {
      matchedAgency = agencies.findAgencyForGroupName(nameWithoutTak, allAgencies);
    }

    if (!access.isGlobalAdmin) {
      const allowedSuffixes = access.allowedAgencySuffixes || [];
      if (!allowedSuffixes.length) {
        return res
          .status(403)
          .json({ error: "You do not have permission to create groups." });
      }

      const managedNames = allAgencies
        .filter((a) =>
          allowedSuffixes.includes(String(a.suffix || "").trim().toLowerCase())
        )
        .map((a) => String(a.name || "").trim())
        .filter(Boolean);

      const detailOk =
        groupType === "Agency" &&
        groupTypeDetail &&
        managedNames.some(
          (n) => n.toLowerCase() === groupTypeDetail.toLowerCase()
        );

      if (!detailOk) {
        return res.status(403).json({
          error:
            "You may only create agency-specific groups for your own agency.",
        });
      }
    }

    if (matchedAgency && !agencies.isAgencyActive(matchedAgency)) {
      return res.status(403).json({
        error: `Agency "${matchedAgency.name || matchedAgency.suffix}" is disabled. Enable the agency before creating groups for it.`,
      });
    }

    // Global groups cannot use the mutual-aid reserved "MA -" prefix
    if (groupType === "Global") {
      const lower = String(nameWithoutTak || "").toLowerCase();
      if (lower.startsWith(MUTUAL_AID_GROUP_PREFIX)) {
        return res.status(400).json({
          error:
            'Global groups cannot start with "MA -". Create mutual aid groups from the Mutual Aid page.',
        });
      }
    }

    const createdBy = authUser
      ? {
          username: authUser.username,
          displayName: authUser.displayName || authUser.username,
        }
      : null;

    const createdAt = new Date().toISOString();

    // Build attributes in deterministic order
// 1) created_at
// 2) description
// 3) created_type
// 4) created_type_detail
// 5) created_by_username
// 6) created_by_display_name

const attributes = {};

// 1) created_at
attributes.created_at = createdAt;

// 2) description (if provided)
if (description) {
  attributes.description = description;
}

// 2b) private (global admins only; default is "no")
if (access.isGlobalAdmin && hasPrivate) {
  attributes.private = privateStatus === "yes" ? "yes" : "no";
}

// 3) created_type
attributes.created_type = groupType;

// 4) created_type_detail
attributes.created_type_detail = groupTypeDetail || null;

// 5–6) created_by_*
if (createdBy) {
  attributes.created_by_username = createdBy.username;
  attributes.created_by_display_name = createdBy.displayName;
}

// Private flag (Global Admins only)
if (access.isGlobalAdmin && typeof privateStatus === "string" && privateStatus) {
  // Accept common truthy values; store as "yes"/"no" for consistency
  const truthy = privateStatus === "yes" || privateStatus === "true" || privateStatus === "1";
  attributes.private = truthy ? "yes" : "no";
}
// Authentik attribute: uppercase key "CN" with value "CN: <name without tak_>"
attributes.CN = nameWithoutTak;
delete attributes.cn;

    const out = await groups.createGroup(name, { attributes });

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "CREATE_GROUP",
      targetType: "group",
      targetId: String(out?.pk || out?.id || ""),
      details: {
        name: out?.name || name,
        description: description || null,
        private: attributes?.private,
        created_type: groupType,
        created_type_detail: groupTypeDetail || null,
      },
    });

    res.json({ success: true, group: out });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

/**
 * Rename group
 * Expected body: { name: "NEW_GROUP_NAME" }
 */
router.patch("/:groupId", async (req, res) => {
  try {
    const rawName = String(req.body?.name || "").trim();
    const name = ensureTakPrefix(rawName);
    const nameWithoutTak = stripTakPrefix(name);
    if (!name) {
      return res.status(400).json({ error: "Group name is required" });
    }

    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);

    // Private groups are a global-admin-only feature
    const hasPrivate = Object.prototype.hasOwnProperty.call(req.body || {}, "private");
    const privateStatus = hasPrivate
      ? String(req.body.private || "").trim().toLowerCase()
      : undefined;

    if (!access.isGlobalAdmin && hasPrivate) {
      return res.status(403).json({ error: "You do not have permission to set group privacy." });
    }

    // Optional: description update
    const hasDescription = Object.prototype.hasOwnProperty.call(req.body || {}, "description");
    const description = hasDescription ? String(req.body.description || "").trim() : undefined;

    const before = await groups.getGroupById(req.params.groupId).catch(() => null);
    const out = await groups.renameGroup(req.params.groupId, name, {
      description,
      private: access.isGlobalAdmin ? privateStatus : undefined,
      CN: nameWithoutTak,
    });

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "UPDATE_GROUP",
      targetType: "group",
      targetId: String(req.params.groupId),
      details: {
        beforeName: before?.name || null,
        name: out?.name || name,
        description: description,
        private: access.isGlobalAdmin ? privateStatus : undefined,
      },
    });

    res.json({ success: true, group: out });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

// Impact preview before delete
router.get("/:groupId/impact", async (req, res) => {
  try {
    const out = await groups.getDeleteImpact(req.params.groupId);
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

// Delete now cleans up users + templates
router.delete("/:groupId", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const before = await groups.getGroupById(req.params.groupId).catch(() => null);
    const out = await groups.deleteGroupWithCleanup(req.params.groupId);

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "DELETE_GROUP",
      targetType: "group",
      targetId: String(req.params.groupId),
      details: { name: before?.name || null },
    });

    res.json(out);
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.post("/mass-assign", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const targetGroupName = await getGroupNameSafe(req.body?.groupId);
    const sourceMode = auditDetails.inferMassAssignSourceMode(req.body);
    const out = await groups.massAssignUsersToGroup({
      groupId: req.body?.groupId,
      suffixes: req.body?.suffixes,
      sourceGroupIds: req.body?.sourceGroupIds ?? req.body?.sourceGroupId,
      userIds: req.body?.userIds,
      authUser,
    });

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "MASS_ASSIGN_USERS_TO_GROUP",
      targetType: "group",
      targetId: targetGroupName || String(req.body?.groupId || ""),
      details: await auditDetails.buildMassGroupActionAuditDetails({
        kind: "assign",
        payload: req.body,
        out,
        sourceMode,
        targetGroupName,
      }),
    });

    res.json({ success: true, ...out });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.post("/mass-assign/start", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const payload = req.body || {};
    const targetGroupName = await getGroupNameSafe(payload.groupId);
    const sourceMode =
      payload.sourceMode === "group" || payload.sourceMode === "users" || payload.sourceMode === "agency"
        ? payload.sourceMode
        : (Array.isArray(payload.userIds) && payload.userIds.length)
          ? "users"
          : (Array.isArray(payload.sourceGroupIds) && payload.sourceGroupIds.length)
            ? "group"
            : "agency";
    const jobId = newJobId();
    const startedAt = Date.now();

    const initialTotal = Array.isArray(payload.userIds)
      ? payload.userIds.length
      : Array.isArray(payload.sourceGroupIds)
        ? payload.sourceGroupIds.length
        : Array.isArray(payload.suffixes)
          ? payload.suffixes.length
          : 0;

    massJobs.set(jobId, {
      jobId,
      status: "running",
      phase: "queued",
      total: Number(initialTotal || 0),
      processed: 0,
      matched: 0,
      updated: 0,
      error: null,
      result: null,
      startedAt,
      finishedAt: null,
      durationMs: null,
      durationSeconds: null,
      sourceMode,
    });

    (async () => {
      try {
        const out = await groups.massAssignUsersToGroup({
          groupId: payload.groupId,
          suffixes: payload.suffixes,
          sourceGroupIds: payload.sourceGroupIds ?? payload.sourceGroupId,
          userIds: payload.userIds,
          authUser,
          onProgress: (p) => {
            const job = massJobs.get(jobId);
            if (!job || job.status !== "running") return;
            if (p && typeof p === "object") {
              if (p.phase) job.phase = String(p.phase);
              if (Number.isFinite(Number(p.total))) job.total = Number(p.total);
              if (Number.isFinite(Number(p.processed))) job.processed = Number(p.processed);
              if (Number.isFinite(Number(p.matched))) job.matched = Number(p.matched);
              if (Number.isFinite(Number(p.updated))) job.updated = Number(p.updated);
            }
          },
        });

        const finishedAt = Date.now();
        const durationMs = finishedAt - startedAt;
        const job = massJobs.get(jobId);
        if (job) {
          job.status = "done";
          job.phase = "done";
          job.result = out;
          job.matched = Number(out?.matched || job.matched || 0);
          job.updated = Number(out?.updated || job.updated || 0);
          job.total = job.total || job.matched;
          job.processed = Math.max(job.processed || 0, job.total || 0);
          job.finishedAt = finishedAt;
          job.durationMs = durationMs;
          job.durationSeconds = Math.round((durationMs / 1000) * 10) / 10;
        }

        auditSvc.logEvent({
          actor: authUser,
          request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
          action: "MASS_ASSIGN_USERS_TO_GROUP",
          targetType: "group",
          targetId: targetGroupName || String(payload.groupId || ""),
          details: await auditDetails.buildMassGroupActionAuditDetails({
            kind: "assign",
            payload,
            out,
            sourceMode,
            targetGroupName,
            durationMs,
            jobId,
          }),
        });
      } catch (err) {
        const finishedAt = Date.now();
        const durationMs = finishedAt - startedAt;
        const job = massJobs.get(jobId);
        if (job) {
          job.status = "failed";
          job.phase = "failed";
          job.error = toErrorPayload(err);
          job.finishedAt = finishedAt;
          job.durationMs = durationMs;
          job.durationSeconds = Math.round((durationMs / 1000) * 10) / 10;
        }
        auditSvc.logEvent({
          actor: authUser,
          request: { method: "JOB", path: "/api/groups/mass-assign/start", ip: req.ip },
          action: "MASS_ASSIGN_USERS_TO_GROUP_FAILED",
          targetType: "group",
          targetId: String(payload.groupId || ""),
          details: {
            jobId,
            groupName: targetGroupName || undefined,
            error: toErrorPayload(err),
            durationMs,
          },
        });
      }
    })();

    setTimeout(() => massJobs.delete(jobId), 60 * 60 * 1000).unref?.();
    return res.json({ success: true, jobId });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

// Mass unassign users from a group
router.post("/mass-unassign", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const targetGroupName = await getGroupNameSafe(req.body?.groupId);
    const sourceMode = auditDetails.inferMassAssignSourceMode(req.body);
    const out = await groups.massUnassignUsersFromGroup({
      groupId: req.body?.groupId,
      suffixes: req.body?.suffixes,
      sourceGroupIds: req.body?.sourceGroupIds ?? req.body?.sourceGroupId,
      userIds: req.body?.userIds,
      authUser,
    });

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "MASS_UNASSIGN_USERS_FROM_GROUP",
      targetType: "group",
      targetId: targetGroupName || String(req.body?.groupId || ""),
      details: await auditDetails.buildMassGroupActionAuditDetails({
        kind: "unassign",
        payload: req.body,
        out,
        sourceMode,
        targetGroupName,
      }),
    });

    res.json({ success: true, ...out });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.post("/mass-unassign/start", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const payload = req.body || {};
    const targetGroupName = await getGroupNameSafe(payload.groupId);
    const sourceMode =
      payload.sourceMode === "group" || payload.sourceMode === "users" || payload.sourceMode === "agency"
        ? payload.sourceMode
        : (Array.isArray(payload.userIds) && payload.userIds.length)
          ? "users"
          : (Array.isArray(payload.sourceGroupIds) && payload.sourceGroupIds.length)
            ? "group"
            : "agency";
    const jobId = newJobId();
    const startedAt = Date.now();

    const initialTotal = Array.isArray(payload.userIds)
      ? payload.userIds.length
      : Array.isArray(payload.sourceGroupIds)
        ? payload.sourceGroupIds.length
        : Array.isArray(payload.suffixes)
          ? payload.suffixes.length
          : 0;

    massJobs.set(jobId, {
      jobId,
      status: "running",
      phase: "queued",
      total: Number(initialTotal || 0),
      processed: 0,
      matched: 0,
      updated: 0,
      error: null,
      result: null,
      startedAt,
      finishedAt: null,
      durationMs: null,
      durationSeconds: null,
      sourceMode,
    });

    (async () => {
      try {
        const out = await groups.massUnassignUsersFromGroup({
          groupId: payload.groupId,
          suffixes: payload.suffixes,
          sourceGroupIds: payload.sourceGroupIds ?? payload.sourceGroupId,
          userIds: payload.userIds,
          authUser,
          onProgress: (p) => {
            const job = massJobs.get(jobId);
            if (!job || job.status !== "running") return;
            if (p && typeof p === "object") {
              if (p.phase) job.phase = String(p.phase);
              if (Number.isFinite(Number(p.total))) job.total = Number(p.total);
              if (Number.isFinite(Number(p.processed))) job.processed = Number(p.processed);
              if (Number.isFinite(Number(p.matched))) job.matched = Number(p.matched);
              if (Number.isFinite(Number(p.updated))) job.updated = Number(p.updated);
            }
          },
        });

        const finishedAt = Date.now();
        const durationMs = finishedAt - startedAt;
        const job = massJobs.get(jobId);
        if (job) {
          job.status = "done";
          job.phase = "done";
          job.result = out;
          job.matched = Number(out?.matched || job.matched || 0);
          job.updated = Number(out?.updated || job.updated || 0);
          job.total = job.total || job.matched;
          job.processed = Math.max(job.processed || 0, job.total || 0);
          job.finishedAt = finishedAt;
          job.durationMs = durationMs;
          job.durationSeconds = Math.round((durationMs / 1000) * 10) / 10;
        }

        auditSvc.logEvent({
          actor: authUser,
          request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
          action: "MASS_UNASSIGN_USERS_FROM_GROUP",
          targetType: "group",
          targetId: targetGroupName || String(payload.groupId || ""),
          details: await auditDetails.buildMassGroupActionAuditDetails({
            kind: "unassign",
            payload,
            out,
            sourceMode,
            targetGroupName,
            durationMs,
            jobId,
          }),
        });
      } catch (err) {
        const finishedAt = Date.now();
        const durationMs = finishedAt - startedAt;
        const job = massJobs.get(jobId);
        if (job) {
          job.status = "failed";
          job.phase = "failed";
          job.error = toErrorPayload(err);
          job.finishedAt = finishedAt;
          job.durationMs = durationMs;
          job.durationSeconds = Math.round((durationMs / 1000) * 10) / 10;
        }
        auditSvc.logEvent({
          actor: authUser,
          request: { method: "JOB", path: "/api/groups/mass-unassign/start", ip: req.ip },
          action: "MASS_UNASSIGN_USERS_FROM_GROUP_FAILED",
          targetType: "group",
          targetId: String(payload.groupId || ""),
          details: {
            jobId,
            groupName: targetGroupName || undefined,
            error: toErrorPayload(err),
            durationMs,
          },
        });
      }
    })();

    setTimeout(() => massJobs.delete(jobId), 60 * 60 * 1000).unref?.();
    return res.json({ success: true, jobId });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.get("/mass-jobs/:jobId", (req, res) => {
  const jobId = String(req.params.jobId || "");
  const job = massJobs.get(jobId);
  if (!job) return res.status(404).json({ error: "Mass action job not found" });
  res.json({
    success: true,
    ...job,
  });
});

function isGroupOwnedByAgency(group, agency) {
  return agencies.isAgencyOwnedGroup(group, agency);
}

// Which agencies' admins can access this group (inverse of agency access-groups).
router.get("/:groupId/admin-access", async (req, res) => {
  try {
    const access = accessSvc.getAgencyAccess(req.authentikUser || null);
    if (!access.isGlobalAdmin) {
      return res.status(403).json({ error: "Only global admins can manage group admin access." });
    }

    const groupId = String(req.params.groupId || "").trim();
    if (!groupId) return res.status(400).json({ error: "Group id is required" });

    let group;
    try {
      group = await groups.getGroupById(groupId);
    } catch (_) {
      return res.status(404).json({ error: "Group not found" });
    }

    const groupName = String(group?.name || "").trim();

    const allAgencies = agencies.load();
    const agenciesOut = allAgencies.map((a, idx) => {
      const ids = Array.isArray(a.allowedAdminGroupIds) ? a.allowedAdminGroupIds : [];
      const hasExplicit = ids.map((id) => String(id).trim()).includes(groupId);
      const implicitAccess = isGroupOwnedByAgency(group, a);
      return {
        id: idx,
        name: String(a.name || "").trim(),
        groupPrefix: agencies.normalizeGroupPrefix(a.groupPrefix),
        suffix: String(a.suffix || "").trim().toLowerCase(),
        hasAccess: hasExplicit,
        implicitAccess,
        selectable: !implicitAccess,
      };
    });

    return res.json({
      groupId,
      groupName,
      agencies: agenciesOut,
    });
  } catch (err) {
    return res.status(500).json({ error: toErrorPayload(err) });
  }
});

router.put("/:groupId/admin-access", async (req, res) => {
  try {
    const access = accessSvc.getAgencyAccess(req.authentikUser || null);
    if (!access.isGlobalAdmin) {
      return res.status(403).json({ error: "Only global admins can manage group admin access." });
    }

    const groupId = String(req.params.groupId || "").trim();
    if (!groupId) return res.status(400).json({ error: "Group id is required" });

    let group;
    try {
      group = await groups.getGroupById(groupId);
    } catch (_) {
      return res.status(404).json({ error: "Group not found" });
    }

    const groupName = String(group?.name || "").trim();

    const raw = req.body?.agencyIds;
    const selected = new Set(
      Array.isArray(raw)
        ? raw.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 0)
        : []
    );

    const allAgencies = agencies.load();
    let updated = 0;

    for (let idx = 0; idx < allAgencies.length; idx++) {
      const agency = allAgencies[idx];
      if (isGroupOwnedByAgency(group, agency)) continue;

      let ids = Array.isArray(agency.allowedAdminGroupIds)
        ? agency.allowedAdminGroupIds.map((id) => String(id).trim()).filter(Boolean)
        : [];
      const had = ids.includes(groupId);
      const want = selected.has(idx);

      if (want && !had) {
        ids.push(groupId);
        updated++;
      } else if (!want && had) {
        ids = ids.filter((id) => id !== groupId);
        updated++;
      }

      agency.allowedAdminGroupIds = ids;
    }

    agencies.save(allAgencies);

    const selectedAgencyNames = [];
    for (const i of selected) {
      const ag = allAgencies[i];
      if (ag) selectedAgencyNames.push(String(ag.name || ag.suffix || i));
    }

    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "UPDATE_GROUP_ADMIN_ACCESS",
      targetType: "group",
      targetId: groupId,
      details: {
        groupName,
        agenciesUpdated: updated,
        selectedAgencyIndices: Array.from(selected),
        selectedAgencyNames,
        summary: `Updated which agencies can manage group "${groupName}" (${updated} agency record(s) changed).`,
      },
    });

    return res.json({ success: true, agenciesUpdated: updated });
  } catch (err) {
    return res.status(500).json({ error: toErrorPayload(err) });
  }
});

// Fetch members of a single group, plus related mutual-aid entries
router.get("/:groupId/members", async (req, res) => {
  try {
    const groupId = req.params.groupId;
    const page = parseInt(req.query.page, 10) || 1;
    const pageSize = parseInt(req.query.pageSize, 10) || 100;
    const group = await groups.getGroupById(groupId);
    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);

    // For agency admins, use agency_abbreviation attribute filtering
    // (single agency) or parallel per-agency filters (multi-agency).
    let agencyAbbreviation = null;
    let agencyAbbreviations = null;
    if (!access.isGlobalAdmin) {
      agencyAbbreviations = groups.resolveAgencyAbbreviationsForAuthUser(authUser);
      if (agencyAbbreviations.length === 1) {
        agencyAbbreviation = agencyAbbreviations[0];
        agencyAbbreviations = null;
      } else if (!agencyAbbreviations.length && authUser?.uid) {
        try {
          const attrs = authUser?.attributes || {};
          const fallbackMe =
            !attrs || !Object.keys(attrs).length
              ? await usersService.getUserById(authUser.uid).catch(() => null)
              : null;
          const attrsResolved =
            fallbackMe && fallbackMe.attributes ? fallbackMe.attributes : attrs;
          const abbr = String(
            attrsResolved?.agency_abbreviation || attrs.agency_abbreviation || ""
          ).trim();
          if (abbr) agencyAbbreviation = abbr;
        } catch (_) {
          agencyAbbreviation = null;
        }
      }
    }

    const members = await groups.getGroupMembersPaged(groupId, {
      authUser,
      agencyAbbreviation,
      agencyAbbreviations,
      page,
      pageSize,
    });
    const users = Array.isArray(members?.users) ? members.users : [];

    let mutual = [];
    try {
      const items = mutualAid.list() || [];
      const groupName = String(group?.name || "").trim();
      mutual = items.filter((it) => {
        const idMatch = String(it.groupId || "") === String(groupId);
        const nameMatch =
          groupName && String(it.groupName || "").trim() === groupName;
        return idMatch || nameMatch;
      });
    } catch (e) {
      mutual = [];
    }

    res.json({
      group,
      users,
      mutualAid: mutual,
      memberCount: Number(members?.total || users.length || 0),
      page: Number(members?.page || page),
      pageSize: Number(members?.pageSize || pageSize),
      hasNext: !!members?.hasNext,
      hasPrev: !!members?.hasPrev,
    });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

module.exports = router;
module.exports.filterGroupsVisibleToUser = filterGroupsVisibleToUser;
