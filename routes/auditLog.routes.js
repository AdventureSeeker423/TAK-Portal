const router = require("express").Router();
const auditSvc = require("../services/auditLog.service");
const accessSvc = require("../services/access.service");

// JSON API for audit log listing + filters.
// Access:
//  - Global Admin: all logs
//  - Agency Admin: only logs tied to agencies they manage
router.get("/", (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);

    if (!access.isGlobalAdmin && !access.isAgencyAdmin) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const query = {
      q: req.query.q,
      actor: req.query.actor,
      action: req.query.action,
      targetType: req.query.targetType,
      agencySuffix: req.query.agencySuffix,
      from: req.query.from,
      to: req.query.to,
      page: req.query.page,
      pageSize: req.query.pageSize,
    };

    // Enforce agency scoping for agency admins.
    if (!access.isGlobalAdmin) {
      const allowed = Array.isArray(access.allowedAgencySuffixes)
        ? access.allowedAgencySuffixes.map((s) => String(s || "").trim().toLowerCase())
        : [];

      // If the user specified an agency filter, ensure it's within allowed.
      if (query.agencySuffix) {
        const sfx = String(query.agencySuffix || "").trim().toLowerCase();
        if (!allowed.includes(sfx)) {
          return res
            .status(403)
            .json({ error: "You do not have access to that agency." });
        }
      }

      // For correctness, filter first then paginate.
      const requestedPage = Math.max(1, Number(query.page) || 1);
      const requestedPageSize = Math.min(500, Math.max(10, Number(query.pageSize) || 50));

      // Pull a large slice then filter; logs are capped (default 5000).
      const unpaged = auditSvc.queryLogs({ ...query, page: 1, pageSize: 5000 });
      const scoped = (unpaged.items || []).filter((it) => {
        const sfx = String(it?.agencySuffix || "").trim().toLowerCase();
        return sfx && allowed.includes(sfx);
      });

      const total = scoped.length;
      const pageCount = Math.max(1, Math.ceil(total / requestedPageSize));
      const page = Math.min(pageCount, requestedPage);
      const start = (page - 1) * requestedPageSize;
      const items = scoped.slice(start, start + requestedPageSize);

      return res.json({
        items,
        total,
        page,
        pageSize: requestedPageSize,
        pageCount,
      });
    }

    if (String(req.query.export || "").trim() === "1") {
      auditSvc.auditFromRequest(req, {
        action: "AUDIT_LOG_EXPORTED",
        targetType: "audit_log",
        targetId: "filtered",
        details: {
          filters: {
            q: query.q,
            actor: query.actor,
            action: query.action,
            targetType: query.targetType,
            agencySuffix: query.agencySuffix,
            from: query.from,
            to: query.to,
          },
          summary: "Exported filtered audit log as CSV from the Audit Log page.",
        },
      });
    }

    const result = auditSvc.queryLogs(query);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Unknown error" });
  }
});

router.get("/meta", (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);

    if (!access.isGlobalAdmin && !access.isAgencyAdmin) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const actions = auditSvc.listDistinctValues({ field: "actions" });
    const targetTypes = auditSvc.listDistinctValues({ field: "targetTypes" });
    const agencies = auditSvc.listDistinctValues({ field: "agencies" });
    const actors = auditSvc.listDistinctValues({ field: "actors" });

    if (!access.isGlobalAdmin) {
      const allowed = Array.isArray(access.allowedAgencySuffixes)
        ? access.allowedAgencySuffixes.map((s) => String(s || "").trim().toLowerCase())
        : [];
      return res.json({
        actions,
        targetTypes,
        agencies: agencies.filter((s) => allowed.includes(String(s || "").toLowerCase())),
        actors,
      });
    }

    return res.json({ actions, targetTypes, agencies, actors });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Unknown error" });
  }
});

module.exports = router;
