const jsonImport = require("./jsonImport.service");
const db = require("./db");

const WORKER_STALE_MS = 60 * 1000;
const WORKER_STARTING_GRACE_MS = 90 * 1000;

let _lastHealthKey = "";

function logHealthTransition(health) {
  const key = [
    health.ok ? "ok" : "degraded",
    health.postgres && health.postgres.ok ? "pg" : "pg_down",
    health.worker && health.worker.ok ? "wk" : `wk_${health.worker && health.worker.detail ? health.worker.detail : "down"}`,
  ].join(":");
  if (key === _lastHealthKey) return;
  _lastHealthKey = key;
  if (health.ok) {
    console.log("[health] portal database and worker are healthy");
    return;
  }
  const parts = [];
  if (!health.postgres.ok) parts.push("Postgres: " + (health.postgres.detail || "unreachable"));
  if (!health.worker.ok) parts.push("worker: " + (health.worker.detail || "not running"));
  console.warn("[health] stack degraded — " + parts.join("; "));
}

async function getStackHealth() {
  let migrating = false;
  try {
    const s = await jsonImport.readStatusJson();
    migrating = !!s.active;
  } catch (_) {
    /* ignore */
  }

  const postgres = { ok: false };
  if (!db.isConfigured()) {
    postgres.detail = "not_configured";
  } else {
    const ping = await pingPostgres();
    if (ping.ok) postgres.ok = true;
    else postgres.detail = ping.detail;
  }

  const worker = { ok: false };
  if (!postgres.ok) {
    worker.detail = "postgres_down";
  } else {
    try {
      const r = await queryOrTimeout("SELECT updated_at FROM worker_heartbeat WHERE id = 1", 3000);
      const ts = r.rows[0] && r.rows[0].updated_at ? new Date(r.rows[0].updated_at).getTime() : 0;
      const ageMs = ts ? Date.now() - ts : null;
      worker.ageMs = ageMs;
      if (ageMs != null && Number.isFinite(ageMs) && ageMs <= WORKER_STALE_MS) {
        worker.ok = true;
      } else if (!ts) {
        if (process.uptime() * 1000 < WORKER_STARTING_GRACE_MS) {
          worker.ok = true;
          worker.detail = "starting";
        } else {
          worker.detail = "no_heartbeat";
        }
      } else {
        worker.detail = "stale";
      }
    } catch (e) {
      worker.detail = e?.code === "42P01" ? "no_heartbeat" : e?.message || "heartbeat_unreadable";
    }
  }

  if (migrating && postgres.ok) {
    worker.ok = true;
    worker.detail = worker.detail || "import";
  }

  const health = {
    ok: !!(postgres.ok && worker.ok),
    migrating,
    postgres,
    worker,
  };
  const outage = describeOutage(health);
  health.title = outage.title;
  health.message = outage.message;
  logHealthTransition(health);
  return health;
}

const UNAVAILABLE_MESSAGE =
  "TAK Portal is not responding properly. Please refresh the page or try again later.";
const UNAVAILABLE_HINT =
  "For ongoing issues, please contact your TAK Administrator";

function getUnavailablePageLocals() {
  let portalTitle = "TAK Portal";
  let brandLogoUrl = "";
  try {
    const settingsSvc = require("./settings.service");
    const settings = settingsSvc.getSettings() || {};
    const raw = String(settings.SERVER_NAME || "").trim();
    if (raw) portalTitle = `${raw.toUpperCase()} Portal`;
    brandLogoUrl = String(settings.BRAND_LOGO_URL || "").trim();
  } catch (_) {
    /* keep defaults */
  }
  return {
    portalTitle,
    brandLogoUrl,
    title: `${portalTitle} Is Unavailable`,
    message: UNAVAILABLE_MESSAGE,
    hint: UNAVAILABLE_HINT,
  };
}

function describeOutage(health) {
  if (!health || health.ok || health.migrating) {
    return { title: "", message: "" };
  }
  const copy = getUnavailablePageLocals();
  return { title: copy.title, message: copy.message };
}

function isTransientPgError(e) {
  const code = String(e?.code || "");
  const msg = String(e?.message || "");
  if (code === "health_timeout") return false;
  if (code === "57P01" || code === "57P02" || code === "57P03") return true;
  if (code === "ECONNRESET" || code === "ECONNREFUSED") return true;
  if (/terminating connection/i.test(msg)) return true;
  if (/Connection terminated/i.test(msg)) return true;
  if (/the database system is (starting up|shutting down)/i.test(msg)) return true;
  return false;
}

async function pingPostgres() {
  try {
    await queryOrTimeout("SELECT 1", 3000);
    return { ok: true };
  } catch (e) {
    if (!isTransientPgError(e)) {
      return { ok: false, detail: e?.code || e?.message || "unreachable" };
    }
    await new Promise((r) => setTimeout(r, 250));
    try {
      await queryOrTimeout("SELECT 1", 3000);
      return { ok: true };
    } catch (e2) {
      return { ok: false, detail: e2?.code || e2?.message || e?.message || "unreachable" };
    }
  }
}

async function queryOrTimeout(sql, ms) {
  let timer;
  try {
    return await Promise.race([
      db.query(sql),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const e = new Error("timeout");
          e.code = "health_timeout";
          reject(e);
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  getStackHealth,
  describeOutage,
  getUnavailablePageLocals,
  WORKER_STALE_MS,
  WORKER_STARTING_GRACE_MS,
};
