const authentik = require("./authentik");
const accessSvc = require("./access.service");
const emailSvc = require("./email.service");
const mouService = require("./mouService");
const auditSvc = require("./auditLog.service");
const usersSvc = require("./users.service");
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

function shouldSendMouEmails() {
  return getBool("EMAIL_ENABLED", false) && getBool("MOU_SEND_EMAILS", true);
}

function buildMouPortalBlock(baseUrl) {
  const portalMouUrl = baseUrl ? `${baseUrl}/mou` : "";
  return usersSvc.buildTakPortalBlock({
    takPortalPublicUrl: portalMouUrl,
    introHtml:
      "To review and sign pending agency documents, use the button below to open TAK Portal.",
    buttonText: "Open TAK Portal",
    elseHtml:
      "To review and sign pending agency documents, open TAK Portal and navigate to MOU / Documents.",
  });
}

function getPortalBaseUrl() {
  return String(getString("TAK_PORTAL_PUBLIC_URL", "") || "").trim().replace(/\/+$/, "");
}

function reminderSweepMs() {
  const hours = getInt("MOU_REMINDER_SWEEP_HOURS", DEFAULT_SWEEP_HOURS);
  const normalized = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_SWEEP_HOURS;
  return normalized * 60 * 60 * 1000;
}

function parseConfiguredGroupNames(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[;,]/)
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
}

async function resolveGroupByName(groupName) {
  const name = String(groupName || "").trim();
  if (!name) return null;

  try {
    const groupResp = await authentik.get(
      `/core/groups/?name=${encodeURIComponent(name)}`
    );
    const results = Array.isArray(groupResp.data?.results)
      ? groupResp.data.results
      : [];
    const exact = results.find(
      (group) =>
        String(group?.name || "").trim().toLowerCase() === name.toLowerCase()
    );
    if (exact) return exact;
  } catch (err) {
    console.warn(
      "[mou-scheduler] group lookup by name failed:",
      name,
      err?.message || err
    );
  }

  try {
    const searchResp = await authentik.get(
      `/core/groups/?search=${encodeURIComponent(name)}`
    );
    const results = Array.isArray(searchResp.data?.results)
      ? searchResp.data.results
      : [];
    return (
      results.find(
        (group) =>
          String(group?.name || "").trim().toLowerCase() === name.toLowerCase()
      ) || null
    );
  } catch (err) {
    console.warn(
      "[mou-scheduler] group search lookup failed:",
      name,
      err?.message || err
    );
    return null;
  }
}

async function getUsersInGroupByPk(groupPk) {
  const gid = String(groupPk || "").trim();
  if (!gid) return [];

  const users = [];
  const pageSize = 200;
  let page = 1;
  let url =
    `/core/users/?page=${page}&page_size=${pageSize}` +
    `&groups_by_pk=${encodeURIComponent(gid)}` +
    "&include_groups=false&include_roles=false";

  while (url) {
    const resp = await authentik.get(url);
    const data = resp.data || {};
    users.push(...(Array.isArray(data.results) ? data.results : []));

    const pagination = data.pagination || {};
    if (pagination && pagination.next) {
      page = pagination.next;
      url =
        `/core/users/?page=${page}&page_size=${pageSize}` +
        `&groups_by_pk=${encodeURIComponent(gid)}` +
        "&include_groups=false&include_roles=false";
    } else if (data.next) {
      url = data.next.replace(/^.*\/api\/v3/, "");
    } else {
      url = null;
    }
  }

  return users;
}

async function fetchUsersFromGroupMembershipList(group) {
  const groupPk = String(group?.pk || group?.id || "").trim();
  if (!groupPk) return [];

  let memberRefs = Array.isArray(group?.users) ? group.users : [];
  if (!memberRefs.length) {
    try {
      const detailResp = await authentik.get(`/core/groups/${encodeURIComponent(groupPk)}/`);
      const detail = detailResp.data || {};
      memberRefs = Array.isArray(detail.users) ? detail.users : [];
    } catch (err) {
      console.warn(
        "[mou-scheduler] group detail lookup failed:",
        groupPk,
        err?.message || err
      );
      return [];
    }
  }

  const memberPks = Array.from(
    new Set(
      memberRefs
        .map((entry) => {
          if (entry && typeof entry === "object") {
            return String(entry.pk || entry.id || "").trim();
          }
          return String(entry || "").trim();
        })
        .filter(Boolean)
    )
  );
  if (!memberPks.length) return [];

  const users = [];
  for (const memberPk of memberPks) {
    try {
      const userResp = await authentik.get(`/core/users/${encodeURIComponent(memberPk)}/`);
      if (userResp?.data) users.push(userResp.data);
    } catch (err) {
      console.warn(
        "[mou-scheduler] group member user lookup failed:",
        memberPk,
        err?.message || err
      );
    }
  }
  return users;
}

async function getUsersForConfiguredGroup(groupName) {
  const group = await resolveGroupByName(groupName);
  if (!group?.pk) {
    return { groupName, group: null, users: [] };
  }

  let users = await getUsersInGroupByPk(group.pk);
  if (!users.length) {
    users = await fetchUsersFromGroupMembershipList(group);
  }

  return {
    groupName,
    group,
    users: Array.isArray(users) ? users : [],
  };
}

async function getUsersInGroup(groupName) {
  const result = await getUsersForConfiguredGroup(groupName);
  return result.users.filter((user) => String(user.email || "").trim());
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

async function getGlobalAdminRecipientLookup() {
  const configuredGroupNames = parseConfiguredGroupNames(
    getString("PORTAL_AUTH_REQUIRED_GROUP", "")
  );
  const resolvedGroups = [];
  const seenEmail = new Set();
  const users = [];

  for (const groupName of configuredGroupNames) {
    const result = await getUsersForConfiguredGroup(groupName);
    if (result.group?.pk) {
      resolvedGroups.push({
        name: result.groupName,
        pk: String(result.group.pk),
        memberCount: result.users.length,
      });
    }
    for (const user of result.users) {
      const email = String(user?.email || "").trim();
      const emailKey = email.toLowerCase();
      if (!email || seenEmail.has(emailKey)) continue;
      seenEmail.add(emailKey);
      users.push(user);
    }
  }

  return {
    configuredGroupNames,
    resolvedGroups,
    users,
  };
}

async function getGlobalAdminUsers() {
  const lookup = await getGlobalAdminRecipientLookup();
  return lookup.users;
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

async function sendGlobalAdminEmail({ subject, html, text }) {
  const lookup = await getGlobalAdminRecipientLookup();
  if (!lookup.configuredGroupNames.length) {
    return {
      sent: false,
      skipped: true,
      reason: "PORTAL_AUTH_REQUIRED_GROUP is not configured.",
    };
  }
  if (!lookup.resolvedGroups.length) {
    return {
      sent: false,
      skipped: true,
      reason:
        "Global admin group not found. Check PORTAL_AUTH_REQUIRED_GROUP matches an Authentik group name.",
    };
  }

  const recipients = lookup.users
    .map((user) => String(user.email || "").trim())
    .filter(Boolean);
  if (!recipients.length) {
    const memberCount = lookup.resolvedGroups.reduce(
      (sum, group) => sum + Number(group.memberCount || 0),
      0
    );
    console.warn("[mou-scheduler] global admin email recipients unavailable", {
      configuredGroups: lookup.configuredGroupNames,
      resolvedGroups: lookup.resolvedGroups,
      memberCount,
      recipientCount: recipients.length,
    });
    return {
      sent: false,
      skipped: true,
      reason:
        memberCount > 0
          ? "Global admin group members were found, but none have email addresses in Authentik."
          : "No users found in the configured global admin group(s).",
    };
  }
  return emailSvc.sendMail({
    to: recipients.join(","),
    subject,
    html,
    text,
  });
}

async function sendAssignmentNotificationForAgency({ stream, version, agency, actor }) {
  if (!shouldSendMouEmails()) {
    return { sent: false, skipped: true, reason: "MOU emails are disabled." };
  }
  const agencySuffix = String(agency?.suffix || "").trim().toLowerCase();
  if (!agencySuffix) {
    return { sent: false, skipped: true, reason: "Agency suffix was missing." };
  }
  if (mouService.getAgencySigningMode(stream, agencySuffix) === mouService.AGENCY_SIGNING_MODE_EXTERNAL_LINK) {
    return { sent: false, skipped: true, reason: "Agency uses external sign link." };
  }

  const baseUrl = getPortalBaseUrl();
  const takPortalBlock = buildMouPortalBlock(baseUrl);
  const html = renderTemplate("mou_document_updated_to_agencies.html", {
    mouTitle: stream.title,
    version: version.version,
    agencyName: agency.name || agency.groupPrefix || agency.suffix,
    operatorName: actor?.displayName || actor?.username || "TAK Portal",
    portalBaseUrl: baseUrl,
    takPortalBlock,
  });
  const text = htmlToText(html);
  const result = await sendAgencyAdminEmail({
    agency,
    subject: `TAK Portal MOU Updated - ${stream.title} (v${version.version})`,
    html,
    text,
  });
  return {
    ...result,
    agencySuffix,
  };
}

async function sendExternalSignInviteEmail({ stream, version, agency, invite, actor }) {
  if (!shouldSendMouEmails()) {
    return { sent: false, skipped: true, reason: "MOU emails are disabled." };
  }
  const recipient = String(invite?.recipientEmail || "").trim();
  if (!recipient) {
    return { sent: false, skipped: true, reason: "No recipient email configured." };
  }

  const baseUrl = getPortalBaseUrl();
  const signPath = mouService.buildExternalSignPath(invite.token);
  const signUrl = baseUrl ? `${baseUrl}${signPath}` : signPath;
  const html = renderTemplate("mou_external_sign_invite.html", {
    mouTitle: stream.title,
    version: version.version,
    agencyName: agency.name || agency.groupPrefix || agency.suffix,
    operatorName: actor?.displayName || actor?.username || "TAK Portal",
    signUrl,
    portalBaseUrl: baseUrl,
    emailHeading: "Document Signature Required",
  });
  const text = htmlToText(html);
  const result = await emailSvc.sendMail({
    to: recipient,
    subject: `Sign Required: ${stream.title} (v${version.version})`,
    html,
    text,
  });
  return {
    ...result,
    agencySuffix: String(agency?.suffix || "").trim().toLowerCase(),
  };
}

async function sendAssignmentNotificationsForVersion({ stream, version, actor }) {
  if (!shouldSendMouEmails()) {
    return { sent: 0, skipped: true };
  }

  let sent = 0;

  for (const agency of mouService.getTargetAgenciesForStream(stream)) {
    const agencySuffix = String(agency?.suffix || "").trim().toLowerCase();
    if (
      mouService.getAgencySigningMode(stream, agencySuffix) ===
      mouService.AGENCY_SIGNING_MODE_EXTERNAL_LINK
    ) {
      const invites = mouService.syncExternalSignInvitesForStream({
        stream,
        actor,
        agencySuffixes: [agencySuffix],
      });
      const invite = invites[0];
      if (invite?.recipientEmail) {
        const result = await sendExternalSignInviteEmail({
          stream,
          version,
          agency,
          invite,
          actor,
        });
        if (result.sent) {
          sent += 1;
          auditSvc.logEvent({
            actor: actor || null,
            action: "MOU_EXTERNAL_SIGN_INVITE_SENT",
            targetType: "mou",
            targetId: String(stream.mouId),
            agencySuffix,
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
            agencySuffix,
            details: {
              mouId: stream.mouId,
              version: version.version,
              agencyName: agency.name || agencySuffix,
              error: result.error || "Failed to send external sign invite.",
            },
          });
        }
      }
      continue;
    }

    const result = await sendAssignmentNotificationForAgency({
      stream,
      version,
      agency,
      actor,
    });
    const resolvedAgencySuffix = result.agencySuffix || agencySuffix;
    if (result.sent) {
      sent += 1;
      auditSvc.logEvent({
        actor: actor || null,
        action: "MOU_ASSIGNMENT_NOTIFICATION_SENT",
        targetType: "mou",
        targetId: String(stream.mouId),
        agencySuffix: resolvedAgencySuffix,
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
        agencySuffix: resolvedAgencySuffix,
        details: {
          mouId: stream.mouId,
          version: version.version,
          agencyName: agency.name || agencySuffix,
          error: result.error || "Failed to send document notification.",
        },
      });
    }
  }

  return { sent, skipped: false };
}

async function sendSignedNotificationToGlobalAdmins({
  stream,
  version,
  signature,
  signMethod,
}) {
  if (!shouldSendMouEmails()) {
    return { sent: false, skipped: true, reason: "MOU emails are disabled." };
  }

  const baseUrl = getPortalBaseUrl();
  const takPortalBlock = buildMouPortalBlock(baseUrl);
  const signMethodLabel =
    signMethod === "upload" || signMethod === "upload_admin"
      ? "Uploaded Signed Copy"
      : "E-Sign";
  const html = renderTemplate("mou_document_signed_to_global_admins.html", {
    mouTitle: stream?.title || "",
    version: version?.version || "",
    agencyName:
      signature?.agencyNameAtSign || signature?.agencyId || "Unknown Agency",
    signerDisplayName:
      signature?.attestationText || signature?.signerDisplayName || "Unknown Signer",
    signerRole: signature?.signerStatusAtSign || "Agency Administrator",
    signedAt: signature?.signedAt || "",
    signMethod: signMethodLabel,
    takPortalBlock,
  });
  const text = htmlToText(html);
  const result = await sendGlobalAdminEmail({
    subject: `TAK Portal Document Signed - ${stream?.title || "Document"} (v${version?.version || ""})`,
    html,
    text,
  });

  if (result.sent) {
    auditSvc.logEvent({
      actor: null,
      action: "MOU_SIGNED_NOTIFICATION_SENT",
      targetType: "mou",
      targetId: String(stream?.mouId || ""),
      agencySuffix: String(signature?.agencyId || "").trim().toLowerCase() || null,
      details: {
        mouId: stream?.mouId || "",
        version: version?.version || null,
        agencyName: signature?.agencyNameAtSign || signature?.agencyId || "",
        signerDisplayName:
          signature?.attestationText || signature?.signerDisplayName || "",
        signMethod: signMethodLabel,
      },
    });
  } else if (result.skipped) {
    console.warn(
      "[mou-scheduler] signed global admin notification skipped:",
      result.reason || "Unknown reason"
    );
    auditSvc.logEvent({
      actor: null,
      action: "MOU_SIGNED_NOTIFICATION_SKIPPED",
      targetType: "mou",
      targetId: String(stream?.mouId || ""),
      agencySuffix: String(signature?.agencyId || "").trim().toLowerCase() || null,
      details: {
        mouId: stream?.mouId || "",
        version: version?.version || null,
        agencyName: signature?.agencyNameAtSign || signature?.agencyId || "",
        reason: result.reason || "Notification skipped.",
      },
    });
  } else if (!result.skipped) {
    auditSvc.logEvent({
      actor: null,
      action: "MOU_EMAIL_FAILURE",
      targetType: "mou",
      targetId: String(stream?.mouId || ""),
      agencySuffix: String(signature?.agencyId || "").trim().toLowerCase() || null,
      details: {
        mouId: stream?.mouId || "",
        version: version?.version || null,
        agencyName: signature?.agencyNameAtSign || signature?.agencyId || "",
        error: result.error || "Failed to send signed document notification.",
      },
    });
  }

  return result;
}

function shouldSendReminder(row) {
  if (!row.lastReminderSentAt) return true;
  const lastMs = new Date(row.lastReminderSentAt).getTime();
  if (!Number.isFinite(lastMs)) return true;
  const elapsedMs = Date.now() - lastMs;
  return elapsedMs >= row.reminderDays * 24 * 60 * 60 * 1000;
}

async function runReminderSweep() {
  if (!mouService.isEnabled() || !shouldSendMouEmails()) {
    return { sent: 0, skipped: true };
  }

  const baseUrl = getPortalBaseUrl();
  let sent = 0;
  for (const row of mouService.getAgencyReminderRows()) {
    if (!shouldSendReminder(row)) continue;
    const agency = mouService.getAgencyBySuffix(row.agencyId);
    if (!agency) continue;

    if (row.signingMode === mouService.AGENCY_SIGNING_MODE_EXTERNAL_LINK) {
      const invite = mouService.getActiveSignInviteForAgency({
        mouId: row.mouId,
        agencyId: row.agencyId,
      });
      if (!invite?.recipientEmail) continue;
      const signPath = mouService.buildExternalSignPath(invite.token);
      const signUrl = baseUrl ? `${baseUrl}${signPath}` : signPath;
      const html = renderTemplate("mou_external_sign_invite.html", {
        mouTitle: row.mouTitle,
        version: row.currentVersion,
        agencyName: row.agencyName,
        operatorName: "TAK Portal",
        signUrl,
        portalBaseUrl: baseUrl,
        emailHeading: `Reminder: Document Signature Required`,
      });
      const text = htmlToText(html);
      const result = await emailSvc.sendMail({
        to: invite.recipientEmail,
        subject: `Reminder: MOU signature required - ${row.mouTitle} (v${row.currentVersion})`,
        html,
        text,
      });
      if (result.sent) {
        const sentAt = new Date().toISOString();
        mouService.markAgencyReminderSent({
          mouId: row.mouId,
          agencyId: row.agencyId,
          version: row.currentVersion,
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
            version: row.currentVersion,
            agencyName: row.agencyName,
            sentAt,
            externalLink: true,
          },
        });
      }
      continue;
    }

    const takPortalBlock = buildMouPortalBlock(baseUrl);
    const html = renderTemplate("mou_reminder_agency.html", {
      mouTitle: row.mouTitle,
      version: row.currentVersion,
      agencyName: row.agencyName,
      takPortalBlock,
    });
    const text = htmlToText(html);
    const result = await sendAgencyAdminEmail({
      agency,
      subject: `Reminder: MOU signature required - ${row.mouTitle} (v${row.currentVersion})`,
      html,
      text,
    });
    if (result.sent) {
      const sentAt = new Date().toISOString();
      mouService.markAgencyReminderSent({
        mouId: row.mouId,
        agencyId: row.agencyId,
        version: row.currentVersion,
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
          version: row.currentVersion,
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
  sendAssignmentNotificationForAgency,
  sendAssignmentNotificationsForVersion,
  sendExternalSignInviteEmail,
  sendSignedNotificationToGlobalAdmins,
  runReminderSweep,
  startScheduler,
  getPortalBaseUrl,
};
