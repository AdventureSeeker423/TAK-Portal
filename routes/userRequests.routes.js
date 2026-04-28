const router = require("express").Router();
const userRequestsSvc = require("../services/userRequests.service");
const auditSvc = require("../services/auditLog.service");
const permsSvc = require("../services/permissions.service");

function requireUserRequestsApi(req, res, next) {
  const eff = req.effectivePermissionSet;
  if (!eff || !permsSvc.can(eff, "page.users")) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}


// Public: create a new access request
router.post("/", async (req, res) => {
  try {
    const created = await userRequestsSvc.createRequest(req.body || {});

    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "CREATE_ACCESS_REQUEST",
      targetType: "user_request",
      targetId: String(created?.id || ""),
      details: req.body || {},
    });

    return res.json({ success: true, request: created });
  } catch (err) {
    return res.status(400).json({ error: err?.message || "Invalid request" });
  }
});

// Admin: list all pending requests
router.get("/", requireUserRequestsApi, (req, res) => {
  const list = userRequestsSvc.listRequestsForUser(req.authentikUser);
  return res.json(list);
});

// Admin: delete a request (reject)
router.delete("/:id", requireUserRequestsApi, (req, res) => {
  const before = userRequestsSvc
    .listRequestsForUser(req.authentikUser)
    .find((x) => String(x?.id) === String(req.params.id)) || null;

  const ok = userRequestsSvc.deleteRequestForUser(req.params.id, req.authentikUser);
  if (!ok) return res.status(404).json({ error: "Not found" });

  auditSvc.logEvent({
    actor: req.authentikUser || null,
    request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
    action: "DELETE_ACCESS_REQUEST",
    targetType: "user_request",
    targetId: String(req.params.id),
    details: before,
  });

  return res.json({ success: true });
});

module.exports = router;
