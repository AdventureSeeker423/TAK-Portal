const store = require("./auditLog.store");
const agenciesSvc = require("./agencies.service");
const accessSvc = require("./access.service");

function safeStr(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function normalizeSuffix(value) {
  return safeStr(value).trim().toLowerCase();
}

function stripTakPrefix(name) {
  const n = safeStr(name).trim();
  if (n.toLowerCase().startsWith("tak_")) return n.slice(4);
  return n;
}

function getAgenciesIndex() {
  const agencies = agenciesSvc.load();
  const bySuffix = new Map();
  const byPrefix = new Map();

  for (const a of agencies) {
    const sfx = normalizeSuffix(a && a.suffix);
    if (sfx) bySuffix.set(sfx, a);

    const pfx = safeStr(a && a.groupPrefix).trim().toUpperCase();
    if (pfx) byPrefix.set(pfx, a);
  }

  return { agencies, bySuffix, byPrefix };
}

function inferAgencyFromUsername(username) {
  const un = safeStr(username).trim().toLowerCase();
  if (!un) return { agencySuffix: null, agencyName: null, agencyPrefix: null };

  const { bySuffix } = getAgenciesIndex();
  // Find the *longest* matching suffix to avoid false positives.
  let best = null;
  for (const [sfx, agency] of bySuffix.entries()) {
    if (sfx && un.endsWith(sfx)) {
      if (!best || sfx.length > best.sfx.length) best = { sfx, agency };
    }
  }
  if (!best) return { agencySuffix: null, agencyName: null, agencyPrefix: null };

  return {
    agencySuffix: normalizeSuffix(best.agency && best.agency.suffix) || null,
    agencyName: safeStr(best.agency && best.agency.name) || null,
    agencyPrefix: safeStr(best.agency && best.agency.groupPrefix).trim().toUpperCase() || null,
  };
}

function inferAgencyFromGroupName(groupName) {
  const raw = stripTakPrefix(groupName);
  const upper = safeStr(raw).trim().toUpperCase();
  if (!upper) return { agencySuffix: null, agencyName: null, agencyPrefix: null };

  const { byPrefix } = getAgenciesIndex();

  // Allow:
  //   PREFIX <space>
  //   PREFIX-...
  //   PREFIX -...
  for (const [pfx, agency] of byPrefix.entries()) {
    if (!pfx) continue;
    if (
      upper.startsWith(pfx + " ") ||
      upper.startsWith(pfx + "-") ||
      upper.startsWith(pfx + " -")
    ) {
      return {
        agencySuffix: normalizeSuffix(agency && agency.suffix) || null,
        agencyName: safeStr(agency && agency.name) || null,
        agencyPrefix: safeStr(agency && agency.groupPrefix).trim().toUpperCase() || null,
      };
    }
  }

  return { agencySuffix: null, agencyName: null, agencyPrefix: null };
}

function inferAgency({ targetType, targetId, details }) {
  const t = safeStr(targetType).trim().toLowerCase();
  if (t === "user" || t === "authentik_user") {
    const username =
      details && details.username != null && details.username !== ""
        ? details.username
        : targetId;
    const attrs =
      details && details.attributes && typeof details.attributes === "object"
        ? details.attributes
        : null;
    if (attrs && Object.keys(attrs).length) {
      const sfx = normalizeSuffix(
        accessSvc.resolveAgencySuffixFromUser({ username, attributes: attrs })
      );
      if (sfx) {
        const { bySuffix } = getAgenciesIndex();
        const agency = bySuffix.get(sfx);
        if (agency) {
          return {
            agencySuffix: normalizeSuffix(agency.suffix) || null,
            agencyName: safeStr(agency.name) || null,
            agencyPrefix: safeStr(agency.groupPrefix).trim().toUpperCase() || null,
          };
        }
      }
    }
    return inferAgencyFromUsername(username);
  }
  if (t === "group" || t === "authentik_group") {
    const name = details && details.name ? details.name : targetId;
    return inferAgencyFromGroupName(name);
  }
  if (t === "agency") {
    // targetId is usually suffix
    const { bySuffix } = getAgenciesIndex();
    const sfx = normalizeSuffix(targetId);
    const a = sfx ? bySuffix.get(sfx) : null;
    if (!a) return { agencySuffix: null, agencyName: null, agencyPrefix: null };
    return {
      agencySuffix: normalizeSuffix(a.suffix) || null,
      agencyName: safeStr(a.name) || null,
      agencyPrefix: safeStr(a.groupPrefix).trim().toUpperCase() || null,
    };
  }
  return { agencySuffix: null, agencyName: null, agencyPrefix: null };
}

function pruneDetails(details) {
  // Keep logs safe & lightweight: avoid accidentally persisting secrets.
  // (Passwords should never be logged.)
  if (!details || typeof details !== "object") return null;
  const out = { ...details };
  // Common sensitive keys
  delete out.password;
  delete out.pass;
  delete out.token;
  delete out.secret;
  delete out.AUTHENTIK_TOKEN;
  delete out.TAK_API_P12_PASSWORD;
  return out;
}

function logEvent(payload) {
  try {
    const logs = store.load();
    const nowIso = new Date().toISOString();

    const actor = payload && payload.actor ? payload.actor : null;
    const action = safeStr(payload && payload.action).trim() || "UNKNOWN";
    const targetType = safeStr(payload && payload.targetType).trim() || "unknown";
    const targetId = safeStr(payload && payload.targetId).trim() || "";
    const details = pruneDetails(payload && payload.details);

    let agency;
    const explicitSuffix = payload && payload.agencySuffix != null && String(payload.agencySuffix).trim() !== "";
    if (explicitSuffix) {
      const sfx = normalizeSuffix(payload.agencySuffix);
      const { bySuffix } = getAgenciesIndex();
      const a = bySuffix.get(sfx);
      agency = a
        ? {
            agencySuffix: normalizeSuffix(a.suffix) || null,
            agencyName: safeStr(a.name) || null,
            agencyPrefix: safeStr(a.groupPrefix).trim().toUpperCase() || null,
          }
        : {
            agencySuffix: sfx,
            agencyName: safeStr(payload.agencyName) || null,
            agencyPrefix: null,
          };
    } else {
      agency = inferAgency({ targetType, targetId, details });
    }

    logs.unshift({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      timestamp: nowIso,
      actor: actor
        ? {
            username: safeStr(actor.username) || null,
            displayName: safeStr(actor.displayName) || null,
            uid: safeStr(actor.uid) || null,
            isGlobalAdmin: !!actor.isGlobalAdmin,
            isAgencyAdmin: !!actor.isAgencyAdmin,
          }
        : null,
      request: payload && payload.request ? payload.request : null,
      action,
      targetType,
      targetId,
      agencySuffix: agency.agencySuffix,
      agencyName: agency.agencyName,
      agencyPrefix: agency.agencyPrefix,
      details,
    });

    const max = Number(payload && payload.maxItems) || 5000;
    if (logs.length > max) logs.splice(max);
    store.save(logs);
  } catch (err) {
    // Audit logging must never break normal app logic.
    console.warn("[audit] failed to write audit log:", err?.message || err);
  }
}

function queryLogs({
  q,
  actor,
  action,
  targetType,
  agencySuffix,
  from,
  to,
  page = 1,
  pageSize = 50,
} = {}) {
  const logs = store.load();
  const needle = safeStr(q).trim().toLowerCase();
  const actorNeedles = safeStr(actor)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const actionNeedles = safeStr(action)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const targetNeedles = safeStr(targetType)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const agencyNeedles = safeStr(agencySuffix)
    .split(",")
    .map((s) => normalizeSuffix(s))
    .filter(Boolean);

  const fromMs = from ? Date.parse(from) : NaN;
  const toMs = to ? Date.parse(to) : NaN;

  function matchesText(log) {
    if (!needle) return true;
    const parts = [
      log.action,
      log.targetType,
      log.targetId,
      log.actor && log.actor.username,
      log.actor && log.actor.displayName,
      log.agencySuffix,
      log.agencyName,
      log.agencyPrefix,
      log.request && log.request.path,
      log.request && log.request.method,
    ]
      .filter(Boolean)
      .map((x) => String(x).toLowerCase());

    if (parts.some((p) => p.includes(needle))) return true;

    // Also search a small JSON representation of details.
    try {
      const d = log.details ? JSON.stringify(log.details).toLowerCase() : "";
      if (d.includes(needle)) return true;
    } catch (_) {}

    return false;
  }

  const filtered = logs.filter((log) => {
    if (!log) return false;

    if (actorNeedles.length) {
      const au = safeStr(log.actor && log.actor.username).toLowerCase();
      const dn = safeStr(log.actor && log.actor.displayName).toLowerCase();
      const matches = actorNeedles.some(
        (needle) => (au && au.includes(needle)) || (dn && dn.includes(needle))
      );
      if (!matches) return false;
    }

    if (actionNeedles.length) {
      const act = safeStr(log.action).toLowerCase();
      if (!actionNeedles.includes(act)) return false;
    }

    if (targetNeedles.length) {
      const tt = safeStr(log.targetType).toLowerCase();
      if (!targetNeedles.includes(tt)) return false;
    }

    if (agencyNeedles.length) {
      const sfx = normalizeSuffix(log.agencySuffix);
      if (!agencyNeedles.includes(sfx)) return false;
    }

    if (!Number.isNaN(fromMs)) {
      const t = Date.parse(log.timestamp);
      if (!Number.isNaN(t) && t < fromMs) return false;
    }

    if (!Number.isNaN(toMs)) {
      const t = Date.parse(log.timestamp);
      if (!Number.isNaN(t) && t > toMs) return false;
    }

    if (!matchesText(log)) return false;
    return true;
  });

  const p = Math.max(1, Number(page) || 1);
  const ps = Math.min(500, Math.max(10, Number(pageSize) || 50));
  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / ps));
  const safePage = Math.min(pageCount, p);
  const start = (safePage - 1) * ps;
  const items = filtered.slice(start, start + ps);

  return {
    items,
    total,
    page: safePage,
    pageSize: ps,
    pageCount,
  };
}

function listDistinctValues({ field, limit = 250 } = {}) {
  const logs = store.load();
  const out = new Set();
  const f = safeStr(field);

  for (const log of logs) {
    if (!log) continue;
    if (f === "actions") out.add(safeStr(log.action));
    else if (f === "targetTypes") out.add(safeStr(log.targetType));
    else if (f === "agencies") out.add(normalizeSuffix(log.agencySuffix));
    else if (f === "actors") out.add(safeStr(log.actor && log.actor.username));
    if (out.size >= limit) break;
  }

  return Array.from(out)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function listDistinctActors({ limit = 250 } = {}) {
  const logs = store.load();
  const byUsername = new Map();

  for (const log of logs) {
    if (!log || !log.actor) continue;
    const username = safeStr(log.actor.username);
    if (!username) continue;
    if (byUsername.has(username)) continue;
    byUsername.set(username, {
      username,
      displayName: safeStr(log.actor.displayName) || null,
    });
    if (byUsername.size >= limit) break;
  }

  return Array.from(byUsername.values())
    .sort((a, b) => {
      const labelA = (a.displayName || a.username).toLowerCase();
      const labelB = (b.displayName || b.username).toLowerCase();
      return labelA.localeCompare(labelB);
    });
}

module.exports = {
  logEvent,
  queryLogs,
  listDistinctValues,
  listDistinctActors,
  inferAgencyFromUsername,
  inferAgencyFromGroupName,
};
