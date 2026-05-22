const router = require("express").Router();
const agenciesStore = require("../services/agencies.service");
const usersSvc = require("../services/users.service");
const groupsSvc = require("../services/groups.service");
const accessSvc = require("../services/access.service");
const emailSvc = require("../services/email.service");
const auditSvc = require("../services/auditLog.service");
const { renderTemplate, htmlToText } = require("../services/emailTemplates.service");
const { toSafeApiError } = require("../services/apiErrorPayload.service");

const AGENCY_ADMIN_GROUP_NAME_PK_CACHE_TTL_MS =
  parseInt(process.env.AGENCY_ADMIN_GROUP_NAME_PK_CACHE_TTL_MS, 10) ||
  5 * 60 * 1000;
let _agencyAdminGroupsNameLowerToPkCache = {
  loadedAt: 0,
  map: new Map(),
};

function toErrorPayload(err) {
  return toSafeApiError(err);
}

function normalizeLegacyAdminGroupList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[;,]/)
    .map((g) => String(g || "").trim().toLowerCase())
    .filter(Boolean);
}

function getAgencyAdminGroupNamesForAgency(agency) {
  const names = new Set();
  for (const n of accessSvc.getAllAgencyAdminGroupNames(agency)) {
    const t = String(n || "").trim().toLowerCase();
    if (t) names.add(t);
  }
  const rawAdmin =
    agency.adminGroups != null ? agency.adminGroups : agency.adminGroup;
  for (const n of normalizeLegacyAdminGroupList(rawAdmin)) {
    names.add(n);
  }
  return Array.from(names);
}

async function getAllHiddenGroupsNameLowerToPk() {
  const now = Date.now();
  const cacheValid =
    _agencyAdminGroupsNameLowerToPkCache &&
    _agencyAdminGroupsNameLowerToPkCache.loadedAt &&
    now - _agencyAdminGroupsNameLowerToPkCache.loadedAt <
      AGENCY_ADMIN_GROUP_NAME_PK_CACHE_TTL_MS &&
    _agencyAdminGroupsNameLowerToPkCache.map &&
    _agencyAdminGroupsNameLowerToPkCache.map.size > 0;

  if (cacheValid) return _agencyAdminGroupsNameLowerToPkCache.map;

  const allGroups = await groupsSvc.getAllGroups({ includeHidden: true });
  const nameLowerToPk = new Map(
    (Array.isArray(allGroups) ? allGroups : []).map((g) => [
      String(g?.name || "").trim().toLowerCase(),
      String(g?.pk ?? g?.id ?? "").trim() || null,
    ])
  );

  _agencyAdminGroupsNameLowerToPkCache = {
    loadedAt: now,
    map: nameLowerToPk,
  };

  return nameLowerToPk;
}

async function resolveAgencyAdminGroupPks({ access, agencySuffixes }) {
  const suffixSet = new Set(
    (Array.isArray(agencySuffixes) ? agencySuffixes : [])
      .map((s) => String(s || "").trim().toLowerCase())
      .filter(Boolean)
  );
  if (!suffixSet.size) return [];

  const allowedSuffixes = access.isGlobalAdmin
    ? null
    : (access.allowedAgencySuffixes || [])
        .map((s) => String(s || "").trim().toLowerCase())
        .filter(Boolean);

  const agencies = agenciesStore.load();
  const matching = agencies.filter((a) => {
    const sfx = String(a?.suffix || "").trim().toLowerCase();
    if (!sfx || !suffixSet.has(sfx)) return false;
    if (!access.isGlobalAdmin) {
      if (!allowedSuffixes || !allowedSuffixes.includes(sfx)) return false;
    }
    return true;
  });

  const nameLowerToPk = await getAllHiddenGroupsNameLowerToPk();
  const pks = new Set();
  for (const agency of matching) {
    for (const nameLower of getAgencyAdminGroupNamesForAgency(agency)) {
      const pk = nameLowerToPk.get(nameLower);
      if (pk) pks.add(pk);
    }
  }
  return Array.from(pks);
}

// GET /api/email/meta
// Returns agencies + groups scoped to current user's access
router.get("/meta", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);

    const agencies = accessSvc.filterAgenciesForUser(
      authUser,
      agenciesStore.load()
    );

    const allGroups = await groupsSvc.getAllGroups({});
    const groups = accessSvc.filterGroupsForUser(authUser, allGroups);

    res.json({
      isGlobalAdmin: access.isGlobalAdmin,
      isAgencyAdmin: access.isAgencyAdmin,
      agencies,
      groups,
    });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

function distinctEmails(list) {
  const seen = new Set();
  const out = [];
  for (const u of list) {
    const email = String(u?.email || "").trim().toLowerCase();
    if (!email) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

// Helper: load users for various modes, honoring agency access
async function resolveRecipients({ authUser, mode, agencies, groupIds, usernames }) {
  const access = accessSvc.getAgencyAccess(authUser);

  // Agency filter utility (Authentik user attributes, then username tail)
  function isUserInAllowedAgency(user) {
    return accessSvc.isUserInAllowedAgencies(authUser, user);
  }

  let users = [];

  if (mode === "all") {
    if (!access.isGlobalAdmin) {
      const err = new Error("Forbidden");
      err.statusCode = 403;
      throw err;
    }
    users = await usersSvc.getAllUsers({ includeHiddenPrefixes: false });
  } else if (mode === "agency") {
    const all = await usersSvc.getAllUsers({ includeHiddenPrefixes: false });
    const suffixes =
      Array.isArray(agencies) && agencies.length
        ? agencies.map((a) => String(a || "").trim().toLowerCase())
        : access.allowedAgencySuffixes || [];
    const suffixSet = new Set(
      (suffixes || []).map((s) => String(s || "").trim().toLowerCase())
    );
    users = all.filter((u) => {
      const resolvedSuffix = accessSvc.resolveAgencySuffixFromUser(u);
      const match =
        resolvedSuffix && suffixSet.has(String(resolvedSuffix).toLowerCase());
      return match && isUserInAllowedAgency(u);
    });
  } else if (mode === "agency_admins") {
    if (!access.isGlobalAdmin) {
      const err = new Error("Forbidden");
      err.statusCode = 403;
      throw err;
    }
    const suffixes =
      Array.isArray(agencies) && agencies.length
        ? agencies.map((a) => String(a || "").trim().toLowerCase())
        : [];
    const groupPks = await resolveAgencyAdminGroupPks({
      access,
      agencySuffixes: suffixes,
    });
    if (!groupPks.length) return [];
    users = await usersSvc.getUsersByGroups(groupPks, {
      includeHiddenPrefixes: false,
    });
    users = users.filter((u) => isUserInAllowedAgency(u));
  } else if (mode === "all_agency_admins") {
    if (!access.isGlobalAdmin) {
      const err = new Error("Forbidden");
      err.statusCode = 403;
      throw err;
    }
    const allSuffixes = agenciesStore
      .load()
      .map((a) => String(a?.suffix || "").trim().toLowerCase())
      .filter(Boolean);
    const groupPks = await resolveAgencyAdminGroupPks({
      access,
      agencySuffixes: allSuffixes,
    });
    if (!groupPks.length) return [];
    users = await usersSvc.getUsersByGroups(groupPks, {
      includeHiddenPrefixes: false,
    });
    users = users.filter((u) => isUserInAllowedAgency(u));
  } else if (mode === "groups") {
    const groupList = Array.isArray(groupIds) ? groupIds : [];
    if (!groupList.length) return [];
    users = await usersSvc.getUsersByGroups(groupList, {
      includeHiddenPrefixes: false,
    });
    users = users.filter((u) => isUserInAllowedAgency(u));
  } else if (mode === "users") {
    const names =
      Array.isArray(usernames) && usernames.length
        ? usernames
        : [];
    const cleaned = names
      .map((n) => String(n || "").trim())
      .filter(Boolean);
    if (!cleaned.length) return [];
    users = await usersSvc.getUsersByUsernames(cleaned, {
      includeHiddenPrefixes: false,
    });
    users = users.filter((u) => isUserInAllowedAgency(u));
  } else {
    const err = new Error("Invalid mode");
    err.statusCode = 400;
    throw err;
  }

  return distinctEmails(users);
}

// POST /api/email/recipient-count — returns { count } for the given mode/selection (no email sent)
router.post("/recipient-count", async (req, res) => {
  try {
    const body = req.body || {};
    const authUser = req.authentikUser || null;
    const mode = String(body.mode || "").toLowerCase();
    const agencies = Array.isArray(body.agencies) ? body.agencies : [];
    const groupIds = Array.isArray(body.groupIds) ? body.groupIds : [];
    const usernamesRaw = Array.isArray(body.usernames)
      ? body.usernames
      : typeof body.usernames === "string"
      ? body.usernames.split(/[\n,]/g)
      : [];
    const usernames = usernamesRaw.map((s) => String(s || "").trim()).filter(Boolean);

    const targets = await resolveRecipients({
      authUser,
      mode,
      agencies,
      groupIds,
      usernames,
    });
    res.json({ count: targets.length });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: toErrorPayload(err) });
  }
});

// POST /api/email/send
router.post("/send", async (req, res) => {
  try {
    const body = req.body || {};
    const authUser = req.authentikUser || null;

    const mode = String(body.mode || "").toLowerCase();
    const agencies = Array.isArray(body.agencies) ? body.agencies : [];
    const groupIds = Array.isArray(body.groupIds) ? body.groupIds : [];
    const usernamesRaw = Array.isArray(body.usernames)
      ? body.usernames
      : typeof body.usernames === "string"
      ? body.usernames.split(/[\n,]/g)
      : [];
    const usernames = usernamesRaw
      .map((s) => String(s || "").trim())
      .filter(Boolean);

    const subject = String(body.subject || "").trim();
    const message = String(body.body || "").trim();
    const testOnly = !!body.testOnly;

    if (!subject || !message) {
      return res
        .status(400)
        .json({ error: "Subject and body are required." });
    }

    // If email is disabled, short-circuit with same behavior as mutual aid
    const emailCfg = emailSvc.getSmtpConfig();
    if (!emailSvc.isEmailEnabled() || !emailCfg.host || !emailCfg.from) {
      return res
        .status(400)
        .json({ error: "Email is disabled or SMTP is not configured." });
    }

    let targets = [];
    if (testOnly) {
      const me = String(authUser?.email || "").trim();
      if (!me) {
        return res
          .status(400)
          .json({ error: "Current user has no email address." });
      }
      targets = [me.toLowerCase()];
    } else {
      targets = await resolveRecipients({
        authUser,
        mode,
        agencies,
        groupIds,
        usernames,
      });
      if (!targets.length) {
        return res
          .status(400)
          .json({ error: "No eligible recipients found for selection." });
      }
    }

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
      to: "", // everyone goes in BCC
      subject,
      text,
      html,
      bcc: targets.join(","),
    });

    if (!result.sent) {
      if (result.skipped) {
        return res
          .status(400)
          .json({ error: "Email is disabled (EMAIL_ENABLED=false)" });
      }
      return res
        .status(500)
        .json({ error: result.error || "Email send failed" });
    }

    const agencyList = Array.isArray(agencies)
      ? agencies.map((a) => String(a || "").trim().toLowerCase()).filter(Boolean)
      : [];
    const groupIdList = Array.isArray(groupIds)
      ? groupIds.map((g) => String(g || "").trim()).filter(Boolean)
      : [];
    const usernameList = Array.isArray(usernames)
      ? usernames.map((u) => String(u || "").trim()).filter(Boolean)
      : [];

    auditSvc.logEvent({
      actor: authUser,
      request: {
        method: req.method,
        path: req.originalUrl || req.path,
        ip: req.ip,
      },
      action: "BULK_EMAIL_SENT",
      targetType: "bulk_email",
      targetId: "",
      details: {
        mode,
        count: targets.length,
        testOnly,
        subject: subject.slice(0, 200),
        agencyCount: agencyList.length,
        agencies: agencyList.length <= 20 ? agencyList : agencyList.slice(0, 20),
        groupIdCount: groupIdList.length,
        groupIds: groupIdList.length <= 15 ? groupIdList : undefined,
        usernameCount: usernameList.length,
        usernames: usernameList.length <= 15 ? usernameList : undefined,
        summary: testOnly
          ? "Sent bulk email test to self only."
          : `Sent bulk email (${mode}) to ${targets.length} recipient(s): "${subject.slice(0, 80)}${subject.length > 80 ? "…" : ""}".`,
      },
    });

    res.json({ success: true, count: targets.length });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: toErrorPayload(err) });
  }
});

module.exports = router;

