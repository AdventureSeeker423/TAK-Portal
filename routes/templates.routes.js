const router = require("express").Router();
const store = require("../services/templates.service");
const accessSvc = require("../services/access.service");
const agenciesSvc = require("../services/agencies.service");
const auditSvc = require("../services/auditLog.service");
const auditDetails = require("../services/auditDetails.service");
const usersSvc = require("../services/users.service");
const mutualAidStore = require("../services/mutualAid.store");

// In-memory progress jobs for bulk template group updates.
const templateBulkJobs = new Map();
function newTemplateBulkJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function runBulkTemplateGroupUpdate({
  action,
  groupName,
  templateIndices,
  authUser,
  onProgress,
} = {}) {
  const actionRaw = String(action || "").trim().toLowerCase();
  const normalizedAction = actionRaw === "remove" ? "remove" : actionRaw === "add" ? "add" : "";
  if (!normalizedAction) {
    throw new Error("Action must be 'add' or 'remove'.");
  }

  const normalizedGroupName = String(groupName || "").trim();
  if (!normalizedGroupName) {
    throw new Error("Group name is required.");
  }
  if (mutualAidStore.isCreatedGroupName(normalizedGroupName)) {
    throw new Error("Mutual aid groups cannot be added to templates.");
  }

  const indices = Array.isArray(templateIndices)
    ? templateIndices
        .map((v) => Number(v))
        .filter((n) => Number.isInteger(n) && n >= 0)
    : [];
  if (!indices.length) {
    throw new Error("Select one or more templates.");
  }

  const emitProgress = (p) => {
    if (typeof onProgress === "function") onProgress(p);
  };

  emitProgress({
    phase: "updating_templates",
    total: indices.length,
    processed: 0,
    matched: 0,
    updated: 0,
  });

  const templates = store.load();
  const uniqueIndices = Array.from(new Set(indices));
  let updated = 0;
  let skipped = 0;
  const touched = [];

  for (const idx of uniqueIndices) {
    const tpl = templates[idx];
    if (!tpl) {
      skipped += 1;
      continue;
    }

    const sfx = String(tpl.agencySuffix || "").trim().toLowerCase();
    if (sfx && !accessSvc.isSuffixAllowed(authUser, sfx)) {
      skipped += 1;
      continue;
    }

    const groups = Array.isArray(tpl.groups)
      ? tpl.groups.map((g) => String(g || "").trim()).filter(Boolean)
      : [];

    let nextGroups = groups.slice();
    if (normalizedAction === "add") {
      if (nextGroups.includes(normalizedGroupName)) {
        skipped += 1;
        continue;
      }
      nextGroups = Array.from(new Set([...nextGroups, normalizedGroupName]));
    } else {
      if (!nextGroups.includes(normalizedGroupName)) {
        skipped += 1;
        continue;
      }
      nextGroups = nextGroups.filter((g) => g !== normalizedGroupName);
      if (!nextGroups.length) {
        skipped += 1;
        continue;
      }
    }

    templates[idx] = {
      ...tpl,
      groups: nextGroups,
    };
    updated += 1;
    touched.push({
      index: idx,
      name: String(tpl.name || "").trim(),
      agencySuffix: sfx,
      beforeGroups: groups,
      afterGroups: nextGroups,
    });
  }

  emitProgress({
    phase: "updating_templates",
    total: uniqueIndices.length,
    processed: uniqueIndices.length,
    matched: 0,
    updated: 0,
    templatesUpdated: updated,
    templatesSkipped: skipped,
  });

  if (updated > 0) {
    store.save(templates);
  }

  let currentTemplateSync = {
    matched: 0,
    updated: 0,
    groupsUpdated: 0,
    templateAttrUpdated: 0,
    templatesProcessed: 0,
  };

  if (updated > 0) {
    currentTemplateSync = await usersSvc.syncUsersForBulkTemplateGroupDelta({
      templates: touched.map((t) => ({
        agencySuffix: t.agencySuffix,
        name: t.name,
      })),
      groupName: normalizedGroupName,
      action: normalizedAction,
      onProgress: (p) => {
        emitProgress({
          ...p,
          templatesUpdated: updated,
          templatesSkipped: skipped,
        });
      },
    });
  }

  return {
    action: normalizedAction,
    groupName: normalizedGroupName,
    templateIndicesRequested: uniqueIndices.length,
    updated,
    skipped,
    touched,
    currentTemplateSync,
  };
}

const ALLOWED_COLORS = new Set([
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

function normalizeColorOverride(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (!ALLOWED_COLORS.has(s)) return "";
  return s;
}

function normalizeTemplate(t) {
  const role = String(t.role || "").trim();
  const rawGroups = Array.isArray(t.groups) ? t.groups.map(g => String(g).trim()).filter(Boolean) : [];
  return {
    name: String(t.name || "").trim(),
    agencySuffix: String(t.agencySuffix || "").trim().toLowerCase(),
    colorOverride: normalizeColorOverride(t.colorOverride),
    role: role || "Team Member",
    groups: mutualAidStore.stripCreatedGroupNames(rawGroups),
    isDefault: !!t.isDefault
  };
}

function assertTemplateGroupsAllowed(groups) {
  const list = Array.isArray(groups) ? groups : [];
  const blocked = list.filter((g) => mutualAidStore.isCreatedGroupName(g));
  if (blocked.length) {
    const err = new Error("Templates cannot include mutual aid groups.");
    err.status = 400;
    throw err;
  }
}

router.get("/", (req, res) => {
  const templates = store.load();
  const authUser = req.authentikUser || null;
  const access = accessSvc.getAgencyAccess(authUser);

  if (access.isGlobalAdmin) {
    return res.json(templates.map((t, i) => ({ ...t, _index: i })));
  }

  const allowed = access.allowedAgencySuffixes || [];
  if (!allowed.length) {
    return res.json([]);
  }

  const allowedSet = new Set(allowed.map((s) => String(s || "").trim().toLowerCase()));
  const filtered = templates
    .map((t, i) => ({ ...t, _index: i }))
    .filter((t) => allowedSet.has(String(t.agencySuffix || "").trim().toLowerCase()));

  res.json(filtered);
});

router.get("/current-template-counts", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);
    const allowed = access.isGlobalAdmin
      ? null
      : (Array.isArray(access.allowedAgencySuffixes) ? access.allowedAgencySuffixes : []);
    const counts = await usersSvc.getCurrentTemplateCountsByTemplate({
      allowedAgencySuffixes: allowed,
    });
    return res.json({ success: true, counts });
  } catch (err) {
    return res.status(400).json({ error: String(err?.message || err || "Failed to load template user counts") });
  }
});

function csvEscapeCell(value) {
  const s = String(value ?? "");
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function listTemplatesVisibleToUser(authUser) {
  const templates = store.load();
  const access = accessSvc.getAgencyAccess(authUser);

  if (access.isGlobalAdmin) {
    return templates.slice();
  }

  const allowed = access.allowedAgencySuffixes || [];
  if (!allowed.length) return [];

  const allowedSet = new Set(allowed.map((s) => String(s || "").trim().toLowerCase()));
  return templates.filter((t) =>
    allowedSet.has(String(t.agencySuffix || "").trim().toLowerCase())
  );
}

function buildTemplatesExportCsv(templates) {
  const header = [
    "Template Name",
    "Username Suffix",
    "Color Override",
    "Role",
    "Default Template",
    "Groups",
  ];
  const lines = [header.map(csvEscapeCell).join(",")];
  const sorted = (Array.isArray(templates) ? templates : [])
    .slice()
    .sort((a, b) => {
      const agencyCmp = String(a?.agencySuffix || "").localeCompare(
        String(b?.agencySuffix || ""),
        undefined,
        { sensitivity: "base" }
      );
      if (agencyCmp !== 0) return agencyCmp;
      return String(a?.name || "").localeCompare(String(b?.name || ""), undefined, {
        sensitivity: "base",
      });
    });

  for (const t of sorted) {
    const groups = Array.isArray(t?.groups)
      ? t.groups.map((g) => String(g || "").trim()).filter(Boolean)
      : [];
    lines.push(
      [
        t?.name || "",
        t?.agencySuffix || "",
        t?.colorOverride || "",
        t?.role || "Team Member",
        t?.isDefault ? "Yes" : "No",
        groups.join("; "),
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

    const visible = listTemplatesVisibleToUser(authUser);
    const csv = buildTemplatesExportCsv(visible);

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "EXPORT_TEMPLATES_CSV",
      targetType: "template",
      targetId: "bulk",
      details: {
        templateCount: visible.length,
      },
    });

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="tak-portal-templates-${stamp}.csv"`
    );
    return res.send(csv);
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Export failed" });
  }
});

router.post("/", (req, res) => {
  const templates = store.load();
  let t;
  try {
    t = normalizeTemplate(req.body || {});
    assertTemplateGroupsAllowed(req.body?.groups);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message || "Invalid template groups" });
  }
  const authUser = req.authentikUser || null;

  if (t.agencySuffix && !accessSvc.isSuffixAllowed(authUser, t.agencySuffix)) {
    return res.status(403).json({ error: "You do not have access to that agency." });
  }

  if (t.agencySuffix) {
    try {
      agenciesSvc.assertAgencyActiveBySuffix(t.agencySuffix);
    } catch (err) {
      return res.status(403).json({ error: err.message || "Agency is disabled." });
    }
  }

  if (!t.name) return res.status(400).json({ error: "Template name is required" });
  if (!t.groups.length) return res.status(400).json({ error: "At least one group is required" });

  const exists = templates.some(x =>
    String(x.name).toLowerCase() === t.name.toLowerCase() &&
    String(x.agencySuffix || "").toLowerCase() === t.agencySuffix
  );
  if (exists) return res.status(400).json({ error: "Template already exists for the selected agency" });

  if (t.isDefault) {
    const sfx = t.agencySuffix;
    templates.forEach((existing) => {
      if (String(existing.agencySuffix || "").trim().toLowerCase() === sfx) {
        existing.isDefault = false;
      }
    });
  }

  templates.push(t);
  store.save(templates);
  const currentTemplateSync = null;

  auditSvc.logEvent({
    actor: authUser,
    request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
    action: "CREATE_TEMPLATE",
    targetType: "template",
    targetId: auditDetails.templateTargetId(t.name, t.agencySuffix),
    details: auditDetails.buildTemplateCreateDetails(t),
  });

  res.json({ success: true, currentTemplateSync });
});

router.put("/:index", async (req, res) => {
  const idx = Number(req.params.index);
  const templates = store.load();
  if (!Number.isInteger(idx) || !templates[idx]) return res.status(404).json({ error: "Not found" });

  const existing = templates[idx];
  const authUser = req.authentikUser || null;

  if (existing && existing.agencySuffix && !accessSvc.isSuffixAllowed(authUser, existing.agencySuffix)) {
    return res.status(403).json({ error: "You do not have access to this template." });
  }

  let t;
  try {
    t = normalizeTemplate(req.body || {});
    assertTemplateGroupsAllowed(req.body?.groups);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message || "Invalid template groups" });
  }

  if (t.agencySuffix && !accessSvc.isSuffixAllowed(authUser, t.agencySuffix)) {
    return res.status(403).json({ error: "You do not have access to that agency." });
  }
  if (t.agencySuffix) {
    try {
      agenciesSvc.assertAgencyActiveBySuffix(t.agencySuffix);
    } catch (err) {
      return res.status(403).json({ error: err.message || "Agency is disabled." });
    }
  }
  if (!t.name) return res.status(400).json({ error: "Template name is required" });
  if (!t.groups.length) return res.status(400).json({ error: "At least one group is required" });

  const exists = templates.some((x, i) =>
    i !== idx &&
    String(x.name).toLowerCase() === t.name.toLowerCase() &&
    String(x.agencySuffix || "").toLowerCase() === t.agencySuffix
  );
  if (exists) return res.status(400).json({ error: "Template already exists for the selected agency" });

  if (t.isDefault) {
    const sfx = t.agencySuffix;
    templates.forEach((existing2) => {
      if (String(existing2.agencySuffix || "").trim().toLowerCase() === sfx) {
        existing2.isDefault = false;
      }
    });
  }

  templates[idx] = {
    ...templates[idx],
    ...t
  };

  store.save(templates);
  const beforeGroups = Array.isArray(existing?.groups)
    ? existing.groups.map((g) => String(g || "").trim()).filter(Boolean)
    : [];
  const afterGroups = Array.isArray(t?.groups)
    ? t.groups.map((g) => String(g || "").trim()).filter(Boolean)
    : [];
  let currentTemplateSync = null;
  try {
    const oldName = String(existing?.name || "").trim();
    const newName = String(t?.name || "").trim();
    const oldAgency = String(existing?.agencySuffix || "").trim().toLowerCase();
    const beforeSet = new Set(beforeGroups);
    const afterSet = new Set(afterGroups);
    const groupsChanged =
      beforeSet.size !== afterSet.size ||
      Array.from(beforeSet).some((g) => !afterSet.has(g));
    const nameChanged = oldName !== newName;

    if (oldName && newName && oldAgency && (nameChanged || groupsChanged)) {
      currentTemplateSync = await usersSvc.syncUsersForTemplateSave({
        agencySuffix: oldAgency,
        fromTemplateName: oldName,
        toTemplateName: newName,
        templateGroupNames: afterGroups,
        applyGroupOverwrite: groupsChanged,
      });
    } else {
      currentTemplateSync = { matched: 0, updated: 0 };
    }
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Template rename saved, but current_template sync failed" });
  }

  auditSvc.logEvent({
    actor: authUser,
    request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
    action: "UPDATE_TEMPLATE",
    targetType: "template",
    targetId: auditDetails.templateTargetId(templates[idx]?.name, templates[idx]?.agencySuffix),
    details: auditDetails.buildTemplateUpdateDetails({
      existing,
      updated: templates[idx],
      beforeGroups,
      afterGroups,
      currentTemplateSync,
      templateIndex: idx,
    }),
  });

  res.json({ success: true, currentTemplateSync });
});

router.delete("/:index", async (req, res) => {
  const idx = Number(req.params.index);
  const templates = store.load();
  if (!Number.isInteger(idx) || !templates[idx]) return res.status(404).json({ error: "Not found" });

  const authUser = req.authentikUser || null;
  const existing = templates[idx];

  if (existing && existing.agencySuffix && !accessSvc.isSuffixAllowed(authUser, existing.agencySuffix)) {
    return res.status(403).json({ error: "You do not have access to this template." });
  }

  let currentTemplateSync = null;
  try {
    const oldName = String(existing?.name || "").trim();
    const oldAgency = String(existing?.agencySuffix || "").trim().toLowerCase();
    if (oldName && oldAgency) {
      currentTemplateSync = await usersSvc.bulkSetCurrentTemplateForAgencyUsers({
        agencySuffix: oldAgency,
        fromTemplate: oldName,
        toTemplate: "Manual Group Selection",
      });
    } else {
      currentTemplateSync = { matched: 0, updated: 0 };
    }
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Template delete blocked: current_template sync failed" });
  }

  templates.splice(idx, 1);
  store.save(templates);

  auditSvc.logEvent({
    actor: authUser,
    request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
    action: "DELETE_TEMPLATE",
    targetType: "template",
    targetId: auditDetails.templateTargetId(existing?.name, existing?.agencySuffix),
    details: auditDetails.buildTemplateDeleteDetails(existing, currentTemplateSync),
  });

  res.json({ success: true });
});

router.post("/bulk-group-update", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const out = await runBulkTemplateGroupUpdate({
      action: req.body?.action,
      groupName: req.body?.groupName,
      templateIndices: req.body?.templateIndices,
      authUser,
    });

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: out.action === "add" ? "BULK_ADD_GROUP_TO_TEMPLATES" : "BULK_REMOVE_GROUP_FROM_TEMPLATES",
      targetType: "template",
      targetId: out.groupName || "bulk",
      details: auditDetails.buildBulkTemplateGroupAuditDetails(out),
    });

    return res.json({
      success: true,
      updated: out.updated,
      skipped: out.skipped,
      currentTemplateSync: out.currentTemplateSync,
    });
  } catch (err) {
    return res.status(400).json({ error: err?.message || "Bulk template update failed" });
  }
});

router.post("/bulk-group-update/start", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const payload = req.body || {};
    const templateIndices = Array.isArray(payload.templateIndices) ? payload.templateIndices : [];
    const jobId = newTemplateBulkJobId();
    const startedAt = Date.now();

    templateBulkJobs.set(jobId, {
      jobId,
      status: "running",
      phase: "queued",
      total: templateIndices.length,
      processed: 0,
      matched: 0,
      updated: 0,
      groupsUpdated: 0,
      templatesUpdated: 0,
      templatesSkipped: 0,
      error: null,
      result: null,
      startedAt,
      finishedAt: null,
      durationMs: null,
      durationSeconds: null,
    });

    (async () => {
      try {
        const out = await runBulkTemplateGroupUpdate({
          action: payload.action,
          groupName: payload.groupName,
          templateIndices,
          authUser,
          onProgress: (p) => {
            const job = templateBulkJobs.get(jobId);
            if (!job || job.status !== "running") return;
            if (!p || typeof p !== "object") return;
            if (p.phase) job.phase = String(p.phase);
            if (Number.isFinite(Number(p.total))) job.total = Number(p.total);
            if (Number.isFinite(Number(p.processed))) job.processed = Number(p.processed);
            if (Number.isFinite(Number(p.matched))) job.matched = Number(p.matched);
            if (Number.isFinite(Number(p.updated))) job.updated = Number(p.updated);
            if (Number.isFinite(Number(p.groupsUpdated))) job.groupsUpdated = Number(p.groupsUpdated);
            if (Number.isFinite(Number(p.templatesUpdated))) job.templatesUpdated = Number(p.templatesUpdated);
            if (Number.isFinite(Number(p.templatesSkipped))) job.templatesSkipped = Number(p.templatesSkipped);
          },
        });

        const finishedAt = Date.now();
        const durationMs = finishedAt - startedAt;
        const job = templateBulkJobs.get(jobId);
        if (job) {
          job.status = "done";
          job.phase = "done";
          job.result = {
            updated: out.updated,
            skipped: out.skipped,
            currentTemplateSync: out.currentTemplateSync,
          };
          job.matched = Number(out.currentTemplateSync?.matched || job.matched || 0);
          job.updated = Number(out.currentTemplateSync?.updated || job.updated || 0);
          job.groupsUpdated = Number(out.currentTemplateSync?.groupsUpdated || job.groupsUpdated || 0);
          job.templatesUpdated = Number(out.updated || 0);
          job.templatesSkipped = Number(out.skipped || 0);
          job.finishedAt = finishedAt;
          job.durationMs = durationMs;
          job.durationSeconds = Math.round((durationMs / 1000) * 10) / 10;
        }

        auditSvc.logEvent({
          actor: authUser,
          request: { method: "POST", path: "/api/templates/bulk-group-update/start", ip: req.ip },
          action: out.action === "add" ? "BULK_ADD_GROUP_TO_TEMPLATES" : "BULK_REMOVE_GROUP_FROM_TEMPLATES",
          targetType: "template",
          targetId: out.groupName || "bulk",
          details: auditDetails.buildBulkTemplateGroupAuditDetails({
            ...out,
            durationMs,
            jobId,
          }),
        });
      } catch (err) {
        const finishedAt = Date.now();
        const durationMs = finishedAt - startedAt;
        const job = templateBulkJobs.get(jobId);
        if (job) {
          job.status = "failed";
          job.phase = "failed";
          job.error = err?.message || String(err);
          job.finishedAt = finishedAt;
          job.durationMs = durationMs;
          job.durationSeconds = Math.round((durationMs / 1000) * 10) / 10;
        }
        auditSvc.logEvent({
          actor: authUser,
          request: { method: "POST", path: "/api/templates/bulk-group-update/start", ip: req.ip },
          action: "BULK_TEMPLATE_GROUP_UPDATE_FAILED",
          targetType: "template",
          targetId: "bulk",
          details: {
            jobId,
            groupName: String(payload.groupName || ""),
            error: err?.message || String(err),
            durationMs,
          },
        });
      }
    })();

    setTimeout(() => templateBulkJobs.delete(jobId), 60 * 60 * 1000).unref?.();
    return res.json({ success: true, jobId });
  } catch (err) {
    return res.status(400).json({ error: err?.message || "Bulk template update failed" });
  }
});

router.get("/bulk-jobs/:jobId", (req, res) => {
  const jobId = String(req.params.jobId || "");
  const job = templateBulkJobs.get(jobId);
  if (!job) return res.status(404).json({ error: "Template bulk job not found" });
  return res.json({
    success: true,
    ...job,
  });
});

module.exports = router;
