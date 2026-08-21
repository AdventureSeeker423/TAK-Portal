const router = require("express").Router();
const accessSvc = require("../services/access.service");
const agenciesStore = require("../services/agencies.service");
const groupsSvc = require("../services/groups.service");
const groupsRoutes = require("./groups.routes");
const mapMeta = require("../services/mapMeta.service");
const cotStream = require("../services/cotStream.service");
const store = require("../services/channelPatch.store");
const engine = require("../services/channelPatch.engine");
const auditSvc = require("../services/auditLog.service");
const { toSafeApiError } = require("../services/apiErrorPayload.service");

function toErrorPayload(err) {
  return toSafeApiError(err);
}

function actorLabel(authUser) {
  if (!authUser) return "";
  return (
    String(authUser.name || "").trim() ||
    String(authUser.email || "").trim() ||
    String(authUser.uid || "").trim() ||
    ""
  );
}

/**
 * Agency-ready group catalog: global sees all map channels;
 * agency admins (future) see membership-scoped channels.
 */
async function loadScopedChannels(authUser, access) {
  cotStream.ensureBridgeStarted();
  const catalog = await mapMeta.getTakGroupCatalog(cotStream.getMarkerList(), {
    scopeMemberGroups: !access.isGlobalAdmin,
    userGroupNames: Array.isArray(authUser?.groups) ? authUser.groups : [],
  });

  // Prefer Authentik-visible groups when available (same filter as Groups/Email).
  let authGroups = [];
  try {
    const all = await groupsSvc.getAllGroups({});
    authGroups = groupsRoutes.filterGroupsVisibleToUser(authUser, all, {
      includeMutualAid: access.isGlobalAdmin,
    });
  } catch (_) {
    authGroups = [];
  }

  const authNames = new Set(
    (authGroups || [])
      .map((g) => String(g?.name || "").trim())
      .filter(Boolean)
      .map((n) => mapMeta.channelBaseKey(n))
      .filter(Boolean)
  );

  let channels = Array.isArray(catalog.groups) ? catalog.groups : [];
  // Drop Unassigned from picker
  channels = channels.filter(
    (g) => g.baseKey && g.baseKey !== mapMeta.UNASSIGNED_CHANNEL_KEY
  );

  if (!access.isGlobalAdmin && authNames.size) {
    channels = channels.filter((g) => authNames.has(g.baseKey));
  }

  return {
    channels: channels.map((g) => ({
      name: g.name,
      displayName: g.displayName || g.name,
      baseKey: g.baseKey,
      count: g.count || 0,
    })),
    channelScope: catalog.channelScope,
    allowedChannelKeys: catalog.allowedChannelKeys,
  };
}

function patchGroupKeys(patch) {
  const keys = new Set();
  const hub = mapMeta.channelBaseKey(patch?.hubGroup);
  if (hub) keys.add(hub);
  for (const s of patch?.spokes || []) {
    const k = mapMeta.channelBaseKey(s.group);
    if (k) keys.add(k);
  }
  return keys;
}

function filterPatchesForAccess(access, patches, allowedKeys) {
  if (access.isGlobalAdmin) return patches;
  const allow = allowedKeys instanceof Set ? allowedKeys : new Set(allowedKeys || []);
  if (!allow.size) return [];
  return patches.filter((p) => {
    const keys = patchGroupKeys(p);
    if (!keys.size) return false;
    for (const k of keys) {
      if (!allow.has(k)) return false;
    }
    return true;
  });
}

function assertGroupsInScope(access, hubGroup, spokes, allowedKeys) {
  if (access.isGlobalAdmin) return;
  const allow = allowedKeys instanceof Set ? allowedKeys : new Set(allowedKeys || []);
  const names = [hubGroup, ...(spokes || []).map((s) => s.group || s)];
  for (const n of names) {
    const k = mapMeta.channelBaseKey(n);
    if (!k || !allow.has(k)) {
      const err = new Error(`Group not in your agency scope: ${n}`);
      err.status = 403;
      throw err;
    }
  }
}

function enrichPatch(patch) {
  const hint = engine.getRuntimeHint(patch.id);
  return {
    ...patch,
    lastForwardAt: hint?.lastForwardAt || patch.lastForwardAt || null,
    lastError:
      hint && Object.prototype.hasOwnProperty.call(hint, "lastError")
        ? hint.lastError
        : patch.lastError || null,
    bridgeConnected: cotStream.isBridgeConnected(),
  };
}

// GET /api/channel-patch/meta
router.get("/meta", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);
    const agencies = accessSvc.filterAgenciesForUser(
      authUser,
      agenciesStore.load()
    );
    const scoped = await loadScopedChannels(authUser, access);
    res.json({
      isGlobalAdmin: access.isGlobalAdmin,
      isAgencyAdmin: access.isAgencyAdmin,
      agencies,
      channels: scoped.channels,
      channelScope: scoped.channelScope,
      allowedChannelKeys: scoped.allowedChannelKeys,
      bridgeConnected: cotStream.isBridgeConnected(),
      directions: Array.from(store.DIRECTIONS),
    });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

// GET /api/channel-patch
router.get("/", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);
    const scoped = await loadScopedChannels(authUser, access);
    const allowed = new Set(
      (scoped.allowedChannelKeys || scoped.channels.map((c) => c.baseKey)).filter(
        Boolean
      )
    );
    const patches = filterPatchesForAccess(access, store.list(), allowed).map(
      enrichPatch
    );
    res.json({ patches, bridgeConnected: cotStream.isBridgeConnected() });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

// POST /api/channel-patch
router.post("/", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);
    const body = req.body || {};
    const scoped = await loadScopedChannels(authUser, access);
    const allowed = new Set(
      (scoped.allowedChannelKeys || scoped.channels.map((c) => c.baseKey)).filter(
        Boolean
      )
    );

    assertGroupsInScope(access, body.hubGroup, body.spokes, allowed);

    const patch = store.create(
      {
        name: body.name,
        enabled: body.enabled !== false,
        hubGroup: body.hubGroup,
        spokes: body.spokes,
        agencyScope: access.isGlobalAdmin
          ? body.agencyScope || []
          : access.allowedAgencySuffixes || [],
      },
      actorLabel(authUser)
    );

    auditSvc.auditFromRequest(req, {
      action: "CHANNEL_PATCH_CREATED",
      targetType: "channel_patch",
      targetId: patch.id,
      details: {
        name: patch.name,
        hubGroup: patch.hubGroup,
        spokes: patch.spokes,
        summary: `Created channel patch ${patch.name}.`,
      },
    });

    res.status(201).json(enrichPatch(patch));
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: toErrorPayload(err) });
  }
});

// PATCH /api/channel-patch/:id
router.patch("/:id", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);
    const existing = store.getById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: "Patch not found" });
    }

    const scoped = await loadScopedChannels(authUser, access);
    const allowed = new Set(
      (scoped.allowedChannelKeys || scoped.channels.map((c) => c.baseKey)).filter(
        Boolean
      )
    );

    if (!access.isGlobalAdmin) {
      const visible = filterPatchesForAccess(access, [existing], allowed);
      if (!visible.length) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    const body = req.body || {};
    const nextHub = body.hubGroup != null ? body.hubGroup : existing.hubGroup;
    const nextSpokes = body.spokes != null ? body.spokes : existing.spokes;
    assertGroupsInScope(access, nextHub, nextSpokes, allowed);

    const fields = {};
    if (body.name != null) fields.name = body.name;
    if (body.enabled != null) fields.enabled = body.enabled;
    if (body.hubGroup != null) fields.hubGroup = body.hubGroup;
    if (body.spokes != null) fields.spokes = body.spokes;
    if (body.agencyScope != null && access.isGlobalAdmin) {
      fields.agencyScope = body.agencyScope;
    }

    const patch = store.update(req.params.id, fields);

    auditSvc.auditFromRequest(req, {
      action: "CHANNEL_PATCH_UPDATED",
      targetType: "channel_patch",
      targetId: patch.id,
      details: {
        name: patch.name,
        enabled: patch.enabled,
        hubGroup: patch.hubGroup,
        spokes: patch.spokes,
        summary: `Updated channel patch ${patch.name}.`,
      },
    });

    res.json(enrichPatch(patch));
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: toErrorPayload(err) });
  }
});

// DELETE /api/channel-patch/:id
router.delete("/:id", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);
    const existing = store.getById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: "Patch not found" });
    }

    const scoped = await loadScopedChannels(authUser, access);
    const allowed = new Set(
      (scoped.allowedChannelKeys || scoped.channels.map((c) => c.baseKey)).filter(
        Boolean
      )
    );

    if (!access.isGlobalAdmin) {
      const visible = filterPatchesForAccess(access, [existing], allowed);
      if (!visible.length) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    store.remove(req.params.id);

    auditSvc.auditFromRequest(req, {
      action: "CHANNEL_PATCH_DELETED",
      targetType: "channel_patch",
      targetId: existing.id,
      details: {
        name: existing.name,
        hubGroup: existing.hubGroup,
        summary: `Deleted channel patch ${existing.name}.`,
      },
    });

    res.json({ ok: true });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: toErrorPayload(err) });
  }
});

module.exports = router;
