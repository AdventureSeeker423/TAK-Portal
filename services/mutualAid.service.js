const crypto = require("crypto");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const { getString } = require("./env");
const Jimp = require("jimp");
const api = require("./authentik");
const groupsSvc = require("./groups.service");
const usersSvc = require("./users.service");
const store = require("./mutualAid.store");
const settingsSvc = require("./settings.service");
const emailSvc = require("./email.service");
const { renderTemplate, htmlToText } = require("./emailTemplates.service");

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

// ---- Jimp helpers (Jimp 0.22.x) ----

async function addLogoToPng(pngBuffer) {
  try {
    const settings = settingsSvc.getSettings ? settingsSvc.getSettings() || {} : {};
    const logoUrl = settings.BRAND_LOGO_URL;

    if (!logoUrl || typeof logoUrl !== "string") {
      return pngBuffer;
    }

    // BRAND_LOGO_URL is like "/branding/logo.png"
    // Files are stored under /data/branding and served via app.use("/branding", ...)
    const logoUrlPath = logoUrl.replace(/^\//, ""); // "branding/logo.png"
    const logoFsPath = path.join(__dirname, "..", "data", logoUrlPath);

    if (!fs.existsSync(logoFsPath)) {
      console.warn("[MUTUAL AID] BRAND_LOGO_URL file not found at", logoFsPath);
      return pngBuffer;
    }

    const [qrImage, logoImageOriginal] = await Promise.all([
      Jimp.read(pngBuffer),
      Jimp.read(logoFsPath),
    ]);

    const qrWidth = qrImage.getWidth();
    const qrHeight = qrImage.getHeight();

    // Max logo size: 25% of QR's smaller dimension (safe for error-correction H)
    const logoMaxSize = Math.floor(Math.min(qrWidth, qrHeight) * 0.25);

    // Clone and resize logo
    const logoImage = logoImageOriginal.clone();
    logoImage.contain(logoMaxSize, logoMaxSize);

    // White background "badge" behind logo
    const padding = Math.floor(logoMaxSize * 0.12); // 12% padding around logo
    const bgWidth = logoImage.getWidth() + padding * 2;
    const bgHeight = logoImage.getHeight() + padding * 2;

    // Position of the white background (centered)
    const bgX = Math.floor((qrWidth - bgWidth) / 2);
    const bgY = Math.floor((qrHeight - bgHeight) / 2);

    // Fill a white rectangle directly onto the QR image
    qrImage.scan(bgX, bgY, bgWidth, bgHeight, function (x, y, idx) {
      // RGBA = 255, 255, 255, 255
      this.bitmap.data[idx + 0] = 255; // R
      this.bitmap.data[idx + 1] = 255; // G
      this.bitmap.data[idx + 2] = 255; // B
      this.bitmap.data[idx + 3] = 255; // A
    });

    // Now center the logo on top of that white rectangle
    const logoX = bgX + padding;
    const logoY = bgY + padding;

    qrImage.composite(logoImage, logoX, logoY);

    return await qrImage.getBufferAsync(Jimp.MIME_PNG);
  } catch (err) {
    console.error("[MUTUAL AID] Failed to add logo to QR:", err);
    return pngBuffer;
  }
}

async function addUsernameLabel(pngBuffer, username) {
  try {
    const qrImage = await Jimp.read(pngBuffer);

    // Bold-looking built-in font
    const font = await Jimp.loadFont(Jimp.FONT_SANS_64_BLACK);

    // FORCE ALL CAPS
    const text = (String(username || "").trim() || "USER").toUpperCase();

    const textBlockHeight = 80; // a little extra space for text

    const qrWidth = qrImage.getWidth();
    const qrHeight = qrImage.getHeight();

    // New canvas: same width, extra height for text
    const combined = new Jimp(
      qrWidth,
      qrHeight + textBlockHeight,
      0xffffffff // white background
    );

    // Paste the QR code at the top
    combined.composite(qrImage, 0, 0);

    // Center text under QR
    combined.print(
      font,
      0,
      qrHeight + 10,
      {
        text,
        alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
        alignmentY: Jimp.VERTICAL_ALIGN_TOP,
      },
      qrWidth,
      textBlockHeight
    );

    return combined.getBufferAsync(Jimp.MIME_PNG);
  } catch (err) {
    console.error("[MUTUAL AID] Failed to add username label to QR:", err);
    return pngBuffer;
  }
}

// ---- QR helpers ----

async function qrDataUrl(username, token) {
  const enrollUrl = enrollUrlForCreds(username, token);
  const basePng = await QRCode.toBuffer(enrollUrl, {
    errorCorrectionLevel: "H",
    type: "png",
    width: 512,
    margin: 2,
    color: { dark: "#000000", light: "#FFFFFF" },
  });
  const finalPng = await addLogoToPng(basePng);
  const qrCode = "data:image/png;base64," + finalPng.toString("base64");
  return { enrollUrl, qrCode };
}

async function qrPngBuffer(username, token) {
  const enrollUrl = enrollUrlForCreds(username, token);
  const pngBuffer = await QRCode.toBuffer(enrollUrl, {
    errorCorrectionLevel: "H",
    type: "png",
    width: 1200,
    margin: 3,
    color: { dark: "#000000", light: "#FFFFFF" },
  });

  // 1) Add logo in the center (with white badge)
  let finalPng = await addLogoToPng(pngBuffer);

  // 2) Add username label underneath
  finalPng = await addUsernameLabel(finalPng, username);

  return finalPng;
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

function itemsSharingGroup(items, groupId) {
  const gid = String(groupId || "").trim();
  if (!gid) return [];
  return (Array.isArray(items) ? items : []).filter((x) => String(x?.groupId || "") === gid);
}

function enrichItemForList(item, allItems) {
  const gid = String(item?.groupId || "");
  const master = findGroupMasterItem(allItems, gid);
  const siblings = itemsSharingGroup(allItems, gid);
  const isGroupMaster = !!(master && String(master.id) === String(item.id));
  return {
    ...item,
    isGroupMaster,
    isLinkedDeployment: !isGroupCreatorItem(item) && siblings.length > 1,
    groupMasterId: master ? String(master.id) : null,
    sharedGroupDeploymentCount: siblings.length,
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
  if (gid && store.getMutualAidGroupIdSet().has(gid)) {
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
  usernameOverride = null,
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
  } else {
    // 1) Create group
    group = await groupsSvc.createGroup(desiredGroupName);
    groupWasCreated = true;
  }

  const groupName = String(group?.name || desiredGroupName);
  const existingItems = store.load();
  const groupMaster = mode === "existing" ? findGroupMasterItem(existingItems, String(group.pk)) : null;

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
async function createLinkedUser({ parentId, title, expireEnabled, expireAt }) {
  const parent = getById(parentId);
  if (!parent) throw new Error("Parent mutual aid item not found");

  const parentType = baseMutualAidType(parent.type);
  if (!parentType) throw new Error("Parent mutual aid type is invalid");

  const childTitle = sanitizeTitle(title);
  if (!childTitle) throw new Error("Name is required");

  const items = store.load();
  const master = findGroupMasterItem(items, parent.groupId) || parent;
  const masterTitle = sanitizeTitle(master.title);
  const username = buildLinkedMutualAidUsername(masterTitle, childTitle);
  if (!username) {
    throw new Error("Name must contain at least one letter/number for username");
  }

  const subType = `SUB-${parentType}`;
  return create({
    type: subType,
    title: childTitle,
    expireEnabled,
    expireAt,
    groupMode: "existing",
    existingGroupId: parent.groupId,
    allowMutualAidGroup: true,
    usernameOverride: username,
  });
}

async function update({ id, type, title, expireEnabled, expireAt }) {
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

  let nextUsername;
  if (isSub) {
    const master = findGroupMasterItem(items, current.groupId);
    const masterTitle = sanitizeTitle(master?.title || current.title);
    nextUsername = buildLinkedMutualAidUsername(masterTitle, nextTitle);
  } else {
    nextUsername = buildMutualAidUsername(nextType, nextTitle);
  }
  if (!nextUsername) throw new Error("Name must contain at least one letter/number for username");

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

  // Update user display name + username to match formatting rules.
  if (String(current.userId || "").trim()) {
    // If username is changing, ensure it isn't already taken (except by this user).
    if (String(current.username || "") !== String(nextUsername)) {
      const taken = await usersSvc.userExists(nextUsername);
      if (taken) throw new Error(`Username already exists: ${nextUsername}`);
    }

    await api
      .patch(`/core/users/${current.userId}/`, {
        username: nextUsername,
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
  saveAll(items);

  // Update expiration schedule
  scheduleExpiration(updated);
  return updated;
}

async function remove({ id }) {
  const items = store.load();
  const idx = items.findIndex((x) => String(x.id) === String(id));
  if (idx < 0) throw new Error("Mutual aid item not found");

  const item = items[idx];
  const cascade = isGroupCreatorItem(item)
    ? itemsSharingGroup(items, item.groupId)
    : [item];

  const deleteSharedGroup =
    isGroupCreatorItem(item) &&
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
  const { enrollUrl, qrCode } = await qrDataUrl(item.username, item.password);
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    username: item.username,
    enrollUrl,
    qrCode,
  };
}

async function getQrDownload({ id }) {
  const item = getById(id);
  if (!item) throw new Error("Mutual aid item not found");
  const pngBuffer = await qrPngBuffer(item.username, item.password);
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
  create,
  createLinkedUser,
  update,
  remove,
  getQr,
  getQrDownload,
  formatMutualAidTypeLabel,
  isSubMutualAidType,
};
