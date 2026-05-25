const authentik = require("./authentik");
const accessSvc = require("./access.service");
const emailSvc = require("./email.service");
const mouService = require("./mouService");
const auditSvc = require("./auditLog.service");
const {
  renderTemplate,
  htmlToText,
} = require("./emailTemplates.service");
const {
  getBool,
  getInt,
  getString,
} = require("./env");

const DEFAULT_SWEEP_HOURS = 6;
let sweepTimer = null;

function getPortalBaseUrl() {
  return String(getString("TAK_PORTAL_PUBLIC_URL", "") || "").trim().replace(/\/+$/, "");
}

function reminderSweepMs() {
  const hours = getInt("MOU_REMINDER_SWEEP_HOURS", DEFAULT_SWEEP_HOURS);
  const normalized = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_SWEEP_HOURS;
  return normalized * 60 * 60 * 1000;
}

async function getUsersInGroup(groupName) {
  if (!groupName) return [];

  const groupResp = await authentik.get(
    `/core/groups/?name=${encodeURIComponent(groupName)}`
  );
  const group = groupResp.data?.results?.[0];
  if (!group) return [];

  const groupPk = group.pk;
  const users = [];
  let next = "/core/users/?page_size=200";
  while (next) {
    const resp = await authentik.get(next);
    const data = resp.data || {};
    users.push(...(Array.isArray(data.results) ? data.results : []));
    next = data.next ? data.next.replace(/^.*\/api\/v3/, "") : null;
  }

  return users.filter((user) =>
    Array.isArray(user.groups) &&
    user.groups.includes(groupPk) &&
    user.email
  );
}

async function getAgencyAdminUsers(agency) {
  const seen = new Set();
  const out = [];
  const groupNames = accessSvc.getAllAgencyAdminGroupNames(agency);
  for (const groupName of groupNames) {
    const users = await getUsersInGroup(groupName);
    for (const user of users) {
      const key = String(user.email || "").trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(user);
    }
  }
  return out;
}

async function sendAgencyAdminEmail({ agency, subject, html, text }) {
  const users = await getAgencyAdminUsers(agency);
  const recipients = users
    .map((user) => String(user.email || "").trim())
    .filter(Boolean);
  if (!recipients.length) {
    return { sent: false, skipped: true, reason: "No agency admin recipients found." };
  }
  return emailSvc.sendMail({
    to: recipients.join(","),
    subject,
    html,
    text,
  });
}

async function sendDeployNotificationsForVersion({ stream, version, actor }) {
  if (!getBool("EMAIL_ENABLED", false)) {
    return { sent: 0, skipped: true };
  }

  const baseUrl = getPortalBaseUrl();
  let sent = 0;

  for (const agency of mouService.getTargetAgenciesForStream(stream)) {
    const agencySuffix = String(agency?.suffix || "").trim().toLowerCase();
    if (!agencySuffix) continue;
    const signUrl = baseUrl
      ? `${baseUrl}/mou/sign/${encodeURIComponent(stream.mouId)}/${encodeURIComponent(version.version)}`
      : "";
    const html = renderTemplate("mou_deployed_to_agencies.html", {
      mouTitle: stream.title,
      version: version.version,
      agencyName: agency.name || agency.groupPrefix || agency.suffix,
      signUrl,
      operatorName: actor?.displayName || actor?.username || "TAK Portal",
      portalBaseUrl: baseUrl,
    });
    const text = htmlToText(html);
    const result = await sendAgencyAdminEmail({
      agency,
      subject: `TAK Portal MOU Deployed - ${stream.title} (v${version.version})`,
      html,
      text,
    });
    if (result.sent) {
      sent += 1;
      auditSvc.logEvent({
        actor: actor || null,
        action: "MOU_DEPLOY_NOTIFICATION_SENT",
        targetType: "mou",
        targetId: String(stream.mouId),
        agencySuffix: agencySuffix,
        details: {
          mouId: stream.mouId,
          version: version.version,
          agencyName: agency.name || agencySuffix,
        },
      });
    } else if (!result.skipped) {
      auditSvc.logEvent({
        actor: actor || null,
        action: "MOU_EMAIL_FAILURE",
        targetType: "mou",
        targetId: String(stream.mouId),
        agencySuffix: agencySuffix,
        details: {
          mouId: stream.mouId,
          version: version.version,
          agencyName: agency.name || agencySuffix,
          error: result.error || "Failed to send deploy notification.",
        },
      });
    }
  }

  return { sent, skipped: false };
}

function shouldSendReminder(row) {
  if (!row.lastReminderSentAt) return true;
  const lastMs = new Date(row.lastReminderSentAt).getTime();
  if (!Number.isFinite(lastMs)) return true;
  const elapsedMs = Date.now() - lastMs;
  return elapsedMs >= row.reminderDays * 24 * 60 * 60 * 1000;
}

async function runReminderSweep() {
  if (!mouService.isEnabled() || !getBool("EMAIL_ENABLED", false)) {
    return { sent: 0, skipped: true };
  }

  const baseUrl = getPortalBaseUrl();
  let sent = 0;
  for (const row of mouService.getAgencyReminderRows()) {
    if (!shouldSendReminder(row)) continue;
    const agency = mouService.getAgencyBySuffix(row.agencyId);
    if (!agency) continue;

    const signUrl = baseUrl
      ? `${baseUrl}/mou/sign/${encodeURIComponent(row.mouId)}/${encodeURIComponent(row.deployedVersion)}`
      : "";
    const html = renderTemplate("mou_reminder_agency.html", {
      mouTitle: row.mouTitle,
      version: row.deployedVersion,
      agencyName: row.agencyName,
      signUrl,
    });
    const text = htmlToText(html);
    const result = await sendAgencyAdminEmail({
      agency,
      subject: `Reminder: MOU signature required - ${row.mouTitle} (v${row.deployedVersion})`,
      html,
      text,
    });
    if (result.sent) {
      const sentAt = new Date().toISOString();
      mouService.markAgencyReminderSent({
        mouId: row.mouId,
        agencyId: row.agencyId,
        version: row.deployedVersion,
        sentAt,
      });
      sent += 1;
      auditSvc.logEvent({
        actor: null,
        action: "MOU_REMINDER_SENT",
        targetType: "mou",
        targetId: String(row.mouId),
        agencySuffix: row.agencyId,
        details: {
          mouId: row.mouId,
          version: row.deployedVersion,
          agencyName: row.agencyName,
          sentAt,
        },
      });
    }
  }

  return { sent, skipped: false };
}

function startScheduler() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  if (!mouService.isEnabled()) {
    return;
  }
  sweepTimer = setInterval(() => {
    runReminderSweep().catch((err) => {
      console.warn("[mou-scheduler] reminder sweep failed:", err?.message || err);
    });
  }, reminderSweepMs());
}

module.exports = {
  sendDeployNotificationsForVersion,
  runReminderSweep,
  startScheduler,
};
