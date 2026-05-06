const router = require("express").Router();
const store = require("../services/templates.service");
const accessSvc = require("../services/access.service");
const auditSvc = require("../services/auditLog.service");
const usersSvc = require("../services/users.service");

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
  return {
    name: String(t.name || "").trim(),
    agencySuffix: String(t.agencySuffix || "").trim().toLowerCase(),
    colorOverride: normalizeColorOverride(t.colorOverride),
    role: role || "Team Member",
    groups: Array.isArray(t.groups) ? t.groups.map(g => String(g).trim()).filter(Boolean) : [],
    isDefault: !!t.isDefault
  };
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

router.post("/", (req, res) => {
  const templates = store.load();
  const t = normalizeTemplate(req.body || {});
  const authUser = req.authentikUser || null;

  if (t.agencySuffix && !accessSvc.isSuffixAllowed(authUser, t.agencySuffix)) {
    return res.status(403).json({ error: "You do not have access to that agency." });
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

  auditSvc.logEvent({
    actor: authUser,
    request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
    action: "CREATE_TEMPLATE",
    targetType: "template",
    targetId: String(templates.length - 1),
    details: {
      name: t.name,
      agencySuffix: t.agencySuffix,
      isDefault: !!t.isDefault,
      groupsCount: t.groups.length,
      colorOverride: t.colorOverride || "",
      role: t.role || "Team Member",
    },
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

  const t = normalizeTemplate(req.body || {});

  if (t.agencySuffix && !accessSvc.isSuffixAllowed(authUser, t.agencySuffix)) {
    return res.status(403).json({ error: "You do not have access to that agency." });
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
  let currentTemplateSync = null;
  try {
    const oldName = String(existing?.name || "").trim();
    const newName = String(t?.name || "").trim();
    const oldAgency = String(existing?.agencySuffix || "").trim().toLowerCase();
    const beforeGroups = Array.isArray(existing?.groups)
      ? existing.groups.map((g) => String(g || "").trim()).filter(Boolean)
      : [];
    const afterGroups = Array.isArray(t?.groups)
      ? t.groups.map((g) => String(g || "").trim()).filter(Boolean)
      : [];
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
    targetId: String(idx),
    details: {
      beforeName: String(existing?.name || ""),
      name: templates[idx]?.name,
      agencySuffix: templates[idx]?.agencySuffix,
      isDefault: !!templates[idx]?.isDefault,
      groupsCount: Array.isArray(templates[idx]?.groups) ? templates[idx].groups.length : 0,
      colorOverride: templates[idx]?.colorOverride || "",
      role: templates[idx]?.role || "Team Member",
      currentTemplateSync,
    },
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
    targetId: String(idx),
    details: {
      name: String(existing?.name || ""),
      agencySuffix: String(existing?.agencySuffix || "").trim().toLowerCase(),
      currentTemplateSync,
    },
  });

  res.json({ success: true });
});

router.post("/bulk-group-update", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const actionRaw = String(req.body?.action || "").trim().toLowerCase();
    const action = actionRaw === "remove" ? "remove" : actionRaw === "add" ? "add" : "";
    if (!action) {
      return res.status(400).json({ error: "Action must be 'add' or 'remove'." });
    }

    const groupName = String(req.body?.groupName || "").trim();
    if (!groupName) {
      return res.status(400).json({ error: "Group name is required." });
    }

    const indices = Array.isArray(req.body?.templateIndices)
      ? req.body.templateIndices
          .map((v) => Number(v))
          .filter((n) => Number.isInteger(n) && n >= 0)
      : [];
    if (!indices.length) {
      return res.status(400).json({ error: "Select one or more templates." });
    }

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
      if (action === "add") {
        if (nextGroups.includes(groupName)) {
          skipped += 1;
          continue;
        }
        nextGroups = Array.from(new Set([...nextGroups, groupName]));
      } else {
        if (!nextGroups.includes(groupName)) {
          skipped += 1;
          continue;
        }
        nextGroups = nextGroups.filter((g) => g !== groupName);
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
      for (const t of touched) {
        const templateName = String(t?.name || "").trim();
        const agencySuffix = String(t?.agencySuffix || "").trim().toLowerCase();
        if (!templateName || !agencySuffix) continue;
        const syncOut = await usersSvc.syncUsersForTemplateSave({
          agencySuffix,
          fromTemplateName: templateName,
          toTemplateName: templateName,
          templateGroupNames: Array.isArray(t?.afterGroups) ? t.afterGroups : [],
          applyGroupOverwrite: true,
        });
        currentTemplateSync.matched += Number(syncOut?.matched || 0);
        currentTemplateSync.updated += Number(syncOut?.updated || 0);
        currentTemplateSync.groupsUpdated += Number(syncOut?.groupsUpdated || 0);
        currentTemplateSync.templateAttrUpdated += Number(syncOut?.templateAttrUpdated || 0);
        currentTemplateSync.templatesProcessed += 1;
      }
    }

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: action === "add" ? "BULK_ADD_GROUP_TO_TEMPLATES" : "BULK_REMOVE_GROUP_FROM_TEMPLATES",
      targetType: "template",
      targetId: "bulk",
      details: {
        groupName,
        templateIndicesRequested: uniqueIndices.length,
        templatesUpdated: updated,
        templatesSkipped: skipped,
        currentTemplateSync,
        touched,
      },
    });

    return res.json({
      success: true,
      updated,
      skipped,
      currentTemplateSync,
    });
  } catch (err) {
    return res.status(400).json({ error: err?.message || "Bulk template update failed" });
  }
});

module.exports = router;
