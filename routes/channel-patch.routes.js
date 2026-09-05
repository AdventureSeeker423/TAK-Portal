const router = require("express").Router();
const accessSvc = require("../services/access.service");
const agenciesStore = require("../services/agencies.service");
const mapMeta = require("../services/mapMeta.service");
const cotStream = require("../services/cotStream.service");
const store = require("../services/channelPatch.store");
const engine = require("../services/channelPatch.engine");
const auditSvc = require("../services/auditLog.service");
const channelPatchAccess = require("../services/channelPatchAccess.service");
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
 * Global admins: all map channels. Agency admins: Groups-page access only
 * (agency-owned + allowedAdminGroupIds), not personal map membership.
 */
async function loadScopedChannels(authUser) {
  cotStream.ensureBridgeStarted();
  const catalog = await mapMeta.getTakGroupCatalog(cotStream.getMarkerList(), {
    scopeMemberGroups: false,
    userGroupNames: [],
  });
  const groups = Array.isArray(catalog.groups) ? catalog.groups : [];
  return channelPatchAccess.buildScopedChannelPicker(authUser, groups);
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

function hideOutOfScopePatch(res) {
  return res.status(404).json({ error: "Patch not found" });
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
    const scoped = await loadScopedChannels(authUser);
    res.json({
      isGlobalAdmin: access.isGlobalAdmin,
      isAgencyAdmin: access.isAgencyAdmin,
      agencies,
      channels: scoped.channels,
      channelScope: scoped.channelScope,
      allowedChannelKeys: scoped.allowedChannelKeys,
      bridgeConnected: cotStream.isBridgeConnected(),
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
    const scoped = await loadScopedChannels(authUser);
    const allowed = channelPatchAccess.allowedKeySetFromPicker(scoped);
    const patches = channelPatchAccess
      .filterPatchesForAccess(access, store.list(), allowed)
      .map(enrichPatch);
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
    const scoped = await loadScopedChannels(authUser);
    const allowed = channelPatchAccess.allowedKeySetFromPicker(scoped);

    const groups = Array.isArray(body.groups) ? body.groups : [];
    channelPatchAccess.assertGroupsInScope(access, groups, allowed);

    const patch = store.create(
      {
        name: body.name,
        enabled: body.enabled !== false,
        groups,
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
        groups: patch.groups,
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

    const scoped = await loadScopedChannels(authUser);
    const allowed = channelPatchAccess.allowedKeySetFromPicker(scoped);

    if (
      !channelPatchAccess.filterPatchesForAccess(access, [existing], allowed)
        .length
    ) {
      return hideOutOfScopePatch(res);
    }

    const body = req.body || {};
    const nextGroups = body.groups != null ? body.groups : existing.groups;
    channelPatchAccess.assertGroupsInScope(access, nextGroups, allowed);

    const fields = {};
    if (body.name != null) fields.name = body.name;
    if (body.enabled != null) fields.enabled = body.enabled;
    if (body.groups != null) fields.groups = body.groups;
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
        groups: patch.groups,
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

    const scoped = await loadScopedChannels(authUser);
    const allowed = channelPatchAccess.allowedKeySetFromPicker(scoped);

    if (
      !channelPatchAccess.filterPatchesForAccess(access, [existing], allowed)
        .length
    ) {
      return hideOutOfScopePatch(res);
    }

    store.remove(req.params.id);

    auditSvc.auditFromRequest(req, {
      action: "CHANNEL_PATCH_DELETED",
      targetType: "channel_patch",
      targetId: existing.id,
      details: {
        name: existing.name,
        groups: existing.groups,
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
