const router = require("express").Router();
const store = require("../services/templates.service");
const accessSvc = require("../services/access.service");
const auditSvc = require("../services/auditLog.service");

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

  res.json({ success: true });
});

router.put("/:index", (req, res) => {
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
    },
  });

  res.json({ success: true });
});

router.delete("/:index", (req, res) => {
  const idx = Number(req.params.index);
  const templates = store.load();
  if (!Number.isInteger(idx) || !templates[idx]) return res.status(404).json({ error: "Not found" });

  const authUser = req.authentikUser || null;
  const existing = templates[idx];

  if (existing && existing.agencySuffix && !accessSvc.isSuffixAllowed(authUser, existing.agencySuffix)) {
    return res.status(403).json({ error: "You do not have access to this template." });
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
    },
  });

  res.json({ success: true });
});

module.exports = router;
