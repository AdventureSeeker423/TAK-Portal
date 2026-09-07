/**
 * Persisted locators (missing-person share links) and ping history.
 * Storage: Postgres (pgCache).
 */

const crypto = require("crypto");
const { getString } = require("./env");
const settingsSvc = require("./settings.service");
const { buildTakAxios } = require("./tak.service");
const pgCache = require("./pgCache");
const locatorForm = require("./locatorForm.service");

const FILE = null;
const HISTORY_CAP_PER_LOCATOR = 5000;

function defaultStore() {
  return { locators: [], history: [] };
}

function load() {
  const data = pgCache.caches.locators || defaultStore();
  if (!data || typeof data !== "object") return defaultStore();
  if (!Array.isArray(data.locators)) data.locators = [];
  if (!Array.isArray(data.history)) data.history = [];
  return data;
}

function save(data) {
  const next = data && typeof data === "object" ? data : defaultStore();
  if (!Array.isArray(next.locators)) next.locators = [];
  if (!Array.isArray(next.history)) next.history = [];
  const counts = new Map();
  const trimmed = [];
  for (let i = next.history.length - 1; i >= 0; i--) {
    const h = next.history[i];
    const lid = String(h?.locatorId || "");
    const n = counts.get(lid) || 0;
    if (n >= HISTORY_CAP_PER_LOCATOR) continue;
    counts.set(lid, n + 1);
    trimmed.push(h);
  }
  next.history = trimmed.reverse();
  pgCache.replaceLocators(next);
}

function titleToSlug(title) {
  const s = String(title || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return s || "locator";
}

/**
 * Base URL for locate pings (no trailing slash, no query string).
 * Derived from TAK_URL: hostname + scheme, ignoring the Marti path. Port 8443 is
 * dropped so the relay matches the built-in locate tab (HTTPS on default 443), e.g.
 *   https://tak.example.com:8443/Marti → https://tak.example.com/locate/api
 */
function getTakLocateApiBase() {
  const raw = String(settingsSvc.getSettings()?.TAK_URL || getString("TAK_URL", "") || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    const proto = u.protocol === "http:" || u.protocol === "https:" ? u.protocol : "https:";
    const hostname = u.hostname;
    if (!hostname) return "";

    const p = String(u.port || "");
    const useDefaultPort =
      !p || p === "8443" || p === "443" || (proto === "https:" && !u.port);
    const hostPart = useDefaultPort ? hostname : `${hostname}:${p}`;

    return `${proto}//${hostPart}/locate/api`;
  } catch {
    return "";
  }
}

/**
 * Display name sent to TAK locate API: "Last, First M/D/YY HH:MM:SS" (local time).
 */
function formatLocatePingNameForTak(firstName, lastName) {
  const last = String(lastName || "").trim();
  const first = String(firstName || "").trim();
  const label = last && first ? `${last}, ${first}` : last || first || "Unknown";
  const d = new Date();
  // Hyphens avoid "/" in query values (some TAK builds mishandle slashes in the name param).
  const md = `${d.getMonth() + 1}-${d.getDate()}-${String(d.getFullYear()).slice(-2)}`;
  const hm = d.toTimeString().slice(0, 8);
  return `${label} ${md} ${hm}`;
}

function summarizeTakResponseBody(data) {
  if (data == null || data === "") return "";
  if (typeof data === "string") return data.trim().slice(0, 500);
  try {
    return JSON.stringify(data).slice(0, 500);
  } catch {
    return "";
  }
}

function getBySlug(slug) {
  const s = String(slug || "").trim().toLowerCase();
  return load().locators.find((l) => l.slug === s) || null;
}

function getById(id) {
  return load().locators.find((l) => l.id === id) || null;
}

function isLiveLocator(l) {
  return !!(l && String(l.kind || "").trim().toLowerCase() === "live");
}

function locatorKind(l) {
  return isLiveLocator(l) ? "live" : "legacy";
}

/**
 * 0 = one-time location send (no repeating pings; manual / remote wake still work).
 * Otherwise clamp to 10–86400 seconds.
 */
function normalizePingIntervalSeconds(raw, fallback = 60) {
  const n = Number(raw);
  if (n === 0) return 0;
  if (!Number.isFinite(n)) {
    const fb = Number(fallback);
    return Number.isFinite(fb) ? fb : 60;
  }
  return Math.max(10, Math.min(86400, n));
}

/**
 * Public poll payload so share pages can pick up interval edits and admin "manual ping" wake-ups without reload.
 */
function getClientConfigForPublicSlug(slug) {
  const l = getBySlug(slug);
  if (!l || l.archived) return null;
  const ping = normalizePingIntervalSeconds(
    l.pingIntervalSeconds,
    isLiveLocator(l) ? 15 : 60
  );
  const cfg = {
    ok: true,
    kind: locatorKind(l),
    pingIntervalSeconds: ping,
    active: !!l.active,
    intervalEpoch: Number(l.intervalEpoch) || 1,
    remotePingEpoch: Number(l.remotePingEpoch) || 1,
  };
  if (isLiveLocator(l)) {
    const form = locatorForm.normalizeForm(l.form);
    cfg.form = {
      heading: form.heading,
      intro: form.intro,
      fields: form.fields.map((f) => ({
        id: f.id,
        type: f.type,
        label: f.label,
        required: !!f.required,
        options: f.type === "choice" ? f.options.slice() : undefined,
      })),
    };
  }
  return cfg;
}

function bumpRemotePingEpoch(locatorId) {
  const data = load();
  const li = data.locators.findIndex((l) => l.id === locatorId);
  if (li < 0) throw new Error("Locator not found.");
  data.locators[li].remotePingEpoch = (Number(data.locators[li].remotePingEpoch) || 0) + 1;
  data.locators[li].updatedAt = new Date().toISOString();
  save(data);
}

function listLocatorsForAdmin({ kind } = {}) {
  const data = load();
  let locators = data.locators.slice();
  if (kind === "live") locators = locators.filter(isLiveLocator);
  else if (kind === "legacy") locators = locators.filter((l) => !isLiveLocator(l));
  locators.sort((a, b) => {
    const ua = String(a.updatedAt || a.createdAt || "");
    const ub = String(b.updatedAt || b.createdAt || "");
    return ub.localeCompare(ua);
  });
  return locators.map((l) => {
    const pings = data.history.filter((h) => h.locatorId === l.id);
    const sorted = pings.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const last = sorted[0];
    const lastWithCoords = sorted.find(
      (h) =>
        h.latitude != null &&
        h.longitude != null &&
        Number.isFinite(Number(h.latitude)) &&
        Number.isFinite(Number(h.longitude))
    );
    return {
      ...l,
      lastPingAt: last ? last.at : null,
      lastCoordsAt: lastWithCoords ? lastWithCoords.at : null,
      lastLatitude: lastWithCoords != null ? Number(lastWithCoords.latitude) : null,
      lastLongitude: lastWithCoords != null ? Number(lastWithCoords.longitude) : null,
      lastAccuracyMeters:
        lastWithCoords != null && lastWithCoords.accuracyMeters != null
          ? Number(lastWithCoords.accuracyMeters)
          : null,
      hasPositionPing: !!lastWithCoords,
    };
  });
}

function create({ title, pingIntervalSeconds }) {
  let titleStr = String(title || "").trim();
  if (!titleStr) titleStr = "Missing Person";
  const ping = normalizePingIntervalSeconds(pingIntervalSeconds);
  const data = load();
  const slug = allocateSlug(titleStr, data);
  const now = new Date().toISOString();
  const loc = {
    id: crypto.randomUUID(),
    slug,
    title: titleStr,
    kind: "legacy",
    pingIntervalSeconds: ping,
    intervalEpoch: 1,
    remotePingEpoch: 1,
    active: true,
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
  data.locators.push(loc);
  save(data);
  return loc;
}

function allocateSlug(titleStr, data) {
  let slug = titleToSlug(titleStr);
  let n = 0;
  while (data.locators.some((l) => l.slug === slug)) {
    n += 1;
    slug = `${titleToSlug(titleStr)}-${n}`;
  }
  return slug;
}

function createLive({
  title,
  pingIntervalSeconds,
  channel,
  channelDisplay,
  mission,
  dropPoints,
  color,
  form,
  agencyScope,
}) {
  let titleStr = String(title || "").trim();
  if (!titleStr) titleStr = "Missing Person";
  const ping = normalizePingIntervalSeconds(pingIntervalSeconds, 15);
  const channelName = String(channel || "").trim();
  if (!channelName) throw new Error("Channel is required.");
  const missionName = String(mission || "").trim();
  const drop = !!dropPoints && !!missionName;
  const colorName = locatorForm.normalizeColor(color);
  const formNorm = locatorForm.normalizeForm(form);

  const data = load();
  const slug = allocateSlug(titleStr, data);
  const now = new Date().toISOString();
  const loc = {
    id: crypto.randomUUID(),
    slug,
    title: titleStr,
    kind: "live",
    pingIntervalSeconds: ping,
    intervalEpoch: 1,
    remotePingEpoch: 1,
    active: true,
    archived: false,
    channel: channelName,
    channelDisplay: String(channelDisplay || "").trim() || channelName,
    mission: missionName,
    dropPoints: drop,
    color: colorName,
    form: formNorm,
    agencyScope: Array.isArray(agencyScope)
      ? agencyScope.map((s) => String(s || "").trim()).filter(Boolean)
      : null,
    createdAt: now,
    updatedAt: now,
  };
  data.locators.push(loc);
  save(data);
  return loc;
}

function update(id, patch) {
  const data = load();
  const idx = data.locators.findIndex((l) => l.id === id);
  if (idx < 0) throw new Error("Locator not found.");
  const l = { ...data.locators[idx] };

  if (patch.title !== undefined) {
    const t = String(patch.title || "").trim();
    if (t) l.title = t;
  }
  if (patch.pingIntervalSeconds !== undefined) {
    const next = normalizePingIntervalSeconds(
      patch.pingIntervalSeconds,
      isLiveLocator(l) ? 15 : 60
    );
    if (next !== l.pingIntervalSeconds) {
      l.pingIntervalSeconds = next;
      l.intervalEpoch = (Number(l.intervalEpoch) || 0) + 1;
    }
  }
  if (patch.active !== undefined) l.active = !!patch.active;

  if (isLiveLocator(l)) {
    if (patch.color !== undefined) l.color = locatorForm.normalizeColor(patch.color);
    if (patch.form !== undefined) l.form = locatorForm.normalizeForm(patch.form);
    if (patch.channel !== undefined) {
      const channelName = String(patch.channel || "").trim();
      if (!channelName) throw new Error("Channel is required.");
      l.channel = channelName;
      l.channelDisplay =
        String(patch.channelDisplay || "").trim() || channelName;
    }
    if (patch.mission !== undefined) {
      l.mission = String(patch.mission || "").trim();
    }
    if (patch.dropPoints !== undefined || patch.mission !== undefined) {
      const drop =
        patch.dropPoints !== undefined ? !!patch.dropPoints : !!l.dropPoints;
      l.dropPoints = drop && !!String(l.mission || "").trim();
    }
  }

  l.updatedAt = new Date().toISOString();
  data.locators[idx] = l;
  save(data);
  return l;
}

function archive(id) {
  const data = load();
  const idx = data.locators.findIndex((l) => l.id === id);
  if (idx < 0) throw new Error("Locator not found.");
  data.locators[idx].archived = true;
  data.locators[idx].active = false;
  data.locators[idx].updatedAt = new Date().toISOString();
  save(data);
  return data.locators[idx];
}

function reactivate(id) {
  const data = load();
  const idx = data.locators.findIndex((l) => l.id === id);
  if (idx < 0) throw new Error("Locator not found.");
  if (!data.locators[idx].archived) throw new Error("Locator is not archived.");
  data.locators[idx].archived = false;
  data.locators[idx].active = true;
  data.locators[idx].updatedAt = new Date().toISOString();
  save(data);
  return data.locators[idx];
}

/** Remove locator and all of its ping history (cannot be undone). */
function permanentDelete(id) {
  const data = load();
  const idx = data.locators.findIndex((l) => l.id === id);
  if (idx < 0) throw new Error("Locator not found.");
  const locId = data.locators[idx].id;
  data.locators.splice(idx, 1);
  data.history = data.history.filter((h) => h.locatorId !== locId);
  save(data);
}

function addHistoryEntry({
  locatorId,
  latitude,
  longitude,
  name,
  remarks,
  kind,
  accuracyMeters,
  answers,
  callsign,
}) {
  const data = load();
  const acc =
    accuracyMeters != null && Number.isFinite(Number(accuracyMeters))
      ? Number(accuracyMeters)
      : null;
  const entry = {
    id: crypto.randomUUID(),
    locatorId,
    at: new Date().toISOString(),
    latitude: latitude == null ? null : Number(latitude),
    longitude: longitude == null ? null : Number(longitude),
    accuracyMeters: acc,
    name: String(name || callsign || "").trim(),
    remarks: String(remarks || "").trim(),
    kind: kind === "manual" ? "manual" : "interval",
  };
  if (answers && typeof answers === "object") {
    entry.answers = answers;
  }
  if (callsign) entry.callsign = String(callsign).trim();
  data.history.push(entry);

  const li = data.locators.findIndex((l) => l.id === locatorId);
  if (li >= 0) {
    data.locators[li].updatedAt = entry.at;
    if (kind !== "manual") {
      data.locators[li].sharingStoppedByUser = false;
    }
  }

  const forLoc = data.history.filter((h) => h.locatorId === locatorId);
  if (forLoc.length > 5000) {
    const sorted = forLoc.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const drop = sorted.slice(0, forLoc.length - 5000).map((h) => h.id);
    data.history = data.history.filter((h) => !drop.includes(h.id));
  }
  save(data);
  return entry;
}

function listHistory(locatorId, { limit = 200 } = {}) {
  const data = load();
  const rows = data.history.filter((h) => h.locatorId === locatorId);
  const newestFirst = rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const recent = newestFirst.slice(0, limit);
  return recent.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** Wake devices only; no history row (admin dashboard "Manual ping"). */
function addManualOperatorPing(locatorId) {
  bumpRemotePingEpoch(locatorId);
}

/** Public page "Stop sharing" — admin status pill shows until the next position ping. */
function setSharingStoppedByUser(locatorId, stopped) {
  const data = load();
  const idx = data.locators.findIndex((l) => l.id === locatorId);
  if (idx < 0) throw new Error("Locator not found.");
  data.locators[idx].sharingStoppedByUser = !!stopped;
  data.locators[idx].updatedAt = new Date().toISOString();
  save(data);
  return data.locators[idx];
}

/**
 * TAK locate API takes name/remarks as query parameters; some TAK builds error on punctuation/quotes.
 * Portal history keeps the original text; relay-only normalization keeps the TAK forward reliable.
 */
function sanitizeForTakLocateQueryParam(s) {
  let t = String(s ?? "");
  t = t.replace(/[!?]+/g, ".").replace(/;/g, ".");
  t = t.replace(
    /[\u0027\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F\u2032\u2033\u2035\u2036\u2037\u0060\u00AB\u00BB\u0022\uFF02\u00B4\u02BC\u02C8\u02CA\u02CB\u02F4\u02F9]/g,
    ""
  );
  t = t.replace(/[^\p{L}\p{N}\s.,:\-]/gu, "");
  return t
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\.{2,}/g, ".");
}

/**
 * Relay a position ping to the TAK Server locate API (server-side; avoids browser CORS).
 */
async function relayPingToTak({ latitude, longitude, name, remarks }) {
  const base = getTakLocateApiBase();
  if (!base) {
    throw new Error("TAK_URL is not configured in Server Settings; cannot reach the TAK locate API.");
  }
  const u = new URL(base);
  u.searchParams.set("latitude", String(latitude));
  u.searchParams.set("longitude", String(longitude));
  u.searchParams.set("name", sanitizeForTakLocateQueryParam(name));
  u.searchParams.set("remarks", sanitizeForTakLocateQueryParam(remarks || ""));

  let client;
  try {
    // Use the locate API origin as baseURL (not Marti /api base) and POST path + query only.
    client = buildTakAxios({
      allowInsecureServer: true,
      baseURL: u.origin,
      timeout: 25000,
    });
  } catch (setupErr) {
    throw new Error(setupErr?.message || String(setupErr));
  }

  const pathAndQuery = `${u.pathname}${u.search}`;

  try {
    const resp = await client.post(pathAndQuery, "", {
      headers: {
        Accept: "*/*",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": "TAK-Portal-LocateRelay/1.0",
      },
      validateStatus: (s) => s >= 200 && s < 600,
    });
    if (resp.status < 200 || resp.status >= 300) {
      const bodyHint = summarizeTakResponseBody(resp.data);
      let msg = `TAK locate API returned HTTP ${resp.status}`;
      if (bodyHint) msg += `. Server response: ${bodyHint}`;
      if (resp.status === 403) {
        msg +=
          ". HTTP 403: ensure CoreConfig <locate requireLogin=\"false\" /> and TAK was restarted, " +
          "and that the relay URL (derived from TAK_URL: host without :8443, path /locate/api) matches your deployment. " +
          "Check takserver-api logs and client-cert rules for /locate/api.";
      } else if (resp.status === 404) {
        msg += ". HTTP 404 — confirm locate is enabled and reachable at https://<host>/locate/api on port 443.";
      } else if (resp.status >= 500) {
        msg +=
          ". HTTP 5xx usually indicates an error inside takserver-api processing this request; check TAK logs for /locate/api.";
      }
      throw new Error(msg);
    }
  } catch (err) {
    const msg = err?.message || String(err);
    const code = err?.code || "";
    const causeMsg = String(err?.cause?.message || "");
    const causeCode = err?.cause?.code || "";
    const scan = `${msg} ${causeMsg}`;
    const scanCode = code || causeCode;
    if (
      /ssl\/tls alert bad certificate|alert number 42|bad certificate/i.test(scan) ||
      scanCode === "ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE"
    ) {
      throw new Error(
        "The TAK server rejected the TLS client certificate (mTLS). " +
          "Use the same TAK_API_P12_PATH (or TAK_API_CERT_PATH + TAK_API_KEY_PATH) that works for Marti/API calls—a cert the TAK server trusts for HTTPS clients."
      );
    }
    throw err;
  }
}

module.exports = {
  FILE,
  titleToSlug,
  formatLocatePingNameForTak,
  getTakLocateApiBase,
  normalizePingIntervalSeconds,
  getClientConfigForPublicSlug,
  getBySlug,
  getById,
  isLiveLocator,
  locatorKind,
  listLocatorsForAdmin,
  create,
  createLive,
  update,
  archive,
  reactivate,
  permanentDelete,
  addHistoryEntry,
  listHistory,
  addManualOperatorPing,
  setSharingStoppedByUser,
  relayPingToTak,
};
