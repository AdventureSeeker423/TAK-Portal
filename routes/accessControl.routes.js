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
const accessSvc = require("../services/access.service");
const agenciesSvc = require("../services/agencies.service");
const { getBool, getString } = require("../services/env");
const api = require("../services/authentik");

const router = express.Router();
const PERMISSION_UI_ORDER = [
  "page.dashboard",
  "page.users",
  "page.groups",
  "page.templates",
  "page.audit_log",
  "page.data_package",
  "page.data_sync",
  "page.email",
  "page.locate",
  "page.mutual_aid",
  "page.agencies",
  "page.integrations",
  "page.plugin_manager",
  "page.access_control",
  "page.settings",
];

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
  const flat = registry.listAllPermissionMeta().slice().sort((a, b) => {
    const ai = PERMISSION_UI_ORDER.indexOf(a.id);
    const bi = PERMISSION_UI_ORDER.indexOf(b.id);
    const aa = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
    const bb = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
    if (aa !== bb) return aa - bb;
    return String(a.label || a.id).localeCompare(String(b.label || b.id));
  });
  const bySection = new Map();
  for (const m of flat) {
    const s = m.section || "other";
    if (!bySection.has(s)) bySection.set(s, []);
    bySection.get(s).push(m);
  }
  res.json({ permissions: flat, bySection: Object.fromEntries(bySection) });
});

router.post("/user-role/:userId", express.json({ limit: "1mb" }), async (req, res) => {
  try {
    const actor = req.authentikUser || null;
    if (!actor || !actor.isGlobalAdmin) {
      return res.status(403).json({ error: "Only global admins can change base user roles." });
    }
    const desiredRole = String(req.body?.role || "").trim().toLowerCase();
    if (!["user", "agency_admin", "global_admin"].includes(desiredRole)) {
      return res.status(400).json({ error: "Invalid role." });
    }
    const userId = String(req.params.userId || "").trim();
    if (!userId) return res.status(400).json({ error: "Missing user id." });

    const target = await usersSvc.getUserById(userId);
    if (!target) return res.status(404).json({ error: "User not found." });
    const currentGroups = new Set((target.groups || []).map((x) => String(x)));
    const allGroups = await groupsSvc.getAllGroups({ includeHidden: true });
    const groupNameById = new Map(
      (allGroups || []).map((g) => [String(g?.pk || ""), String(g?.name || "")])
    );
    const groupsByNameLower = new Map(
      (allGroups || []).map((g) => [String(g?.name || "").trim().toLowerCase(), String(g?.pk || "")])
    );
    const currentGroupNames = Array.from(currentGroups)
      .map((id) => groupNameById.get(String(id)) || "")
      .filter(Boolean);
    const currentRoles = authzRoles.computePortalRolesFromGroupNames(currentGroupNames);
    const previousRole = currentRoles.isGlobalAdmin
      ? "global_admin"
      : currentRoles.isAgencyAdmin
      ? "agency_admin"
      : "user";

    const globalGroupNames = String(getString("PORTAL_AUTH_REQUIRED_GROUP", ""))
      .split(",")
      .map((x) => String(x || "").trim().toLowerCase())
      .filter(Boolean);
    const globalIds = globalGroupNames
      .map((n) => groupsByNameLower.get(n))
      .filter(Boolean);

    const attrs = target.attributes || {};
    const userAbbr = String(attrs.agency_abbreviation || "").trim().toUpperCase();
    const agency = (agenciesSvc.load() || []).find(
      (a) => String(a?.groupPrefix || "").trim().toUpperCase() === userAbbr
    );
    const agencyAdminGroupNames = agency
      ? accessSvc.getAllAgencyAdminGroupNames(agency).map((n) => String(n || "").trim().toLowerCase())
      : [];
    const agencyAdminIds = agencyAdminGroupNames
      .map((n) => groupsByNameLower.get(n))
      .filter(Boolean);

    if ((desiredRole === "agency_admin" || desiredRole === "user") && !agencyAdminIds.length) {
      return res.status(400).json({
        error: "Cannot change role: agency admin group not resolvable for this user.",
      });
    }
    if (desiredRole === "global_admin" && !globalIds.length) {
      return res.status(400).json({ error: "Global admin groups are not configured." });
    }

    const toAdd = new Set();
    const toRemove = new Set();
    if (desiredRole === "user") {
      agencyAdminIds.forEach((id) => toRemove.add(id));
      globalIds.forEach((id) => toRemove.add(id));
    } else if (desiredRole === "agency_admin") {
      agencyAdminIds.forEach((id) => toAdd.add(id));
      globalIds.forEach((id) => toRemove.add(id));
    } else {
      globalIds.forEach((id) => toAdd.add(id));
      agencyAdminIds.forEach((id) => toRemove.add(id));
    }
    for (const id of Array.from(toAdd)) if (currentGroups.has(id)) toAdd.delete(id);
    for (const id of Array.from(toRemove)) if (!currentGroups.has(id)) toRemove.delete(id);

    if (toAdd.size) await usersSvc.addUserGroups(userId, Array.from(toAdd));
    if (toRemove.size) await usersSvc.removeUserGroups(userId, Array.from(toRemove));
    // Any explicit per-user permission customizations must be cleared when base role changes.
    permsSvc.saveOverridesForUser(String(target.username || "").trim().toLowerCase(), {
      deny: [],
      allow: [],
    });

    const { groupNames } = await loadGroupNamesForUserId(userId);
    const roles = authzRoles.computePortalRolesFromGroupNames(groupNames);
    const resultingRole = roles.isGlobalAdmin
      ? "global_admin"
      : roles.isAgencyAdmin
      ? "agency_admin"
      : "user";

    auditSvc.logEvent({
      actor,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "ACCESS_CONTROL_ROLE_CHANGE",
      targetType: "user",
      targetId: String(target.username || userId).trim().toLowerCase(),
      details: {
        username: String(target.username || "").trim().toLowerCase(),
        previousRole,
        requestedRole: desiredRole,
        resultingRole,
        userId,
        groupsAdded: Array.from(toAdd),
        groupsRemoved: Array.from(toRemove),
        summary: `Changed access role for ${String(target.username || "user").trim()} from ${previousRole} to ${resultingRole}. Cleared granular permission overrides.`,
      },
    });

    return res.json({ ok: true, role: resultingRole });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed to update role." });
  }
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
      allow: desc.allow,
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

router.post("/overrides/reset-all", (req, res) => {
  try {
    const actor = req.authentikUser || null;
    if (!actor || !actor.isGlobalAdmin) {
      return res.status(403).json({ error: "Only global admins can reset all overrides." });
    }
    const beforeUsernames = permsSvc.listAllOverrideUsernames();
    permsSvc.clearAllOverrides();
    auditSvc.logEvent({
      actor,
      request: {
        method: req.method,
        path: req.originalUrl || req.path,
        ip: req.ip,
      },
      action: "PERMISSION_OVERRIDES_RESET_ALL",
      targetType: "permission_overrides",
      targetId: "all_users",
      details: {
        affectedUsers: beforeUsernames,
        affectedCount: beforeUsernames.length,
        summary: `Reset all granular permission overrides to defaults for ${beforeUsernames.length} user(s).`,
      },
    });
    return res.json({ ok: true, affectedCount: beforeUsernames.length });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed to reset overrides." });
  }
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
  const allow = Array.isArray(req.body && req.body.allow) ? req.body.allow : [];
  const before = permsSvc.getOverridesForUser(target);
  try {
    permsSvc.saveOverridesForUser(target, { deny, allow });
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
      details: {
        username: target,
        beforeDeny: before.deny,
        afterDeny: after.deny,
        beforeAllow: before.allow || [],
        afterAllow: after.allow || [],
        summary: `Updated granular permission overrides for ${target}: deny ${before.deny.length} -> ${after.deny.length}, allow ${(before.allow || []).length} -> ${(after.allow || []).length}.`,
      },
    });
  } catch (_) {
    // non-blocking
  }
  return res.json({ ok: true, deny: after.deny, allow: after.allow || [] });
});

module.exports = router;
