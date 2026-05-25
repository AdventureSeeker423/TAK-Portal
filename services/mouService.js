const crypto = require("crypto");
const path = require("path");
const agenciesStore = require("./agencies.service");
const accessSvc = require("./access.service");
const {
  getBool,
  getInt,
} = require("./env");
const store = require("./mouStore");
const {
  sanitizeMouHtml,
  sanitizeUserAgreementHtml,
} = require("./mouHtmlSanitizer");

function nowIso() {
  return new Date().toISOString();
}

function makeId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
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

function slugify(value) {
  const out = normalizeLower(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out || "mou";
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

function computeSha256(content) {
  return crypto.createHash("sha256").update(String(content || ""), "utf8").digest("hex");
}

function getIndex() {
  store.ensureStorage();
  const index = store.loadIndex();
  if (!Array.isArray(index.streams)) {
    index.streams = [];
  }
  return index;
}

function saveIndex(index) {
  store.saveIndex(index);
}

function getUserAgreementStore() {
  store.ensureStorage();
  const agreement = store.loadUserAgreement();
  if (!Array.isArray(agreement.versions)) {
    agreement.versions = [];
  }
  if (!Number.isFinite(Number(agreement.currentVersion))) {
    agreement.currentVersion = 0;
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
  if (!data || typeof data !== "object") {
    return { schemaVersion: 1, agency: {} };
  }
  if (!data.agency || typeof data.agency !== "object") data.agency = {};
  return data;
}

function saveRemindersStore(data) {
  store.saveReminders(data);
}

function sortVersions(versions) {
  return (Array.isArray(versions) ? versions : [])
    .slice()
    .sort((a, b) => normalizeVersion(a?.version) - normalizeVersion(b?.version));
}

function findStream(index, mouId) {
  return (index.streams || []).find((stream) => String(stream?.mouId || "") === String(mouId || ""));
}

function findVersion(stream, version) {
  const numeric = normalizeVersion(version);
  return (stream?.versions || []).find((entry) => normalizeVersion(entry?.version) === numeric) || null;
}

function getCurrentDeployedVersion(stream) {
  return sortVersions(stream?.versions || []).find((entry) => String(entry?.state || "") === "deployed") || null;
}

function getLatestVersion(stream) {
  const versions = sortVersions(stream?.versions || []);
  return versions.length ? versions[versions.length - 1] : null;
}

function readContentForVersion(versionRecord) {
  const rel = normalizeText(versionRecord?.contentHtmlPath);
  if (!rel) return "";
  return store.readHtml(path.join(__dirname, "..", "data", rel));
}

function buildRelativeDataPath(absPath) {
  const dataDir = path.join(__dirname, "..", "data");
  const relative = path.relative(dataDir, absPath).replace(/\\/g, "/");
  return relative.startsWith("../") ? "" : relative;
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

function validateDraftFields(input) {
  const title = normalizeText(input?.title);
  const slug = slugify(input?.slug || title);
  const reminderDays = normalizedReminderDays(input?.reminderDays);
  const mandatory = normalizedMandatory(input?.mandatory);
  const html = sanitizeMouHtml(input?.html || "");

  requireNonEmpty(title, "Title");
  enforceHtmlSize(html);

  return {
    title,
    slug,
    reminderDays,
    mandatory,
    html,
  };
}

function listStreams() {
  const index = getIndex();
  return sortStreams(index.streams || []);
}

function sortStreams(streams) {
  return (Array.isArray(streams) ? streams : [])
    .slice()
    .sort((a, b) => String(a?.title || "").localeCompare(String(b?.title || ""), undefined, { sensitivity: "base" }));
}

function getStreamById(mouId) {
  const index = getIndex();
  const stream = findStream(index, mouId);
  if (!stream) throw new Error("MOU stream not found.");
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

function createDraftStream({ title, slug, html, reminderDays, mandatory, actor }) {
  requireEnabled();
  const draft = validateDraftFields({ title, slug, html, reminderDays, mandatory });
  const index = getIndex();
  const mouId = makeId();
  const version = 1;
  const timestamp = nowIso();
  const draftPath = store.getDraftPath(mouId, version);
  store.writeHtml(draftPath, draft.html);

  const stream = {
    mouId,
    title: draft.title,
    slug: draft.slug,
    mandatory: draft.mandatory,
    reminderDays: draft.reminderDays,
    createdAt: timestamp,
    createdBy: actor?.uid || actor?.username || null,
    updatedAt: timestamp,
    updatedBy: actor?.uid || actor?.username || null,
    versions: [
      {
        version,
        state: "draft",
        contentHtmlPath: buildRelativeDataPath(draftPath),
        contentSha256: null,
        createdAt: timestamp,
        createdBy: actor?.uid || actor?.username || null,
        updatedAt: timestamp,
        updatedBy: actor?.uid || actor?.username || null,
        deployedAt: null,
        deployedBy: null,
        supersededAt: null,
        supersededBy: null,
        signatures: [],
      },
    ],
  };

  index.streams.push(stream);
  saveIndex(index);
  return clone(stream);
}

function createNextDraft({ mouId, actor }) {
  requireEnabled();
  const index = getIndex();
  const stream = findStream(index, mouId);
  if (!stream) throw new Error("MOU stream not found.");
  const existingDraft = (stream.versions || []).find((entry) => String(entry?.state || "") === "draft");
  if (existingDraft) {
    throw new Error("A draft already exists for this stream.");
  }

  const latest = getLatestVersion(stream);
  const nextVersion = normalizeVersion(latest?.version) + 1;
  const timestamp = nowIso();
  const sourceHtml = latest ? readContentForVersion(latest) : "";
  const sanitizedHtml = sanitizeMouHtml(sourceHtml);
  enforceHtmlSize(sanitizedHtml);
  const draftPath = store.getDraftPath(mouId, nextVersion);
  store.writeHtml(draftPath, sanitizedHtml);

  stream.versions.push({
    version: nextVersion,
    state: "draft",
    contentHtmlPath: buildRelativeDataPath(draftPath),
    contentSha256: null,
    createdAt: timestamp,
    createdBy: actor?.uid || actor?.username || null,
    updatedAt: timestamp,
    updatedBy: actor?.uid || actor?.username || null,
    deployedAt: null,
    deployedBy: null,
    supersededAt: null,
    supersededBy: null,
    signatures: [],
  });
  stream.updatedAt = timestamp;
  stream.updatedBy = actor?.uid || actor?.username || null;
  saveIndex(index);
  return clone(stream);
}

function updateDraft({ mouId, version, title, slug, html, reminderDays, mandatory, actor }) {
  requireEnabled();
  const update = validateDraftFields({ title, slug, html, reminderDays, mandatory });
  const { index, stream, versionRecord } = getStreamAndVersion(mouId, version);
  if (String(versionRecord.state || "") !== "draft") {
    throw new Error("Only draft versions can be edited.");
  }

  const timestamp = nowIso();
  const draftPath = store.getDraftPath(mouId, versionRecord.version);
  store.writeHtml(draftPath, update.html);

  stream.title = update.title;
  stream.slug = update.slug;
  stream.reminderDays = update.reminderDays;
  stream.mandatory = update.mandatory;
  stream.updatedAt = timestamp;
  stream.updatedBy = actor?.uid || actor?.username || null;

  versionRecord.contentHtmlPath = buildRelativeDataPath(draftPath);
  versionRecord.updatedAt = timestamp;
  versionRecord.updatedBy = actor?.uid || actor?.username || null;

  saveIndex(index);
  return clone(stream);
}

function discardDraft({ mouId, version }) {
  requireEnabled();
  const { index, stream, versionRecord } = getStreamAndVersion(mouId, version);
  if (String(versionRecord.state || "") !== "draft") {
    throw new Error("Only draft versions can be discarded.");
  }

  store.deleteFile(store.getDraftPath(mouId, versionRecord.version));
  stream.versions = (stream.versions || []).filter((entry) => normalizeVersion(entry?.version) !== normalizeVersion(version));
  if (!stream.versions.length) {
    index.streams = (index.streams || []).filter((entry) => String(entry?.mouId || "") !== String(mouId));
  }
  saveIndex(index);
  return true;
}

function deployDraft({ mouId, version, actor, confirmText }) {
  requireEnabled();
  if (getBool("MOU_DEPLOY_REQUIRES_TYPED_CONFIRM", true) && normalizeText(confirmText) !== "DEPLOY") {
    throw new Error('Typed confirmation must equal "DEPLOY".');
  }

  const { index, stream, versionRecord } = getStreamAndVersion(mouId, version);
  if (String(versionRecord.state || "") !== "draft") {
    throw new Error("Only draft versions can be deployed.");
  }

  const draftPath = store.getDraftPath(mouId, versionRecord.version);
  const html = sanitizeMouHtml(store.readHtml(draftPath));
  requireNonEmpty(html.replace(/<[^>]+>/g, "").trim(), "MOU HTML");
  enforceHtmlSize(html);

  const deployedPath = store.getDeployedPath(mouId, versionRecord.version);
  store.writeHtml(deployedPath, html);
  store.deleteFile(draftPath);

  const now = nowIso();
  const contentSha256 = computeSha256(html);
  const previous = getCurrentDeployedVersion(stream);
  if (previous) {
    previous.state = "superseded";
    previous.supersededAt = now;
    previous.supersededBy = versionRecord.version;
  }

  versionRecord.state = "deployed";
  versionRecord.contentHtmlPath = buildRelativeDataPath(deployedPath);
  versionRecord.contentSha256 = contentSha256;
  versionRecord.updatedAt = now;
  versionRecord.updatedBy = actor?.uid || actor?.username || null;
  versionRecord.deployedAt = now;
  versionRecord.deployedBy = actor?.uid || actor?.username || null;
  if (!Array.isArray(versionRecord.signatures)) {
    versionRecord.signatures = [];
  }

  stream.updatedAt = now;
  stream.updatedBy = actor?.uid || actor?.username || null;
  saveIndex(index);

  return {
    stream: clone(stream),
    version: clone(versionRecord),
    supersededVersion: previous ? previous.version : null,
    html,
    contentSha256,
  };
}

function listDeployedStreams() {
  return sortStreams(
    listStreams().filter((stream) => !!getCurrentDeployedVersion(stream))
  );
}

function getDeployedVersionOrLatest(mouId, version) {
  const index = getIndex();
  const stream = findStream(index, mouId);
  if (!stream) throw new Error("MOU stream not found.");
  const deployed = getCurrentDeployedVersion(stream);
  if (!deployed) throw new Error("This MOU has not been deployed yet.");
  const requested = version ? findVersion(stream, version) : deployed;
  if (!requested) throw new Error("MOU version not found.");
  const shouldRedirectToLatest =
    String(requested.state || "") !== "deployed" &&
    String(requested.state || "") !== "superseded";
  const target = shouldRedirectToLatest ? deployed : requested;
  return {
    stream: clone(stream),
    requestedVersion: clone(requested),
    targetVersion: clone(target),
    latestVersion: clone(deployed),
    html: readContentForVersion(target),
    redirectedToLatest: normalizeVersion(target.version) !== normalizeVersion(requested.version),
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
  const current = (data.versions || []).find((entry) => normalizeVersion(entry?.version) === currentVersion) || null;
  return {
    currentVersion,
    current: current ? clone(current) : null,
    versions: clone(data.versions || []),
  };
}

function saveUserAgreement({ title, html, actor }) {
  requireEnabled();
  const safeTitle = normalizeText(title) || "User Agreement";
  const safeHtml = sanitizeUserAgreementHtml(html || "");
  requireNonEmpty(safeHtml.replace(/<[^>]+>/g, "").trim(), "User agreement text");
  enforceHtmlSize(safeHtml);

  const data = getUserAgreementStore();
  const current = getCurrentUserAgreement().current;
  if (current && current.title === safeTitle && current.bodyHtml === safeHtml) {
    return {
      changed: false,
      version: clone(current),
    };
  }

  const nextVersion = normalizeVersion(data.currentVersion) + 1 || 1;
  const now = nowIso();
  const versionRecord = {
    version: nextVersion,
    title: safeTitle,
    bodyHtml: safeHtml,
    createdAt: now,
    createdBy: actor?.uid || actor?.username || null,
    deployedAt: now,
    deployedBy: actor?.uid || actor?.username || null,
  };
  data.currentVersion = nextVersion;
  data.versions.push(versionRecord);
  saveUserAgreementStore(data);
  return {
    changed: true,
    version: clone(versionRecord),
  };
}

function isStandardUser(authUser) {
  return !!(authUser && !authUser.isGlobalAdmin && !authUser.isAgencyAdmin);
}

function getCurrentAgreementAckForUser(authUser) {
  const userId = getUserKey(authUser);
  if (!userId) return null;
  const agreement = getCurrentUserAgreement();
  if (!agreement.current) return null;
  const data = getAcksStore();
  return data.items.find((item) =>
    String(item?.type || "") === "user_agreement" &&
    String(item?.userId || "") === userId &&
    normalizeVersion(item?.version) === agreement.currentVersion
  ) || null;
}

function shouldRequireUserAgreement(authUser) {
  if (!isEnabled()) return false;
  if (!isStandardUser(authUser)) return false;
  const agreement = getCurrentUserAgreement();
  if (!agreement.current) return false;
  return !getCurrentAgreementAckForUser(authUser);
}

function acceptCurrentUserAgreement({ authUser, ip, userAgent }) {
  if (!isStandardUser(authUser)) {
    throw new Error("Only standard users can accept the user agreement.");
  }
  const agreement = getCurrentUserAgreement();
  if (!agreement.current) {
    throw new Error("No user agreement is currently configured.");
  }

  const userId = getUserKey(authUser);
  if (!userId) throw new Error("Authenticated user not found.");

  const data = getAcksStore();
  const existing = getCurrentAgreementAckForUser(authUser);
  if (existing) return clone(existing);

  const row = {
    type: "user_agreement",
    key: `${userId}|agreement|${agreement.currentVersion}`,
    userId,
    username: authUser?.username || null,
    version: agreement.currentVersion,
    acceptedAt: nowIso(),
    ip: ip || null,
    userAgent: userAgent || null,
  };
  data.items.push(row);
  saveAcksStore(data);
  return clone(row);
}

function getAgencyBySuffix(agencySuffix) {
  const suffix = normalizeLower(agencySuffix);
  return (agenciesStore.load() || []).find((agency) => normalizeLower(agency?.suffix) === suffix) || null;
}

function buildSignedHtml({ stream, versionRecord, deployedHtml, signatureRecord }) {
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "  <meta charset=\"utf-8\" />",
    `  <title>${escapeHtml(stream.title)} - Signed Evidence</title>`,
    "  <style>",
    "    body { font-family: Arial, Helvetica, sans-serif; margin: 24px; color: #111827; }",
    "    .signed-shell { max-width: 1100px; margin: 0 auto; }",
    "    .signed-header { margin-bottom: 24px; }",
    "    .signature-card { margin-top: 32px; border-top: 2px solid #111827; padding-top: 16px; }",
    "    .signature-image { max-width: 360px; max-height: 160px; display: block; margin-bottom: 12px; border-bottom: 1px solid #6b7280; padding-bottom: 10px; }",
    "    .signature-line { margin: 4px 0; }",
    "  </style>",
    "</head>",
    "<body>",
    "  <div class=\"signed-shell\">",
    "    <div class=\"signed-header\">",
    `      <h1>${escapeHtml(stream.title)}</h1>`,
    `      <p>Signed evidence for version ${escapeHtml(String(versionRecord.version))}</p>`,
    "    </div>",
    `    <div class=\"signed-body\">${deployedHtml}</div>`,
    "    <div class=\"signature-card\">",
    signatureRecord.signatureImageDataUrl
      ? `      <img class="signature-image" src="${signatureRecord.signatureImageDataUrl}" alt="Signature" />`
      : "      <div class=\"signature-image\" style=\"padding:12px 0;\">Typed attestation used.</div>",
    `      <div class="signature-line"><strong>${escapeHtml(signatureRecord.signerDisplayName)}</strong></div>`,
    `      <div class="signature-line">${escapeHtml(signatureRecord.signerStatusAtSign || "Agency Administrator")}</div>`,
    `      <div class="signature-line">${escapeHtml(signatureRecord.agencyNameAtSign)}</div>`,
    `      <div class="signature-line">Signed ${escapeHtml(signatureRecord.signedAt)} from ${escapeHtml(signatureRecord.ip || "unknown")}</div>`,
    "    </div>",
    "  </div>",
    "</body>",
    "</html>",
  ].join("\n");
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
  if (!match) {
    throw new Error("Signature must be a PNG data URL.");
  }
  return Buffer.from(match[1], "base64");
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
  ip,
  userAgent,
}) {
  requireEnabled();
  const { index, stream, versionRecord } = getStreamAndVersion(mouId, version);
  if (String(versionRecord.state || "") !== "deployed") {
    throw new Error("Only deployed versions can be signed.");
  }

  const safeAgencySuffix = normalizeLower(agencySuffix);
  const safeAgencyName = normalizeText(agencyNameAtSign);
  const safeSigner = normalizeText(signerDisplayName);
  const safeStatus = normalizeText(signerStatusAtSign) || "Agency Administrator";
  const safeAttestation = normalizeText(attestationText);
  const pngBuffer = parseSignatureDataUrl(signatureDataUrl);

  requireNonEmpty(safeAgencySuffix, "Agency");
  requireNonEmpty(safeAgencyName, "Agency name");
  requireNonEmpty(safeSigner, "Signer name");
  if (!pngBuffer && !safeAttestation) {
    throw new Error("Provide a drawn signature or typed attestation.");
  }

  if (!Array.isArray(versionRecord.signatures)) {
    versionRecord.signatures = [];
  }
  if (versionRecord.signatures.some((entry) => normalizeLower(entry?.agencyId) === safeAgencySuffix)) {
    throw new Error("This agency has already signed the current version.");
  }

  const signaturePath = store.getSignaturePngPath(mouId, safeAgencySuffix, versionRecord.version);
  if (pngBuffer) {
    store.writeBinary(signaturePath, pngBuffer);
  }

  const deployedHtml = readContentForVersion(versionRecord);
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
    signedHtmlPath: buildRelativeDataPath(
      store.getSignedHtmlPath(mouId, safeAgencySuffix, versionRecord.version)
    ),
    attestationText: safeAttestation,
    signatureImageDataUrl: pngBuffer ? `data:image/png;base64,${pngBuffer.toString("base64")}` : "",
  };

  const signedHtml = buildSignedHtml({
    stream,
    versionRecord,
    deployedHtml,
    signatureRecord,
  });
  store.writeHtml(path.join(__dirname, "..", "data", signatureRecord.signedHtmlPath), signedHtml);
  delete signatureRecord.signatureImageDataUrl;

  versionRecord.signatures.push(signatureRecord);
  saveIndex(index);
  return {
    stream: clone(stream),
    version: clone(versionRecord),
    signature: clone(signatureRecord),
  };
}

function listSignaturesForStream(stream) {
  const rows = [];
  for (const version of sortVersions(stream?.versions || [])) {
    for (const signature of version.signatures || []) {
      rows.push({
        mouId: stream.mouId,
        mouTitle: stream.title,
        streamSlug: stream.slug,
        deployedVersion: getCurrentDeployedVersion(stream)?.version || null,
        versionSigned: version.version,
        agencyId: signature.agencyId,
        agencyName: signature.agencyNameAtSign,
        signerDisplayName: signature.signerDisplayName,
        signerStatusAtSign: signature.signerStatusAtSign,
        signedAt: signature.signedAt,
        signedHtmlPath: signature.signedHtmlPath,
        needsNewSignature: !!(getCurrentDeployedVersion(stream) &&
          normalizeVersion(getCurrentDeployedVersion(stream).version) > normalizeVersion(version.version)),
      });
    }
  }
  return rows;
}

function getAgencyEvidence({ mouId, agencyId, version }) {
  const stream = getStreamById(mouId);
  const versions = version
    ? [findVersion(stream, version)].filter(Boolean)
    : sortVersions(stream.versions || []).reverse();

  for (const versionRecord of versions) {
    const signature = (versionRecord.signatures || []).find(
      (entry) => normalizeLower(entry?.agencyId) === normalizeLower(agencyId)
    );
    if (!signature) continue;
    const fullPath = path.join(__dirname, "..", "data", signature.signedHtmlPath);
    return {
      stream,
      version: clone(versionRecord),
      signature: clone(signature),
      html: store.readHtml(fullPath),
    };
  }
  throw new Error("Signed evidence not found.");
}

function listSignatureRows() {
  const streams = listStreams();
  return streams.flatMap((stream) => listSignaturesForStream(stream));
}

function getAgencySignatureStatusRows() {
  const agencies = agenciesStore.load() || [];
  const requireAgencySignature = getBool("MOU_REQUIRE_AGENCY_SIGNATURE", true);
  const rows = [];
  for (const stream of listDeployedStreams()) {
    const deployed = getCurrentDeployedVersion(stream);
    if (!deployed) continue;
    for (const agency of agencies) {
      const agencyId = normalizeLower(agency?.suffix);
      if (!agencyId) continue;
      const latestSignature = sortVersions(stream.versions || [])
        .reverse()
        .flatMap((versionRecord) =>
          (versionRecord.signatures || [])
            .filter((entry) => normalizeLower(entry?.agencyId) === agencyId)
            .map((entry) => ({ versionRecord, entry }))
        )[0] || null;

      rows.push({
        mouId: stream.mouId,
        mouTitle: stream.title,
        deployedVersion: deployed.version,
        agencyId,
        agencyName: agency.name || agency.groupPrefix || agency.suffix,
        signedVersion: latestSignature ? latestSignature.versionRecord.version : null,
        signerDisplayName: latestSignature ? latestSignature.entry.signerDisplayName : null,
        signedAt: latestSignature ? latestSignature.entry.signedAt : null,
        needsSignature: requireAgencySignature &&
          (!latestSignature || normalizeVersion(latestSignature.versionRecord.version) < normalizeVersion(deployed.version)),
      });
    }
  }
  return rows;
}

function getAgreementAcceptanceRowsForUsers(users) {
  const agreement = getCurrentUserAgreement();
  const currentVersion = agreement.currentVersion;
  const items = getAcksStore().items.filter((item) =>
    String(item?.type || "") === "user_agreement" &&
    normalizeVersion(item?.version) === currentVersion
  );
  const byUser = new Map(items.map((item) => [String(item.userId), item]));
  return (Array.isArray(users) ? users : []).map((user) => {
    const userId = normalizeText(user?.username || user?.uid || user?.pk || user?.id);
    const ack = byUser.get(userId) || null;
    return {
      userId,
      username: user?.username || null,
      displayName: user?.name || user?.displayName || user?.username || null,
      accepted: !!ack,
      acceptedAt: ack?.acceptedAt || null,
      version: currentVersion,
    };
  });
}

function getAgreementSummaryForUser(authUser) {
  return {
    shouldRequire: shouldRequireUserAgreement(authUser),
    agreement: getCurrentUserAgreement().current,
    accepted: !!getCurrentAgreementAckForUser(authUser),
  };
}

function getAgencyReminderRows() {
  const reminders = getRemindersStore();
  const byKey = reminders.agency || {};
  return getAgencySignatureStatusRows()
    .filter((row) => row.needsSignature)
    .map((row) => {
      const key = `${row.mouId}:${row.agencyId}:${row.deployedVersion}`;
      return {
        ...row,
        reminderDays: normalizedReminderDays(
          getStreamById(row.mouId).reminderDays
        ),
        lastReminderSentAt: byKey[key]?.lastSentAt || null,
        reminderKey: key,
      };
    });
}

function markAgencyReminderSent({ mouId, agencyId, version, sentAt }) {
  const data = getRemindersStore();
  const key = `${normalizeText(mouId)}:${normalizeLower(agencyId)}:${normalizeVersion(version)}`;
  data.agency[key] = {
    lastSentAt: sentAt || nowIso(),
  };
  saveRemindersStore(data);
}

function getCurrentAgencySignatureForStream(stream, agencySuffix) {
  const deployed = getCurrentDeployedVersion(stream);
  if (!deployed) return null;
  return (deployed.signatures || []).find(
    (entry) => normalizeLower(entry?.agencyId) === normalizeLower(agencySuffix)
  ) || null;
}

function getSidebarListForUser(authUser) {
  const access = accessSvc.getAgencyAccess(authUser);
  return listDeployedStreams().map((stream) => {
    const deployed = getCurrentDeployedVersion(stream);
    return {
      mouId: stream.mouId,
      title: stream.title,
      version: deployed?.version || null,
      viewHref: deployed ? `/mou/view/${encodeURIComponent(stream.mouId)}/${encodeURIComponent(deployed.version)}` : null,
      signHref:
        deployed && access.isAgencyAdmin && access.allowedAgencySuffixes && access.allowedAgencySuffixes[0]
          ? `/mou/sign/${encodeURIComponent(stream.mouId)}/${encodeURIComponent(deployed.version)}`
          : null,
    };
  });
}

module.exports = {
  isEnabled,
  listStreams,
  listDeployedStreams,
  getStreamById,
  getDeployedVersionOrLatest,
  createDraftStream,
  createNextDraft,
  updateDraft,
  discardDraft,
  deployDraft,
  recordMouView,
  getCurrentUserAgreement,
  saveUserAgreement,
  shouldRequireUserAgreement,
  acceptCurrentUserAgreement,
  getAgreementSummaryForUser,
  signVersion,
  getAgencyEvidence,
  listSignatureRows,
  getAgencySignatureStatusRows,
  getAgreementAcceptanceRowsForUsers,
  getAgencyReminderRows,
  markAgencyReminderSent,
  getAgencyBySuffix,
  getCurrentDeployedVersion,
  getCurrentAgencySignatureForStream,
  getSidebarListForUser,
};
