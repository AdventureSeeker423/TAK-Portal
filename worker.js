require("dotenv").config({ quiet: true });

const db = require("./services/db");
const settingsSvc = require("./services/settings.service");
const jsonImport = require("./services/jsonImport.service");
const directorySync = require("./services/directorySync.service");
const pgCache = require("./services/pgCache");
const axios = require("axios");
const pkg = require("./package.json");

const INBOUND_SECONDS = Number(process.env.AUTHENTIK_INBOUND_SYNC_SECONDS || 30) || 30;

let _stopping = false;
const _timers = [];

function stripVersionPrefix(v) {
  return String(v || "")
    .trim()
    .replace(/^v/i, "");
}

function isNewerVersion(latest, current) {
  const toParts = (v) =>
    String(v || "0.0.0")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const [la, lb, lc] = toParts(latest);
  const [ca, cb, cc] = toParts(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

async function writeAppUpdateMeta() {
  try {
    const repo = process.env.GITHUB_REPO || "AdventureSeeker423/TAK-Portal";
    const url = `https://api.github.com/repos/${repo}/releases/latest`;
    const response = await axios.get(url, {
      timeout: 5000,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "TAK-Portal",
      },
    });
    const tag = stripVersionPrefix((response.data && response.data.tag_name) || "");
    if (!/^\d+\.\d+\.\d+/.test(tag)) return;
    const updateAvailable = isNewerVersion(tag, pkg.version || "0.0.0");
    await db.query(
      `INSERT INTO app_update_meta (id, latest, update_available, checked_at)
       VALUES (1, $1, $2, now())
       ON CONFLICT (id) DO UPDATE SET latest = EXCLUDED.latest, update_available = EXCLUDED.update_available, checked_at = now()`,
      [tag, updateAvailable]
    );
  } catch (_) {
    /* quiet */
  }
}

async function writeTakDashboard() {
  try {
    const takDashboardCache = require("./services/takDashboardCache.service");
    const snap = await takDashboardCache.refreshNow();
    await db.query(
      `INSERT INTO tak_dashboard_stats (id, payload, updated_at)
       VALUES (1, $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
      [JSON.stringify(snap || {})]
    );
  } catch (e) {
    console.warn("[worker] TAK dashboard refresh failed:", e?.message || e);
  }
}

async function waitForImportComplete() {
  for (;;) {
    try {
      const row = await jsonImport.getProgressRow();
      const phase = String(row.phase || "idle");
      if (phase === "complete" || phase === "idle") return;
      if (phase === "failed") {
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function every(ms, fn) {
  const t = setInterval(() => {
    if (_stopping) return;
    Promise.resolve()
      .then(fn)
      .catch((e) => console.warn("[worker] loop error:", e?.message || e));
  }, ms);
  if (t.unref) t.unref();
  _timers.push(t);
  return t;
}

async function main() {
  try {
    settingsSvc.ensureSettingsInitialized();
  } catch (e) {
    console.warn("[worker] settings init:", e?.message || e);
  }

  console.log("[worker] connecting to Postgres…");
  await db.connectWithRetry(60000);
  await db.waitForSchema();
  console.log("[worker] waiting for JSON import to finish…");
  await waitForImportComplete();
  try {
    await pgCache.hydrate();
  } catch (e) {
    console.warn("[worker] hydrate:", e?.message || e);
  }
  console.log("[worker] starting loops");

  every(200, () => directorySync.drainOutbox());
  every(INBOUND_SECONDS * 1000, () => directorySync.inboundSnapshot());
  void directorySync.inboundSnapshot().catch((e) =>
    console.warn("[worker] initial snapshot:", e?.message || e)
  );

  every(15 * 1000, writeTakDashboard);
  void writeTakDashboard();

  try {
    const mutualAidSvc = require("./services/mutualAid.service");
    mutualAidSvc.initExpirationScheduler();
  } catch (e) {
    console.warn("[worker] mutual-aid scheduler:", e?.message || e);
  }

  try {
    const mouScheduler = require("./services/mouScheduler");
    mouScheduler.startScheduler();
  } catch (e) {
    console.warn("[worker] MOU scheduler:", e?.message || e);
  }

  every(15 * 60 * 1000, writeAppUpdateMeta);
  void writeAppUpdateMeta();
}

async function shutdown() {
  if (_stopping) return;
  _stopping = true;
  console.log("[worker] shutting down…");
  for (const t of _timers) clearInterval(t);
  try {
    await directorySync.drainOutbox();
  } catch (_) {}
  try {
    await db.end();
  } catch (_) {}
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main().catch((e) => {
  console.error("[worker] fatal:", e?.message || e);
  process.exit(1);
});
