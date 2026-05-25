const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
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
  return getBool("MOU_ENABLED", false);
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
    agreement.enabled = normalizeVersion(agreement.currentVersion) > 0;
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
  if (assignments && typeof assignments === "object") {
    const serverwide = normalizedMandatory(assignments.serverwide);
    return {
      serverwide,
      agencySuffixes: serverwide
        ? []
        : normalizeAgencySuffixList(assignments.agencySuffixes),
    };
  }

  const legacyScopeType = normalizeScopeType(legacyStream?.scopeType);
  if (legacyScopeType === "global") {
    return {
      serverwide: true,
      agencySuffixes: [],
    };
  }

  return {
    serverwide: false,
    agencySuffixes: normalizeAgencySuffixList(legacyStream?.agencySuffix),
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
    return `Agency: ${agency.name || agency.groupPrefix || agency.suffix}`;
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

function resolveUserAgencySuffix(authUser) {
  if (!authUser) return "";
  return normalizeAgencySuffix(accessSvc.resolveAgencySuffixFromUser(authUser));
}

function streamAppliesToUser(stream, authUser) {
  if (!authUser) return false;
  if (!hasActiveAssignments(stream)) return false;
  if (getAssignments(stream).serverwide) return true;
  const targetAgencySuffixes = getStreamAgencySuffixes(stream);
  if (!targetAgencySuffixes.length) return false;
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
  };
}

function createVersionRecord({
  version,
  contentType,
  contentPath,
  contentSha256,
  originalFileName,
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
    reminderDays,
    mandatory,
  });
  const index = getIndex();
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
      actor,
    })
  );
  stream.updatedAt = nowIso();
  stream.updatedBy = actor?.uid || actor?.username || null;
  saveIndex(index);
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
    reminderDays,
    mandatory,
  }, versionRecord);

  const now = nowIso();
  stream.title = update.title;
  stream.slug = update.slug;
  stream.reminderDays = update.reminderDays;
  stream.mandatory = update.mandatory;
  stream.updatedAt = now;
  stream.updatedBy = actor?.uid || actor?.username || null;

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

  for (const versionRecord of stream.versions || []) {
    const contentPath = getAbsoluteContentPath(versionRecord);
    if (contentPath) {
      store.deleteFile(contentPath);
    }
    for (const signature of versionRecord.signatures || []) {
      const signedHtmlPath = getAbsoluteDataPath(signature?.signedHtmlPath);
      const signaturePngPath = getAbsoluteDataPath(signature?.signaturePngPath);
      const uploadedSignedCopyPath = getAbsoluteDataPath(signature?.uploadedSignedCopyPath);
      if (signedHtmlPath) store.deleteFile(signedHtmlPath);
      if (signaturePngPath) store.deleteFile(signaturePngPath);
      if (uploadedSignedCopyPath) store.deleteFile(uploadedSignedCopyPath);
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
  return true;
}

function updateStreamAssignments({ mouId, serverwide, agencySuffixes, actor }) {
  requireEnabled();
  const index = getIndex();
  const stream = findStream(index, mouId);
  if (!stream) {
    throw new Error("MOU stream not found.");
  }
  if (!getCurrentVersion(stream)) {
    throw new Error("Create a document version before assigning it.");
  }

  const assignments = normalizeAssignments({
    serverwide,
    agencySuffixes,
  });

  stream.assignments = assignments;
  stream.updatedAt = nowIso();
  stream.updatedBy = actor?.uid || actor?.username || null;
  saveIndex(index);
  return clone(stream);
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
  return !!(authUser && !authUser.isGlobalAdmin && !authUser.isAgencyAdmin);
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

function buildSignedHtml({ stream, versionRecord, signatureRecord }) {
  const scopeLabel = getScopeLabel(stream);
  const fileHref = `/mou/file/${encodeURIComponent(stream.mouId)}/${encodeURIComponent(versionRecord.version)}`;
  const storedSignaturePng = signatureRecord.signaturePngPath
    ? readBufferSafe(getAbsoluteDataPath(signatureRecord.signaturePngPath))
    : Buffer.alloc(0);
  const signatureImageDataUrl = signatureRecord.signatureImageDataUrl
    || (storedSignaturePng.length
      ? `data:image/png;base64,${storedSignaturePng.toString("base64")}`
      : "");
  const uploadedSignedCopyHref = signatureRecord.uploadedSignedCopyPath
    ? `/mou/agency-file/${encodeURIComponent(stream.mouId)}/${encodeURIComponent(signatureRecord.agencyId)}?version=${encodeURIComponent(versionRecord.version)}`
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
  const uploadedSignedCopyBlock = !uploadedSignedCopyHref
    ? ""
    : signatureRecord.uploadedSignedCopyContentType === "application/pdf"
      ? [
          '<div class="signed-uploaded-copy">',
          `  <p><a href="${uploadedSignedCopyHref}" target="_blank" rel="noopener noreferrer">Open uploaded signed document</a></p>`,
          `  <iframe src="${uploadedSignedCopyHref}" title="Uploaded signed document" style="width:100%;min-height:780px;border:1px solid #d1d5db;border-radius:12px;background:#fff;"></iframe>`,
          "</div>",
        ].join("\n")
      : String(signatureRecord.uploadedSignedCopyContentType || "").startsWith("image/")
        ? [
            '<div class="signed-uploaded-copy">',
            `  <p><a href="${uploadedSignedCopyHref}" target="_blank" rel="noopener noreferrer">Open uploaded signed document</a></p>`,
            `  <img src="${uploadedSignedCopyHref}" alt="Uploaded signed document" style="max-width:100%;height:auto;border:1px solid #d1d5db;border-radius:12px;background:#fff;" />`,
            "</div>",
          ].join("\n")
        : [
            '<div class="signed-uploaded-copy">',
            `  <p><a href="${uploadedSignedCopyHref}" target="_blank" rel="noopener noreferrer">Download uploaded signed document</a></p>`,
            "</div>",
          ].join("\n");

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
    "  .signature-image { max-width: 360px; max-height: 160px; display: block; margin-bottom: 12px; border-bottom: 1px solid #94a3b8; padding-bottom: 10px; }",
    "  .signature-line { margin: 4px 0; }",
    "</style>",
    '<div class="signed-shell">',
    '  <div class="signed-header">',
    `    <h1>${escapeHtml(stream.title)}</h1>`,
    `    <div>Version ${escapeHtml(String(versionRecord.version))} | ${escapeHtml(scopeLabel)}</div>`,
    "  </div>",
    `  <div class="signed-body">${renderedBody}${uploadedSignedCopyBlock}`,
    '    <div class="signature-card">',
    signatureImageDataUrl
      ? `      <img class="signature-image" src="${signatureImageDataUrl}" alt="Signature" />`
      : signatureRecord.uploadedSignedCopyPath
        ? '      <div class="signature-image" style="padding:12px 0;">Uploaded signed document.</div>'
        : '      <div class="signature-image" style="padding:12px 0;">E-signed document.</div>',
    `      <div class="signature-line"><strong>${escapeHtml(signatureRecord.attestationText || signatureRecord.signerDisplayName)}</strong></div>`,
    `      <div class="signature-line">${escapeHtml(signatureRecord.signerStatusAtSign || "Agency Administrator")}</div>`,
    `      <div class="signature-line">${escapeHtml(signatureRecord.agencyNameAtSign)}</div>`,
    `      <div class="signature-line">Signed ${escapeHtml(signatureRecord.signedAt)}</div>`,
    "    </div>",
    "  </div>",
    "</div>",
  ].join("\n");
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
  signatureDataUrl,
  uploadedSignedCopyFile,
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
  const pngBuffer = parseSignatureDataUrl(signatureDataUrl);

  requireNonEmpty(safeAgencySuffix, "Agency");
  requireNonEmpty(safeAgencyName, "Agency name");
  requireNonEmpty(safeSigner, "Signer name");
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
  return {
    stream: clone(stream),
    version: clone(versionRecord),
    signature: clone(signatureRecord),
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
    };
  }
  throw new Error("Signed evidence not found.");
}

function listSignaturesForStream(stream) {
  const rows = [];
  for (const versionRecord of sortVersions(stream?.versions || [])) {
    for (const signature of versionRecord.signatures || []) {
      rows.push({
        mouId: stream.mouId,
        mouTitle: stream.title,
        scopeType: normalizeScopeType(stream.scopeType),
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
  const requireAgencySignature = getBool("MOU_REQUIRE_AGENCY_SIGNATURE", true);
  const rows = [];
  for (const stream of listCurrentStreams()) {
    const currentVersion = getCurrentVersion(stream);
    if (!currentVersion) continue;
    for (const agency of getTargetAgenciesForStream(stream)) {
      const agencyId = normalizeAgencySuffix(agency?.suffix);
      if (!agencyId) continue;
      const latestSignature =
        sortVersions(stream.versions || [])
          .reverse()
          .flatMap((versionRecord) =>
            (versionRecord.signatures || [])
              .filter(
                (entry) =>
                  normalizeAgencySuffix(entry?.agencyId) === agencyId
              )
              .map((entry) => ({ versionRecord, entry }))
          )[0] || null;

      rows.push({
        mouId: stream.mouId,
        mouTitle: stream.title,
        scopeType: normalizeScopeType(stream.scopeType),
        scopeLabel: getScopeLabel(stream),
        currentVersion: currentVersion.version,
        agencyId,
        agencyName: agency.name || agency.groupPrefix || agency.suffix,
        signedVersion: latestSignature ? latestSignature.versionRecord.version : null,
        signerDisplayName: latestSignature
          ? (latestSignature.entry.attestationText || latestSignature.entry.signerDisplayName)
          : null,
        signedAt: latestSignature ? latestSignature.entry.signedAt : null,
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
  return listCurrentStreamsForUser(authUser).map((stream) => {
    const currentVersion = getCurrentVersion(stream);
    const contentUrls = currentVersion ? buildContentUrls(stream, currentVersion) : null;
    const availableAgencySuffixes = authUser?.isAgencyAdmin
      ? getStreamAgencySuffixes(stream).filter((suffix) =>
          accessSvc.isSuffixAllowed(authUser, suffix)
        )
      : [];
    return {
      mouId: stream.mouId,
      title: stream.title,
      version: currentVersion?.version || null,
      scopeType: getAssignments(stream).serverwide ? "global" : "agency",
      scopeLabel: getScopeLabel(stream),
      contentType: normalizeContentType(currentVersion?.contentType),
      viewHref:
        currentVersion
          ? normalizeContentType(currentVersion?.contentType) === "pdf"
            ? `/mou/file/${encodeURIComponent(stream.mouId)}/${encodeURIComponent(
                currentVersion.version
              )}`
            : `/mou/view/${encodeURIComponent(stream.mouId)}/${encodeURIComponent(
                currentVersion.version
              )}`
          : null,
      fileUrl: contentUrls?.fileUrl || null,
      downloadUrl: contentUrls?.downloadUrl || null,
      signHref:
        currentVersion && availableAgencySuffixes.length
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
  recordMouView,
  getCurrentUserAgreement,
  getDefaultUserAgreementTemplate,
  saveUserAgreement,
  shouldRequireUserAgreement,
  getAgreementSummaryForUser,
  signVersion,
  getAgencyEvidence,
  listSignatureRows,
  getAgencySignatureStatusRows,
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
};
