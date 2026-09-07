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

let nodeCotPromise = null;

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

  if (destGroup) {
    detail.filtergroup = { _attributes: { group: destGroup } };
    detail.marti = { dest: [{ _attributes: { group: destGroup } }] };
  } else if (destMission) {
    detail.marti = { dest: [{ _attributes: { mission: destMission } }] };
  }

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

async function toCot(js, dest) {
  const mod = await loadNodeCot();
  const CoT = mod.default || mod.CoT;
  if (!CoT) throw new Error("node-cot CoT constructor unavailable");
  const cot = new CoT(js);
  if (dest && typeof cot.addDest === "function") {
    try {
      cot.addDest(dest);
    } catch (_) {
      /* marti dest already stamped on the JS tree */
    }
  }
  return cot;
}

async function writeEvent(js, dest) {
  try {
    const cot = await toCot(js, dest);
    const ok = await cotStream.writeCot(cot, { stripFlow: true });
    return !!ok;
  } catch (err) {
    console.error("[locator cot] write failed:", err?.message || err);
    return false;
  }
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
  await writeEvent(liveJs, destGroup ? { group: destGroup } : null);

  const mission = String(locator.mission || "").trim();
  if (mission && locator.dropPoints) {
    const dropJs = buildEventJs({
      uid: dropTrackUid(locator.id, now),
      type: DROP_TYPE,
      lat: latitude,
      lon: longitude,
      ce: accuracyMeters,
      callsign,
      color,
      remarks,
      destMission: mission,
      now,
      staleDate: new Date(now.getTime() + 365 * 24 * 3600 * 1000),
    });
    await writeEvent(dropJs, { mission });
  }
}

async function publishDelete(locator) {
  if (!locator || !locator.id) return false;
  const destGroup = toMartiGroupName(locator.channelDisplay || locator.channel);
  const js = buildDeleteEventJs({
    uid: liveTrackUid(locator.id),
    destGroup,
    now: new Date(),
  });
  return writeEvent(js, destGroup ? { group: destGroup } : null);
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
};
