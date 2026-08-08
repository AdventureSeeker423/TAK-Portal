/**
 * services/dataSync.service.js — TAK Server Marti mission / Data Sync API (mTLS via tak.service buildTakAxios).
 * See: https://docs.opentakserver.io/marti_api.html
 */

const { buildTakAxios, isTakConfigured } = require("./tak.service");
const { getBool } = require("./env");

function assertTakAvailable() {
  if (getBool("TAK_BYPASS_ENABLED", false)) {
    const e = new Error("TAK operations are disabled (TAK_BYPASS_ENABLED=true).");
    e.code = "TAK_BYPASS";
    throw e;
  }
  if (!isTakConfigured()) {
    const e = new Error("TAK_URL is not configured in Server Settings.");
    e.code = "TAK_NOT_CONFIGURED";
    throw e;
  }
}

function missionPath(missionName) {
  const n = String(missionName || "").trim();
  if (!n) {
    const e = new Error("Mission name is required.");
    e.code = "INVALID_MISSION_NAME";
    throw e;
  }
  return `/api/missions/${encodeURIComponent(n)}`;
}

/**
 * List all missions — TAK GET /Marti/api/missions (full list; same shape as legacy pagedmissions).
 * Always request passwordProtected + defaultRole: without them TAK omits password-protected
 * missions and any whose defaultRole isn't plain MISSION_SUBSCRIBER (e.g. read-only subscriber).
 * Callers may still override via params.
 */
async function listMissions(params) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 60000 });
  const res = await client.get("/api/missions", {
    params: { passwordProtected: true, defaultRole: true, ...(params || {}) },
  });
  return res.data;
}

async function getMission(missionName) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 60000 });
  const res = await client.get(missionPath(missionName));
  return res.data;
}

async function missionExists(missionName) {
  try {
    await getMission(missionName);
    return true;
  } catch (err) {
    const status = err?.response?.status;
    if (status === 404) return false;
    // Treat other errors as "unknown / not found" for idempotent ensure flows.
    return false;
  }
}

async function putMission(missionName, body) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 60000 });
  const res = await client.put(missionPath(missionName), body, {
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  });
  return res.data;
}

async function postMission(missionName, body) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 60000 });
  const res = await client.post(missionPath(missionName), body, {
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  });
  return res.data;
}

/** Prefer POST for mission changes; some TAK builds only allow PUT (405). */
async function changeMission(missionName, body) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 60000 });
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  try {
    const res = await client.post(missionPath(missionName), body, { headers });
    return res.data;
  } catch (postErr) {
    const st = postErr?.response?.status;
    if (st === 405 || st === 501) {
      const res = await client.put(missionPath(missionName), body, { headers });
      return res.data;
    }
    throw postErr;
  }
}

async function deleteMission(missionName) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 60000 });
  const res = await client.delete(missionPath(missionName), {
    validateStatus: (s) => (s >= 200 && s < 300) || s === 404,
  });
  if (res.status === 404) {
    return { ok: true, alreadyGone: true };
  }
  return res.data;
}

async function setMissionPassword(missionName, password) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 30000 });
  const res = await client.put(`${missionPath(missionName)}/password`, String(password ?? ""), {
    headers: { "Content-Type": "text/plain; charset=utf-8", Accept: "application/json" },
  });
  return res.data;
}

async function clearMissionPassword(missionName) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 30000 });
  const res = await client.delete(`${missionPath(missionName)}/password`);
  return res.data;
}

async function listGroupsAll() {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 60000 });
  const res = await client.get("/api/groups/all");
  return res.data;
}

async function putMissionKeywords(missionName, keywordsPayload) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 30000 });
  const res = await client.put(`${missionPath(missionName)}/keywords`, keywordsPayload, {
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  });
  return res.data;
}

/**
 * PUT /api/missions/:name/contents — associate uploaded content with a mission.
 */
async function putMissionContents(missionName, body) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 120000 });
  const res = await client.put(`${missionPath(missionName)}/contents`, body, {
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  });
  return res.data;
}

async function getSyncSearch(params) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 60000 });
  const res = await client.get("/sync/search", { params: params || {} });
  return res.data;
}

const KML_MIME = "application/vnd.google-earth.kml+xml";

/**
 * Full mission / data sync package as KML — TAK Marti:
 * GET /Marti/api/missions/{missionName}/kml?download=true
 * (Optional query params e.g. password for protected missions are merged from queryParams.)
 */
async function exportMissionKmlStream(missionName, queryParams = {}) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 180000 });
  const name = String(missionName || "").trim();
  if (!name) {
    const e = new Error("Mission name is required.");
    e.code = "INVALID_MISSION_NAME";
    throw e;
  }
  const params = { ...queryParams, download: "true" };
  return client.get(`${missionPath(name)}/kml`, {
    params,
    responseType: "stream",
    validateStatus: () => true,
  });
}

/**
 * Mission HTML archive (open in browser) — TAK Marti GET /api/missions/{name}/archive
 */
async function exportMissionArchiveStream(missionName, queryParams = {}) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 180000 });
  const name = String(missionName || "").trim();
  if (!name) {
    const e = new Error("Mission name is required.");
    e.code = "INVALID_MISSION_NAME";
    throw e;
  }
  return client.get(`${missionPath(name)}/archive`, {
    params: queryParams || {},
    responseType: "stream",
    validateStatus: () => true,
  });
}

/** Mission CoT items as XML — TAK GET /Marti/api/missions/{name}/cot */
async function getMissionCotXml(missionName, queryParams = {}) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 180000 });
  const name = String(missionName || "").trim();
  if (!name) {
    const e = new Error("Mission name is required.");
    e.code = "INVALID_MISSION_NAME";
    throw e;
  }
  const res = await client.get(`${missionPath(name)}/cot`, {
    params: queryParams || {},
    responseType: "text",
    validateStatus: () => true,
  });
  return res;
}

/** Mission layer tree — TAK GET /Marti/api/missions/{name}/layer */
async function getMissionLayers(missionName, queryParams = {}) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 60000 });
  const name = String(missionName || "").trim();
  if (!name) {
    const e = new Error("Mission name is required.");
    e.code = "INVALID_MISSION_NAME";
    throw e;
  }
  const res = await client.get(`${missionPath(name)}/layer`, {
    params: queryParams || {},
    validateStatus: () => true,
  });
  return res;
}

/** Invite a connected client to a mission — POST /Marti/api/missions/{name}/invite */
async function inviteMissionContact(missionName, clientUid) {
  assertTakAvailable();
  const uid = String(clientUid || "").trim();
  if (!uid) {
    const e = new Error("Client UID is required.");
    e.code = "INVALID_CLIENT_UID";
    throw e;
  }
  const client = buildTakAxios({ timeout: 60000 });
  const form = new FormData();
  form.append("contacts", uid);
  const res = await client.post(`${missionPath(missionName)}/invite`, form, {
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  return res.data;
}

/** Enterprise sync file by hash — GET /Marti/sync/content */
async function getSyncContent(hash, queryParams = {}) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 180000 });
  const h = String(hash || "").trim();
  if (!h) {
    const e = new Error("Content hash is required.");
    e.code = "INVALID_HASH";
    throw e;
  }
  return client.get("/sync/content", {
    params: { hash: h, ...(queryParams || {}) },
    responseType: "arraybuffer",
    validateStatus: () => true,
  });
}

module.exports = {
  assertTakAvailable,
  missionPath,
  listMissions,
  /** @deprecated use listMissions */
  listPagedMissions: listMissions,
  getMission,
  missionExists,
  putMission,
  postMission,
  changeMission,
  deleteMission,
  setMissionPassword,
  clearMissionPassword,
  listGroupsAll,
  putMissionKeywords,
  putMissionContents,
  getSyncSearch,
  exportMissionKmlStream,
  exportMissionArchiveStream,
  getMissionCotXml,
  getMissionLayers,
  getSyncContent,
  inviteMissionContact,
  KML_MIME,
};
