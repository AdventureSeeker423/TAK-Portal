const store = require("./auditLog.store");
const agenciesSvc = require("./agencies.service");
const accessSvc = require("./access.service");

function safeStr(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function normalizeSuffix(value) {
  return safeStr(value).trim().toLowerCase();
}

function stripTakPrefix(name) {
  const n = safeStr(name).trim();
  if (n.toLowerCase().startsWith("tak_")) return n.slice(4);
  return n;
}

function getAgenciesIndex() {
  const agencies = agenciesSvc.load();
  const bySuffix = new Map();
  const byPrefix = new Map();

  for (const a of agencies) {
    const sfx = normalizeSuffix(a && a.suffix);
    if (sfx) bySuffix.set(sfx, a);

    const pfx = safeStr(a && a.groupPrefix).trim().toUpperCase();
    if (pfx) byPrefix.set(pfx, a);
  }

  return { agencies, bySuffix, byPrefix };
}

function inferAgencyFromUsername(username) {
  const sfx = normalizeSuffix(accessSvc.inferAgencySuffixFromUsername(username));
  if (!sfx) return { agencySuffix: null, agencyName: null, agencyPrefix: null };

  const { bySuffix } = getAgenciesIndex();
  const agency = bySuffix.get(sfx);
  if (!agency) return { agencySuffix: null, agencyName: null, agencyPrefix: null };

  return {
    agencySuffix: normalizeSuffix(agency.suffix) || null,
    agencyName: safeStr(agency.name) || null,
    agencyPrefix: safeStr(agency.groupPrefix).trim().toUpperCase() || null,
  };
}

function inferAgencyFromGroupName(groupName) {
  const raw = stripTakPrefix(groupName);
  const upper = safeStr(raw).trim().toUpperCase();
  if (!upper) return { agencySuffix: null, agencyName: null, agencyPrefix: null };

  const { byPrefix } = getAgenciesIndex();

  // Allow:
  //   PREFIX <space>
  //   PREFIX-...
  //   PREFIX -...
  for (const [pfx, agency] of byPrefix.entries()) {
    if (!pfx) continue;
    if (
      upper.startsWith(pfx + " ") ||
      upper.startsWith(pfx + "-") ||
      upper.startsWith(pfx + " -")
    ) {
      return {
        agencySuffix: normalizeSuffix(agency && agency.suffix) || null,
        agencyName: safeStr(agency && agency.name) || null,
        agencyPrefix: safeStr(agency && agency.groupPrefix).trim().toUpperCase() || null,
      };
    }
  }

  return { agencySuffix: null, agencyName: null, agencyPrefix: null };
}

function inferAgency({ targetType, targetId, details }) {
  const t = safeStr(targetType).trim().toLowerCase();
  if (t === "user" || t === "authentik_user") {
    const username =
      details && details.username != null && details.username !== ""
        ? details.username
        : targetId;
    const attrs =
      details && details.attributes && typeof details.attributes === "object"
        ? details.attributes
        : null;
    if (attrs && Object.keys(attrs).length) {
      const sfx = normalizeSuffix(
        accessSvc.resolveAgencySuffixFromUser({ username, attributes: attrs })
      );
      if (sfx) {
        const { bySuffix } = getAgenciesIndex();
        const agency = bySuffix.get(sfx);
        if (agency) {
          return {
            agencySuffix: normalizeSuffix(agency.suffix) || null,
            agencyName: safeStr(agency.name) || null,
            agencyPrefix: safeStr(agency.groupPrefix).trim().toUpperCase() || null,
          };
        }
      }
    }
    return inferAgencyFromUsername(username);
  }
  if (t === "group" || t === "authentik_group") {
    const name = details && details.name ? details.name : targetId;
    return inferAgencyFromGroupName(name);
  }
  if (t === "agency") {
    // targetId is usually suffix
    const { bySuffix } = getAgenciesIndex();
    const sfx = normalizeSuffix(targetId);
    const a = sfx ? bySuffix.get(sfx) : null;
    if (!a) return { agencySuffix: null, agencyName: null, agencyPrefix: null };
    return {
      agencySuffix: normalizeSuffix(a.suffix) || null,
      agencyName: safeStr(a.name) || null,
      agencyPrefix: safeStr(a.groupPrefix).trim().toUpperCase() || null,
    };
  }
  if (t === "data_package" || t === "data_sync_mission" || t === "data_sync_file") {
    const groupRaw =
      details && details.group != null && details.group !== ""
        ? details.group
        : details && Array.isArray(details.groups) && details.groups.length
          ? details.groups[0]
          : "";
    if (groupRaw) return inferAgencyFromGroupName(groupRaw);
  }
  return { agencySuffix: null, agencyName: null, agencyPrefix: null };
}

const SENSITIVE_DETAIL_KEYS = new Set([
  "password",
  "pass",
  "token",
  "secret",
  "key",
  "pdfbase64",
  "h-captcha-response",
  "hcaptcha",
  "authentik_token",
  "tak_api_p12_password",
  "sms_twilio_auth_token",
  "sms_brevo_api_key",
  "hcaptcha_secret_key",
]);

function pruneDetails(details) {
  // Keep logs safe & lightweight: avoid accidentally persisting secrets.
  if (!details || typeof details !== "object") return null;
  if (Array.isArray(details)) return details;
  const out = { ...details };
  for (const k of Object.keys(out)) {
    if (SENSITIVE_DETAIL_KEYS.has(String(k).trim().toLowerCase())) {
      delete out[k];
    }
  }
  return out;
}

function requestMeta(req) {
  if (!req) return null;
  return {
    method: safeStr(req.method) || "",
    path: safeStr(req.originalUrl || req.path) || "",
    ip: safeStr(req.ip) || "",
  };
}

/**
 * Standard audit entry from an Express request (non-throwing).
 */
function auditFromRequest(req, payload = {}) {
  try {
    logEvent({
      actor:
        payload.actor !== undefined ? payload.actor : req?.authentikUser || null,
      request: payload.request || requestMeta(req),
      action: payload.action,
      targetType: payload.targetType,
      targetId: payload.targetId,
      details: payload.details,
      agencySuffix: payload.agencySuffix,
      agencyName: payload.agencyName,
      maxItems: payload.maxItems,
    });
  } catch (_) {
    /* logEvent already catches */
  }
}

function logEvent(payload) {
  try {
    const nowIso = new Date().toISOString();

    const actor = payload && payload.actor ? payload.actor : null;
    const action = safeStr(payload && payload.action).trim() || "UNKNOWN";
    const targetType = safeStr(payload && payload.targetType).trim() || "unknown";
    const targetId = safeStr(payload && payload.targetId).trim() || "";
    const details = pruneDetails(payload && payload.details);

    let agency;
    const explicitSuffix = payload && payload.agencySuffix != null && String(payload.agencySuffix).trim() !== "";
    if (explicitSuffix) {
      const sfx = normalizeSuffix(payload.agencySuffix);
      const { bySuffix } = getAgenciesIndex();
      const a = bySuffix.get(sfx);
      agency = a
        ? {
            agencySuffix: normalizeSuffix(a.suffix) || null,
            agencyName: safeStr(a.name) || null,
            agencyPrefix: safeStr(a.groupPrefix).trim().toUpperCase() || null,
          }
        : {
            agencySuffix: sfx,
            agencyName: safeStr(payload.agencyName) || null,
            agencyPrefix: null,
          };
    } else {
      agency = inferAgency({ targetType, targetId, details });
    }

    const ev = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      timestamp: nowIso,
      actor: actor
        ? {
            username: safeStr(actor.username) || null,
            displayName: safeStr(actor.displayName) || null,
            uid: safeStr(actor.uid) || null,
            isGlobalAdmin: !!actor.isGlobalAdmin,
            isAgencyAdmin: !!actor.isAgencyAdmin,
          }
        : null,
      request: payload && payload.request ? payload.request : null,
      action,
      targetType,
      targetId,
      agencySuffix: agency.agencySuffix,
      agencyName: agency.agencyName,
      agencyPrefix: agency.agencyPrefix,
      details,
    };
    store.insertEvent(ev).catch((err) => {
      console.warn("[audit] failed to write audit log:", err?.message || err);
    });
  } catch (err) {
    console.warn("[audit] failed to write audit log:", err?.message || err);
  }
}

async function queryLogs({
  q,
  actor,
  action,
  targetType,
  agencySuffix,
  from,
  to,
  page = 1,
  pageSize = 50,
} = {}) {
  const actorNeedles = safeStr(actor)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const actionNeedles = safeStr(action)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const targetNeedles = safeStr(targetType)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const agencyNeedles = safeStr(agencySuffix)
    .split(",")
    .map((s) => normalizeSuffix(s))
    .filter(Boolean);

  const p = Math.max(1, Number(page) || 1);
  const ps = Math.min(500, Math.max(10, Number(pageSize) || 50));
  const { items, total } = await store.queryRows({
    q,
    actorNeedles,
    actionNeedles,
    targetNeedles,
    agencyNeedles,
    from,
    to,
    page: p,
    pageSize: ps,
  });
  const pageCount = Math.max(1, Math.ceil((total || 0) / ps));
  const safePage = Math.min(pageCount, p);
  return {
    items,
    total,
    page: safePage,
    pageSize: ps,
    pageCount,
  };
}

async function listDistinctValues({ field, limit = 250 } = {}) {
  const f = safeStr(field);
  const vals = await store.listDistinct(f, limit);
  return (vals || [])
    .map((v) => (f === "agencies" ? normalizeSuffix(v) : v))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

const LOOKUP_FAILURE_LABELS = {
  captcha_missing: "Captcha was not completed.",
  captcha_failed: "Captcha verification failed.",
  missing_fields: "Email address or username was missing.",
  invalid_email: "Email address format was invalid.",
  agency_not_eligible: "No agency with account lookup enabled matched the email domain.",
  agency_disabled: "The matching agency is disabled and account lookup is unavailable.",
  user_not_found: "Username was not found or the account already has an email on file.",
  email_send_failed: "Account matched but the enrollment QR email could not be sent.",
};

function summarizeLookupEvent(payload = {}) {
  const form = payload.form && typeof payload.form === "object" ? payload.form : {};
  const email = safeStr(form.email).trim().toLowerCase();
  const username = safeStr(form.username).trim().toLowerCase();
  const domain =
    safeStr(form.emailDomain).trim().toLowerCase() ||
    (email.includes("@") ? email.split("@")[1] : "");

  if (payload.outcome === "success") {
    const agency = safeStr(payload.agencyName || payload.agencySuffix).trim() || "agency";
    return `Account lookup succeeded: enrollment QR emailed for username "${username}" to ${email} (${agency}).`;
  }

  const reason =
    LOOKUP_FAILURE_LABELS[safeStr(payload.failureReason).trim()] ||
    safeStr(payload.failureReason).trim() ||
    "Lookup failed.";
  const domainPart = domain ? ` (domain ${domain})` : "";
  return `Account lookup failed for email "${email}" and username "${username}"${domainPart}: ${reason}`;
}

/**
 * Audit every account lookup form submission (public /lookup page).
 * Logs all submitted form fields plus outcome-specific context.
 */
function logLookupEvent(req, payload = {}) {
  const form = payload.form && typeof payload.form === "object" ? payload.form : {};
  const email = safeStr(form.email).trim().toLowerCase();
  const username = safeStr(form.username).trim().toLowerCase();
  const emailDomain =
    safeStr(form.emailDomain).trim().toLowerCase() ||
    (email.includes("@") ? email.split("@")[1] : "") ||
    null;

  const outcome =
    safeStr(payload.outcome).trim().toLowerCase() === "success" ? "success" : "failure";
  const failureReason =
    outcome === "failure" ? safeStr(payload.failureReason).trim() || "unknown" : undefined;

  const details = pruneDetails({
    source: "account-lookup-form",
    outcome,
    failureReason,
    form: {
      email: email || null,
      username: username || null,
      emailDomain,
    },
    hcaptchaEnabled: payload.hcaptchaEnabled === true,
    hcaptchaPassed:
      payload.hcaptchaPassed === true
        ? true
        : payload.hcaptchaPassed === false
          ? false
          : null,
    agencySuffix:
      payload.agencySuffix != null && String(payload.agencySuffix).trim() !== ""
        ? normalizeSuffix(payload.agencySuffix)
        : undefined,
    agencyName: safeStr(payload.agencyName).trim() || undefined,
    matchedUsername: safeStr(payload.matchedUsername).trim() || undefined,
    matchedUserId: safeStr(payload.matchedUserId).trim() || undefined,
    usernameExists:
      payload.usernameExists === true
        ? true
        : payload.usernameExists === false
          ? false
          : undefined,
    userHasEmailOnFile:
      payload.userHasEmailOnFile === true
        ? true
        : payload.userHasEmailOnFile === false
          ? false
          : undefined,
    notificationEmail: outcome === "success" ? email || undefined : undefined,
    lookupEnabledAgencyCount: Number.isFinite(Number(payload.lookupEnabledAgencyCount))
      ? Number(payload.lookupEnabledAgencyCount)
      : undefined,
    errorMessage: safeStr(payload.errorMessage).trim() || undefined,
    summary: summarizeLookupEvent({
      ...payload,
      form: { email, username, emailDomain },
      outcome,
      failureReason,
    }),
  });

  const action = outcome === "success" ? "LOOKUP_QR_EMAIL_SENT" : "LOOKUP_ACCOUNT_FAILED";

  logEvent({
    actor: payload.actor !== undefined ? payload.actor : req?.authentikUser || null,
    request: payload.request || requestMeta(req),
    action,
    targetType: "user",
    targetId: safeStr(payload.matchedUsername || username).trim().toLowerCase() || "lookup",
    agencySuffix: payload.agencySuffix,
    agencyName: payload.agencyName,
    details,
  });
}

function listDistinctActors({ limit = 250 } = {}) {
  const logs = store.load();
  const byUsername = new Map();

  for (const log of logs) {
    if (!log || !log.actor) continue;
    const username = safeStr(log.actor.username);
    if (!username) continue;
    if (byUsername.has(username)) continue;
    byUsername.set(username, {
      username,
      displayName: safeStr(log.actor.displayName) || null,
    });
    if (byUsername.size >= limit) break;
  }

  return Array.from(byUsername.values())
    .sort((a, b) => {
      const labelA = (a.displayName || a.username).toLowerCase();
      const labelB = (b.displayName || b.username).toLowerCase();
      return labelA.localeCompare(labelB);
    });
}

module.exports = {
  logEvent,
  logLookupEvent,
  auditFromRequest,
  requestMeta,
  pruneDetails,
  queryLogs,
  listDistinctValues,
  listDistinctActors,
  inferAgencyFromUsername,
  inferAgencyFromGroupName,
};
