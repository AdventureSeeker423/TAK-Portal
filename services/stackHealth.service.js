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
    try {
      await queryOrTimeout("SELECT 1", 3000);
      postgres.ok = true;
    } catch (e) {
      postgres.detail = e?.code || e?.message || "unreachable";
    }
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

function describeOutage(health) {
  if (!health || health.ok || health.migrating) {
    return { title: "", message: "" };
  }
  if (!health.postgres || !health.postgres.ok) {
    return {
      title: "Portal database is unavailable",
      message:
        "TAK Portal cannot be used until Postgres is running again. Docker restarts it if the process exited. On the server, run ./takportal start (or restart the stack from InfraTAK).",
    };
  }
  return {
    title: "Background worker is not running",
    message:
      "Directory sync and dashboard updates cannot continue, so the portal is paused until the worker recovers. Docker restarts it if the process exited. On the server, run ./takportal start (or restart the stack from InfraTAK).",
  };
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
  WORKER_STALE_MS,
  WORKER_STARTING_GRACE_MS,
};
