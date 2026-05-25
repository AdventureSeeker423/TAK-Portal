const path = require("path");
const express = require("express");
const mouService = require("../services/mouService");
const mouScheduler = require("../services/mouScheduler");
const mouStore = require("../services/mouStore");
const auditSvc = require("../services/auditLog.service");
const permsSvc = require("../services/permissions.service");
const accessSvc = require("../services/access.service");
const usersSvc = require("../services/users.service");
const tokensSvc = require("../services/authentikTokens.service");
const { getBool } = require("../services/env");

const router = express.Router();

function renderNotFound(req, res) {
  if ((req.originalUrl || req.path || "").startsWith("/api/")) {
    return res.status(404).json({ error: "Not found" });
  }
  return res.status(404).render("access-denied", {
    username: req.authentikUser?.username || "",
  });
}

function requireMouEnabled(req, res, next) {
  if (!mouService.isEnabled()) {
    return renderNotFound(req, res);
  }
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

function resolveManagedAgencyChoices(authUser) {
  const access = accessSvc.getAgencyAccess(authUser);
  const allowed = Array.isArray(access.allowedAgencySuffixes)
    ? access.allowedAgencySuffixes
    : [];
  return allowed
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

router.get("/mou", requireMouEnabled, requireMouPermission, (req, res) => {
  const streams = mouService.listDeployedStreams().map((stream) => {
    const deployed = mouService.getCurrentDeployedVersion(stream);
    const currentAgencySignature = req.authentikUser?.isAgencyAdmin
      ? resolveManagedAgencyChoices(req.authentikUser)
          .map((agency) => ({
            agency,
            signature: mouService.getCurrentAgencySignatureForStream(stream, agency.suffix),
          }))
          .find((entry) => !!entry.signature) || null
      : null;

    return {
      stream,
      deployed,
      currentAgencySignature,
    };
  });

  res.render("mou_list", {
    streams,
    agreementSummary: mouService.getAgreementSummaryForUser(req.authentikUser),
    publicListVisibleToAll: getBool("MOU_PUBLIC_LIST_VISIBLE_TO_ALL", true),
  });
});

router.get("/mou/view/:mouId/:version", requireMouEnabled, requireMouPermission, (req, res) => {
  try {
    const out = mouService.getDeployedVersionOrLatest(req.params.mouId, req.params.version);
    if (
      out.redirectedToLatest ||
      String(out.requestedVersion?.state || "") === "superseded"
    ) {
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

    res.render("mou_view", {
      mode: "deployed",
      stream: out.stream,
      version: out.targetVersion,
      html: out.html,
      updatedFromOlderVersion: req.query.updated === "1",
    });
  } catch (err) {
    res.status(404).render("access-denied", {
      username: req.authentikUser?.username || "",
    });
  }
});

router.get("/mou/agency/:mouId/:agencyId", requireMouEnabled, requireMouPermission, (req, res) => {
  try {
    const agencyId = String(req.params.agencyId || "").trim().toLowerCase();
    const canSeeAll = !!req.authentikUser?.isGlobalAdmin;
    const canSeeOwnAgency = !!req.authentikUser?.isAgencyAdmin && accessSvc.isSuffixAllowed(req.authentikUser, agencyId);
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
      signature: evidence.signature,
      updatedFromOlderVersion: false,
    });
  } catch (err) {
    res.status(404).render("access-denied", {
      username: req.authentikUser?.username || "",
    });
  }
});

router.get("/mou/sign/:mouId/:version", requireMouEnabled, requireMouPermission, requireAgencyAdmin, (req, res) => {
  try {
    const out = mouService.getDeployedVersionOrLatest(req.params.mouId, req.params.version);
    if (String(out.targetVersion?.state || "") !== "deployed") {
      return res.redirect(
        `/mou/sign/${encodeURIComponent(out.stream.mouId)}/${encodeURIComponent(out.latestVersion.version)}`
      );
    }
    const agencyChoices = resolveManagedAgencyChoices(req.authentikUser);
    res.render("mou_sign", {
      stream: out.stream,
      version: out.targetVersion,
      html: out.html,
      agencyChoices,
      error: req.query.error || "",
      success: req.query.success || "",
    });
  } catch (err) {
    res.status(404).render("access-denied", {
      username: req.authentikUser?.username || "",
    });
  }
});

router.post("/mou/sign/:mouId/:version", requireMouEnabled, requireMouPermission, requireAgencyAdmin, async (req, res) => {
  try {
    const agencySuffix = String(req.body?.agencySuffix || "").trim().toLowerCase();
    if (!accessSvc.isSuffixAllowed(req.authentikUser, agencySuffix)) {
      return res.status(403).render("access-denied", {
        username: req.authentikUser?.username || "",
      });
    }

    const agency = mouService.getAgencyBySuffix(agencySuffix);
    if (!agency) {
      throw new Error("Selected agency not found.");
    }

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
      agencySuffix: agencySuffix,
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
    const ack = mouService.acceptCurrentUserAgreement({
      authUser: req.authentikUser,
      ...requestMeta(req),
    });
    auditRequest(req, {
      action: "MOU_USER_AGREEMENT_ACCEPTED",
      targetType: "user_agreement",
      targetId: String(ack.version),
      details: {
        version: ack.version,
        userId: ack.userId,
      },
    });
    res.json({ success: true, version: ack.version });
  } catch (err) {
    res.status(400).json({ error: err?.message || "Failed to accept agreement." });
  }
});

router.post("/api/mou/user-agreement/decline", requireMouEnabled, requireMouPermission, (req, res) => {
  auditRequest(req, {
    action: "MOU_USER_AGREEMENT_DECLINED",
    targetType: "user_agreement",
    targetId: String(mouService.getCurrentUserAgreement().currentVersion || ""),
    details: {
      userId: req.authentikUser?.uid || req.authentikUser?.username || null,
    },
  });
  res.json({ success: true, logoutUrl: "/logout" });
});

router.get("/admin/mou", requireMouEnabled, requireMouPermission, requireGlobalAdmin, (req, res) => {
  const streams = mouService.listStreams().map((stream) => ({
    ...stream,
    currentDeployed: mouService.getCurrentDeployedVersion(stream),
  }));
  const agreement = mouService.getCurrentUserAgreement();
  res.render("admin/mou_admin_list", {
    streams,
    agreement,
    error: req.query.error || "",
    success: req.query.success || "",
  });
});

router.post("/admin/mou", requireMouEnabled, requireMouPermission, requireGlobalAdmin, (req, res) => {
  try {
    const stream = mouService.createDraftStream({
      title: req.body?.title,
      slug: req.body?.slug,
      html: req.body?.html,
      reminderDays: req.body?.reminderDays,
      mandatory: req.body?.mandatory,
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
    return res.redirect(`/admin/mou/${encodeURIComponent(stream.mouId)}/1/edit?success=${encodeURIComponent("Draft created.")}`);
  } catch (err) {
    return toErrorRedirect(res, "/admin/mou", err);
  }
});

router.post("/admin/mou/:mouId/new-version", requireMouEnabled, requireMouPermission, requireGlobalAdmin, (req, res) => {
  try {
    const stream = mouService.createNextDraft({
      mouId: req.params.mouId,
      actor: req.authentikUser,
    });
    const draft = (stream.versions || []).find((entry) => String(entry.state || "") === "draft");
    return res.redirect(`/admin/mou/${encodeURIComponent(stream.mouId)}/${encodeURIComponent(draft.version)}/edit?success=${encodeURIComponent("New draft created.")}`);
  } catch (err) {
    return toErrorRedirect(res, "/admin/mou", err);
  }
});

router.get("/admin/mou/:mouId/:version/edit", requireMouEnabled, requireMouPermission, requireGlobalAdmin, (req, res) => {
  try {
    const stream = mouService.getStreamById(req.params.mouId);
    const version = (stream.versions || []).find(
      (entry) => Number(entry.version) === Number(req.params.version)
    );
    if (!version) throw new Error("MOU version not found.");
    res.render("admin/mou_admin_edit", {
      stream,
      version,
      html: version.contentHtmlPath
        ? mouStore.readHtml(
            path.join(__dirname, "..", "data", version.contentHtmlPath)
          )
        : "",
      error: req.query.error || "",
      success: req.query.success || "",
    });
  } catch (err) {
    return toErrorRedirect(res, "/admin/mou", err);
  }
});

router.post("/admin/mou/:mouId/:version/save", requireMouEnabled, requireMouPermission, requireGlobalAdmin, (req, res) => {
  try {
    mouService.updateDraft({
      mouId: req.params.mouId,
      version: req.params.version,
      title: req.body?.title,
      slug: req.body?.slug,
      html: req.body?.html,
      reminderDays: req.body?.reminderDays,
      mandatory: req.body?.mandatory,
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
    return res.redirect(`/admin/mou/${encodeURIComponent(req.params.mouId)}/${encodeURIComponent(req.params.version)}/edit?success=${encodeURIComponent("Draft saved.")}`);
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
    const version = (stream.versions || []).find(
      (entry) => Number(entry.version) === Number(req.params.version)
    );
    if (!version) throw new Error("MOU version not found.");
    const html = version.contentHtmlPath
      ? mouStore.readHtml(
          path.join(__dirname, "..", "data", version.contentHtmlPath)
        )
      : "";
    res.render("admin/mou_admin_preview", {
      stream,
      version,
      html,
    });
  } catch (err) {
    return toErrorRedirect(res, "/admin/mou", err);
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
      },
    });
    await mouScheduler.sendDeployNotificationsForVersion({
      stream: deployed.stream,
      version: deployed.version,
      actor: req.authentikUser,
    });
    return res.redirect(`/admin/mou?success=${encodeURIComponent("MOU deployed.")}`);
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
    return res.redirect(`/admin/mou?success=${encodeURIComponent("Draft discarded.")}`);
  } catch (err) {
    return toErrorRedirect(res, "/admin/mou", err);
  }
});

router.post("/admin/mou/user-agreement/save", requireMouEnabled, requireMouPermission, requireGlobalAdmin, (req, res) => {
  try {
    const result = mouService.saveUserAgreement({
      title: req.body?.title,
      html: req.body?.html,
      actor: req.authentikUser,
    });
    auditRequest(req, {
      action: "MOU_USER_AGREEMENT_SAVED",
      targetType: "user_agreement",
      targetId: String(result.version.version),
      details: {
        version: result.version.version,
        changed: result.changed,
      },
    });
    return res.redirect(`/admin/mou?success=${encodeURIComponent("User agreement saved.")}`);
  } catch (err) {
    return toErrorRedirect(res, "/admin/mou", err);
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
      const allUsers = await usersSvc.getAllUsersLightweight();
      const visibleUsers = req.authentikUser.isGlobalAdmin
        ? allUsers
        : allUsers.filter((user) => accessSvc.isUserInAllowedAgencies(req.authentikUser, user));

      const signatureRows = mouService
        .getAgencySignatureStatusRows()
        .filter((row) =>
          req.authentikUser.isGlobalAdmin ||
          accessSvc.isSuffixAllowed(req.authentikUser, row.agencyId)
        );

      const agreementRows = mouService.getAgreementAcceptanceRowsForUsers(visibleUsers);
      if (req.query.export === "signatures") {
        const csv = rowsToCsv(
          ["mou_title", "agency_name", "deployed_version", "signed_version", "signer_name", "status"],
          signatureRows.map((row) => [
            row.mouTitle,
            row.agencyName,
            row.deployedVersion,
            row.signedVersion || "",
            row.signerDisplayName || "",
            row.needsSignature ? "needs_signature" : "current",
          ])
        );
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", 'attachment; filename="mou-signature-compliance.csv"');
        return res.send(csv);
      }
      if (req.query.export === "agreement") {
        const csv = rowsToCsv(
          ["display_name", "username", "agreement_version", "accepted", "accepted_at"],
          agreementRows.map((row) => [
            row.displayName || "",
            row.username || "",
            row.version || "",
            row.accepted ? "yes" : "no",
            row.acceptedAt || "",
          ])
        );
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", 'attachment; filename="mou-user-agreement-compliance.csv"');
        return res.send(csv);
      }
      res.render("admin/mou_compliance", {
        signatureRows,
        agreementRows,
      });
    })
    .catch((err) => {
      res.status(500).render("access-denied", {
        username: req.authentikUser?.username || "",
      });
    });
});

module.exports = router;
