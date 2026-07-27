const crypto = require("crypto");
const agenciesStore = require("./agencies.service");
const accessSvc = require("./access.service");
const store = require("./userRequests.store");
const emailSvc = require("./email.service");
const settingsSvc = require("./settings.service");
const usersSvc = require("./users.service");
const authentik = require("./authentik");

function genId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function genReviewToken() {
  return crypto.randomBytes(24).toString("hex");
}

function normalizeEmail(v) {
  return String(v || "").trim().toLowerCase();
}

function normalizeStr(v) {
  return String(v || "").trim();
}

/**
 * If the badge includes the agency username token (prefix or suffix), remove it
 * so the stored badge is token-free (username is built from badge + token on approval).
 */
function normalizeBadgeForUsername(badgeNumber) {
  return String(badgeNumber || "")
    .trim()
    .toLowerCase()
    .replace(/\p{White_Space}+/gu, "");
}

function buildUsernameForAgency(badgeNumber, agencyOrSuffix) {
  const badge = normalizeBadgeForUsername(badgeNumber);
  if (!badge) return "";
  if (agencyOrSuffix && typeof agencyOrSuffix === "object") {
    return accessSvc.buildUsernameWithAgencyToken(badge, agencyOrSuffix);
  }
  const suffix = normalizeStr(agencyOrSuffix);
  if (!suffix) return "";
  return accessSvc.buildUsernameWithAgencyToken(badge, suffix);
}

function userAlreadyExistsError() {
  const err = new Error(
    "An account with this badge number already exists. To login or to reset your password, visit the portal."
  );
  err.code = "USER_ALREADY_EXISTS";
  return err;
}

function pendingRequestExistsError() {
  const err = new Error(
    "An access request is already pending. Please check your email for updates from your administrator."
  );
  err.code = "ACCESS_REQUEST_PENDING";
  return err;
}

function findPendingDuplicateRequest(validated) {
  const all = store.load();
  const email = normalizeEmail(validated.email);
  const agencySuffix = normalizeStr(validated.agencySuffix).toLowerCase();
  const badgeNumber = normalizeBadgeForUsername(validated.badgeNumber);

  return (
    all.find((r) => {
      const rEmail = normalizeEmail(r.email);
      if (email && rEmail && email === rEmail) return true;

      if (agencySuffix && agencySuffix !== "__other__" && badgeNumber) {
        const rSuffix = normalizeStr(r.agencySuffix).toLowerCase();
        const rBadge = normalizeBadgeForUsername(r.badgeNumber);
        if (rSuffix === agencySuffix && rBadge === badgeNumber) return true;
      }

      return false;
    }) || null
  );
}

function stripMatchingAgencySuffixFromBadge(badgeNumber, agencySuffix, agency) {
  if (agency && typeof agency === "object") {
    return accessSvc.stripAgencyTokenFromBadge(badgeNumber, agency.suffix || agencySuffix, agency);
  }
  return accessSvc.stripAgencyTokenFromBadge(badgeNumber, agencySuffix);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getPortalBaseUrl() {
  try {
    const settings = settingsSvc.getSettings ? settingsSvc.getSettings() || {} : {};
    const direct = String(settings.TAK_PORTAL_PUBLIC_URL || "").trim();
    if (direct) return direct.replace(/\/+$/, "");
  } catch (_) {
    // ignore and fall back
  }
  return "";
}

const ALLOWED_REQUEST_STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID",
  "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS",
  "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
  "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
  "WI", "WY", "FED", "OTHER",
]);

function toTitleCaseWords(str) {
  return String(str || "")
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function normalizeCountyName(raw) {
  let v = String(raw || "").trim().replace(/\s+/g, " ");
  if (!v) return "";
  const lower = v.toLowerCase();
  if (lower.endsWith(" county")) {
    const base = v.slice(0, lower.lastIndexOf(" county"));
    return toTitleCaseWords(base);
  }
  return toTitleCaseWords(v);
}

function normalizeRequestedAgencyFields(input) {
  const sfRaw = String(input?.stateFederalAgency ?? "").trim().toLowerCase();
  const stateFederalAgency =
    sfRaw === "yes" || sfRaw === "true" || sfRaw === "1" || input?.stateFederalAgency === true;
  return {
    groupPrefix: normalizeStr(input.groupPrefix).toUpperCase(),
    usernameTokenPlacement: accessSvc.normalizeUsernameTokenPlacement(
      input.usernameTokenPlacement || "suffix"
    ),
    suffix: normalizeStr(input.suffix).toLowerCase(),
    state: normalizeStr(input.state).toUpperCase(),
    county: normalizeCountyName(input.county),
    countyAbbrev: normalizeStr(input.countyAbbrev).toUpperCase().replace(/[^A-Z]/g, ""),
    type: normalizeStr(input.type),
    stateFederalAgency: !!stateFederalAgency,
  };
}

function validateCreate(input) {
  const firstName = normalizeStr(input.firstName);
  const lastName = normalizeStr(input.lastName);
  const email = normalizeEmail(input.email);
  const agencySuffix = normalizeStr(input.agencySuffix);
  const agencies = agenciesStore.load();
  const agency =
    agencySuffix && agencySuffix !== "__other__"
      ? agencies.find(
          (a) => String(a?.suffix || "").toLowerCase() === agencySuffix.toLowerCase()
        ) || null
      : null;
  const badgeNumber = stripMatchingAgencySuffixFromBadge(
    input.badgeNumber,
    agencySuffix,
    agency
  );
  const radioCallsign = normalizeStr(input.radioCallsign);
  const otherAgency = normalizeStr(input.otherAgency);
  const otherReason = normalizeStr(input.otherReason);
  const requestedAgency = normalizeRequestedAgencyFields(input || {});

  if (!firstName) throw new Error("First Name is required");
  if (!lastName) throw new Error("Last Name is required");
  if (!email) throw new Error("Email Address is required");
  if (!/^\S+@\S+\.[A-Za-z]{2,}$/.test(email)) {
    throw new Error("Email Address must be valid");
  }
  if (!badgeNumber) throw new Error("Badge Number is required");
  if (!/^[A-Za-z0-9._-]+$/.test(badgeNumber)) {
    throw new Error("Badge Number can only contain letters, numbers, periods, dashes, and underscores");
  }
  if (!agencySuffix) throw new Error("Agency is required");

  const isOther = agencySuffix === "__other__";
  if (isOther) {
    if (!otherAgency) throw new Error("Please enter your agency name");
    if (!otherReason) throw new Error("Please enter your reason for requesting access");
    if (!requestedAgency.groupPrefix) throw new Error("Agency Abbreviation is required");
    if (!requestedAgency.suffix) throw new Error("Username Suffix/Prefix is required");
    if (!requestedAgency.state) throw new Error("State is required");
    if (!ALLOWED_REQUEST_STATES.has(requestedAgency.state)) {
      throw new Error("State is not valid");
    }
    if (!requestedAgency.stateFederalAgency) {
      if (!requestedAgency.county) throw new Error("County is required");
      if (!requestedAgency.countyAbbrev) throw new Error("County Abbreviation is required");
    }
    if (requestedAgency.countyAbbrev && requestedAgency.countyAbbrev.length < 2) {
      throw new Error("County Abbreviation must be at least 2 characters");
    }
    if (!requestedAgency.type) throw new Error("Agency Type is required");
  }

  if (!isOther) {
    if (!agency) throw new Error("Selected agency is not valid");
    if (!agenciesStore.isAgencyPublicEnrollmentEligible(agency)) {
      throw new Error(
        "The selected agency is not currently accepting access requests."
      );
    }

    const list = agenciesStore.domainsListFromStored(agency.lookupDomain);
    if (list.length > 0 && !agenciesStore.emailDomainInAgencyList(email, agency.lookupDomain)) {
      throw new Error(
        "The email provided does not match the selected agency's email domain"
      );
    }
  }

  return {
    firstName,
    lastName,
    email,
    badgeNumber,
    radioCallsign,
    agencySuffix,
    otherAgency,
    otherReason,
    groupPrefix: isOther ? requestedAgency.groupPrefix : null,
    usernameTokenPlacement: isOther ? requestedAgency.usernameTokenPlacement : null,
    suffix: isOther ? requestedAgency.suffix : null,
    state: isOther ? requestedAgency.state : null,
    county: isOther ? requestedAgency.county : null,
    countyAbbrev: isOther ? requestedAgency.countyAbbrev : null,
    type: isOther ? requestedAgency.type : null,
    stateFederalAgency: isOther ? !!requestedAgency.stateFederalAgency : null,
  };
}

function listRequests() {
  const all = store.load();
  return all
    .slice()
    .sort((a, b) =>
      String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
    );
}

function listRequestsForUser(authUser) {
  const user = authUser || null;

  if (user && user.isGlobalAdmin) return listRequests();

  if (user && user.isAgencyAdmin) {
    return listRequests().filter((r) =>
      accessSvc.isSuffixAllowed(user, r && r.agencySuffix)
    );
  }

  return [];
}

function countRequestsForUser(authUser) {
  return listRequestsForUser(authUser).length;
}

function countPendingRequestsForAgencySuffix(suffix) {
  const sfx = String(suffix || "").trim().toLowerCase();
  if (!sfx) return 0;
  return store.load().filter(
    (r) => String(r?.agencySuffix || "").trim().toLowerCase() === sfx
  ).length;
}

function deleteRequestsForAgencySuffix(suffix) {
  const sfx = String(suffix || "").trim().toLowerCase();
  if (!sfx) return 0;

  const all = store.load();
  const next = all.filter(
    (r) => String(r?.agencySuffix || "").trim().toLowerCase() !== sfx
  );
  const removed = all.length - next.length;
  if (removed > 0) store.save(next);
  return removed;
}

async function createRequest(input) {
  const v = validateCreate(input || {});
  const agencies = agenciesStore.load();

  const agency = agencies.find(
    (a) => String(a?.suffix || "").toLowerCase() === v.agencySuffix.toLowerCase()
  );

  if (findPendingDuplicateRequest(v)) {
    throw pendingRequestExistsError();
  }

  if (v.agencySuffix !== "__other__" && agency) {
    const username = buildUsernameForAgency(v.badgeNumber, agency);
    if (username && (await usersSvc.userExists(username))) {
      throw userAlreadyExistsError();
    }
  }

  const now = new Date().toISOString();

  const reqObj = {
    id: genId(),
    reviewToken: genReviewToken(),
    createdAt: now,
    firstName: v.firstName,
    lastName: v.lastName,
    email: v.email,
    badgeNumber: v.badgeNumber,
    radioCallsign: v.radioCallsign || null,
    agencySuffix: v.agencySuffix,
    agencyName: agency ? String(agency.name || "").trim() : null,
    otherAgency: v.agencySuffix === "__other__" ? v.otherAgency : null,
    otherReason: v.agencySuffix === "__other__" ? v.otherReason : null,
    groupPrefix: v.agencySuffix === "__other__" ? v.groupPrefix : null,
    usernameTokenPlacement:
      v.agencySuffix === "__other__" ? v.usernameTokenPlacement : null,
    suffix: v.agencySuffix === "__other__" ? v.suffix : null,
    state: v.agencySuffix === "__other__" ? v.state : null,
    county: v.agencySuffix === "__other__" ? v.county : null,
    countyAbbrev: v.agencySuffix === "__other__" ? v.countyAbbrev : null,
    type: v.agencySuffix === "__other__" ? v.type : null,
    stateFederalAgency: v.agencySuffix === "__other__" ? !!v.stateFederalAgency : null,
  };

  const all = store.load();
  all.push(reqObj);
  store.save(all);

  // ===============================
  // Email Notification Logic
  // ===============================
  try {
    let recipients = [];

    async function getUsersInGroup(groupName) {
      if (!groupName) return [];

      const groupResp = await authentik.get(
        `/core/groups/?name=${encodeURIComponent(groupName)}`
      );

      const group = groupResp.data?.results?.[0];
      if (!group) return [];

      const groupPk = group.pk;

      let users = [];
      let next = "/core/users/?page_size=200";

      while (next) {
        const resp = await authentik.get(next);
        const data = resp.data;

        users.push(...(data.results || []));

        next = data.next
          ? data.next.replace(/^.*\/api\/v3/, "")
          : null;
      }

      return users
        .filter(
          (u) =>
            Array.isArray(u.groups) &&
            u.groups.includes(groupPk) &&
            u.email
        )
        .map((u) => u.email);
    }

    // Try agency admins first
    if (v.agencySuffix !== "__other__" && agency) {
      const agencyAdminGroup =
        accessSvc.getAgencyAdminGroupName(agency);

      recipients = await getUsersInGroup(agencyAdminGroup);
    }

    // Fallback to global admins
    if (!recipients.length) {
      const settings = settingsSvc.getSettings();
      const globalGroup = settings.PORTAL_AUTH_REQUIRED_GROUP;
      recipients = await getUsersInGroup(globalGroup);
    }

    if (recipients.length) {
const reasonLine = reqObj.otherReason
  ? `Reason for requesting access: ${reqObj.otherReason}\n`
  : "";
const isOtherRequest = reqObj.agencySuffix === "__other__";
const otherAgencyDetailsText = isOtherRequest
  ? [
      `Agency Abbreviation: ${reqObj.groupPrefix || ""}`,
      `Username Identifier: ${reqObj.usernameTokenPlacement || "suffix"} (${reqObj.suffix || ""})`,
      `State: ${reqObj.state || ""}`,
      `State/Federal Agency: ${reqObj.stateFederalAgency ? "Yes" : "No"}`,
      `County: ${reqObj.county || ""}`,
      `County Abbreviation: ${reqObj.countyAbbrev || ""}`,
      `Agency Type: ${reqObj.type || ""}`,
    ].join("\n") + "\n"
  : "";
const otherAgencyDetailsHtml = isOtherRequest
  ? `
  <strong>Agency Abbreviation:</strong> ${escapeHtml(reqObj.groupPrefix || "")}<br/>
  <strong>Username Identifier:</strong> ${escapeHtml(reqObj.usernameTokenPlacement || "suffix")} (${escapeHtml(reqObj.suffix || "")})<br/>
  <strong>State:</strong> ${escapeHtml(reqObj.state || "")}<br/>
  <strong>State/Federal Agency:</strong> ${escapeHtml(reqObj.stateFederalAgency ? "Yes" : "No")}<br/>
  <strong>County:</strong> ${escapeHtml(reqObj.county || "")}<br/>
  <strong>County Abbreviation:</strong> ${escapeHtml(reqObj.countyAbbrev || "")}<br/>
  <strong>Agency Type:</strong> ${escapeHtml(reqObj.type || "")}<br/>
`
  : "";
const portalBaseUrl = getPortalBaseUrl();
const reviewPath = `/request-access/${reqObj.reviewToken}`;
const reviewUrl = portalBaseUrl ? `${portalBaseUrl}${reviewPath}` : reviewPath;
const safeReviewUrl = escapeHtml(reviewUrl);

await emailSvc.sendMail({
  to: recipients.join(","),
  subject: "New TAK Portal Access Request",
  text: `A new user has requested access to TAK Portal.

Review Request: ${reviewUrl}

Name: ${reqObj.lastName}, ${reqObj.firstName}
Email: ${reqObj.email}
Badge: ${reqObj.badgeNumber}
${reqObj.radioCallsign ? `Radio Callsign: ${reqObj.radioCallsign}\n` : ""}Agency: ${
    reqObj.agencyName ||
    reqObj.otherAgency ||
    reqObj.agencySuffix
  }
${otherAgencyDetailsText}${reasonLine}`,
  html: `
<p>A new user has requested access to TAK Portal.</p>
<p><strong><a href="${safeReviewUrl}">Review Request</a></strong></p>
<p>
  <strong>Name:</strong> ${escapeHtml(reqObj.lastName)}, ${escapeHtml(reqObj.firstName)}<br/>
  <strong>Email:</strong> ${escapeHtml(reqObj.email)}<br/>
  <strong>Badge:</strong> ${escapeHtml(reqObj.badgeNumber)}<br/>
  ${
    reqObj.radioCallsign
      ? `<strong>Radio Callsign:</strong> ${escapeHtml(reqObj.radioCallsign)}<br/>`
      : ""
  }
  <strong>Agency:</strong> ${
    escapeHtml(
      reqObj.agencyName ||
      reqObj.otherAgency ||
      reqObj.agencySuffix
    )
  }<br/>
  ${otherAgencyDetailsHtml}
  ${
    reqObj.otherReason
      ? `<strong>Reason for requesting access:</strong> ${escapeHtml(reqObj.otherReason)}`
      : ""
  }
</p>
`,
});

      console.log("Access request notification sent to:", recipients);
    } else {
      console.warn("No recipients found for access request notification.");
    }
  } catch (err) {
    console.error("Failed to send access request notification:", err);
  }

  return reqObj;
}

function deleteRequestForUser(id, authUser) {
  const user = authUser || null;

  if (user && user.isGlobalAdmin) return deleteRequest(id);

  if (user && user.isAgencyAdmin) {
    const reqObj = getById(id);
    if (!reqObj) return false;
    if (!accessSvc.isSuffixAllowed(user, reqObj.agencySuffix)) return false;
    return deleteRequest(id);
  }

  return false;
}

function deleteRequest(id) {
  const rid = String(id || "").trim();
  if (!rid) return false;

  const all = store.load();
  const next = all.filter((r) => String(r.id || "") !== rid);

  const changed = next.length !== all.length;
  if (changed) store.save(next);

  return changed;
}

function getById(id) {
  const rid = String(id || "").trim();
  if (!rid) return null;

  const all = store.load();
  return all.find((r) => String(r.id || "") === rid) || null;
}

function markAgencyCreated(id, agency, mainGroupName) {
  const rid = String(id || "").trim();
  if (!rid) throw new Error("User request ID is required");

  const all = store.load();
  const index = all.findIndex((r) => String(r.id || "") === rid);
  if (index < 0) throw new Error("Pending user request was not found");
  if (String(all[index].agencySuffix || "") !== "__other__") {
    throw new Error("Only Other agency requests can be linked to a created agency");
  }

  const suffix = normalizeStr(agency?.suffix).toLowerCase();
  const groupPrefix = normalizeStr(agency?.groupPrefix).toUpperCase();
  if (!suffix) throw new Error("Created agency suffix is required");

  all[index].createdAgency = {
    suffix,
    name: normalizeStr(agency?.name) || null,
    groupPrefix: groupPrefix || null,
    mainGroupName:
      normalizeStr(mainGroupName) ||
      (groupPrefix ? `tak_${groupPrefix} Main` : null),
    createdAt: new Date().toISOString(),
  };

  store.save(all);
  return all[index];
}

function getByReviewToken(token) {
  const value = String(token || "").trim();
  if (!value) return null;
  const all = store.load();
  return all.find((r) => String(r?.reviewToken || "") === value) || null;
}

module.exports = {
  listRequests,
  listRequestsForUser,
  countRequestsForUser,
  countPendingRequestsForAgencySuffix,
  deleteRequestsForAgencySuffix,
  createRequest,
  deleteRequest,
  deleteRequestForUser,
  getById,
  getByReviewToken,
  markAgencyCreated,
  validateCreate,
};