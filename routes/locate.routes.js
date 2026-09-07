const router = require("express").Router();
const locatorsSvc = require("../services/locators.service");
const locatorAccess = require("../services/locatorAccess.service");
const locatorForm = require("../services/locatorForm.service");
const locatorCot = require("../services/locatorCot.service");
const locatorReport = require("../services/locatorReport.service");
const accessSvc = require("../services/access.service");
const emailSvc = require("../services/email.service");
const auditSvc = require("../services/auditLog.service");
const { renderTemplate, htmlToText } = require("../services/emailTemplates.service");
const { toSafeApiError } = require("../services/apiErrorPayload.service");
const smsSvc = require("../services/sms.service");
const settingsSvc = require("../services/settings.service");
const { getString } = require("../services/env");

const EMAIL_RE = /^\S+@\S+\.[A-Za-z]{2,}$/;

function buildPublicLocateUrl(req, slug) {
  let base = "";
  try {
    const settings = settingsSvc.getSettings ? settingsSvc.getSettings() || {} : {};
    if (settings.TAK_PORTAL_PUBLIC_URL && String(settings.TAK_PORTAL_PUBLIC_URL).trim()) {
      base = String(settings.TAK_PORTAL_PUBLIC_URL).trim().replace(/\/+$/, "");
    }
  } catch (_) {
    /* ignore */
  }
  if (!base) {
    const env = getString("TAK_PORTAL_PUBLIC_URL", "").trim().replace(/\/+$/, "");
    if (env) base = env;
  }
  if (base) {
    return `${base}/locate/${encodeURIComponent(slug)}`;
  }
  const proto =
    String(req.get("x-forwarded-proto") || req.protocol || "https")
      .split(",")[0]
      .trim() || "https";
  const host = String(req.get("x-forwarded-host") || req.get("host") || "").trim();
  return `${proto}://${host}/locate/${encodeURIComponent(slug)}`;
}

function auditRequest(req) {
  return {
    method: req.method,
    path: req.originalUrl || req.path,
    ip: req.ip,
  };
}

function parseRecipientEmails(raw) {
  const s = String(raw || "").trim();
  if (!s) return { error: "Enter at least one email address." };
  const parts = s
    .split(/[;,]/g)
    .map((x) => String(x).trim())
    .filter(Boolean);
  if (!parts.length) return { error: "Enter at least one email address." };
  const seen = new Set();
  const emails = [];
  for (const e of parts) {
    if (!EMAIL_RE.test(e)) {
      return { error: `Invalid email address: ${e}` };
    }
    const lower = e.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    emails.push(e);
  }
  if (!emails.length) return { error: "Enter at least one email address." };
  return { emails };
}

function isEmailConfigured() {
  const emailCfg = emailSvc.getSmtpConfig();
  return !!(emailSvc.isEmailEnabled() && emailCfg.host && emailCfg.from);
}

async function resolveChannelAndMission(req, channelRaw, missionRaw) {
  const authUser = req.authentikUser || null;
  const access = accessSvc.getAgencyAccess(authUser);
  const { channels, allowedChannelKeys } = await locatorAccess.listChannelsForUser(authUser);
  const raw = String(channelRaw || "").trim();
  if (!raw) {
    const err = new Error("Channel is required.");
    err.status = 400;
    throw err;
  }
  locatorAccess.assertChannelInScope(access, raw, allowedChannelKeys);
  const match = channels.find(
    (c) =>
      c.name === raw ||
      c.displayName === raw ||
      locatorAccess.channelKeyOf(c.name) === locatorAccess.channelKeyOf(raw)
  );
  if (!match) {
    const err = new Error("Channel is required.");
    err.status = 400;
    throw err;
  }
  const mission = await locatorAccess.assertMissionOnChannel(
    authUser,
    String(missionRaw || "").trim(),
    match.name
  );
  return { match, mission };
}

async function scopedLocator(req, id) {
  const loc = locatorsSvc.getById(id);
  const access = accessSvc.getAgencyAccess(req.authentikUser || null);
  const { allowedChannelKeys } = await locatorAccess.listChannelsForUser(req.authentikUser || null);
  return locatorAccess.assertLocatorAccessible(access, loc, allowedChannelKeys);
}

router.get("/meta", async (req, res) => {
  try {
    const { channels } = await locatorAccess.listChannelsForUser(req.authentikUser || null);
    res.json({
      ok: true,
      channels,
      colors: locatorForm.ALLOWED_TEAM_COLORS.slice(),
      smsConfigured: smsSvc.isSmsConfigured(),
      emailConfigured: isEmailConfigured(),
      defaults: {
        heading: locatorForm.DEFAULT_HEADING,
        intro: locatorForm.DEFAULT_INTRO,
        pingIntervalSeconds: 15,
        color: "Cyan",
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.get("/missions", async (req, res) => {
  try {
    const channel = String(req.query.channel || "").trim();
    if (!channel) return res.json({ ok: true, missions: [] });
    const access = accessSvc.getAgencyAccess(req.authentikUser || null);
    const { allowedChannelKeys } = await locatorAccess.listChannelsForUser(req.authentikUser || null);
    locatorAccess.assertChannelInScope(access, channel, allowedChannelKeys);
    const missions = await locatorAccess.listMissionsForChannel(req.authentikUser || null, channel);
    res.json({ ok: true, missions });
  } catch (err) {
    const status = err?.status || (err?.code === "FORBIDDEN" ? 403 : 500);
    if (status === 403) {
      return res.status(403).json({ ok: false, error: err.message || "Forbidden" });
    }
    const code = err?.code;
    if (code === "TAK_NOT_CONFIGURED" || code === "TAK_BYPASS") {
      return res.json({ ok: true, missions: [], takUnavailable: true });
    }
    res.status(500).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.get("/locators", async (req, res) => {
  try {
    const access = accessSvc.getAgencyAccess(req.authentikUser || null);
    const { allowedChannelKeys } = await locatorAccess.listChannelsForUser(req.authentikUser || null);
    const locators = locatorAccess.filterLocatorsForAccess(
      access,
      locatorsSvc.listLocatorsForAdmin({ kind: "live" }),
      allowedChannelKeys
    );
    res.json({
      ok: true,
      locators,
      smsConfigured: smsSvc.isSmsConfigured(),
      emailConfigured: isEmailConfigured(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.post("/locators", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const { match, mission } = await resolveChannelAndMission(
      req,
      req.body?.channel,
      req.body?.mission
    );
    const loc = locatorsSvc.createLive({
      title: req.body?.title,
      pingIntervalSeconds: req.body?.pingIntervalSeconds,
      channel: match.name,
      channelDisplay: match.displayName,
      mission,
      dropPoints: req.body?.dropPoints,
      color: req.body?.color,
      form: req.body?.form,
      agencyScope: locatorAccess.agencyScopeForCreate(authUser),
    });
    auditSvc.logEvent({
      actor: authUser,
      request: auditRequest(req),
      action: "LOCATE_LOCATOR_CREATED",
      targetType: "locator",
      targetId: loc.id,
      details: {
        kind: "live",
        title: loc.title,
        slug: loc.slug,
        channel: loc.channelDisplay,
        mission: loc.mission || undefined,
        pingIntervalSeconds: loc.pingIntervalSeconds,
        summary: `Created live locator "${loc.title}" (slug "${loc.slug}") on channel "${loc.channelDisplay}".`,
      },
    });
    res.json({ ok: true, locator: loc });
  } catch (err) {
    const status = err?.status || (err?.code === "FORBIDDEN" ? 403 : 400);
    res.status(status).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.patch("/locators/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const before = await scopedLocator(req, id);
    const patch = {
      title: req.body?.title,
      pingIntervalSeconds: req.body?.pingIntervalSeconds,
      active: req.body?.active,
      color: req.body?.color,
      dropPoints: req.body?.dropPoints,
      form: req.body?.form,
    };
    if (req.body?.channel !== undefined || req.body?.mission !== undefined) {
      const { match, mission } = await resolveChannelAndMission(
        req,
        req.body?.channel !== undefined ? req.body.channel : before.channel,
        req.body?.mission !== undefined ? req.body.mission : before.mission
      );
      patch.channel = match.name;
      patch.channelDisplay = match.displayName;
      patch.mission = mission;
    }
    const loc = locatorsSvc.update(id, patch);
    const channelChanged =
      locatorAccess.channelKeyOf(before.channel) !== locatorAccess.channelKeyOf(loc.channel);
    if ((before.active && loc.active === false) || channelChanged) {
      locatorCot.publishDelete(before).catch(() => {});
    }
    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: auditRequest(req),
      action: "LOCATE_LOCATOR_UPDATED",
      targetType: "locator",
      targetId: id,
      details: {
        kind: "live",
        slug: loc.slug,
        title: loc.title,
        summary: `Updated locator "${loc.title}" (${loc.slug}).`,
      },
    });
    res.json({ ok: true, locator: loc });
  } catch (err) {
    const status = err?.status || 400;
    res.status(status).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.post("/locators/:id/archive", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const loc = await scopedLocator(req, id);
    locatorCot.publishDelete(loc).catch(() => {});
    const archived = locatorsSvc.archive(id);
    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: auditRequest(req),
      action: "LOCATE_LOCATOR_ARCHIVED",
      targetType: "locator",
      targetId: id,
      details: {
        kind: "live",
        title: archived.title,
        slug: archived.slug,
        summary: `Archived locator "${archived.title}" (slug "${archived.slug}").`,
      },
    });
    res.json({ ok: true, locator: archived });
  } catch (err) {
    const status = err?.status || 400;
    res.status(status).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.post("/locators/:id/reactivate", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    await scopedLocator(req, id);
    const loc = locatorsSvc.reactivate(id);
    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: auditRequest(req),
      action: "LOCATE_LOCATOR_REACTIVATED",
      targetType: "locator",
      targetId: id,
      details: {
        kind: "live",
        title: loc.title,
        slug: loc.slug,
        summary: `Reactivated locator "${loc.title}" (slug "${loc.slug}").`,
      },
    });
    res.json({ ok: true, locator: loc });
  } catch (err) {
    const status = err?.status || 400;
    res.status(status).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.delete("/locators/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const before = await scopedLocator(req, id);
    locatorCot.publishDelete(before).catch(() => {});
    locatorsSvc.permanentDelete(id);
    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: auditRequest(req),
      action: "LOCATE_LOCATOR_DELETED",
      targetType: "locator",
      targetId: id,
      details: {
        kind: "live",
        title: before?.title,
        slug: before?.slug,
        summary: before
          ? `Permanently deleted locator "${before.title}" (slug "${before.slug}").`
          : `Permanently deleted locator id ${id}.`,
      },
    });
    res.json({ ok: true });
  } catch (err) {
    const status = err?.status || 400;
    res.status(status).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.post("/locators/:id/manual-ping", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const loc = await scopedLocator(req, id);
    if (loc.archived) {
      return res.status(404).json({ ok: false, error: "Locator not found." });
    }
    locatorsSvc.addManualOperatorPing(id);
    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: auditRequest(req),
      action: "LOCATE_MANUAL_PING_REQUESTED",
      targetType: "locator",
      targetId: id,
      details: {
        kind: "live",
        title: loc.title,
        slug: loc.slug,
        summary: `Requested a manual ping for locator "${loc.title}" (slug "${loc.slug}").`,
      },
    });
    res.json({ ok: true });
  } catch (err) {
    const status = err?.status || 500;
    res.status(status).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.get("/locators/:id/history", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    await scopedLocator(req, id);
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit || "200"), 10) || 200));
    const history = locatorsSvc.listHistory(id, { limit });
    res.json({ ok: true, history });
  } catch (err) {
    const status = err?.status || 500;
    res.status(status).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.get("/locators/:id/report.pdf", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const loc = await scopedLocator(req, id);
    const history = locatorsSvc.listHistory(id, { limit: 5000 });
    const { buffer, fileName } = await locatorReport.generateLocatorReportPdf(loc, history);
    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: auditRequest(req),
      action: "LOCATE_REPORT_GENERATED",
      targetType: "locator",
      targetId: id,
      details: {
        kind: "live",
        title: loc.title,
        slug: loc.slug,
        pingCount: history.length,
        summary: `Generated a PDF after-action report for locator "${loc.title}" (${history.length} history row(s)).`,
      },
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(buffer);
  } catch (err) {
    const status = err?.status || 500;
    res.status(status).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.post("/locators/:id/send-link-email", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const loc = await scopedLocator(req, id);
    if (loc.archived) {
      return res.status(404).json({ ok: false, error: "Locator not found." });
    }
    if (!isEmailConfigured()) {
      return res.status(400).json({ ok: false, error: "Email is not configured." });
    }
    const parsed = parseRecipientEmails(req.body?.recipients ?? req.body?.to ?? "");
    if (parsed.error) {
      return res.status(400).json({ ok: false, error: parsed.error });
    }
    const url = buildPublicLocateUrl(req, loc.slug);
    const subject = "Share your location";
    const message = `Please open this link on your phone to share your location with responders:\n\n${url}\n`;
    const escapeHtml = (s) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    const messageBody = escapeHtml(message).replace(/\n/g, "<br>");
    const html = renderTemplate("bulk_email.html", { subject, messageBody });
    const text = htmlToText(html);
    const result = await emailSvc.sendMail({
      to: parsed.emails.join(","),
      subject,
      text,
      html,
    });
    if (!result.sent) {
      return res.status(result.skipped ? 400 : 500).json({
        ok: false,
        error: result.error || "Email send failed",
      });
    }
    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: auditRequest(req),
      action: "LOCATE_LINK_EMAIL_SENT",
      targetType: "locator",
      targetId: id,
      details: {
        kind: "live",
        locatorTitle: loc.title,
        slug: loc.slug,
        recipientCount: parsed.emails.length,
        summary: `Emailed the public locate link to ${parsed.emails.length} recipient(s) for locator "${loc.title}".`,
      },
    });
    res.json({ ok: true, count: parsed.emails.length });
  } catch (err) {
    const status = err?.status || 500;
    res.status(status).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.post("/locators/:id/send-link-sms", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const loc = await scopedLocator(req, id);
    if (loc.archived) {
      return res.status(404).json({ ok: false, error: "Locator not found." });
    }
    if (!smsSvc.isSmsConfigured()) {
      return res.status(503).json({ ok: false, error: "SMS is not configured." });
    }
    const parsed = smsSvc.parsePhoneList(req.body?.phones ?? req.body?.numbers ?? "");
    if (parsed.error) {
      return res.status(400).json({ ok: false, error: parsed.error });
    }
    const url = buildPublicLocateUrl(req, loc.slug);
    const text = `Please open this link on your phone to share your location with responders:\n\n${url}`;
    for (const phone of parsed.phones) {
      const out = await smsSvc.sendSmsFromSettings(phone, text);
      if (!out.ok) {
        return res.status(500).json({ ok: false, error: out.error || "SMS send failed" });
      }
    }
    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: auditRequest(req),
      action: "LOCATE_LINK_SMS_SENT",
      targetType: "locator",
      targetId: id,
      details: {
        kind: "live",
        locatorTitle: loc.title,
        slug: loc.slug,
        recipientCount: parsed.phones.length,
        summary: `Sent the public locate link by SMS to ${parsed.phones.length} phone number(s) for locator "${loc.title}".`,
      },
    });
    res.json({ ok: true, count: parsed.phones.length });
  } catch (err) {
    const status = err?.status || 500;
    res.status(status).json({ ok: false, error: toSafeApiError(err) });
  }
});

module.exports = router;
module.exports.buildPublicLocateUrl = buildPublicLocateUrl;
