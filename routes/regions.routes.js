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
  return (Array.isArray(regions) ? regions : []).map((r) => {
    const members = regionsSvc.agenciesForRegion(r.id, agencies);
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
    };
  });
}

/** List regions (authenticated). Includes agency counts for Settings UI. */
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

router.delete("/:id", (req, res) => {
  if (!requireGlobalAdmin(req, res)) return;
  try {
    const id = String(req.params.id || "").trim();
    const result = regionsSvc.remove(id);
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

/**
 * Bulk-assign all agencies in a state+county to this region.
 * Body: { state, county }
 */
router.post("/:id/assign-county", (req, res) => {
  if (!requireGlobalAdmin(req, res)) return;
  try {
    const id = String(req.params.id || "").trim();
    const result = regionsSvc.assignCountyToRegion(
      id,
      req.body?.state,
      req.body?.county
    );
    try {
      auditSvc.logEvent({
        actor: req.authentikUser,
        request: auditRequest(req),
        action: "ASSIGN_REGION_COUNTY",
        targetType: "region",
        targetId: id,
        details: {
          state: req.body?.state,
          county: req.body?.county,
          updated: result.updated,
          matched: result.matched,
        },
      });
    } catch (_) {}
    res.json(result);
  } catch (err) {
    const msg = err?.message || "Failed to assign county";
    const status = /required|not found/i.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  }
});

module.exports = router;
