const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { getString } = require("./env");
const api = require("./authentik");
const groupsSvc = require("./groups.service");
const usersSvc = require("./users.service");
const store = require("./mutualAid.store");
const settingsSvc = require("./settings.service");
const emailSvc = require("./email.service");
const { renderTemplate, htmlToText } = require("./emailTemplates.service");
const qrSvc = require("./qr.service");
const accessSvc = require("./access.service");
const agenciesSvc = require("./agencies.service");

const MA_LOGO_DIR = path.join(__dirname, "..", "data", "mutual-aid-logos");
const MA_LOGO_ALLOWED_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

// ---- Expiration scheduler (in-memory) ----
// Expiration settings are persisted in mutual-aid.json. Timers are best-effort
// and rehydrated on server start.
const expirationTimers = new Map(); // id -> Timeout

function clearExpirationTimer(id) {
  const key = String(id || "");
  const t = expirationTimers.get(key);
  if (t) clearTimeout(t);
  expirationTimers.delete(key);
}

async function handleExpirationFire(id) {
  try {
    const item = getById(id);
    if (!item) return;

    const enabled = !!item.expireEnabled;
    const at = item.expireAt ? new Date(item.expireAt).getTime() : NaN;
    if (!enabled || !Number.isFinite(at)) return;

    // Only fire if we're at/after the scheduled time.
    if (Date.now() < at) {
      // Clock drift/restart: reschedule.
      scheduleExpiration(item);
      return;
    }

    // Treat as if the delete button was clicked.
    await remove({ id: item.id });
  } catch (e) {
    console.error("[MUTUAL AID] expiration delete failed:", e?.message || e);
  } finally {
    clearExpirationTimer(id);
  }
}

function scheduleExpiration(item) {
  if (!item) return;
  clearExpirationTimer(item.id);

  if (!item.expireEnabled) return;
  // Expiration is supported for both EVENT and INCIDENT.

  const atMs = item.expireAt ? new Date(item.expireAt).getTime() : NaN;
  if (!Number.isFinite(atMs)) return;

  const delay = atMs - Date.now();
  if (delay <= 0) {
    // Fire ASAP on next tick.
    const t = setTimeout(() => void handleExpirationFire(item.id), 0);
    expirationTimers.set(String(item.id), t);
    return;
  }

  // Cap long timeouts to avoid max-delay issues (Node timers are ~24.8 days)
  const MAX_DELAY = 2_000_000_000; // ~23.1 days
  const t = setTimeout(() => {
    // If far in future, chain timers.
    if (delay > MAX_DELAY) {
      scheduleExpiration(item);
      return;
    }
    void handleExpirationFire(item.id);
  }, Math.min(delay, MAX_DELAY));

  expirationTimers.set(String(item.id), t);
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeTitle(title) {
  return String(title || "").trim();
}

function sanitizeUsernameSlug(title) {
  // lowercase, no spaces, keep a-z0-9_- only
  return String(title || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9_-]/g, "");
}

function buildMutualAidUsername(type, title) {
  const slug = sanitizeUsernameSlug(title);
  if (!slug) return "";
  return `ma-${slug}`;
}

/** Additional MA user on a shared channel: ma-{masterTitleSlug}-{childTitleSlug} */
function buildLinkedMutualAidUsername(masterTitle, childTitle) {
  const masterSlug = sanitizeUsernameSlug(masterTitle);
  const childSlug = sanitizeUsernameSlug(childTitle);
  if (!masterSlug || !childSlug) return "";
  return `ma-${masterSlug}-${childSlug}`;
}

function buildGroupName(type, title) {
  const name = sanitizeTitle(title);
  if (!name) throw new Error("Name is required");
  return `MA - ${name}`;
}

function randomPassword(length = 18) {
  // Use a mix of upper/lower/digits/symbols
  // (avoid ambiguous/whitespace characters)
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%&*-+=?";
  const all = upper + lower + digits + symbols;

  const pick = (charset) => charset[crypto.randomInt(0, charset.length)];

  // Ensure at least one from each category
  let out = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  while (out.length < length) out.push(pick(all));

  // Shuffle
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join("");
}

function getTakHost() {
  // Match QR Generator behavior: prefer TAK_URL from settings.json, fall back to env.
  try {
    const settings = settingsSvc.getSettings ? settingsSvc.getSettings() || {} : {};
    let takUrl = null;

    if (
      settings.TAK_URL &&
      typeof settings.TAK_URL === "string" &&
      settings.TAK_URL.trim()
    ) {
      takUrl = settings.TAK_URL.trim();
    } else if (process.env.TAK_URL && String(process.env.TAK_URL).trim()) {
      takUrl = String(process.env.TAK_URL).trim();
    }

    if (!takUrl) {
      throw new Error(
        "TAK_URL is not configured. Set it in Settings (TAK URL) or via the TAK_URL environment variable."
      );
    }

    return new URL(takUrl).hostname;
  } catch (e) {
    throw new Error(
      "TAK_URL is not configured. Set it in Settings (TAK URL) or via the TAK_URL environment variable."
    );
  }
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


function enrollUrlForCreds(username, token) {
  const host = getTakHost();
  return (
    `tak://com.atakmap.app/enroll?` +
    `host=${host}` +
    `&username=${encodeURIComponent(username)}` +
    `&token=${encodeURIComponent(token)}`
  );
}

// ---- Deployment logo (master only; subs inherit from group anchor) ----

function ensureMaLogoDir() {
  if (!fs.existsSync(MA_LOGO_DIR)) {
    fs.mkdirSync(MA_LOGO_DIR, { recursive: true });
  }
}

function logoUrlToFsPath(logoUrl) {
  const rel = String(logoUrl || "")
    .trim()
    .replace(/^\//, "");
  if (!rel || rel.includes("..")) return null;
  if (!rel.startsWith("mutual-aid-logos/")) return null;
  return path.join(__dirname, "..", "data", rel);
}

function getBrandLogoFsPath() {
  const settings = settingsSvc.getSettings ? settingsSvc.getSettings() || {} : {};
  const logoUrl = settings.BRAND_LOGO_URL;
  if (!logoUrl || typeof logoUrl !== "string") return null;
  const logoUrlPath = logoUrl.replace(/^\//, "");
  const logoFsPath = path.join(__dirname, "..", "data", logoUrlPath);
  return fs.existsSync(logoFsPath) ? logoFsPath : null;
}

function resolveLogoFsPathForItem(item) {
  const items = store.load();
  const anchor = findGroupAnchorItem(items, item?.groupId) || item;
  if (anchor?.logoUrl) {
    const custom = logoUrlToFsPath(anchor.logoUrl);
    if (custom && fs.existsSync(custom)) return custom;
  }
  return getBrandLogoFsPath();
}

function deleteLogoFilesForDeployment(deploymentId) {
  const id = String(deploymentId || "").trim();
  if (!id) return;
  ensureMaLogoDir();
  try {
    for (const name of fs.readdirSync(MA_LOGO_DIR)) {
      if (name === id || name.startsWith(`${id}.`)) {
        fs.unlinkSync(path.join(MA_LOGO_DIR, name));
      }
    }
  } catch (err) {
    console.warn("[MUTUAL AID] failed to delete logo files:", err?.message || err);
  }
}

function getLogoOwnerItem(items, item) {
  if (!item || isSubMutualAidType(item.type)) return null;
  return findGroupAnchorItem(items, item.groupId) || item;
}

async function applyDeploymentLogo({ id, file, removeLogo }) {
  const items = store.load();
  const idx = items.findIndex((x) => String(x.id) === String(id));
  if (idx < 0) throw new Error("Mutual aid item not found");

  const current = items[idx];
  if (isSubMutualAidType(current.type)) {
    throw new Error("Sub deployments cannot set a custom logo");
  }

  const owner = getLogoOwnerItem(items, current);
  if (!owner) throw new Error("Logo can only be set on a master deployment");

  const ownerIdx = items.findIndex((x) => String(x.id) === String(owner.id));
  if (ownerIdx < 0) throw new Error("Master deployment not found");

  if (removeLogo) {
    deleteLogoFilesForDeployment(owner.id);
    const nextOwner = { ...items[ownerIdx] };
    delete nextOwner.logoUrl;
    nextOwner.updatedAt = nowIso();
    items[ownerIdx] = nextOwner;
    saveAll(items);
    return nextOwner;
  }

  if (!file || !file.path) return items[ownerIdx];

  const ext = path.extname(file.originalname || file.path || "").toLowerCase();
  if (!MA_LOGO_ALLOWED_EXT.has(ext)) {
    try {
      fs.unlinkSync(file.path);
    } catch {
      /* ignore */
    }
    throw new Error("Logo must be PNG, JPEG, WebP, or GIF");
  }

  ensureMaLogoDir();
  deleteLogoFilesForDeployment(owner.id);

  const destName = `${owner.id}${ext}`;
  const destPath = path.join(MA_LOGO_DIR, destName);
  fs.renameSync(file.path, destPath);

  const logoUrl = `/mutual-aid-logos/${destName}`;
  const nextOwner = {
    ...items[ownerIdx],
    logoUrl,
    updatedAt: nowIso(),
  };
  items[ownerIdx] = nextOwner;
  saveAll(items);
  return nextOwner;
}

// ---- QR helpers (cached PNG + logo overlay via qr.service) ----

async function qrDataUrl(username, token, item) {
  const enrollUrl = enrollUrlForCreds(username, token);
  const logoPath = resolveLogoFsPathForItem(item);
  const qrCode = await qrSvc.generateDisplayQrDataUrl(enrollUrl, {
    width: 1024,
    margin: 2,
    logoRatio: 0.28,
    ...(logoPath ? { logoPath } : {}),
  });
  return { enrollUrl, qrCode };
}

async function qrPngBuffer(username, token, item) {
  const enrollUrl = enrollUrlForCreds(username, token);
  const logoPath = resolveLogoFsPathForItem(item);
  return qrSvc.generateQrPngBuffer(enrollUrl, {
    width: 1800,
    margin: 3,
    logoRatio: 0.28,
    usernameLabel: username,
    ...(logoPath ? { logoPath } : {}),
  });
}

function isSubMutualAidType(type) {
  return String(type || "")
    .trim()
    .toUpperCase()
    .startsWith("SUB-");
}

function baseMutualAidType(type) {
  return String(type || "")
    .trim()
    .toUpperCase()
    .replace(/^SUB-/, "");
}

function formatMutualAidTypeLabel(type) {
  const t = String(type || "").trim().toUpperCase();
  if (!t) return "";
  if (isSubMutualAidType(t)) {
    const base = baseMutualAidType(t);
    if (!base) return "Sub";
    return `Sub-${base.charAt(0)}${base.slice(1).toLowerCase()}`;
  }
  return `${t.charAt(0)}${t.slice(1).toLowerCase()}`;
}

function isGroupCreatorItem(item) {
  if (isSubMutualAidType(item?.type)) return false;
  if (item?.groupWasCreated === true) return true;
  const mode = String(item?.groupMode || "new").trim().toLowerCase();
  return mode !== "existing";
}

function findGroupMasterItem(items, groupId) {
  const gid = String(groupId || "").trim();
  if (!gid) return null;
  const creators = (Array.isArray(items) ? items : []).filter(
    (x) => String(x?.groupId || "") === gid && isGroupCreatorItem(x)
  );
  if (!creators.length) return null;
  creators.sort((a, b) =>
    String(a?.createdAt || "").localeCompare(String(b?.createdAt || ""))
  );
  return creators[0];
}

/** MA-created group master, or earliest non-sub deployment on the shared group. */
function findGroupAnchorItem(items, groupId) {
  const master = findGroupMasterItem(items, groupId);
  if (master) return master;
  const gid = String(groupId || "").trim();
  if (!gid) return null;
  const primaries = (Array.isArray(items) ? items : []).filter(
    (x) => String(x?.groupId || "") === gid && !isSubMutualAidType(x?.type)
  );
  if (!primaries.length) return null;
  primaries.sort((a, b) =>
    String(a?.createdAt || "").localeCompare(String(b?.createdAt || ""))
  );
  return primaries[0];
}

function itemsSharingGroupId(items, groupId) {
  const gid = String(groupId || "").trim();
  if (!gid) return [];
  return (Array.isArray(items) ? items : []).filter((x) => String(x?.groupId || "") === gid);
}

async function syncLinkedSubDeployments(items, parentItem, { nextBaseType } = {}) {
  const gid = String(parentItem?.groupId || "").trim();
  if (!gid) return 0;

  const baseType = String(nextBaseType || baseMutualAidType(parentItem?.type) || "")
    .trim()
    .toUpperCase();
  if (!baseType) return 0;

  const subType = `SUB-${baseType}`;
  let updated = 0;

  for (let i = 0; i < items.length; i++) {
    const entry = items[i];
    if (String(entry?.groupId || "") !== gid) continue;
    if (!isSubMutualAidType(entry?.type)) continue;

    const childTitle = sanitizeTitle(entry?.title);

    if (String(entry?.userId || "").trim()) {
      await api
        .patch(`/core/users/${entry.userId}/`, {
          name: childTitle,
          attributes: {
            ...(entry.attributes || {}),
            mutual_aid: true,
            mutual_aid_type: subType,
            mutual_aid_group: String(parentItem?.groupName || entry?.groupName || ""),
          },
        })
        .catch(() => null);
    }

    const nextEntry = {
      ...entry,
      type: subType,
      groupMasterId: String(parentItem?.id || entry?.groupMasterId || ""),
      updatedAt: nowIso(),
    };
    items[i] = nextEntry;
    scheduleExpiration(nextEntry);
    updated += 1;
  }

  return updated;
}

function itemsSharingGroup(items, groupId) {
  const gid = String(groupId || "").trim();
  if (!gid) return [];
  return (Array.isArray(items) ? items : []).filter((x) => String(x?.groupId || "") === gid);
}

function enrichItemForList(item, allItems) {
  const gid = String(item?.groupId || "");
  const master = findGroupAnchorItem(allItems, gid);
  const siblings = itemsSharingGroup(allItems, gid);
  const isGroupMaster = !!(master && String(master.id) === String(item.id));
  const logoUrl = master?.logoUrl || null;
  return {
    ...item,
    createdBy: normalizeCreatedBy(item),
    isGroupMaster,
    isLinkedDeployment: !isGroupCreatorItem(item) && siblings.length > 1,
    groupMasterId: master ? String(master.id) : null,
    sharedGroupDeploymentCount: siblings.length,
    logoUrl,
    hasCustomLogo: !!logoUrl,
  };
}

function list() {
  const items = store.load();
  const enriched = items.map((it) => enrichItemForList(it, items));
  // newest first
  return enriched.sort((a, b) =>
    String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  );
}

function getById(id) {
  const items = store.load();
  return items.find((x) => String(x.id) === String(id)) || null;
}

function normalizeSuffix(value) {
  return String(value || "").trim().toLowerCase();
}

/**
 * Missing createdBy (legacy records) is treated as global-admin ownership.
 */
function normalizeCreatedBy(itemOrCreatedBy) {
  const raw =
    itemOrCreatedBy && itemOrCreatedBy.createdBy
      ? itemOrCreatedBy.createdBy
      : itemOrCreatedBy && itemOrCreatedBy.role
        ? itemOrCreatedBy
        : null;

  if (!raw || typeof raw !== "object") {
    return {
      role: "global_admin",
      username: null,
      displayName: null,
      agencySuffixes: [],
      agencyNames: [],
    };
  }

  let role = String(raw.role || "").trim().toLowerCase();
  if (role === "multi_agency_admin" || role === "multi-agency-admin") {
    role = "multi_agency_admin";
  } else if (role === "agency_admin" || role === "agency-admin") {
    role = "agency_admin";
  } else {
    role = "global_admin";
  }

  const agencySuffixes = Array.isArray(raw.agencySuffixes)
    ? raw.agencySuffixes.map(normalizeSuffix).filter(Boolean)
    : [];
  const agencyNames = Array.isArray(raw.agencyNames)
    ? raw.agencyNames.map((n) => String(n || "").trim()).filter(Boolean)
    : [];

  return {
    role,
    username: raw.username != null ? String(raw.username).trim() || null : null,
    displayName:
      raw.displayName != null ? String(raw.displayName).trim() || null : null,
    agencySuffixes,
    agencyNames,
  };
}

function isAgencyCreatedRole(role) {
  const r = String(role || "").trim().toLowerCase();
  return r === "agency_admin" || r === "multi_agency_admin";
}

function buildCreatedByFromAuthUser(authUser) {
  if (!authUser) {
    return {
      role: "global_admin",
      username: null,
      displayName: null,
      agencySuffixes: [],
      agencyNames: [],
    };
  }

  const username = String(authUser.username || "").trim() || null;
  const displayName =
    String(authUser.displayName || authUser.username || "").trim() || null;

  if (authUser.isGlobalAdmin) {
    return {
      role: "global_admin",
      username,
      displayName,
      agencySuffixes: [],
      agencyNames: [],
    };
  }

  const suffixes = accessSvc
    .getUserManagedAgencySuffixes(authUser)
    .map(normalizeSuffix)
    .filter(Boolean);
  const agencies = agenciesSvc.load() || [];
  const agencyNames = [];
  for (const sfx of suffixes) {
    const agency = agencies.find(
      (a) => normalizeSuffix(a?.suffix) === sfx
    );
    const name = String(agency?.name || "").trim();
    if (name) agencyNames.push(name);
  }

  const role =
    suffixes.length > 1 ? "multi_agency_admin" : "agency_admin";

  return {
    role,
    username,
    displayName,
    agencySuffixes: suffixes,
    agencyNames,
  };
}

function cloneCreatedBy(createdBy) {
  const n = normalizeCreatedBy(createdBy);
  return {
    role: n.role,
    username: n.username,
    displayName: n.displayName,
    agencySuffixes: n.agencySuffixes.slice(),
    agencyNames: n.agencyNames.slice(),
  };
}

function canViewMutualAid(authUser, item) {
  if (!authUser) return false;
  if (authUser.isGlobalAdmin) return true;

  const createdBy = normalizeCreatedBy(item);
  if (!isAgencyCreatedRole(createdBy.role)) return false;

  const allowed = accessSvc
    .getUserManagedAgencySuffixes(authUser)
    .map(normalizeSuffix)
    .filter(Boolean);
  if (!allowed.length || !createdBy.agencySuffixes.length) return false;

  const allowedSet = new Set(allowed);
  return createdBy.agencySuffixes.some((sfx) => allowedSet.has(sfx));
}

function canManageMutualAid(authUser, item) {
  return canViewMutualAid(authUser, item);
}

function listForUser(authUser) {
  return list().filter((item) => canViewMutualAid(authUser, item));
}

function assertCanManage(authUser, id) {
  const item = getById(id);
  if (!item) {
    const err = new Error("Mutual aid item not found");
    err.status = 404;
    throw err;
  }
  if (!canManageMutualAid(authUser, item)) {
    const err = new Error(
      "You do not have permission to manage this mutual aid deployment."
    );
    err.status = 403;
    throw err;
  }
  return item;
}

function saveAll(items) {
  store.save(items);
}

async function sendMutualAidCreatedEmail({ type, title, username, password, groupName }) {
  // Requirement: notify EMAIL_ALWAYS_CC and EMAIL_SEND_COPY_TO recipients.
  // We'll send *to* the union list to ensure delivery even if cc/bcc are empty.
  const cfg = emailSvc.getSmtpConfig();

  const parse = (v) =>
    String(v || "")
      .trim()
      .split(/[;,]/g)
      .map((x) => String(x).trim())
      .filter(Boolean);

  const recipients = Array.from(new Set([...parse(cfg.alwaysCc), ...parse(cfg.sendCopyTo)]));
  if (!recipients.length) return;

  const { enrollUrl, qrCode } = await qrDataUrl(username, password);
  const subject = `${String(type || "").toUpperCase()} Created: ${title}`;

  const html = renderTemplate("mutual_aid_created.html", {
    type: String(type || "").toUpperCase(),
    title: String(title || ""),
    groupName: String(groupName || ""),
    username: String(username || ""),
    password: String(password || ""),
    enrollUrl,
    qrDataUrl: qrCode,
    takPortalPublicUrl: getTakPortalPublicUrl(),
  });
  const text = htmlToText(html);

  await emailSvc.sendMail({
    to: recipients.join(","),
    subject,
    text,
    html,
  });
}

function coerceBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

function parseExpireAt(value) {
  if (value == null || value === "") return null;
  const d = new Date(value);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) throw new Error("Invalid expiration date/time");
  return d.toISOString();
}

function assertNotMutualAidChannelGroup(group, { allowMutualAidGroup = false } = {}) {
  if (allowMutualAidGroup || !group) return;
  const gid = String(group.pk || "").trim();
  // Only block groups created by the MA workflow. A normal existing group may
  // be reused by more than one standalone mutual aid deployment.
  if (gid && store.getCreatedGroupIdSet().has(gid)) {
    throw new Error(
      "Mutual aid channels cannot be selected as an existing group. Use Create Additional MA User on an existing deployment instead."
    );
  }
  const raw = String(group.name || "").trim().toLowerCase();
  const withoutTak = raw.startsWith("tak_") ? raw.slice(4) : raw;
  if (withoutTak.startsWith("ma -") || withoutTak.startsWith("ma-")) {
    throw new Error(
      "Mutual aid channels cannot be selected as an existing group. Use Create Additional MA User on an existing deployment instead."
    );
  }
}

async function create({
  type,
  title,
  expireEnabled,
  expireAt,
  groupMode,
  existingGroupId,
  allowMutualAidGroup = false,
  groupMasterId = null,
  usernameOverride = null,
  createdBy = null,
  authUser = null,
  preserveMissingCreatedBy = false,
} = {}) {
  const t = String(type || "").trim().toUpperCase();
  const name = sanitizeTitle(title);
  const desiredGroupName = buildGroupName(t, name);
  const username = usernameOverride
    ? String(usernameOverride).trim()
    : buildMutualAidUsername(t, name);
  if (!username) throw new Error("Name must contain at least one letter/number for username");

  const taken = await usersSvc.userExists(username);
  if (taken) throw new Error(`Username already exists: ${username}`);

  // Expiration options (EVENT + INCIDENT)
  const wantExpire = coerceBool(expireEnabled);
  const parsedExpireAt = wantExpire ? parseExpireAt(expireAt) : null;

  if (wantExpire && !parsedExpireAt) {
    throw new Error("Expiration date/time is required when expiration is enabled");
  }
  if (wantExpire && new Date(parsedExpireAt).getTime() <= Date.now()) {
    throw new Error("Expiration date/time must be in the future");
  }

  // Group selection
  // - "new" (default): create a brand new group named "MA - TITLE"
  // - "existing": attach this mutual aid user to an existing group
  const modeRaw = String(groupMode || "").trim().toLowerCase();
  const mode = modeRaw === "existing" ? "existing" : "new";

  let group;
  let groupWasCreated = false;

  if (mode === "existing") {
    const gid = String(existingGroupId || "").trim();
    if (!gid) throw new Error("Existing group is required when using an existing group");
    group = await groupsSvc.getGroupById(gid);
    if (!group || !group.pk) throw new Error("Group not found");
    assertNotMutualAidChannelGroup(group, { allowMutualAidGroup });
    // Agency admins may only attach to groups in their scope (not MA channel groups via this path).
    if (!allowMutualAidGroup && authUser) {
      const access = accessSvc.getAgencyAccess(authUser);
      if (!access.isGlobalAdmin && !accessSvc.canUserModifyGroup(authUser, group)) {
        const err = new Error(
          "You do not have permission to use that group for mutual aid."
        );
        err.status = 403;
        throw err;
      }
    }
  } else {
    // 1) Create group
    group = await groupsSvc.createGroup(desiredGroupName);
    groupWasCreated = true;
  }

  const groupName = String(group?.name || desiredGroupName);
  const existingItems = store.load();
  const requestedMasterId = String(groupMasterId || "").trim();
  const groupMaster =
    mode === "existing" && allowMutualAidGroup
      ? (requestedMasterId
          ? existingItems.find((x) => String(x?.id || "") === requestedMasterId) || null
          : findGroupAnchorItem(existingItems, String(group.pk)))
      : null;

  // 2) Create user (minimal fields; password is numeric as requested)
  const password = randomPassword(18);
  const userPayload = {
    username,
    name, // display name
    is_active: true,
    password,
    attributes: {
      mutual_aid: true,
      mutual_aid_type: t,
      mutual_aid_group: groupName,
    },
  };

  const folderRaw = String(process.env.AUTHENTIK_USER_PATH || "").trim();
  if (folderRaw) {
    userPayload.path = String(folderRaw).replace(/^\/+|\/+$/g, "");
  }

  const res = await api.post("/core/users/", userPayload);
  const user = res.data;

  // IMPORTANT:
  // Authentik's create-user endpoint may not reliably apply the provided
  // password field (depending on configuration / permissions). The main
  // users.service.js was updated to always set passwords using the dedicated
  // set_password endpoint; mutual-aid users should follow the same pattern
  // so the stored password always matches the actual Authentik password.
  await api.post(`/core/users/${user.pk}/set_password/`, { password });

  // 3) Ensure user gets this mutual aid group
  const finalGroups = [group];

  await api.patch(`/core/users/${user.pk}/`, {
    groups: finalGroups.map((g) => g.pk),
  });

  // 4) Persist record (stores password so QR can be regenerated later)
  // createdBy:
  // - explicit object → stamp it
  // - explicit null with preserveMissingCreatedBy → leave untagged (legacy channel)
  // - otherwise build from authUser when available
  let stampedCreatedBy = null;
  if (createdBy && typeof createdBy === "object") {
    stampedCreatedBy = cloneCreatedBy(createdBy);
  } else if (preserveMissingCreatedBy) {
    stampedCreatedBy = null;
  } else if (authUser) {
    stampedCreatedBy = buildCreatedByFromAuthUser(authUser);
  }

  if (
    stampedCreatedBy &&
    isAgencyCreatedRole(stampedCreatedBy.role) &&
    !stampedCreatedBy.agencySuffixes.length
  ) {
    throw new Error(
      "Unable to determine your agency scope for this mutual aid deployment."
    );
  }

  const item = {
    id: crypto.randomUUID(),
    type: t,
    title: name,
    groupId: String(group.pk),
    groupName,
    groupMode: mode,
    groupWasCreated,
    groupMasterId: groupMaster ? String(groupMaster.id) : null,
    userId: String(user.pk),
    username,
    password,
    expireEnabled: wantExpire,
    expireAt: parsedExpireAt,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...(stampedCreatedBy ? { createdBy: stampedCreatedBy } : {}),
  };

  const items = store.load();
  items.push(item);
  saveAll(items);

  // 4b) Schedule expiration (best-effort)
  scheduleExpiration(item);

  // 5) Email notify (best-effort)
  try {
    await sendMutualAidCreatedEmail({
      type: t,
      title: name,
      username,
      password,
      groupName,
    });
  } catch (e) {
    console.error("[EMAIL] mutual aid created notice failed:", e?.message || e);
  }

  return item;
}

/**
 * Add another deployment user on the same channel as an existing master MA record.
 */
async function createLinkedUser({ parentId, title, expireEnabled, expireAt, authUser = null }) {
  const parent = getById(parentId);
  if (!parent) throw new Error("Parent mutual aid item not found");

  const parentType = baseMutualAidType(parent.type);
  if (!parentType) throw new Error("Parent mutual aid type is invalid");

  const childTitle = sanitizeTitle(title);
  if (!childTitle) throw new Error("Name is required");

  const items = store.load();
  const master = findGroupAnchorItem(items, parent.groupId) || parent;
  const masterTitle = sanitizeTitle(parent.title || master.title);
  const username = buildLinkedMutualAidUsername(masterTitle, childTitle);
  if (!username) {
    throw new Error("Name must contain at least one letter/number for username");
  }

  // Inherit channel ownership from parent (or master) so ACL stays consistent.
  const sourceCreatedBy = parent.createdBy || master.createdBy || null;
  const inheritedCreatedBy = sourceCreatedBy
    ? cloneCreatedBy(sourceCreatedBy)
    : null;

  const subType = `SUB-${parentType}`;
  return create({
    type: subType,
    title: childTitle,
    expireEnabled,
    expireAt,
    groupMode: "existing",
    existingGroupId: parent.groupId,
    allowMutualAidGroup: true,
    groupMasterId: parent.id,
    usernameOverride: username,
    createdBy: inheritedCreatedBy,
    authUser,
    // Legacy parent with no createdBy: keep child untagged (global).
    preserveMissingCreatedBy: !inheritedCreatedBy,
  });
}

async function update({ id, type, title, expireEnabled, expireAt, logoFile, removeLogo }) {
  const items = store.load();
  const idx = items.findIndex((x) => String(x.id) === String(id));
  if (idx < 0) throw new Error("Mutual aid item not found");

  const current = items[idx];
  const currentMode = String(current.groupMode || "new").toLowerCase();
  const groupWasCreated = current.groupWasCreated === true;
  const isSub = isSubMutualAidType(current.type);
  const canModifyGroup = !isSub && (groupWasCreated || currentMode !== "existing");

  const nextType = String(type || current.type || "").trim().toUpperCase();
  const nextTitle = sanitizeTitle(title ?? current.title);
  // Only allow the mutual-aid workflow to rename groups that it actually created.
  // When a mutual aid is linked to an existing group, we must not rename that group.
  const nextGroupName = canModifyGroup
    ? buildGroupName(nextType, nextTitle)
    : String(current.groupName || "");

  // Username is assigned at creation and never changed on edit (needed for cert revocation on delete).
  const nextUsername = String(current.username || "").trim();
  if (!nextUsername) throw new Error("Mutual aid deployment username is missing");

  // Expiration options (EVENT + INCIDENT)
  const nextExpireEnabled = coerceBool(expireEnabled ?? current.expireEnabled);
  const nextExpireAt = nextExpireEnabled
    ? parseExpireAt(expireAt ?? current.expireAt)
    : null;
  if (nextExpireEnabled && !nextExpireAt) {
    throw new Error("Expiration date/time is required when expiration is enabled");
  }
  if (nextExpireEnabled && new Date(nextExpireAt).getTime() <= Date.now()) {
    throw new Error("Expiration date/time must be in the future");
  }

  // Rename group in Authentik if needed
  if (canModifyGroup && String(current.groupName) !== String(nextGroupName)) {
    await groupsSvc.renameGroup(current.groupId, nextGroupName, { ignoreLocks: true });
  }

  // Update display name and MA metadata only; username stays fixed.
  if (String(current.userId || "").trim()) {
    await api
      .patch(`/core/users/${current.userId}/`, {
        name: nextTitle,
        attributes: {
          ...(current.attributes || {}),
          mutual_aid: true,
          mutual_aid_type: nextType,
          mutual_aid_group: nextGroupName,
        },
      })
      .catch(() => {
        // Non-fatal if attribute patch fails due to schema
        return null;
      });
  }

  const updated = {
    ...current,
    type: nextType,
    title: nextTitle,
    groupName: nextGroupName,
    username: nextUsername,
    expireEnabled: nextExpireEnabled,
    expireAt: nextExpireAt,
    updatedAt: nowIso(),
  };
  items[idx] = updated;

  if (!isSub) {
    const prevBase = baseMutualAidType(current.type);
    const nextBase = baseMutualAidType(nextType);
    if (prevBase !== nextBase) {
      await syncLinkedSubDeployments(items, updated, { nextBaseType: nextBase });
    }
  }

  saveAll(items);

  // Update expiration schedule
  scheduleExpiration(updated);

  if (logoFile || removeLogo) {
    await applyDeploymentLogo({ id, file: logoFile, removeLogo: !!removeLogo });
  }

  return getById(id) || updated;
}

function itemsOwnedByDeployment(items, item) {
  const id = String(item?.id || "").trim();
  if (!id) return [];
  const owned = [];
  for (const entry of Array.isArray(items) ? items : []) {
    if (String(entry?.id || "") === id) {
      owned.push(entry);
      continue;
    }
    if (String(entry?.groupMasterId || "").trim() === id) owned.push(entry);
  }
  return owned;
}

async function remove({ id }) {
  const items = store.load();
  const idx = items.findIndex((x) => String(x.id) === String(id));
  if (idx < 0) throw new Error("Mutual aid item not found");

  const item = items[idx];
  const anchor = findGroupAnchorItem(items, item.groupId);
  const isAnchor = !!(anchor && String(anchor.id) === String(item.id));
  const isCreator = isGroupCreatorItem(item);

  // MA-created channels still cascade the whole family. Standalone deployments
  // that reused an existing group only remove themselves and their own sub-users.
  const cascade =
    isAnchor && isCreator
      ? itemsSharingGroup(items, item.groupId)
      : itemsOwnedByDeployment(items, item);

  const deleteSharedGroup =
    isAnchor &&
    isCreator &&
    (item.groupWasCreated === true ||
      String(item.groupMode || "new").toLowerCase() !== "existing");

  // Delete linked deployment users first, then remove shared group once.
  for (const entry of cascade) {
    clearExpirationTimer(entry.id);
    if (entry.userId) {
      await usersSvc.deleteUser(entry.userId, { ignoreLocks: true });
    }
  }

  if (deleteSharedGroup && item.groupId) {
    await groupsSvc.deleteGroupWithCleanup(item.groupId, { ignoreLocks: true });
  }

  if (isAnchor) {
    deleteLogoFilesForDeployment(item.id);
  }

  const removeIds = new Set(cascade.map((x) => String(x.id)));
  const next = items.filter((x) => !removeIds.has(String(x.id)));
  saveAll(next);

  return {
    success: true,
    deletedCount: cascade.length,
    deletedIds: cascade.map((x) => String(x.id)),
    cascade: cascade.length > 1,
    groupDeleted: !!deleteSharedGroup,
  };
}

async function getQr({ id }) {
  const item = getById(id);
  if (!item) throw new Error("Mutual aid item not found");
  const { enrollUrl, qrCode } = await qrDataUrl(item.username, item.password, item);
  const items = store.load();
  const anchor = findGroupAnchorItem(items, item.groupId);
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    username: item.username,
    enrollUrl,
    qrCode,
    hasCustomLogo: !!anchor?.logoUrl,
    logoUrl: anchor?.logoUrl || null,
  };
}

async function getQrDownload({ id }) {
  const item = getById(id);
  if (!item) throw new Error("Mutual aid item not found");
  const pngBuffer = await qrPngBuffer(item.username, item.password, item);
  const safeUser = String(item.username || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "") || "mutual-aid";

  const filename = `tak-${safeUser}-enrollment-qr.png`;
  return { pngBuffer, filename };
}

function initExpirationScheduler() {
  try {
    const items = store.load();
    items.forEach((it) => scheduleExpiration(it));
  } catch (e) {
    console.error("[MUTUAL AID] failed to initialize expiration scheduler:", e?.message || e);
  }
}

module.exports = {
  initExpirationScheduler,
  list,
  listForUser,
  create,
  createLinkedUser,
  update,
  remove,
  getQr,
  getQrDownload,
  formatMutualAidTypeLabel,
  isSubMutualAidType,
  normalizeCreatedBy,
  buildCreatedByFromAuthUser,
  canViewMutualAid,
  canManageMutualAid,
  assertCanManage,
};
