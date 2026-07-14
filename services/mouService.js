const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const { PDFDocument: PDFLibDocument, StandardFonts, rgb } = require("pdf-lib");
const Jimp = require("jimp");
const { marked } = require("marked");
const agenciesStore = require("./agencies.service");
const accessSvc = require("./access.service");
const { getBool, getInt } = require("./env");
const store = require("./mouStore");
const {
  sanitizeMouHtml,
  sanitizeUserAgreementHtml,
} = require("./mouHtmlSanitizer");

const PDF_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_USER_AGREEMENT_TITLE = "User Agreement";
const DEFAULT_USER_AGREEMENT_MARKDOWN =
  "I understand that use of this TAK environment is subject to my agency's current MOU and local operating policies. I agree to use this access only for authorized mission purposes, to safeguard credentials and shared data, and to follow administrator direction regarding acceptable use and account security.";
const SIGNED_COPY_ALLOWED_EXTENSIONS = new Set(["pdf", "png", "jpg", "jpeg", "webp"]);
const SIGNED_COPY_CONTENT_TYPES = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};
const AGENCY_SIGNING_MODE_AGENCY_ADMINS = "agency_admins";
const AGENCY_SIGNING_MODE_SPECIFIC_ADMIN = "specific_agency_admin";
const AGENCY_SIGNING_MODE_EXTERNAL_LINK = "external_link";
const SIGN_INVITE_EXPIRY_DAYS = 30;
const PDF_FONT_PATHS = {
  regular: [
    "C:\\Windows\\Fonts\\arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
  ].find((candidate) => fs.existsSync(candidate)),
  bold: [
    "C:\\Windows\\Fonts\\arialbd.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  ].find((candidate) => fs.existsSync(candidate)),
};

function nowIso() {
  return new Date().toISOString();
}

function makeId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeLower(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeVersion(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function getUserKey(authUser) {
  return normalizeText(authUser?.username || authUser?.uid);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function slugify(value) {
  const out = normalizeLower(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out || "mou";
}

function isEnabled() {
  return getBool("MOU_ENABLED", true);
}

function requireEnabled() {
  if (!isEnabled()) {
    throw new Error("MOU feature is disabled.");
  }
}

function requireNonEmpty(value, label) {
  if (!normalizeText(value)) {
    throw new Error(`${label} is required.`);
  }
}

function getHtmlLimitBytes() {
  const limitKb = getInt("MOU_HTML_MAX_KB", 512);
  const normalizedKb = Number.isFinite(limitKb) && limitKb > 0 ? limitKb : 512;
  return normalizedKb * 1024;
}

function enforceHtmlSize(html) {
  const bytes = Buffer.byteLength(String(html || ""), "utf8");
  if (bytes > getHtmlLimitBytes()) {
    throw new Error("HTML content is larger than MOU_HTML_MAX_KB allows.");
  }
}

function enforcePdfSize(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer.length : 0;
  if (!bytes) {
    throw new Error("PDF content is empty.");
  }
  if (bytes > PDF_MAX_BYTES) {
    throw new Error("PDF content exceeds the maximum supported upload size.");
  }
}

function computeSha256(content) {
  const value = Buffer.isBuffer(content)
    ? content
    : Buffer.from(String(content || ""), "utf8");
  return crypto.createHash("sha256").update(value).digest("hex");
}

function buildRelativeDataPath(absPath) {
  const dataDir = path.join(__dirname, "..", "data");
  const relative = path.relative(dataDir, absPath).replace(/\\/g, "/");
  return relative.startsWith("../") ? "" : relative;
}

function readBufferSafe(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch {
    return Buffer.alloc(0);
  }
}

function getIndex() {
  store.ensureStorage();
  const index = store.loadIndex();
  if (!Array.isArray(index.streams)) {
    index.streams = [];
  }
  index.streams = index.streams.map(ensureStreamShape);
  return index;
}

function saveIndex(index) {
  store.saveIndex(index);
}

function getUserAgreementStore() {
  store.ensureStorage();
  const agreement = store.loadUserAgreement();
  if (!Array.isArray(agreement.versions)) agreement.versions = [];
  if (!Number.isFinite(Number(agreement.currentVersion))) agreement.currentVersion = 0;
  if (typeof agreement.enabled !== "boolean") {
    agreement.enabled = false;
  }
  return agreement;
}

function saveUserAgreementStore(data) {
  store.saveUserAgreement(data);
}

function getAcksStore() {
  const data = store.loadAcks();
  if (!Array.isArray(data.items)) data.items = [];
  return data;
}

function saveAcksStore(data) {
  store.saveAcks(data);
}

function getViewsStore() {
  const data = store.loadViews();
  if (!Array.isArray(data.items)) data.items = [];
  return data;
}

function saveViewsStore(data) {
  store.saveViews(data);
}

function getRemindersStore() {
  const data = store.loadReminders();
  if (!data || typeof data !== "object") return { schemaVersion: 1, agency: {} };
  if (!data.agency || typeof data.agency !== "object") data.agency = {};
  return data;
}

function saveRemindersStore(data) {
  store.saveReminders(data);
}

function getArchivedDocumentsStore() {
  const data = store.loadArchivedDocuments();
  if (!data || typeof data !== "object") {
    return { schemaVersion: 1, items: [] };
  }
  if (!Array.isArray(data.items)) data.items = [];
  return data;
}

function saveArchivedDocumentsStore(data) {
  store.saveArchivedDocuments(data);
}

function saveArchivedDocumentsStore(data) {
  store.saveArchivedDocuments(data);
}

function getSignInvitesStore() {
  const data = store.loadSignInvites();
  if (!data || typeof data !== "object") {
    return { schemaVersion: 1, items: [] };
  }
  if (!Array.isArray(data.items)) data.items = [];
  return data;
}

function saveSignInvitesStore(data) {
  store.saveSignInvites(data);
}

function genSignInviteToken() {
  return crypto.randomBytes(24).toString("hex");
}

function normalizeAgencySigningMode(value) {
  const mode = normalizeLower(value);
  if (mode === AGENCY_SIGNING_MODE_EXTERNAL_LINK) {
    return AGENCY_SIGNING_MODE_EXTERNAL_LINK;
  }
  if (mode === AGENCY_SIGNING_MODE_SPECIFIC_ADMIN) {
    return AGENCY_SIGNING_MODE_SPECIFIC_ADMIN;
  }
  return AGENCY_SIGNING_MODE_AGENCY_ADMINS;
}

function normalizeAgencySigningConfig(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [key, entry] of Object.entries(raw)) {
    const suffix = normalizeAgencySuffix(key);
    if (!suffix) continue;
    const mode = normalizeAgencySigningMode(entry?.mode);
    const inviteEmail = normalizeText(entry?.inviteEmail);
    const assignedAdminEmail = normalizeText(entry?.assignedAdminEmail);
    const assignedAdminUsername = normalizeText(entry?.assignedAdminUsername);
    const assignedAdminName = normalizeText(entry?.assignedAdminName);
    out[suffix] = {
      mode,
      ...(inviteEmail ? { inviteEmail } : {}),
      ...(entry?.externalLinkAcknowledged === true ? { externalLinkAcknowledged: true } : {}),
      ...(assignedAdminEmail ? { assignedAdminEmail } : {}),
      ...(assignedAdminUsername ? { assignedAdminUsername } : {}),
      ...(assignedAdminName ? { assignedAdminName } : {}),
    };
  }
  return out;
}

function getAgencySigningMode(stream, agencySuffix) {
  const suffix = normalizeAgencySuffix(agencySuffix);
  const assignments = getAssignments(stream);
  const entry = assignments.agencySigning?.[suffix];
  return normalizeAgencySigningMode(entry?.mode);
}

function getAgencySigningInviteEmail(stream, agencySuffix) {
  const suffix = normalizeAgencySuffix(agencySuffix);
  const assignments = getAssignments(stream);
  return normalizeText(assignments.agencySigning?.[suffix]?.inviteEmail);
}

function getAgencySigningAssignedAdminEmail(stream, agencySuffix) {
  const suffix = normalizeAgencySuffix(agencySuffix);
  const assignments = getAssignments(stream);
  return normalizeText(assignments.agencySigning?.[suffix]?.assignedAdminEmail);
}

function getAgencySigningAssignedAdminUsername(stream, agencySuffix) {
  const suffix = normalizeAgencySuffix(agencySuffix);
  const assignments = getAssignments(stream);
  return normalizeText(assignments.agencySigning?.[suffix]?.assignedAdminUsername);
}

function userMatchesAssignedSigningAdmin(authUser, stream, agencySuffix) {
  if (!authUser || !stream) return false;
  const suffix = normalizeAgencySuffix(agencySuffix);
  const assignedEmail = getAgencySigningAssignedAdminEmail(stream, suffix);
  const assignedUsername = getAgencySigningAssignedAdminUsername(stream, suffix);
  const userEmail = String(authUser.email || "").trim().toLowerCase();
  const userUsername = String(authUser.username || "").trim().toLowerCase();
  if (assignedUsername && userUsername === assignedUsername.toLowerCase()) {
    return true;
  }
  if (assignedEmail && userEmail && userEmail === assignedEmail.toLowerCase()) {
    return true;
  }
  return false;
}

function canUserSignAgencyForStream(authUser, stream, agencySuffix) {
  if (!authUser || !stream) return false;
  const suffix = normalizeAgencySuffix(agencySuffix);
  if (!suffix) return false;
  if (!getStreamAgencySuffixes(stream).includes(suffix)) return false;

  const mode = getAgencySigningMode(stream, suffix);
  if (mode === AGENCY_SIGNING_MODE_EXTERNAL_LINK) {
    return false;
  }
  if (mode === AGENCY_SIGNING_MODE_SPECIFIC_ADMIN) {
    return userMatchesAssignedSigningAdmin(authUser, stream, suffix);
  }

  if (authUser.isGlobalAdmin) {
    return true;
  }

  const managed = accessSvc
    .getUserManagedAgencySuffixes(authUser)
    .map(normalizeAgencySuffix)
    .filter(Boolean);
  if (managed.length) {
    return managed.includes(suffix);
  }
  if (authUser.isAgencyAdmin) {
    return accessSvc.isSuffixAllowed(authUser, suffix);
  }
  return normalizeAgencySuffix(resolveUserAgencySuffix(authUser)) === suffix;
}

function buildDocumentViewHref(stream, versionRecord) {
  if (!stream?.mouId || !versionRecord?.version) return null;
  if (normalizeContentType(versionRecord.contentType) === "pdf") {
    return `/mou/file/${encodeURIComponent(stream.mouId)}/${encodeURIComponent(
      versionRecord.version
    )}`;
  }
  return `/mou/view/${encodeURIComponent(stream.mouId)}/${encodeURIComponent(
    versionRecord.version
  )}`;
}

function resolvePrimaryAgencySuffixForUser(authUser, stream) {
  const targetSuffixes = getStreamAgencySuffixes(stream);
  if (!targetSuffixes.length) return "";

  const signable = targetSuffixes.filter((suffix) =>
    canUserSignAgencyForStream(authUser, stream, suffix)
  );
  if (signable.length) return normalizeAgencySuffix(signable[0]);

  const managed = accessSvc
    .getUserManagedAgencySuffixes(authUser)
    .map(normalizeAgencySuffix)
    .filter(Boolean);
  if (managed.length) {
    const managedSet = new Set(managed);
    const match = targetSuffixes.find((suffix) =>
      managedSet.has(normalizeAgencySuffix(suffix))
    );
    if (match) return normalizeAgencySuffix(match);
  }
  if (authUser?.isAgencyAdmin) {
    const match = targetSuffixes.find((suffix) =>
      accessSvc.isSuffixAllowed(authUser, suffix)
    );
    if (match) return normalizeAgencySuffix(match);
  }

  const home = normalizeAgencySuffix(resolveUserAgencySuffix(authUser));
  if (home && targetSuffixes.includes(home)) return home;
  return normalizeAgencySuffix(targetSuffixes[0]);
}

function buildExternalSignPath(token) {
  return `/request-access/mou/${encodeURIComponent(String(token || "").trim())}`;
}

function revokeActiveSignInvitesForAgency({ mouId, agencyId, reason }) {
  const data = getSignInvitesStore();
  const now = nowIso();
  let changed = false;
  for (const item of data.items) {
    if (
      normalizeText(item?.mouId) === normalizeText(mouId) &&
      normalizeAgencySuffix(item?.agencyId) === normalizeAgencySuffix(agencyId) &&
      !item?.usedAt &&
      !item?.revokedAt
    ) {
      item.revokedAt = now;
      item.revokeReason = normalizeText(reason) || "revoked";
      changed = true;
    }
  }
  if (changed) saveSignInvitesStore(data);
}

function revokeSignInvitesForStream(mouId, reason) {
  const data = getSignInvitesStore();
  const now = nowIso();
  let changed = false;
  for (const item of data.items) {
    if (normalizeText(item?.mouId) === normalizeText(mouId) && !item?.usedAt && !item?.revokedAt) {
      item.revokedAt = now;
      item.revokeReason = normalizeText(reason) || "revoked";
      changed = true;
    }
  }
  if (changed) saveSignInvitesStore(data);
}

function purgeSignInvitesForStream(mouId) {
  const data = getSignInvitesStore();
  const before = data.items.length;
  data.items = data.items.filter(
    (item) => normalizeText(item?.mouId) !== normalizeText(mouId)
  );
  if (data.items.length !== before) saveSignInvitesStore(data);
}

function getSignInviteByToken(token) {
  const safeToken = normalizeText(token);
  if (!safeToken) return null;
  return (
    getSignInvitesStore().items.find(
      (item) => normalizeText(item?.token) === safeToken
    ) || null
  );
}

function getActiveSignInviteForAgency({ mouId, agencyId }) {
  const safeMouId = normalizeText(mouId);
  const safeAgencyId = normalizeAgencySuffix(agencyId);
  const nowMs = Date.now();
  return (
    getSignInvitesStore().items.find((item) => {
      if (normalizeText(item?.mouId) !== safeMouId) return false;
      if (normalizeAgencySuffix(item?.agencyId) !== safeAgencyId) return false;
      if (item?.usedAt || item?.revokedAt) return false;
      if (item?.expiresAt && new Date(item.expiresAt).getTime() < nowMs) return false;
      return true;
    }) || null
  );
}

function getUsedSignInviteForAgency({ mouId, agencyId, version }) {
  const safeMouId = normalizeText(mouId);
  const safeAgencyId = normalizeAgencySuffix(agencyId);
  const safeVersion = version == null || version === "" ? null : normalizeVersion(version);
  return (
    getSignInvitesStore()
      .items.filter((item) => {
        if (normalizeText(item?.mouId) !== safeMouId) return false;
        if (normalizeAgencySuffix(item?.agencyId) !== safeAgencyId) return false;
        if (!item?.usedAt) return false;
        if (safeVersion != null && normalizeVersion(item?.version) !== safeVersion) {
          return false;
        }
        return true;
      })
      .sort((a, b) => String(b.usedAt || "").localeCompare(String(a.usedAt || "")))[0] || null
  );
}

function createSignInvite({ mouId, agencyId, version, recipientEmail, actor }) {
  revokeActiveSignInvitesForAgency({ mouId, agencyId, reason: "replaced" });
  const token = genSignInviteToken();
  const createdAt = nowIso();
  const expiresAt = new Date(
    Date.now() + SIGN_INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const invite = {
    inviteId: makeId(),
    token,
    mouId: normalizeText(mouId),
    agencyId: normalizeAgencySuffix(agencyId),
    version: normalizeVersion(version),
    recipientEmail: normalizeText(recipientEmail) || null,
    createdAt,
    expiresAt,
    usedAt: null,
    revokedAt: null,
    createdBy: actor?.uid || actor?.username || null,
  };
  const data = getSignInvitesStore();
  data.items.push(invite);
  saveSignInvitesStore(data);
  return invite;
}

function markSignInviteUsed(token) {
  const safeToken = normalizeText(token);
  if (!safeToken) return null;
  const data = getSignInvitesStore();
  const item = data.items.find((entry) => normalizeText(entry?.token) === safeToken);
  if (!item || item.usedAt) return item?.completionToken || null;
  item.usedAt = nowIso();
  item.completionToken = genSignInviteToken();
  item.completionViewedAt = null;
  saveSignInvitesStore(data);
  return item.completionToken;
}

function getSignInviteByCompletionToken(completionToken) {
  const safeToken = normalizeText(completionToken);
  if (!safeToken) return null;
  return (
    getSignInvitesStore().items.find(
      (item) => normalizeText(item?.completionToken) === safeToken
    ) || null
  );
}

function resolveSignInviteCompletion(completionToken) {
  const invite = getSignInviteByCompletionToken(completionToken);
  if (!invite || !invite.usedAt) {
    throw new Error("This confirmation link is invalid.");
  }
  if (invite.completionViewedAt) {
    throw new Error("This confirmation link has expired.");
  }

  const stream = getStreamById(invite.mouId);
  const currentVersion = getCurrentVersion(stream);
  if (!currentVersion) {
    throw new Error("This document is no longer available.");
  }
  if (normalizeVersion(currentVersion.version) !== normalizeVersion(invite.version)) {
    throw new Error("This confirmation link is no longer valid.");
  }

  const signature = getCurrentAgencySignatureForStream(stream, invite.agencyId);
  if (!signature) {
    throw new Error("Signed document evidence was not found.");
  }

  const evidence = getAgencyEvidence({
    mouId: stream.mouId,
    agencyId: invite.agencyId,
    version: currentVersion.version,
  });

  return { stream, currentVersion, invite, signature, evidence };
}

function resolveSignInviteCompletionPdf(completionToken) {
  const invite = getSignInviteByCompletionToken(completionToken);
  if (!invite || !invite.usedAt) {
    throw new Error("This download link is invalid.");
  }
  const stream = getStreamById(invite.mouId);
  const currentVersion = getCurrentVersion(stream);
  if (!currentVersion) {
    throw new Error("This document is no longer available.");
  }
  const signature = getCurrentAgencySignatureForStream(stream, invite.agencyId);
  if (!signature) {
    throw new Error("Signed document evidence was not found.");
  }
  return {
    stream,
    currentVersion,
    invite,
    signature,
  };
}

function markSignInviteCompletionViewed(completionToken) {
  const safeToken = normalizeText(completionToken);
  if (!safeToken) return;
  const data = getSignInvitesStore();
  const item = data.items.find(
    (entry) => normalizeText(entry?.completionToken) === safeToken
  );
  if (!item || item.completionViewedAt) return;
  item.completionViewedAt = nowIso();
  saveSignInvitesStore(data);
}

function markSignInviteUsedForAgencySignature({ mouId, agencySuffix, version }) {
  const invite = getActiveSignInviteForAgency({
    mouId,
    agencyId: agencySuffix,
  });
  if (
    invite &&
    normalizeVersion(invite.version) === normalizeVersion(version)
  ) {
    markSignInviteUsed(invite.token);
  }
}

function resolveValidSignInvite(token) {
  const invite = getSignInviteByToken(token);
  if (!invite) {
    throw new Error("Sign link not found.");
  }
  if (invite.revokedAt) {
    throw new Error("This sign link is no longer valid.");
  }
  if (invite.usedAt) {
    throw new Error("This sign link has already been used.");
  }
  if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) {
    throw new Error("This sign link has expired.");
  }

  const stream = getStreamById(invite.mouId);
  const currentVersion = getCurrentVersion(stream);
  if (!currentVersion) {
    throw new Error("This document is not available for signing.");
  }
  if (
    normalizeVersion(currentVersion.version) !== normalizeVersion(invite.version)
  ) {
    throw new Error(
      "This sign link is for an older document version. Request a new link from your administrator."
    );
  }
  if (getAgencySigningMode(stream, invite.agencyId) !== AGENCY_SIGNING_MODE_EXTERNAL_LINK) {
    throw new Error("This agency no longer accepts external sign links.");
  }
  const targetSuffixes = getStreamAgencySuffixes(stream);
  if (!targetSuffixes.includes(normalizeAgencySuffix(invite.agencyId))) {
    throw new Error("This document is no longer assigned to this agency.");
  }

  return { stream, currentVersion, invite };
}

function syncExternalSignInvitesForStream({ stream, actor, agencySuffixes }) {
  const currentVersion = getCurrentVersion(stream);
  if (!currentVersion) return [];
  const suffixes = Array.isArray(agencySuffixes)
    ? agencySuffixes.map(normalizeAgencySuffix).filter(Boolean)
    : getTargetAgenciesForStream(stream)
        .map((agency) => normalizeAgencySuffix(agency?.suffix))
        .filter(Boolean);
  const created = [];
  for (const agencySuffix of suffixes) {
    if (getAgencySigningMode(stream, agencySuffix) !== AGENCY_SIGNING_MODE_EXTERNAL_LINK) {
      continue;
    }
    if (getCurrentAgencySignatureForStream(stream, agencySuffix)) {
      continue;
    }
    const inviteEmail = getAgencySigningInviteEmail(stream, agencySuffix);
    const existing = getActiveSignInviteForAgency({
      mouId: stream.mouId,
      agencyId: agencySuffix,
    });
    if (
      existing &&
      normalizeVersion(existing.version) === normalizeVersion(currentVersion.version)
    ) {
      created.push(existing);
      continue;
    }
    created.push(
      createSignInvite({
        mouId: stream.mouId,
        agencyId: agencySuffix,
        version: currentVersion.version,
        recipientEmail: inviteEmail,
        actor,
      })
    );
  }
  return created;
}

function refreshExternalSignInvitesAfterVersionChange({ stream, actor }) {
  revokeSignInvitesForStream(stream.mouId, "version_changed");
  return syncExternalSignInvitesForStream({ stream, actor });
}

function streamHasAnySignatures(stream) {
  for (const versionRecord of stream?.versions || []) {
    if (Array.isArray(versionRecord.signatures) && versionRecord.signatures.length) {
      return true;
    }
  }
  return false;
}

function getStreamSignatureSummary(stream) {
  let signatureCount = 0;
  const agencies = new Set();
  for (const versionRecord of stream?.versions || []) {
    for (const signature of versionRecord.signatures || []) {
      signatureCount += 1;
      agencies.add(normalizeAgencySuffix(signature?.agencyId));
    }
  }
  return {
    signatureCount,
    agencyCount: agencies.size,
    hasSignatures: signatureCount > 0,
  };
}

function getStreamActiveAssignmentSignatureSummary(stream) {
  const activeSuffixes = new Set(getStreamAgencySuffixes(stream));
  const agenciesWithSignatures = new Set();
  for (const versionRecord of stream?.versions || []) {
    for (const signature of versionRecord.signatures || []) {
      const agencyId = normalizeAgencySuffix(signature?.agencyId);
      if (activeSuffixes.has(agencyId)) {
        agenciesWithSignatures.add(agencyId);
      }
    }
  }
  const signatureCount = agenciesWithSignatures.size;
  return {
    signatureCount,
    agencyCount: signatureCount,
    hasSignatures: signatureCount > 0,
  };
}

function getArchivedAgencySuffixesForStream(mouId) {
  const safeMouId = normalizeText(mouId);
  if (!safeMouId) return new Set();
  return new Set(
    getArchivedDocumentsStore()
      .items.filter((item) => normalizeText(item?.mouId) === safeMouId)
      .map((item) => normalizeAgencySuffix(item?.agencyId))
      .filter(Boolean)
  );
}

function copyDataFile(sourceRelativePath, destRelativePath) {
  const sourceAbs = getAbsoluteDataPath(sourceRelativePath);
  const destAbs = getAbsoluteDataPath(destRelativePath);
  if (!sourceAbs || !destAbs || !fs.existsSync(sourceAbs)) return false;
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(sourceAbs, destAbs);
  return true;
}

function deleteArchiveSnapshotFiles(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  deleteSignatureArtifacts(snapshot);
}

function createArchiveSnapshot(archiveId, signatureEntry, versionRecord) {
  if (!signatureEntry) return null;
  const safeArchiveId = normalizeText(archiveId);
  if (!safeArchiveId) return null;
  const snapshot = {
    signedVersion: normalizeVersion(versionRecord?.version),
    contentType: normalizeContentType(versionRecord?.contentType),
    signature: {
      agencyId: signatureEntry.agencyId,
      agencyNameAtSign: signatureEntry.agencyNameAtSign,
      attestationText: signatureEntry.attestationText,
      signerDisplayName: signatureEntry.signerDisplayName,
      signerStatusAtSign: signatureEntry.signerStatusAtSign,
      signedAt: signatureEntry.signedAt,
      customFieldValues: Array.isArray(signatureEntry.customFieldValues)
        ? signatureEntry.customFieldValues
        : [],
      uploadedSignedCopyContentType: signatureEntry.uploadedSignedCopyContentType || "",
    },
    signedHtmlPath: "",
    signaturePngPath: "",
    uploadedSignedCopyPath: "",
  };
  const base = `mou-archives/${safeArchiveId}`;
  if (signatureEntry.signedHtmlPath) {
    const dest = `${base}/signed.html`;
    if (copyDataFile(signatureEntry.signedHtmlPath, dest)) {
      snapshot.signedHtmlPath = dest;
    }
  }
  if (signatureEntry.signaturePngPath) {
    const dest = `${base}/signature.png`;
    if (copyDataFile(signatureEntry.signaturePngPath, dest)) {
      snapshot.signaturePngPath = dest;
    }
  }
  if (signatureEntry.uploadedSignedCopyPath) {
    const ext = path.extname(String(signatureEntry.uploadedSignedCopyPath || "")) || ".pdf";
    const dest = `${base}/uploaded${ext}`;
    if (copyDataFile(signatureEntry.uploadedSignedCopyPath, dest)) {
      snapshot.uploadedSignedCopyPath = dest;
    }
  }
  const countersignature = signatureEntry.countersignature;
  if (countersignature && typeof countersignature === "object") {
    snapshot.signature.countersignature = {
      attestationText: countersignature.attestationText,
      signerDisplayName: countersignature.signerDisplayName,
      signerStatusAtSign: countersignature.signerStatusAtSign,
      signedAt: countersignature.signedAt,
      customFieldValues: Array.isArray(countersignature.customFieldValues)
        ? countersignature.customFieldValues
        : [],
      uploadedSignedCopyContentType: countersignature.uploadedSignedCopyContentType || "",
      signaturePngPath: "",
      uploadedSignedCopyPath: "",
    };
    if (countersignature.signaturePngPath) {
      const dest = `${base}/countersignature.png`;
      if (copyDataFile(countersignature.signaturePngPath, dest)) {
        snapshot.signature.countersignature.signaturePngPath = dest;
      }
    }
    if (countersignature.uploadedSignedCopyPath) {
      const ext =
        path.extname(String(countersignature.uploadedSignedCopyPath || "")) || ".pdf";
      const dest = `${base}/countersign-uploaded${ext}`;
      if (copyDataFile(countersignature.uploadedSignedCopyPath, dest)) {
        snapshot.signature.countersignature.uploadedSignedCopyPath = dest;
      }
    }
  }
  return snapshot;
}

function getArchivedDocumentById(archiveId) {
  const safeArchiveId = normalizeText(archiveId);
  if (!safeArchiveId) return null;
  const record = getArchivedDocumentsStore().items.find(
    (item) => normalizeText(item?.archiveId) === safeArchiveId
  );
  return record ? normalizeArchivedDocumentRecord(record) : null;
}

function getArchivedDocumentView(archiveId) {
  const archivedRecord = getArchivedDocumentById(archiveId);
  if (!archivedRecord) {
    throw new Error("Archived document not found.");
  }

  const stream = (() => {
    try {
      return getStreamById(archivedRecord.mouId);
    } catch {
      return null;
    }
  })();

  if (stream && archivedRecord.signedVersion) {
    try {
      const evidence = getAgencyEvidence({
        mouId: archivedRecord.mouId,
        agencyId: archivedRecord.agencyId,
        version: archivedRecord.signedVersion,
      });
      return {
        archivedRecord,
        stream,
        html: evidence.html || "",
        source: "live",
      };
    } catch {
      // Live signature may have been cleared after archive; use snapshot below.
    }
  }

  const snapshotHtmlPath = getAbsoluteDataPath(archivedRecord.snapshot?.signedHtmlPath);
  if (snapshotHtmlPath && fs.existsSync(snapshotHtmlPath)) {
    return {
      archivedRecord,
      stream: null,
      html: store.readHtml(snapshotHtmlPath),
      source: "snapshot",
    };
  }

  throw new Error("Signed document evidence was not found for this archive.");
}

async function getArchivedSignedPdfExport(archiveId) {
  const archivedRecord = getArchivedDocumentById(archiveId);
  if (!archivedRecord) {
    throw new Error("Archived document not found.");
  }
  if (!archivedRecord.signedVersion) {
    throw new Error("This archived document does not include a signed copy.");
  }

  const stream = (() => {
    try {
      return getStreamById(archivedRecord.mouId);
    } catch {
      return null;
    }
  })();

  if (stream) {
    try {
      return await getSignedPdfExport({
        mouId: archivedRecord.mouId,
        agencyId: archivedRecord.agencyId,
        version: archivedRecord.signedVersion,
      });
    } catch {
      // Live signature may have been cleared after archive; use snapshot below.
    }
  }

  const snapshot = archivedRecord.snapshot;
  const signatureRecord = snapshot?.signature
    ? {
        ...snapshot.signature,
        agencyId: archivedRecord.agencyId,
        agencyNameAtSign:
          snapshot.signature.agencyNameAtSign ||
          archivedRecord.agencyName ||
          archivedRecord.agencyId,
        uploadedSignedCopyPath: snapshot.uploadedSignedCopyPath || "",
        uploadedSignedCopyContentType:
          snapshot.signature.uploadedSignedCopyContentType || "",
        signaturePngPath: snapshot.signaturePngPath || "",
      }
    : null;
  if (signatureRecord?.uploadedSignedCopyPath) {
    const pdfBuffer = await buildUploadedSignedCopyPdfBuffer(signatureRecord);
    return {
      fileName: `${sanitizeFileSegment(archivedRecord.mouTitle, "mou")}-${archivedRecord.agencyId}-v${archivedRecord.signedVersion}-signed.pdf`,
      contentType: "application/pdf",
      buffer: pdfBuffer,
    };
  }

  if (signatureRecord) {
    const pdfBuffer = await buildSignatureAppendixPdfBuffer({
      stream: {
        mouId: archivedRecord.mouId,
        title: archivedRecord.mouTitle || "MOU",
        assignments: {
          serverwide: false,
          agencySuffixes: [archivedRecord.agencyId],
        },
      },
      versionRecord: {
        version: archivedRecord.signedVersion,
        contentType: snapshot?.contentType || "html",
      },
      signatureRecord,
    });
    return {
      fileName: `${sanitizeFileSegment(archivedRecord.mouTitle, "mou")}-${archivedRecord.agencyId}-v${archivedRecord.signedVersion}-signed.pdf`,
      contentType: "application/pdf",
      buffer: pdfBuffer,
    };
  }

  throw new Error("Signed PDF is unavailable for this archived document.");
}

function getArchivedDocumentContentExport(archiveId) {
  const archivedRecord = getArchivedDocumentById(archiveId);
  if (!archivedRecord) {
    throw new Error("Archived document not found.");
  }
  if (!archivedRecord.currentVersion) {
    throw new Error("Archived document version was not recorded.");
  }

  try {
    const content = getVersionContent(archivedRecord.mouId, archivedRecord.currentVersion);
    return {
      archivedRecord,
      stream: content.stream,
      version: content.version,
      contentType: content.contentType,
      fileName: content.fileName,
      contentBuffer: content.contentBuffer,
      html: content.html,
    };
  } catch (err) {
    throw new Error(
      err?.message ||
        "The source document file is no longer available. Only signed archived copies can be downloaded."
    );
  }
}

function normalizeScopeType(value) {
  return normalizeLower(value) === "agency" ? "agency" : "global";
}

function normalizeContentType(value) {
  const normalized = normalizeLower(value);
  if (normalized === "pdf") return "pdf";
  if (normalized === "markdown") return "markdown";
  return "html";
}

function getFileExtensionForContentType(contentType) {
  if (contentType === "pdf") return "pdf";
  if (contentType === "markdown") return "md";
  return "html";
}

function normalizeAgencySuffix(value) {
  return normalizeLower(value);
}

function normalizeAgencySuffixList(values) {
  const list = Array.isArray(values) ? values : [values];
  const seen = new Set();
  const out = [];
  for (const value of list) {
    const suffix = normalizeAgencySuffix(value);
    if (!suffix || seen.has(suffix)) continue;
    seen.add(suffix);
    out.push(suffix);
  }
  return out;
}

function normalizedReminderDays(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  const fallback = getInt("MOU_DEFAULT_REMINDER_DAYS", 7);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 7;
}

function normalizedMandatory(value) {
  return value === true || String(value || "").toLowerCase() === "true";
}

function normalizeCustomSignerFields(value) {
  const rawList = Array.isArray(value)
    ? value
    : value === undefined || value === null
      ? []
      : [value];
  const seen = new Set();
  const out = [];
  for (const entry of rawList) {
    const label = normalizeText(entry);
    if (!label) continue;
    const normalizedKey = label.toLowerCase();
    if (seen.has(normalizedKey)) continue;
    seen.add(normalizedKey);
    out.push(label.slice(0, 80));
    if (out.length >= 8) break;
  }
  return out;
}

function normalizeCustomFieldValues(value, labels) {
  const rawList = Array.isArray(value)
    ? value
    : value === undefined || value === null
      ? []
      : [value];
  const out = [];
  const safeLabels = normalizeCustomSignerFields(labels);
  for (let index = 0; index < safeLabels.length; index += 1) {
    out.push({
      label: safeLabels[index],
      value: normalizeText(rawList[index]).slice(0, 200),
    });
  }
  return out;
}

function requireCustomFieldValues(values) {
  const list = Array.isArray(values) ? values : [];
  for (const entry of list) {
    const label = normalizeText(entry?.label) || "Custom field";
    const fieldValue = normalizeText(entry?.value);
    if (!fieldValue) {
      throw new Error(`${label} is required.`);
    }
  }
}

function sortVersions(versions) {
  return (Array.isArray(versions) ? versions : [])
    .slice()
    .sort((a, b) => normalizeVersion(a?.version) - normalizeVersion(b?.version));
}

function sortStreams(streams) {
  return (Array.isArray(streams) ? streams : [])
    .slice()
    .sort((a, b) =>
      String(a?.title || "").localeCompare(String(b?.title || ""), undefined, {
        sensitivity: "base",
      })
    );
}

function ensureVersionShape(versionRecord) {
  const contentPath = normalizeText(
    versionRecord?.contentPath || versionRecord?.contentHtmlPath || ""
  );
  const inferredContentType = contentPath.endsWith(".pdf")
    ? "pdf"
    : contentPath.endsWith(".md")
      ? "markdown"
      : "html";
  const contentType = normalizeContentType(versionRecord?.contentType || inferredContentType);
  const rawState = normalizeText(versionRecord?.state || "").toLowerCase();
  const state =
    rawState === "previous" || rawState === "superseded"
      ? "previous"
      : "current";
  return {
    version: normalizeVersion(versionRecord?.version),
    state,
    contentType,
    fileExtension: normalizeText(versionRecord?.fileExtension || getFileExtensionForContentType(contentType)),
    originalFileName: normalizeText(versionRecord?.originalFileName || ""),
    contentPath,
    contentSha256: normalizeText(versionRecord?.contentSha256 || ""),
    createdAt: versionRecord?.createdAt || null,
    createdBy: versionRecord?.createdBy || null,
    updatedAt: versionRecord?.updatedAt || null,
    updatedBy: versionRecord?.updatedBy || null,
    activeAt: versionRecord?.activeAt || versionRecord?.createdAt || null,
    activeBy: versionRecord?.activeBy || versionRecord?.createdBy || null,
    previousAt: versionRecord?.previousAt || null,
    previousBy: versionRecord?.previousBy || null,
    customSignerFields: normalizeCustomSignerFields(versionRecord?.customSignerFields),
    signatures: Array.isArray(versionRecord?.signatures) ? versionRecord.signatures : [],
  };
}

function ensureStreamShape(stream) {
  const legacyScopeType = normalizeScopeType(stream?.scopeType);
  const legacyAgencySuffix = normalizeAgencySuffix(stream?.agencySuffix);
  const assignments = normalizeAssignments(stream?.assignments, {
    scopeType: legacyScopeType,
    agencySuffix: legacyAgencySuffix,
  });
  return {
    mouId: normalizeText(stream?.mouId),
    title: normalizeText(stream?.title),
    slug: normalizeText(stream?.slug || slugify(stream?.title)),
    mandatory: normalizedMandatory(stream?.mandatory),
    reminderDays: normalizedReminderDays(stream?.reminderDays),
    assignments,
    createdAt: stream?.createdAt || null,
    createdBy: stream?.createdBy || null,
    updatedAt: stream?.updatedAt || null,
    updatedBy: stream?.updatedBy || null,
    versions: sortVersions((stream?.versions || []).map(ensureVersionShape)),
  };
}

function findStream(index, mouId) {
  return (index.streams || []).find(
    (stream) => String(stream?.mouId || "") === String(mouId || "")
  );
}

function assertUniqueStreamTitle(index, title, excludeMouId) {
  const normalizedTitle = normalizeLower(title);
  if (!normalizedTitle) return;
  const duplicate = (index?.streams || []).find((stream) => {
    if (excludeMouId && String(stream?.mouId || "") === String(excludeMouId || "")) {
      return false;
    }
    return normalizeLower(stream?.title) === normalizedTitle;
  });
  if (duplicate) {
    throw new Error("A document with this title already exists.");
  }
}

function findVersion(stream, version) {
  const numeric = normalizeVersion(version);
  return (
    (stream?.versions || []).find(
      (entry) => normalizeVersion(entry?.version) === numeric
    ) || null
  );
}

function getCurrentVersion(stream) {
  return (
    sortVersions(stream?.versions || []).find(
      (entry) => String(entry?.state || "") === "current"
    ) || null
  );
}

function getLatestVersion(stream) {
  const versions = sortVersions(stream?.versions || []);
  return versions.length ? versions[versions.length - 1] : null;
}

function getAgencyBySuffix(agencySuffix) {
  const suffix = normalizeAgencySuffix(agencySuffix);
  return (
    (agenciesStore.load() || []).find(
      (agency) => normalizeAgencySuffix(agency?.suffix) === suffix
    ) || null
  );
}

function getAllAgencies() {
  return agenciesStore.load() || [];
}

function normalizeAssignments(assignments, legacyStream) {
  let base;
  if (assignments && typeof assignments === "object") {
    const serverwide = normalizedMandatory(assignments.serverwide);
    base = {
      serverwide,
      agencySuffixes: serverwide
        ? []
        : normalizeAgencySuffixList(assignments.agencySuffixes),
    };
  } else {
    const legacyScopeType = normalizeScopeType(legacyStream?.scopeType);
    if (legacyScopeType === "global") {
      base = {
        serverwide: true,
        agencySuffixes: [],
      };
    } else {
      base = {
        serverwide: false,
        agencySuffixes: normalizeAgencySuffixList(legacyStream?.agencySuffix),
      };
    }
  }

  const rawSigning =
    (assignments && assignments.agencySigning) ||
    legacyStream?.assignments?.agencySigning;
  const normalizedSigning = normalizeAgencySigningConfig(rawSigning);
  const targetSuffixes = base.serverwide
    ? getAllAgencies()
        .map((agency) => normalizeAgencySuffix(agency?.suffix))
        .filter(Boolean)
    : base.agencySuffixes.slice();

  const agencySigning = {};
  for (const suffix of targetSuffixes) {
    agencySigning[suffix] = normalizedSigning[suffix] || {
      mode: AGENCY_SIGNING_MODE_AGENCY_ADMINS,
    };
  }

  return {
    ...base,
    agencySigning,
  };
}

function getAssignments(stream) {
  return normalizeAssignments(stream?.assignments, stream);
}

function hasActiveAssignments(stream) {
  const assignments = getAssignments(stream);
  return assignments.serverwide || assignments.agencySuffixes.length > 0;
}

function getTargetAgenciesForStream(stream) {
  const assignments = getAssignments(stream);
  if (assignments.serverwide) {
    return getAllAgencies();
  }
  return assignments.agencySuffixes
    .map((suffix) => {
      const agency = getAgencyBySuffix(suffix);
      if (agency) return agency;
      return {
        suffix,
        name: suffix,
        groupPrefix: String(suffix || "").trim().toUpperCase(),
      };
    })
    .filter(Boolean);
}

function getScopeLabel(stream) {
  const assignments = getAssignments(stream);
  if (assignments.serverwide) {
    return "Serverwide";
  }
  const agencies = getTargetAgenciesForStream(stream);
  if (!agencies.length) {
    return "Inactive";
  }
  if (agencies.length === 1) {
    const agency = agencies[0];
    return agency.name || agency.groupPrefix || agency.suffix;
  }
  return `${agencies.length} agencies`;
}

function getStreamAgencySuffixes(stream) {
  const assignments = getAssignments(stream);
  if (assignments.serverwide) {
    return getAllAgencies()
      .map((agency) => normalizeAgencySuffix(agency?.suffix))
      .filter(Boolean);
  }
  return assignments.agencySuffixes.slice();
}

function buildAssignmentsFromAgencySuffixes(agencySuffixes, previousAssignments) {
  const normalized = normalizeAgencySuffixList(agencySuffixes);
  const allAgencySuffixes = normalizeAgencySuffixList(
    getAllAgencies().map((agency) => agency?.suffix)
  );
  const allAssigned =
    normalized.length > 0 &&
    normalized.length === allAgencySuffixes.length &&
    allAgencySuffixes.every((suffix) => normalized.includes(suffix));
  const base = allAssigned
    ? { serverwide: true, agencySuffixes: [] }
    : { serverwide: false, agencySuffixes: normalized };
  const prevSigning = normalizeAgencySigningConfig(previousAssignments?.agencySigning);
  const targetSuffixes = base.serverwide ? allAgencySuffixes : base.agencySuffixes;
  const agencySigning = {};
  for (const suffix of targetSuffixes) {
    agencySigning[suffix] = prevSigning[suffix] || {
      mode: AGENCY_SIGNING_MODE_AGENCY_ADMINS,
    };
  }
  return {
    ...base,
    agencySigning,
  };
}

function validateAgencySigningForAssignments(assignments) {
  const suffixes = getStreamAgencySuffixes({ assignments });
  for (const suffix of suffixes) {
    const entry = assignments?.agencySigning?.[suffix];
    const mode = normalizeAgencySigningMode(entry?.mode);
    const agencyLabel = String(suffix || "").trim().toUpperCase() || "agency";
    if (mode === AGENCY_SIGNING_MODE_SPECIFIC_ADMIN) {
      if (
        !normalizeText(entry?.assignedAdminEmail) &&
        !normalizeText(entry?.assignedAdminUsername)
      ) {
        throw new Error(
          `Agency Admin selection is required for Specific Agency Admin signing (${agencyLabel}).`
        );
      }
    }
  }
}

function buildAssignmentsWithSigning({
  mouId,
  serverwide,
  agencySuffixes,
  agencySigning,
  previousAssignments,
}) {
  const base = normalizeAssignments({
    serverwide,
    agencySuffixes,
    agencySigning,
  });
  const previous = getAssignments({ assignments: previousAssignments || {} });
  const prevSuffixes = getStreamAgencySuffixes({ assignments: previous });
  const nextSuffixes = getStreamAgencySuffixes({ assignments: base });
  const inputSigning = normalizeAgencySigningConfig(agencySigning);

  for (const suffix of prevSuffixes) {
    if (!nextSuffixes.includes(suffix)) {
      revokeActiveSignInvitesForAgency({
        mouId,
        agencyId: suffix,
        reason: "unassigned",
      });
    }
  }

  const mergedSigning = { ...base.agencySigning };
  for (const suffix of nextSuffixes) {
    if (inputSigning[suffix]) {
      mergedSigning[suffix] = inputSigning[suffix];
    }
    const prevMode = normalizeAgencySigningMode(previous.agencySigning?.[suffix]?.mode);
    const nextMode = normalizeAgencySigningMode(mergedSigning[suffix]?.mode);
    if (
      prevMode === AGENCY_SIGNING_MODE_EXTERNAL_LINK &&
      nextMode !== AGENCY_SIGNING_MODE_EXTERNAL_LINK
    ) {
      revokeActiveSignInvitesForAgency({
        mouId,
        agencyId: suffix,
        reason: "mode_changed",
      });
    }
  }

  return {
    ...base,
    agencySigning: mergedSigning,
  };
}

function getLatestSignatureForAgency(stream, agencyId) {
  const safeAgencyId = normalizeAgencySuffix(agencyId);
  return (
    sortVersions(stream?.versions || [])
      .reverse()
      .flatMap((versionRecord) =>
        (versionRecord.signatures || [])
          .filter(
            (entry) => normalizeAgencySuffix(entry?.agencyId) === safeAgencyId
          )
          .map((entry) => ({ versionRecord, entry }))
      )[0] || null
  );
}

function getHistoricalSignedVersionsForAgency(stream, agencyId, currentVersion) {
  const safeAgencyId = normalizeAgencySuffix(agencyId);
  const currentVersionNumber = normalizeVersion(currentVersion);
  return sortVersions(stream?.versions || [])
    .filter(
      (versionRecord) =>
        normalizeVersion(versionRecord?.version) < currentVersionNumber
    )
    .filter((versionRecord) =>
      (versionRecord.signatures || []).some(
        (entry) => normalizeAgencySuffix(entry?.agencyId) === safeAgencyId
      )
    )
    .map((versionRecord) => normalizeVersion(versionRecord.version));
}

function deleteSignatureArtifacts(signature) {
  const signedHtmlPath = getAbsoluteDataPath(signature?.signedHtmlPath);
  const signaturePngPath = getAbsoluteDataPath(signature?.signaturePngPath);
  const uploadedSignedCopyPath = getAbsoluteDataPath(signature?.uploadedSignedCopyPath);
  const countersignaturePngPath = getAbsoluteDataPath(
    signature?.countersignature?.signaturePngPath
  );
  const countersignUploadedPath = getAbsoluteDataPath(
    signature?.countersignature?.uploadedSignedCopyPath
  );
  if (signedHtmlPath) store.deleteFile(signedHtmlPath);
  if (signaturePngPath) store.deleteFile(signaturePngPath);
  if (uploadedSignedCopyPath) store.deleteFile(uploadedSignedCopyPath);
  if (countersignaturePngPath) store.deleteFile(countersignaturePngPath);
  if (countersignUploadedPath) store.deleteFile(countersignUploadedPath);
}

function normalizeArchivedDocumentRecord(record) {
  const normalizedStatus = normalizeText(record?.status);
  return {
    archiveId: normalizeText(record?.archiveId) || makeId(),
    mouId: normalizeText(record?.mouId),
    mouTitle: normalizeText(record?.mouTitle),
    scopeType: normalizeScopeType(record?.scopeType),
    scopeLabel: normalizeText(record?.scopeLabel),
    currentVersion: normalizeVersion(record?.currentVersion),
    agencyId: normalizeAgencySuffix(record?.agencyId),
    agencyName: normalizeText(record?.agencyName),
    signedVersion: normalizeVersion(record?.signedVersion) || null,
    signerDisplayName: normalizeText(record?.signerDisplayName),
    signedAt: record?.signedAt || null,
    historicalSignedVersions: Array.isArray(record?.historicalSignedVersions)
      ? record.historicalSignedVersions
          .map((value) => normalizeVersion(value))
          .filter(Boolean)
      : [],
    status: normalizedStatus === "Current" ? "Signed" : (normalizedStatus || "Archived"),
    archivedAt: record?.archivedAt || null,
    archivedBy: normalizeText(record?.archivedBy),
    snapshot: record?.snapshot && typeof record.snapshot === "object" ? record.snapshot : null,
  };
}

function listArchivedDocumentRows() {
  return getArchivedDocumentsStore()
    .items.map((record) => {
      const normalized = normalizeArchivedDocumentRecord(record);
      const agency = getAgencyBySuffix(normalized.agencyId);
      return {
        ...normalized,
        agencyName:
          agency?.name ||
          agency?.groupPrefix ||
          normalized.agencyName ||
          normalized.agencyId,
      };
    })
    .sort((a, b) => String(b.archivedAt || "").localeCompare(String(a.archivedAt || "")));
}

function resolveUserAgencySuffix(authUser) {
  if (!authUser) return "";
  return normalizeAgencySuffix(accessSvc.resolveAgencySuffixFromUser(authUser));
}

function streamAppliesToUser(stream, authUser) {
  if (!authUser) return false;
  if (!hasActiveAssignments(stream)) return false;
  const managedSuffixes = accessSvc.getUserManagedAgencySuffixes(authUser);
  const managedSet = new Set(managedSuffixes.map(normalizeAgencySuffix));
  if (getAssignments(stream).serverwide) {
    if (authUser.isGlobalAdmin && !managedSuffixes.length) {
      return false;
    }
    return true;
  }
  const targetAgencySuffixes = getStreamAgencySuffixes(stream);
  if (!targetAgencySuffixes.length) return false;
  if (managedSuffixes.length) {
    return targetAgencySuffixes.some((suffix) =>
      managedSet.has(normalizeAgencySuffix(suffix))
    );
  }
  if (authUser.isAgencyAdmin) {
    return targetAgencySuffixes.some((suffix) =>
      accessSvc.isSuffixAllowed(authUser, suffix)
    );
  }
  return targetAgencySuffixes.includes(resolveUserAgencySuffix(authUser));
}

function getVisibleStreamsForUser(authUser) {
  return listStreams().filter((stream) => streamAppliesToUser(stream, authUser));
}

function listStreams() {
  const index = getIndex();
  return sortStreams(index.streams || []);
}

function listCurrentStreams() {
  return sortStreams(listStreams().filter((stream) => !!getCurrentVersion(stream)));
}

function listCurrentStreamsForUser(authUser) {
  return sortStreams(
    listCurrentStreams().filter((stream) => streamAppliesToUser(stream, authUser))
  );
}

function getStreamById(mouId) {
  const index = getIndex();
  const stream = ensureStreamShape(findStream(index, mouId));
  if (!stream?.mouId) throw new Error("MOU stream not found.");
  return clone(stream);
}

function getStreamAndVersion(mouId, version) {
  const index = getIndex();
  const stream = findStream(index, mouId);
  if (!stream) throw new Error("MOU stream not found.");
  const versionRecord = findVersion(stream, version);
  if (!versionRecord) throw new Error("MOU version not found.");
  return {
    index,
    stream,
    versionRecord,
  };
}

function getAbsoluteContentPath(versionRecord) {
  const rel = normalizeText(versionRecord?.contentPath || versionRecord?.contentHtmlPath);
  if (!rel) return "";
  return path.join(__dirname, "..", "data", rel);
}

function readContentBuffer(versionRecord) {
  const absPath = getAbsoluteContentPath(versionRecord);
  return absPath ? readBufferSafe(absPath) : Buffer.alloc(0);
}

function readHtmlContent(versionRecord) {
  const buffer = readContentBuffer(versionRecord);
  return buffer.length ? buffer.toString("utf8") : "";
}

function renderDocumentHtml(versionRecord) {
  const rawContent = readHtmlContent(versionRecord);
  const contentType = normalizeContentType(versionRecord?.contentType);
  if (contentType === "markdown") {
    return sanitizeMouHtml(marked.parse(rawContent || ""));
  }
  return rawContent;
}

function renderContentPreview({ contentType, html }) {
  const normalized = normalizeContentType(contentType);
  if (normalized === "markdown") {
    return sanitizeMouHtml(marked.parse(String(html || "")));
  }
  if (normalized === "html") {
    return sanitizeMouHtml(String(html || ""));
  }
  return "";
}

function renderUserAgreementHtml(markdownSource) {
  return sanitizeUserAgreementHtml(marked.parse(String(markdownSource || "")));
}

function decodeBasicHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'");
}

function htmlToPlainText(value) {
  return decodeBasicHtmlEntities(
    String(value || "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<\/li>/gi, "\n")
      .replace(/<(td|th)[^>]*>/gi, " ")
      .replace(/<\/(div|p|h1|h2|h3|h4|h5|h6|blockquote|ul|ol|table|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeFileSegment(value, fallback) {
  return (
    String(value || "")
      .trim()
      .replace(/[^a-z0-9._-]+/gi, "-")
      .replace(/-+/g, "-")
      .replace(/^[-_.]+|[-_.]+$/g, "") || String(fallback || "file")
  );
}

function setPdfFont(doc, weight) {
  const isBold = weight === "bold";
  const customPath = isBold ? (PDF_FONT_PATHS.bold || PDF_FONT_PATHS.regular) : PDF_FONT_PATHS.regular;
  if (customPath) {
    doc.font(customPath);
    return doc;
  }
  doc.font(isBold ? "Helvetica-Bold" : "Helvetica");
  return doc;
}

function collectPdfBuffer(drawFn) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      autoFirstPage: false,
      margin: 54,
      size: "LETTER",
      bufferPages: true,
    });
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    Promise.resolve()
      .then(() => drawFn(doc))
      .then(() => doc.end())
      .catch((err) => reject(err));
  });
}

async function normalizeImageBufferForPdf(buffer, sourcePath, contentType) {
  const ext = normalizeLower(path.extname(sourcePath || "").replace(/^\./, ""));
  const mime = normalizeLower(contentType);
  if (mime === "image/png" || ext === "png") {
    return { buffer, kind: "png" };
  }
  if (mime === "image/jpeg" || mime === "image/jpg" || ext === "jpg" || ext === "jpeg") {
    return { buffer, kind: "jpg" };
  }
  const image = await Jimp.read(buffer);
  return {
    buffer: await image.getBufferAsync(Jimp.MIME_PNG),
    kind: "png",
  };
}

function readSignatureImageBuffer(signatureRecord) {
  const absPath = getAbsoluteDataPath(signatureRecord?.signaturePngPath);
  return absPath ? readBufferSafe(absPath) : Buffer.alloc(0);
}

function buildSignedPdfFileName(stream, signatureRecord, versionRecord) {
  const title = sanitizeFileSegment(stream?.title || stream?.slug || "mou", "mou");
  const agency = sanitizeFileSegment(signatureRecord?.agencyId || "agency", "agency");
  return `${title}-${agency}-v${normalizeVersion(versionRecord?.version) || 1}-signed.pdf`;
}

function deriveUserAgreementSource(versionRecord) {
  const markdown = normalizeText(versionRecord?.bodyMarkdown || versionRecord?.bodyText);
  if (markdown) return markdown;
  const html = String(versionRecord?.bodyHtml || "");
  return decodeBasicHtmlEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<\/li>/gi, "\n")
      .replace(/<\/(div|p|h1|h2|h3|blockquote|ul|ol)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeUserAgreementVersion(versionRecord) {
  if (!versionRecord || typeof versionRecord !== "object") return null;
  const bodyMarkdown = deriveUserAgreementSource(versionRecord);
  const renderedHtml = normalizeText(versionRecord.bodyHtml)
    ? sanitizeUserAgreementHtml(versionRecord.bodyHtml)
    : renderUserAgreementHtml(bodyMarkdown);
  return {
    ...clone(versionRecord),
    title: normalizeText(versionRecord.title) || "User Agreement",
    bodyMarkdown,
    bodyHtml: renderedHtml,
  };
}

function persistVersionContent({ mouId, version, contentType, html, file }) {
  const ext = getFileExtensionForContentType(contentType);
  const targetPath = store.getVersionContentPath(mouId, version, ext);
  if (contentType === "pdf") {
    const buffer = Buffer.isBuffer(file?.buffer) ? file.buffer : Buffer.alloc(0);
    enforcePdfSize(buffer);
    store.writeBinary(targetPath, buffer);
    return {
      absPath: targetPath,
      contentSha256: computeSha256(buffer),
      originalFileName: normalizeText(file?.originalname || `mou-${version}.pdf`),
    };
  }

  if (contentType === "markdown") {
    const safeMarkdown = String(html || "");
    requireNonEmpty(safeMarkdown, "Document Markdown");
    enforceHtmlSize(safeMarkdown);
    store.writeHtml(targetPath, safeMarkdown);
    return {
      absPath: targetPath,
      contentSha256: computeSha256(safeMarkdown),
      originalFileName: normalizeText(file?.originalname || ""),
    };
  }

  const safeHtml = sanitizeMouHtml(html || "");
  requireNonEmpty(safeHtml.replace(/<[^>]+>/g, "").trim(), "Document HTML");
  enforceHtmlSize(safeHtml);
  store.writeHtml(targetPath, safeHtml);
  return {
    absPath: targetPath,
    contentSha256: computeSha256(safeHtml),
    originalFileName: normalizeText(file?.originalname || ""),
  };
}

function buildVersionInput(input, existingVersionRecord) {
  const title = normalizeText(input?.title);
  const slug = slugify(input?.slug || title);
  const reminderDays = normalizedReminderDays(input?.reminderDays);
  const mandatory = true;
  const contentType = normalizeContentType(
    input?.contentType || existingVersionRecord?.contentType || "markdown"
  );

  requireNonEmpty(title, "Title");

  const existingContentType = normalizeContentType(existingVersionRecord?.contentType);

  if (contentType === "html" || contentType === "markdown") {
    requireNonEmpty(
      input?.html,
      contentType === "markdown" ? "Document Markdown" : "Document HTML"
    );
  } else if ((!existingVersionRecord || existingContentType !== "pdf") && !input?.file) {
    throw new Error("A PDF file is required.");
  }

  return {
    title,
    slug,
    reminderDays,
    mandatory,
    contentType,
    html: input?.html || "",
    file: input?.file || null,
    customSignerFields: normalizeCustomSignerFields(
      input?.customFieldLabels ?? existingVersionRecord?.customSignerFields
    ),
  };
}

function createVersionRecord({
  version,
  contentType,
  contentPath,
  contentSha256,
  originalFileName,
  customSignerFields,
  actor,
}) {
  const now = nowIso();
  return ensureVersionShape({
    version,
    state: "current",
    contentType,
    fileExtension: getFileExtensionForContentType(contentType),
    originalFileName,
    contentPath,
    contentSha256,
    createdAt: now,
    createdBy: actor?.uid || actor?.username || null,
    updatedAt: now,
    updatedBy: actor?.uid || actor?.username || null,
    activeAt: now,
    activeBy: actor?.uid || actor?.username || null,
    customSignerFields: normalizeCustomSignerFields(customSignerFields),
    signatures: [],
  });
}

function copyVersionContentToVersion(mouId, targetVersion, sourceVersion) {
  const contentType = normalizeContentType(sourceVersion?.contentType);
  const extension = getFileExtensionForContentType(contentType);
  const sourceAbs = getAbsoluteContentPath(sourceVersion);
  const targetAbs = store.getVersionContentPath(mouId, targetVersion, extension);
  const contentBuffer = readBufferSafe(sourceAbs);
  if (!contentBuffer.length) {
    throw new Error("The previous version content could not be read.");
  }
  if (contentType === "pdf") {
    store.writeBinary(targetAbs, contentBuffer);
  } else {
    store.writeHtml(targetAbs, contentBuffer.toString("utf8"));
  }
  return {
    absPath: targetAbs,
    contentType,
    contentSha256: computeSha256(contentBuffer),
    originalFileName: normalizeText(sourceVersion?.originalFileName || ""),
  };
}

function createStream({
  title,
  slug,
  html,
  file,
  contentType,
  customFieldLabels,
  reminderDays,
  mandatory,
  actor,
}) {
  requireEnabled();
  const versionInput = buildVersionInput({
    title,
    slug,
    html,
    file,
    contentType,
    customFieldLabels,
    reminderDays,
    mandatory,
  });
  const index = getIndex();
  assertUniqueStreamTitle(index, versionInput.title);
  const mouId = makeId();
  const version = 1;
  const persisted = persistVersionContent({
    mouId,
    version,
    contentType: versionInput.contentType,
    html: versionInput.html,
    file: versionInput.file,
  });
  const now = nowIso();
  const stream = ensureStreamShape({
    mouId,
    title: versionInput.title,
    slug: versionInput.slug,
    mandatory: versionInput.mandatory,
    reminderDays: versionInput.reminderDays,
    assignments: {
      serverwide: false,
      agencySuffixes: [],
    },
    createdAt: now,
    createdBy: actor?.uid || actor?.username || null,
    updatedAt: now,
    updatedBy: actor?.uid || actor?.username || null,
    versions: [
      createVersionRecord({
        version,
        contentType: versionInput.contentType,
        contentPath: buildRelativeDataPath(persisted.absPath),
        contentSha256: persisted.contentSha256,
        originalFileName: persisted.originalFileName,
        customSignerFields: versionInput.customSignerFields,
        actor,
      }),
    ],
  });
  index.streams.push(stream);
  saveIndex(index);
  return clone(stream);
}

function createNextVersion({ mouId, actor }) {
  requireEnabled();
  const index = getIndex();
  const stream = findStream(index, mouId);
  if (!stream) throw new Error("MOU stream not found.");
  const latest = getLatestVersion(stream);
  const nextVersion = normalizeVersion(latest?.version) + 1;
  const currentVersion = getCurrentVersion(stream);
  if (currentVersion) {
    currentVersion.state = "previous";
    currentVersion.previousAt = nowIso();
    currentVersion.previousBy = actor?.uid || actor?.username || null;
  }
  const copied = copyVersionContentToVersion(mouId, nextVersion, latest);
  stream.versions.push(
    createVersionRecord({
      version: nextVersion,
      contentType: copied.contentType,
      contentPath: buildRelativeDataPath(copied.absPath),
      contentSha256: copied.contentSha256,
      originalFileName: copied.originalFileName,
      customSignerFields: latest?.customSignerFields,
      actor,
    })
  );
  stream.updatedAt = nowIso();
  stream.updatedBy = actor?.uid || actor?.username || null;
  saveIndex(index);
  refreshExternalSignInvitesAfterVersionChange({ stream, actor });
  return clone(stream);
}

function updateVersion({
  mouId,
  version,
  title,
  slug,
  html,
  file,
  contentType,
  customFieldLabels,
  reminderDays,
  mandatory,
  actor,
}) {
  requireEnabled();
  const { index, stream, versionRecord } = getStreamAndVersion(mouId, version);
  if (String(versionRecord.state || "") !== "current") {
    throw new Error("Only the current version can be edited.");
  }

  const update = buildVersionInput({
    title,
    slug,
    html,
    file,
    contentType,
    customFieldLabels,
    reminderDays,
    mandatory,
  }, versionRecord);
  assertUniqueStreamTitle(index, update.title, mouId);

  const now = nowIso();
  stream.title = update.title;
  stream.slug = update.slug;
  stream.reminderDays = update.reminderDays;
  stream.mandatory = update.mandatory;
  stream.updatedAt = now;
  stream.updatedBy = actor?.uid || actor?.username || null;
  versionRecord.customSignerFields = update.customSignerFields;

  if (
    update.file ||
    update.contentType !== normalizeContentType(versionRecord.contentType) ||
    update.contentType === "html" ||
    update.contentType === "markdown"
  ) {
    const oldAbsPath = getAbsoluteContentPath(versionRecord);
    const persisted = persistVersionContent({
      mouId,
      version: versionRecord.version,
      contentType: update.contentType,
      html: update.html,
      file: update.file,
    });
    if (oldAbsPath && oldAbsPath !== persisted.absPath) {
      store.deleteFile(oldAbsPath);
    }
    versionRecord.contentType = update.contentType;
    versionRecord.fileExtension = getFileExtensionForContentType(update.contentType);
    versionRecord.contentPath = buildRelativeDataPath(persisted.absPath);
    versionRecord.originalFileName = persisted.originalFileName;
    versionRecord.contentSha256 = persisted.contentSha256;
  }

  if (Array.isArray(versionRecord.signatures) && versionRecord.signatures.length) {
    for (const signature of versionRecord.signatures) {
      const signedHtmlPath = getAbsoluteDataPath(signature?.signedHtmlPath);
      const signaturePngPath = getAbsoluteDataPath(signature?.signaturePngPath);
      const uploadedSignedCopyPath = getAbsoluteDataPath(signature?.uploadedSignedCopyPath);
      if (signedHtmlPath) store.deleteFile(signedHtmlPath);
      if (signaturePngPath) store.deleteFile(signaturePngPath);
      if (uploadedSignedCopyPath) store.deleteFile(uploadedSignedCopyPath);
    }
    versionRecord.signatures = [];
  }

  versionRecord.updatedAt = now;
  versionRecord.updatedBy = actor?.uid || actor?.username || null;
  saveIndex(index);
  return clone(stream);
}

function getAbsoluteDataPath(relativePath) {
  const rel = normalizeText(relativePath);
  return rel ? path.join(__dirname, "..", "data", rel) : "";
}

function deleteStream({ mouId }) {
  requireEnabled();
  const index = getIndex();
  const stream = findStream(index, mouId);
  if (!stream) {
    throw new Error("MOU stream not found.");
  }

  const signatureSummary = getStreamActiveAssignmentSignatureSummary(stream);
  if (signatureSummary.hasSignatures) {
    throw new Error(
      `Cannot delete while ${signatureSummary.signatureCount} signed cop${signatureSummary.signatureCount === 1 ? "y" : "ies"} exist on active agency assignments. Archive agencies, then Delete Permanently from Archived Documents.`
    );
  }

  const archivedAgencies = getArchivedAgencySuffixesForStream(mouId);

  for (const versionRecord of stream.versions || []) {
    const contentPath = getAbsoluteContentPath(versionRecord);
    if (contentPath) {
      store.deleteFile(contentPath);
    }
    for (const signature of versionRecord.signatures || []) {
      const agencyId = normalizeAgencySuffix(signature?.agencyId);
      if (!archivedAgencies.has(agencyId)) {
        deleteSignatureArtifacts(signature);
      }
    }
  }

  index.streams = (index.streams || []).filter(
    (entry) => String(entry?.mouId || "") !== String(mouId)
  );
  saveIndex(index);

  const views = getViewsStore();
  views.items = (views.items || []).filter(
    (item) => String(item?.mouId || "") !== String(mouId)
  );
  saveViewsStore(views);

  const reminders = getRemindersStore();
  for (const key of Object.keys(reminders.agency || {})) {
    if (String(key).startsWith(`${normalizeText(mouId)}:`)) {
      delete reminders.agency[key];
    }
  }
  saveRemindersStore(reminders);

  purgeSignInvitesForStream(mouId);
  return true;
}

function getSignedAgencySuffixesForCurrentVersion(stream) {
  const currentVersion = getCurrentVersion(stream);
  if (!currentVersion) return [];
  // Only signatures for agencies that are currently assigned count.
  // Archived/revoked agencies may still have live signature records (kept for restore),
  // but those must not force them back onto the assignment list.
  const activeSuffixes = new Set(getStreamAgencySuffixes(stream));
  return (Array.isArray(currentVersion.signatures) ? currentVersion.signatures : [])
    .map((entry) => normalizeAgencySuffix(entry?.agencyId))
    .filter((suffix) => suffix && activeSuffixes.has(suffix));
}

function clearCurrentVersionSignatureForAgencyInPlace(stream, agencyId) {
  const currentVersion = getCurrentVersion(stream);
  if (!currentVersion) return null;
  const safeAgencyId = normalizeAgencySuffix(agencyId);
  const signatures = Array.isArray(currentVersion.signatures)
    ? currentVersion.signatures
    : [];
  const existing = signatures.find(
    (entry) => normalizeAgencySuffix(entry?.agencyId) === safeAgencyId
  );
  if (!existing) return null;
  deleteSignatureArtifacts(existing);
  currentVersion.signatures = signatures.filter(
    (entry) => normalizeAgencySuffix(entry?.agencyId) !== safeAgencyId
  );
  return existing;
}

function updateStreamAssignments({
  mouId,
  serverwide,
  agencySuffixes,
  agencySigning,
  actor,
}) {
  requireEnabled();
  const index = getIndex();
  const stream = findStream(index, mouId);
  if (!stream) {
    throw new Error("MOU stream not found.");
  }
  if (!getCurrentVersion(stream)) {
    throw new Error("Create a document version before assigning it.");
  }

  const previousSuffixes = new Set(getStreamAgencySuffixes(stream));
  const signedSuffixes = getSignedAgencySuffixesForCurrentVersion(stream);
  const previousAssignments = getAssignments(stream);
  let normalizedSuffixes = normalizeAgencySuffixList(agencySuffixes);
  const isServerwide = !!serverwide;
  if (!isServerwide && signedSuffixes.length) {
    const suffixSet = new Set(normalizedSuffixes);
    for (const suffix of signedSuffixes) {
      suffixSet.add(suffix);
    }
    normalizedSuffixes = Array.from(suffixSet);
  }

  let signingPayload = agencySigning;
  if (signedSuffixes.length && previousAssignments?.agencySigning) {
    signingPayload = { ...(agencySigning || {}) };
    for (const suffix of signedSuffixes) {
      if (previousAssignments.agencySigning[suffix]) {
        signingPayload[suffix] = previousAssignments.agencySigning[suffix];
      }
    }
  }

  const assignments = buildAssignmentsWithSigning({
    mouId,
    serverwide: isServerwide,
    agencySuffixes: normalizedSuffixes,
    agencySigning: signingPayload,
    previousAssignments: stream.assignments || {},
  });
  validateAgencySigningForAssignments(assignments);

  // Re-assigning an agency after archive/revoke must start unsigned.
  // Restore uses restoreArchivedDocument and intentionally keeps the live signature.
  const nextSuffixes = new Set(
    getStreamAgencySuffixes({ ...stream, assignments })
  );
  for (const suffix of nextSuffixes) {
    if (!suffix || previousSuffixes.has(suffix)) continue;
    clearCurrentVersionSignatureForAgencyInPlace(stream, suffix);
  }

  stream.assignments = assignments;
  stream.updatedAt = nowIso();
  stream.updatedBy = actor?.uid || actor?.username || null;
  saveIndex(index);
  return clone(stream);
}

function updateAgencySigningConfig({ mouId, agencySuffix, signingPatch, actor, skipValidation = false }) {
  requireEnabled();
  const index = getIndex();
  const stream = findStream(index, mouId);
  if (!stream) {
    throw new Error("MOU stream not found.");
  }
  if (!getCurrentVersion(stream)) {
    throw new Error("Create a document version before updating signing settings.");
  }

  const suffix = normalizeAgencySuffix(agencySuffix);
  const targetedSuffixes = getStreamAgencySuffixes(stream);
  if (!targetedSuffixes.includes(suffix)) {
    throw new Error("This agency is not assigned to the document.");
  }

  const previous = getAssignments(stream);
  const patch = normalizeAgencySigningConfig({ [suffix]: signingPatch || {} })[suffix] || {
    mode: AGENCY_SIGNING_MODE_AGENCY_ADMINS,
  };
  const mergedSigning = {
    ...(previous.agencySigning || {}),
    [suffix]: patch,
  };

  stream.assignments = buildAssignmentsWithSigning({
    mouId,
    serverwide: previous.serverwide,
    agencySuffixes: previous.agencySuffixes,
    agencySigning: mergedSigning,
    previousAssignments: previous,
  });
  if (!skipValidation) {
    validateAgencySigningForAssignments(stream.assignments);
  }
  stream.updatedAt = nowIso();
  stream.updatedBy = actor?.uid || actor?.username || null;
  saveIndex(index);
  return clone(stream);
}

function clearAgencySignatureForCurrentVersion({ mouId, agencyId, actor }) {
  requireEnabled();
  const index = getIndex();
  const stream = findStream(index, mouId);
  if (!stream) {
    throw new Error("MOU stream not found.");
  }
  const currentVersion = getCurrentVersion(stream);
  if (!currentVersion) {
    throw new Error("MOU version not found.");
  }

  const safeAgencyId = normalizeAgencySuffix(agencyId);
  const signatures = Array.isArray(currentVersion.signatures) ? currentVersion.signatures : [];
  const existing = signatures.find(
    (entry) => normalizeAgencySuffix(entry?.agencyId) === safeAgencyId
  );
  if (!existing) {
    throw new Error("Current signature not found for this agency.");
  }

  deleteSignatureArtifacts(existing);

  currentVersion.signatures = signatures.filter(
    (entry) => normalizeAgencySuffix(entry?.agencyId) !== safeAgencyId
  );
  stream.updatedAt = nowIso();
  stream.updatedBy = actor?.uid || actor?.username || null;
  saveIndex(index);
  return {
    stream: clone(stream),
    version: clone(currentVersion),
    removedSignature: clone(existing),
  };
}

function archiveDocumentForAgency({ mouId, agencyId, actor }) {
  requireEnabled();
  const index = getIndex();
  const stream = findStream(index, mouId);
  if (!stream) {
    throw new Error("MOU stream not found.");
  }
  const currentVersion = getCurrentVersion(stream);
  if (!currentVersion) {
    throw new Error("MOU version not found.");
  }

  const safeAgencyId = normalizeAgencySuffix(agencyId);
  const targetAgency = getTargetAgenciesForStream(stream).find(
    (agency) => normalizeAgencySuffix(agency?.suffix) === safeAgencyId
  );
  if (!targetAgency) {
    throw new Error("Agency assignment not found.");
  }

  const latestSignature = getLatestSignatureForAgency(stream, safeAgencyId);
  const requireAgencySignature = true;
  const needsSignature =
    requireAgencySignature &&
    (!latestSignature ||
      normalizeVersion(latestSignature.versionRecord.version) <
        normalizeVersion(currentVersion.version));

  const archivedDocuments = getArchivedDocumentsStore();
  archivedDocuments.items = archivedDocuments.items.filter(
    (item) =>
      !(
        normalizeText(item?.mouId) === normalizeText(mouId) &&
        normalizeAgencySuffix(item?.agencyId) === safeAgencyId
      )
  );
  const archiveId = makeId();
  const snapshot = latestSignature
    ? createArchiveSnapshot(archiveId, latestSignature.entry, latestSignature.versionRecord)
    : null;
  archivedDocuments.items.push(
    normalizeArchivedDocumentRecord({
      archiveId,
      mouId: stream.mouId,
      mouTitle: stream.title,
      scopeType: getAssignments(stream).serverwide ? "global" : "agency",
      scopeLabel: getScopeLabel(stream),
      currentVersion: currentVersion.version,
      agencyId: safeAgencyId,
      agencyName: targetAgency.name || targetAgency.groupPrefix || targetAgency.suffix,
      signedVersion: latestSignature ? latestSignature.versionRecord.version : null,
      signerDisplayName: latestSignature
        ? latestSignature.entry.attestationText || latestSignature.entry.signerDisplayName
        : null,
      signedAt: latestSignature ? latestSignature.entry.signedAt : null,
      historicalSignedVersions: getHistoricalSignedVersionsForAgency(
        stream,
        safeAgencyId,
        currentVersion.version
      ),
      status: needsSignature ? "Needs Signature" : "Signed",
      archivedAt: nowIso(),
      archivedBy: actor?.uid || actor?.username || null,
      snapshot,
    })
  );

  const remainingAgencySuffixes = getStreamAgencySuffixes(stream).filter(
    (suffix) => normalizeAgencySuffix(suffix) !== safeAgencyId
  );
  stream.assignments = buildAssignmentsFromAgencySuffixes(
    remainingAgencySuffixes,
    stream.assignments
  );

  // Snapshot already captured evidence. Clear live signatures so a later
  // re-assignment starts unsigned. Restore rehydrates from the snapshot.
  for (const versionRecord of stream.versions || []) {
    const signatures = Array.isArray(versionRecord.signatures)
      ? versionRecord.signatures
      : [];
    const matchingSignatures = signatures.filter(
      (entry) => normalizeAgencySuffix(entry?.agencyId) === safeAgencyId
    );
    for (const signature of matchingSignatures) {
      deleteSignatureArtifacts(signature);
    }
    versionRecord.signatures = signatures.filter(
      (entry) => normalizeAgencySuffix(entry?.agencyId) !== safeAgencyId
    );
  }

  stream.updatedAt = nowIso();
  stream.updatedBy = actor?.uid || actor?.username || null;
  saveIndex(index);
  saveArchivedDocumentsStore(archivedDocuments);
  return clone(stream);
}

function restoreLiveSignatureFromArchiveSnapshot(stream, archivedRecord) {
  const snapshot = archivedRecord?.snapshot;
  if (!snapshot?.signature) return false;

  const versionNumber = normalizeVersion(
    snapshot.signedVersion || archivedRecord.signedVersion
  );
  if (!versionNumber) return false;
  const versionRecord = findVersion(stream, versionNumber);
  if (!versionRecord) return false;

  const mouId = stream.mouId;
  const agencyId = normalizeAgencySuffix(archivedRecord.agencyId);
  if (!agencyId) return false;

  const signatures = Array.isArray(versionRecord.signatures)
    ? versionRecord.signatures
    : [];
  for (const existing of signatures.filter(
    (entry) => normalizeAgencySuffix(entry?.agencyId) === agencyId
  )) {
    deleteSignatureArtifacts(existing);
  }
  versionRecord.signatures = signatures.filter(
    (entry) => normalizeAgencySuffix(entry?.agencyId) !== agencyId
  );

  const signedHtmlAbs = store.getSignedHtmlPath(mouId, agencyId, versionNumber);
  const signaturePngAbs = store.getSignaturePngPath(mouId, agencyId, versionNumber);
  let signedHtmlPath = null;
  let signaturePngPath = null;
  let uploadedAbs = "";
  let uploadedFileName = null;
  let uploadedContentType =
    snapshot.signature.uploadedSignedCopyContentType || null;

  if (snapshot.signedHtmlPath) {
    if (copyDataFile(snapshot.signedHtmlPath, buildRelativeDataPath(signedHtmlAbs))) {
      signedHtmlPath = buildRelativeDataPath(signedHtmlAbs);
    }
  }
  if (snapshot.signaturePngPath) {
    if (copyDataFile(snapshot.signaturePngPath, buildRelativeDataPath(signaturePngAbs))) {
      signaturePngPath = buildRelativeDataPath(signaturePngAbs);
    }
  }
  if (snapshot.uploadedSignedCopyPath) {
    const ext =
      path.extname(String(snapshot.uploadedSignedCopyPath || "")) || ".pdf";
    uploadedAbs = store.getSignedUploadPath(
      mouId,
      agencyId,
      versionNumber,
      ext.replace(/^\./, "")
    );
    if (copyDataFile(snapshot.uploadedSignedCopyPath, buildRelativeDataPath(uploadedAbs))) {
      uploadedFileName = path.basename(String(snapshot.uploadedSignedCopyPath));
    } else {
      uploadedAbs = "";
    }
  }

  const countersignatureSource = snapshot.signature.countersignature;
  let countersignature = null;
  if (countersignatureSource && typeof countersignatureSource === "object") {
    countersignature = {
      ...countersignatureSource,
      signaturePngPath: null,
      uploadedSignedCopyPath: null,
      uploadedSignedCopyFileName: null,
    };
    if (countersignatureSource.signaturePngPath) {
      const destAbs = store.getCountersignaturePngPath(mouId, agencyId, versionNumber);
      if (copyDataFile(countersignatureSource.signaturePngPath, buildRelativeDataPath(destAbs))) {
        countersignature.signaturePngPath = buildRelativeDataPath(destAbs);
      }
    }
    if (countersignatureSource.uploadedSignedCopyPath) {
      const ext =
        path.extname(String(countersignatureSource.uploadedSignedCopyPath || "")) ||
        ".pdf";
      const destAbs = store.getCountersignUploadPath(
        mouId,
        agencyId,
        versionNumber,
        ext.replace(/^\./, "")
      );
      if (
        copyDataFile(
          countersignatureSource.uploadedSignedCopyPath,
          buildRelativeDataPath(destAbs)
        )
      ) {
        countersignature.uploadedSignedCopyPath = buildRelativeDataPath(destAbs);
        countersignature.uploadedSignedCopyFileName = path.basename(
          String(countersignatureSource.uploadedSignedCopyPath)
        );
      }
    }
  }

  const signatureRecord = {
    agencyId,
    agencyNameAtSign: snapshot.signature.agencyNameAtSign || "",
    signerUserId: snapshot.signature.signerUserId || null,
    signerDisplayName:
      snapshot.signature.signerDisplayName ||
      snapshot.signature.attestationText ||
      "",
    signerStatusAtSign: snapshot.signature.signerStatusAtSign || "",
    signerEmail: snapshot.signature.signerEmail || null,
    signedAt: snapshot.signature.signedAt || null,
    ip: snapshot.signature.ip || null,
    userAgent: snapshot.signature.userAgent || null,
    signaturePngPath,
    uploadedSignedCopyPath: uploadedAbs ? buildRelativeDataPath(uploadedAbs) : null,
    uploadedSignedCopyFileName: uploadedFileName,
    uploadedSignedCopyContentType: uploadedContentType,
    signedHtmlPath,
    attestationText: snapshot.signature.attestationText || "",
    customFieldValues: Array.isArray(snapshot.signature.customFieldValues)
      ? snapshot.signature.customFieldValues
      : [],
    ...(countersignature ? { countersignature } : {}),
  };

  if (!Array.isArray(versionRecord.signatures)) versionRecord.signatures = [];
  versionRecord.signatures.push(signatureRecord);
  return true;
}

function restoreArchivedDocument({ archiveId, actor }) {
  requireEnabled();
  const safeArchiveId = normalizeText(archiveId);
  const archivedDocuments = getArchivedDocumentsStore();
  const archivedRecord = archivedDocuments.items.find(
    (item) => normalizeText(item?.archiveId) === safeArchiveId
  );
  if (!archivedRecord) {
    throw new Error("Archived document not found.");
  }

  const index = getIndex();
  const stream = findStream(index, archivedRecord.mouId);
  if (!stream) {
    throw new Error("MOU stream not found.");
  }
  if (!getCurrentVersion(stream)) {
    throw new Error("MOU version not found.");
  }

  const nextAgencySuffixes = normalizeAgencySuffixList([
    ...getStreamAgencySuffixes(stream),
    archivedRecord.agencyId,
  ]);
  stream.assignments = buildAssignmentsFromAgencySuffixes(
    nextAgencySuffixes,
    stream.assignments
  );
  restoreLiveSignatureFromArchiveSnapshot(stream, archivedRecord);
  stream.updatedAt = nowIso();
  stream.updatedBy = actor?.uid || actor?.username || null;
  archivedDocuments.items = archivedDocuments.items.filter(
    (item) => normalizeText(item?.archiveId) !== safeArchiveId
  );
  saveIndex(index);
  saveArchivedDocumentsStore(archivedDocuments);
  return clone(stream);
}

function deleteArchivedDocument({ archiveId, actor }) {
  requireEnabled();
  const safeArchiveId = normalizeText(archiveId);
  const archivedDocuments = getArchivedDocumentsStore();
  const archivedRecord = archivedDocuments.items.find(
    (item) => normalizeText(item?.archiveId) === safeArchiveId
  );
  if (!archivedRecord) {
    throw new Error("Archived document not found.");
  }

  const index = getIndex();
  const stream = findStream(index, archivedRecord.mouId);
  if (stream) {
    for (const versionRecord of stream.versions || []) {
      const signatures = Array.isArray(versionRecord.signatures)
        ? versionRecord.signatures
        : [];
      const matchingSignatures = signatures.filter(
        (entry) =>
          normalizeAgencySuffix(entry?.agencyId) ===
          normalizeAgencySuffix(archivedRecord.agencyId)
      );
      for (const signature of matchingSignatures) {
        deleteSignatureArtifacts(signature);
      }
      versionRecord.signatures = signatures.filter(
        (entry) =>
          normalizeAgencySuffix(entry?.agencyId) !==
          normalizeAgencySuffix(archivedRecord.agencyId)
      );
    }
    stream.updatedAt = nowIso();
    stream.updatedBy = actor?.uid || actor?.username || null;
    saveIndex(index);
  }

  const reminders = getRemindersStore();
  for (const key of Object.keys(reminders.agency || {})) {
    if (
      String(key).startsWith(
        `${normalizeText(archivedRecord.mouId)}:${normalizeAgencySuffix(
          archivedRecord.agencyId
        )}:`
      )
    ) {
      delete reminders.agency[key];
    }
  }
  saveRemindersStore(reminders);

  archivedDocuments.items = archivedDocuments.items.filter(
    (item) => normalizeText(item?.archiveId) !== safeArchiveId
  );
  deleteArchiveSnapshotFiles(archivedRecord.snapshot);
  saveArchivedDocumentsStore(archivedDocuments);
  return true;
}

function getCurrentVersionOrLatest(mouId, version) {
  const index = getIndex();
  const stream = findStream(index, mouId);
  if (!stream) throw new Error("MOU stream not found.");
  const currentVersion = getCurrentVersion(stream);
  if (!currentVersion) throw new Error("This document does not have a current version yet.");
  const requested = version ? findVersion(stream, version) : currentVersion;
  if (!requested) throw new Error("MOU version not found.");
  const shouldRedirectToLatest =
    String(requested.state || "") !== "current" &&
    String(requested.state || "") !== "previous";
  const target = shouldRedirectToLatest ? currentVersion : requested;
  const contentType = normalizeContentType(target.contentType);
  const contentBuffer = readContentBuffer(target);
  return {
    stream: clone(stream),
    requestedVersion: clone(requested),
    targetVersion: clone(target),
    latestVersion: clone(currentVersion),
    contentType,
    html: contentType === "pdf" ? "" : renderDocumentHtml(target),
    fileName: normalizeText(target.originalFileName || `${stream.slug || "mou"}-${target.version}.${getFileExtensionForContentType(contentType)}`),
    redirectedToLatest:
      normalizeVersion(target.version) !== normalizeVersion(requested.version),
  };
}

function getVersionContent(mouId, version) {
  const stream = getStreamById(mouId);
  const versionRecord =
    (stream.versions || []).find(
      (entry) => normalizeVersion(entry.version) === normalizeVersion(version)
    ) || null;
  if (!versionRecord) {
    throw new Error("MOU version not found.");
  }
  const contentType = normalizeContentType(versionRecord.contentType);
  const contentBuffer = readContentBuffer(versionRecord);
  return {
    stream,
    version: clone(versionRecord),
    contentType,
    sourceText: contentType === "pdf" ? "" : readHtmlContent(versionRecord),
    html: contentType === "pdf" ? "" : renderDocumentHtml(versionRecord),
    customSignerFields: normalizeCustomSignerFields(versionRecord.customSignerFields),
    fileName: normalizeText(
      versionRecord.originalFileName ||
        `${stream.slug || "mou"}-${versionRecord.version}.${getFileExtensionForContentType(contentType)}`
    ),
    contentBuffer,
  };
}

function recordMouView({ authUser, mouId, version, ip, userAgent }) {
  const userId = getUserKey(authUser);
  if (!userId) return null;
  const data = getViewsStore();
  const key = `${userId}|mou|${normalizeText(mouId)}|${normalizeVersion(version)}`;
  const now = nowIso();
  let row = data.items.find((item) => String(item?.key || "") === key) || null;
  if (!row) {
    row = {
      key,
      type: "mou",
      userId,
      username: authUser?.username || null,
      mouId: normalizeText(mouId),
      version: normalizeVersion(version),
      firstViewedAt: now,
      lastViewedAt: now,
      viewCount: 1,
      lastIp: ip || null,
      lastUserAgent: userAgent || null,
    };
    data.items.push(row);
  } else {
    row.lastViewedAt = now;
    row.viewCount = Number(row.viewCount || 0) + 1;
    row.lastIp = ip || null;
    row.lastUserAgent = userAgent || null;
  }
  saveViewsStore(data);
  return clone(row);
}

function getCurrentUserAgreement() {
  const data = getUserAgreementStore();
  const currentVersion = normalizeVersion(data.currentVersion);
  const versions = (data.versions || [])
    .map(normalizeUserAgreementVersion)
    .filter(Boolean);
  const current =
    versions.find((entry) => normalizeVersion(entry?.version) === currentVersion) || null;
  return {
    enabled: data.enabled === true,
    currentVersion,
    current: current ? clone(current) : null,
    versions,
  };
}

function getDefaultUserAgreementTemplate() {
  return {
    title: DEFAULT_USER_AGREEMENT_TITLE,
    markdown: DEFAULT_USER_AGREEMENT_MARKDOWN,
  };
}

function saveUserAgreement({ title, markdown, html, actor, enabled }) {
  requireEnabled();
  const safeTitle = normalizeText(title) || DEFAULT_USER_AGREEMENT_TITLE;
  const safeMarkdown = normalizeText(markdown || html || "");
  const safeHtml = renderUserAgreementHtml(safeMarkdown);
  const safeEnabled = normalizedMandatory(enabled);
  requireNonEmpty(safeMarkdown, "User agreement text");
  enforceHtmlSize(safeMarkdown);
  enforceHtmlSize(safeHtml);

  const data = getUserAgreementStore();
  data.enabled = safeEnabled;
  const current = getCurrentUserAgreement().current;
  if (current && current.title === safeTitle && current.bodyMarkdown === safeMarkdown) {
    saveUserAgreementStore(data);
    return { changed: false, version: clone(current), enabled: data.enabled };
  }

  const nextVersion = normalizeVersion(data.currentVersion) + 1 || 1;
  const now = nowIso();
  const versionRecord = {
    version: nextVersion,
    title: safeTitle,
    bodyMarkdown: safeMarkdown,
    bodyHtml: safeHtml,
    createdAt: now,
    createdBy: actor?.uid || actor?.username || null,
    activeAt: now,
    activeBy: actor?.uid || actor?.username || null,
  };
  data.currentVersion = nextVersion;
  data.versions.push(versionRecord);
  saveUserAgreementStore(data);
  return { changed: true, version: clone(versionRecord), enabled: data.enabled };
}

function isUserAgreementTargetUser(authUser) {
  return !!(authUser && authUser.username && !authUser.isGlobalAdmin);
}

function shouldRequireUserAgreement(authUser, options) {
  const acceptedForSession = options?.acceptedForSession === true;
  if (!isEnabled()) return false;
  if (!isUserAgreementTargetUser(authUser)) return false;
  const agreement = getCurrentUserAgreement();
  if (!agreement.current) return false;
  if (!agreement.enabled) return false;
  return !acceptedForSession;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseSignatureDataUrl(dataUrl) {
  const raw = normalizeText(dataUrl);
  if (!raw) return null;
  const match = raw.match(/^data:image\/png;base64,(.+)$/i);
  if (!match) throw new Error("Signature must be a PNG data URL.");
  return Buffer.from(match[1], "base64");
}

function getSignedCopyExtension(file) {
  const fromMime = normalizeLower(file?.mimetype);
  if (fromMime === "application/pdf") return "pdf";
  if (fromMime === "image/png") return "png";
  if (fromMime === "image/jpeg" || fromMime === "image/jpg") return "jpg";
  if (fromMime === "image/webp") return "webp";

  const fromName = normalizeLower(String(path.extname(file?.originalname || "") || "").replace(/^\./, ""));
  if (SIGNED_COPY_ALLOWED_EXTENSIONS.has(fromName)) {
    return fromName === "jpeg" ? "jpg" : fromName;
  }
  throw new Error("Signed document must be a PDF, PNG, JPG, or WEBP file.");
}

function persistSignedCopy({ mouId, agencySuffix, version, file }) {
  const buffer = Buffer.isBuffer(file?.buffer) ? file.buffer : Buffer.alloc(0);
  if (!buffer.length) {
    throw new Error("Signed document file is empty.");
  }
  if (buffer.length > PDF_MAX_BYTES) {
    throw new Error("Signed document exceeds the maximum supported upload size.");
  }
  const extension = getSignedCopyExtension(file);
  const targetPath = store.getSignedUploadPath(mouId, agencySuffix, version, extension);
  store.writeBinary(targetPath, buffer);
  return {
    absPath: targetPath,
    fileName: normalizeText(file?.originalname || `signed-document.${extension}`),
    contentType: SIGNED_COPY_CONTENT_TYPES[extension] || "application/octet-stream",
  };
}

function persistCountersignCopy({ mouId, agencySuffix, version, file }) {
  const buffer = Buffer.isBuffer(file?.buffer) ? file.buffer : Buffer.alloc(0);
  if (!buffer.length) {
    throw new Error("Countersigned document file is empty.");
  }
  if (buffer.length > PDF_MAX_BYTES) {
    throw new Error("Countersigned document exceeds the maximum supported upload size.");
  }
  const extension = getSignedCopyExtension(file);
  const targetPath = store.getCountersignUploadPath(mouId, agencySuffix, version, extension);
  store.writeBinary(targetPath, buffer);
  return {
    absPath: targetPath,
    fileName: normalizeText(file?.originalname || `countersigned-document.${extension}`),
    contentType: SIGNED_COPY_CONTENT_TYPES[extension] || "application/octet-stream",
  };
}

function buildSignatureCardHtml({
  stream,
  versionRecord,
  signatureEntry,
  heading,
  uploadedCopyHref,
  signatureImageDataUrl,
  showAgencyName,
}) {
  const customFieldLines = Array.isArray(signatureEntry?.customFieldValues)
    ? signatureEntry.customFieldValues
        .map((entry) => ({
          label: escapeHtml(entry?.label || ""),
          value: escapeHtml(entry?.value || ""),
        }))
        .filter((entry) => entry.label)
        .map(
          (entry) =>
            `      <div class="signature-line"><strong>${entry.label}:</strong> ${entry.value || "______________________________"}</div>`
        )
    : [];
  const uploadedLabel = heading.toLowerCase().includes("counter")
    ? "Uploaded countersigned document."
    : "Uploaded signed document.";
  return [
    '    <div class="signature-card">',
    heading ? `      <h3 class="signature-card-title">${escapeHtml(heading)}</h3>` : "",
    signatureImageDataUrl
      ? `      <img class="signature-image" src="${signatureImageDataUrl}" alt="${escapeHtml(heading || "Signature")}" />`
      : signatureEntry?.uploadedSignedCopyPath
        ? `      <div class="signature-image" style="padding:12px 0;">${escapeHtml(uploadedLabel)}</div>`
        : '      <div class="signature-image" style="padding:12px 0;">E-signed document.</div>',
    `      <div class="signature-line"><strong>Full Name:</strong> ${escapeHtml(signatureEntry?.attestationText || signatureEntry?.signerDisplayName || "")}</div>`,
    `      <div class="signature-line"><strong>Position / Role:</strong> ${escapeHtml(signatureEntry?.signerStatusAtSign || "Agency Administrator")}</div>`,
    ...customFieldLines,
    showAgencyName
      ? `      <div class="signature-line">${escapeHtml(signatureEntry?.agencyNameAtSign || "")}</div>`
      : "",
    uploadedCopyHref
      ? `      <div class="signature-line"><a href="${uploadedCopyHref}" target="_blank" rel="noopener noreferrer">Open uploaded file</a></div>`
      : "",
    `      <div class="signature-line">${escapeHtml(
      heading.toLowerCase().includes("counter") ? "Countersigned" : "Signed"
    )} ${escapeHtml(signatureEntry?.signedAt || "")}</div>`,
    "    </div>",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildUploadedSignedCopyBlock({
  href,
  contentType,
  title,
}) {
  if (!href) return "";
  const safeTitle = escapeHtml(title || "Uploaded signed document");
  if (contentType === "application/pdf") {
    return [
      '<div class="signed-uploaded-copy">',
      `  <p><a href="${href}" target="_blank" rel="noopener noreferrer">Open ${safeTitle.toLowerCase()}</a></p>`,
      `  <iframe src="${href}" title="${safeTitle}" style="width:100%;min-height:780px;border:1px solid #d1d5db;border-radius:12px;background:#fff;"></iframe>`,
      "</div>",
    ].join("\n");
  }
  if (String(contentType || "").startsWith("image/")) {
    return [
      '<div class="signed-uploaded-copy">',
      `  <p><a href="${href}" target="_blank" rel="noopener noreferrer">Open ${safeTitle.toLowerCase()}</a></p>`,
      `  <img src="${href}" alt="${safeTitle}" style="max-width:100%;height:auto;border:1px solid #d1d5db;border-radius:12px;background:#fff;" />`,
      "</div>",
    ].join("\n");
  }
  return [
    '<div class="signed-uploaded-copy">',
    `  <p><a href="${href}" target="_blank" rel="noopener noreferrer">Download ${safeTitle.toLowerCase()}</a></p>`,
    "</div>",
  ].join("\n");
}

function resolveSignatureImageDataUrl(signatureEntry) {
  if (signatureEntry?.signatureImageDataUrl) return signatureEntry.signatureImageDataUrl;
  const storedSignaturePng = signatureEntry?.signaturePngPath
    ? readBufferSafe(getAbsoluteDataPath(signatureEntry.signaturePngPath))
    : Buffer.alloc(0);
  return storedSignaturePng.length
    ? `data:image/png;base64,${storedSignaturePng.toString("base64")}`
    : "";
}

function buildSignedHtml({ stream, versionRecord, signatureRecord }) {
  const scopeLabel = getScopeLabel(stream);
  const fileHref = `/mou/file/${encodeURIComponent(stream.mouId)}/${encodeURIComponent(versionRecord.version)}`;
  const uploadedSignedCopyHref = signatureRecord.uploadedSignedCopyPath
    ? `/mou/agency-file/${encodeURIComponent(stream.mouId)}/${encodeURIComponent(signatureRecord.agencyId)}?version=${encodeURIComponent(versionRecord.version)}`
    : "";
  const countersignature = signatureRecord?.countersignature;
  const countersignUploadedHref = countersignature?.uploadedSignedCopyPath
    ? `/mou/agency-file/${encodeURIComponent(stream.mouId)}/${encodeURIComponent(signatureRecord.agencyId)}?version=${encodeURIComponent(versionRecord.version)}&part=countersign`
    : "";
  const renderedBody =
    normalizeContentType(versionRecord.contentType) === "pdf"
      ? [
          '<div class="signed-pdf-wrap">',
          `  <p><a href="${fileHref}" target="_blank" rel="noopener noreferrer">Open attached PDF</a></p>`,
          `  <iframe src="${fileHref}" title="MOU PDF" style="width:100%;min-height:780px;border:1px solid #d1d5db;border-radius:12px;background:#fff;"></iframe>`,
          "</div>",
        ].join("\n")
      : renderDocumentHtml(versionRecord);
  const uploadedSignedCopyBlock = buildUploadedSignedCopyBlock({
    href: uploadedSignedCopyHref,
    contentType: signatureRecord.uploadedSignedCopyContentType,
    title: "Uploaded signed document",
  });
  const countersignUploadedBlock = buildUploadedSignedCopyBlock({
    href: countersignUploadedHref,
    contentType: countersignature?.uploadedSignedCopyContentType,
    title: "Uploaded countersigned document",
  });
  const agencySignatureCard = buildSignatureCardHtml({
    stream,
    versionRecord,
    signatureEntry: signatureRecord,
    heading: "Agency Signature",
    uploadedCopyHref: "",
    signatureImageDataUrl: resolveSignatureImageDataUrl(signatureRecord),
    showAgencyName: true,
  });
  const countersignatureCard = countersignature
    ? buildSignatureCardHtml({
        stream,
        versionRecord,
        signatureEntry: countersignature,
        heading: "Countersignature",
        uploadedCopyHref: "",
        signatureImageDataUrl: resolveSignatureImageDataUrl(countersignature),
        showAgencyName: false,
      })
    : "";

  return [
    "<style>",
    "  .signed-shell { max-width: 1180px; margin: 0 auto; }",
    "  .signed-header { margin-bottom: 24px; background: #ffffff; color: #111827 !important; padding: 20px 24px; border-radius: 16px; border: 1px solid #dbe4f0; }",
    "  .signed-header h1 { margin: 0 0 8px 0; }",
    "  .signed-header *, .signed-body, .signed-body * { color: #111827 !important; -webkit-text-fill-color: #111827 !important; }",
    "  .signed-body { background: #ffffff; color: #111827 !important; border-radius: 16px; padding: 24px; border: 1px solid #dbe4f0; }",
    "  .signed-body a, .signed-header a { color: #2563eb !important; }",
    "  .signed-uploaded-copy { margin-top: 24px; border-top: 2px solid #0f172a; padding-top: 16px; }",
    "  .signature-card { margin-top: 24px; border-top: 2px solid #0f172a; padding-top: 16px; }",
    "  .signature-card-title { margin: 0 0 12px 0; font-size: 16px; }",
    "  .signature-image { max-width: 360px; max-height: 160px; display: block; margin-bottom: 12px; border-bottom: 1px solid #94a3b8; padding-bottom: 10px; }",
    "  .signature-line { margin: 4px 0; }",
    "</style>",
    '<div class="signed-shell">',
    '  <div class="signed-header">',
    `    <h1>${escapeHtml(stream.title)}</h1>`,
    `    <div>Version ${escapeHtml(String(versionRecord.version))} | ${escapeHtml(scopeLabel)}</div>`,
    "  </div>",
    `  <div class="signed-body">${renderedBody}${uploadedSignedCopyBlock}${countersignUploadedBlock}`,
    agencySignatureCard,
    countersignatureCard,
    "  </div>",
    "</div>",
  ].join("\n");
}

function writePdfHeader(doc, stream, versionRecord) {
  doc.addPage({ size: "LETTER", margin: 54 });
  setPdfFont(doc, "bold").fontSize(20).fillColor("#111827").text(stream.title || "MOU");
  doc.moveDown(0.25);
  setPdfFont(doc, "regular")
    .fontSize(11)
    .fillColor("#4b5563")
    .text(`Version ${normalizeVersion(versionRecord?.version) || 1} | ${getScopeLabel(stream)}`);
  doc.moveDown(1);
  doc.fillColor("#111827");
}

function writePdfLabeledLine(doc, label, value) {
  setPdfFont(doc, "bold");
  doc
    .fontSize(11)
    .fillColor("#111827")
    .text(`${label}: `, { continued: true });
  setPdfFont(doc, "regular");
  doc.text(value || "______________________________");
}

function writeSignatureSection(doc, signatureRecord, options = {}) {
  if (doc.y > doc.page.height - doc.page.margins.bottom - 220) {
    doc.addPage({ size: "LETTER", margin: 54 });
  }
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const dividerY = doc.y;
  doc.lineWidth(1).strokeColor("#0f172a").moveTo(left, dividerY).lineTo(right, dividerY).stroke();
  doc.moveDown(1);

  const heading = normalizeText(options?.heading);
  if (heading) {
    setPdfFont(doc, "bold").fontSize(13).fillColor("#111827").text(heading);
    doc.moveDown(0.5);
  }

  const signatureImage = readSignatureImageBuffer(signatureRecord);
  if (signatureImage.length) {
    const imageTop = doc.y;
    doc.image(signatureImage, left, imageTop, { fit: [260, 120], align: "left" });
    doc.y = imageTop + 104;
  }

  writePdfLabeledLine(
    doc,
    "Full Name",
    normalizeText(signatureRecord?.attestationText || signatureRecord?.signerDisplayName) || "Signer"
  );
  writePdfLabeledLine(
    doc,
    "Position / Role",
    normalizeText(signatureRecord?.signerStatusAtSign) || "Agency Administrator"
  );
  const customFieldValues = Array.isArray(signatureRecord?.customFieldValues)
    ? signatureRecord.customFieldValues
    : [];
  for (const customField of customFieldValues) {
    const label = normalizeText(customField?.label);
    if (!label) continue;
    const value = normalizeText(customField?.value);
    writePdfLabeledLine(doc, label, value);
  }
  if (options?.showAgencyName !== false) {
    doc.text(normalizeText(signatureRecord?.agencyNameAtSign) || "");
  }
  const signedLabel = options?.countersign ? "Countersigned" : "Signed";
  doc.text(`${signedLabel} ${normalizeText(signatureRecord?.signedAt) || ""}`);
}

async function buildUploadedSignedCopyPdfBuffer(signatureRecord) {
  const absPath = getAbsoluteDataPath(signatureRecord?.uploadedSignedCopyPath);
  const source = readBufferSafe(absPath);
  if (!source.length) {
    throw new Error("Uploaded signed document file was not found.");
  }
  if (normalizeLower(signatureRecord?.uploadedSignedCopyContentType) === "application/pdf") {
    return source;
  }
  const normalized = await normalizeImageBufferForPdf(
    source,
    absPath,
    signatureRecord?.uploadedSignedCopyContentType
  );
  return collectPdfBuffer((doc) => {
    doc.addPage({ size: "LETTER", margin: 36 });
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const height = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
    doc.image(normalized.buffer, doc.page.margins.left, doc.page.margins.top, {
      fit: [width, height],
      align: "center",
      valign: "center",
    });
  });
}

function writeAllSignatureSections(doc, signatureRecord) {
  writeSignatureSection(doc, signatureRecord, {
    heading: "Agency Signature",
    showAgencyName: true,
  });
  if (signatureRecord?.countersignature) {
    writeSignatureSection(doc, signatureRecord.countersignature, {
      heading: "Countersignature",
      showAgencyName: false,
      countersign: true,
    });
  }
}

async function buildSignatureAppendixPdfBuffer({ stream, versionRecord, signatureRecord }) {
  return collectPdfBuffer((doc) => {
    writePdfHeader(doc, stream, versionRecord);
    writeAllSignatureSections(doc, signatureRecord);
  });
}

async function buildCountersignAppendixPdfBuffer(signatureRecord) {
  if (!signatureRecord?.countersignature) return null;
  return collectPdfBuffer((doc) => {
    doc.addPage({ size: "LETTER", margin: 54 });
    writeSignatureSection(doc, signatureRecord.countersignature, {
      heading: "Countersignature",
      showAgencyName: false,
      countersign: true,
    });
  });
}

async function mergePdfBuffers(buffers) {
  const merged = await PDFLibDocument.create();
  for (const buffer of buffers) {
    if (!buffer?.length) continue;
    const source = await PDFLibDocument.load(buffer);
    const pages = await merged.copyPages(source, source.getPageIndices());
    for (const page of pages) merged.addPage(page);
  }
  return Buffer.from(await merged.save());
}

async function buildMergedSignedPdfBuffer({ stream, versionRecord, signatureRecord }) {
  const sourcePdf = readContentBuffer(versionRecord);
  if (!sourcePdf.length) {
    throw new Error("Document PDF was not found.");
  }
  const appendixPdf = await buildSignatureAppendixPdfBuffer({
    stream,
    versionRecord,
    signatureRecord,
  });
  return mergePdfBuffers([sourcePdf, appendixPdf]);
}

async function buildSignedTextPdfBuffer({ stream, versionRecord, signatureRecord }) {
  const plainText = htmlToPlainText(renderDocumentHtml(versionRecord));
  return collectPdfBuffer((doc) => {
    writePdfHeader(doc, stream, versionRecord);
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const paragraphs = plainText.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
    setPdfFont(doc, "regular").fontSize(11).fillColor("#111827");
    if (!paragraphs.length) {
      doc.text("Document content unavailable.", { width });
      doc.moveDown(1);
    } else {
      for (const paragraph of paragraphs) {
        doc.text(paragraph, { width, lineGap: 2 });
        doc.moveDown(0.7);
      }
    }
    writeAllSignatureSections(doc, signatureRecord);
  });
}

async function getSignedPdfExport({ mouId, agencyId, version }) {
  const evidence = getAgencyEvidence({ mouId, agencyId, version });
  const fileName = buildSignedPdfFileName(evidence.stream, evidence.signature, evidence.version);
  const countersignature = evidence.signature?.countersignature;
  let pdfBuffer;
  if (countersignature?.uploadedSignedCopyPath) {
    pdfBuffer = await buildUploadedSignedCopyPdfBuffer(countersignature);
  } else if (evidence.signature?.uploadedSignedCopyPath) {
    const uploadedPdf = await buildUploadedSignedCopyPdfBuffer(evidence.signature);
    if (countersignature) {
      const appendix = await buildCountersignAppendixPdfBuffer(evidence.signature);
      pdfBuffer = await mergePdfBuffers([uploadedPdf, appendix]);
    } else {
      pdfBuffer = uploadedPdf;
    }
  } else if (normalizeContentType(evidence.version?.contentType) === "pdf") {
    pdfBuffer = await buildMergedSignedPdfBuffer({
      stream: evidence.stream,
      versionRecord: evidence.version,
      signatureRecord: evidence.signature,
    });
  } else {
    pdfBuffer = await buildSignedTextPdfBuffer({
      stream: evidence.stream,
      versionRecord: evidence.version,
      signatureRecord: evidence.signature,
    });
  }
  return {
    fileName,
    contentType: "application/pdf",
    buffer: pdfBuffer,
    evidence,
  };
}

function signVersion({
  mouId,
  version,
  agencySuffix,
  agencyNameAtSign,
  signerUserId,
  signerDisplayName,
  signerStatusAtSign,
  attestationText,
  customFieldValues,
  signatureDataUrl,
  uploadedSignedCopyFile,
  signerEmail,
  ip,
  userAgent,
}) {
  requireEnabled();
  const { index, stream, versionRecord } = getStreamAndVersion(mouId, version);
  if (String(versionRecord.state || "") !== "current") {
    throw new Error("Only the current version can be signed.");
  }

  const safeAgencySuffix = normalizeAgencySuffix(agencySuffix);
  const targetAgencySuffixes = getStreamAgencySuffixes(stream);
  if (!targetAgencySuffixes.includes(safeAgencySuffix)) {
    throw new Error("This MOU does not apply to the selected agency.");
  }

  const safeAgencyName = normalizeText(agencyNameAtSign);
  const safeSigner = normalizeText(signerDisplayName);
  const safeStatus = normalizeText(signerStatusAtSign) || "Agency Administrator";
  const safeAttestation = normalizeText(attestationText);
  const normalizedCustomFieldValues = normalizeCustomFieldValues(
    customFieldValues,
    versionRecord?.customSignerFields
  );
  const pngBuffer = parseSignatureDataUrl(signatureDataUrl);

  requireNonEmpty(safeAgencySuffix, "Agency");
  requireNonEmpty(safeAgencyName, "Agency name");
  requireNonEmpty(safeSigner, "Signer name");
  requireNonEmpty(safeAttestation, "Signer full name");
  requireNonEmpty(safeStatus, "Signer position / role");
  requireCustomFieldValues(normalizedCustomFieldValues);
  if (!pngBuffer && !uploadedSignedCopyFile && !safeAttestation) {
    throw new Error("Provide a drawn signature, uploaded signed document, or typed attestation.");
  }

  if (!Array.isArray(versionRecord.signatures)) versionRecord.signatures = [];
  if (
    versionRecord.signatures.some(
      (entry) => normalizeAgencySuffix(entry?.agencyId) === safeAgencySuffix
    )
  ) {
    throw new Error("This agency has already signed the current version.");
  }

  const signaturePath = store.getSignaturePngPath(
    mouId,
    safeAgencySuffix,
    versionRecord.version
  );
  if (pngBuffer) {
    store.writeBinary(signaturePath, pngBuffer);
  }
  const uploadedSignedCopy = uploadedSignedCopyFile
    ? persistSignedCopy({
        mouId,
        agencySuffix: safeAgencySuffix,
        version: versionRecord.version,
        file: uploadedSignedCopyFile,
      })
    : null;

  const signedAt = nowIso();
  const signatureRecord = {
    agencyId: safeAgencySuffix,
    agencyNameAtSign: safeAgencyName,
    signerUserId: normalizeText(signerUserId) || null,
    signerDisplayName: safeSigner,
    signerStatusAtSign: safeStatus,
    signerEmail: normalizeText(signerEmail) || null,
    signedAt,
    ip: normalizeText(ip) || null,
    userAgent: normalizeText(userAgent) || null,
    signaturePngPath: pngBuffer ? buildRelativeDataPath(signaturePath) : null,
    uploadedSignedCopyPath: uploadedSignedCopy ? buildRelativeDataPath(uploadedSignedCopy.absPath) : null,
    uploadedSignedCopyFileName: uploadedSignedCopy ? uploadedSignedCopy.fileName : null,
    uploadedSignedCopyContentType: uploadedSignedCopy ? uploadedSignedCopy.contentType : null,
    signedHtmlPath: buildRelativeDataPath(
      store.getSignedHtmlPath(mouId, safeAgencySuffix, versionRecord.version)
    ),
    attestationText: safeAttestation,
    customFieldValues: normalizedCustomFieldValues,
    signatureImageDataUrl: pngBuffer
      ? `data:image/png;base64,${pngBuffer.toString("base64")}`
      : "",
  };

  const signedHtml = buildSignedHtml({
    stream,
    versionRecord,
    signatureRecord,
  });
  store.writeHtml(
    path.join(__dirname, "..", "data", signatureRecord.signedHtmlPath),
    signedHtml
  );
  delete signatureRecord.signatureImageDataUrl;

  versionRecord.signatures.push(signatureRecord);
  saveIndex(index);
  markSignInviteUsedForAgencySignature({
    mouId,
    agencySuffix: safeAgencySuffix,
    version: versionRecord.version,
  });
  return {
    stream: clone(stream),
    version: clone(versionRecord),
    signature: clone(signatureRecord),
  };
}

function countersignVersion({
  mouId,
  version,
  agencySuffix,
  signerUserId,
  signerDisplayName,
  signerStatusAtSign,
  attestationText,
  customFieldValues,
  signatureDataUrl,
  uploadedSignedCopyFile,
  ip,
  userAgent,
}) {
  requireEnabled();
  const { index, stream, versionRecord } = getStreamAndVersion(mouId, version);
  if (String(versionRecord.state || "") !== "current") {
    throw new Error("Only the current version can be countersigned.");
  }

  const safeAgencySuffix = normalizeAgencySuffix(agencySuffix);
  const targetAgencySuffixes = getStreamAgencySuffixes(stream);
  if (!targetAgencySuffixes.includes(safeAgencySuffix)) {
    throw new Error("This MOU does not apply to the selected agency.");
  }

  if (!Array.isArray(versionRecord.signatures)) versionRecord.signatures = [];
  const signatureIndex = versionRecord.signatures.findIndex(
    (entry) => normalizeAgencySuffix(entry?.agencyId) === safeAgencySuffix
  );
  if (signatureIndex < 0) {
    throw new Error("This agency has not signed the current version yet.");
  }

  const existingSignature = versionRecord.signatures[signatureIndex];
  if (existingSignature?.countersignature) {
    throw new Error("This agency document has already been countersigned.");
  }

  const safeSigner = normalizeText(signerDisplayName);
  const safeStatus = normalizeText(signerStatusAtSign) || "Global Administrator";
  const safeAttestation = normalizeText(attestationText);
  const normalizedCustomFieldValues = normalizeCustomFieldValues(
    customFieldValues,
    versionRecord?.customSignerFields
  );
  const pngBuffer = parseSignatureDataUrl(signatureDataUrl);

  requireNonEmpty(safeSigner, "Signer name");
  requireNonEmpty(safeAttestation, "Signer full name");
  requireNonEmpty(safeStatus, "Signer position / role");
  requireCustomFieldValues(normalizedCustomFieldValues);
  if (!pngBuffer && !uploadedSignedCopyFile) {
    throw new Error("Provide a drawn signature or uploaded countersigned document.");
  }

  const signaturePath = store.getCountersignaturePngPath(
    mouId,
    safeAgencySuffix,
    versionRecord.version
  );
  if (pngBuffer) {
    store.writeBinary(signaturePath, pngBuffer);
  }
  const uploadedSignedCopy = uploadedSignedCopyFile
    ? persistCountersignCopy({
        mouId,
        agencySuffix: safeAgencySuffix,
        version: versionRecord.version,
        file: uploadedSignedCopyFile,
      })
    : null;

  const countersignature = {
    signerUserId: normalizeText(signerUserId) || null,
    signerDisplayName: safeSigner,
    signerStatusAtSign: safeStatus,
    signedAt: nowIso(),
    ip: normalizeText(ip) || null,
    userAgent: normalizeText(userAgent) || null,
    signaturePngPath: pngBuffer ? buildRelativeDataPath(signaturePath) : null,
    uploadedSignedCopyPath: uploadedSignedCopy
      ? buildRelativeDataPath(uploadedSignedCopy.absPath)
      : null,
    uploadedSignedCopyFileName: uploadedSignedCopy ? uploadedSignedCopy.fileName : null,
    uploadedSignedCopyContentType: uploadedSignedCopy ? uploadedSignedCopy.contentType : null,
    attestationText: safeAttestation,
    customFieldValues: normalizedCustomFieldValues,
    signatureImageDataUrl: pngBuffer
      ? `data:image/png;base64,${pngBuffer.toString("base64")}`
      : "",
  };

  const updatedSignature = {
    ...existingSignature,
    countersignature,
  };
  const signedHtml = buildSignedHtml({
    stream,
    versionRecord,
    signatureRecord: updatedSignature,
  });
  const signedHtmlPath =
    getAbsoluteDataPath(existingSignature.signedHtmlPath) ||
    store.getSignedHtmlPath(mouId, safeAgencySuffix, versionRecord.version);
  store.writeHtml(signedHtmlPath, signedHtml);
  delete countersignature.signatureImageDataUrl;

  versionRecord.signatures[signatureIndex] = {
    ...updatedSignature,
    countersignature,
    signedHtmlPath:
      existingSignature.signedHtmlPath || buildRelativeDataPath(signedHtmlPath),
  };
  stream.updatedAt = nowIso();
  saveIndex(index);

  return {
    stream: clone(stream),
    version: clone(versionRecord),
    signature: clone(versionRecord.signatures[signatureIndex]),
  };
}

function getAgencyEvidence({ mouId, agencyId, version }) {
  const stream = getStreamById(mouId);
  const versions = version
    ? [findVersion(stream, version)].filter(Boolean)
    : sortVersions(stream.versions || []).reverse();

  for (const versionRecord of versions) {
    const signature = (versionRecord.signatures || []).find(
      (entry) => normalizeAgencySuffix(entry?.agencyId) === normalizeAgencySuffix(agencyId)
    );
    if (!signature) continue;
    return {
      stream,
      version: clone(versionRecord),
      signature: clone(signature),
      html: buildSignedHtml({
        stream,
        versionRecord,
        signatureRecord: signature,
      }),
      uploadedSignedCopyAbsPath: getAbsoluteDataPath(signature?.uploadedSignedCopyPath),
      countersignUploadedAbsPath: getAbsoluteDataPath(
        signature?.countersignature?.uploadedSignedCopyPath
      ),
    };
  }
  throw new Error("Signed document not found.");
}

function listSignaturesForStream(stream) {
  const rows = [];
  for (const versionRecord of sortVersions(stream?.versions || [])) {
    for (const signature of versionRecord.signatures || []) {
      rows.push({
        mouId: stream.mouId,
        mouTitle: stream.title,
        scopeType: getAssignments(stream).serverwide ? "global" : "agency",
        scopeLabel: getScopeLabel(stream),
        agencyId: signature.agencyId,
        agencyName: signature.agencyNameAtSign,
        currentVersion: getCurrentVersion(stream)?.version || null,
        signedVersion: versionRecord.version,
        signerDisplayName: signature.attestationText || signature.signerDisplayName,
        signerStatusAtSign: signature.signerStatusAtSign,
        signedAt: signature.signedAt,
        needsNewSignature:
          !!getCurrentVersion(stream) &&
          normalizeVersion(getCurrentVersion(stream).version) >
            normalizeVersion(versionRecord.version),
      });
    }
  }
  return rows;
}

function listSignatureRows() {
  return listStreams().flatMap((stream) => listSignaturesForStream(stream));
}

function getCurrentAgencySignatureForStream(stream, agencySuffix) {
  const currentVersion = getCurrentVersion(stream);
  if (!currentVersion) return null;
  return (
    (currentVersion.signatures || []).find(
      (entry) => normalizeAgencySuffix(entry?.agencyId) === normalizeAgencySuffix(agencySuffix)
    ) || null
  );
}

function getAgencySignatureStatusRows() {
  const requireAgencySignature = true;
  const rows = [];
  for (const stream of listCurrentStreams()) {
    const currentVersion = getCurrentVersion(stream);
    if (!currentVersion) continue;
    for (const agency of getTargetAgenciesForStream(stream)) {
      const agencyId = normalizeAgencySuffix(agency?.suffix);
      if (!agencyId) continue;
      const latestSignature = getLatestSignatureForAgency(stream, agencyId);

      rows.push({
        mouId: stream.mouId,
        mouTitle: stream.title,
        scopeType: normalizeScopeType(stream.scopeType),
        scopeLabel: getScopeLabel(stream),
        currentVersion: currentVersion.version,
        agencyId,
        agencyName: agency.name || agency.groupPrefix || agency.suffix,
        signingMode: getAgencySigningMode(stream, agencyId),
        inviteEmail: getAgencySigningInviteEmail(stream, agencyId),
        assignedAdminEmail: getAgencySigningAssignedAdminEmail(stream, agencyId),
        assignedAdminUsername: getAgencySigningAssignedAdminUsername(stream, agencyId),
        assignedAdminName: normalizeText(
          getAssignments(stream).agencySigning?.[agencyId]?.assignedAdminName
        ),
        externalSignPath: (() => {
          const invite = getActiveSignInviteForAgency({ mouId: stream.mouId, agencyId });
          return invite ? buildExternalSignPath(invite.token) : "";
        })(),
        signedVersion: latestSignature ? latestSignature.versionRecord.version : null,
        signerDisplayName: latestSignature
          ? (latestSignature.entry.attestationText || latestSignature.entry.signerDisplayName)
          : null,
        signedAt: latestSignature ? latestSignature.entry.signedAt : null,
        hasCountersignature: !!(
          latestSignature &&
          latestSignature.entry?.countersignature &&
          normalizeVersion(latestSignature.versionRecord.version) ===
            normalizeVersion(currentVersion.version)
        ),
        countersignerDisplayName:
          latestSignature?.entry?.countersignature?.attestationText ||
          latestSignature?.entry?.countersignature?.signerDisplayName ||
          null,
        historicalSignedVersions: getHistoricalSignedVersionsForAgency(
          stream,
          agencyId,
          currentVersion.version
        ),
        needsSignature:
          requireAgencySignature &&
          (!latestSignature ||
            normalizeVersion(latestSignature.versionRecord.version) <
              normalizeVersion(currentVersion.version)),
      });
    }
  }
  return rows;
}

function getAgreementSummaryForUser(authUser, options) {
  const currentAgreement = getCurrentUserAgreement();
  return {
    enabled: currentAgreement.enabled,
    shouldRequire: shouldRequireUserAgreement(authUser, options),
    agreement: currentAgreement.current,
  };
}

function getAgencyReminderRows() {
  const reminders = getRemindersStore();
  const byKey = reminders.agency || {};
  return getAgencySignatureStatusRows()
    .filter((row) => row.needsSignature)
    .map((row) => ({
      ...row,
      reminderDays: normalizedReminderDays(getStreamById(row.mouId).reminderDays),
      lastReminderSentAt:
        byKey[`${row.mouId}:${row.agencyId}:${row.currentVersion}`]?.lastSentAt ||
        null,
      reminderKey: `${row.mouId}:${row.agencyId}:${row.currentVersion}`,
    }));
}

function markAgencyReminderSent({ mouId, agencyId, version, sentAt }) {
  const data = getRemindersStore();
  const key = `${normalizeText(mouId)}:${normalizeAgencySuffix(
    agencyId
  )}:${normalizeVersion(version)}`;
  data.agency[key] = { lastSentAt: sentAt || nowIso() };
  saveRemindersStore(data);
}

function buildContentUrls(stream, versionRecord) {
  const fileUrl = `/mou/file/${encodeURIComponent(stream.mouId)}/${encodeURIComponent(versionRecord.version)}`;
  return {
    fileUrl,
    downloadUrl: `${fileUrl}?download=1`,
  };
}

function getSidebarListForUser(authUser) {
  const managedSuffixes = accessSvc.getUserManagedAgencySuffixes(authUser);
  const managedSet = new Set(managedSuffixes.map(normalizeAgencySuffix));
  return listCurrentStreamsForUser(authUser).map((stream) => {
    const currentVersion = getCurrentVersion(stream);
    const contentUrls = currentVersion ? buildContentUrls(stream, currentVersion) : null;
    const availableAgencySuffixes = managedSuffixes.length
      ? getStreamAgencySuffixes(stream).filter((suffix) =>
          managedSet.has(normalizeAgencySuffix(suffix))
        )
      : authUser?.isAgencyAdmin
        ? getStreamAgencySuffixes(stream).filter((suffix) =>
            accessSvc.isSuffixAllowed(authUser, suffix)
          )
        : [];
    const signableAgencySuffixes = availableAgencySuffixes.filter((suffix) =>
      canUserSignAgencyForStream(authUser, stream, suffix)
    );
    const viewHref = currentVersion ? buildDocumentViewHref(stream, currentVersion) : null;
    return {
      mouId: stream.mouId,
      title: stream.title,
      version: currentVersion?.version || null,
      scopeType: getAssignments(stream).serverwide ? "global" : "agency",
      scopeLabel: getScopeLabel(stream),
      contentType: normalizeContentType(currentVersion?.contentType),
      viewHref,
      fileUrl: contentUrls?.fileUrl || null,
      downloadUrl: contentUrls?.downloadUrl || null,
      signHref:
        currentVersion && signableAgencySuffixes.length
          ? `/mou/sign/${encodeURIComponent(stream.mouId)}/${encodeURIComponent(
              currentVersion.version
            )}`
          : null,
    };
  });
}

module.exports = {
  isEnabled,
  listStreams,
  listCurrentStreams,
  listCurrentStreamsForUser,
  getVisibleStreamsForUser,
  getStreamById,
  getCurrentVersionOrLatest,
  getVersionContent,
  createStream,
  createNextVersion,
  updateVersion,
  deleteStream,
  updateStreamAssignments,
  updateAgencySigningConfig,
  clearAgencySignatureForCurrentVersion,
  recordMouView,
  getCurrentUserAgreement,
  getDefaultUserAgreementTemplate,
  saveUserAgreement,
  shouldRequireUserAgreement,
  getAgreementSummaryForUser,
  signVersion,
  countersignVersion,
  getAgencyEvidence,
  getSignedPdfExport,
  getArchivedDocumentView,
  getArchivedSignedPdfExport,
  getArchivedDocumentContentExport,
  listSignatureRows,
  getAgencySignatureStatusRows,
  listArchivedDocumentRows,
  archiveDocumentForAgency,
  restoreArchivedDocument,
  deleteArchivedDocument,
  getAgencyReminderRows,
  markAgencyReminderSent,
  getAgencyBySuffix,
  getCurrentVersion,
  getCurrentAgencySignatureForStream,
  getSidebarListForUser,
  getScopeLabel,
  getTargetAgenciesForStream,
  streamAppliesToUser,
  readContentBuffer,
  readHtmlContent,
  renderContentPreview,
  buildContentUrls,
  getAgencySigningMode,
  getAgencySigningInviteEmail,
  AGENCY_SIGNING_MODE_AGENCY_ADMINS,
  AGENCY_SIGNING_MODE_SPECIFIC_ADMIN,
  AGENCY_SIGNING_MODE_EXTERNAL_LINK,
  buildExternalSignPath,
  createSignInvite,
  getActiveSignInviteForAgency,
  getUsedSignInviteForAgency,
  getSignInviteByToken,
  getSignInviteByCompletionToken,
  resolveValidSignInvite,
  resolveSignInviteCompletion,
  resolveSignInviteCompletionPdf,
  markSignInviteCompletionViewed,
  getAgencySigningAssignedAdminEmail,
  getAgencySigningAssignedAdminUsername,
  userMatchesAssignedSigningAdmin,
  canUserSignAgencyForStream,
  buildDocumentViewHref,
  resolvePrimaryAgencySuffixForUser,
  syncExternalSignInvitesForStream,
  refreshExternalSignInvitesAfterVersionChange,
  revokeActiveSignInvitesForAgency,
  streamHasAnySignatures,
  getStreamSignatureSummary,
  getStreamActiveAssignmentSignatureSummary,
};
