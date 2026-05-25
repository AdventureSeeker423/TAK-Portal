const path = require("path");
const express = require("express");
const multer = require("multer");
const mouService = require("../services/mouService");
const mouScheduler = require("../services/mouScheduler");
const auditSvc = require("../services/auditLog.service");
const permsSvc = require("../services/permissions.service");
const accessSvc = require("../services/access.service");
const usersSvc = require("../services/users.service");
const tokensSvc = require("../services/authentikTokens.service");
const { getBool } = require("../services/env");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });
const USER_AGREEMENT_SESSION_COOKIE = "mou_user_agreement_session";

function renderNotFound(req, res) {
  if ((req.originalUrl || req.path || "").startsWith("/api/")) {
    return res.status(404).json({ error: "Not found" });
  }
  return res.status(404).render("access-denied", {
    username: req.authentikUser?.username || "",
  });
}

function requireMouEnabled(req, res, next) {
  if (!mouService.isEnabled()) return renderNotFound(req, res);
  return next();
}

function requireMouPermission(req, res, next) {
  const eff = req.effectivePermissionSet;
  if (!eff || !permsSvc.can(eff, "page.mou")) {
    if ((req.originalUrl || req.path || "").startsWith("/api/")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    return res.status(403).render("access-denied", {
      username: req.authentikUser?.username || "",
    });
  }
  return next();
}

function requireGlobalAdmin(req, res, next) {
  if (!req.authentikUser || !req.authentikUser.isGlobalAdmin) {
    if ((req.originalUrl || req.path || "").startsWith("/api/")) {
      return res.status(403).json({ error: "Forbidden" });
    }
    return res.status(403).render("access-denied", {
      username: req.authentikUser?.username || "",
    });
  }
  return next();
}

function requireAgencyAdmin(req, res, next) {
  if (!req.authentikUser || !req.authentikUser.isAgencyAdmin) {
    return res.status(403).render("access-denied", {
      username: req.authentikUser?.username || "",
    });
  }
  return next();
}

function requestMeta(req) {
  return {
    ip: req.ip || "",
    userAgent: String(req.get("user-agent") || "").slice(0, 500),
  };
}

function auditRequest(req, payload) {
  auditSvc.auditFromRequest(req, payload);
}

function toErrorRedirect(res, url, err) {
  const message = encodeURIComponent(err?.message || String(err || "Request failed."));
  return res.redirect(`${url}${url.includes("?") ? "&" : "?"}error=${message}`);
}

function csvEscape(value) {
  const str = String(value ?? "");
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function rowsToCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(row.map(csvEscape).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function getAgencyOptions() {
  return (mouService.getTargetAgenciesForStream({ scopeType: "global" }) || [])
    .map((agency) => ({
      suffix: String(agency?.suffix || "").trim().toLowerCase(),
      name: agency?.name || agency?.groupPrefix || agency?.suffix,
    }))
    .filter((agency) => agency.suffix);
}

function canSeeStream(authUser, stream) {
  if (authUser?.isGlobalAdmin) return true;
  return mouService.streamAppliesToUser(stream, authUser);
}

function resolveSignableAgencyChoices(authUser, stream) {
  const targetSuffixes = mouService.getTargetAgenciesForStream(stream).map((agency) =>
    String(agency?.suffix || "").trim().toLowerCase()
  );
  const access = accessSvc.getAgencyAccess(authUser);
  const managed = Array.isArray(access.allowedAgencySuffixes)
    ? access.allowedAgencySuffixes.map((suffix) => String(suffix || "").trim().toLowerCase())
    : [];
  return managed
    .filter((suffix) => targetSuffixes.includes(suffix))
    .map((suffix) => mouService.getAgencyBySuffix(suffix))
    .filter(Boolean)
    .map((agency) => ({
      suffix: String(agency.suffix || "").trim().toLowerCase(),
      name: agency.name || agency.groupPrefix || agency.suffix,
    }));
}

async function resolveSignerStatus(authUser) {
  try {
    const userId = await tokensSvc.getUserIdByUsername(authUser?.username || "");
    const fullUser = await usersSvc.getUserById(userId);
    const attrs = fullUser?.attributes || {};
    const pref = usersSvc.getPreferenceDataForUser(fullUser);
    return (
      String(attrs.title || "").trim() ||
      String(attrs.role || "").trim() ||
      String(attrs.atakRole || "").trim() ||
      String(pref?.roleLabel || "").trim() ||
      String(attrs.current_template || "").trim() ||
      "Agency Administrator"
    );
  } catch {
    return "Agency Administrator";
  }
}

function buildStreamCard(authUser, stream) {
  const deployed = mouService.getCurrentDeployedVersion(stream);
  const agencyChoices = authUser?.isAgencyAdmin
    ? resolveSignableAgencyChoices(authUser, stream)
    : [];
  const signatures = agencyChoices.map((agency) => ({
    agency,
    signature: mouService.getCurrentAgencySignatureForStream(stream, agency.suffix),
  }));

  return {
    stream,
    deployed,
    scopeLabel: mouService.getScopeLabel(stream),
    targetAgencies: mouService.getTargetAgenciesForStream(stream).map((agency) => ({
      suffix: agency.suffix,
      name: agency.name || agency.groupPrefix || agency.suffix,
    })),
    signableAgencyChoices: agencyChoices,
    signatures,
    allSigned:
      !agencyChoices.length ||
      signatures.every((entry) => !!entry.signature),
  };
}

router.get("/mou", requireMouEnabled, requireMouPermission, (req, res) => {
  const cards = mouService
    .listDeployedStreamsForUser(req.authentikUser)
    .map((stream) => buildStreamCard(req.authentikUser, stream));
  const isGlobalAdmin = !!req.authentikUser?.isGlobalAdmin;
  const adminStreams = isGlobalAdmin
    ? mouService.listStreams().map((stream) => ({
        ...stream,
        currentDeployed: mouService.getCurrentDeployedVersion(stream),
        scopeLabel: mouService.getScopeLabel(stream),
      }))
    : [];

  res.render("mou_list", {
    cards,
    adminStreams,
    adminAgreement: isGlobalAdmin ? mouService.getCurrentUserAgreement() : null,
    agencies: isGlobalAdmin ? getAgencyOptions() : [],
    error: req.query.error || "",
    success: req.query.success || "",
    publicListVisibleToAll: getBool("MOU_PUBLIC_LIST_VISIBLE_TO_ALL", true),
  });
});

router.get("/mou/file/:mouId/:version", requireMouEnabled, requireMouPermission, (req, res) => {
  try {
    const content = mouService.getVersionContent(req.params.mouId, req.params.version);
    if (!canSeeStream(req.authentikUser, content.stream)) {
      return res.status(403).render("access-denied", {
        username: req.authentikUser?.username || "",
      });
    }
    if (
      !req.authentikUser?.isGlobalAdmin &&
      !["deployed", "superseded"].includes(String(content.version?.state || ""))
    ) {
      return res.status(403).render("access-denied", {
        username: req.authentikUser?.username || "",
      });
    }

    if (content.contentType === "pdf") {
      res.setHeader("Content-Type", "application/pdf");
      const disposition = req.query.download === "1" ? "attachment" : "inline";
      res.setHeader(
        "Content-Disposition",
        `${disposition}; filename="${content.fileName.replace(/"/g, "")}"`
      );
      return res.send(content.contentBuffer);
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(content.html);
  } catch (err) {
    return renderNotFound(req, res);
  }
});

router.get("/mou/view/:mouId/:version", requireMouEnabled, requireMouPermission, (req, res) => {
  try {
    const out = mouService.getDeployedVersionOrLatest(req.params.mouId, req.params.version);
    if (!canSeeStream(req.authentikUser, out.stream)) {
      return res.status(403).render("access-denied", {
        username: req.authentikUser?.username || "",
      });
    }
    if (out.redirectedToLatest || String(out.requestedVersion?.state || "") === "superseded") {
      return res.redirect(
        `/mou/view/${encodeURIComponent(out.stream.mouId)}/${encodeURIComponent(out.latestVersion.version)}?updated=1`
      );
    }

    const viewRow = mouService.recordMouView({
      authUser: req.authentikUser,
      mouId: out.stream.mouId,
      version: out.targetVersion.version,
      ...requestMeta(req),
    });

    auditRequest(req, {
      action: "MOU_VIEWED",
      targetType: "mou",
      targetId: String(out.stream.mouId),
      details: {
        mouId: out.stream.mouId,
        version: out.targetVersion.version,
        viewCount: viewRow?.viewCount || 1,
      },
    });

    const contentUrls = mouService.buildContentUrls(out.stream, out.targetVersion);
    res.render("mou_view", {
      mode: "deployed",
      stream: out.stream,
      version: out.targetVersion,
      html: out.html,
      contentType: out.contentType,
      fileUrl: contentUrls.fileUrl,
      downloadUrl: contentUrls.downloadUrl,
      fileName: out.fileName,
      scopeLabel: mouService.getScopeLabel(out.stream),
      updatedFromOlderVersion: req.query.updated === "1",
    });
  } catch (err) {
    return renderNotFound(req, res);
  }
});

router.get("/mou/agency/:mouId/:agencyId", requireMouEnabled, requireMouPermission, (req, res) => {
  try {
    const agencyId = String(req.params.agencyId || "").trim().toLowerCase();
    const canSeeAll = !!req.authentikUser?.isGlobalAdmin;
    const canSeeOwnAgency =
      !!req.authentikUser?.isAgencyAdmin &&
      accessSvc.isSuffixAllowed(req.authentikUser, agencyId);
    const canSeePublic = getBool("MOU_PUBLIC_LIST_VISIBLE_TO_ALL", true);
    if (!canSeeAll && !canSeeOwnAgency && !canSeePublic) {
      return res.status(403).render("access-denied", {
        username: req.authentikUser?.username || "",
      });
    }

    const evidence = mouService.getAgencyEvidence({
      mouId: req.params.mouId,
      agencyId,
      version: req.query.version,
    });
    res.render("mou_view", {
      mode: "signed_evidence",
      stream: evidence.stream,
      version: evidence.version,
      html: evidence.html,
      contentType: "signed_html",
      fileUrl: null,
      downloadUrl: null,
      fileName: null,
      signature: evidence.signature,
      scopeLabel: mouService.getScopeLabel(evidence.stream),
      updatedFromOlderVersion: false,
    });
  } catch (err) {
    return renderNotFound(req, res);
  }
});

router.get("/mou/sign/:mouId/:version", requireMouEnabled, requireMouPermission, requireAgencyAdmin, (req, res) => {
  try {
    const out = mouService.getDeployedVersionOrLatest(req.params.mouId, req.params.version);
    if (!canSeeStream(req.authentikUser, out.stream)) {
      return res.status(403).render("access-denied", {
        username: req.authentikUser?.username || "",
      });
    }
    const agencyChoices = resolveSignableAgencyChoices(req.authentikUser, out.stream).map((agency) => ({
      ...agency,
      currentSignature: mouService.getCurrentAgencySignatureForStream(out.stream, agency.suffix),
    }));
    if (!agencyChoices.length) {
      return res.status(403).render("access-denied", {
        username: req.authentikUser?.username || "",
      });
    }
    const contentUrls = mouService.buildContentUrls(out.stream, out.targetVersion);
    res.render("mou_sign", {
      stream: out.stream,
      version: out.targetVersion,
      html: out.html,
      contentType: out.contentType,
      fileUrl: contentUrls.fileUrl,
      downloadUrl: contentUrls.downloadUrl,
      fileName: out.fileName,
      scopeLabel: mouService.getScopeLabel(out.stream),
      agencyChoices,
      error: req.query.error || "",
      success: req.query.success || "",
    });
  } catch (err) {
    return renderNotFound(req, res);
  }
});

router.post("/mou/sign/:mouId/:version", requireMouEnabled, requireMouPermission, requireAgencyAdmin, async (req, res) => {
  try {
    const stream = mouService.getStreamById(req.params.mouId);
    const agencyChoices = resolveSignableAgencyChoices(req.authentikUser, stream);
    const agencySuffix = String(req.body?.agencySuffix || "").trim().toLowerCase();
    if (!agencyChoices.some((agency) => agency.suffix === agencySuffix)) {
      return res.status(403).render("access-denied", {
        username: req.authentikUser?.username || "",
      });
    }

    const agency = mouService.getAgencyBySuffix(agencySuffix);
    const signerStatus = await resolveSignerStatus(req.authentikUser);
    const result = mouService.signVersion({
      mouId: req.params.mouId,
      version: req.params.version,
      agencySuffix,
      agencyNameAtSign: agency.name || agency.groupPrefix || agency.suffix,
      signerUserId: req.authentikUser?.uid || req.authentikUser?.username,
      signerDisplayName: req.authentikUser?.displayName || req.authentikUser?.username,
      signerStatusAtSign: signerStatus,
      attestationText: req.body?.attestationText,
      signatureDataUrl: req.body?.signatureDataUrl,
      ...requestMeta(req),
    });

    auditRequest(req, {
      action: "MOU_AGENCY_SIGNED",
      targetType: "mou",
      targetId: String(result.stream.mouId),
      agencySuffix,
      details: {
        mouId: result.stream.mouId,
        version: result.version.version,
        agencyId: agencySuffix,
        signerDisplayName: result.signature.signerDisplayName,
      },
    });

    return res.redirect(
      `/mou/sign/${encodeURIComponent(req.params.mouId)}/${encodeURIComponent(req.params.version)}?success=${encodeURIComponent("MOU signed successfully.")}`
    );
  } catch (err) {
    return toErrorRedirect(
      res,
      `/mou/sign/${encodeURIComponent(req.params.mouId)}/${encodeURIComponent(req.params.version)}`,
      err
    );
  }
});

router.post("/api/mou/user-agreement/accept", requireMouEnabled, requireMouPermission, (req, res) => {
  try {
    if (!mouService.shouldRequireUserAgreement(req.authentikUser, { acceptedForSession: false })) {
      return res.json({ success: true });
    }
    res.cookie(USER_AGREEMENT_SESSION_COOKIE, "1", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err?.message || "Failed to continue." });
  }
});

router.post("/api/mou/user-agreement/decline", requireMouEnabled, requireMouPermission, (req, res) => {
  res.json({ success: true, logoutUrl: "/logout" });
});

router.get("/admin/mou", requireMouEnabled, requireMouPermission, requireGlobalAdmin, (req, res) => {
  return res.redirect("/mou");
});

router.post("/admin/mou", requireMouEnabled, requireMouPermission, requireGlobalAdmin, upload.single("contentFile"), (req, res) => {
  try {
    const stream = mouService.createDraftStream({
      title: req.body?.title,
      html: req.body?.html,
      file: req.file || null,
      contentType: req.body?.contentType,
      reminderDays: req.body?.reminderDays,
      mandatory: true,
      actor: req.authentikUser,
    });
    auditRequest(req, {
      action: "MOU_DRAFT_CREATED",
      targetType: "mou",
      targetId: String(stream.mouId),
      details: {
        mouId: stream.mouId,
        version: 1,
        title: stream.title,
      },
    });
    return res.redirect(
      `/admin/mou/${encodeURIComponent(stream.mouId)}/1/edit?success=${encodeURIComponent("Draft created.")}`
    );
  } catch (err) {
    return toErrorRedirect(res, "/mou", err);
  }
});

router.post("/admin/mou/:mouId/new-version", requireMouEnabled, requireMouPermission, requireGlobalAdmin, (req, res) => {
  try {
    const stream = mouService.createNextDraft({
      mouId: req.params.mouId,
      actor: req.authentikUser,
    });
    const draft = (stream.versions || []).find((entry) => String(entry.state || "") === "draft");
    return res.redirect(
      `/admin/mou/${encodeURIComponent(stream.mouId)}/${encodeURIComponent(draft.version)}/edit?success=${encodeURIComponent("New draft created.")}`
    );
  } catch (err) {
    return toErrorRedirect(res, "/mou", err);
  }
});

router.get("/admin/mou/:mouId/:version/edit", requireMouEnabled, requireMouPermission, requireGlobalAdmin, (req, res) => {
  try {
    const stream = mouService.getStreamById(req.params.mouId);
    const version =
      (stream.versions || []).find(
        (entry) => Number(entry.version) === Number(req.params.version)
      ) || null;
    if (!version) throw new Error("MOU version not found.");

    const content = mouService.getVersionContent(req.params.mouId, req.params.version);
    const contentUrls = mouService.buildContentUrls(stream, version);
    res.render("admin/mou_admin_edit", {
      stream,
      version,
      html: content.contentType === "html" ? content.html : "",
      contentType: content.contentType,
      fileName: content.fileName,
      fileUrl: contentUrls.fileUrl,
      downloadUrl: contentUrls.downloadUrl,
      error: req.query.error || "",
      success: req.query.success || "",
    });
  } catch (err) {
    return toErrorRedirect(res, "/mou", err);
  }
});

router.post("/admin/mou/:mouId/:version/save", requireMouEnabled, requireMouPermission, requireGlobalAdmin, upload.single("contentFile"), (req, res) => {
  try {
    mouService.updateDraft({
      mouId: req.params.mouId,
      version: req.params.version,
      title: req.body?.title,
      slug: req.body?.slug,
      html: req.body?.html,
      file: req.file || null,
      contentType: req.body?.contentType,
      reminderDays: req.body?.reminderDays,
      mandatory: true,
      actor: req.authentikUser,
    });
    auditRequest(req, {
      action: "MOU_DRAFT_UPDATED",
      targetType: "mou",
      targetId: String(req.params.mouId),
      details: {
        mouId: req.params.mouId,
        version: Number(req.params.version),
      },
    });
    return res.redirect(
      `/admin/mou/${encodeURIComponent(req.params.mouId)}/${encodeURIComponent(req.params.version)}/edit?success=${encodeURIComponent("Draft saved.")}`
    );
  } catch (err) {
    return toErrorRedirect(
      res,
      `/admin/mou/${encodeURIComponent(req.params.mouId)}/${encodeURIComponent(req.params.version)}/edit`,
      err
    );
  }
});

router.get("/admin/mou/:mouId/:version/preview", requireMouEnabled, requireMouPermission, requireGlobalAdmin, (req, res) => {
  try {
    const stream = mouService.getStreamById(req.params.mouId);
    const version =
      (stream.versions || []).find(
        (entry) => Number(entry.version) === Number(req.params.version)
      ) || null;
    if (!version) throw new Error("MOU version not found.");
    const content = mouService.getVersionContent(req.params.mouId, req.params.version);
    const contentUrls = mouService.buildContentUrls(stream, version);
    res.render("admin/mou_admin_preview", {
      stream,
      version,
      html: content.contentType === "html" ? content.html : "",
      contentType: content.contentType,
      fileUrl: contentUrls.fileUrl,
      downloadUrl: contentUrls.downloadUrl,
      fileName: content.fileName,
      scopeLabel: mouService.getScopeLabel(stream),
    });
  } catch (err) {
    return toErrorRedirect(res, "/mou", err);
  }
});

router.post("/admin/mou/:mouId/:version/deploy", requireMouEnabled, requireMouPermission, requireGlobalAdmin, async (req, res) => {
  try {
    const deployed = mouService.deployDraft({
      mouId: req.params.mouId,
      version: req.params.version,
      confirmText: req.body?.confirmText,
      actor: req.authentikUser,
    });
    auditRequest(req, {
      action: "MOU_DEPLOYED",
      targetType: "mou",
      targetId: String(req.params.mouId),
      details: {
        mouId: req.params.mouId,
        version: deployed.version.version,
        contentSha256: deployed.contentSha256,
        supersededVersion: deployed.supersededVersion,
        assignment: mouService.getScopeLabel(deployed.stream),
      },
    });
    return res.redirect(`/mou?success=${encodeURIComponent("MOU deployed.")}`);
  } catch (err) {
    return toErrorRedirect(
      res,
      `/admin/mou/${encodeURIComponent(req.params.mouId)}/${encodeURIComponent(req.params.version)}/edit`,
      err
    );
  }
});

router.post("/admin/mou/:mouId/:version/discard", requireMouEnabled, requireMouPermission, requireGlobalAdmin, (req, res) => {
  try {
    mouService.discardDraft({
      mouId: req.params.mouId,
      version: req.params.version,
    });
    auditRequest(req, {
      action: "MOU_DRAFT_DISCARDED",
      targetType: "mou",
      targetId: String(req.params.mouId),
      details: {
        mouId: req.params.mouId,
        version: Number(req.params.version),
      },
    });
    return res.redirect(`/mou?success=${encodeURIComponent("Draft discarded.")}`);
  } catch (err) {
    return toErrorRedirect(res, "/mou", err);
  }
});

router.post("/admin/mou/:mouId/delete", requireMouEnabled, requireMouPermission, requireGlobalAdmin, (req, res) => {
  try {
    mouService.deleteStream({
      mouId: req.params.mouId,
    });
    auditRequest(req, {
      action: "MOU_STREAM_DELETED",
      targetType: "mou",
      targetId: String(req.params.mouId),
      details: {
        mouId: req.params.mouId,
      },
    });
    return res.redirect(`/mou?success=${encodeURIComponent("MOU deleted.")}`);
  } catch (err) {
    return toErrorRedirect(res, "/mou", err);
  }
});

router.post("/admin/mou/:mouId/assignments/save", requireMouEnabled, requireMouPermission, requireGlobalAdmin, async (req, res) => {
  try {
    const previousStream = mouService.getStreamById(req.params.mouId);
    const rawAgencySuffixes = req.body?.agencySuffixes;
    const agencySuffixes = Array.isArray(rawAgencySuffixes)
      ? rawAgencySuffixes
      : rawAgencySuffixes
        ? [rawAgencySuffixes]
        : [];
    const stream = mouService.updateStreamAssignments({
      mouId: req.params.mouId,
      serverwide: req.body?.serverwide,
      agencySuffixes,
      actor: req.authentikUser,
    });
    const deployed = mouService.getCurrentDeployedVersion(stream);
    const previousAssignmentKey = JSON.stringify(previousStream.assignments || {});
    const currentAssignmentKey = JSON.stringify(stream.assignments || {});
    if (
      deployed &&
      previousAssignmentKey !== currentAssignmentKey &&
      mouService.getTargetAgenciesForStream(stream).length
    ) {
      await mouScheduler.sendDeployNotificationsForVersion({
        stream,
        version: deployed,
        actor: req.authentikUser,
      });
    }
    auditRequest(req, {
      action: "MOU_ASSIGNMENTS_UPDATED",
      targetType: "mou",
      targetId: String(req.params.mouId),
      details: {
        mouId: req.params.mouId,
        assignment: mouService.getScopeLabel(stream),
        targetAgencyCount: mouService.getTargetAgenciesForStream(stream).length,
      },
    });
    return res.redirect(`/mou?success=${encodeURIComponent("Document assignment updated.")}`);
  } catch (err) {
    return toErrorRedirect(res, "/mou", err);
  }
});

router.post("/admin/mou/user-agreement/save", requireMouEnabled, requireMouPermission, requireGlobalAdmin, (req, res) => {
  try {
    const result = mouService.saveUserAgreement({
      title: req.body?.title,
      html: req.body?.html,
      enabled: req.body?.enabled,
      actor: req.authentikUser,
    });
    auditRequest(req, {
      action: "MOU_USER_AGREEMENT_SAVED",
      targetType: "user_agreement",
      targetId: String(result.version.version),
      details: {
        version: result.version.version,
        changed: result.changed,
        enabled: result.enabled,
      },
    });
    return res.redirect(`/mou?success=${encodeURIComponent("User agreement saved.")}`);
  } catch (err) {
    return toErrorRedirect(res, "/mou", err);
  }
});

router.get("/admin/mou/compliance", requireMouEnabled, requireMouPermission, (req, res) => {
  if (!req.authentikUser || (!req.authentikUser.isGlobalAdmin && !req.authentikUser.isAgencyAdmin)) {
    return res.status(403).render("access-denied", {
      username: req.authentikUser?.username || "",
    });
  }

  Promise.resolve()
    .then(async () => {
      const signatureRows = mouService.getAgencySignatureStatusRows().filter((row) =>
        req.authentikUser.isGlobalAdmin ||
        accessSvc.isSuffixAllowed(req.authentikUser, row.agencyId)
      );

      if (req.query.export === "signatures") {
        const csv = rowsToCsv(
          [
            "mou_title",
            "scope",
            "agency_name",
            "deployed_version",
            "signed_version",
            "signer_name",
            "status",
          ],
          signatureRows.map((row) => [
            row.mouTitle,
            row.scopeLabel,
            row.agencyName,
            row.deployedVersion,
            row.signedVersion || "",
            row.signerDisplayName || "",
            row.needsSignature ? "needs_signature" : "current",
          ])
        );
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="mou-signature-compliance.csv"'
        );
        return res.send(csv);
      }

      res.render("admin/mou_compliance", {
        signatureRows,
      });
    })
    .catch(() => {
      res.status(500).render("access-denied", {
        username: req.authentikUser?.username || "",
      });
    });
});

module.exports = router;
