/**
 * Send mission/data packages directly to connected TAK clients (Marti missioncreate).
 */
const crypto = require("crypto");
const { buildTakAxios, getTakBaseUrl, isTakConfigured } = require("./tak.service");
const { getBool } = require("./env");
const dataPackagesSvc = require("./dataPackages.service");

const SENT_PACKAGE_CLEANUP_DELAY_MS = 5000;
const SENT_PACKAGE_CLEANUP_RETRY_MS = 5000;
const SENT_PACKAGE_CLEANUP_MAX_ATTEMPTS = 8;

function assertTakAvailable() {
  if (getBool("TAK_BYPASS_ENABLED", false)) {
    const err = new Error("TAK operations are disabled (TAK_BYPASS_ENABLED=true).");
    err.code = "TAK_BYPASS";
    err.status = 503;
    throw err;
  }
  if (!isTakConfigured()) {
    const err = new Error("TAK_URL is not configured in Server Settings.");
    err.code = "TAK_NOT_CONFIGURED";
    err.status = 503;
    throw err;
  }
}

function getTakOriginBaseUrl() {
  const u = new URL(getTakBaseUrl());
  return `${u.protocol}//${u.host}`;
}

function buildTakOriginAxios(options = {}) {
  return buildTakAxios({
    ...options,
    baseURL: getTakOriginBaseUrl(),
  });
}

function safeStr(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function normalizeHash(value) {
  const h = safeStr(value).trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(h) ? h : "";
}

function formatMartiError(err) {
  const status = Number(err?.response?.status) || 500;
  const data = err?.response?.data;
  let message = err?.message || "TAK request failed";
  if (typeof data === "string" && data.trim()) message = data.trim();
  else if (Buffer.isBuffer(data)) message = data.toString("utf8").trim() || message;
  else if (data && typeof data === "object") {
    message = data.message || data.error || JSON.stringify(data);
  }
  const out = new Error(message);
  out.status = status;
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractHashFromMartiResponse(data) {
  if (data == null) return "";
  if (typeof data === "string") {
    const direct = normalizeHash(data);
    if (direct) return direct;
    try {
      return extractHashFromMartiResponse(JSON.parse(data));
    } catch (_) {
      return "";
    }
  }
  if (typeof data !== "object") return "";

  const direct = normalizeHash(
    data.hash || data.Hash || data.sha256 || data.SHA256 || data.contentHash || data.ContentHash
  );
  if (direct) return direct;

  if (data.data != null) {
    const nested = extractHashFromMartiResponse(data.data);
    if (nested) return nested;
  }
  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      const nested = extractHashFromMartiResponse(data[i]);
      if (nested) return nested;
    }
  }
  return "";
}

function packageFilename(record) {
  return safeStr(record?.filename || record?.Filename || record?.name || record?.Name).trim();
}

function packageCreatedAt(record) {
  const raw = safeStr(
    record?.created_at || record?.createdAt || record?.submissionTime || record?.SubmissionDateTime
  ).trim();
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : 0;
}

async function resolveStoredPackageHash({ hash, filename }) {
  const preferred = normalizeHash(hash);
  const fname = safeStr(filename).trim().toLowerCase();
  if (!preferred && !fname) return "";

  try {
    const listed = await dataPackagesSvc.listDataPackages({});
    const items = Array.isArray(listed?.items) ? listed.items : [];

    if (preferred) {
      const byHash = items.find((item) => normalizeHash(item?.hash) === preferred);
      if (byHash?.hash) return normalizeHash(byHash.hash);
    }

    if (fname) {
      const matches = items.filter((item) => packageFilename(item).toLowerCase() === fname);
      if (matches.length) {
        matches.sort((a, b) => packageCreatedAt(b) - packageCreatedAt(a));
        const pick = normalizeHash(matches[0]?.hash);
        if (pick) return pick;
      }
    }
  } catch (err) {
    console.warn(
      "[takMissionPackage] Failed to resolve stored package hash:",
      err?.message || err
    );
  }

  return preferred;
}

async function deleteSentDataPackage({ hash, filename, label }) {
  const labelText = safeStr(label).trim() || safeStr(filename).trim() || safeStr(hash).trim();
  if (!hash && !filename) return;

  for (let attempt = 1; attempt <= SENT_PACKAGE_CLEANUP_MAX_ATTEMPTS; attempt++) {
    const resolvedHash = await resolveStoredPackageHash({ hash, filename });
    if (!resolvedHash) {
      if (attempt < SENT_PACKAGE_CLEANUP_MAX_ATTEMPTS) {
        await sleep(SENT_PACKAGE_CLEANUP_RETRY_MS);
        continue;
      }
      break;
    }

    const result = await dataPackagesSvc.deleteDataPackage(resolvedHash);
    if (!result?.alreadyGone) {
      console.log(`[takMissionPackage] Cleaned up sent package ${labelText} (${resolvedHash})`);
      return;
    }

    if (attempt < SENT_PACKAGE_CLEANUP_MAX_ATTEMPTS) {
      await sleep(SENT_PACKAGE_CLEANUP_RETRY_MS);
    }
  }

  console.warn(
    `[takMissionPackage] Failed to clean up sent package ${labelText}; it may still appear in Data Package Manager.`
  );
}

function scheduleSentPackageCleanup({
  hash,
  filename,
  label,
  delayMs = SENT_PACKAGE_CLEANUP_DELAY_MS,
}) {
  const h = normalizeHash(hash);
  const fname = safeStr(filename).trim();
  if (!h && !fname) return;

  setTimeout(() => {
    deleteSentDataPackage({ hash: h, filename: fname, label: label || fname || h }).catch((err) => {
      console.warn(
        `[takMissionPackage] Package cleanup failed (${label || fname || h}):`,
        err?.message || err
      );
    });
  }, delayMs);
}

async function sendMissionPackageToContact({ clientUid, buffer, filename, packageHash }) {
  assertTakAvailable();

  const uid = safeStr(clientUid).trim();
  if (!uid) {
    const err = new Error("Client UID is required.");
    err.status = 400;
    throw err;
  }
  if (!buffer || !Buffer.isBuffer(buffer) || !buffer.length) {
    const err = new Error("Package content is required.");
    err.status = 400;
    throw err;
  }

  const name = safeStr(filename).trim() || "Pref-config.zip";
  const hash = normalizeHash(packageHash) || crypto.createHash("sha256").update(buffer).digest("hex");
  const client = buildTakOriginAxios({ timeout: 180000 });
  const BlobCtor = global.Blob || require("node:buffer").Blob;
  const form = new FormData();
  const blob = new BlobCtor([buffer], { type: "application/x-zip-compressed" });
  form.append("assetfile", blob, name);
  form.append("filename", name);
  form.append("contacts", uid);

  try {
    const res = await client.post("/Marti/sync/missioncreate", form, {
      params: {
        hash,
        filename: name,
        creatorUid: uid,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    const serverHash = extractHashFromMartiResponse(res.data) || hash;
    return {
      ok: true,
      clientUid: uid,
      filename: name,
      packageHash: serverHash,
      computedHash: hash,
      data: res.data,
    };
  } catch (err) {
    throw formatMartiError(err);
  }
}

module.exports = {
  sendMissionPackageToContact,
  scheduleSentPackageCleanup,
  extractHashFromMartiResponse,
  resolveStoredPackageHash,
  SENT_PACKAGE_CLEANUP_DELAY_MS,
};
