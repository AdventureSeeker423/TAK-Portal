/**
 * /api/access-control/* — read/update permission overrides (gated by page.access_control).
 */

const express = require("express");
const usersSvc = require("../services/users.service");
const groupsSvc = require("../services/groups.service");
const authzRoles = require("../services/authzRoles.service");
const permsSvc = require("../services/permissions.service");
const registry = require("../services/permissions.registry");
const auditSvc = require("../services/auditLog.service");
const { getBool } = require("../services/env");
const api = require("../services/authentik");

const router = express.Router();

async function loadGroupNamesForUserId(userId) {
  const user = await usersSvc.getUserById(userId);
  const ids = Array.isArray(user.groups) ? user.groups : [];
  const names = [];
  for (const gid of ids) {
    try {
      const g = await groupsSvc.getGroupById(gid);
      if (g && g.name) names.push(g.name);
    } catch (_) {
      // ignore
    }
  }
  return { user, groupNames: names };
}

router.get("/registry", (req, res) => {
  const flat = registry.listAllPermissionMeta();
  const bySection = new Map();
  for (const m of flat) {
    const s = m.section || "other";
    if (!bySection.has(s)) bySection.set(s, []);
    bySection.get(s).push(m);
  }
  res.json({ permissions: flat, bySection: Object.fromEntries(bySection) });
});

router.get("/effective", async (req, res) => {
  try {
    const raw = String(req.query.user || req.query.username || "").trim();
    if (!raw) {
      return res.status(400).json({ error: "Missing ?user= (Authentik username)" });
    }

    const r = await api.get("/core/users/", { params: { username: raw } });
    const row = (r.data && r.data.results) ? r.data.results[0] : null;
    if (!row) {
      return res.status(404).json({ error: "User not found in Authentik" });
    }

    const { user, groupNames } = await loadGroupNamesForUserId(row.pk);
    const roles = authzRoles.computePortalRolesFromGroupNames(groupNames);
    const userStub = {
      username: user.username,
      isGlobalAdmin: roles.isGlobalAdmin,
      isAgencyAdmin: roles.isAgencyAdmin,
    };
    const authDisabled = getBool("PORTAL_AUTH_ENABLED", false) === false;
    const desc = permsSvc.describeEffectiveForUser(userStub, authDisabled);
    const byId = new Map(registry.listAllPermissionMeta().map((m) => [m.id, m]));
    const baseIds = Array.from(registry.getDefaultSetForRole(desc.baseRole)).sort();
    const effectiveLabels = desc.effectiveIds.map((id) => {
      const m = byId.get(id);
      return m
        ? { id, label: m.label, description: m.description, section: m.section }
        : { id, label: id, description: "", section: "other" };
    });

    return res.json({
      username: user.username,
      displayName: String(user.name || user.username),
      isGlobalAdmin: roles.isGlobalAdmin,
      isAgencyAdmin: roles.isAgencyAdmin,
      baseRole: desc.baseRole,
      baseIds,
      deny: desc.deny,
      effectiveIds: desc.effectiveIds,
      effectiveLabels,
    });
  } catch (e) {
    console.error("[access-control] /effective", e);
    return res
      .status(500)
      .json({ error: e && e.message ? e.message : "Server error" });
  }
});

router.get("/overrides", (req, res) => {
  res.json({ usernames: permsSvc.listAllOverrideUsernames() });
});

router.get("/overrides/:username", (req, res) => {
  let raw;
  try {
    raw = decodeURIComponent(String(req.params.username || ""));
  } catch (_) {
    raw = String(req.params.username || "");
  }
  const un = raw.trim();
  if (!un) {
    return res.status(400).json({ error: "Username required" });
  }
  return res.json({
    username: un,
    ...permsSvc.getOverridesForUser(un),
  });
});

router.put("/overrides/:username", express.json({ limit: "2mb" }), (req, res) => {
  let raw;
  try {
    raw = decodeURIComponent(String(req.params.username || ""));
  } catch (_) {
    raw = String(req.params.username || "");
  }
  const target = raw.trim().toLowerCase();
  if (!target) {
    return res.status(400).json({ error: "Username required" });
  }
  const deny = Array.isArray(req.body && req.body.deny) ? req.body.deny : [];
  const before = permsSvc.getOverridesForUser(target);
  try {
    permsSvc.saveOverridesForUser(target, deny);
  } catch (e) {
    return res.status(400).json({ error: e && e.message ? e.message : String(e) });
  }
  const after = permsSvc.getOverridesForUser(target);
  try {
    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: {
        method: req.method,
        path: req.originalUrl || req.path,
        ip: req.ip,
      },
      action: "PERMISSION_OVERRIDES_UPDATE",
      targetType: "user",
      targetId: target,
      details: { beforeDeny: before.deny, afterDeny: after.deny },
    });
  } catch (_) {
    // non-blocking
  }
  return res.json({ ok: true, deny: after.deny });
});

module.exports = router;
