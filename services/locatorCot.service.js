/**
 * Publish live locator CoT on the portal TLS stream (EUD-style SA + optional mission drops).
 */

const cotStream = require("./cotStream.service");
const groupsSvc = require("./groups.service");
const locatorForm = require("./locatorForm.service");

const LIVE_TYPE = "a-f-G-U-C";
const DROP_TYPE = "b-m-p-s-m";
const DELETE_TYPE = "t-x-d-d";
const TEAM_ROLE = "Team Member";
const DROP_TRACE_CAP = 25;

let nodeCotPromise = null;
const dropTraces = [];

function loadNodeCot() {
  if (!nodeCotPromise) nodeCotPromise = import("@tak-ps/node-cot");
  return nodeCotPromise;
}

function liveTrackUid(locatorId) {
  return `takportal.locator.${String(locatorId || "").trim()}`;
}

function dropTrackUid(locatorId, at) {
  const stamp = String(at || new Date().toISOString()).replace(/[^0-9]/g, "").slice(0, 17);
  return `takportal.locator.${String(locatorId || "").trim()}.drop.${stamp}`;
}

function toMartiGroupName(name) {
  return groupsSvc.stripTakPrefix(String(name || "").trim());
}

function staleAfterMs(pingIntervalSeconds) {
  const ping = Number(pingIntervalSeconds);
  if (ping === 0) return 120000;
  if (!Number.isFinite(ping) || ping < 0) return 45000;
  return Math.max(45000, ping * 3 * 1000);
}

function iso(d) {
  return (d instanceof Date ? d : new Date(d)).toISOString();
}

function buildEventJs({
  uid,
  type,
  lat,
  lon,
  ce,
  callsign,
  color,
  remarks,
  destGroup,
  destMission,
  archive,
  now,
  staleDate,
  how,
}) {
  const t = iso(now);
  const stale = iso(staleDate);
  const detail = {
    contact: { _attributes: { callsign: String(callsign || "").trim() || "LOCATOR" } },
    __group: { _attributes: { name: locatorForm.normalizeColor(color), role: TEAM_ROLE } },
  };
  const note = String(remarks || "").trim();
  if (note) detail.remarks = { _text: note };
  if (archive) detail.archive = {};

  const dests = [];
  if (destMission) {
    dests.push({ _attributes: { mission: destMission } });
  }
  if (destGroup) {
    detail.filtergroup = { _attributes: { group: destGroup } };
    dests.push({ _attributes: { group: destGroup } });
  }
  if (dests.length) detail.marti = { dest: dests };

  const ceVal =
    ce != null && Number.isFinite(Number(ce)) && Number(ce) >= 0
      ? String(Number(ce))
      : "9999999.0";

  return {
    event: {
      _attributes: {
        version: "2.0",
        uid,
        type,
        time: t,
        start: t,
        stale,
        how: how || "m-g",
      },
      point: {
        _attributes: {
          lat: String(lat),
          lon: String(lon),
          hae: "9999999.0",
          ce: ceVal,
          le: "9999999.0",
        },
      },
      detail,
    },
  };
}

function buildDeleteEventJs({ uid, destGroup, now }) {
  const t = iso(now);
  const stale = iso(new Date((now instanceof Date ? now : new Date(now)).getTime() + 20000));
  const detail = {
    link: { _attributes: { uid, type: LIVE_TYPE, relation: "p-p" } },
  };
  if (destGroup) {
    detail.filtergroup = { _attributes: { group: destGroup } };
    detail.marti = { dest: [{ _attributes: { group: destGroup } }] };
  }
  return {
    event: {
      _attributes: {
        version: "2.0",
        uid,
        type: DELETE_TYPE,
        time: t,
        start: t,
        stale,
        how: "t-p",
      },
      point: {
        _attributes: {
          lat: "0.0",
          lon: "0.0",
          hae: "0.0",
          ce: "9999999.0",
          le: "9999999.0",
        },
      },
      detail,
    },
  };
}

function clip(value, max) {
  const n = max || 4000;
  if (value == null) return "";
  const s = typeof value === "string" ? value : safeJson(value);
  return s.length > n ? s.slice(0, n) + `…[+${s.length - n} chars]` : s;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function axiosBody(data) {
  if (data == null) return "";
  if (Buffer.isBuffer(data)) return clip(data.toString("utf8"), 2500);
  if (typeof data === "string") return clip(data, 2500);
  return clip(safeJson(data), 2500);
}

function rememberDropTrace(trace) {
  dropTraces.unshift(trace);
  if (dropTraces.length > DROP_TRACE_CAP) dropTraces.length = DROP_TRACE_CAP;
  const lastAttempt =
    trace.bind && Array.isArray(trace.bind.attempts) && trace.bind.attempts.length
      ? trace.bind.attempts[trace.bind.attempts.length - 1]
      : null;
  const summary = {
    at: trace.at,
    skipReason: trace.skipReason || null,
    locatorId: trace.locatorId,
    title: trace.title,
    mission: trace.mission,
    dropPoints: trace.dropPoints,
    bridgeConnected: trace.bridgeConnected,
    written: trace.write && trace.write.written,
    bindOk: trace.bind && trace.bind.ok,
    lastBindStatus: lastAttempt ? lastAttempt.status : null,
    lastBindBody: lastAttempt ? lastAttempt.body : null,
    cotXmlStatus: trace.probe && trace.probe.cotXmlStatus,
    missionHasUid: trace.probe && trace.probe.missionHasUid,
    missionCotHasUid: trace.probe && trace.probe.missionCotHasUid,
  };
  console.info("[locator-drop]", safeJson(summary));
  console.info("[locator-drop:json]", safeJson(trace));
}

function getDropDebug() {
  return {
    at: new Date().toISOString(),
    bridgeConnected: cotStream.isBridgeConnected(),
    traces: dropTraces.slice(),
  };
}

function destList(dest) {
  if (!dest) return [];
  return Array.isArray(dest) ? dest.filter(Boolean) : [dest];
}

function extractCotXml(cot) {
  if (!cot) return "";
  const methods = ["to_xml", "toXML", "toXml", "xml"];
  for (const name of methods) {
    if (typeof cot[name] === "function") {
      try {
        const xml = cot[name]();
        if (xml) return String(xml);
      } catch (_) {}
    }
  }
  if (cot.raw) return safeJson(cot.raw);
  return "";
}

async function toCot(js, dest, { archive = false } = {}) {
  const mod = await loadNodeCot();
  const CoT = mod.default || mod.CoT;
  if (!CoT) throw new Error("node-cot CoT constructor unavailable");
  const cot = new CoT(js);
  if (typeof cot.addDest === "function") {
    for (const d of destList(dest)) {
      try {
        cot.addDest(d);
      } catch (_) {
        /* marti dest already stamped on the JS tree */
      }
    }
  }
  if (archive && typeof cot.archived === "function") {
    try {
      cot.archived(true);
    } catch (_) {}
  }
  return cot;
}

async function writeEvent(js, dest, { ingest = false, archive = false } = {}) {
  const result = {
    bridgeConnected: cotStream.isBridgeConnected(),
    written: false,
    xml: "",
    error: null,
    dests: destList(dest),
  };
  try {
    const cot = await toCot(js, dest, { archive });
    result.xml = clip(extractCotXml(cot), 5000);
    result.uid =
      (typeof cot.uid === "function" && cot.uid()) ||
      (cot.raw && cot.raw.event && cot.raw.event._attributes && cot.raw.event._attributes.uid) ||
      (js && js.event && js.event._attributes && js.event._attributes.uid) ||
      "";
    result.archived =
      typeof cot.archived === "function" ? cot.archived() : !!(js && js.event && js.event.detail && js.event.detail.archive);
    const written = await cotStream.writeCot(cot, { stripFlow: true });
    result.written = !!written;
    if (ingest) {
      cotStream.ingestCot(cot);
    }
  } catch (err) {
    result.error = err?.message || String(err);
    console.error("[locator cot] write failed:", result.error);
    if (ingest) {
      try {
        const cot = await toCot(js, dest, { archive });
        cotStream.ingestCot(cot);
      } catch (_) {}
    }
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unwrapMission(payload) {
  if (!payload) return null;
  if (payload.data != null) {
    if (Array.isArray(payload.data) && payload.data.length) return payload.data[0];
    if (typeof payload.data === "object" && !Array.isArray(payload.data)) return payload.data;
  }
  return payload;
}

function collectMissionUids(payload) {
  const m = unwrapMission(payload) || {};
  const raw = m.uids || m.Uids || [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of arr) {
    if (item == null) continue;
    if (typeof item === "string" || typeof item === "number") {
      const id = String(item).trim();
      if (id) out.push(id);
      continue;
    }
    const id = String(item.uid || item.data || item.UID || item.name || "").trim();
    if (id) out.push(id);
  }
  return out;
}

async function bindUidToMission(missionName, uid, creatorUid) {
  const dataSyncSvc = require("./dataSync.service");
  const delays = [250, 700, 1500];
  const attempts = [];
  for (let i = 0; i < delays.length; i++) {
    await sleep(delays[i]);
    const attempt = { n: i + 1, delayMs: delays[i], ok: false, status: null, body: "" };
    try {
      const data = await dataSyncSvc.putMissionContents(
        missionName,
        { uids: [uid] },
        { creatorUid: String(creatorUid || uid) }
      );
      attempt.ok = true;
      attempt.status = 200;
      attempt.body = axiosBody(data);
      attempts.push(attempt);
      return { ok: true, attempts };
    } catch (err) {
      attempt.status = err?.response?.status || err?.status || null;
      attempt.body = axiosBody(err?.response?.data) || err?.message || String(err);
      attempts.push(attempt);
    }
  }
  return { ok: false, attempts };
}

async function probeTakForDrop(missionName, uid) {
  const dataSyncSvc = require("./dataSync.service");
  const probe = {};
  try {
    const cotRes = await dataSyncSvc.getCotXmlByUid(uid);
    probe.cotXmlStatus = cotRes.status;
    probe.cotXml = clip(cotRes.data, 2500);
  } catch (err) {
    probe.cotXmlError = err?.message || String(err);
  }
  try {
    const payload = await dataSyncSvc.getMission(missionName);
    const uids = collectMissionUids(payload);
    const mission = unwrapMission(payload) || {};
    probe.missionName = mission.name || missionName;
    probe.missionGuid = mission.guid || mission.GUID || "";
    probe.missionUidCount = uids.length;
    probe.missionHasUid = uids.includes(uid);
    probe.missionUidSample = uids.slice(0, 25);
  } catch (err) {
    probe.missionError = err?.message || String(err);
    probe.missionStatus = err?.response?.status || err?.status || null;
    probe.missionBody = axiosBody(err?.response?.data);
  }
  try {
    const cotMission = await dataSyncSvc.getMissionCotXml(missionName);
    const text =
      typeof cotMission.data === "string" ? cotMission.data : axiosBody(cotMission.data);
    probe.missionCotStatus = cotMission.status;
    probe.missionCotLen = text.length;
    probe.missionCotHasUid = text.includes(uid);
    probe.missionCotSnippet = clip(text, 1500);
  } catch (err) {
    probe.missionCotError = err?.message || String(err);
  }
  return probe;
}

async function publishPing(locator, { latitude, longitude, accuracyMeters, callsign, remarks, at }) {
  const now = at instanceof Date ? at : new Date(at || Date.now());
  const staleDate = new Date(now.getTime() + staleAfterMs(locator.pingIntervalSeconds));
  const destGroup = toMartiGroupName(locator.channelDisplay || locator.channel);
  const color = locatorForm.normalizeColor(locator.color);
  const liveJs = buildEventJs({
    uid: liveTrackUid(locator.id),
    type: LIVE_TYPE,
    lat: latitude,
    lon: longitude,
    ce: accuracyMeters,
    callsign,
    color,
    remarks,
    destGroup,
    now,
    staleDate,
  });
  const liveWrite = await writeEvent(liveJs, destGroup ? { group: destGroup } : null, { ingest: true });

  const mission = String(locator.mission || "").trim();
  const dropEnabled = !!locator.dropPoints;
  const trace = {
    at: now.toISOString(),
    locatorId: locator.id,
    slug: locator.slug,
    title: locator.title,
    channel: locator.channel,
    channelDisplay: locator.channelDisplay,
    destGroup,
    mission: mission || "",
    dropPoints: locator.dropPoints,
    dropPointsType: typeof locator.dropPoints,
    ping: { latitude, longitude, accuracyMeters, callsign },
    bridgeConnected: cotStream.isBridgeConnected(),
    liveWritten: !!liveWrite.written,
    liveWriteError: liveWrite.error || null,
  };

  if (!mission || !dropEnabled) {
    trace.skipReason = !mission ? "no-mission" : "drop-points-off";
    rememberDropTrace(trace);
    return;
  }

  const dropUid = dropTrackUid(locator.id, now);
  const dropDest = [{ mission }];
  if (destGroup) dropDest.push({ group: destGroup });
  const dropJs = buildEventJs({
    uid: dropUid,
    type: DROP_TYPE,
    lat: latitude,
    lon: longitude,
    ce: accuracyMeters,
    callsign,
    color,
    remarks,
    destGroup,
    destMission: mission,
    archive: true,
    now,
    staleDate: new Date(now.getTime() + 365 * 24 * 3600 * 1000),
  });
  trace.dropUid = dropUid;
  trace.dropJsDest = dropJs.event?.detail?.marti || null;
  trace.dropJsArchive = !!dropJs.event?.detail?.archive;
  const written = await writeEvent(dropJs, dropDest, { archive: true });
  trace.write = written;
  if (!written.written) {
    trace.skipReason = "cot-write-failed";
    rememberDropTrace(trace);
    return;
  }
  trace.bind = await bindUidToMission(mission, dropUid, liveTrackUid(locator.id));
  trace.probe = await probeTakForDrop(mission, dropUid);
  rememberDropTrace(trace);
}

async function publishDelete(locator) {
  if (!locator || !locator.id) return false;
  const destGroup = toMartiGroupName(locator.channelDisplay || locator.channel);
  const js = buildDeleteEventJs({
    uid: liveTrackUid(locator.id),
    destGroup,
    now: new Date(),
  });
  const result = await writeEvent(js, destGroup ? { group: destGroup } : null, { ingest: true });
  return !!result.written;
}

module.exports = {
  LIVE_TYPE,
  DROP_TYPE,
  DELETE_TYPE,
  liveTrackUid,
  dropTrackUid,
  toMartiGroupName,
  staleAfterMs,
  buildEventJs,
  buildDeleteEventJs,
  publishPing,
  publishDelete,
  getDropDebug,
};
