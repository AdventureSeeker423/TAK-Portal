const router = require("express").Router();
const locateConfig = require("../services/locateConfig.service");
const locatorsSvc = require("../services/locators.service");
const dataSyncSvc = require("../services/dataSync.service");
const groupsSvc = require("../services/groups.service");
const accessSvc = require("../services/access.service");
const emailSvc = require("../services/email.service");
const auditSvc = require("../services/auditLog.service");
const { renderTemplate, htmlToText } = require("../services/emailTemplates.service");
const { toSafeApiError } = require("../services/apiErrorPayload.service");
const smsSvc = require("../services/sms.service");
const settingsSvc = require("../services/settings.service");
const { getString } = require("../services/env");

const EMAIL_RE = /^\S+@\S+\.[A-Za-z]{2,}$/;

/** Public share URL for /locate/:slug — prefers TAK_PORTAL_PUBLIC_URL (required for CloudTAK bridge). */
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

function unwrapPagedMissions(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

/** Short display names (strip tak_) from TAK mission GET payload — same idea as Data Sync UI. */
function extractMissionGroupShortNamesSorted(takPayload) {
  let m = takPayload;
  if (m && Array.isArray(m.data) && m.data.length && typeof m.data[0] === "object") {
    m = m.data[0];
  } else if (m && typeof m.data === "object" && m.data != null && !Array.isArray(m.data)) {
    m = m.data;
  }
  if (m && m.Mission && typeof m.Mission === "object") m = m.Mission;
  const arr = m && Array.isArray(m.groups) ? m.groups : [];
  const shorts = new Set();
  for (const g of arr) {
    const full = typeof g === "string" ? g : g && g.name != null ? String(g.name) : "";
    const t = String(full || "").trim();
    if (!t) continue;
    const short = t.toLowerCase().startsWith("tak_") ? t.slice(4) : t;
    if (short) shorts.add(short);
  }
  return Array.from(shorts).sort((a, b) => a.localeCompare(b));
}

function groupAllowedForMission(shortName, allowedShorts) {
  const s = String(shortName || "").trim();
  if (!s) return false;
  const sl = s.toLowerCase();
  return allowedShorts.some((x) => String(x || "").trim().toLowerCase() === sl);
}

function stripTakPrefix(name) {
  const n = String(name || "").trim();
  if (n.toLowerCase().startsWith("tak_")) return n.slice(4);
  return n;
}

function isTakUpstreamNotFound(err) {
  const st = err?.response?.status;
  return st === 404 || st === 410;
}

/** TAK channel groups (short names) for Locate — does not require page.groups. */
router.get("/tak-channel-groups", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const all = await groupsSvc.getGroupsForAuthUser(authUser);
    const filtered = accessSvc.filterGroupsForUser(authUser, all);
    const shorts = filtered
      .map((g) => stripTakPrefix(g?.name))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    res.json({ ok: true, groups: shorts });
  } catch (err) {
    const code = err?.code;
    if (code === "TAK_NOT_CONFIGURED" || code === "TAK_BYPASS") {
      return res.json({ ok: true, groups: [], takUnavailable: true });
    }
    console.warn("[locate] tak-channel-groups failed:", err?.message || err);
    res.json({ ok: true, groups: [], warning: toSafeApiError(err) });
  }
});

/** Groups with access to a mission (short names, A–Z) — for locate Data Sync mode group dropdown. */
router.get("/mission-groups/:missionName", async (req, res) => {
  try {
    const name = String(req.params.missionName || "").trim();
    if (!name) {
      return res.status(400).json({ ok: false, error: "Mission name is required." });
    }
    const raw = await dataSyncSvc.getMission(name);
    const groups = extractMissionGroupShortNamesSorted(raw);
    res.json({ ok: true, groups });
  } catch (err) {
    const code = err?.code;
    if (code === "TAK_NOT_CONFIGURED" || code === "TAK_BYPASS") {
      return res.json({ ok: true, groups: [], takUnavailable: true });
    }
    if (isTakUpstreamNotFound(err)) {
      const missionLabel = String(req.params.missionName || "").trim() || "unknown";
      return res.json({
        ok: true,
        groups: [],
        missionNotFound: true,
        warning: `Mission "${missionLabel}" was not found on the TAK Server (it may have been renamed or removed).`,
      });
    }
    res.status(500).json({ ok: false, error: toSafeApiError(err) });
  }
});

/** Data Sync missions with tool=public (for locate CoreConfig mission dropdown), A–Z by name. */
router.get("/data-sync-missions", async (req, res) => {
  try {
    const data = await dataSyncSvc.listMissions({});
    const list = unwrapPagedMissions(data);
    const publicOnes = list.filter((m) => {
      const t = m && m.tool != null ? String(m.tool).toLowerCase().trim() : "";
      return t === "public";
    });
    publicOnes.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    const missions = publicOnes
      .map((m) => ({ name: String(m.name || "").trim() }))
      .filter((x) => x.name);
    res.json({ ok: true, missions });
  } catch (err) {
    const code = err?.code;
    if (code === "TAK_NOT_CONFIGURED" || code === "TAK_BYPASS") {
      return res.json({ ok: true, missions: [], takUnavailable: true });
    }
    if (isTakUpstreamNotFound(err)) {
      return res.json({
        ok: true,
        missions: [],
        warning: "TAK mission list API returned not found; check TAK_URL and Marti API path.",
      });
    }
    console.warn("[locate] data-sync-missions failed:", err?.message || err);
    res.json({ ok: true, missions: [], warning: toSafeApiError(err) });
  }
});

router.get("/config", async (req, res) => {
  try {
    const ssh = locateConfig.isSshConfigured();
    if (!ssh.configured) {
      return res.json({
        ok: true,
        sshConfigured: false,
        mode: "disabled",
        enabled: false,
        group: "",
        mission: "",
      });
    }
    const xml = await locateConfig.readRemoteCoreConfigXml();
    const parsed = locateConfig.parseLocateFromXml(xml);
    let mode = "disabled";
    if (!parsed.enabled) {
      mode = "disabled";
    } else if (parsed.addToMission && String(parsed.mission || "").trim()) {
      mode = "data_sync";
    } else {
      mode = "group_only";
    }
    res.json({
      ok: true,
      sshConfigured: true,
      mode,
      enabled: parsed.enabled,
      group: parsed.group || "",
      mission: parsed.mission || "",
      addToMission: !!parsed.addToMission,
    });
  } catch (err) {
    const ssh = locateConfig.isSshConfigured();
    console.warn("[locate] config load failed:", err?.message || err);
    res.status(500).json({
      ok: false,
      error: toSafeApiError(err),
      sshConfigured: !!ssh.configured,
      hint: ssh.configured
        ? "SSH is configured but reading CoreConfig.xml failed. Check Server Settings SSH setup and sudo access."
        : "Configure SSH under Server Settings before loading locate configuration from the TAK Server.",
    });
  }
});

router.post("/apply", async (req, res) => {
  try {
    const mode = String(req.body?.mode ?? "").trim();
    const group = String(req.body?.group ?? "").trim();
    const mission = String(req.body?.mission ?? "").trim();

    if (mode === "disabled" || !mode) {
      const out = await locateConfig.applyLocateConfiguration({
        enabled: false,
        groupDisplayName: "",
        missionName: "",
      });
      const authUser = req.authentikUser || null;
      auditSvc.logEvent({
        actor: authUser,
        request: auditRequest(req),
        action: "LOCATE_TAK_CORE_CONFIG_APPLIED",
        targetType: "locate_config",
        targetId: "tak-coreconfig-locate",
        details: {
          locateMode: "disabled",
          locateEnabled: false,
          takServerRestartInitiated: true,
          summary:
            "Locate was disabled on the TAK Server: the locate block was removed from CoreConfig.xml over SSH and a TAK Server restart was started.",
        },
      });
      return res.json({ ok: true, ...out });
    }

    if (mode === "group_only") {
      if (!group) {
        return res.status(400).json({
          ok: false,
          error: "Select a notification group for Enabled — Group only.",
        });
      }
      const out = await locateConfig.applyLocateConfiguration({
        enabled: true,
        groupDisplayName: group,
        missionName: "",
      });
      const authUser = req.authentikUser || null;
      auditSvc.logEvent({
        actor: authUser,
        request: auditRequest(req),
        action: "LOCATE_TAK_CORE_CONFIG_APPLIED",
        targetType: "locate_config",
        targetId: "tak-coreconfig-locate",
        details: {
          locateMode: "group_only",
          locateEnabled: true,
          takNotifyGroup: group,
          takServerRestartInitiated: true,
          summary: `Locate enabled (group only) for notifications to group "${group}". CoreConfig.xml was updated over SSH and a TAK Server restart was started.`,
        },
      });
      return res.json({ ok: true, ...out });
    }

    if (mode === "data_sync") {
      if (!mission) {
        return res.status(400).json({
          ok: false,
          error: "Select a Data Sync mission.",
        });
      }
      if (!group) {
        return res.status(400).json({
          ok: false,
          error: "Select a notification group for that mission.",
        });
      }
      let allowed;
      try {
        const raw = await dataSyncSvc.getMission(mission);
        allowed = extractMissionGroupShortNamesSorted(raw);
      } catch (err) {
        return res.status(400).json({
          ok: false,
          error: `Could not load mission from TAK: ${toSafeApiError(err)}`,
        });
      }
      if (!allowed.length) {
        return res.status(400).json({
          ok: false,
          error: "That mission has no groups assigned in TAK; add groups to the mission on Data Sync first.",
        });
      }
      if (!groupAllowedForMission(group, allowed)) {
        return res.status(400).json({
          ok: false,
          error: "Selected group does not have access to that Data Sync mission.",
        });
      }
      const out = await locateConfig.applyLocateConfiguration({
        enabled: true,
        groupDisplayName: group,
        missionName: mission,
      });
      const authUser = req.authentikUser || null;
      auditSvc.logEvent({
        actor: authUser,
        request: auditRequest(req),
        action: "LOCATE_TAK_CORE_CONFIG_APPLIED",
        targetType: "locate_config",
        targetId: "tak-coreconfig-locate",
        details: {
          locateMode: "data_sync",
          locateEnabled: true,
          takNotifyGroup: group,
          takNotifyDataSyncMission: mission,
          takServerRestartInitiated: true,
          summary: `Locate enabled with Data Sync mission "${mission}" and notifications to group "${group}". CoreConfig.xml was updated over SSH and a TAK Server restart was started.`,
        },
      });
      return res.json({ ok: true, ...out });
    }

    return res.status(400).json({ ok: false, error: "Invalid locate mode." });
  } catch (err) {
    res.status(500).json({ ok: false, error: toSafeApiError(err) });
  }
});

// ---- Missing-person locators (admin) ----

router.get("/locators", async (req, res) => {
  try {
    const locators = locatorsSvc.listLocatorsForAdmin();
    res.json({ ok: true, locators });
  } catch (err) {
    res.status(500).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.post("/locators", async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim();
    const pingIntervalSeconds = req.body?.pingIntervalSeconds;
    const loc = locatorsSvc.create({ title, pingIntervalSeconds });
    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: auditRequest(req),
      action: "LOCATE_LOCATOR_CREATED",
      targetType: "locator",
      targetId: loc.id,
      details: {
        title: loc.title,
        slug: loc.slug,
        pingIntervalSeconds: loc.pingIntervalSeconds,
        summary:
          loc.pingIntervalSeconds === 0
            ? `Created missing-person locator "${loc.title}" (public slug "${loc.slug}", one-time ping).`
            : `Created missing-person locator "${loc.title}" (public slug "${loc.slug}", ping every ${loc.pingIntervalSeconds}s).`,
      },
    });
    res.json({ ok: true, locator: loc });
  } catch (err) {
    res.status(400).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.patch("/locators/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const before = locatorsSvc.getById(id);
    const loc = locatorsSvc.update(id, {
      title: req.body?.title,
      pingIntervalSeconds: req.body?.pingIntervalSeconds,
      active: req.body?.active,
    });
    const changes = [];
    if (before && before.title !== loc.title) {
      changes.push(`title "${before.title}" → "${loc.title}"`);
    }
    if (
      before &&
      Number(before.pingIntervalSeconds) !== Number(loc.pingIntervalSeconds)
    ) {
      changes.push(
        `ping interval ${before.pingIntervalSeconds}s → ${loc.pingIntervalSeconds}s`
      );
    }
    if (before && !!before.active !== !!loc.active) {
      changes.push(`active ${before.active} → ${loc.active}`);
    }
    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: auditRequest(req),
      action: "LOCATE_LOCATOR_UPDATED",
      targetType: "locator",
      targetId: id,
      details: {
        slug: loc.slug,
        title: loc.title,
        pingIntervalSeconds: loc.pingIntervalSeconds,
        active: loc.active,
        previousTitle: before?.title,
        previousPingIntervalSeconds: before?.pingIntervalSeconds,
        previousActive: before?.active,
        summary:
          changes.length > 0
            ? `Updated locator "${loc.title}" (${loc.slug}): ${changes.join("; ")}.`
            : `Saved locator "${loc.title}" (${loc.slug}) with no effective field changes.`,
      },
    });
    res.json({ ok: true, locator: loc });
  } catch (err) {
    res.status(400).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.post("/locators/:id/archive", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const loc = locatorsSvc.archive(id);
    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: auditRequest(req),
      action: "LOCATE_LOCATOR_ARCHIVED",
      targetType: "locator",
      targetId: id,
      details: {
        title: loc.title,
        slug: loc.slug,
        summary: `Archived locator "${loc.title}" (slug "${loc.slug}"). The public link is treated as inactive/archived.`,
      },
    });
    res.json({ ok: true, locator: loc });
  } catch (err) {
    res.status(400).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.post("/locators/:id/reactivate", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const loc = locatorsSvc.reactivate(id);
    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: auditRequest(req),
      action: "LOCATE_LOCATOR_REACTIVATED",
      targetType: "locator",
      targetId: id,
      details: {
        title: loc.title,
        slug: loc.slug,
        summary: `Reactivated locator "${loc.title}" (slug "${loc.slug}") from archived state.`,
      },
    });
    res.json({ ok: true, locator: loc });
  } catch (err) {
    res.status(400).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.delete("/locators/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const before = locatorsSvc.getById(id);
    locatorsSvc.permanentDelete(id);
    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: auditRequest(req),
      action: "LOCATE_LOCATOR_DELETED",
      targetType: "locator",
      targetId: id,
      details: {
        title: before?.title,
        slug: before?.slug,
        summary: before
          ? `Permanently deleted locator "${before.title}" (slug "${before.slug}") and its stored ping history.`
          : `Permanently deleted locator id ${id} and its stored ping history.`,
      },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.post("/locators/:id/manual-ping", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const loc = locatorsSvc.getById(id);
    if (!loc || loc.archived) {
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
        title: loc.title,
        slug: loc.slug,
        summary: `Requested a manual ping for locator "${loc.title}" (slug "${loc.slug}"); devices with the page open should send a location update soon.`,
      },
    });
    res.json({ ok: true, message: "Devices with this link open will send a location update soon." });
  } catch (err) {
    res.status(500).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.get("/locators/:id/history", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const loc = locatorsSvc.getById(id);
    if (!loc) {
      return res.status(404).json({ ok: false, error: "Locator not found." });
    }
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit || "200"), 10) || 200));
    const history = locatorsSvc.listHistory(id, { limit });
    res.json({ ok: true, history });
  } catch (err) {
    res.status(500).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.post("/locators/:id/send-link-email", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const loc = locatorsSvc.getById(id);
    if (!loc || loc.archived) {
      return res.status(404).json({ ok: false, error: "Locator not found." });
    }

    const parsed = parseRecipientEmails(req.body?.recipients ?? req.body?.to ?? "");
    if (parsed.error) {
      return res.status(400).json({ ok: false, error: parsed.error });
    }
    const emails = parsed.emails;

    const emailCfg = emailSvc.getSmtpConfig();
    if (!emailSvc.isEmailEnabled() || !emailCfg.host || !emailCfg.from) {
      return res.status(400).json({
        ok: false,
        error: "Email is disabled or SMTP is not configured.",
      });
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
      to: emails.join(","),
      subject,
      text,
      html,
    });

    if (!result.sent) {
      if (result.skipped) {
        return res.status(400).json({
          ok: false,
          error: "Email is disabled (EMAIL_ENABLED=false)",
        });
      }
      return res.status(500).json({
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
        locatorTitle: loc.title,
        slug: loc.slug,
        recipientCount: emails.length,
        summary: `Emailed the public locate link to ${emails.length} recipient(s) for locator "${loc.title}" (slug "${loc.slug}").`,
      },
    });

    res.json({ ok: true, count: emails.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.post("/locators/:id/send-link-sms", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const loc = locatorsSvc.getById(id);
    if (!loc || loc.archived) {
      return res.status(404).json({ ok: false, error: "Locator not found." });
    }

    const parsed = smsSvc.parsePhoneList(req.body?.phones ?? req.body?.numbers ?? "");
    if (parsed.error) {
      return res.status(400).json({ ok: false, error: parsed.error });
    }

    if (!smsSvc.isSmsConfigured()) {
      return res.status(503).json({
        ok: false,
        error:
          "SMS is not configured. Choose Twilio or Brevo and add credentials under Server Settings → SMS.",
      });
    }

    const url = buildPublicLocateUrl(req, loc.slug);
    const text = `Please open this link on your phone to share your location with responders:\n\n${url}`;

    for (const phone of parsed.phones) {
      const out = await smsSvc.sendSmsFromSettings(phone, text);
      if (!out.ok) {
        return res.status(500).json({
          ok: false,
          error: out.error || "SMS send failed",
        });
      }
    }

    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: auditRequest(req),
      action: "LOCATE_LINK_SMS_SENT",
      targetType: "locator",
      targetId: id,
      details: {
        locatorTitle: loc.title,
        slug: loc.slug,
        recipientCount: parsed.phones.length,
        summary: `Sent the public locate link by SMS to ${parsed.phones.length} phone number(s) for locator "${loc.title}" (slug "${loc.slug}").`,
      },
    });

    res.json({ ok: true, count: parsed.phones.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: toSafeApiError(err) });
  }
});

module.exports = router;
