const router = require("express").Router();
const userRequestsSvc = require("../services/userRequests.service");
const auditSvc = require("../services/auditLog.service");
const permsSvc = require("../services/permissions.service");
const usersSvc = require("../services/users.service");
const agenciesSvc = require("../services/agencies.service");

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

    const body = req.body || {};
    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "CREATE_ACCESS_REQUEST",
      targetType: "user_request",
      targetId: String(created?.id || ""),
      details: {
        source: "api",
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email,
        badgeNumber: body.badgeNumber,
        radioCallsign: body.radioCallsign,
        agencySuffix: body.agencySuffix,
        otherAgency: body.otherAgency,
        otherReason: body.otherReason,
      },
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

router.get("/review/:token", (req, res) => {
  const request = userRequestsSvc.getByReviewToken(req.params.token);
  if (!request) return res.status(404).json({ error: "Not found" });
  return res.json({ request });
});

router.get("/review/:token/meta", async (req, res) => {
  try {
    const request = userRequestsSvc.getByReviewToken(req.params.token);
    if (!request) return res.status(404).json({ error: "Not found" });
    const agencySuffix = String(req.query.agencySuffix || request.agencySuffix || "").trim().toLowerCase();
    const templates = usersSvc.getTemplatesForAgency(agencySuffix);
    const groups = await usersSvc.getAllGroups({ includeHidden: false });
    const agencies = agenciesSvc.load();
    return res.json({ templates, groups, agencies });
  } catch (err) {
    return res.status(400).json({ error: err?.message || "Failed to load metadata." });
  }
});

router.post("/review/:token/approve", async (req, res) => {
  try {
    const request = userRequestsSvc.getByReviewToken(req.params.token);
    if (!request) return res.status(404).json({ error: "Not found" });

    const payload = req.body || {};
    let permRaw = payload.permissions;
    if (Array.isArray(permRaw)) permRaw = permRaw[0];
    permRaw = String(permRaw ?? "user").trim().toLowerCase();
    if (!permRaw) permRaw = "user";
    const allowedPerm = ["user", "agency_admin"];
    if (!allowedPerm.includes(permRaw)) {
      return res.status(400).json({ error: "Invalid permissions value." });
    }
    payload.permissions = permRaw;

    const result = await usersSvc.createUser(payload, {
      createdBy: {
        username: "request-access-review-link",
        displayName: "Request Access Review Link",
      },
      creationMethod: "request_access_review_link",
    });

    userRequestsSvc.deleteRequest(request.id);

    auditSvc.logEvent({
      actor: null,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "CREATE_USER",
      targetType: "user",
      targetId: String(result?.user?.pk || ""),
      details: {
        username: result?.user?.username,
        email: result?.user?.email,
        name: result?.user?.name,
        groups: Array.isArray(result?.groups)
          ? result.groups.map((g) => g?.name).filter(Boolean)
          : [],
        created_method: "request_access_review_link",
        sourceRequestId: request.id,
      },
    });

    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(400).json({ error: err?.message || "Failed to create user." });
  }
});

router.post("/review/:token/reject", (req, res) => {
  const request = userRequestsSvc.getByReviewToken(req.params.token);
  if (!request) return res.status(404).json({ error: "Not found" });

  const ok = userRequestsSvc.deleteRequest(request.id);
  if (!ok) return res.status(404).json({ error: "Not found" });

  auditSvc.logEvent({
    actor: null,
    request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
    action: "REJECT_ACCESS_REQUEST",
    targetType: "user_request",
    targetId: String(request.id),
    details: {
      request,
      summary: request
        ? `Rejected access request for ${request.firstName || ""} ${request.lastName || ""} (${request.email || "no email"}).`
        : "Rejected access request.",
      source: "request_access_review_link",
    },
  });

  return res.json({ success: true });
});

// Admin: delete a request (reject)
router.delete("/:id", requireUserRequestsApi, (req, res) => {
  const deleteReason = String(req.query.reason || "").trim().toLowerCase();
  const isApproveCleanup =
    deleteReason === "approved" ||
    deleteReason === "approve" ||
    deleteReason === "created";
  const before = userRequestsSvc
    .listRequestsForUser(req.authentikUser)
    .find((x) => String(x?.id) === String(req.params.id)) || null;

  const ok = userRequestsSvc.deleteRequestForUser(req.params.id, req.authentikUser);
  if (!ok) return res.status(404).json({ error: "Not found" });

  if (!isApproveCleanup) {
    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "REJECT_ACCESS_REQUEST",
      targetType: "user_request",
      targetId: String(req.params.id),
      details: {
        request: before,
        summary: before
          ? `Rejected access request for ${before.firstName || ""} ${before.lastName || ""} (${before.email || "no email"}).`
          : "Rejected access request.",
      },
    });
  }

  return res.json({ success: true });
});

module.exports = router;
