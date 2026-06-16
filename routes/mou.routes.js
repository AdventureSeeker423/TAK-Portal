const path = require("path");
const express = require("express");
const multer = require("multer");
const archiver = require("archiver");
const mouService = require("../services/mouService");
const mouScheduler = require("../services/mouScheduler");
const auditSvc = require("../services/auditLog.service");
const permsSvc = require("../services/permissions.service");
const accessSvc = require("../services/access.service");
const usersSvc = require("../services/users.service");
const tokensSvc = require("../services/authentikTokens.service");
const { getBool } = require("../services/env");
const {
  USER_AGREEMENT_SESSION_COOKIE,
  buildAgreementSessionValue,
} = require("../services/userAgreementSession.service");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

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

function triggerSignedGlobalAdminNotification(req, result, signMethod) {
  void Promise.resolve()
    .then(async () => {
      const notifyResult = await mouScheduler.sendSignedNotificationToGlobalAdmins({
        stream: result?.stream,
        version: result?.version,
        signature: result?.signature,
        signMethod,
      });
      if (notifyResult?.sent) return;
      if (notifyResult?.skipped) {
        console.warn("[MOU_SIGN] Global admin notification skipped", {
          mouId: result?.stream?.mouId || null,
          version: result?.version?.version || null,
          agencyId: result?.signature?.agencyId || null,
          signMethod,
          reason: notifyResult.reason || "Unknown reason",
        });
        return;
      }
      throw new Error(
        notifyResult?.error || "Failed to send signed document notification to global admins."
      );
    })
    .catch((notifyErr) => {
      console.error("[MOU_SIGN] Global admin notification failure", {
        mouId: result?.stream?.mouId || null,
        version: result?.version?.version || null,
        agencyId: result?.signature?.agencyId || null,
        signMethod,
        error: notifyErr?.message || String(notifyErr || "Unknown notification error"),
        stack: notifyErr?.stack || null,
      });
      auditRequest(req, {
        action: "MOU_SIGNED_NOTIFICATION_FAILED",
        targetType: "mou",
        targetId: String(result?.stream?.mouId || ""),
        agencySuffix: result?.signature?.agencyId || null,
        details: {
          mouId: result?.stream?.mouId || "",
          version: result?.version?.version || null,
          agencyId: result?.signature?.agencyId || null,
          signMethod,
          error:
            notifyErr?.message ||
            String(notifyErr || "Failed to notify global admins of signed document."),
        },
      });
    });
}

function buildContentDisposition(disposition, fileName) {
  const original = String(fileName || "mou").trim() || "mou";
  const asciiFallback = original
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\\r\n]/g, "_");
  const encoded = encodeURIComponent(original).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
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

const MAX_AUDIT_TEXT_LENGTH = 20000;

function truncateAuditText(value, maxLength = MAX_AUDIT_TEXT_LENGTH) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...[truncated ${text.length - maxLength} chars]`;
}

function normalizeAuditContentType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "pdf") return "pdf";
  if (normalized === "markdown") return "markdown";
  return "html";
}

function summarizeFileUpload(file) {
  if (!file) return null;
  return {
    fileName: String(file.originalname || "").trim() || "",
    mimeType: String(file.mimetype || "").trim() || "application/octet-stream",
    sizeBytes: Number(file.size || 0) || 0,
  };
}

function summarizeMouContent(content) {
  if (!content) return null;
  return {
    contentType: normalizeAuditContentType(content.contentType),
    fileName: String(content.fileName || "").trim() || "",
    text: truncateAuditText(content.contentType === "pdf" ? "" : content.sourceText || ""),
  };
}

function summarizeEditorInput({ contentType, html }) {
  const normalizedType = normalizeAuditContentType(contentType);
  return {
    contentType: normalizedType,
    text: truncateAuditText(normalizedType === "pdf" ? "" : String(html || "")),
  };
}

function buildMouAuditContentChange({ beforeContent, afterContent, inputContent, uploadFile }) {
  return {
    uploadedFile: summarizeFileUpload(uploadFile),
    before: summarizeMouContent(beforeContent),
    submitted: summarizeEditorInput(inputContent || {}),
    after: summarizeMouContent(afterContent),
  };
}

function buildSignatureComplianceCsv(signatureRows) {
  return rowsToCsv(
    [
      "mou_title",
      "scope",
      "agency_name",
      "current_version",
      "signed_version",
      "signer_name",
      "status",
    ],
    signatureRows.map((row) => [
      row.mouTitle,
      row.scopeType === "agency" ? String(row.agencyId || "").toUpperCase() : row.scopeLabel,
      row.agencyName,
      row.currentVersion,
      row.signedVersion || "",
      row.signerDisplayName || "",
      row.needsSignature ? "needs_signature" : "current",
    ])
  );
}

function safeArchiveSegment(value, fallback) {
  return (
    String(value || "")
      .trim()
      .replace(/[^a-z0-9._-]+/gi, "-")
      .replace(/-+/g, "-")
      .replace(/^[-_.]+|[-_.]+$/g, "") || String(fallback || "file")
  );
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
  const managed = accessSvc
    .getUserManagedAgencySuffixes(authUser)
    .map((suffix) => String(suffix || "").trim().toLowerCase())
    .filter(Boolean);
  return managed
    .filter((suffix) => targetSuffixes.includes(suffix))
    .map((suffix) => mouService.getAgencyBySuffix(suffix))
    .filter(Boolean)
    .map((agency) => ({
      suffix: String(agency.suffix || "").trim().toLowerCase(),
      name: agency.name || agency.groupPrefix || agency.suffix,
    }));
}

function parseAgencySigningPayload(body, agencySuffixes) {
  const agencySigning = {};
  const suffixes = Array.isArray(agencySuffixes) ? agencySuffixes : [];
  for (const suffix of suffixes) {
    const safeSuffix = String(suffix || "").trim().toLowerCase();
    if (!safeSuffix) continue;
    const modeRaw = String(body?.[`signingMode_${safeSuffix}`] || "")
      .trim()
      .toLowerCase();
    let mode = mouService.AGENCY_SIGNING_MODE_AGENCY_ADMINS;
    if (modeRaw === mouService.AGENCY_SIGNING_MODE_EXTERNAL_LINK) {
      mode = mouService.AGENCY_SIGNING_MODE_EXTERNAL_LINK;
    } else if (modeRaw === mouService.AGENCY_SIGNING_MODE_SPECIFIC_ADMIN) {
      mode = mouService.AGENCY_SIGNING_MODE_SPECIFIC_ADMIN;
    }
    const inviteEmail = normalizeAssignmentEmail(body?.[`signingEmail_${safeSuffix}`]);
    const adminSelection = parseSigningAdminSelection(
      body?.[`signingAdminEmail_${safeSuffix}`],
      body?.[`signingAdminUsername_${safeSuffix}`],
      body?.[`signingAdminName_${safeSuffix}`]
    );
    const externalLinkAcknowledged =
      String(body?.[`signingLinkCopied_${safeSuffix}`] || "").trim() === "1";
    agencySigning[safeSuffix] = { mode };
    if (mode === mouService.AGENCY_SIGNING_MODE_EXTERNAL_LINK) {
      if (inviteEmail) agencySigning[safeSuffix].inviteEmail = inviteEmail;
      if (externalLinkAcknowledged) {
        agencySigning[safeSuffix].externalLinkAcknowledged = true;
      }
    }
    if (mode === mouService.AGENCY_SIGNING_MODE_SPECIFIC_ADMIN) {
      if (adminSelection.assignedAdminEmail) {
        agencySigning[safeSuffix].assignedAdminEmail = adminSelection.assignedAdminEmail;
      }
      if (adminSelection.assignedAdminUsername) {
        agencySigning[safeSuffix].assignedAdminUsername = adminSelection.assignedAdminUsername;
      }
      if (adminSelection.assignedAdminName) {
        agencySigning[safeSuffix].assignedAdminName = adminSelection.assignedAdminName;
      }
    }
  }
  return agencySigning;
}

function normalizeAssignmentEmail(value) {
  return String(value || "").trim();
}

function parseSigningAdminSelection(rawValue, hiddenUsername, hiddenName) {
  const selection = String(rawValue || "").trim();
  let assignedAdminEmail = "";
  let assignedAdminUsername = String(hiddenUsername || "").trim();
  let assignedAdminName = String(hiddenName || "").trim();
  if (selection.startsWith("user:")) {
    assignedAdminUsername = selection.slice(5).trim() || assignedAdminUsername;
  } else if (selection) {
    assignedAdminEmail = normalizeAssignmentEmail(selection);
  }
  return { assignedAdminEmail, assignedAdminUsername, assignedAdminName };
}

function buildExternalInviteResponseRows(stream, invites) {
  const { getString } = require("../services/env");
  const baseUrl = String(getString("TAK_PORTAL_PUBLIC_URL", "") || "")
    .trim()
    .replace(/\/+$/, "");
  return (Array.isArray(invites) ? invites : []).map((invite) => {
    const path = mouService.buildExternalSignPath(invite.token);
    return {
      agencySuffix: invite.agencyId,
      signUrl: baseUrl ? `${baseUrl}${path}` : path,
      signPath: path,
      emailed: !!invite.recipientEmail,
    };
  });
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
  const currentVersion = mouService.getCurrentVersion(stream);
  const agencyChoices = resolveSignableAgencyChoices(authUser, stream);
  const signatures = agencyChoices.map((agency) => ({
    agency,
    signature: mouService.getCurrentAgencySignatureForStream(stream, agency.suffix),
  }));

  return {
    stream,
    currentVersion,
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

function buildAdminStreamRow(stream) {
  const currentVersion = mouService.getCurrentVersion(stream);
  const targetAgencies = mouService.getTargetAgenciesForStream(stream).map((agency) => ({
    suffix: String(agency.suffix || "").trim().toLowerCase(),
    name: agency.name || agency.groupPrefix || agency.suffix,
  }));
  const signatures = currentVersion
    ? targetAgencies.map((agency) => ({
        agency,
        signature: mouService.getCurrentAgencySignatureForStream(stream, agency.suffix),
      }))
    : [];
  const editorContent = currentVersion
    ? mouService.getVersionContent(stream.mouId, currentVersion.version)
    : null;
  const editorUrls = currentVersion ? mouService.buildContentUrls(stream, currentVersion) : null;

  return {
    ...stream,
    currentVersion,
    scopeLabel: mouService.getScopeLabel(stream),
    targetAgencies,
    signedCount: signatures.filter((entry) => !!entry.signature).length,
    pendingSignatureCount: signatures.filter((entry) => !entry.signature).length,
    signatureSummary: mouService.getStreamActiveAssignmentSignatureSummary(stream),
    externalSignPaths: Object.fromEntries(
      targetAgencies.map((agency) => {
        const invite = mouService.getActiveSignInviteForAgency({
          mouId: stream.mouId,
          agencyId: agency.suffix,
        });
        return [
          agency.suffix,
          invite ? mouService.buildExternalSignPath(invite.token) : "",
        ];
      })
    ),
    editor:
      currentVersion && editorContent
        ? {
            version: currentVersion.version,
            title: stream.title,
            contentType: editorContent.contentType,
            sourceText: editorContent.contentType === "pdf" ? "" : editorContent.sourceText,
            customSignerFields: Array.isArray(editorContent.customSignerFields)
              ? editorContent.customSignerFields
              : [],
            fileName: editorContent.fileName,
            fileUrl: editorUrls?.fileUrl || "",
            downloadUrl: editorUrls?.downloadUrl || "",
            previewUrl: `/admin/mou/${encodeURIComponent(stream.mouId)}/${encodeURIComponent(currentVersion.version)}/preview`,
          }
        : null,
  };
}

router.get("/mou", requireMouEnabled, requireMouPermission, async (req, res) => {
  const isGlobalAdmin = !!req.authentikUser?.isGlobalAdmin;
  const cards = mouService
    .listCurrentStreamsForUser(req.authentikUser)
    .map((stream) => buildStreamCard(req.authentikUser, stream));
  const adminStreams = isGlobalAdmin
    ? mouService.listStreams().map((stream) => buildAdminStreamRow(stream))
    : [];
  const signatureRows = isGlobalAdmin
    ? mouService.getAgencySignatureStatusRows()
    : [];
  const archivedRows = isGlobalAdmin
    ? mouService.listArchivedDocumentRows()
    : [];

  if (isGlobalAdmin && req.query.export === "signatures") {
    const csv = buildSignatureComplianceCsv(signatureRows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="mou-signature-compliance.csv"'
    );
    return res.send(csv);
  }

  if (isGlobalAdmin && req.query.export === "signatures-zip") {
    const csv = buildSignatureComplianceCsv(signatureRows);
    const signedRows = signatureRows.filter((row) => !!row.signedVersion);
    const pdfExports = [];

    for (const row of signedRows) {
      pdfExports.push(
        await mouService.getSignedPdfExport({
          mouId: row.mouId,
          agencyId: row.agencyId,
          version: row.signedVersion,
        })
      );
    }

    auditRequest(req, {
      action: "MOU_SIGNATURE_BUNDLE_EXPORTED",
      targetType: "mou",
      targetId: "signature_bundle",
      details: {
        documentsIncluded: signedRows.length,
        summary: `Exported signed MOU PDF bundle (${signedRows.length} PDF(s) plus CSV).`,
      },
    });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition("attachment", "mou-signed-documents.zip")
    );

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      console.error("MOU signature zip export error:", err);
      if (!res.headersSent) {
        res.status(500).end("Failed to export signed documents zip");
      } else {
        res.end();
      }
    });
    archive.pipe(res);
    archive.append(csv, { name: "mou-signature-compliance.csv" });

    for (const pdf of pdfExports) {
      archive.append(pdf.buffer, { name: `signed-documents/${pdf.fileName}` });
    }

    return archive.finalize();
  }

  res.render("mou_list", {
    cards,
    adminStreams,
    managedAgencySuffixes: accessSvc.getUserManagedAgencySuffixes(req.authentikUser),
    adminAgreement: isGlobalAdmin ? mouService.getCurrentUserAgreement() : null,
    defaultUserAgreement: isGlobalAdmin ? mouService.getDefaultUserAgreementTemplate() : null,
    signatureRows,
    archivedRows,
    agencies: isGlobalAdmin ? getAgencyOptions() : [],
    error: req.query.error || "",
    success: req.query.success || "",
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
      !["current", "previous"].includes(String(content.version?.state || ""))
    ) {
      return res.status(403).render("access-denied", {
        username: req.authentikUser?.username || "",
      });
    }

    const fileName = String(content.fileName || "mou").replace(/"/g, "");

    if (content.contentType === "pdf") {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        buildContentDisposition(req.query.download === "1" ? "attachment" : "inline", fileName)
      );
      return res.send(content.contentBuffer);
    }

    if (content.contentType === "markdown") {
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      if (req.query.download === "1") {
        res.setHeader("Content-Disposition", buildContentDisposition("attachment", fileName));
      }
      return res.send(content.contentBuffer.toString("utf8"));
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (req.query.download === "1") {
      res.setHeader("Content-Disposition", buildContentDisposition("attachment", fileName));
    }
    return res.send(content.html);
  } catch (err) {
    return renderNotFound(req, res);
  }
});

router.get("/mou/view/:mouId/:version", requireMouEnabled, requireMouPermission, (req, res) => {
  try {
    const out = mouService.getCurrentVersionOrLatest(req.params.mouId, req.params.version);
    if (!canSeeStream(req.authentikUser, out.stream)) {
      return res.status(403).render("access-denied", {
        username: req.authentikUser?.username || "",
      });
    }
    if (out.redirectedToLatest || String(out.requestedVersion?.state || "") === "previous") {
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
    if (out.contentType === "pdf" && contentUrls.fileUrl) {
      return res.redirect(contentUrls.fileUrl);
    }
    res.render("mou_view", {
      mode: "current",
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
    if (!canSeeAll && !canSeeOwnAgency) {
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
      downloadUrl: `/mou/agency/${encodeURIComponent(req.params.mouId)}/${encodeURIComponent(agencyId)}/pdf?version=${encodeURIComponent(evidence.version.version)}`,
      fileName: null,
      signature: evidence.signature,
      scopeLabel: mouService.getScopeLabel(evidence.stream),
      updatedFromOlderVersion: false,
    });
  } catch (err) {
    return renderNotFound(req, res);
  }
});

router.get("/mou/agency/:mouId/:agencyId/pdf", requireMouEnabled, requireMouPermission, async (req, res) => {
  try {
    const agencyId = String(req.params.agencyId || "").trim().toLowerCase();
    const canSeeAll = !!req.authentikUser?.isGlobalAdmin;
    const canSeeOwnAgency =
      !!req.authentikUser?.isAgencyAdmin &&
      accessSvc.isSuffixAllowed(req.authentikUser, agencyId);
    if (!canSeeAll && !canSeeOwnAgency) {
      return res.status(403).render("access-denied", {
        username: req.authentikUser?.username || "",
      });
    }

    const pdf = await mouService.getSignedPdfExport({
      mouId: req.params.mouId,
      agencyId,
      version: req.query.version,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", buildContentDisposition("attachment", pdf.fileName));
    return res.send(pdf.buffer);
  } catch (err) {
    return renderNotFound(req, res);
  }
});

router.get("/mou/agency-file/:mouId/:agencyId", requireMouEnabled, requireMouPermission, (req, res) => {
  try {
    const agencyId = String(req.params.agencyId || "").trim().toLowerCase();
    const canSeeAll = !!req.authentikUser?.isGlobalAdmin;
    const canSeeOwnAgency =
      !!req.authentikUser?.isAgencyAdmin &&
      accessSvc.isSuffixAllowed(req.authentikUser, agencyId);
    if (!canSeeAll && !canSeeOwnAgency) {
      return res.status(403).render("access-denied", {
        username: req.authentikUser?.username || "",
      });
    }

    const evidence = mouService.getAgencyEvidence({
      mouId: req.params.mouId,
      agencyId,
      version: req.query.version,
    });
    if (!evidence.uploadedSignedCopyAbsPath) {
      return renderNotFound(req, res);
    }
    const fileName =
      evidence.signature?.uploadedSignedCopyFileName ||
      `${evidence.stream?.title || "signed-document"}-signed-copy`;
    if (evidence.signature?.uploadedSignedCopyContentType) {
      res.type(evidence.signature.uploadedSignedCopyContentType);
    }
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition(req.query.download === "1" ? "attachment" : "inline", fileName)
    );
    return res.sendFile(evidence.uploadedSignedCopyAbsPath);
  } catch (err) {
    return renderNotFound(req, res);
  }
});

router.get("/mou/sign/:mouId/:version", requireMouEnabled, requireMouPermission, requireAgencyAdmin, (req, res) => {
  try {
    const out = mouService.getCurrentVersionOrLatest(req.params.mouId, req.params.version);
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
    const currentAgency = agencyChoices[0] || null;
    const currentAgencySignature = currentAgency?.currentSignature || null;
    const signedEvidence =
      currentAgency && currentAgencySignature
        ? mouService.getAgencyEvidence({
            mouId: out.stream.mouId,
            agencyId: currentAgency.suffix,
            version: out.targetVersion.version,
          })
        : null;
    const signedEvidenceViewUrl =
      currentAgency && currentAgencySignature
        ? `/mou/agency/${encodeURIComponent(out.stream.mouId)}/${encodeURIComponent(currentAgency.suffix)}?version=${encodeURIComponent(out.targetVersion.version)}`
        : "";
    const signedEvidencePdfUrl =
      currentAgency && currentAgencySignature
        ? `/mou/agency/${encodeURIComponent(out.stream.mouId)}/${encodeURIComponent(currentAgency.suffix)}/pdf?version=${encodeURIComponent(out.targetVersion.version)}`
        : "";
    res.render("mou_sign", {
      stream: out.stream,
      version: out.targetVersion,
      html: out.html,
      contentType: out.contentType,
      fileUrl: contentUrls.fileUrl,
      downloadUrl: contentUrls.downloadUrl,
      signedEvidenceHtml: signedEvidence?.html || "",
      signedEvidenceSignature: signedEvidence?.signature || null,
      signedEvidenceViewUrl,
      signedEvidenceDownloadUrl: signedEvidencePdfUrl,
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

router.post("/mou/sign/:mouId/:version", requireMouEnabled, requireMouPermission, requireAgencyAdmin, upload.single("signedCopyFile"), async (req, res) => {
  try {
    const stream = mouService.getStreamById(req.params.mouId);
    const agencyChoices = resolveSignableAgencyChoices(req.authentikUser, stream);
    const agencySuffix = String(req.body?.agencySuffix || "").trim().toLowerCase();
    const signMethod = String(req.body?.signMethod || "esign").trim().toLowerCase();
    if (!agencyChoices.some((agency) => agency.suffix === agencySuffix)) {
      return res.status(403).render("access-denied", {
        username: req.authentikUser?.username || "",
      });
    }
    if (signMethod === "upload" && !req.file) {
      throw new Error("Attach a PDF or image of the signed document.");
    }

    const agency = mouService.getAgencyBySuffix(agencySuffix);
    const signerStatus = await resolveSignerStatus(req.authentikUser);
    const result = mouService.signVersion({
      mouId: req.params.mouId,
      version: req.params.version,
      agencySuffix,
      agencyNameAtSign: agency?.name || agency?.groupPrefix || agency?.suffix || agencySuffix,
      signerUserId: req.authentikUser?.uid || req.authentikUser?.username,
      signerDisplayName: req.body?.attestationText || req.authentikUser?.displayName || req.authentikUser?.username,
      signerStatusAtSign: req.body?.signerRole || signerStatus,
      attestationText: req.body?.attestationText,
      customFieldValues: req.body?.customFieldValues,
      signatureDataUrl: req.body?.signatureDataUrl,
      uploadedSignedCopyFile: signMethod === "upload" ? req.file || null : null,
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
        signMethod,
      },
    });

    triggerSignedGlobalAdminNotification(req, result, signMethod);

    return res.redirect(
      `/mou/sign/${encodeURIComponent(req.params.mouId)}/${encodeURIComponent(req.params.version)}?success=${encodeURIComponent(signMethod === "upload" ? "Signed document uploaded successfully." : "MOU signed successfully.")}`
    );
  } catch (err) {
    return toErrorRedirect(
      res,
      `/mou/sign/${encodeURIComponent(req.params.mouId)}/${encodeURIComponent(req.params.version)}`,
      err
    );
  }
});

router.post("/admin/mou/:mouId/signatures/upload/:agencyId", requireMouEnabled, requireMouPermission, requireGlobalAdmin, upload.single("signedCopyFile"), async (req, res) => {
  try {
    const stream = mouService.getStreamById(req.params.mouId);
    const currentVersion = mouService.getCurrentVersion(stream);
    if (!currentVersion) {
      throw new Error("MOU version not found.");
    }

    const agencySuffix = String(req.params.agencyId || "").trim().toLowerCase();
    const targetAgency = mouService
      .getTargetAgenciesForStream(stream)
      .find((agency) => String(agency?.suffix || "").trim().toLowerCase() === agencySuffix);
    if (!targetAgency) {
      throw new Error("This document is not assigned to the selected agency.");
    }
    if (!req.file) {
      throw new Error("Attach a PDF or image of the signed document.");
    }

    const agency = mouService.getAgencyBySuffix(agencySuffix);
    const signerStatus = await resolveSignerStatus(req.authentikUser);
    const result = mouService.signVersion({
      mouId: req.params.mouId,
      version: currentVersion.version,
      agencySuffix,
      agencyNameAtSign: agency?.name || targetAgency?.name || agency?.groupPrefix || agencySuffix,
      signerUserId: req.authentikUser?.uid || req.authentikUser?.username,
      signerDisplayName: req.body?.attestationText || req.authentikUser?.displayName || req.authentikUser?.username,
      signerStatusAtSign: req.body?.signerRole || signerStatus,
      attestationText: req.body?.attestationText,
      customFieldValues: req.body?.customFieldValues,
      signatureDataUrl: "",
      uploadedSignedCopyFile: req.file,
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
        signMethod: "upload_admin",
      },
    });

    triggerSignedGlobalAdminNotification(req, result, "upload_admin");

    return res.redirect(`/mou?success=${encodeURIComponent("Signed document uploaded successfully.")}`);
  } catch (err) {
    return toErrorRedirect(res, "/mou", err);
  }
});

router.get(
  "/admin/mou/agency-admins/:agencySuffix",
  requireMouEnabled,
  requireMouPermission,
  requireGlobalAdmin,
  async (req, res) => {
    try {
      const agency = mouService.getAgencyBySuffix(req.params.agencySuffix);
      if (!agency) {
        return res.status(404).json({ error: "Agency not found." });
      }
      const users = await mouScheduler.listAgencyAdminUsersForAssign(agency);
      return res.json({ users });
    } catch (err) {
      return res.status(500).json({ error: err?.message || "Failed to load agency admins." });
    }
  }
);

router.post("/admin/mou/:mouId/signatures/resend/:agencyId", requireMouEnabled, requireMouPermission, requireGlobalAdmin, async (req, res) => {
  try {
    const stream = mouService.getStreamById(req.params.mouId);
    const currentVersion = mouService.getCurrentVersion(stream);
    if (!currentVersion) {
      throw new Error("MOU version not found.");
    }

    const agencySuffix = String(req.params.agencyId || "").trim().toLowerCase();
    const targetAgency = mouService
      .getTargetAgenciesForStream(stream)
      .find((agency) => String(agency?.suffix || "").trim().toLowerCase() === agencySuffix);
    if (!targetAgency) {
      throw new Error("This document is not assigned to the selected agency.");
    }

    const signingMode = mouService.getAgencySigningMode(stream, agencySuffix);
    let result;
    if (signingMode === mouService.AGENCY_SIGNING_MODE_EXTERNAL_LINK) {
      const invites = mouService.syncExternalSignInvitesForStream({
        stream,
        actor: req.authentikUser,
        agencySuffixes: [agencySuffix],
      });
      const invite = invites[0];
      if (!invite) {
        throw new Error("Unable to create an external sign link for this agency.");
      }
      result = await mouScheduler.sendExternalSignInviteEmail({
        stream,
        version: currentVersion,
        agency: targetAgency,
        invite,
        actor: req.authentikUser,
      });
    } else {
      result = await mouScheduler.sendAssignmentNotificationForAgency({
        stream,
        version: currentVersion,
        agency: targetAgency,
        actor: req.authentikUser,
      });
    }
    if (!result.sent) {
      throw new Error(result.reason || result.error || "No recipients found for this notification.");
    }

    auditRequest(req, {
      action:
        signingMode === mouService.AGENCY_SIGNING_MODE_EXTERNAL_LINK
          ? "MOU_EXTERNAL_SIGN_INVITE_SENT"
          : "MOU_ASSIGNMENT_NOTIFICATION_RESENT",
      targetType: "mou",
      targetId: String(req.params.mouId),
      agencySuffix,
      details: {
        mouId: req.params.mouId,
        version: currentVersion.version,
        agencyId: agencySuffix,
      },
    });

    return res.redirect(
      `/mou?success=${encodeURIComponent(
        signingMode === mouService.AGENCY_SIGNING_MODE_EXTERNAL_LINK
          ? "External sign link email sent."
          : signingMode === mouService.AGENCY_SIGNING_MODE_SPECIFIC_ADMIN
            ? "Email resent to the assigned agency administrator."
            : "Email resent to agency administrators."
      )}`
    );
  } catch (err) {
    return toErrorRedirect(res, "/mou", err);
  }
});

router.post(
  "/admin/mou/:mouId/sign-invites/:agencyId/regenerate",
  requireMouEnabled,
  requireMouPermission,
  requireGlobalAdmin,
  async (req, res) => {
    try {
      const stream = mouService.getStreamById(req.params.mouId);
      const currentVersion = mouService.getCurrentVersion(stream);
      if (!currentVersion) {
        throw new Error("MOU version not found.");
      }

      const agencySuffix = String(req.params.agencyId || "").trim().toLowerCase();
      const targetAgency = mouService
        .getTargetAgenciesForStream(stream)
        .find((agency) => String(agency?.suffix || "").trim().toLowerCase() === agencySuffix);
      if (!targetAgency) {
        throw new Error("This document is not assigned to the selected agency.");
      }
      if (mouService.getAgencySigningMode(stream, agencySuffix) !== mouService.AGENCY_SIGNING_MODE_EXTERNAL_LINK) {
        throw new Error("This agency is not configured for external sign links.");
      }

      const inviteEmail =
        normalizeAssignmentEmail(req.body?.inviteEmail) ||
        mouService.getAgencySigningInviteEmail(stream, agencySuffix);
      if (inviteEmail) {
        const currentAssignments = stream.assignments || {};
        const agencySigning = {
          ...(currentAssignments.agencySigning || {}),
          [agencySuffix]: {
            mode: mouService.AGENCY_SIGNING_MODE_EXTERNAL_LINK,
            inviteEmail,
          },
        };
        mouService.updateStreamAssignments({
          mouId: req.params.mouId,
          serverwide: currentAssignments.serverwide,
          agencySuffixes: currentAssignments.agencySuffixes,
          agencySigning,
          actor: req.authentikUser,
        });
      }

      const refreshedStream = mouService.getStreamById(req.params.mouId);
      const invites = mouService.syncExternalSignInvitesForStream({
        stream: refreshedStream,
        actor: req.authentikUser,
        agencySuffixes: [agencySuffix],
      });
      const invite = invites[0];
      if (!invite) {
        throw new Error("Unable to regenerate the external sign link.");
      }

      let emailed = false;
      if (inviteEmail) {
        const emailResult = await mouScheduler.sendExternalSignInviteEmail({
          stream: refreshedStream,
          version: currentVersion,
          agency: targetAgency,
          invite,
          actor: req.authentikUser,
        });
        emailed = !!emailResult.sent;
      }

      const wantsJson =
        String(req.headers.accept || "").includes("application/json") ||
        req.query.format === "json";
      const responseRow = buildExternalInviteResponseRows(refreshedStream, [invite])[0] || null;
      if (wantsJson) {
        return res.json({
          success: true,
          externalInvite: responseRow,
          emailed,
        });
      }

      return res.redirect(
        `/mou?success=${encodeURIComponent(
          emailed ? "New external sign link generated and emailed." : "New external sign link generated."
        )}`
      );
    } catch (err) {
      if (
        String(req.headers.accept || "").includes("application/json") ||
        req.query.format === "json"
      ) {
        return res.status(400).json({ error: err?.message || "Failed to regenerate sign link." });
      }
      return toErrorRedirect(res, "/mou", err);
    }
  }
);

router.post("/admin/mou/:mouId/signatures/resign/:agencyId", requireMouEnabled, requireMouPermission, requireGlobalAdmin, async (req, res) => {
  try {
    const agencyId = String(req.params.agencyId || "").trim().toLowerCase();
    const stream = mouService.getStreamById(req.params.mouId);
    const currentVersion = mouService.getCurrentVersion(stream);
    if (!currentVersion) {
      throw new Error("MOU version not found.");
    }

    const targetAgency = mouService
      .getTargetAgenciesForStream(stream)
      .find((agency) => String(agency?.suffix || "").trim().toLowerCase() === agencyId);
    if (!targetAgency) {
      throw new Error("This document is not assigned to the selected agency.");
    }

    const result = mouService.clearAgencySignatureForCurrentVersion({
      mouId: req.params.mouId,
      agencyId,
      actor: req.authentikUser,
    });

    auditRequest(req, {
      action: "MOU_SIGNATURE_RESET",
      targetType: "mou",
      targetId: String(req.params.mouId),
      agencySuffix: agencyId,
      details: {
        mouId: req.params.mouId,
        agencyId,
        version: result.version?.version || null,
        summary: `Cleared current MOU signature for agency ${agencyId}.`,
      },
    });

    let successMessage = "Agency signature reset. Re-sign is now required.";
    try {
      const notifyResult = await mouScheduler.sendAssignmentNotificationForAgency({
        stream,
        version: currentVersion,
        agency: targetAgency,
        actor: req.authentikUser,
      });
      if (notifyResult.sent) {
        auditRequest(req, {
          action: "MOU_ASSIGNMENT_NOTIFICATION_SENT",
          targetType: "mou",
          targetId: String(req.params.mouId),
          agencySuffix: agencyId,
          details: {
            mouId: req.params.mouId,
            version: currentVersion.version,
            agencyId,
            trigger: "resign",
          },
        });
        successMessage =
          "Agency signature reset. Re-sign is required, and agency administrators were notified by email.";
      } else if (!notifyResult.skipped) {
        console.warn("[MOU_RESIGN] Assignment notification failed", {
          mouId: req.params.mouId,
          agencyId,
          version: currentVersion.version,
          error: notifyResult.error || "Unknown error",
        });
      }
    } catch (notifyErr) {
      console.error("[MOU_RESIGN] Assignment notification failure", {
        mouId: req.params.mouId,
        agencyId,
        version: currentVersion.version,
        error: notifyErr?.message || String(notifyErr || "Unknown notification error"),
      });
    }

    return res.redirect(`/mou?success=${encodeURIComponent(successMessage)}`);
  } catch (err) {
    return toErrorRedirect(res, "/mou", err);
  }
});

router.post("/api/mou/user-agreement/accept", requireMouEnabled, (req, res) => {
  try {
    if (!mouService.shouldRequireUserAgreement(req.authentikUser, { acceptedForSession: false })) {
      return res.json({ success: true });
    }
    const agreement = mouService.getCurrentUserAgreement().current;
    res.cookie(USER_AGREEMENT_SESSION_COOKIE, buildAgreementSessionValue(req, req.authentikUser, agreement), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err?.message || "Failed to continue." });
  }
});

router.post("/api/mou/user-agreement/decline", requireMouEnabled, (req, res) => {
  res.json({ success: true, logoutUrl: "/logout" });
});

router.get("/admin/mou", requireMouEnabled, requireMouPermission, requireGlobalAdmin, (req, res) => {
  return res.redirect("/mou");
});

router.get("/admin/mou/:mouId/history.zip", requireMouEnabled, requireMouPermission, requireGlobalAdmin, (req, res) => {
  Promise.resolve()
    .then(async () => {
      const stream = mouService.getStreamById(req.params.mouId);
      const currentVersion = mouService.getCurrentVersion(stream);
      const agencyId = String(req.query.agencyId || "").trim().toLowerCase();
      if (!agencyId) {
        throw new Error("Agency is required for historical signed export.");
      }

      const signedVersions = (stream.versions || [])
        .filter((entry) =>
          (entry.signatures || []).some(
            (signature) => String(signature?.agencyId || "").trim().toLowerCase() === agencyId
          )
        )
        .sort((a, b) => Number(a?.version || 0) - Number(b?.version || 0));

      if (!signedVersions.length) {
        throw new Error("No signed versions are available for this agency.");
      }

      const pdfExports = [];
      for (const versionRecord of signedVersions) {
        pdfExports.push(
          await mouService.getSignedPdfExport({
            mouId: stream.mouId,
            agencyId,
            version: versionRecord.version,
          })
        );
      }

      auditRequest(req, {
        action: "MOU_HISTORY_EXPORTED",
        targetType: "mou",
        targetId: String(stream.mouId),
        agencySuffix: agencyId,
        details: {
          mouId: stream.mouId,
          agencyId,
          currentVersion: currentVersion?.version || null,
          historicalVersionCount: pdfExports.length,
          summary: `Exported ${pdfExports.length} signed MOU PDF(s) for agency ${agencyId}, including the current signed version when available.`,
        },
      });

      const baseName = safeArchiveSegment(stream.title || stream.slug || "mou", "mou");
      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        buildContentDisposition("attachment", `${baseName}-${agencyId}-signed-history.zip`)
      );

      const archive = archiver("zip", { zlib: { level: 9 } });
      archive.on("error", (err) => {
        console.error("MOU history zip export error:", err);
        if (!res.headersSent) {
          res.status(500).end("Failed to export historical signed zip");
        } else {
          res.end();
        }
      });
      archive.pipe(res);

      for (const pdf of pdfExports) {
        archive.append(pdf.buffer, { name: `${baseName}/${pdf.fileName}` });
      }

      return archive.finalize();
    })
    .catch((err) => {
      return toErrorRedirect(res, "/mou", err);
    });
});

router.post("/admin/mou", requireMouEnabled, requireMouPermission, requireGlobalAdmin, upload.single("contentFile"), (req, res) => {
  try {
    const stream = mouService.createStream({
      title: req.body?.title,
      html: req.body?.html,
      file: req.file || null,
      contentType: req.body?.contentType,
      customFieldLabels: req.body?.customFieldLabels,
      reminderDays: req.body?.reminderDays,
      mandatory: true,
      actor: req.authentikUser,
    });
    const currentVersion = mouService.getCurrentVersion(stream);
    const createdContent = currentVersion
      ? mouService.getVersionContent(stream.mouId, currentVersion.version)
      : null;
    auditRequest(req, {
      action: "MOU_DOCUMENT_CREATED",
      targetType: "mou",
      targetId: String(stream.mouId),
      details: {
        mouId: stream.mouId,
        version: currentVersion?.version || 1,
        title: stream.title,
        changes: buildMouAuditContentChange({
          beforeContent: null,
          inputContent: {
            contentType: req.body?.contentType,
            html: req.body?.html,
          },
          uploadFile: req.file || null,
          afterContent: createdContent,
        }),
      },
    });
    return res.redirect(`/mou?success=${encodeURIComponent("Document created.")}`);
  } catch (err) {
    return toErrorRedirect(res, "/mou", err);
  }
});

router.post("/admin/mou/:mouId/new-version", requireMouEnabled, requireMouPermission, requireGlobalAdmin, (req, res) => {
  Promise.resolve()
    .then(async () => {
      const stream = mouService.createNextVersion({
        mouId: req.params.mouId,
        actor: req.authentikUser,
      });
      const currentVersion = mouService.getCurrentVersion(stream);
      if (
        currentVersion &&
        mouService.getTargetAgenciesForStream(stream).length
      ) {
        await mouScheduler.sendAssignmentNotificationsForVersion({
          stream,
          version: currentVersion,
          actor: req.authentikUser,
        });
      }
      auditRequest(req, {
        action: "MOU_VERSION_CREATED",
        targetType: "mou",
        targetId: String(stream.mouId),
        details: {
          mouId: stream.mouId,
          version: currentVersion ? currentVersion.version : null,
          title: stream.title,
        },
      });
      return res.redirect(`/mou?success=${encodeURIComponent("New version created.")}`);
    })
    .catch((err) => {
      return toErrorRedirect(res, "/mou", err);
    });
});

router.get("/admin/mou/:mouId/:version/edit", requireMouEnabled, requireMouPermission, requireGlobalAdmin, (req, res) => {
  return res.redirect(`/mou?editVersion=${encodeURIComponent(`${req.params.mouId}:${req.params.version}`)}`);
});

router.post("/admin/mou/:mouId/assignments/save", requireMouEnabled, requireMouPermission, requireGlobalAdmin, async (req, res) => {
  const debugContext = {
    mouId: String(req.params.mouId || ""),
    username: req.authentikUser?.username || req.authentikUser?.uid || "unknown",
    serverwide: !!req.body?.serverwide,
    agencySuffixes: [],
  };
  try {
    const previousStream = mouService.getStreamById(req.params.mouId);
    const rawAgencySuffixes = req.body?.agencySuffixes;
    const agencySuffixes = Array.isArray(rawAgencySuffixes)
      ? rawAgencySuffixes
      : rawAgencySuffixes
        ? [rawAgencySuffixes]
        : [];
    debugContext.agencySuffixes = agencySuffixes;
    console.info("[MOU_ASSIGN] Save requested", debugContext);

    const stream = mouService.updateStreamAssignments({
      mouId: req.params.mouId,
      serverwide: req.body?.serverwide,
      agencySuffixes,
      agencySigning: parseAgencySigningPayload(req.body, agencySuffixes),
      actor: req.authentikUser,
    });

    console.info("[MOU_ASSIGN] Assignments updated", {
      ...debugContext,
      savedAssignments: stream.assignments || null,
    });

    const previousAssignmentKey = JSON.stringify(previousStream.assignments || {});
    const currentAssignmentKey = JSON.stringify(stream.assignments || {});
    const currentVersion = mouService.getCurrentVersion(stream);
    const targetAgencies = mouService.getTargetAgenciesForStream(stream);
    const successUrl = `/mou?success=${encodeURIComponent("Document assignment updated.")}`;
    const wantsJson =
      String(req.headers.accept || "").includes("application/json") ||
      req.query.format === "json";

    console.info("[MOU_ASSIGN] Post-save state", {
      ...debugContext,
      currentVersion: currentVersion?.version || null,
      targetAgencyCount: targetAgencies.length,
      targetAgencySuffixes: targetAgencies.map((agency) => agency?.suffix).filter(Boolean),
    });
    if (wantsJson) {
      const externalInvites = mouService.syncExternalSignInvitesForStream({
        stream,
        actor: req.authentikUser,
      });
      res.json({
        success: true,
        redirectUrl: successUrl,
        externalInvites: buildExternalInviteResponseRows(stream, externalInvites),
      });
    } else {
      res.redirect(successUrl);
    }

    void Promise.resolve().then(async () => {
      if (
        req.query.skipNotifications === "1" ||
        !currentVersion ||
        previousAssignmentKey === currentAssignmentKey ||
        !targetAgencies.length
      ) {
        return;
      }
      try {
        await mouScheduler.sendAssignmentNotificationsForVersion({
          stream,
          version: currentVersion,
          actor: req.authentikUser,
        });
      } catch (notifyErr) {
          console.error("[MOU_ASSIGN] Notification failure", {
            ...debugContext,
            currentVersion: currentVersion.version,
            error: notifyErr?.message || String(notifyErr || "Unknown notification error"),
            stack: notifyErr?.stack || null,
          });
          auditRequest(req, {
            action: "MOU_ASSIGNMENT_NOTIFICATION_FAILED",
            targetType: "mou",
            targetId: String(req.params.mouId),
            details: {
              mouId: req.params.mouId,
              version: currentVersion.version,
              error: notifyErr?.message || String(notifyErr || "Failed to send assignment notifications."),
            },
          });
      }
      try {
        auditRequest(req, {
          action: "MOU_ASSIGNMENTS_UPDATED",
          targetType: "mou",
          targetId: String(req.params.mouId),
          details: {
            mouId: req.params.mouId,
            assignment: mouService.getScopeLabel(stream),
            targetAgencyCount: targetAgencies.length,
          },
        });
      } catch (auditErr) {
        console.error("[MOU_ASSIGN] Audit logging failure", {
          ...debugContext,
          error: auditErr?.message || String(auditErr || "Unknown audit error"),
          stack: auditErr?.stack || null,
        });
      }
    }).catch((backgroundErr) => {
      console.error("[MOU_ASSIGN] Background follow-up failure", {
        ...debugContext,
        error: backgroundErr?.message || String(backgroundErr || "Unknown background error"),
        stack: backgroundErr?.stack || null,
      });
    });
    return;
  } catch (err) {
    console.error("[MOU_ASSIGN] Fatal failure", {
      ...debugContext,
      error: err?.message || String(err || "Unknown assignment error"),
      stack: err?.stack || null,
      body: req.body || null,
    });
    if (
      String(req.headers.accept || "").includes("application/json") ||
      req.query.format === "json"
    ) {
      return res.status(400).json({ error: err?.message || "Failed to save assignment." });
    }
    return toErrorRedirect(res, "/mou", err);
  }
});

router.post("/admin/mou/:mouId/assignments/revoke/:agencyId", requireMouEnabled, requireMouPermission, requireGlobalAdmin, (req, res) => {
  try {
    const stream = mouService.getStreamById(req.params.mouId);
    const agencyId = String(req.params.agencyId || "").trim().toLowerCase();
    const remainingAgencySuffixes = mouService
      .getTargetAgenciesForStream(stream)
      .map((agency) => String(agency?.suffix || "").trim().toLowerCase())
      .filter(Boolean)
      .filter((suffix) => suffix !== agencyId);

    mouService.updateStreamAssignments({
      mouId: req.params.mouId,
      serverwide: false,
      agencySuffixes: remainingAgencySuffixes,
      actor: req.authentikUser,
    });

    auditRequest(req, {
      action: "MOU_ASSIGNMENT_REVOKED",
      targetType: "mou",
      targetId: String(req.params.mouId),
      agencySuffix: agencyId,
      details: {
        mouId: req.params.mouId,
        agencyId,
      },
    });

    return res.redirect(`/mou?success=${encodeURIComponent("Agency assignment revoked.")}`);
  } catch (err) {
    return toErrorRedirect(res, "/mou", err);
  }
});

router.post("/admin/mou/:mouId/assignments/archive/:agencyId", requireMouEnabled, requireMouPermission, requireGlobalAdmin, (req, res) => {
  try {
    const agencyId = String(req.params.agencyId || "").trim().toLowerCase();
    mouService.archiveDocumentForAgency({
      mouId: req.params.mouId,
      agencyId,
      actor: req.authentikUser,
    });

    auditRequest(req, {
      action: "MOU_ASSIGNMENT_ARCHIVED",
      targetType: "mou",
      targetId: String(req.params.mouId),
      agencySuffix: agencyId,
      details: {
        mouId: req.params.mouId,
        agencyId,
      },
    });

    return res.redirect(`/mou?success=${encodeURIComponent("Document archived.")}`);
  } catch (err) {
    return toErrorRedirect(res, "/mou", err);
  }
});

router.post("/admin/mou/archive/:archiveId/restore", requireMouEnabled, requireMouPermission, requireGlobalAdmin, (req, res) => {
  try {
    const archiveId = String(req.params.archiveId || "").trim();
    mouService.restoreArchivedDocument({
      archiveId,
      actor: req.authentikUser,
    });

    auditRequest(req, {
      action: "MOU_ARCHIVE_RESTORED",
      targetType: "mou_archive",
      targetId: archiveId,
      details: {
        archiveId,
      },
    });

    return res.redirect(`/mou?success=${encodeURIComponent("Archived document restored.")}`);
  } catch (err) {
    return toErrorRedirect(res, "/mou", err);
  }
});

router.post("/admin/mou/archive/:archiveId/delete", requireMouEnabled, requireMouPermission, requireGlobalAdmin, (req, res) => {
  try {
    const archiveId = String(req.params.archiveId || "").trim();
    mouService.deleteArchivedDocument({
      archiveId,
      actor: req.authentikUser,
    });

    auditRequest(req, {
      action: "MOU_ARCHIVE_DELETED",
      targetType: "mou_archive",
      targetId: archiveId,
      details: {
        archiveId,
      },
    });

    return res.redirect(`/mou?success=${encodeURIComponent("Archived document permanently deleted.")}`);
  } catch (err) {
    return toErrorRedirect(res, "/mou", err);
  }
});

router.get("/admin/mou/archive/:archiveId/view", requireMouEnabled, requireMouPermission, requireGlobalAdmin, (req, res) => {
  try {
    const out = mouService.getArchivedDocumentView(req.params.archiveId);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(out.html || "<p>Signed document not found.</p>");
  } catch (err) {
    return res.status(404).send(err?.message || "Archived document not found.");
  }
});

router.get("/admin/mou/archive/:archiveId/pdf", requireMouEnabled, requireMouPermission, requireGlobalAdmin, async (req, res) => {
  try {
    const pdf = await mouService.getArchivedSignedPdfExport(req.params.archiveId);
    res.setHeader("Content-Type", pdf.contentType || "application/pdf");
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition(
        req.query.download === "1" ? "attachment" : "inline",
        pdf.fileName
      )
    );
    return res.send(pdf.buffer);
  } catch (err) {
    return res.status(404).send(err?.message || "Archived signed PDF not found.");
  }
});

router.get("/admin/mou/archive/:archiveId/document", requireMouEnabled, requireMouPermission, requireGlobalAdmin, (req, res) => {
  try {
    const out = mouService.getArchivedDocumentContentExport(req.params.archiveId);
    const fileName = String(out.fileName || "mou").replace(/"/g, "");
    const download = req.query.download === "1";

    if (out.contentType === "pdf") {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        buildContentDisposition(download ? "attachment" : "inline", fileName)
      );
      return res.send(out.contentBuffer);
    }

    if (out.contentType === "markdown") {
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      if (download) {
        res.setHeader("Content-Disposition", buildContentDisposition("attachment", fileName));
      }
      return res.send(out.contentBuffer.toString("utf8"));
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (download) {
      res.setHeader("Content-Disposition", buildContentDisposition("attachment", fileName));
    }
    return res.send(out.html);
  } catch (err) {
    return res.status(404).send(err?.message || "Archived document not found.");
  }
});

router.post(
  "/admin/mou/:mouId/signing/:agencyId/ensure-link",
  requireMouEnabled,
  requireMouPermission,
  requireGlobalAdmin,
  async (req, res) => {
    try {
      const agencySuffix = String(req.params.agencyId || "").trim().toLowerCase();
      let stream = mouService.getStreamById(req.params.mouId);
      const targetedSuffixes = mouService
        .getTargetAgenciesForStream(stream)
        .map((agency) => String(agency?.suffix || "").trim().toLowerCase());
      if (!targetedSuffixes.includes(agencySuffix)) {
        throw new Error("Assign this agency before copying a sign link.");
      }

      const signingMode = mouService.getAgencySigningMode(stream, agencySuffix);
      const inviteEmail = normalizeAssignmentEmail(req.body?.signingEmail);
      const requestedMode = String(req.body?.signingMode || "").trim().toLowerCase();
      if (requestedMode === mouService.AGENCY_SIGNING_MODE_EXTERNAL_LINK) {
        stream = mouService.updateAgencySigningConfig({
          mouId: req.params.mouId,
          agencySuffix,
          signingPatch: {
            mode: mouService.AGENCY_SIGNING_MODE_EXTERNAL_LINK,
            ...(inviteEmail ? { inviteEmail } : {}),
            externalLinkAcknowledged:
              String(req.body?.signingLinkCopied || "").trim() === "1",
          },
          actor: req.authentikUser,
          skipValidation: true,
        });
      } else if (signingMode !== mouService.AGENCY_SIGNING_MODE_EXTERNAL_LINK) {
        throw new Error("Set signing method to External One-Time Link before copying a sign link.");
      } else if (inviteEmail) {
        stream = mouService.updateAgencySigningConfig({
          mouId: req.params.mouId,
          agencySuffix,
          signingPatch: {
            mode: mouService.AGENCY_SIGNING_MODE_EXTERNAL_LINK,
            inviteEmail,
          },
          actor: req.authentikUser,
          skipValidation: true,
        });
      }

      const invites = mouService.syncExternalSignInvitesForStream({
        stream,
        actor: req.authentikUser,
        agencySuffixes: [agencySuffix],
      });
      const invite = invites[0];
      if (!invite?.token) {
        throw new Error("Unable to create an external sign link for this agency.");
      }

      const externalSignPath = mouService.buildExternalSignPath(invite.token);
      const { getString } = require("../services/env");
      const baseUrl = String(getString("TAK_PORTAL_PUBLIC_URL", "") || "")
        .trim()
        .replace(/\/+$/, "");
      return res.json({
        success: true,
        externalSignPath,
        signUrl: baseUrl ? `${baseUrl}${externalSignPath}` : externalSignPath,
      });
    } catch (err) {
      return res.status(400).json({ error: err?.message || "Unable to create sign link." });
    }
  }
);

router.post(
  "/admin/mou/:mouId/signing/:agencyId/update",
  requireMouEnabled,
  requireMouPermission,
  requireGlobalAdmin,
  async (req, res) => {
    try {
      const agencySuffix = String(req.params.agencyId || "").trim().toLowerCase();
      const adminSelection = parseSigningAdminSelection(
        req.body?.signingAdminEmail,
        req.body?.signingAdminUsername,
        req.body?.signingAdminName
      );
      const stream = mouService.updateAgencySigningConfig({
        mouId: req.params.mouId,
        agencySuffix,
        signingPatch: {
          mode: req.body?.signingMode,
          inviteEmail: req.body?.signingEmail,
          externalLinkAcknowledged:
            String(req.body?.signingLinkCopied || req.body?.externalLinkCopied || "").trim() ===
            "1",
          assignedAdminEmail: adminSelection.assignedAdminEmail,
          assignedAdminUsername: adminSelection.assignedAdminUsername,
          assignedAdminName: adminSelection.assignedAdminName,
        },
        actor: req.authentikUser,
      });
      const signingMode = mouService.getAgencySigningMode(stream, agencySuffix);
      let externalSignPath = "";
      if (signingMode === mouService.AGENCY_SIGNING_MODE_EXTERNAL_LINK) {
        const invites = mouService.syncExternalSignInvitesForStream({
          stream,
          actor: req.authentikUser,
          agencySuffixes: [agencySuffix],
        });
        const invite = invites[0];
        if (invite?.token) {
          externalSignPath = mouService.buildExternalSignPath(invite.token);
        }
      }

      const shouldResend =
        String(req.body?.action || "").trim().toLowerCase() === "save_resend" ||
        String(req.body?.resend || "").trim().toLowerCase() === "true";
      if (shouldResend) {
        const currentVersion = mouService.getCurrentVersion(stream);
        const targetAgency = mouService
          .getTargetAgenciesForStream(stream)
          .find((agency) => String(agency?.suffix || "").trim().toLowerCase() === agencySuffix);
        if (!currentVersion || !targetAgency) {
          throw new Error("Unable to send signing notification.");
        }
        let result;
        if (signingMode === mouService.AGENCY_SIGNING_MODE_EXTERNAL_LINK) {
          const invite = mouService.getActiveSignInviteForAgency({
            mouId: stream.mouId,
            agencyId: agencySuffix,
          });
          if (!invite) {
            throw new Error("Unable to create an external sign link for this agency.");
          }
          result = await mouScheduler.sendExternalSignInviteEmail({
            stream,
            version: currentVersion,
            agency: targetAgency,
            invite,
            actor: req.authentikUser,
          });
        } else {
          result = await mouScheduler.sendAssignmentNotificationForAgency({
            stream,
            version: currentVersion,
            agency: targetAgency,
            actor: req.authentikUser,
          });
        }
        if (!result.sent && !result.skipped) {
          throw new Error(result.reason || result.error || "No recipients found for this notification.");
        }
      }

      const wantsJson =
        String(req.headers.accept || "").includes("application/json") ||
        req.query.format === "json";
      const successUrl = `/mou?success=${encodeURIComponent(
        shouldResend
          ? "Signing method updated and notification sent."
          : "Signing method updated."
      )}`;
      if (wantsJson) {
        return res.json({
          success: true,
          redirectUrl: successUrl,
          externalSignPath,
        });
      }
      return res.redirect(successUrl);
    } catch (err) {
      const wantsJson =
        String(req.headers.accept || "").includes("application/json") ||
        req.query.format === "json";
      if (wantsJson) {
        return res.status(400).json({ error: err?.message || "Failed to update signing method." });
      }
      return toErrorRedirect(res, "/mou", err);
    }
  }
);

router.post("/admin/mou/:mouId/:version/save", requireMouEnabled, requireMouPermission, requireGlobalAdmin, upload.single("contentFile"), (req, res) => {
  try {
    const beforeContent = mouService.getVersionContent(req.params.mouId, req.params.version);
    mouService.updateVersion({
      mouId: req.params.mouId,
      version: req.params.version,
      title: req.body?.title,
      slug: req.body?.slug,
      html: req.body?.html,
      file: req.file || null,
      contentType: req.body?.contentType,
      customFieldLabels: req.body?.customFieldLabels,
      reminderDays: req.body?.reminderDays,
      mandatory: true,
      actor: req.authentikUser,
    });
    const payload = {
      success: true,
      previewUrl: `/admin/mou/${encodeURIComponent(req.params.mouId)}/${encodeURIComponent(req.params.version)}/preview`,
    };
    const afterContent = mouService.getVersionContent(req.params.mouId, req.params.version);
    auditRequest(req, {
      action: "MOU_DOCUMENT_UPDATED",
      targetType: "mou",
      targetId: String(req.params.mouId),
      details: {
        mouId: req.params.mouId,
        version: Number(req.params.version),
        titleBefore: beforeContent?.stream?.title || "",
        titleAfter: afterContent?.stream?.title || "",
        changes: buildMouAuditContentChange({
          beforeContent,
          inputContent: {
            contentType: req.body?.contentType || beforeContent?.contentType,
            html: req.body?.html,
          },
          uploadFile: req.file || null,
          afterContent,
        }),
      },
    });
    if (
      String(req.headers.accept || "").includes("application/json") ||
      req.query.format === "json"
    ) {
      return res.json(payload);
    }
    return res.redirect(
      `/mou?success=${encodeURIComponent("Document saved.")}&editVersion=${encodeURIComponent(`${req.params.mouId}:${req.params.version}`)}`
    );
  } catch (err) {
    if (
      String(req.headers.accept || "").includes("application/json") ||
      req.query.format === "json"
    ) {
      return res.status(400).json({ error: err?.message || "Failed to save document." });
    }
    return toErrorRedirect(
      res,
      `/mou?editVersion=${encodeURIComponent(`${req.params.mouId}:${req.params.version}`)}`,
      err
    );
  }
});

router.post("/admin/mou/:mouId/:version/save-as-new", requireMouEnabled, requireMouPermission, requireGlobalAdmin, upload.single("contentFile"), (req, res) => {
  Promise.resolve()
    .then(async () => {
      const sourceVersionContent = mouService.getVersionContent(req.params.mouId, req.params.version);
      const stream = mouService.createNextVersion({
        mouId: req.params.mouId,
        actor: req.authentikUser,
      });
      const currentVersion = mouService.getCurrentVersion(stream);
      if (!currentVersion) {
        throw new Error("MOU version not found.");
      }
      mouService.updateVersion({
        mouId: req.params.mouId,
        version: currentVersion.version,
        title: req.body?.title,
        slug: req.body?.slug,
        html: req.body?.html,
        file: req.file || null,
        contentType: req.body?.contentType,
        customFieldLabels: req.body?.customFieldLabels,
        reminderDays: req.body?.reminderDays,
        mandatory: true,
        actor: req.authentikUser,
      });
      if (mouService.getTargetAgenciesForStream(stream).length) {
        const updatedStream = mouService.getStreamById(req.params.mouId);
        const updatedVersion = mouService.getCurrentVersion(updatedStream);
        await mouScheduler.sendAssignmentNotificationsForVersion({
          stream: updatedStream,
          version: updatedVersion,
          actor: req.authentikUser,
        });
      }
      const savedContent = mouService.getVersionContent(req.params.mouId, currentVersion.version);
      auditRequest(req, {
        action: "MOU_VERSION_CREATED",
        targetType: "mou",
        targetId: String(req.params.mouId),
        details: {
          mouId: req.params.mouId,
          version: currentVersion.version,
          sourceVersion: Number(req.params.version),
          titleBefore: sourceVersionContent?.stream?.title || "",
          titleAfter: savedContent?.stream?.title || "",
          changes: buildMouAuditContentChange({
            beforeContent: sourceVersionContent,
            inputContent: {
              contentType: req.body?.contentType || sourceVersionContent?.contentType,
              html: req.body?.html,
            },
            uploadFile: req.file || null,
            afterContent: savedContent,
          }),
        },
      });
      const payload = {
        success: true,
        redirectUrl: `/mou?success=${encodeURIComponent("New version created.")}`,
      };
      if (
        String(req.headers.accept || "").includes("application/json") ||
        req.query.format === "json"
      ) {
        return res.json(payload);
      }
      return res.redirect(payload.redirectUrl);
    })
    .catch((err) => {
      if (
        String(req.headers.accept || "").includes("application/json") ||
        req.query.format === "json"
      ) {
        return res.status(400).json({ error: err?.message || "Failed to create new version." });
      }
      return toErrorRedirect(
        res,
        `/mou?editVersion=${encodeURIComponent(`${req.params.mouId}:${req.params.version}`)}`,
        err
      );
    });
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
      html: content.contentType === "pdf" ? "" : content.html,
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

router.post("/admin/mou/:mouId/:version/preview", requireMouEnabled, requireMouPermission, requireGlobalAdmin, upload.single("contentFile"), (req, res) => {
  try {
    const stream = mouService.getStreamById(req.params.mouId);
    const version =
      (stream.versions || []).find(
        (entry) => Number(entry.version) === Number(req.params.version)
      ) || null;
    if (!version) throw new Error("MOU version not found.");

    const contentType = String(req.body?.contentType || version.contentType || "markdown").trim().toLowerCase();
    const html = mouService.renderContentPreview({
      contentType,
      html: req.body?.html,
    });

    return res.render("admin/mou_admin_preview", {
      stream: {
        ...stream,
        title: String(req.body?.title || stream.title || "").trim() || stream.title,
      },
      version,
      html,
      contentType,
      fileUrl: "",
      downloadUrl: "",
      fileName: req.file?.originalname || "",
      scopeLabel: mouService.getScopeLabel(stream),
    });
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

router.post("/admin/mou/user-agreement/save", requireMouEnabled, requireMouPermission, requireGlobalAdmin, (req, res) => {
  try {
    const beforeAgreement = mouService.getCurrentUserAgreement();
    const beforeCurrent = beforeAgreement?.current || null;
    const resetToDefault = String(req.body?.resetToDefault || "").toLowerCase() === "true";
    const defaults = mouService.getDefaultUserAgreementTemplate();
    const result = mouService.saveUserAgreement({
      title: resetToDefault ? defaults.title : req.body?.title,
      markdown: resetToDefault ? defaults.markdown : req.body?.markdown,
      html: req.body?.html,
      enabled: resetToDefault ? false : req.body?.enabled,
      actor: req.authentikUser,
    });
    auditRequest(req, {
      action: "MOU_USER_AGREEMENT_SAVED",
      targetType: "user_agreement",
      targetId: String(result.version.version),
      details: {
        version: result.version.version,
        changed: result.changed,
        enabledBefore: beforeAgreement?.enabled === true,
        enabledAfter: result.enabled,
        resetToDefault,
        titleBefore: beforeCurrent?.title || "",
        titleAfter: result.version?.title || "",
        markdownBefore: truncateAuditText(beforeCurrent?.bodyMarkdown || ""),
        markdownAfter: truncateAuditText(result.version?.bodyMarkdown || ""),
      },
    });
    return res.redirect(
      `/mou?success=${encodeURIComponent(resetToDefault ? "User agreement reset to default." : "User agreement saved.")}`
    );
  } catch (err) {
    return toErrorRedirect(res, "/mou", err);
  }
});

router.get("/admin/mou/compliance", requireMouEnabled, requireMouPermission, (req, res) => {
  if (req.query.export === "signatures") {
    return res.redirect("/mou?export=signatures");
  }
  return res.redirect("/mou");
});

function renderExternalSignError(res, err, token) {
  const message = err?.message || String(err || "Unable to open sign link.");
  const linkUnavailable =
    /already been used|confirmation link|sign link not found|no longer valid|no longer accepts|not available|expired|invalid/i.test(
      message
    );
  return res.status(linkUnavailable ? 410 : 400).render("mou_external_sign", {
    error: linkUnavailable ? "" : message,
    success: "",
    token: token || "",
    stream: null,
    version: null,
    html: "",
    contentType: "",
    fileUrl: "",
    downloadUrl: "",
    fileName: "",
    agencyName: "",
    customSignerFields: [],
    alreadySigned: false,
    signedComplete: false,
    signedEvidenceHtml: "",
    signedPdfUrl: "",
    defaultSignerEmail: "",
  });
}

router.get("/request-access/mou/:token", requireMouEnabled, (req, res) => {
  try {
    const { stream, currentVersion, invite } = mouService.resolveValidSignInvite(req.params.token);
    const agency = mouService.getAgencyBySuffix(invite.agencyId);
    const agencyName = agency?.name || agency?.groupPrefix || invite.agencyId;
    const existingSignature = mouService.getCurrentAgencySignatureForStream(
      stream,
      invite.agencyId
    );
    const out = mouService.getCurrentVersionOrLatest(stream.mouId, currentVersion.version);
    const fileUrl = `/request-access/mou/${encodeURIComponent(invite.token)}/file`;
    const downloadUrl = `${fileUrl}?download=1`;
    let signedEvidenceHtml = "";
    if (existingSignature) {
      const evidence = mouService.getAgencyEvidence({
        mouId: stream.mouId,
        agencyId: invite.agencyId,
        version: currentVersion.version,
      });
      signedEvidenceHtml = evidence.html || "";
    }
    return res.render("mou_external_sign", {
      error: req.query.error || "",
      success: req.query.success || "",
      token: invite.token,
      stream,
      version: out.targetVersion,
      html: out.html,
      contentType: out.contentType,
      fileUrl,
      downloadUrl,
      fileName: out.fileName,
      agencyName,
      customSignerFields: Array.isArray(out.targetVersion?.customSignerFields)
        ? out.targetVersion.customSignerFields
        : [],
      alreadySigned: !!existingSignature,
      signedComplete: false,
      signedEvidenceHtml,
      signedPdfUrl: "",
      defaultSignerEmail: invite.recipientEmail || "",
    });
  } catch (err) {
    return renderExternalSignError(res, err, req.params.token);
  }
});

router.get("/request-access/mou/:token/file", requireMouEnabled, (req, res) => {
  try {
    const { stream, currentVersion, invite } = mouService.resolveValidSignInvite(req.params.token);
    const content = mouService.getVersionContent(stream.mouId, currentVersion.version);
    const fileName = String(content.fileName || "mou").replace(/"/g, "");

    if (content.contentType === "pdf") {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        buildContentDisposition(req.query.download === "1" ? "attachment" : "inline", fileName)
      );
      return res.send(content.contentBuffer);
    }

    if (content.contentType === "markdown") {
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      if (req.query.download === "1") {
        res.setHeader("Content-Disposition", buildContentDisposition("attachment", fileName));
      }
      return res.send(content.contentBuffer.toString("utf8"));
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (req.query.download === "1") {
      res.setHeader("Content-Disposition", buildContentDisposition("attachment", fileName));
    }
    return res.send(content.html);
  } catch (err) {
    return res.status(404).send(err?.message || "Not found");
  }
});

router.post(
  "/request-access/mou/:token/sign",
  requireMouEnabled,
  upload.single("signedCopyFile"),
  async (req, res) => {
    const token = String(req.params.token || "").trim();
    try {
      const { stream, currentVersion, invite } = mouService.resolveValidSignInvite(token);
      const signMethod = String(req.body?.signMethod || "esign").trim().toLowerCase();
      if (signMethod === "upload" && !req.file) {
        throw new Error("Attach a PDF or image of the signed document.");
      }
      const agency = mouService.getAgencyBySuffix(invite.agencyId);
      const result = mouService.signVersion({
        mouId: stream.mouId,
        version: currentVersion.version,
        agencySuffix: invite.agencyId,
        agencyNameAtSign: agency?.name || agency?.groupPrefix || invite.agencyId,
        signerUserId: null,
        signerDisplayName: req.body?.attestationText,
        signerStatusAtSign: req.body?.signerRole,
        attestationText: req.body?.attestationText,
        customFieldValues: req.body?.customFieldValues,
        signatureDataUrl: req.body?.signatureDataUrl,
        uploadedSignedCopyFile: signMethod === "upload" ? req.file || null : null,
        ...requestMeta(req),
      });

      auditRequest(req, {
        action: "MOU_AGENCY_SIGNED",
        targetType: "mou",
        targetId: String(result.stream.mouId),
        agencySuffix: invite.agencyId,
        details: {
          mouId: result.stream.mouId,
          version: result.version.version,
          agencyId: invite.agencyId,
          signerDisplayName: result.signature.signerDisplayName,
          signMethod: signMethod === "upload" ? "external_link_upload" : "external_link",
        },
      });

      triggerSignedGlobalAdminNotification(
        req,
        result,
        signMethod === "upload" ? "external_link_upload" : "external_link"
      );

      const signerEmail =
        normalizeAssignmentEmail(req.body?.signerEmail) ||
        normalizeAssignmentEmail(invite.recipientEmail);
      if (signerEmail) {
        void mouScheduler
          .sendExternalSignedPdfEmail({
            stream: result.stream,
            version: result.version,
            agency,
            signerEmail,
            signature: result.signature,
          })
          .catch((emailErr) => {
            console.warn("[MOU_EXTERNAL_SIGN] Signed PDF email failed:", emailErr?.message || emailErr);
          });
      }

      const inviteAfter = mouService.getSignInviteByToken(token);
      const completionToken = inviteAfter?.completionToken;
      if (!completionToken) {
        throw new Error("Unable to open the signed confirmation page.");
      }

      return res.redirect(
        `/request-access/mou/complete/${encodeURIComponent(completionToken)}`
      );
    } catch (err) {
      return res.redirect(
        `/request-access/mou/${encodeURIComponent(token)}?error=${encodeURIComponent(
          err?.message || "Failed to sign document."
        )}`
      );
    }
  }
);

router.get("/request-access/mou/complete/:completionToken", requireMouEnabled, async (req, res) => {
  try {
    const out = mouService.resolveSignInviteCompletion(req.params.completionToken);
    const agency = mouService.getAgencyBySuffix(out.invite.agencyId);
    const agencyName = agency?.name || agency?.groupPrefix || out.invite.agencyId;
    const pdfUrl = `/request-access/mou/complete/${encodeURIComponent(
      out.invite.completionToken
    )}/pdf`;
    mouService.markSignInviteCompletionViewed(req.params.completionToken);
    return res.render("mou_external_sign", {
      error: "",
      success: "",
      token: "",
      stream: out.stream,
      version: out.currentVersion,
      html: "",
      contentType: "",
      fileUrl: "",
      downloadUrl: pdfUrl,
      signedPdfUrl: pdfUrl,
      fileName: out.stream.title,
      agencyName,
      customSignerFields: [],
      alreadySigned: true,
      signedComplete: true,
      signedEvidenceHtml: out.evidence?.html || "",
    });
  } catch (err) {
    return renderExternalSignError(res, err, "");
  }
});

router.get(
  "/request-access/mou/complete/:completionToken/pdf",
  requireMouEnabled,
  async (req, res) => {
    try {
      const out = mouService.resolveSignInviteCompletionPdf(req.params.completionToken);
      const pdf = await mouService.getSignedPdfExport({
        mouId: out.stream.mouId,
        agencyId: out.invite.agencyId,
        version: out.currentVersion.version,
      });
      res.setHeader("Content-Type", pdf.contentType || "application/pdf");
      res.setHeader(
        "Content-Disposition",
        buildContentDisposition(
          req.query.download === "1" ? "attachment" : "inline",
          pdf.fileName
        )
      );
      return res.send(pdf.buffer);
    } catch (err) {
      return res.status(404).send(err?.message || "Not found");
    }
  }
);

module.exports = router;
