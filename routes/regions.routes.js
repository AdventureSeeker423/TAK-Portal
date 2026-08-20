const router = require("express").Router();
const regionsSvc = require("../services/regions.service");
const regionRenameSvc = require("../services/regionRename.service");
const accessSvc = require("../services/access.service");
const agenciesStore = require("../services/agencies.service");
const auditSvc = require("../services/auditLog.service");

function requireGlobalAdmin(req, res) {
  const access = accessSvc.getAgencyAccess(req.authentikUser);
  if (!access.isGlobalAdmin) {
    res.status(403).json({ error: "Global admin required" });
    return null;
  }
  return access;
}

function auditRequest(req) {
  return {
    method: req.method,
    path: req.originalUrl || req.path,
    ip: req.ip,
  };
}

function withAgencyCounts(regions) {
  const agencies = agenciesStore.load();
  const locks = regionsSvc.listLocks();
  return (Array.isArray(regions) ? regions : []).map((r) => {
    const members = regionsSvc.agenciesForRegion(r.id, agencies);
    const lockedCounties = regionsSvc.locksForRegion(r.id, locks);
    return {
      ...r,
      agencyCount: members.length,
      agencies: members.map((a) => ({
        name: a.name,
        suffix: a.suffix,
        state: a.state,
        county: a.county,
        groupPrefix: a.groupPrefix,
      })),
      lockedCounties,
    };
  });
}

/** List county→region locks (authenticated). */
router.get("/county-locks", (req, res) => {
  try {
    const locks = regionsSvc.listLocks().map((l) => ({
      ...l,
      regionName: regionsSvc.getRegionName(l.regionId) || null,
    }));
    res.json(locks);
  } catch (err) {
    res.status(500).json({ error: err?.message || "Failed to list county assignments" });
  }
});

/**
 * Lock a state or county to a region.
 * Body: { state, county?, regionId } — omit county (or leave empty) to lock the entire state.
 */
router.post("/county-locks", (req, res) => {
  if (!requireGlobalAdmin(req, res)) return;
  try {
    const result = regionsSvc.lockLocation(
      req.body?.regionId,
      req.body?.state,
      req.body?.county
    );
    try {
      auditSvc.logEvent({
        actor: req.authentikUser,
        request: auditRequest(req),
        action:
          result.lock?.scope === "state"
            ? "LOCK_REGION_STATE"
            : "LOCK_REGION_COUNTY",
        targetType: "region",
        targetId: result.lock.regionId,
        details: {
          scope: result.lock.scope,
          state: result.lock.state,
          county: result.lock.county || null,
          agenciesUpdated: result.agenciesUpdated,
        },
      });
    } catch (_) {}
    res.status(201).json(result);
  } catch (err) {
    const msg = err?.message || "Failed to assign";
    const status = /required|not found|cannot assign/i.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  }
});

/**
 * Unlock a state or county.
 * Body/query: { state, county? } — omit county to unlock an entire-state lock.
 */
router.delete("/county-locks", (req, res) => {
  if (!requireGlobalAdmin(req, res)) return;
  try {
    const state = req.body?.state ?? req.query?.state;
    const county = req.body?.county ?? req.query?.county;
    const result = regionsSvc.unlockLocation(state, county);
    try {
      auditSvc.logEvent({
        actor: req.authentikUser,
        request: auditRequest(req),
        action:
          result.unlocked?.scope === "state"
            ? "UNLOCK_REGION_STATE"
            : "UNLOCK_REGION_COUNTY",
        targetType: "region",
        targetId: "geo-lock",
        details: result.unlocked,
      });
    } catch (_) {}
    res.json(result);
  } catch (err) {
    const msg = err?.message || "Failed to unassign";
    const status = /required|not found/i.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  }
});

/** List regions (authenticated). Includes agency counts and county locks. */
router.get("/", (req, res) => {
  try {
    const regions = withAgencyCounts(regionsSvc.listNormalized());
    res.json(regions);
  } catch (err) {
    res.status(500).json({ error: err?.message || "Failed to list regions" });
  }
});

router.post("/", (req, res) => {
  if (!requireGlobalAdmin(req, res)) return;
  try {
    const region = regionsSvc.create(req.body?.name);
    try {
      auditSvc.logEvent({
        actor: req.authentikUser,
        request: auditRequest(req),
        action: "CREATE_REGION",
        targetType: "region",
        targetId: region.id,
        details: { name: region.name },
      });
    } catch (_) {}
    res.status(201).json(region);
  } catch (err) {
    const msg = err?.message || "Failed to create region";
    const status = /required|already exists/i.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  }
});

router.put("/:id", async (req, res) => {
  if (!requireGlobalAdmin(req, res)) return;
  try {
    const id = String(req.params.id || "").trim();
    const result = await regionRenameSvc.renameRegion(id, req.body?.name);
    try {
      auditSvc.logEvent({
        actor: req.authentikUser,
        request: auditRequest(req),
        action: "RENAME_REGION",
        targetType: "region",
        targetId: result.region.id,
        details: {
          oldName: result.oldName,
          newName: result.newName,
          groupsRenamed: result.groupsRenamed,
        },
      });
    } catch (_) {}
    res.json(result);
  } catch (err) {
    const msg = err?.message || "Failed to rename region";
    const status = /required|already exists|not found/i.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  }
});

router.delete("/:id", async (req, res) => {
  if (!requireGlobalAdmin(req, res)) return;
  try {
    const id = String(req.params.id || "").trim();
    const result = await regionRenameSvc.deleteRegion(id);
    try {
      auditSvc.logEvent({
        actor: req.authentikUser,
        request: auditRequest(req),
        action: "DELETE_REGION",
        targetType: "region",
        targetId: result.region?.id || id,
        details: {
          name: result.region?.name,
          agenciesCleared: result.agenciesCleared,
          locksCleared: result.locksCleared,
          groupsDeleted: result.groupsDeleted,
          groupNames: result.groupNames,
        },
      });
    } catch (_) {}
    res.json(result);
  } catch (err) {
    const msg = err?.message || "Failed to delete region";
    const status = /required|not found/i.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  }
});

module.exports = router;
