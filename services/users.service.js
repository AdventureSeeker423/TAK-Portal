const { getString, getInt, getBool } = require("./env");
const api = require("./authentik");
const agenciesStore = require("./agencies.service");
const templatesStore = require("./templates.service");
const tak = require("./tak.service");
const settingsSvc = require("./settings.service");
const accessSvc = require("./access.service");
const { sanitizeCallsign } = require("./callsignSanitize");
const directoryRepo = require("./directoryRepo.service");
const authentikOutbox = require("./authentikOutbox.service");
const db = require("./db");

function getHiddenUserPrefixes() {
  return String(getString("USERS_HIDDEN_PREFIXES", ""))
    .split(",")
    .map(p => String(p || "").trim().toLowerCase())
    .filter(Boolean);
}

function usernameMatchesHiddenPrefix(username) {
  const u = String(username || "").trim().toLowerCase();
  if (!u) return false;
  const prefixes = getHiddenUserPrefixes();
  if (!prefixes.length) return false;
  return prefixes.some((p) => u.startsWith(p));
}

// ---------------- Action-lock helpers ----------------
// If a username starts with any prefix in USERS_ACTIONS_HIDDEN_PREFIXES,
// the UI hides action buttons AND the API will reject mutating operations.
function getUserActionLockPrefixes() {
  return String(getString("USERS_ACTIONS_HIDDEN_PREFIXES", ""))
    .split(",")
    .map(p => String(p || "").trim().toLowerCase())
    .filter(Boolean);
}

function isUserActionLocked(username) {
  const u = String(username || "").trim().toLowerCase();
  if (!u) return false;
  const prefixes = getUserActionLockPrefixes();
  if (!prefixes.length) return false;
  return prefixes.some(p => u.startsWith(p));
}

async function assertUserNotActionLocked(userId, { ignoreLocks } = {}) {
  const user = await getUserById(userId);
  if (!ignoreLocks && isUserActionLocked(user?.username)) {
    throw new Error(`Actions are locked for user ${user?.username || userId}`);
  }
  return user;
}

const emailSvc = require("./email.service");
const { renderTemplate, htmlToText } = require("./emailTemplates.service");
const { toSafeApiError } = require("./apiErrorPayload.service");
const mutualAidStore = require("./mutualAid.store");
const DEFAULT_ATAK_ROLE = "Team Member";

/** Recognized ATAK role labels (same set as templates / UI). Used for CSV import validation. */
const ALLOWED_TAK_ROLES = [
  "Team Member",
  "Team Lead",
  "HQ",
  "Sniper",
  "Medic",
  "Forward Observer",
  "RTO",
  "K9",
];

/** Case-insensitive match to canonical role; null if non-empty but unknown. */
function resolveAllowedTakRoleInput(raw) {
  const s = String(raw || "").trim();
  if (!s) return { ok: true, role: "" };
  const lower = s.toLowerCase();
  const match = ALLOWED_TAK_ROLES.find((r) => r.toLowerCase() === lower);
  if (match) return { ok: true, role: match };
  return { ok: false, role: "" };
}

// Helpers
function normalizePath(p) {
  // Remove leading/trailing slashes
  return String(p || "").replace(/^\/+|\/+$/g, "");
}

/** Normalize badge for storage: trim, lowercase, remove all whitespace (including NBSP, zero-width, BOM). */
function normalizeBadge(badge) {
  return String(badge || "")
    .trim()
    .toLowerCase()
    .replace(/\p{White_Space}+/gu, "");
}

function validateBadgeNumber(badge) {
  const b = String(badge || "").trim();
  if (!b) return "Badge / Username is required.";
  // Allow letters, numbers, periods, dashes, and underscores only.
  if (!/^[A-Za-z0-9._-]+$/.test(b)) {
    return "Badge / Username can only contain letters, numbers, periods, dashes, and underscores.";
  }
  return null;
}

function validatePassword(password) {
  const p = String(password || "");
  if (p.length < 12) return "Password must be at least 12 characters.";
  if (!/[a-z]/.test(p)) return "Password must contain a lowercase letter.";
  if (!/[A-Z]/.test(p)) return "Password must contain an uppercase letter.";
  if (!/[0-9]/.test(p)) return "Password must contain a number.";
  if (!/[!@#$%^&*()_+\-=[\]{};':\"\\|,.<>/?]/.test(p))
    return "Password must contain a symbol.";
  return null;
}

/** When non-empty, must be acceptable to Authentik/Django email validation (no leading/trailing check only — trim in caller). */
function validateEmailFormatIfPresent(email) {
  const m = String(email || "").trim();
  if (!m) return null;
  if (/\s/.test(m)) return "Enter a valid email address.";
  // Pragmatic single-line email pattern; aligns with common HTML5 / Django checks.
  const re =
    /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  if (!re.test(m)) return "Enter a valid email address.";
  return null;
}

function normalizeTakRole(value, fallback = DEFAULT_ATAK_ROLE) {
  const role = String(value || "").trim();
  return role || fallback;
}

function isMutualAidUser(user) {
  const attrs = user?.attributes && typeof user.attributes === "object" ? user.attributes : {};
  if (attrs.mutual_aid === true) return true;
  const raw = String(attrs.mutual_aid ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

function loadMutualAidCreatedGroupIdSet() {
  return mutualAidStore.getCreatedGroupIdSet();
}

function shouldSkipRoleBackfillForUser(user) {
  const type = String(user?.type || "").trim().toLowerCase();
  // Authentik service accounts can reject profile/attribute writes.
  if (type === "service_account" || type === "internal_service_account") return true;
  // Mutual aid deployment users are managed separately.
  if (isMutualAidUser(user)) return true;
  // Never migrate users hidden by USERS_HIDDEN_PREFIXES.
  if (usernameMatchesHiddenPrefix(user?.username)) return true;
  return false;
}

function shouldSkipCurrentTemplateBackfillForUser(user) {
  return shouldSkipRoleBackfillForUser(user);
}

async function resolveGroupNames(groupIds) {
  const ids = Array.isArray(groupIds)
    ? groupIds.map(x => String(x).trim()).filter(Boolean)
    : [];
  if (!ids.length) return [];

  const groups = await directoryRepo.getGroupsByPks(ids);
  const byPk = new Map(groups.map(g => [String(g.pk), String(g.name || "").trim()]));
  return ids
    .map(id => byPk.get(String(id)) || String(id))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function stripGroupNamePrefixesForDisplay(groupName) {
  let out = String(groupName || "").trim();
  if (!out) return out;
  out = out.replace(/^tak[_-]/i, "");
  out = out.replace(/^authentik[_-]/i, "");
  return out.trim();
}

function safeMailTo(user) {
  const to = String(user?.email || "").trim();
  return to || null;
}

function parseName(displayName) {
  const s = String(displayName || "").trim();

  // Split on first comma only
  const [last, rest] = s.split(",", 2);

  const lastName = (last || "").trim();
  const firstName = (rest || "").trim();

  return {
    lastName,
    lastNameUpper: lastName.toUpperCase(),
    firstName,
  };
}

/**
 * Map agency type strings (as stored in agencies.json) to short codes for callsign format.
 */
const AGENCY_TYPE_TO_CODE = {
  "Law Enforcement": "LE",
  "Fire": "FD",
  "EMS": "EMS",
  "State Defense": "SDF",
  "Military": "MIL",
  "Game Warden / NPS / Forestry": "WLD",
  "CBRNE / HAZMAT": "HAZ",
  "SAR / Technical": "SAR",
  "Emergency Management": "EMA",
  "Dispatch / Communications": "COM",
  "Public Works": "PW",
  "Volunteer": "VOL",
  "Other": "OTH",
};

function getAgencyTypeCode(agencyTypeString) {
  const key = String(agencyTypeString || "").trim();
  return AGENCY_TYPE_TO_CODE[key] || "";
}

/**
 * {{badgeNumber}} in callsign format:
 * 1) radio_callsign when set
 * 2) badge_number attribute (badge only, no agency suffix)
 * 3) username with agency token removed (prefix or suffix placement)
 */
function resolveCallsignRadioOrUsername({
  radioCallsign,
  badgeNumber,
  username,
  agencySuffix,
} = {}) {
  const radio = String(radioCallsign ?? "").trim();
  if (radio) return radio;

  const badge = String(badgeNumber ?? "").trim();
  if (badge) return badge;

  const user = String(username ?? "").trim();
  if (!user) return "";

  return accessSvc.stripAgencyTokenFromUsername(user, agencySuffix);
}

/** Radio callsign only — blank when unset (no badge or username fallback). */
function resolveCallsignRadioOrBlank({ radioCallsign } = {}) {
  return String(radioCallsign ?? "").trim();
}

/** Strip empty segments and orphan dashes (e.g. XXX--ZZZ or XXX- → XXX-ZZZ / XXX). */
function cleanupCallsignOutput(str) {
  let s = sanitizeCallsign(str);
  s = s.replace(/\s*-\s*/g, "-");
  s = s.replace(/-{2,}/g, "-");
  while (s.startsWith("-")) s = s.slice(1);
  while (s.endsWith("-")) s = s.slice(0, -1);
  return s.trim();
}

/**
 * Build a callsign string from settings + user context.
 * Falls back to "{{agencyAbbreviation}}-{{lastNameUpper}}-{{badgeNumber}}" when unset/invalid.
 */
function resolveCallsignCurrentTemplate(currentTemplate) {
  const name = String(currentTemplate || "").trim();
  if (!name || name === "Manual Group Selection") return "";
  return name;
}

function buildCallsign({
  firstName,
  lastName,
  lastNameUpper,
  radioCallsign,
  badgeNumber,
  username,
  agencySuffix,
  agencyAbbreviation,
  agencyColor,
  stateAbbreviation,
  county,
  countyAbbreviation,
  agencyTypeCode,
  currentTemplate,
} = {}) {
  let settings = {};
  try {
    settings = settingsSvc.getSettings ? settingsSvc.getSettings() || {} : {};
  } catch {
    settings = {};
  }

  let expr = String(settings.CALLSIGN_FORMAT_EXPRESSION || "").trim();
  if (!expr) {
    expr = "{{agencyAbbreviation}}-{{lastNameUpper}}-{{badgeNumber}}";
  }

  const fnTrim = String(firstName || "").trim();
  const lnTrim = String(lastName || "").trim();
  const ctx = {
    firstName: firstName || "",
    lastName: lastName || "",
    lastNameUpper: lastNameUpper || "",
    firstInitial: fnTrim ? fnTrim.charAt(0).toUpperCase() : "",
    lastInitial: lnTrim ? lnTrim.charAt(0).toUpperCase() : "",
    badgeNumber: resolveCallsignRadioOrUsername({
      radioCallsign,
      badgeNumber,
      username,
      agencySuffix,
    }),
    radioCallsignOrBlank: resolveCallsignRadioOrBlank({ radioCallsign }),
    agencyAbbreviation: agencyAbbreviation || "",
    agencyColor: agencyColor || "",
    stateAbbreviation: stateAbbreviation || "",
    county: county || "",
    countyAbbreviation: countyAbbreviation || "",
    agencyTypeCode: agencyTypeCode || "",
    currentTemplate: resolveCallsignCurrentTemplate(currentTemplate),
  };

  const rendered = expr.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(ctx, key)) {
      const v = ctx[key];
      return v != null ? String(v).trim() : "";
    }
    // Unknown tokens are left as-is so misconfigurations are visible.
    return match;
  });

  // Always drop empty fields and clean orphan leading/trailing/double dashes
  // (e.g. XXX-YYY-ZZZ with YYY empty → XXX-ZZZ).
  return cleanupCallsignOutput(rendered);
}

/**
 * Get preference data for Setup My Device (Android Step 3): callsign, team (color), role.
 * Uses same logic as onboarding email (CALLSIGN_FORMAT_EXPRESSION, agency, template color override).
 * @param {object} user - Full Authentik user with attributes
 * @returns {{ callsign: string, teamLabel: string, roleLabel: string }}
 */
function getPreferenceDataForUser(user) {
  const attrs = user?.attributes || {};
  const agencies = agenciesStore.load();

  const agencySuffix = String(attrs.agency || "").toLowerCase();
  const agency =
    agencies.find(
      (a) => String(a.suffix || "").toLowerCase() === agencySuffix
    ) || null;

  const badgeNumber = String(attrs.badge_number || "");
  const radioCallsign = String(attrs.radio_callsign || "");
  const username = String(user?.username || "");
  const agencyAbbreviation = String(
    agency?.groupPrefix || attrs.agency_abbreviation || ""
  );
  const agencyColor = String(
    agency?.color || attrs.agency_color || ""
  );
  const stateAbbreviation = String(agency?.state || attrs.state || "").toUpperCase();
  const county = String(agency?.county || attrs.county || "").trim().toUpperCase();
  const countyAbbreviation = String(agency?.countyAbbrev || "").trim().toUpperCase();
  const agencyTypeCode = getAgencyTypeCode(agency?.type);

  const displayName = String(user?.name || "").trim() || "";
  const { lastName, lastNameUpper, firstName } = parseName(displayName);

  let agencyColorEffective = agencyColor;
  try {
    const createdTemplateName = String(attrs.created_template || "").trim();
    if (createdTemplateName && createdTemplateName !== "Manual Group Selection") {
      const tplAgencySuffix = String(attrs.agency || agencySuffix || "")
        .trim()
        .toLowerCase();
      const allTemplates = templatesStore.load();
      const match = allTemplates.find(
        (t) =>
          String(t?.agencySuffix || "").trim().toLowerCase() === tplAgencySuffix &&
          String(t?.name || "").trim().toLowerCase() === createdTemplateName.toLowerCase()
      );
      const override = String(match?.colorOverride || "").trim();
      if (override) agencyColorEffective = override;
    }
  } catch (e) {
    // ignore
  }

  const callsign = buildCallsign({
    firstName,
    lastName,
    lastNameUpper,
    radioCallsign,
    badgeNumber,
    username,
    agencySuffix,
    agencyAbbreviation,
    agencyColor: agencyColorEffective,
    stateAbbreviation,
    county,
    countyAbbreviation,
    agencyTypeCode,
    currentTemplate: attrs.current_template,
  });

  const roleLabel = normalizeTakRole(attrs.role, DEFAULT_ATAK_ROLE);

  return {
    callsign: String(callsign || "").trim(),
    teamLabel: String(agencyColorEffective || "").trim(),
    roleLabel,
  };
}

function getTakPortalPublicUrl() {
  try {
    const settings = settingsSvc.getSettings ? settingsSvc.getSettings() || {} : {};

    if (
      settings.TAK_PORTAL_PUBLIC_URL &&
      typeof settings.TAK_PORTAL_PUBLIC_URL === "string" &&
      settings.TAK_PORTAL_PUBLIC_URL.trim()
    ) {
      return settings.TAK_PORTAL_PUBLIC_URL.trim();
    }

    const env = getString("TAK_PORTAL_PUBLIC_URL", "").trim();
    if (env) return env;

    return "";
  } catch {
    return "";
  }
}

/**
 * Build an HTML block for "TAK Portal" content.
 * NOTE: This is used with {{{takPortalBlock}}} in templates so it must be valid HTML.
 * CTA is a plain bold link (not a boxed button) — some mail gateways strip button-shaped CTAs.
 */
function buildTakPortalBlock({
  takPortalPublicUrl,
  introHtml,
  buttonText,
  elseHtml,
} = {}) {
  const url = String(takPortalPublicUrl || "").trim();

  if (url) {
    const intro = String(introHtml || "").trim();
    const btnText = String(buttonText || "Open TAK Portal").trim();
    const linkColor = "#2e6da4";

    return `
      ${intro ? `<p style="margin:0 0 12px; font-size:14px; line-height:21px;">${intro}</p>` : ""}

      <p style="margin:0 0 16px; text-align:center;">
        <a href="${url}" target="_blank" rel="noopener noreferrer"
           style="font-size:16px; font-weight:700; color:${linkColor};">
          ${btnText}
        </a>
      </p>
    `.trim();
  }

  const fallback = String(elseHtml || "").trim();
  return `
    <p style="margin:0 0 16px; font-size:14px; line-height:21px;">
      ${fallback}
    </p>
  `.trim();
}

/**
 * Build Mustache variables shared by user-created and user re-enabled welcome emails.
 *
 * @param {object} user - Authentik user object
 * @param {Array<{name?: string}>|undefined} groupsOverride - When defined (including `[]`),
 *   group CSV is built from these objects' names (create-user flow). When omitted, names are
 *   resolved from `user.groups`.
 * @returns {Promise<{ to: string, vars: object }|null>}
 */
async function buildUserAccountWelcomeEmailVars(user, groupsOverride) {
  const to = safeMailTo(user);
  if (!to) return null;

  let groupNames;
  if (groupsOverride !== undefined) {
    groupNames = Array.isArray(groupsOverride)
      ? groupsOverride
          .map(g => String(g?.name || "").trim())
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b))
      : [];
  } else {
    groupNames = await resolveGroupNames(user?.groups || []);
  }
  const groupsCsv = groupNames.length ? groupNames.join(", ") : "(none)";

  const displayName = String(user?.name || "").trim() || "there";
  const { lastName, lastNameUpper, firstName } = parseName(displayName);

  const attrs = user?.attributes || {};
  const agencies = agenciesStore.load();

  const agencySuffix = String(attrs.agency || "").toLowerCase();
  const agency =
    agencies.find(
      a => String(a.suffix || "").toLowerCase() === agencySuffix
    ) || null;

  const badgeNumber = String(attrs.badge_number || "");
  const radioCallsign = String(attrs.radio_callsign || "");
  const username = String(user?.username || "");
  const agencyAbbreviation =
    String(
      agency?.groupPrefix ||
      attrs.agency_abbreviation ||
      ""
    );
  const agencyColor =
    String(
      agency?.color ||
      attrs.agency_color ||
      ""
    );
  const stateAbbreviation = String(agency?.state || attrs.state || "").toUpperCase();
  const county = String(agency?.county || attrs.county || "").trim().toUpperCase();
  const countyAbbreviation = String(agency?.countyAbbrev || "").trim().toUpperCase();
  const agencyTypeCode = getAgencyTypeCode(agency?.type);

  // If the user was created from an agency template, prefer that template's color override
  // (when present). Otherwise fall back to the agency color behavior above.
  let agencyColorEffective = agencyColor;
  try {
    const createdTemplateName = String(attrs.created_template || "").trim();

    // "Manual Group Selection" is the non-template option in the UI.
    if (createdTemplateName && createdTemplateName !== "Manual Group Selection") {
      const tplAgencySuffix = String(attrs.agency || agencySuffix || "")
        .trim()
        .toLowerCase();
      const allTemplates = templatesStore.load();
      const match = allTemplates.find(t =>
        String(t?.agencySuffix || "").trim().toLowerCase() === tplAgencySuffix &&
        String(t?.name || "").trim().toLowerCase() === createdTemplateName.toLowerCase()
      );
      const override = String(match?.colorOverride || "").trim();
      if (override) agencyColorEffective = override;
    }
  } catch (e) {
    // Never block email sending because of template lookup issues.
  }

  const takPortalPublicUrl = getTakPortalPublicUrl();

  const callsign = buildCallsign({
    firstName,
    lastName,
    lastNameUpper,
    radioCallsign,
    badgeNumber,
    username,
    agencySuffix,
    agencyAbbreviation,
    agencyColor: agencyColorEffective,
    stateAbbreviation,
    county,
    countyAbbreviation,
    agencyTypeCode,
    currentTemplate: attrs.current_template,
  });

  return {
    to,
    vars: {
      displayName,
      lastName,
      lastNameUpper,
      firstName,
      username,
      groupsCsv,
      badgeNumber,
      agencyAbbreviation,
      agencyColor: agencyColorEffective,
      stateAbbreviation,
      county,
      callsign,
      atakRole: normalizeTakRole(attrs.role, DEFAULT_ATAK_ROLE),
      takPortalPublicUrl,
    },
  };
}

/**
 * User-created email.
 *
 * hasPassword === true  -> use "user_created_password_set.html"
 * hasPassword === false -> use "user_created_no_password.html"
 *
 */
async function emailUserCreated({ user, groups, hasPassword }) {
  const built = await buildUserAccountWelcomeEmailVars(user, groups);
  if (!built) return;

  const templateKey = hasPassword
    ? "user_created_password_set.html"
    : "user_created_no_password.html";

  const takPortalPublicUrl = built.vars.takPortalPublicUrl;

  const takPortalBlock = hasPassword
    ? buildTakPortalBlock({
        takPortalPublicUrl,
        introHtml:
          "Use the TAK Portal to access device setup instructions, reset your password, or generate a QR code for faster sign-in on your mobile device.",
        buttonText: "Open TAK Portal",
        elseHtml:
          "If you forget your password or need help setting up TAK on your device, contact your TAK Portal Administrator.",
      })
    : buildTakPortalBlock({
        takPortalPublicUrl,
        introHtml:
          "Use the TAK Portal to set your password, access device setup instructions, or generate a QR code for faster sign-in on your mobile device.",
        buttonText: "Open TAK Portal To Set Your Password",
        elseHtml:
          "To set your password or get help setting up TAK on your device, contact your TAK Portal Administrator.",
      });

  const html = renderTemplate(templateKey, {
    ...built.vars,
    hasPassword: !!hasPassword,
    takPortalBlock,
  });

  const text = htmlToText(html);

  await emailSvc.sendMail({
    to: built.to,
    subject: "TAK Account Created",
    text,
    html,
  });
}

/**
 * Sent when an administrator re-enables a previously disabled user (same portal block as
 * "user created with password" — user keeps their existing password).
 */
async function emailUserReenabled(user) {
  const built = await buildUserAccountWelcomeEmailVars(user, undefined);
  if (!built) return;

  const takPortalPublicUrl = built.vars.takPortalPublicUrl;
  const takPortalBlock = buildTakPortalBlock({
    takPortalPublicUrl,
    introHtml:
      "Use the TAK Portal to access device setup instructions, reset your password, or generate a QR code for faster sign-in on your mobile device.",
    buttonText: "Open TAK Portal",
    elseHtml:
      "If you forget your password or need help setting up TAK on your device, contact your TAK Portal Administrator.",
  });

  const html = renderTemplate("user_reenabled.html", {
    ...built.vars,
    hasPassword: true,
    takPortalBlock,
  });

  const text = htmlToText(html);

  await emailSvc.sendMail({
    to: built.to,
    subject: "TAK Account Re-Enabled",
    text,
    html,
  });
}

async function emailPasswordChanged(user) {
  const to = safeMailTo(user);
  if (!to) return;

  const attrs = user?.attributes || {};
  const agencies = agenciesStore.load();

  const agencySuffix = String(attrs.agency || "").toLowerCase();
  const agency =
    agencies.find(
      a => String(a.suffix || "").toLowerCase() === agencySuffix
    ) || null;

  const badgeNumber = String(attrs.badge_number || "");
  const radioCallsign = String(attrs.radio_callsign || "");
  const username = String(user?.username || "");
  const agencyAbbreviation =
    String(
      agency?.groupPrefix ||
      attrs.agency_abbreviation ||
      ""
    );
  const agencyColor =
    String(
      agency?.color ||
      attrs.agency_color ||
      ""
    );
  const stateAbbreviation = String(agency?.state || attrs.state || "").toUpperCase();
  const county = String(agency?.county || attrs.county || "").trim().toUpperCase();
  const countyAbbreviation = String(agency?.countyAbbrev || "").trim().toUpperCase();
  const agencyTypeCode = getAgencyTypeCode(agency?.type);

  const subject = "TAK Password Updated";
  const displayName = String(user?.name || "").trim() || "there";
  const { lastName, lastNameUpper, firstName } = parseName(displayName);

  const takPortalPublicUrl = getTakPortalPublicUrl();
  const takPortalBlock = buildTakPortalBlock({
    takPortalPublicUrl,
    introHtml:
      "Use the TAK Portal to manage your password, access device setup instructions, or generate a QR code for faster sign-in on your mobile device.",
    buttonText: "Open TAK Portal",
    elseHtml:
      "If you need to change your password or get help setting up TAK on your device, contact your TAK Portal Administrator.",
  });

  const callsign = buildCallsign({
    firstName,
    lastName,
    lastNameUpper,
    radioCallsign,
    badgeNumber,
    username,
    agencySuffix,
    agencyAbbreviation,
    agencyColor,
    stateAbbreviation,
    county,
    countyAbbreviation,
    agencyTypeCode,
    currentTemplate: attrs.current_template,
  });

  const html = renderTemplate("password_changed.html", {
    displayName,
    lastName,
    lastNameUpper,
    firstName,
    username: String(user?.username || ""),
    badgeNumber,
    agencyAbbreviation,
    agencyColor,
    atakRole: normalizeTakRole(attrs.role, DEFAULT_ATAK_ROLE),
    takPortalPublicUrl,
    stateAbbreviation,
    county,
    callsign,
    takPortalBlock,
  });

  const text = htmlToText(html);

  await emailSvc.sendMail({ to, subject, text, html });
}

function normalizeGroupIdList(raw) {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return list
    .map((entry) => {
      if (entry && typeof entry === "object") {
        return String(entry.pk ?? entry.id ?? "").trim();
      }
      return String(entry || "").trim();
    })
    .filter(Boolean);
}

function formatGroupLabelsCsv(groupNames) {
  const labels = (Array.isArray(groupNames) ? groupNames : [])
    .map(stripGroupNamePrefixesForDisplay)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return labels.length ? labels.join(", ") : "(none)";
}

function diffGroupIds(beforeIds, afterIds) {
  const beforeSet = new Set(normalizeGroupIdList(beforeIds));
  const afterSet = new Set(normalizeGroupIdList(afterIds));
  const addedIds = [...afterSet].filter((id) => !beforeSet.has(id));
  const removedIds = [...beforeSet].filter((id) => !afterSet.has(id));
  return { addedIds, removedIds };
}

async function emailGroupsUpdated({ user, beforeIds, afterIds }) {
  let u = user;
  try {
    const pk = user?.pk ?? user?.id;
    if (pk) u = await getUserById(pk);
  } catch (_) {
    // keep snapshot user
  }

  const to = safeMailTo(u);
  if (!to) return;

  const { addedIds, removedIds } = diffGroupIds(beforeIds, afterIds);
  if (!addedIds.length && !removedIds.length) return;

  const [addedNames, removedNames] = await Promise.all([
    resolveGroupNames(addedIds),
    resolveGroupNames(removedIds),
  ]);

  const attrs = u?.attributes || {};
  const agencies = agenciesStore.load();

  const agencySuffix = String(attrs.agency || "").toLowerCase();
  const agency =
    agencies.find(
      a => String(a.suffix || "").toLowerCase() === agencySuffix
    ) || null;

  const badgeNumber = String(attrs.badge_number || "");
  const radioCallsign = String(attrs.radio_callsign || "");
  const username = String(u?.username || "");
  const agencyAbbreviation =
    String(
      agency?.groupPrefix ||
      attrs.agency_abbreviation ||
      ""
    );
  const agencyColor =
    String(
      agency?.color ||
      attrs.agency_color ||
      ""
    );
  const stateAbbreviation = String(agency?.state || attrs.state || "").toUpperCase();
  const county = String(agency?.county || attrs.county || "").trim().toUpperCase();
  const countyAbbreviation = String(agency?.countyAbbrev || "").trim().toUpperCase();
  const agencyTypeCode = getAgencyTypeCode(agency?.type);

  const subject = "TAK Groups Updated";
  const displayName = String(u?.name || "").trim() || "there";
  const { lastName, lastNameUpper, firstName } = parseName(displayName);
  const addedGroupsCsv = formatGroupLabelsCsv(addedNames);
  const removedGroupsCsv = formatGroupLabelsCsv(removedNames);

  const takPortalPublicUrl = getTakPortalPublicUrl();
  const takPortalBlock = buildTakPortalBlock({
    takPortalPublicUrl,
    introHtml:
      "Use the TAK Portal to review your access, manage your account, follow device setup instructions, or generate a QR code for faster sign-in on your mobile device.",
    buttonText: "Open TAK Portal",
    elseHtml:
      "If you need to review your access or get help setting up TAK on your device, contact your TAK Portal Administrator.",
  });

  const callsign = buildCallsign({
    firstName,
    lastName,
    lastNameUpper,
    radioCallsign,
    badgeNumber,
    username,
    agencySuffix,
    agencyAbbreviation,
    agencyColor,
    stateAbbreviation,
    county,
    countyAbbreviation,
    agencyTypeCode,
    currentTemplate: attrs.current_template,
  });

  const html = renderTemplate("groups_updated.html", {
    displayName,
    lastName,
    lastNameUpper,
    firstName,
    username: String(u?.username || ""),
    addedGroupsCsv,
    removedGroupsCsv,
    badgeNumber,
    agencyAbbreviation,
    agencyColor,
    atakRole: normalizeTakRole(attrs.role, DEFAULT_ATAK_ROLE),
    stateAbbreviation,
    county,
    callsign,
    takPortalPublicUrl,
    takPortalBlock,
  });

  const text = [
    `Hi ${firstName} ${lastName},`,
    "",
    "Your TAK account access groups were recently changed by your agency administrator.",
    "",
    `Removed Groups: ${removedGroupsCsv}`,
    `Added Groups: ${addedGroupsCsv}`,
    "",
    takPortalPublicUrl
      ? `Open TAK Portal: ${takPortalPublicUrl}`
      : "Open TAK Portal to review your access.",
    "",
    "If you do not recognize these changes, contact your TAK agency administrator.",
  ].join("\n");

  await emailSvc.sendMail({ to, subject, text, html });
}

// --- Debounced "groups updated" email logic ---
const GROUP_EMAIL_DEBOUNCE_MS = 3 * 60 * 1000;

// In-memory queue to debounce group-change emails per user.
// NOTE: This is per-process. If you run multiple Node instances,
// each process will handle its own debounce window.
const groupEmailQueue = new Map();

function scheduleDebouncedGroupsEmail({ user, beforeIds, afterIds }) {
  if (!getBool("EMAIL_GROUP_CHANGES_ENABLED", true)) return;
  const userId = String(user?.pk || user?.id || "").trim();
  if (!userId) return;

  const existing = groupEmailQueue.get(userId);
  if (existing && existing.timeout) {
    clearTimeout(existing.timeout);
  }

  const entry = {
    // Keep the very first snapshot of "before" so the email shows all changes.
    user: existing?.user || user,
    beforeIds:
      existing?.beforeIds || normalizeGroupIdList(beforeIds),
    // Always use the latest "after" set so we reflect the final state.
    afterIds: normalizeGroupIdList(afterIds),
  };

  entry.timeout = setTimeout(async () => {
    groupEmailQueue.delete(userId);
    try {
      await emailGroupsUpdated({
        user: entry.user,
        beforeIds: entry.beforeIds,
        afterIds: entry.afterIds,
      });
    } catch (err) {
      console.error(
        "[EMAIL] groups update notice (debounced) failed:",
        err?.message || err
      );
    }
  }, GROUP_EMAIL_DEBOUNCE_MS);

  groupEmailQueue.set(userId, entry);
}

// Get templates available for a given agency suffix.
// Templates are agency-specific; must match the given suffix.
// Returned templates are used AFTER the "Manual Group Selection" option in the UI.
function getTemplatesForAgency(agencySuffix) {
  const all = templatesStore.load();
  const sfx = String(agencySuffix || "").trim().toLowerCase();
  const filtered = all.filter(t => {
    const tSfx = String(t.agencySuffix || "").trim().toLowerCase();
    return tSfx === sfx;
  });
  return filtered.map(t => ({
    name: String(t.name || "").trim(),
    agencySuffix: String(t.agencySuffix || "").trim().toLowerCase(),
    role: normalizeTakRole(t.role, DEFAULT_ATAK_ROLE),
    groups: Array.isArray(t.groups)
      ? t.groups.map(g => String(g).trim()).filter(Boolean)
      : [],
    isDefault: !!t.isDefault,
  }));
}

// Authentik API helpers (groups)
async function getAllGroupsRaw(options = {}) {
  const { includeHidden = false } = options || {};
  const r = await directoryRepo.searchGroupsPaged({
    includeHidden,
    page: 1,
    pageSize: 500,
  });
  return r.groups;
}

/**
 * Filter out USERS_HIDDEN_PREFIXES unless includeHiddenPrefixes is true.
 * Used by list endpoints and dashboard stats (single fetch + split in memory).
 */
function applyHiddenPrefixFilter(users, includeHiddenPrefixes) {
  if (includeHiddenPrefixes) return users;
  const hiddenPrefixes = getHiddenUserPrefixes();
  if (!hiddenPrefixes.length) return users;
  return users.filter((u) => {
    const username = String(u?.username || "").trim().toLowerCase();
    return !hiddenPrefixes.some((p) => username.startsWith(p));
  });
}

// Fetch all users, then:
// - page using Authentik's `pagination` object (no hard cap on total)
// - hide service/system users by username prefix (USERS_HIDDEN_PREFIXES), unless includeHiddenPrefixes
// - optionally filter by AUTHENTIK_USER_PATH if set
async function getAllUsersRaw(options = {}) {
  const { includeHiddenPrefixes = false } = options;
  const r = await directoryRepo.searchUsersPaged({
    includeHiddenPrefixes,
    includeGroups: true,
    page: 1,
    pageSize: 100,
  });
  return r.users;
}

async function getAllUsersLightweightRaw(options = {}) {
  const { includeHiddenPrefixes = false, includeGroups = false } = options;
  const r = await directoryRepo.searchUsersPaged({
    includeHiddenPrefixes,
    includeGroups,
    page: 1,
    pageSize: 100,
  });
  return r.users;
}

async function userExists(username) {
  return directoryRepo.userExists(username);
}

// Main: Create user
async function createUser(
  {
    badge,
    agencySuffix,
    email,
    firstName,
    lastName,
    password,
    radioCallsign,
    templateIndex,
    manualGroupIds,
    role,
    /** "user" | "agency_admin" | "global_admin" — extra groups applied after template groups */
    permissions,
    /** Agency suffixes to grant agency-admin groups (defaults to user's create agency) */
    managedAgencySuffixes,
    // Optional optimization: pass preloaded Authentik groups to avoid refetching for each user
    allGroups,
  },
  opts = {}
) {
  const {
    skipExistenceCheck = false,
    createdBy = null,
    creationMethod = "manual",
  } = opts;

  const createdAt = new Date().toISOString();
  let templateNameUsed = null;
  let templateRoleUsed = DEFAULT_ATAK_ROLE;

  // Normalize badge: trim, lowercase, remove all whitespace (including NBSP from Excel/CSV)
  const normalizedBadge = normalizeBadge(badge);

  // Validate normalized badge
  const badgeErr = validateBadgeNumber(normalizedBadge);
  if (badgeErr) throw new Error(badgeErr);

  // Keep server-side password validation consistent with reset-password.
  // (The UI validates too, but API callers could bypass the UI.)
  const pwd = String(password || "").trim();
  if (pwd) {
    const pwdErr = validatePassword(pwd);
    if (pwdErr) throw new Error(pwdErr);
  }

  const agencies = agenciesStore.load();
  const agency = agencies.find(
    a =>
      a.suffix.toLowerCase() === String(agencySuffix || "").toLowerCase()
  );
  if (!agency) throw new Error("Invalid agency");
  agenciesStore.assertAgencyActiveBySuffix(agency.suffix, agencies);

  const username = accessSvc.buildUsernameWithAgencyToken(normalizedBadge, agency);
  if (!skipExistenceCheck && await userExists(username)) {
    throw new Error("Username already exists");
  }

  const first = String(firstName || "").trim();
  const last = String(lastName || "").trim();
  const mail = String(email || "").trim();

  if (!first) throw new Error("First name required");
  if (!last) throw new Error("Last name required");

  if (mail) {
    const emailFmtErr = validateEmailFormatIfPresent(mail);
    if (emailFmtErr) throw new Error(emailFmtErr);
  }

  const name = `${last}, ${first}`;

  const perm = String(permissions || "user").trim().toLowerCase() || "user";

  const templateNameRaw = String(templateIndex || "").trim();
  const dynTemplates = getTemplatesForAgency(agency.suffix);

  const neededNames = [];
  const neededPks = [];
  if (templateNameRaw === "Manual Group Selection") {
    for (const x of Array.isArray(manualGroupIds) ? manualGroupIds : []) {
      const v = String(x).trim();
      if (!v) continue;
      if (/^\d+$/.test(v) || directoryRepo.isUuid(v)) neededPks.push(v);
      else neededNames.push(v);
    }
  } else {
    const selectedTemplate = dynTemplates.find(t =>
      String(t.name || "").trim().toLowerCase() === templateNameRaw.toLowerCase()
    );
    if (!selectedTemplate) {
      throw new Error(`Template "${templateNameRaw}" not found for agency.`);
    }
    for (const n of selectedTemplate.groups || []) {
      if (n) neededNames.push(String(n));
    }
  }
  if (perm === "agency_admin") {
    const suffixes = accessSvc.normalizeManagedAgencySuffixes(
      Array.isArray(managedAgencySuffixes) && managedAgencySuffixes.length
        ? managedAgencySuffixes
        : [agency.suffix],
      { allowedForActor: Array.isArray(opts.allowedAgencySuffixesForAssign) ? opts.allowedAgencySuffixesForAssign : null }
    );
    const agencies = agenciesStore.load();
    for (const sfx of suffixes.concat([String(agency.suffix || "").trim().toLowerCase()])) {
      const ag = agencies.find((a) => String(a.suffix || "").trim().toLowerCase() === String(sfx).trim().toLowerCase());
      if (!ag) continue;
      for (const n of accessSvc.getAllAgencyAdminGroupNames(ag) || []) neededNames.push(n);
    }
  }
  if (perm === "global_admin") {
    for (const n of String(getString("PORTAL_AUTH_REQUIRED_GROUP", "")).split(",")) {
      if (n.trim()) neededNames.push(n.trim());
    }
  }

  const fetched = [
    ...(Array.isArray(allGroups) ? allGroups : []),
    ...(await directoryRepo.getGroupsByNames(neededNames)),
    ...(await directoryRepo.getGroupsByPks(neededPks)),
  ];
  const allGroupsLocal = [...new Map(fetched.map((g) => [String(g.pk), g])).values()];

  const byPk = new Map(allGroupsLocal.map(g => [String(g.pk), g]));
  const byNameLower = new Map(
    allGroupsLocal.map(g => [String(g.name || "").trim().toLowerCase(), g])
  );

  let selectedGroups = [];
  if (templateNameRaw === "Manual Group Selection") {
    templateNameUsed = "Manual Group Selection";
    const raw = Array.isArray(manualGroupIds) ? manualGroupIds : [];
    selectedGroups = raw
      .map(x => String(x).trim())
      .filter(Boolean)
      .map(v => {
        const g1 = byPk.get(v);
        if (g1) return g1;
        const g2 = byPk.get(String(Number(v)));
        if (g2) return g2;
        return byNameLower.get(v.toLowerCase()) || null;
      })
      .filter(Boolean);
    if (!selectedGroups.length) {
      throw new Error("Manual group selection did not match any Authentik groups.");
    }
    templateRoleUsed = DEFAULT_ATAK_ROLE;
  } else {
    const selectedTemplate = dynTemplates.find(t =>
      String(t.name || "").trim().toLowerCase() === templateNameRaw.toLowerCase()
    );
    templateNameUsed = String(selectedTemplate.name || "").trim();
    templateRoleUsed = normalizeTakRole(selectedTemplate.role, DEFAULT_ATAK_ROLE);
    selectedGroups = (selectedTemplate.groups || [])
      .map(n => byNameLower.get(String(n).trim().toLowerCase()))
      .filter(Boolean);
  }

  let groupsToApply = [...new Map(selectedGroups.map(g => [g.pk, g])).values()];

  if (perm === "agency_admin" || perm === "global_admin") {
    const extra = [];
    if (perm === "agency_admin") {
      const actorScope = Array.isArray(opts.allowedAgencySuffixesForAssign)
        ? opts.allowedAgencySuffixesForAssign
        : null;
      let suffixes = accessSvc.normalizeManagedAgencySuffixes(
        Array.isArray(managedAgencySuffixes) && managedAgencySuffixes.length
          ? managedAgencySuffixes
          : [agency.suffix],
        { allowedForActor: actorScope }
      );
      if (!suffixes.includes(String(agency.suffix || "").trim().toLowerCase())) {
        suffixes = [...suffixes, String(agency.suffix || "").trim().toLowerCase()];
      }
      const adminPkSet = accessSvc.resolveAgencyAdminGroupIdsForSuffixes(suffixes, allGroupsLocal);
      for (const g of allGroupsLocal) {
        if (adminPkSet.has(String(g.pk))) extra.push(g);
      }
      if (!extra.length) {
        throw new Error("Cannot assign Agency Admin: agency admin group was not found in Authentik.");
      }
    } else {
      const raw = String(getString("PORTAL_AUTH_REQUIRED_GROUP", "")).trim();
      const nameList = raw.split(",").map(x => String(x || "").trim().toLowerCase()).filter(Boolean);
      for (const nm of nameList) {
        const g = byNameLower.get(nm);
        if (g) extra.push(g);
      }
      if (!extra.length) {
        throw new Error("Cannot assign Global Admin: global admin groups are not configured or not found in Authentik.");
      }
    }
    const mergedByPk = new Map(groupsToApply.map(g => [String(g.pk), g]));
    for (const g of extra) mergedByPk.set(String(g.pk), g);
    groupsToApply = [...mergedByPk.values()];
  }

  // Build payload
  const resolvedRole = String(role || "").trim()
    ? normalizeTakRole(role, DEFAULT_ATAK_ROLE)
    : normalizeTakRole(templateRoleUsed, DEFAULT_ATAK_ROLE);

  const attributes = {
    agency: agency.suffix,
    agency_name: agency.name,

    badge_number: normalizedBadge,
    agency_abbreviation: String(agency.groupPrefix || ""),
    agency_color: String(agency.color || ""),
    role: resolvedRole,
  };

  // who created the user
  if (createdBy && createdBy.username) {
    attributes.created_by_username = String(createdBy.username);
  }
  if (createdBy && createdBy.displayName) {
    attributes.created_by_display_name = String(createdBy.displayName);
  }

  // when / how / from which template
  attributes.created_at = createdAt;
  if (templateNameUsed) {
    attributes.created_template = templateNameUsed;
    attributes.current_template = templateNameUsed;
  }
  if (creationMethod) {
    attributes.created_method = String(creationMethod);
  }

  const radioCall = String(radioCallsign || "").trim();
  if (radioCall) {
    attributes.radio_callsign = radioCall;
  }

  const payload = {
    username,
    email: mail,
    name,
    is_active: true,
    attributes,
  };

  // Ensure created users land in the correct "folder" (path)
  const folderRaw = String(getString("AUTHENTIK_USER_PATH", "")).trim();
  if (folderRaw) payload.path = normalizePath(folderRaw);

  const groupPks = groupsToApply.map((g) => String(g.pk));
  const wait = opts.waitForOutbox !== false && opts.bulk !== true;

  const outboxId = await db.withTransaction(async (c) => {
    const local = await directoryRepo.insertLocalUser(
      {
        username: payload.username,
        name: payload.name,
        email: payload.email,
        path: payload.path || null,
        attributes: payload.attributes,
        isActive: true,
      },
      c
    );
    await directoryRepo.setUserMemberships(local.uuid || local.id, groupPks, c);
    return authentikOutbox.enqueue(
      {
        kind: "create_user",
        entityType: "user",
        entityId: local.uuid || local.id,
        username: payload.username,
        payload: {
          username: payload.username,
          email: payload.email,
          name: payload.name,
          path: payload.path,
          is_active: true,
          attributes: payload.attributes,
          groupPks,
          password: pwd || "",
          sendOnboardingEmail: true,
        },
      },
      c
    );
  });

  if (wait) {
    await authentikOutbox.waitForOutbox(outboxId, 8000);
  }

  let user = await directoryRepo.getUserByUsername(username);
  invalidateUsersCache();
  return { user, groups: groupsToApply };
}

const INTEGRATION_PREFIX = "nodered-";

function toSlug(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

/** Title slug: combine words to one, no dash (e.g. "Weather API" → "weatherapi"). */
function toTitleSlug(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** TAK streaming data feed name is title-only (no nodered-global- prefix); max length enforced by TAK. */
const STREAMING_DATA_FEED_NAME_MAX_LEN = 30;

/**
 * Derive the TAK Server streaming data feed `name` from the integration title.
 * Must match the client’s title-slug rules (letters/digits only).
 */
function getStreamingDataFeedNameForTitle(title) {
  const slug = toTitleSlug(title) || "integration";
  if (slug.length > STREAMING_DATA_FEED_NAME_MAX_LEN) {
    throw new Error(
      `Streaming data feed name (letters and numbers from the title) must be at most ${STREAMING_DATA_FEED_NAME_MAX_LEN} characters.`
    );
  }
  return slug;
}

function uniqueGroupIds(groupIds, groupId) {
  const ids = [];
  if (Array.isArray(groupIds)) ids.push(...groupIds);
  else if (groupIds != null && groupIds !== "") ids.push(groupIds);
  if (groupId != null && groupId !== "") ids.push(groupId);
  return [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))];
}

/**
 * Create an integration user (username prefix "nodered-") with one or more groups.
 * type: "global" | "state" | "county" | "agency". Scope values (state, county, agencySuffix) required when type matches.
 * Username is always lowercase, no spaces: e.g. nodered-state-ca-weather-api, nodered-agency-abc-myapi.
 */
async function createIntegrationUser(
  { type, title, groupId, groupIds, state, county, agencySuffix },
  opts = {}
) {
  const createdBy = opts.createdBy || null;

  const integrationType = String(type || "global").toLowerCase();
  const titleSlug = toTitleSlug(title) || "integration";

  let scopeSlug = "";
  if (integrationType === "agency") {
    const raw = String(agencySuffix || "").trim();
    if (!raw) throw new Error("Agency is required for agency integrations.");
    scopeSlug = toSlug(raw);
  } else if (integrationType === "county") {
    const raw = String(county || "").trim();
    if (!raw) throw new Error("County is required for county integrations.");
    scopeSlug = toSlug(raw);
  } else if (integrationType === "state") {
    const raw = String(state || "").trim();
    if (!raw) throw new Error("State is required for state integrations.");
    scopeSlug = toSlug(raw);
  }

  const username =
    integrationType === "global"
      ? `${INTEGRATION_PREFIX}global-${titleSlug}`
      : `${INTEGRATION_PREFIX}${integrationType}-${scopeSlug}-${titleSlug}`;

  if (await userExists(username)) {
    throw new Error(`Integration user "${username}" already exists.`);
  }

  const requestedIds = uniqueGroupIds(groupIds, groupId);
  if (!requestedIds.length) {
    throw new Error("At least one group is required.");
  }

  const selectedGroups = await directoryRepo.getGroupsByPks(requestedIds);
  if (selectedGroups.length !== requestedIds.length) {
    const have = new Set(selectedGroups.map((g) => String(g.pk)));
    const missing = requestedIds.filter((id) => !have.has(String(id)));
    if (missing.length) throw new Error("Selected group not found.");
  }

  const name = username;
  const attributes = {
    integration_type: "nodered",
    integration_scope: integrationType,
    integration_title: String(title || "").trim() || username,
    tak_integration_group: selectedGroups
      .map((g) => String(g.name || "").trim())
      .filter(Boolean)
      .join(","),
  };
  if (createdBy && createdBy.username) {
    attributes.created_by_username = String(createdBy.username);
  }
  if (createdBy && createdBy.displayName) {
    attributes.created_by_display_name = String(createdBy.displayName);
  }

  const payload = {
    username,
    email: "",
    name,
    is_active: true,
    attributes,
  };

  const folderRaw = String(getString("AUTHENTIK_USER_PATH", "")).trim();
  if (folderRaw) payload.path = normalizePath(folderRaw);

  const crypto = require("crypto");
  const randomPassword = `Int3gr4t10n!${crypto.randomBytes(8).toString("hex")}`;
  const groupPks = selectedGroups.map((g) => String(g.pk));
  const wait = opts.waitForOutbox !== false && opts.bulk !== true;

  const outboxId = await db.withTransaction(async (c) => {
    const local = await directoryRepo.insertLocalUser(
      {
        username: payload.username,
        name: payload.name,
        email: payload.email,
        path: payload.path || null,
        attributes: payload.attributes,
        isActive: true,
      },
      c
    );
    await directoryRepo.setUserMemberships(local.uuid || local.id, groupPks, c);
    return authentikOutbox.enqueue(
      {
        kind: "create_user",
        entityType: "user",
        entityId: local.uuid || local.id,
        username: payload.username,
        payload: {
          username: payload.username,
          email: payload.email,
          name: payload.name,
          path: payload.path,
          is_active: true,
          attributes: payload.attributes,
          groupPks,
          password: randomPassword,
          sendOnboardingEmail: false,
        },
      },
      c
    );
  });

  if (wait) {
    await authentikOutbox.waitForOutbox(outboxId, 8000);
  }

  invalidateUsersCache();
  const user = await directoryRepo.getUserByUsername(username);
  return { user, groups: selectedGroups };
}

/**
 * Return users whose username starts with the integration prefix (e.g. "nodered-").
 * Bypasses USERS_HIDDEN_PREFIXES so integration users are visible on the Integrations page.
 * Uses the lightweight list endpoint (same as dashboard) — not full getAllUsersRaw.
 */
async function findIntegrationUsers() {
  const r = await directoryRepo.searchUsersPaged({
    usernamePrefix: INTEGRATION_PREFIX,
    includeHiddenPrefixes: true,
    includeGroups: true,
    page: 1,
    pageSize: 200,
  });
  return r.users;
}

function agencyIntegrationUsernamePrefix(agencySuffix) {
  const sfx = toSlug(agencySuffix);
  if (!sfx) return "";
  return `${INTEGRATION_PREFIX}agency-${sfx}-`.toLowerCase();
}

function isAgencyIntegrationUser(user, agencySuffix) {
  const username = String(user?.username || "").trim().toLowerCase();
  if (!username.startsWith(INTEGRATION_PREFIX.toLowerCase())) return false;

  const prefix = agencyIntegrationUsernamePrefix(agencySuffix);
  if (!prefix || !username.startsWith(prefix)) return false;

  const scope = String(user?.attributes?.integration_scope || "")
    .trim()
    .toLowerCase();
  return !scope || scope === "agency";
}

async function findAgencyIntegrationUsersForSuffix(agencySuffix) {
  const integrations = await findIntegrationUsers();
  return integrations.filter((u) => isAgencyIntegrationUser(u, agencySuffix));
}

async function deleteIntegrationUser(userOrId) {
  const takSshSvc = require("./takSsh.service");

  const user =
    userOrId && typeof userOrId === "object" && (userOrId.pk != null || userOrId.id != null)
      ? userOrId
      : await getUserById(userOrId);

  const userId = String(user?.pk ?? user?.id ?? "").trim();
  const username = String(user?.username || "").trim().toLowerCase();
  if (!userId || !username.startsWith(INTEGRATION_PREFIX.toLowerCase())) {
    throw new Error("Not an integration user.");
  }

  const dataFeedName = user?.attributes?.tak_data_feed_name;
  if (dataFeedName && tak.isTakConfigured()) {
    try {
      const takClient = tak.buildTakAxios();
      await takClient.delete(`/api/datafeeds/${encodeURIComponent(dataFeedName)}`);
    } catch (err) {
      console.warn(
        `[integrations] Could not delete data feed "${dataFeedName}" for "${username}":`,
        err?.message || err
      );
    }
  }

  await takSshSvc.revokeIntegrationCertViaSshScript(username);
  try {
    takSshSvc.deleteStoredIntegrationCertFiles(username);
  } catch (_) {
    // ignore local cache cleanup errors
  }

  await deleteUser(userId, { ignoreLocks: true, skipTakCertRevoke: true });
  return { userId, username };
}

/**
 * One Authentik user-directory pass for dashboard stats (4000+ users: avoids doubling HTTP work).
 * Fetches with hidden-prefix accounts included, then derives visible totals + integration count in memory.
 */
async function fetchUsersForDashboardStats() {
  const all = await getAllUsersLightweightRaw({ includeHiddenPrefixes: true });
  const visibleUsers = applyHiddenPrefixFilter(all, false);
  const integrationPrefix = INTEGRATION_PREFIX.toLowerCase();
  let integrationCount = 0;
  for (const u of all) {
    const un = String(u?.username || "").toLowerCase();
    if (un.startsWith(integrationPrefix)) integrationCount += 1;
  }
  return { visibleUsers, integrationCount };
}

// Bulk CSV import
// This CSV format is intentionally minimal and strict:
// REQUIRED columns (case-insensitive):
//   badge
//   agency   (suffix or prefix)
//   firstName
//   lastName
//   password (may be blank)
//   template (name must exist for the agency)
// OPTIONAL columns (may be omitted entirely):
//   email — if non-blank, must be a valid email address
//   radioCallsign — if non-blank, sets Authentik attribute radio_callsign
//   role — if blank or omitted, use the template's role (same as UI).
// Rows that fail validation or Authentik creation are skipped; valid rows are still created.
// Existing users are *skipped* but reported back (not counted as failures).
async function importUsersFromCsvBuffer(buffer, opts = {}) {
  if (!buffer) throw new Error("No file uploaded");

  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;

  const allowedAgencySuffixes = Array.isArray(opts.allowedAgencySuffixes)
    ? opts.allowedAgencySuffixes.map((s) => String(s || "").trim().toLowerCase())
    : null;

  const createdBy = opts.createdBy || null;
  const creationMethod = opts.creationMethod || "csv";

  // Throttle progress callbacks to avoid taxing the system.
  let _lastProgressAt = 0;
  function reportProgress(payload) {
    if (!onProgress) return;
    const now = Date.now();
    // report at most 4x/sec, but always report final updates.
    const force = payload?.force === true;
    if (!force && now - _lastProgressAt < 250) return;
    _lastProgressAt = now;
    try {
      onProgress(payload);
    } catch (_) {
      // never allow progress reporting to break imports
    }
  }

  let rawText = buffer.toString("utf8");
  // Strip BOM so first column header/value is not "\ufeffbadge" or "\ufeff1234"
  if (rawText.charCodeAt(0) === 0xfeff) rawText = rawText.slice(1);
  if (!rawText.trim()) throw new Error("CSV file is empty");

  const lines = rawText
    .split(/\r?\n/)
    .map(l => String(l || "").trim())
    .filter(Boolean);

  if (lines.length < 2)
    throw new Error("CSV must include header + at least one data row");

  reportProgress({ phase: "parsing", total: Math.max(0, lines.length - 1), processed: 0, created: 0, skipped: 0, force: true });

  // ----------- Columns -----------
  const header = lines[0].split(",").map(h => h.trim().toLowerCase());
  const required = [
    "badge",
    "agency",
    "firstname",
    "lastname",
    "password",
    "template",
  ];

  for (const req of required) {
    if (!header.includes(req)) {
      throw new Error(`Missing required column: ${req}`);
    }
  }

  function get(parts, name) {
    const idx = header.indexOf(name);
    return idx >= 0 ? String(parts[idx] ?? "").trim() : "";
  }

  function getRadioCallsign(parts) {
    for (const key of ["radiocallsign", "radio_callsign", "radio callsign"]) {
      const v = get(parts, key);
      if (v) return v;
    }
    return "";
  }

  const agencies = agenciesStore.load();
  const rows = [];
  /** @type {Array<{ line: number, phase: string, messages: string[], badge?: string, email?: string, username?: string }>} */
  const failed = [];

  // Inform UI that we're validating (no network calls yet)
  reportProgress({
    phase: "validating",
    total: Math.max(0, lines.length - 1),
    processed: 0,
    created: 0,
    skipped: 0,
    force: true,
  });

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    const lineNum = i + 1;

    // Normalize badge so spaces/NBSP/weird chars from CSV (e.g. Excel) are stripped before validation and storage
    const badge = normalizeBadge(get(parts, "badge"));
    const agencyRaw = get(parts, "agency");
    const firstName = get(parts, "firstname");
    const lastName = get(parts, "lastname");
    const email = get(parts, "email");
    const password = get(parts, "password");
    const radioCallsign = getRadioCallsign(parts);
    const templateName = get(parts, "template");

    const rowErrors = [];

    const roleRaw = get(parts, "role");
    const roleResolved = resolveAllowedTakRoleInput(roleRaw);
    if (!roleResolved.ok) {
      rowErrors.push(
        `Invalid role "${roleRaw}". Expected one of: ${ALLOWED_TAK_ROLES.join(", ")}`
      );
    }

    if (!agencyRaw) rowErrors.push("Missing agency");
    if (!firstName) rowErrors.push("Missing first name");
    if (!lastName) rowErrors.push("Missing last name");
    if (!templateName) rowErrors.push("Missing template");

    const emailErr = validateEmailFormatIfPresent(email);
    if (emailErr) rowErrors.push(emailErr);

    // Badge/username base must match the same allowed characters as UI/backend validation.
    const badgeErr = validateBadgeNumber(badge);
    if (badgeErr) rowErrors.push(badgeErr);

    // Password: blank allowed. If non-blank, must pass validatePassword.
    if (password) {
      const pwdErr = validatePassword(password);
      if (pwdErr) rowErrors.push(pwdErr);
    }

    // Resolve agency (suffix or prefix / groupPrefix)
    let agency = null;
    let agencySuffix = "";
    if (agencyRaw) {
      const lower = agencyRaw.toLowerCase();
      agency =
        agencies.find(a => String(a.suffix || "").toLowerCase() === lower) ||
        agencies.find(a => String(a.groupPrefix || "").toLowerCase() === lower);

      if (!agency) {
        rowErrors.push(`Unknown agency "${agencyRaw}"`);
      } else {
        agencySuffix = String(agency.suffix || "").trim();

        if (allowedAgencySuffixes && allowedAgencySuffixes.length) {
          const sfxLower = String(agencySuffix || "").trim().toLowerCase();
          if (!allowedAgencySuffixes.includes(sfxLower)) {
            rowErrors.push(`You do not have access to agency "${agencyRaw}"`);
          }
        }
      }
    }

    // Template must exist for the resolved agency
    if (templateName && agencySuffix) {
      const dyn = getTemplatesForAgency(agencySuffix);
      const found = dyn.find(
        t =>
          String(t.name || "").trim().toLowerCase() ===
          String(templateName).trim().toLowerCase()
      );
      if (!found) {
        rowErrors.push(
          `Template "${templateName}" not found for agency "${agencySuffix}"`
        );
      }
    }

    if (rowErrors.length) {
      failed.push({
        line: lineNum,
        phase: "validation",
        messages: rowErrors,
        badge: badge || undefined,
        email: String(email || "").trim() || undefined,
      });
      reportProgress({
        phase: "validating",
        total: Math.max(0, lines.length - 1),
        processed: Math.max(0, i),
        created: 0,
        skipped: 0,
      });
      continue;
    }

    rows.push({
      lineNum,
      badge,
      agencySuffix,
      firstName,
      lastName,
      email,
      password,
      radioCallsign,
      templateName,
      /** Non-empty only when CSV specified a valid role; otherwise createUser uses template role */
      roleCsv: roleResolved.ok ? roleResolved.role : "",
    });

    // Light progress during validation/parsing
    reportProgress({
      phase: "validating",
      total: Math.max(0, lines.length - 1),
      processed: Math.max(0, i),
      created: 0,
      skipped: 0,
    });
  }

  reportProgress({ phase: "creating", total: rows.length, processed: 0, created: 0, skipped: 0, force: true });

  async function runWithConcurrencyLimit(items, limit, worker) {
    let index = 0;
    const workers = [];

    for (let i = 0; i < limit; i++) {
      workers.push(
        (async () => {
          while (true) {
            const current = index++;
            if (current >= items.length) break;
            await worker(items[current], current);
          }
        })()
      );
    }

    await Promise.all(workers);
  }

  const created = [];
  const skipped = [];
  let processed = 0;

  // Groups resolved per row via targeted SQL in createUser
  const allGroups = [];

  const defaultLimit = 5;
  const envVal = getInt("USER_IMPORT_CONCURRENCY", defaultLimit);
  const importConcurrency =
    Number.isFinite(envVal) && envVal > 0 && envVal <= 25 ? envVal : defaultLimit;

  // Use a modest concurrency to balance speed vs load on Authentik
  await runWithConcurrencyLimit(rows, importConcurrency, async row => {
    try {
      const dyn = getTemplatesForAgency(row.agencySuffix);

      const selectedTemplate = dyn.find(
        t =>
          String(t.name || "").trim().toLowerCase() ===
          String(row.templateName || "").trim().toLowerCase()
      );

      if (!selectedTemplate) {
        failed.push({
          line: row.lineNum,
          phase: "creation",
          messages: [
            `Template "${row.templateName}" not found during creation`,
          ],
          username: `${row.badge}${row.agencySuffix}`,
          badge: row.badge,
          email: String(row.email || "").trim() || undefined,
        });
        return;
      }

      const username = `${row.badge}${row.agencySuffix}`;

      // Option B behavior: if user already exists, skip but record it.
      if (await userExists(username)) {
        skipped.push({
          line: row.lineNum,
          username,
          reason: "Username already exists",
        });
        return;
      }

      // Use template name directly (no index math)
      const templateIndex = selectedTemplate.name;

      try {
        const result = await createUser(
          {
            badge: row.badge,
            agencySuffix: row.agencySuffix,
            email: row.email,
            firstName: row.firstName,
            lastName: row.lastName,
            password: row.password || undefined, // <- per-row password / no-password
            radioCallsign: row.radioCallsign || undefined,
            templateIndex,
            manualGroupIds: [],
            allGroups,
            role: row.roleCsv ? row.roleCsv : undefined,
          },
          {
            skipExistenceCheck: true,
            createdBy,
            creationMethod,
            bulk: true,
            waitForOutbox: false,
          }
        );

        const createdUsername =
          (result && result.user && result.user.username) || username;
        created.push({
          username: createdUsername,
          templateName: selectedTemplate
            ? String(selectedTemplate.name || row.templateName || "").trim()
            : row.templateName || "",
        });
      } catch (createErr) {
        failed.push({
          line: row.lineNum,
          phase: "creation",
          messages: [toSafeApiError(createErr)],
          username,
          badge: row.badge,
          email: String(row.email || "").trim() || undefined,
        });
      }
    } finally {
      processed += 1;
      reportProgress({
        phase: "creating",
        total: rows.length,
        processed,
        created: created.length,
        skipped: skipped.length,
      });
    }
  });

  reportProgress({
    phase: "done",
    total: rows.length,
    processed: rows.length,
    created: created.length,
    skipped: skipped.length,
    force: true,
  });

  failed.sort((a, b) => Number(a.line) - Number(b.line));

  invalidateUsersCache();
  try {
    const dashboardStatsCache = require("./dashboardStatsCache.service");
    dashboardStatsCache.refreshAfterUsersChanged();
  } catch (err) {
    console.warn(
      "[USERS] Dashboard stats refresh after CSV import failed:",
      err?.message || err
    );
  }
  return { count: created.length, created, skipped, failed };
}

// Search users
// - If no q provided -> returns all users (already filtered by folder)
async function findUsers({ q, forceRefresh = false } = {}) {
  const r = await directoryRepo.searchUsersPaged({
    q,
    page: 1,
    pageSize: 200,
    includeGroups: true,
    includeHiddenPrefixes: false,
  });
  return r.users;
}

function getAuthentikOrderingForUserSort({ sortKey, sortDir } = {}) {
  const key = String(sortKey || "").toLowerCase();
  const dir = String(sortDir || "asc").toLowerCase() === "desc" ? "desc" : "asc";

  // These are expected to match Authentik's User model fields for ordering.
  // If we can't map a sortKey safely, caller should avoid delegating.
  let orderingField = "username";
  if (key === "username") orderingField = "username";
  else if (key === "name") orderingField = "name";
  else if (key === "email") orderingField = "email";
  else if (key === "status") orderingField = "is_active";

  return dir === "desc" ? `-${orderingField}` : orderingField;
}

async function searchUsersPaged({
  q,
  page = 1,
  pageSize = 50,
  sortKey = "username",
  sortDir = "asc",
  currentTemplate,
} = {}) {
  return directoryRepo.searchUsersPaged({
    q,
    page,
    pageSize,
    sortKey,
    sortDir,
    currentTemplate,
    includeGroups: true,
  });
}

async function searchUsersByAgencyAbbreviationPaged({
  agencyAbbreviation,
  q,
  page = 1,
  pageSize = 50,
  sortKey = "username",
  sortDir = "asc",
  groupsByPk,
  includeRoles = false,
  includeGroups = true,
  currentTemplate,
} = {}) {
  const abbr = String(agencyAbbreviation || "").trim();
  if (!abbr) {
    return {
      users: [],
      total: 0,
      page: 1,
      pageSize,
      hasNext: false,
      hasPrev: false,
    };
  }

  return directoryRepo.searchUsersPaged({
    q,
    page,
    pageSize,
    sortKey,
    sortDir,
    currentTemplate,
    agencyAbbreviation: abbr,
    includeGroups,
  });

  const hiddenPrefixes = getHiddenUserPrefixes();
  const folderRaw = String(getString("AUTHENTIK_USER_PATH", "")).trim();

  const attrsFilter = { agency_abbreviation: abbr };
  const templateName = String(currentTemplate || "").trim();
  if (templateName) attrsFilter.current_template = templateName;

  const params = {
    page,
    page_size: pageSize,
    ordering: getAuthentikOrderingForUserSort({ sortKey, sortDir }),
    // Authentik filters JSON attributes via `attributes=<json>`.
    // See authentik/core/api/users.py UsersFilter.filter_attributes().
    attributes: JSON.stringify(attrsFilter),
    include_roles: includeRoles ? "true" : "false",
    include_groups: includeGroups ? "true" : "false",
  };

  // Reduce payload + align pagination totals with what the UI is allowed to see.
  if (hiddenPrefixes.length) {
    params.type = ["external", "internal"];
  }

  if (folderRaw) {
    params.path_startswith = normalizePath(folderRaw);
  }

  if (Array.isArray(groupsByPk) && groupsByPk.length) {
    const cleaned = groupsByPk.map((x) => String(x).trim()).filter(Boolean);
    // axios may serialize arrays in a way Authentik's filters don't accept.
    // In practice, the global-admin set is usually a single group; handle
    // that reliably as a scalar. If we have multiple, force fallback.
    if (cleaned.length > 1) {
      throw new Error("Delegated global-admin exclusion requires a single group PK");
    }
    if (cleaned.length === 1) params.groups_by_pk = cleaned[0];
  }

  if (q && String(q).trim()) {
    // Authentik supports "search" across username/email/etc.
    params.search = String(q).trim();
  }

  const res = await api.get("/core/users/", { params });
  const data = res?.data || {};
  const raw = Array.isArray(data.results) ? data.results : [];

  // Apply the same hidden-prefix/path filters used elsewhere.
  let users = raw.slice();

  if (hiddenPrefixes.length) {
    users = users.filter((u) => {
      const username = String(u?.username || "").trim().toLowerCase();
      return !hiddenPrefixes.some((p) => username.startsWith(p));
    });
  }

  if (folderRaw) {
    const target = normalizePath(folderRaw);
    users = users.filter((u) => {
      const up = normalizePath(u.path);
      return up === target || up.startsWith(target + "/");
    });
  }

  const pagination = data.pagination || {};
  let total = 0;

  if (pagination) {
    if (typeof pagination.count === "number") total = pagination.count;
    if (!total && typeof pagination.total === "number") total = pagination.total;
    if (!total && typeof pagination.total_items === "number")
      total = pagination.total_items;
  }

  if (!total && data && data.count != null) {
    const c = Number(data.count);
    if (!Number.isNaN(c) && c >= 0) total = c;
  }

  if (!total) total = users.length;

  // Adjust downward for hidden-prefix filtering when it affected this page.
  if (hiddenPrefixes.length) {
    const filteredOnPage = raw.length - users.length;
    if (filteredOnPage > 0 && total >= filteredOnPage) {
      total = total - filteredOnPage;
    }
  }

  const currentPage =
    typeof pagination.current === "number"
      ? pagination.current
      : Number(params.page) || 1;

  return {
    users,
    total,
    page: currentPage,
    pageSize,
    hasNext: Boolean(pagination.next ?? data.next),
    hasPrev: Boolean(pagination.previous ?? data.previous),
  };
}

async function listAllUsersByAgencySuffix(agencySuffix) {
  return directoryRepo.listUsersByAgencySuffix(agencySuffix);
}

async function searchUsersByAgencySuffixPaged({
  agencySuffix,
  q,
  page = 1,
  pageSize = 50,
  sortKey = "username",
  sortDir = "asc",
  groupsByPk,
  includeRoles = false,
  includeGroups = true,
  currentTemplate,
} = {}) {
  const sfx = String(agencySuffix || "").trim();
  if (!sfx) {
    return {
      users: [],
      total: 0,
      page: 1,
      pageSize,
      hasNext: false,
      hasPrev: false,
    };
  }

  return directoryRepo.searchUsersPaged({
    q,
    page,
    pageSize,
    sortKey,
    sortDir,
    currentTemplate,
    agencySuffix: sfx,
    includeGroups,
  });

  const hiddenPrefixesSuffix = getHiddenUserPrefixes();
  const hiddenPrefixes = getHiddenUserPrefixes();
  const folderRaw = String(getString("AUTHENTIK_USER_PATH", "")).trim();

  const attrsFilter = { agency: sfx };
  const templateName = String(currentTemplate || "").trim();
  if (templateName) attrsFilter.current_template = templateName;

  const params = {
    page,
    page_size: pageSize,
    ordering: getAuthentikOrderingForUserSort({ sortKey, sortDir }),
    // Authentik filters JSON attributes via `attributes=<json>`.
    // See authentik/core/api/users.py UsersFilter.filter_attributes().
    attributes: JSON.stringify(attrsFilter),
    include_roles: includeRoles ? "true" : "false",
    include_groups: includeGroups ? "true" : "false",
  };

  // Reduce payload + align pagination totals with what the UI is allowed to see.
  if (hiddenPrefixes.length) {
    // Match the logic used by searchUsersPaged() so totals reflect visible users.
    params.type = ["external", "internal"];
  }

  if (folderRaw) {
    params.path_startswith = normalizePath(folderRaw);
  }

  if (Array.isArray(groupsByPk) && groupsByPk.length) {
    const cleaned = groupsByPk.map((x) => String(x).trim()).filter(Boolean);
    if (cleaned.length > 1) {
      throw new Error("Delegated global-admin exclusion requires a single group PK");
    }
    if (cleaned.length === 1) params.groups_by_pk = cleaned[0];
  }

  if (q && String(q).trim()) {
    // For this fast path, we generally call with q empty (to preserve semantics).
    params.search = String(q).trim();
  }

  const res = await api.get("/core/users/", { params });
  const data = res?.data || {};
  const raw = Array.isArray(data.results) ? data.results : [];

  // Keep the same hidden-prefix/path enforcement as other paged helpers
  let users = raw.slice();

  // Apply prefix filter as a safety net in case the instance has custom naming.
  if (hiddenPrefixes.length) {
    users = users.filter((u) => {
      const username = String(u?.username || "").trim().toLowerCase();
      return !hiddenPrefixes.some((p) => username.startsWith(p));
    });
  }

  if (folderRaw) {
    const target = normalizePath(folderRaw);
    users = users.filter((u) => {
      const up = normalizePath(u.path);
      return up === target || up.startsWith(target + "/");
    });
  }

  const pagination = data.pagination || {};
  let total = 0;

  if (pagination && pagination.count != null) {
    const t = Number(pagination.count);
    if (!Number.isNaN(t) && t >= 0) total = t;
  }

  if (!total && data && data.count != null) {
    const c = Number(data.count);
    if (!Number.isNaN(c) && c >= 0) total = c;
  }

  if (!total) total = users.length;

  // Adjust downward for hidden-prefix filtering when it affected this page.
  if (hiddenPrefixes.length) {
    const filteredOnPage = raw.length - users.length;
    if (filteredOnPage > 0 && total >= filteredOnPage) {
      total = total - filteredOnPage;
    }
  }

  const currentPage =
    typeof pagination.current === "number"
      ? pagination.current
      : Number(params.page) || 1;

  return {
    users,
    total,
    page: currentPage,
    pageSize,
    hasNext: Boolean(pagination.next ?? data.next),
    hasPrev: Boolean(pagination.previous ?? data.previous),
  };
}

async function searchUsersByAgencyNamePaged({
  agencyName,
  q,
  page = 1,
  pageSize = 50,
  sortKey = "username",
  sortDir = "asc",
  groupsByPk,
  includeRoles = false,
  includeGroups = true,
  currentTemplate,
  activeOnly = false,
} = {}) {
  const name = String(agencyName || "").trim();
  if (!name) {
    return {
      users: [],
      total: 0,
      page: 1,
      pageSize,
      hasNext: false,
      hasPrev: false,
    };
  }

  return directoryRepo.searchUsersPaged({
    q,
    page,
    pageSize,
    sortKey,
    sortDir,
    currentTemplate,
    agencyName: name,
    includeGroups,
    activeOnly: activeOnly || undefined,
  });

  const hiddenPrefixes = getHiddenUserPrefixes();
  const templateName = String(currentTemplate || "").trim();
  if (templateName) attrsFilter.current_template = templateName;

  const params = {
    page,
    page_size: pageSize,
    ordering: getAuthentikOrderingForUserSort({ sortKey, sortDir }),
    // Authentik filters JSON attributes via `attributes=<json>`.
    // The create-user flow stores the full agency name under `attributes.agency_name`.
    attributes: JSON.stringify(attrsFilter),
    include_roles: includeRoles ? "true" : "false",
    include_groups: includeGroups ? "true" : "false",
  };

  if (activeOnly) params.is_active = true;

  if (hiddenPrefixes.length) {
    params.type = ["external", "internal"];
  }

  if (folderRaw) {
    params.path_startswith = normalizePath(folderRaw);
  }

  if (Array.isArray(groupsByPk) && groupsByPk.length) {
    const cleaned = groupsByPk.map((x) => String(x).trim()).filter(Boolean);
    if (cleaned.length > 1) {
      throw new Error("Delegated global-admin exclusion requires a single group PK");
    }
    if (cleaned.length === 1) params.groups_by_pk = cleaned[0];
  }

  if (q && String(q).trim()) {
    params.search = String(q).trim();
  }

  const res = await api.get("/core/users/", { params });
  const data = res?.data || {};
  const raw = Array.isArray(data.results) ? data.results : [];

  let users = raw.slice();

  if (hiddenPrefixes.length) {
    users = users.filter((u) => {
      const username = String(u?.username || "").trim().toLowerCase();
      return !hiddenPrefixes.some((p) => username.startsWith(p));
    });
  }

  if (folderRaw) {
    const target = normalizePath(folderRaw);
    users = users.filter((u) => {
      const up = normalizePath(u.path);
      return up === target || up.startsWith(target + "/");
    });
  }

  const pagination = data.pagination || {};
  let total = 0;

  if (pagination && pagination.count != null) {
    const t = Number(pagination.count);
    if (!Number.isNaN(t) && t >= 0) total = t;
  }

  if (!total && data && data.count != null) {
    const c = Number(data.count);
    if (!Number.isNaN(c) && c >= 0) total = c;
  }

  if (!total) total = users.length;

  if (hiddenPrefixes.length) {
    const filteredOnPage = raw.length - users.length;
    if (filteredOnPage > 0 && total >= filteredOnPage) {
      total = total - filteredOnPage;
    }
  }

  const currentPage =
    typeof pagination.current === "number"
      ? pagination.current
      : Number(params.page) || 1;

  return {
    users,
    total,
    page: currentPage,
    pageSize,
    hasNext: Boolean(pagination.next ?? data.next),
    hasPrev: Boolean(pagination.previous ?? data.previous),
  };
}

async function listAllUsersByAgencyName(agencyName, { activeOnly = false } = {}) {
  return directoryRepo.listUsersByAgencyName(agencyName, { activeOnly });
}

function getAgencyActiveConcurrency() {
  const defaultLimit = 5;
  const envVal = getInt("AGENCY_ACTIVE_CONCURRENCY", defaultLimit);
  return Number.isFinite(envVal) && envVal > 0 && envVal <= 25 ? envVal : defaultLimit;
}

function getTemplateSyncConcurrency() {
  const defaultLimit = 10;
  const envVal = getInt("TEMPLATE_SYNC_CONCURRENCY", defaultLimit);
  return Number.isFinite(envVal) && envVal > 0 && envVal <= 25 ? envVal : defaultLimit;
}

function getTemplateSyncFetchConcurrency() {
  const defaultLimit = 6;
  const envVal = getInt("TEMPLATE_SYNC_FETCH_CONCURRENCY", defaultLimit);
  return Number.isFinite(envVal) && envVal > 0 && envVal <= 12 ? envVal : defaultLimit;
}

async function runWithConcurrencyLimit(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return;

  let index = 0;
  const workers = [];
  const maxWorkers = Math.max(1, Math.min(Number(limit) || 1, list.length));

  for (let i = 0; i < maxWorkers; i++) {
    workers.push(
      (async () => {
        while (true) {
          const current = index++;
          if (current >= list.length) break;
          await worker(list[current], current);
        }
      })()
    );
  }

  await Promise.all(workers);
}

/**
 * Disable many agency users efficiently: one TAK cert fetch/verify pass, then
 * concurrent Authentik PATCH calls (no redundant GET per user).
 */
async function bulkDisableUsersForAgency(users) {
  const active = (Array.isArray(users) ? users : []).filter((u) => {
    const pk = u?.pk ?? u?.id;
    return pk != null && u?.is_active;
  });

  const toDisable = [];
  const failures = [];

  for (const user of active) {
    const userId = String(user.pk ?? user.id);
    if (isUserActionLocked(user?.username)) {
      failures.push({
        userId,
        error: `Actions are locked for user ${user?.username || userId}`,
      });
      continue;
    }
    toDisable.push(user);
  }

  const usernames = toDisable.map((u) => u.username).filter(Boolean);
  if (getBool("TAK_REVOKE_ON_DISABLE", true) && usernames.length) {
    await tak.revokeCertsForUsersBulk(usernames, { requireVerified: true });
  }

  const affectedIds = [];
  const concurrency = getAgencyActiveConcurrency();

  await runWithConcurrencyLimit(toDisable, concurrency, async (user) => {
    const userId = String(user.pk ?? user.id);
    try {
      await api.patch(`/core/users/${userId}/`, { is_active: false });
      affectedIds.push(userId);
    } catch (err) {
      failures.push({
        userId,
        error: err?.message || String(err),
      });
    }
  });

  invalidateUsersCache();

  if (failures.length) {
    const detail = failures
      .slice(0, 5)
      .map((f) => `${f.userId}: ${f.error}`)
      .join(" | ");
    throw new Error(
      `Failed to disable ${failures.length} user(s) for this agency. ${detail}${
        failures.length > 5 ? " | …" : ""
      }`
    );
  }

  return { affectedIds };
}

/**
 * Re-enable users previously disabled with an agency. Uses concurrent GET/PATCH
 * and sends re-enable emails for users that were inactive.
 */
async function bulkEnableUsersForAgency(userIds) {
  const ids = (Array.isArray(userIds) ? userIds : [])
    .map((id) => String(id).trim())
    .filter(Boolean);

  if (!ids.length) return { usersUpdated: 0 };

  const failures = [];
  const reenabledIds = [];
  const concurrency = getAgencyActiveConcurrency();

  await runWithConcurrencyLimit(ids, concurrency, async (userId) => {
    try {
      const user = await getUserById(userId);
      if (!user) return;

      if (isUserActionLocked(user?.username)) {
        throw new Error(`Actions are locked for user ${user?.username || userId}`);
      }

      if (user.is_active) return;

      await api.patch(`/core/users/${userId}/`, { is_active: true });
      reenabledIds.push(String(userId));

      try {
        await emailUserReenabled(user);
      } catch (e) {
        console.error("[EMAIL] user re-enabled notice failed:", e?.message || e);
      }
    } catch (err) {
      failures.push({
        userId: String(userId),
        error: err?.message || String(err),
      });
    }
  });

  if (reenabledIds.length > 0) invalidateUsersCache();

  if (failures.length) {
    const detail = failures
      .slice(0, 5)
      .map((f) => `${f.userId}: ${f.error}`)
      .join(" | ");
    throw new Error(
      `Failed to re-enable ${failures.length} user(s) for this agency. ${detail}${
        failures.length > 5 ? " | …" : ""
      }`
    );
  }

  return { usersUpdated: reenabledIds.length };
}

/**
 * Delete many agency users: bulk TAK cert revoke, then concurrent Authentik DELETE.
 */
async function bulkDeleteUsersForAgency(users) {
  const list = (Array.isArray(users) ? users : []).filter((u) => {
    const pk = u?.pk ?? u?.id;
    return pk != null;
  });

  const usernames = list.map((u) => u.username).filter(Boolean);
  if (usernames.length) {
    await tak.revokeCertsForUsersBulk(usernames, { requireVerified: true });
  }

  const deletedIds = [];
  const failures = [];
  const concurrency = getAgencyActiveConcurrency();

  await runWithConcurrencyLimit(list, concurrency, async (user) => {
    const userId = String(user.pk ?? user.id);
    try {
      await api.delete(`/core/users/${userId}/`);
      deletedIds.push(userId);
    } catch (err) {
      failures.push({
        userId,
        error: err?.message || String(err),
      });
    }
  });

  if (deletedIds.length > 0) invalidateUsersCache();

  if (failures.length) {
    const detail = failures
      .slice(0, 5)
      .map((f) => `${f.userId}: ${f.error}`)
      .join(" | ");
    throw new Error(
      `Failed to delete ${failures.length} user(s) for this agency. ${detail}${
        failures.length > 5 ? " | …" : ""
      }`
    );
  }

  return { deletedIds };
}

const AGENCY_DASHBOARD_USER_PAGE_SIZE = 300;

function userPassesAgencySuffixSafety(user, expectedAgencySuffix) {
  const expected = String(expectedAgencySuffix || "").trim().toLowerCase();
  if (!expected) return true;
  const attrs =
    user && typeof user.attributes === "object" && user.attributes ? user.attributes : {};
  const agency = String(attrs.agency || "").trim().toLowerCase();
  if (!agency) return true;
  return agency === expected;
}

async function countUsersByAgencyName(agencyName) {
  const name = String(agencyName || "").trim();
  if (!name) return 0;
  const page = await searchUsersByAgencyNamePaged({
    agencyName: name,
    page: 1,
    pageSize: 1,
    includeGroups: false,
  });
  return Number(page.total) || 0;
}

async function buildUsersByTemplateForAgencyName(agencyName, { expectedAgencySuffix } = {}) {
  const name = String(agencyName || "").trim();
  if (!name) return {};

  const counts = Object.create(null);
  let page = 1;
  let hasNext = true;

  while (hasNext) {
    const result = await searchUsersByAgencyNamePaged({
      agencyName: name,
      page,
      pageSize: AGENCY_DASHBOARD_USER_PAGE_SIZE,
      includeGroups: false,
    });

    for (const u of result.users || []) {
      if (!userPassesAgencySuffixSafety(u, expectedAgencySuffix)) continue;
      const attrs =
        u && typeof u.attributes === "object" && u.attributes ? u.attributes : {};
      let tmpl = String(attrs.current_template || "").trim();
      if (!tmpl) tmpl = "Manual Group Selection";
      counts[tmpl] = (counts[tmpl] || 0) + 1;
    }

    hasNext = result.hasNext;
    page += 1;
  }

  return counts;
}

async function resetPassword(userId, password) {
  await assertUserNotActionLocked(userId);
  const err = validatePassword(password);
  if (err) throw new Error(err);
  const user = await directoryRepo.getUserById(userId);
  if (!user) throw new Error("User not found");
  const outboxId = await authentikOutbox.enqueue({
    kind: "set_password",
    entityType: "user",
    entityId: user.uuid || user.id,
    authentikPk: user.authentik_pk,
    username: user.username,
    payload: { password, authentikPk: user.authentik_pk },
  });
  const waited = await authentikOutbox.waitForOutbox(outboxId, 8000);
  if (waited.done) {
    try {
      await emailPasswordChanged(user);
    } catch (e) {
      console.error("[EMAIL] password change notice failed:", e?.message || e);
    }
  }
  return true;
}

async function resendOnboardingEmail(userId) {
  const user = await getUserById(userId);

  if (!user) {
    throw new Error("User not found");
  }

  // Resolve the user's current groups
  const groupIds = Array.isArray(user.groups)
    ? user.groups.map(x => String(x))
    : [];

  const groups = await directoryRepo.getGroupsByPks(groupIds);

  // Determine whether the user already has a password
  const hasPassword = !!user.password_set;

  await emailUserCreated({
    user,
    groups,
    hasPassword,
  });

  return user;
}

async function updateEmail(userId, email) {
  await assertUserNotActionLocked(userId);
  const mail = String(email || "").trim();
  const user = await directoryRepo.getUserById(userId);
  if (!user) throw new Error("User not found");
  const outboxId = await db.withTransaction(async (c) => {
    await directoryRepo.updateLocalUser(user.uuid || user.id, { email: mail }, c);
    return authentikOutbox.enqueue(
      {
        kind: "patch_user",
        entityType: "user",
        entityId: user.uuid || user.id,
        authentikPk: user.authentik_pk,
        username: user.username,
        payload: { authentikPk: user.authentik_pk, patch: { email: mail } },
      },
      c
    );
  });
  await authentikOutbox.waitForOutbox(outboxId, 8000);
  return true;
}

async function setUserGroups(userId, groupIds, opts = {}) {
  const userBefore = await assertUserNotActionLocked(userId, opts);
  let ids = Array.isArray(groupIds)
    ? groupIds.map(x => String(x).trim()).filter(Boolean)
    : [];

  if (opts.preserveMutualAidGroups) {
    const mutualAidGroupIds = mutualAidStore.getMutualAidGroupIdSet();
    const before = Array.isArray(userBefore?.groups)
      ? userBefore.groups.map((x) => String(x).trim()).filter(Boolean)
      : [];
    const preserved = before.filter((id) => mutualAidGroupIds.has(id));
    ids = Array.from(new Set([...ids, ...preserved]));
  }

  const payload = { groups: ids };
  if (Object.prototype.hasOwnProperty.call(opts || {}, "currentTemplate")) {
    const currentTemplate = String(opts.currentTemplate || "").trim();
    const beforeAttrs =
      userBefore && userBefore.attributes && typeof userBefore.attributes === "object"
        ? userBefore.attributes
        : {};
    payload.attributes = {
      ...beforeAttrs,
      current_template: currentTemplate || "Manual Group Selection",
    };
  }
  const wait = opts.waitForOutbox !== false && opts.bulk !== true;
  const outboxId = await db.withTransaction(async (c) => {
    await directoryRepo.setUserMemberships(userBefore.uuid || userBefore.id, ids, c);
    if (payload.attributes) {
      await directoryRepo.updateLocalUser(userBefore.uuid || userBefore.id, { attributes: payload.attributes }, c);
    }
    return authentikOutbox.enqueue(
      {
        kind: "set_groups",
        entityType: "user",
        entityId: userBefore.uuid || userBefore.id,
        authentikPk: userBefore.authentik_pk,
        username: userBefore.username,
        payload: {
          authentikPk: userBefore.authentik_pk,
          groupPks: ids,
          patch: payload.attributes ? { attributes: payload.attributes } : undefined,
        },
      },
      c
    );
  });
  if (wait) await authentikOutbox.waitForOutbox(outboxId, 8000);

  invalidateUsersCache();

  // Notify user via debounced email (do not fail operation if email fails)
  try {
    scheduleDebouncedGroupsEmail({
      user: userBefore,
      beforeIds: userBefore?.groups || [],
      afterIds: ids,
    });
  } catch (e) {
    console.error(
      "[EMAIL] groups update notice (debounced) failed:",
      e?.message || e
    );
  }
  return ids;
}

async function toggleUserActive(userId, isActive) {
  await assertUserNotActionLocked(userId);

  let userBefore;
  try {
    userBefore = await getUserById(userId);
  } catch (e) {
    throw e;
  }
  const wasActive = !!userBefore?.is_active;

  if (isActive && !wasActive) {
    const suffix = accessSvc.resolveAgencySuffixFromUser(userBefore);
    if (suffix) {
      agenciesStore.assertAgencyActiveBySuffix(suffix);
    }
  }

  // If disabling, revoke + VERIFY TAK certs first (if enabled)
  if (!isActive) {
    const shouldRevoke = getBool("TAK_REVOKE_ON_DISABLE", true);

    if (shouldRevoke) {
      const user = userBefore;

      // Hard stop if revocation cannot be verified.
      // tak.service.js already no-ops safely if TAK_URL isn't set.
      await tak.revokeCertsForUser(user?.username, { requireVerified: true });
    }
  }

  const outboxId = await db.withTransaction(async (c) => {
    await directoryRepo.updateLocalUser(userBefore.uuid || userBefore.id, { is_active: !!isActive }, c);
    return authentikOutbox.enqueue(
      {
        kind: "patch_user",
        entityType: "user",
        entityId: userBefore.uuid || userBefore.id,
        authentikPk: userBefore.authentik_pk,
        username: userBefore.username,
        payload: { authentikPk: userBefore.authentik_pk, patch: { is_active: !!isActive } },
      },
      c
    );
  });
  await authentikOutbox.waitForOutbox(outboxId, 8000);

  invalidateUsersCache();

  if (isActive && !wasActive) {
    try {
      const userAfter = await getUserById(userId);
      await emailUserReenabled(userAfter);
    } catch (e) {
      console.error("[EMAIL] user re-enabled notice failed:", e?.message || e);
    }
  }

  return true;
}

async function deleteUser(userId, opts = {}) {
  // This will skip the lock check if opts.ignoreLocks === true
  const user = await assertUserNotActionLocked(userId, opts);
  // Revoke + VERIFY TAK certs BEFORE deleting the Authentik user
  // requireVerified defaults to true, but making it explicit is good.
  if (!opts.skipTakCertRevoke) {
    await tak.revokeCertsForUser(user?.username, { requireVerified: true });
  }

  const outboxId = await db.withTransaction(async (c) => {
    await directoryRepo.updateLocalUser(user.uuid || user.id, { pending_delete: true }, c);
    return authentikOutbox.enqueue(
      {
        kind: "delete_user",
        entityType: "user",
        entityId: user.uuid || user.id,
        authentikPk: user.authentik_pk,
        username: user.username,
        payload: { authentikPk: user.authentik_pk },
      },
      c
    );
  });
  await authentikOutbox.waitForOutbox(outboxId, 8000);
  invalidateUsersCache();
  return true;
}

async function updateName(userId, name) {
  await assertUserNotActionLocked(userId);
  const n = String(name || "").trim();
  if (!n) throw new Error("Name is required");
  const user = await directoryRepo.getUserById(userId);
  if (!user) throw new Error("User not found");
  const outboxId = await db.withTransaction(async (c) => {
    await directoryRepo.updateLocalUser(user.uuid || user.id, { name: n }, c);
    return authentikOutbox.enqueue(
      {
        kind: "patch_user",
        entityType: "user",
        entityId: user.uuid || user.id,
        authentikPk: user.authentik_pk,
        username: user.username,
        payload: { authentikPk: user.authentik_pk, patch: { name: n } },
      },
      c
    );
  });
  await authentikOutbox.waitForOutbox(outboxId, 8000);
}

// Fetch single user (if you don't already have it)
async function getUserById(userId) {
  return directoryRepo.getUserById(userId);
}

// Update specific attributes on a user (merging with existing)
async function updateUserAttributes(userId, changes) {
  await assertUserNotActionLocked(userId, { ignoreLocks: true });
  const user = await getUserById(userId);
  const newAttrs = { ...(user.attributes || {}), ...changes };
  const outboxId = await db.withTransaction(async (c) => {
    await directoryRepo.updateLocalUser(user.uuid || user.id, { attributes: newAttrs }, c);
    return authentikOutbox.enqueue(
      {
        kind: "patch_user",
        entityType: "user",
        entityId: user.uuid || user.id,
        authentikPk: user.authentik_pk,
        username: user.username,
        payload: { authentikPk: user.authentik_pk, patch: { attributes: newAttrs } },
      },
      c
    );
  });
  await authentikOutbox.waitForOutbox(outboxId, 8000);
  invalidateUsersCache();
  return newAttrs;
}

async function updateRadioCallsign(userId, radioCallsign) {
  await assertUserNotActionLocked(userId, { ignoreLocks: true });
  const user = await getUserById(userId);
  const newAttrs = { ...(user.attributes || {}) };
  const v = String(radioCallsign ?? "").trim();
  if (v) {
    newAttrs.radio_callsign = v;
  } else {
    delete newAttrs.radio_callsign;
  }
  const outboxId = await db.withTransaction(async (c) => {
    await directoryRepo.updateLocalUser(user.uuid || user.id, { attributes: newAttrs }, c);
    return authentikOutbox.enqueue(
      {
        kind: "patch_user",
        entityType: "user",
        entityId: user.uuid || user.id,
        authentikPk: user.authentik_pk,
        username: user.username,
        payload: { authentikPk: user.authentik_pk, patch: { attributes: newAttrs } },
      },
      c
    );
  });
  await authentikOutbox.waitForOutbox(outboxId, 8000);
  invalidateUsersCache();
  return newAttrs;
}

/**
 * Update users' `attributes.current_template` by exact agency + current_template match.
 * Uses Authentik attribute filtering first (single paginated query path), then patches only matches.
 */
async function bulkSetCurrentTemplateForAgencyUsers({
  agencySuffix,
  fromTemplate,
  toTemplate,
} = {}) {
  const sfx = String(agencySuffix || "").trim().toLowerCase();
  const from = String(fromTemplate || "").trim();
  const to = String(toTemplate || "").trim() || "Manual Group Selection";
  if (!sfx || !from) {
    return { matched: 0, updated: 0 };
  }

  const usersToUpdate = await directoryRepo.listUsersByTemplate(sfx, from);
  let updated = 0;
  for (const u of usersToUpdate) {
    const attrs = u?.attributes && typeof u.attributes === "object" ? u.attributes : {};
    const newAttrs = { ...attrs, current_template: to };
    await db.withTransaction(async (c) => {
      await directoryRepo.updateLocalUser(u.uuid || u.id, { attributes: newAttrs }, c);
      await authentikOutbox.enqueue(
        {
          kind: "patch_user",
          entityType: "user",
          entityId: u.uuid || u.id,
          authentikPk: u.authentik_pk,
          username: u.username,
          payload: { authentikPk: u.authentik_pk, patch: { attributes: newAttrs } },
        },
        c
      );
    });
    updated += 1;
  }

  if (updated > 0) invalidateUsersCache();
  return {
    matched: usersToUpdate.length,
    updated,
  };
}

function normalizeIdSet(arr) {
  return new Set(
    (Array.isArray(arr) ? arr : [])
      .map((x) => String(x || "").trim())
      .filter(Boolean)
  );
}

function idSetsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

function buildTemplateGroupSyncContext(allVisibleGroups) {
  const groups = Array.isArray(allVisibleGroups) ? allVisibleGroups : [];
  const byName = new Map(
    groups.map((g) => [
      String(g?.name || "").trim().toLowerCase(),
      String(g?.pk || "").trim(),
    ])
  );
  const visibleGroupIdSet = new Set(
    groups.map((g) => String(g?.pk || "").trim()).filter(Boolean)
  );
  const mutualAidGroupIds = mutualAidStore.getMutualAidGroupIdSet();
  return { byName, visibleGroupIdSet, mutualAidGroupIds };
}

function resolveTemplateGroupIds(templateGroupNames, syncCtx) {
  return Array.from(
    new Set(
      (Array.isArray(templateGroupNames) ? templateGroupNames : [])
        .map((n) => syncCtx.byName.get(String(n || "").trim().toLowerCase()) || "")
        .filter(Boolean)
    )
  );
}

/**
 * Fetch users by Authentik custom attributes (agency + current_template).
 * Relies on server-side attribute filtering to avoid scanning all users.
 */
async function fetchUsersByAgencyAndCurrentTemplate(agencySuffix, templateName) {
  const sfx = String(agencySuffix || "").trim().toLowerCase();
  const fromName = String(templateName || "").trim();
  if (!sfx || !fromName) return [];
  return directoryRepo.listUsersByTemplate(sfx, fromName);
}

function computeTemplateSyncWorkItem(
  user,
  {
    agencySuffix,
    fromTemplateName,
    toTemplateName,
    templateGroupNames,
    applyGroupOverwrite = false,
    syncCtx = null,
  } = {}
) {
  const sfx = String(agencySuffix || "").trim().toLowerCase();
  const fromName = String(fromTemplateName || "").trim();
  const toName = String(toTemplateName || "").trim() || fromName;

  const uid = String(user?.pk ?? user?.id ?? "").trim();
  if (!uid) return null;

  const attrs = user?.attributes && typeof user.attributes === "object" ? user.attributes : {};
  const currentTemplate = String(attrs.current_template || "").trim();
  const currentAgency = String(attrs.agency || "").trim().toLowerCase();
  if (currentTemplate !== fromName || currentAgency !== sfx) return null;

  const beforeGroups = Array.isArray(user?.groups) ? user.groups.map((x) => String(x)) : [];
  const beforeSet = normalizeIdSet(beforeGroups);
  let nextGroups = beforeGroups.slice();

  if (applyGroupOverwrite && syncCtx) {
    const targetVisibleTemplateGroupIds = resolveTemplateGroupIds(templateGroupNames, syncCtx);
    const preservedUnknown = beforeGroups.filter((id) => !syncCtx.visibleGroupIdSet.has(String(id)));
    const preservedMutualAid = beforeGroups.filter((id) => syncCtx.mutualAidGroupIds.has(String(id)));
    nextGroups = Array.from(
      new Set([
        ...preservedUnknown,
        ...preservedMutualAid,
        ...targetVisibleTemplateGroupIds,
      ])
    );
  }

  const nextSet = normalizeIdSet(nextGroups);
  const attrsChanged = currentTemplate !== toName;
  const groupsChanged = applyGroupOverwrite ? !idSetsEqual(beforeSet, nextSet) : false;

  if (!attrsChanged && !groupsChanged) return null;

  const payload = {
    attributes: {
      ...attrs,
      current_template: toName,
    },
  };
  if (groupsChanged) {
    payload.groups = nextGroups;
  }

  return {
    userId: uid,
    user,
    payload,
    beforeGroups,
    afterGroups: nextGroups,
    attrsChanged,
    groupsChanged,
  };
}

async function applyTemplateSyncWorkItems(workItems, { invalidateCache = true, onProgress } = {}) {
  const items = Array.isArray(workItems) ? workItems : [];
  if (!items.length) {
    return { updated: 0, groupsUpdated: 0, templateAttrUpdated: 0 };
  }

  const stats = { updated: 0, groupsUpdated: 0, templateAttrUpdated: 0 };
  const concurrency = getTemplateSyncConcurrency();
  const emitProgress = (extra = {}) => {
    if (typeof onProgress !== "function") return;
    onProgress({
      phase: "applying",
      total: items.length,
      processed: stats.updated,
      updated: stats.updated,
      groupsUpdated: stats.groupsUpdated,
      ...extra,
    });
  };

  emitProgress();

  await runWithConcurrencyLimit(items, concurrency, async (item) => {
    await api.patch(`/core/users/${item.userId}/`, item.payload);
    stats.updated += 1;
    if (item.attrsChanged) stats.templateAttrUpdated += 1;
    if (item.groupsChanged) {
      stats.groupsUpdated += 1;
      try {
        scheduleDebouncedGroupsEmail({
          user: item.user,
          beforeIds: item.beforeGroups,
          afterIds: item.afterGroups,
        });
      } catch (e) {
        // Never fail template sync because an email enqueue failed.
      }
    }
    emitProgress();
  });

  if (invalidateCache && stats.updated > 0) invalidateUsersCache();
  return stats;
}

/**
 * Sync users tied to a template after template save.
 * Efficient path:
 * - One paged Authentik query filtered by agency + current_template
 * - Group-centric membership updates (one PATCH per changed group, not per user)
 * - Concurrent attribute-only PATCHes when the template was renamed
 */
async function syncUsersForTemplateSave({
  agencySuffix,
  fromTemplateName,
  toTemplateName,
  templateGroupNames,
  applyGroupOverwrite = false,
  preloadedSyncCtx = null,
} = {}) {
  const sfx = String(agencySuffix || "").trim().toLowerCase();
  const fromName = String(fromTemplateName || "").trim();
  const toName = String(toTemplateName || "").trim() || fromName;
  if (!sfx || !fromName) {
    return { matched: 0, updated: 0, groupsUpdated: 0, templateAttrUpdated: 0 };
  }

  let syncCtx = preloadedSyncCtx;
  if (applyGroupOverwrite && !syncCtx) {
    const allVisibleGroups = await directoryRepo.listGroupsMatching({ includeHidden: false, limit: 500 });
    syncCtx = buildTemplateGroupSyncContext(allVisibleGroups);
  }

  const usersToSync = await fetchUsersByAgencyAndCurrentTemplate(sfx, fromName);
  const syncOpts = {
    agencySuffix: sfx,
    fromTemplateName: fromName,
    toTemplateName: toName,
    templateGroupNames,
    applyGroupOverwrite,
    syncCtx,
  };

  const workItems = [];
  for (const u of usersToSync) {
    const item = computeTemplateSyncWorkItem(u, syncOpts);
    if (item) workItems.push(item);
  }

  if (!workItems.length) {
    return {
      matched: usersToSync.length,
      updated: 0,
      groupsUpdated: 0,
      templateAttrUpdated: 0,
    };
  }

  if (!applyGroupOverwrite) {
    let templateAttrUpdated = 0;
    const updatedUsers = new Set();
    await runWithConcurrencyLimit(workItems, getTemplateSyncConcurrency(), async (item) => {
      await api.patch(`/core/users/${item.userId}/`, { attributes: item.payload.attributes });
      templateAttrUpdated += 1;
      updatedUsers.add(item.userId);
    });
    if (updatedUsers.size > 0) invalidateUsersCache();
    return {
      matched: usersToSync.length,
      updated: updatedUsers.size,
      groupsUpdated: 0,
      templateAttrUpdated,
    };
  }

  const addByGroup = new Map();
  const removeByGroup = new Map();
  const attrItems = [];
  const groupEmailItems = [];

  for (const item of workItems) {
    if (item.groupsChanged) {
      groupEmailItems.push(item);
      const beforeSet = normalizeIdSet(item.beforeGroups);
      const nextSet = normalizeIdSet(item.afterGroups);
      for (const gid of nextSet) {
        if (!beforeSet.has(gid)) {
          if (!addByGroup.has(gid)) addByGroup.set(gid, new Set());
          addByGroup.get(gid).add(item.userId);
        }
      }
      for (const gid of beforeSet) {
        if (!nextSet.has(gid)) {
          if (!removeByGroup.has(gid)) removeByGroup.set(gid, new Set());
          removeByGroup.get(gid).add(item.userId);
        }
      }
    }
    if (item.attrsChanged) {
      attrItems.push(item);
    }
  }

  const groupsSvc = require("./groups.service");
  const usersWithGroupChange = new Set();

  const removeJobs = Array.from(removeByGroup.entries());
  await runWithConcurrencyLimit(removeJobs, getTemplateSyncFetchConcurrency(), async ([groupId, pkSet]) => {
    const out = await groupsSvc.applyBulkGroupMembership(groupId, "remove", [...pkSet]);
    for (const pk of out?.affectedPks || []) {
      usersWithGroupChange.add(String(pk));
    }
  });

  const addJobs = Array.from(addByGroup.entries());
  await runWithConcurrencyLimit(addJobs, getTemplateSyncFetchConcurrency(), async ([groupId, pkSet]) => {
    const out = await groupsSvc.applyBulkGroupMembership(groupId, "add", [...pkSet]);
    for (const pk of out?.affectedPks || []) {
      usersWithGroupChange.add(String(pk));
    }
  });

  let templateAttrUpdated = 0;
  const updatedUsers = new Set(usersWithGroupChange);
  if (attrItems.length) {
    await runWithConcurrencyLimit(attrItems, getTemplateSyncConcurrency(), async (item) => {
      await api.patch(`/core/users/${item.userId}/`, { attributes: item.payload.attributes });
      templateAttrUpdated += 1;
      updatedUsers.add(item.userId);
    });
  }

  for (const item of groupEmailItems) {
    try {
      scheduleDebouncedGroupsEmail({
        user: item.user,
        beforeIds: item.beforeGroups,
        afterIds: item.afterGroups,
      });
    } catch (e) {
      // Never fail template sync because an email enqueue failed.
    }
  }

  if (updatedUsers.size > 0) invalidateUsersCache();

  return {
    matched: usersToSync.length,
    updated: updatedUsers.size,
    groupsUpdated: usersWithGroupChange.size,
    templateAttrUpdated,
  };
}

/**
 * Batch-sync users after bulk template group add/remove.
 * Loads Authentik groups once, fetches matched users per template in parallel,
 * then applies concurrent user PATCHes.
 */
async function syncUsersForBulkTemplateGroupUpdates(templates, { onProgress } = {}) {
  const emitProgress = (p) => {
    if (typeof onProgress === "function") onProgress(p);
  };

  const list = (Array.isArray(templates) ? templates : [])
    .map((t) => ({
      agencySuffix: String(t?.agencySuffix || "").trim().toLowerCase(),
      templateName: String(t?.name || t?.templateName || "").trim(),
      templateGroupNames: Array.isArray(t?.afterGroups) ? t.afterGroups : [],
    }))
    .filter((t) => t.agencySuffix && t.templateName);

  if (!list.length) {
    return {
      matched: 0,
      updated: 0,
      groupsUpdated: 0,
      templateAttrUpdated: 0,
      templatesProcessed: 0,
    };
  }

  emitProgress({
    phase: "loading_groups",
    total: list.length,
    processed: 0,
    matched: 0,
    updated: 0,
  });

  const syncCtx = buildTemplateGroupSyncContext(
    await directoryRepo.listGroupsMatching({ includeHidden: false, limit: 500 })
  );
  const fetchConcurrency = getTemplateSyncFetchConcurrency();
  const fetchJobs = list.map((t, i) => ({ t, i }));
  const usersByTemplate = new Array(list.length);

  emitProgress({
    phase: "fetching_users",
    total: list.length,
    processed: 0,
    matched: 0,
    updated: 0,
  });

  let fetchProcessed = 0;
  let matchedWhileFetching = 0;
  await runWithConcurrencyLimit(fetchJobs, fetchConcurrency, async (job) => {
    usersByTemplate[job.i] = await fetchUsersByAgencyAndCurrentTemplate(
      job.t.agencySuffix,
      job.t.templateName
    );
    fetchProcessed += 1;
    matchedWhileFetching += (usersByTemplate[job.i] || []).length;
    emitProgress({
      phase: "fetching_users",
      total: list.length,
      processed: fetchProcessed,
      matched: matchedWhileFetching,
      updated: 0,
    });
  });

  let matched = 0;
  const workItems = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const users = usersByTemplate[i] || [];
    matched += users.length;
    const syncOpts = {
      agencySuffix: t.agencySuffix,
      fromTemplateName: t.templateName,
      toTemplateName: t.templateName,
      templateGroupNames: t.templateGroupNames,
      applyGroupOverwrite: true,
      syncCtx,
    };
    for (const u of users) {
      const item = computeTemplateSyncWorkItem(u, syncOpts);
      if (item) workItems.push(item);
    }
  }

  emitProgress({
    phase: "matching",
    total: workItems.length,
    processed: workItems.length,
    matched,
    updated: 0,
  });

  const patchStats = await applyTemplateSyncWorkItems(workItems, {
    onProgress: (p) => {
      emitProgress({
        ...p,
        matched,
      });
    },
  });

  emitProgress({
    phase: "done",
    total: workItems.length,
    processed: patchStats.updated,
    matched,
    updated: patchStats.updated,
    groupsUpdated: patchStats.groupsUpdated,
  });

  return {
    matched,
    ...patchStats,
    templatesProcessed: list.length,
  };
}

/**
 * Fast path for bulk template group add/remove (groups page).
 * Matches users by agency + current_template attributes, then updates membership
 * with a single group-centric Authentik PATCH (same approach as agency mass assign).
 */
async function syncUsersForBulkTemplateGroupDelta({
  templates,
  groupName,
  action,
  onProgress,
} = {}) {
  const emitProgress = (p) => {
    if (typeof onProgress === "function") onProgress(p);
  };

  const normalizedAction = String(action || "").trim().toLowerCase() === "remove" ? "remove" : "add";
  const normalizedGroupName = String(groupName || "").trim();
  if (!normalizedGroupName) {
    throw new Error("Group name is required.");
  }

  const list = (Array.isArray(templates) ? templates : [])
    .map((t) => ({
      agencySuffix: String(t?.agencySuffix || "").trim().toLowerCase(),
      templateName: String(t?.name || t?.templateName || "").trim(),
    }))
    .filter((t) => t.agencySuffix && t.templateName);

  if (!list.length) {
    return {
      matched: 0,
      updated: 0,
      groupsUpdated: 0,
      templateAttrUpdated: 0,
      templatesProcessed: 0,
    };
  }

  emitProgress({
    phase: "loading_groups",
    total: list.length,
    processed: 0,
    matched: 0,
    updated: 0,
  });

  const syncCtx = buildTemplateGroupSyncContext(
    await directoryRepo.listGroupsMatching({ includeHidden: false, limit: 500 })
  );
  const targetGroupId = syncCtx.byName.get(normalizedGroupName.toLowerCase()) || "";
  if (!targetGroupId) {
    throw new Error(`Group not found: ${normalizedGroupName}`);
  }
  const targetGroupIdStr = String(targetGroupId);

  const fetchConcurrency = getTemplateSyncFetchConcurrency();
  const fetchJobs = list.map((t, i) => ({ t, i }));
  const usersByTemplate = new Array(list.length);

  emitProgress({
    phase: "fetching_users",
    total: list.length,
    processed: 0,
    matched: 0,
    updated: 0,
  });

  let fetchProcessed = 0;
  let matchedWhileFetching = 0;
  await runWithConcurrencyLimit(fetchJobs, fetchConcurrency, async (job) => {
    usersByTemplate[job.i] = await fetchUsersByAgencyAndCurrentTemplate(
      job.t.agencySuffix,
      job.t.templateName
    );
    fetchProcessed += 1;
    matchedWhileFetching += (usersByTemplate[job.i] || []).length;
    emitProgress({
      phase: "fetching_users",
      total: list.length,
      processed: fetchProcessed,
      matched: matchedWhileFetching,
      updated: 0,
    });
  });

  const userByPk = new Map();
  for (const users of usersByTemplate) {
    for (const u of users || []) {
      const pk = String(u?.pk ?? u?.id ?? "").trim();
      if (pk && !userByPk.has(pk)) userByPk.set(pk, u);
    }
  }
  const allUsers = Array.from(userByPk.values());
  const matched = allUsers.length;
  const allUserPks = allUsers
    .map((u) => String(u?.pk ?? u?.id ?? "").trim())
    .filter(Boolean);

  emitProgress({
    phase: "matching",
    total: allUserPks.length,
    processed: allUserPks.length,
    matched,
    updated: 0,
  });

  if (!allUserPks.length) {
    emitProgress({
      phase: "done",
      total: 0,
      processed: 0,
      matched: 0,
      updated: 0,
      groupsUpdated: 0,
    });
    return {
      matched: 0,
      updated: 0,
      groupsUpdated: 0,
      templateAttrUpdated: 0,
      templatesProcessed: list.length,
    };
  }

  emitProgress({
    phase: "applying",
    total: allUserPks.length,
    processed: 0,
    matched,
    updated: 0,
  });

  const groupsSvc = require("./groups.service");
  const bulkOut = await groupsSvc.applyBulkGroupMembership(
    targetGroupId,
    normalizedAction,
    allUserPks
  );
  const changed = Number(bulkOut?.changed || 0);
  const affectedPkSet = new Set(
    (Array.isArray(bulkOut?.affectedPks) ? bulkOut.affectedPks : []).map((pk) => String(pk))
  );

  if (changed > 0) {
    for (const u of allUsers) {
      const pk = String(u?.pk ?? u?.id ?? "").trim();
      if (!pk || !affectedPkSet.has(pk)) continue;
      try {
        const beforeGroups = (Array.isArray(u?.groups) ? u.groups : []).map((x) => String(x));
        const afterGroups =
          normalizedAction === "add"
            ? Array.from(new Set([...beforeGroups, targetGroupIdStr]))
            : beforeGroups.filter((id) => id !== targetGroupIdStr);
        scheduleDebouncedGroupsEmail({
          user: u,
          beforeIds: beforeGroups,
          afterIds: afterGroups,
        });
      } catch (e) {
        // Never fail template sync because an email enqueue failed.
      }
    }
    invalidateUsersCache();
  }

  emitProgress({
    phase: "done",
    total: allUserPks.length,
    processed: changed,
    matched,
    updated: changed,
    groupsUpdated: changed,
  });

  return {
    matched,
    updated: changed,
    groupsUpdated: changed,
    templateAttrUpdated: 0,
    templatesProcessed: list.length,
  };
}

// Add groups to a user (merge)
async function addUserGroups(userId, groupIds, opts = {}) {
  await assertUserNotActionLocked(userId);
  const idsToAdd = Array.isArray(groupIds)
    ? groupIds.map(x => String(x).trim()).filter(Boolean)
    : [];

  if (!idsToAdd.length)
    return (await getUserById(userId)).groups || [];

  const user = await getUserById(userId);
  const current = Array.isArray(user.groups)
    ? user.groups.map(x => String(x))
    : [];

  const merged = Array.from(new Set([...current, ...idsToAdd]));
  await setUserGroups(userId, merged, opts);
  return merged;
}

// Remove groups from a user
async function removeUserGroups(userId, groupIds, opts = {}) {
  await assertUserNotActionLocked(userId);
  const idsToRemove = new Set(
    Array.isArray(groupIds)
      ? groupIds.map(x => String(x).trim()).filter(Boolean)
      : []
  );

  const user = await getUserById(userId);
  const current = Array.isArray(user.groups)
    ? user.groups.map(x => String(x))
    : [];

  const remaining = current.filter(id => !idsToRemove.has(String(id)));
  await setUserGroups(userId, remaining, opts);
  return remaining;
}

let USERS_CACHE = null;
let USERS_CACHE_TS = 0;
let USERS_LIGHTWEIGHT_CACHE = null;
let USERS_LIGHTWEIGHT_CACHE_TS = 0;
let TEMPLATE_COUNTS_CACHE = null;
let TEMPLATE_COUNTS_CACHE_KEY = "";
let TEMPLATE_COUNTS_CACHE_TS = 0;
// TTL in seconds; defaults to 60s. Use 0 to disable caching and always hit Authentik.
// Cache is invalidated on create/delete/update so paging/sorting stays fast without stale data.
const USERS_CACHE_TTL_MS = (getInt("USERS_CACHE_TTL_SECONDS", 60) || 0) * 1000;
// Template user counts change less often than the full user list; longer TTL keeps Templates page snappy.
const TEMPLATE_COUNTS_CACHE_TTL_MS =
  (getInt("TEMPLATE_COUNTS_CACHE_TTL_SECONDS", 300) || 0) * 1000;

function invalidateUsersCache() {
  USERS_CACHE = null;
  USERS_CACHE_TS = 0;
  USERS_LIGHTWEIGHT_CACHE = null;
  USERS_LIGHTWEIGHT_CACHE_TS = 0;
  TEMPLATE_COUNTS_CACHE = null;
  TEMPLATE_COUNTS_CACHE_KEY = "";
  TEMPLATE_COUNTS_CACHE_TS = 0;
  try {
    require("./dashboardStatsCache.service").refreshAfterUsersChanged();
  } catch (_) {
    /* dashboard refresh is best-effort */
  }
}

function invalidateGroupsCache() {
  // Currently uncached, but keep function for symmetry / future use.
}

async function getAllUsers(options = {}) {
  const { forceRefresh = false } = options || {};

  // If caching is disabled via env, always hit Authentik directly.
  if (USERS_CACHE_TTL_MS <= 0) {
    return await getAllUsersRaw({});
  }

  const now = Date.now();
  const cacheValid =
    USERS_CACHE &&
    USERS_CACHE_TS &&
    now - USERS_CACHE_TS < USERS_CACHE_TTL_MS;

  if (!forceRefresh && cacheValid) {
    return USERS_CACHE;
  }

  const users = await getAllUsersRaw({});
  USERS_CACHE = users;
  USERS_CACHE_TS = now;
  return users;
}

async function getAllUsersLightweight(options = {}) {
  const { forceRefresh = false } = options || {};

  // If caching is disabled via env, always hit Authentik directly.
  if (USERS_CACHE_TTL_MS <= 0) {
    return await getAllUsersLightweightRaw({});
  }

  const now = Date.now();
  const cacheValid =
    USERS_LIGHTWEIGHT_CACHE &&
    USERS_LIGHTWEIGHT_CACHE_TS &&
    now - USERS_LIGHTWEIGHT_CACHE_TS < USERS_CACHE_TTL_MS;

  if (!forceRefresh && cacheValid) {
    return USERS_LIGHTWEIGHT_CACHE;
  }

  const users = await getAllUsersLightweightRaw({});
  USERS_LIGHTWEIGHT_CACHE = users;
  USERS_LIGHTWEIGHT_CACHE_TS = now;
  return users;
}

async function getAllGroups(options = {}) {
  // ignore forceRefresh; always reload
  return await getAllGroupsRaw(options);
}

/**
 * Fetch users who are in a single group via Authentik's groups_by_pk filter.
 * Used so we get accurate membership without relying on user.groups from list endpoints.
 */
async function fetchUsersByGroupId(groupId, options = {}) {
  const gid = String(groupId || "").trim();
  if (!gid) return [];
  const { includeHiddenPrefixes = false, ignoreUserPathFilter = false } = options;
  let users = [];
  const pageSize = 200;
  let page = 1;
  let url =
    `/core/users/?page=${page}&page_size=${pageSize}` +
    `&groups_by_pk=${encodeURIComponent(gid)}` +
    "&include_groups=false&include_roles=false";

  while (url) {
    const res = await api.get(url);
    const data = res?.data || {};
    const results = Array.isArray(data.results) ? data.results : [];
    users = users.concat(results);

    const pagination = data.pagination || {};
    if (pagination && pagination.next) {
      page = pagination.next;
      url =
        `/core/users/?page=${page}&page_size=${pageSize}` +
        `&groups_by_pk=${encodeURIComponent(gid)}` +
        "&include_groups=false&include_roles=false";
    } else if (data.next) {
      url = String(data.next).replace(`${getString("AUTHENTIK_URL", "")}/api/v3`, "");
    } else {
      url = null;
    }
  }

  if (!includeHiddenPrefixes) {
    const hiddenPrefixes = getHiddenUserPrefixes();
    if (hiddenPrefixes.length) {
      users = users.filter((u) => {
        const username = String(u?.username || "").trim().toLowerCase();
        return !hiddenPrefixes.some((p) => username.startsWith(p));
      });
    }
  }

  const folderRaw = String(getString("AUTHENTIK_USER_PATH", "")).trim();
  if (folderRaw && !ignoreUserPathFilter) {
    const target = normalizePath(folderRaw);
    users = users.filter((u) => {
      const up = normalizePath(u.path);
      return up === target || up.startsWith(target + "/");
    });
  }

  return users;
}

/**
 * Return users who belong to any of the given group IDs (for bulk email by groups).
 * Fetches per group via Authentik's groups_by_pk so membership is correct; merges and dedupes by user pk.
 */
async function getUsersByGroups(groupIds, options = {}) {
  const list = Array.isArray(groupIds) ? groupIds.map((id) => String(id).trim()).filter(Boolean) : [];
  if (!list.length) return [];
  const seenPk = new Set();
  const merged = [];
  for (const gid of list) {
    const groupUsers = await fetchUsersByGroupId(gid, options);
    for (const u of groupUsers) {
      const pk = u?.pk != null ? String(u.pk) : u?.id != null ? String(u.id) : null;
      if (pk && !seenPk.has(pk)) {
        seenPk.add(pk);
        merged.push(u);
      }
    }
  }
  return merged;
}

/**
 * Return users whose username is in the given list (for bulk email by usernames).
 */
async function getUsersByUsernames(usernames, options = {}) {
  const list = Array.isArray(usernames) ? usernames.map((n) => String(n).trim()).filter(Boolean) : [];
  if (!list.length) return [];
  return directoryRepo.getUsersByUsernames(list);
}

async function backfillMissingUserRoles({ dryRun = true } = {}) {
  const users = await getAllUsersRaw({ includeHiddenPrefixes: true });
  const list = Array.isArray(users) ? users : [];
  const sampleUsers = [];
  const skippedUsers = [];
  let updated = 0;
  let skipped = 0;

  for (const user of list) {
    if (shouldSkipRoleBackfillForUser(user)) {
      skipped += 1;
      if (skippedUsers.length < 100) {
        skippedUsers.push(String(user?.username || user?.pk || ""));
      }
      continue;
    }

    const attrs = user?.attributes || {};
    const roleValue = String(attrs.role || "").trim();
    if (roleValue) continue;

    const newAttrs = {
      ...attrs,
      role: DEFAULT_ATAK_ROLE,
    };

    if (!dryRun) {
      try {
        await api.patch(`/core/users/${user.pk}/`, { attributes: newAttrs });
      } catch (err) {
        // Ignore accounts Authentik will not allow us to update (common for internal service accounts).
        skipped += 1;
        if (skippedUsers.length < 100) {
          skippedUsers.push(String(user?.username || user?.pk || ""));
        }
        continue;
      }
    }

    updated += 1;
    if (sampleUsers.length < 100) {
      sampleUsers.push(String(user?.username || user?.pk || ""));
    }
  }

  if (!dryRun && updated > 0) {
    invalidateUsersCache();
  }

  return {
    defaultRole: DEFAULT_ATAK_ROLE,
    scanned: list.length,
    updated,
    skipped,
    dryRun: !!dryRun,
    sampleUsers,
    skippedUsers,
  };
}

async function getMissingUserRoleStats() {
  const users = await getAllUsersRaw({ includeHiddenPrefixes: true });
  const list = Array.isArray(users) ? users : [];
  let missing = 0;
  let skipped = 0;
  const sampleUsers = [];
  const skippedUsers = [];

  for (const user of list) {
    if (shouldSkipRoleBackfillForUser(user)) {
      skipped += 1;
      if (skippedUsers.length < 25) {
        skippedUsers.push(String(user?.username || user?.pk || ""));
      }
      continue;
    }

    const attrs = user?.attributes || {};
    const roleValue = String(attrs.role || "").trim();
    if (roleValue) continue;
    missing += 1;
    if (sampleUsers.length < 25) {
      sampleUsers.push(String(user?.username || user?.pk || ""));
    }
  }

  return {
    scanned: list.length,
    missing,
    skipped,
    needsBackfill: missing > 0,
    sampleUsers,
    skippedUsers,
    defaultRole: DEFAULT_ATAK_ROLE,
  };
}

async function getMissingUserRolePreviewRows() {
  const users = await getAllUsersRaw({ includeHiddenPrefixes: true });
  const list = Array.isArray(users) ? users : [];
  const rows = [];

  for (const user of list) {
    const attrs = user?.attributes || {};
    const username = String(user?.username || "").trim();
    const displayName = String(user?.name || "").trim();
    const userId = String(user?.pk || user?.id || "").trim();
    const agencySuffix = String(
      attrs.agency || accessSvc.resolveAgencySuffixFromUser(user) || ""
    ).trim().toLowerCase();
    const currentRole = String(attrs.role || "").trim();

    if (shouldSkipRoleBackfillForUser(user)) {
      continue;
    }
    if (currentRole) continue;

    rows.push({
      username,
      displayName,
      userId,
      agencySuffix,
      currentRole: "",
      newRole: DEFAULT_ATAK_ROLE,
      action: "will_set_role",
    });
  }

  rows.sort((a, b) =>
    String(a.username || "").localeCompare(String(b.username || ""), undefined, {
      sensitivity: "base",
    })
  );
  return rows;
}

function idSetFromArray(arr) {
  return new Set(
    (Array.isArray(arr) ? arr : [])
      .map((x) => String(x || "").trim())
      .filter(Boolean)
  );
}

function idSetsMatchExact(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

function computeCurrentTemplateForUser({
  user,
  templatesByAgencySuffix,
  groupNameToId,
  visibleGroupIds,
  ignoredGroupIds = null,
} = {}) {
  const attrs = user?.attributes || {};
  const agencySuffix = String(attrs.agency || "").trim().toLowerCase();
  if (!agencySuffix) return null;

  const templates = Array.isArray(templatesByAgencySuffix.get(agencySuffix))
    ? templatesByAgencySuffix.get(agencySuffix)
    : [];

  const ignore =
    ignoredGroupIds instanceof Set ? ignoredGroupIds : loadMutualAidCreatedGroupIdSet();
  const userGroupIds = idSetFromArray(user?.groups || []);
  const userVisible = new Set(
    Array.from(userGroupIds).filter((id) => {
      const sid = String(id);
      if (!visibleGroupIds.has(sid)) return false;
      if (ignore.has(sid)) return false;
      return true;
    })
  );

  for (const t of templates) {
    const templateGroupNames = Array.isArray(t?.groups) ? t.groups : [];
    const tplVisibleIds = new Set();
    for (const gName of templateGroupNames) {
      const gid = groupNameToId.get(String(gName || "").trim().toLowerCase());
      if (!gid) continue;
      if (!visibleGroupIds.has(String(gid))) continue;
      tplVisibleIds.add(String(gid));
    }
    if (!tplVisibleIds.size) continue;
    if (idSetsMatchExact(tplVisibleIds, userVisible)) {
      return String(t?.name || "").trim() || "Manual Group Selection";
    }
  }

  return "Manual Group Selection";
}

/**
 * Recompute attributes.current_template for users in an agency after group/template renames.
 * Uses fresh group list + template definitions so template-prefill matching stays consistent.
 */
async function reconcileCurrentTemplateForAgencySuffix(agencySuffix) {
  const sfx = String(agencySuffix || "").trim().toLowerCase();
  if (!sfx) return { scanned: 0, updated: 0 };

  const templates = templatesStore.load();
  const templatesByAgencySuffix = new Map();
  for (const t of Array.isArray(templates) ? templates : []) {
    const ts = String(t?.agencySuffix || "").trim().toLowerCase();
    if (ts !== sfx) continue;
    if (!templatesByAgencySuffix.has(ts)) templatesByAgencySuffix.set(ts, []);
    templatesByAgencySuffix.get(ts).push(t);
  }

  const allGroups = await directoryRepo.listGroupsMatching({ includeHidden: false, limit: 500 });
  const groupNameToId = new Map(
    (Array.isArray(allGroups) ? allGroups : []).map((g) => [
      String(g?.name || "").trim().toLowerCase(),
      String(g?.pk || "").trim(),
    ])
  );
  const visibleGroupIds = new Set(
    (Array.isArray(allGroups) ? allGroups : [])
      .map((g) => String(g?.pk || "").trim())
      .filter(Boolean)
  );
  const mutualAidCreatedGroupIds = loadMutualAidCreatedGroupIdSet();

  let scanned = 0;
  let updated = 0;
  let page = 1;
  let hasNext = true;

  while (hasNext) {
    const params = {
      page,
      page_size: 200,
      include_groups: "true",
      include_roles: "false",
      attributes: JSON.stringify({ agency: sfx }),
    };

    const res = await api.get("/core/users/", { params });
    const data = res?.data || {};
    const rows = Array.isArray(data.results) ? data.results : [];

    for (const user of rows) {
      const attrs = user?.attributes && typeof user.attributes === "object" ? user.attributes : {};
      if (String(attrs.agency || "").trim().toLowerCase() !== sfx) continue;
      if (shouldSkipCurrentTemplateBackfillForUser(user)) continue;

      scanned += 1;
      const desired = computeCurrentTemplateForUser({
        user,
        templatesByAgencySuffix,
        groupNameToId,
        visibleGroupIds,
        ignoredGroupIds: mutualAidCreatedGroupIds,
      });
      if (desired == null) continue;

      const current = String(attrs.current_template || "").trim();
      if (current === desired) continue;

      const uid = String(user?.pk ?? user?.id ?? "").trim();
      if (!uid) continue;

      await api.patch(`/core/users/${uid}/`, {
        attributes: {
          ...attrs,
          current_template: desired,
        },
      });
      updated += 1;
    }

    const pagination = data.pagination || {};
    if (pagination && pagination.next) {
      page = pagination.next;
      hasNext = true;
    } else if (data.next) {
      page += 1;
      hasNext = true;
    } else {
      hasNext = false;
    }
  }

  if (updated > 0) invalidateUsersCache();
  return { scanned, updated };
}

async function getCurrentTemplateBackfillStats() {
  const users = await getAllUsersRaw({ includeHiddenPrefixes: true });
  const list = Array.isArray(users) ? users : [];
  const templates = templatesStore.load();
  const allGroups = await directoryRepo.listGroupsMatching({ includeHidden: false, limit: 500 });

  const groupNameToId = new Map(
    (Array.isArray(allGroups) ? allGroups : []).map((g) => [
      String(g?.name || "").trim().toLowerCase(),
      String(g?.pk || "").trim(),
    ])
  );
  const visibleGroupIds = new Set(
    (Array.isArray(allGroups) ? allGroups : [])
      .map((g) => String(g?.pk || "").trim())
      .filter(Boolean)
  );

  const templatesByAgencySuffix = new Map();
  for (const t of Array.isArray(templates) ? templates : []) {
    const sfx = String(t?.agencySuffix || "").trim().toLowerCase();
    if (!sfx) continue;
    if (!templatesByAgencySuffix.has(sfx)) templatesByAgencySuffix.set(sfx, []);
    templatesByAgencySuffix.get(sfx).push(t);
  }
  const mutualAidCreatedGroupIds = loadMutualAidCreatedGroupIdSet();

  let missing = 0;
  let mismatch = 0;
  let skipped = 0;
  const sampleUsers = [];

  for (const user of list) {
    if (shouldSkipCurrentTemplateBackfillForUser(user)) {
      skipped += 1;
      continue;
    }
    const desired = computeCurrentTemplateForUser({
      user,
      templatesByAgencySuffix,
      groupNameToId,
      visibleGroupIds,
      ignoredGroupIds: mutualAidCreatedGroupIds,
    });
    if (desired == null) {
      skipped += 1;
      continue;
    }
    const current = String(user?.attributes?.current_template || "").trim();
    if (!current) {
      missing += 1;
      if (sampleUsers.length < 25) sampleUsers.push(String(user?.username || user?.pk || ""));
      continue;
    }
    if (current !== desired) {
      mismatch += 1;
      if (sampleUsers.length < 25) sampleUsers.push(String(user?.username || user?.pk || ""));
    }
  }

  const needsBackfill = (missing + mismatch) > 0;
  return {
    scanned: list.length,
    missing,
    mismatch,
    skipped,
    needsBackfill,
    sampleUsers,
  };
}

async function backfillCurrentTemplateAttributes({ dryRun = true } = {}) {
  const users = await getAllUsersRaw({ includeHiddenPrefixes: true });
  const list = Array.isArray(users) ? users : [];
  const templates = templatesStore.load();
  const allGroups = await directoryRepo.listGroupsMatching({ includeHidden: false, limit: 500 });

  const groupNameToId = new Map(
    (Array.isArray(allGroups) ? allGroups : []).map((g) => [
      String(g?.name || "").trim().toLowerCase(),
      String(g?.pk || "").trim(),
    ])
  );
  const visibleGroupIds = new Set(
    (Array.isArray(allGroups) ? allGroups : [])
      .map((g) => String(g?.pk || "").trim())
      .filter(Boolean)
  );

  const templatesByAgencySuffix = new Map();
  for (const t of Array.isArray(templates) ? templates : []) {
    const sfx = String(t?.agencySuffix || "").trim().toLowerCase();
    if (!sfx) continue;
    if (!templatesByAgencySuffix.has(sfx)) templatesByAgencySuffix.set(sfx, []);
    templatesByAgencySuffix.get(sfx).push(t);
  }
  const mutualAidCreatedGroupIds = loadMutualAidCreatedGroupIdSet();

  let updated = 0;
  let skipped = 0;
  const sampleUsers = [];

  for (const user of list) {
    if (shouldSkipCurrentTemplateBackfillForUser(user)) {
      skipped += 1;
      continue;
    }
    const desired = computeCurrentTemplateForUser({
      user,
      templatesByAgencySuffix,
      groupNameToId,
      visibleGroupIds,
      ignoredGroupIds: mutualAidCreatedGroupIds,
    });
    if (desired == null) {
      skipped += 1;
      continue;
    }
    const current = String(user?.attributes?.current_template || "").trim();
    if (current === desired) continue;

    if (!dryRun) {
      const attrs = user?.attributes && typeof user.attributes === "object" ? user.attributes : {};
      try {
        await api.patch(`/core/users/${user.pk}/`, {
          attributes: {
            ...attrs,
            current_template: desired,
          },
        });
      } catch {
        skipped += 1;
        continue;
      }
    }
    updated += 1;
    if (sampleUsers.length < 100) sampleUsers.push(String(user?.username || user?.pk || ""));
  }

  if (!dryRun && updated > 0) invalidateUsersCache();
  return {
    scanned: list.length,
    updated,
    skipped,
    dryRun: !!dryRun,
    sampleUsers,
  };
}

async function getCurrentTemplateBackfillPreviewRows() {
  const users = await getAllUsersRaw({ includeHiddenPrefixes: true });
  const list = Array.isArray(users) ? users : [];
  const templates = templatesStore.load();
  const allGroups = await directoryRepo.listGroupsMatching({ includeHidden: false, limit: 500 });

  const groupNameToId = new Map(
    (Array.isArray(allGroups) ? allGroups : []).map((g) => [
      String(g?.name || "").trim().toLowerCase(),
      String(g?.pk || "").trim(),
    ])
  );
  const visibleGroupIds = new Set(
    (Array.isArray(allGroups) ? allGroups : [])
      .map((g) => String(g?.pk || "").trim())
      .filter(Boolean)
  );

  const templatesByAgencySuffix = new Map();
  for (const t of Array.isArray(templates) ? templates : []) {
    const sfx = String(t?.agencySuffix || "").trim().toLowerCase();
    if (!sfx) continue;
    if (!templatesByAgencySuffix.has(sfx)) templatesByAgencySuffix.set(sfx, []);
    templatesByAgencySuffix.get(sfx).push(t);
  }
  const mutualAidCreatedGroupIds = loadMutualAidCreatedGroupIdSet();

  const rows = [];
  for (const user of list) {
    const attrs = user?.attributes || {};
    const agencySuffix = String(attrs.agency || "").trim().toLowerCase();
    const current = String(attrs.current_template || "").trim();
    const username = String(user?.username || "").trim();
    const displayName = String(user?.name || "").trim();
    const userId = String(user?.pk || user?.id || "").trim();

    if (shouldSkipCurrentTemplateBackfillForUser(user)) {
      rows.push({
        username,
        displayName,
        userId,
        agencySuffix,
        currentTemplate: current,
        computedTemplate: "",
        action: "skipped_mutual_aid_or_locked",
      });
      continue;
    }

    const desired = computeCurrentTemplateForUser({
      user,
      templatesByAgencySuffix,
      groupNameToId,
      visibleGroupIds,
      ignoredGroupIds: mutualAidCreatedGroupIds,
    });

    if (desired == null) {
      rows.push({
        username,
        displayName,
        userId,
        agencySuffix,
        currentTemplate: current,
        computedTemplate: "",
        action: "skipped_no_agency",
      });
      continue;
    }

    rows.push({
      username,
      displayName,
      userId,
      agencySuffix,
      currentTemplate: current,
      computedTemplate: desired,
      action: current === desired ? "no_change" : "would_update",
    });
  }
  return rows;
}

async function getCurrentTemplateCountsByTemplate(options = {}) {
  const { allowedAgencySuffixes = null } = options || {};
  const allowedSet = Array.isArray(allowedAgencySuffixes)
    ? new Set(
        allowedAgencySuffixes
          .map((s) => String(s || "").trim().toLowerCase())
          .filter(Boolean)
      )
    : null;
  const cacheKey = allowedSet
    ? Array.from(allowedSet).sort().join("|")
    : "*global*";

  if (TEMPLATE_COUNTS_CACHE_TTL_MS > 0) {
    const now = Date.now();
    const cacheValid =
      TEMPLATE_COUNTS_CACHE &&
      TEMPLATE_COUNTS_CACHE_KEY === cacheKey &&
      TEMPLATE_COUNTS_CACHE_TS &&
      now - TEMPLATE_COUNTS_CACHE_TS < TEMPLATE_COUNTS_CACHE_TTL_MS;
    if (cacheValid) {
      return TEMPLATE_COUNTS_CACHE;
    }
  }

  const users = await getAllUsersLightweight({});
  const list = Array.isArray(users) ? users : [];
  const counts = Object.create(null);

  for (const u of list) {
    const attrs = (u && typeof u.attributes === "object" && u.attributes) ? u.attributes : {};
    const agencySuffix = String(attrs.agency || "").trim().toLowerCase();
    const currentTemplate = String(attrs.current_template || "").trim();
    if (!agencySuffix || !currentTemplate) continue;
    if (allowedSet && !allowedSet.has(agencySuffix)) continue;
    if (currentTemplate === "Manual Group Selection") continue;

    const key = `${agencySuffix}::${currentTemplate.toLowerCase()}`;
    counts[key] = Number(counts[key] || 0) + 1;
  }

  if (TEMPLATE_COUNTS_CACHE_TTL_MS > 0) {
    TEMPLATE_COUNTS_CACHE = counts;
    TEMPLATE_COUNTS_CACHE_KEY = cacheKey;
    TEMPLATE_COUNTS_CACHE_TS = Date.now();
  }

  return counts;
}

function splitDisplayName(full) {
  const t = String(full || "").trim();
  if (!t) return { first: "", last: "" };

  if (t.includes(",")) {
    const [last, first] = t.split(",").map((x) => String(x || "").trim());
    return { first, last };
  }

  const parts = t.split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: "" };
  const last = parts.pop();
  const first = parts.join(" ");
  return { first, last };
}

function csvEscapeCell(value) {
  const s = String(value == null ? "" : value);
  return `"${s.replace(/"/g, '""')}"`;
}

function stripTakPrefixForUserExport(name) {
  const n = String(name || "").trim();
  if (n.toLowerCase().startsWith("tak_")) return n.slice(4);
  return n;
}

function getHiddenGroupPrefixes() {
  return String(getString("GROUPS_HIDDEN_PREFIXES", "") || "")
    .split(",")
    .map((p) => String(p || "").trim().toLowerCase())
    .filter(Boolean);
}

function isGroupNameHiddenByPrefix(groupName, hiddenPrefixes) {
  const prefixes = Array.isArray(hiddenPrefixes) ? hiddenPrefixes : getHiddenGroupPrefixes();
  if (!prefixes.length) return false;

  const raw = String(groupName || "").trim().toLowerCase();
  const withoutTak = raw.startsWith("tak_") ? raw.slice(4) : raw;

  return prefixes.some(
    (prefix) => raw.startsWith(prefix) || withoutTak.startsWith(prefix)
  );
}

function resolvePortalPermissionLabel(user, { globalAdminGroupPks, groupNameByPk }) {
  const groups = Array.isArray(user?.groups) ? user.groups.map(String) : [];
  const globalSet = new Set((globalAdminGroupPks || []).map(String));
  if (groups.some((gid) => globalSet.has(gid))) return "Global Admin";

  for (const gid of groups) {
    const name = String(groupNameByPk.get(String(gid)) || "")
      .trim()
      .toLowerCase();
    if (name && name.endsWith("-agencyadmin")) return "Agency Admin";
  }

  return "Standard User";
}

function formatUserGroupMemberships(user, groupNameByPk, hiddenGroupPrefixes) {
  const groups = Array.isArray(user?.groups) ? user.groups.map(String) : [];
  const hiddenPrefixes =
    hiddenGroupPrefixes === undefined ? getHiddenGroupPrefixes() : hiddenGroupPrefixes;

  return groups
    .map((gid) => {
      const raw = groupNameByPk.get(String(gid));
      if (!raw || isGroupNameHiddenByPrefix(raw, hiddenPrefixes)) return "";
      return stripTakPrefixForUserExport(raw);
    })
    .filter(Boolean)
    .sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
    )
    .join("; ");
}

/**
 * Build a CSV export for the users list (RFC 4180-style quoted fields).
 */
function buildUsersExportCsv(users, options = {}) {
  const {
    groupNameByPk = new Map(),
    globalAdminGroupPks = [],
    agencyNameByAbbr = new Map(),
    hiddenGroupPrefixes = getHiddenGroupPrefixes(),
  } = options;

  const header = [
    "Username",
    "First",
    "Last",
    "Radio Callsign",
    "Email",
    "Agency",
    "Template",
    "Role",
    "Permissions",
    "Status",
    "Groups",
  ];

  const lines = [header.map(csvEscapeCell).join(",")];

  for (const user of Array.isArray(users) ? users : []) {
    const attrs = user?.attributes || {};
    const { first, last } = splitDisplayName(user?.name || "");
    const abbr = String(
      attrs.agency_abbreviation ||
        attrs.agencyAbbreviation ||
        attrs.agencyAbbr ||
        attrs.agencyabbr ||
        ""
    )
      .trim()
      .toLowerCase();
    const agency =
      agencyNameByAbbr.get(abbr) ||
      String(attrs.agency_name || "").trim() ||
      (abbr ? abbr.toUpperCase() : "");

    const row = [
      user?.username || "",
      first,
      last,
      String(attrs.radio_callsign || "").trim(),
      user?.email || "",
      agency,
      String(attrs.current_template || "").trim() || "Manual Group Selection",
      normalizeTakRole(attrs.role, DEFAULT_ATAK_ROLE),
      resolvePortalPermissionLabel(user, { globalAdminGroupPks, groupNameByPk }),
      user?.is_active ? "Active" : "Disabled",
      formatUserGroupMemberships(user, groupNameByPk, hiddenGroupPrefixes),
    ];

    lines.push(row.map(csvEscapeCell).join(","));
  }

  return `${lines.join("\n")}\n`;
}

module.exports = {
  // meta/template support
  getTemplatesForAgency,
  buildTakPortalBlock,
  emailUserCreated,

  // shared data
  getAllGroups,
  getAllUsers,
  getAllUsersLightweight,
  fetchUsersForDashboardStats,
  invalidateUsersCache,
  invalidateGroupsCache,

  // preference data for setup-my-device (Android Step 3)
  getPreferenceDataForUser,

  // user ops
  userExists,
  createUser,
  createIntegrationUser,
  getStreamingDataFeedNameForTitle,
  STREAMING_DATA_FEED_NAME_MAX_LEN,
  findIntegrationUsers,
  findAgencyIntegrationUsersForSuffix,
  deleteIntegrationUser,
  importUsersFromCsvBuffer,
  getUserById,
  findUsers,
  searchUsersPaged,
  searchUsersByAgencyAbbreviationPaged,
  searchUsersByAgencySuffixPaged,
  listAllUsersByAgencySuffix,
  searchUsersByAgencyNamePaged,
  listAllUsersByAgencyName,
  countUsersByAgencyName,
  buildUsersByTemplateForAgencyName,
  resetPassword,
  resendOnboardingEmail,
  updateEmail,
  updateName,
  setUserGroups,
  updateUserAttributes,
  updateRadioCallsign,
  backfillMissingUserRoles,
  getMissingUserRoleStats,
  getMissingUserRolePreviewRows,
  backfillCurrentTemplateAttributes,
  getCurrentTemplateBackfillStats,
  getCurrentTemplateBackfillPreviewRows,
  getCurrentTemplateCountsByTemplate,
  toggleUserActive,
  bulkDisableUsersForAgency,
  bulkEnableUsersForAgency,
  bulkDeleteUsersForAgency,
  deleteUser,
  addUserGroups,
  removeUserGroups,

  getUsersByGroups,
  getUsersByUsernames,
  buildUsersExportCsv,
  bulkSetCurrentTemplateForAgencyUsers,
  syncUsersForTemplateSave,
  syncUsersForBulkTemplateGroupUpdates,
  syncUsersForBulkTemplateGroupDelta,
  reconcileCurrentTemplateForAgencySuffix,
};
