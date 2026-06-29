/**
 * Send mission/data packages directly to connected TAK clients (Marti missioncreate).
 */
const { buildTakAxios, getTakBaseUrl, isTakConfigured } = require("./tak.service");
const { getBool } = require("./env");
const dataPackagesSvc = require("./dataPackages.service");

const SENT_PACKAGE_CLEANUP_DELAY_MS = 5000;
const SENT_PACKAGE_CLEANUP_RETRY_MS = 3000;

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

async function deleteSentDataPackage(hash, label) {
  const h = safeStr(hash).trim();
  if (!h) return;

  let result = await dataPackagesSvc.deleteDataPackage(h);
  if (result?.alreadyGone) {
    await sleep(SENT_PACKAGE_CLEANUP_RETRY_MS);
    result = await dataPackagesSvc.deleteDataPackage(h);
  }

  if (result?.alreadyGone) {
    console.warn(
      `[takMissionPackage] Sent package not found for cleanup (${label || h}); it may not have been stored on the server.`
    );
    return;
  }

  console.log(`[takMissionPackage] Cleaned up sent package ${label || h}`);
}

function scheduleSentPackageCleanup({ hash, label, delayMs = SENT_PACKAGE_CLEANUP_DELAY_MS }) {
  const h = safeStr(hash).trim();
  if (!h) return;

  setTimeout(() => {
    deleteSentDataPackage(h, label).catch((err) => {
      console.warn(
        `[takMissionPackage] Package cleanup failed (${label || h}):`,
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
  const client = buildTakOriginAxios({ timeout: 180000 });
  const BlobCtor = global.Blob || require("node:buffer").Blob;
  const form = new FormData();
  const blob = new BlobCtor([buffer], { type: "application/x-zip-compressed" });
  form.append("assetfile", blob, name);
  form.append("filename", name);
  form.append("contacts", uid);

  try {
    const res = await client.post("/Marti/sync/missioncreate", form, {
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    return {
      ok: true,
      clientUid: uid,
      filename: name,
      packageHash: safeStr(packageHash).trim(),
      data: res.data,
    };
  } catch (err) {
    throw formatMartiError(err);
  }
}

module.exports = {
  sendMissionPackageToContact,
  scheduleSentPackageCleanup,
  SENT_PACKAGE_CLEANUP_DELAY_MS,
};
