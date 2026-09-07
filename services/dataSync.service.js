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

const missionSubCache = new Map();

function extractMissionToken(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.token === "string" && payload.token.trim()) return payload.token.trim();
  const d = payload.data;
  if (d && typeof d === "object") {
    if (!Array.isArray(d) && typeof d.token === "string" && d.token.trim()) return d.token.trim();
    if (Array.isArray(d) && d[0] && typeof d[0].token === "string" && d[0].token.trim()) {
      return d[0].token.trim();
    }
  }
  return "";
}

function extractMissionGuid(payload) {
  if (!payload || typeof payload !== "object") return "";
  let m = payload.data != null ? payload.data : payload;
  if (Array.isArray(m)) m = m[0];
  if (m && m.mission && typeof m.mission === "object") m = m.mission;
  return String((m && (m.guid || m.GUID)) || "").trim();
}

/**
 * Subscribe the portal cert to a mission so content writes can use a mission JWT.
 * TAK often accepts PUT /contents with HTTP 200 but leaves uids empty without this token.
 */
async function ensureMissionSubscription(missionName, clientUid) {
  assertTakAvailable();
  const name = String(missionName || "").trim();
  const uid = String(clientUid || "takportal").trim() || "takportal";
  const cacheKey = `${name}\0${uid}`;
  const cached = missionSubCache.get(cacheKey);
  if (cached && cached.token && Date.now() - cached.at < 30 * 60 * 1000) {
    return { token: cached.token, guid: cached.guid, status: cached.status, cached: true };
  }
  const client = buildTakAxios({ timeout: 30000 });
  const params = { uid };
  let status = null;
  let payload = null;
  try {
    const res = await client.put(`${missionPath(name)}/subscription`, undefined, { params });
    status = res.status;
    payload = res.data;
  } catch (err) {
    const got = await client.get(`${missionPath(name)}/subscription`, {
      params,
      validateStatus: () => true,
    });
    if (got.status >= 200 && got.status < 300) {
      status = got.status;
      payload = got.data;
    } else {
      const e = new Error(
        `Mission subscribe failed: HTTP ${err?.response?.status || got.status}`
      );
      e.status = err?.response?.status || got.status;
      throw e;
    }
  }
  const token = extractMissionToken(payload);
  const guid = extractMissionGuid(payload);
  if (token) missionSubCache.set(cacheKey, { token, guid, status, at: Date.now() });
  return { token, guid, status, cached: false };
}

/**
 * PUT /api/missions/:name/contents — associate uploaded content or CoT UIDs with a mission.
 * queryParams may include creatorUid and uid. extraHeaders may include Authorization Bearer token.
 */
async function putMissionContents(missionName, body, queryParams, extraHeaders) {
  assertTakAvailable();
  const client = buildTakAxios({ timeout: 120000 });
  const res = await client.put(`${missionPath(missionName)}/contents`, body, {
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}),
    },
    params: queryParams && typeof queryParams === "object" ? queryParams : undefined,
  });
  return res.data;
}

async function putMissionContentsByGuid(guid, body, queryParams, extraHeaders) {
  assertTakAvailable();
  const g = String(guid || "").trim();
  if (!g) {
    const e = new Error("Mission GUID is required.");
    e.code = "INVALID_MISSION_GUID";
    throw e;
  }
  const client = buildTakAxios({ timeout: 120000 });
  const res = await client.put(`/api/missions/guid/${encodeURIComponent(g)}/contents`, body, {
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}),
    },
    params: queryParams && typeof queryParams === "object" ? queryParams : undefined,
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

/** Latest CoT for a UID — TAK GET /Marti/api/cot/xml/{uid} */
async function getCotXmlByUid(uid) {
  assertTakAvailable();
  const id = String(uid || "").trim();
  if (!id) {
    const e = new Error("CoT UID is required.");
    e.code = "INVALID_UID";
    throw e;
  }
  const client = buildTakAxios({ timeout: 30000 });
  return client.get(`/api/cot/xml/${encodeURIComponent(id)}`, {
    responseType: "text",
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
  putMissionContentsByGuid,
  ensureMissionSubscription,
  getSyncSearch,
  exportMissionKmlStream,
  exportMissionArchiveStream,
  getCotXmlByUid,
  getMissionCotXml,
  getMissionLayers,
  getSyncContent,
  inviteMissionContact,
  KML_MIME,
};
