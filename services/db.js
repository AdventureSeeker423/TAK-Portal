const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const ROLE = String(process.env.PROCESS_ROLE || "web").trim().toLowerCase();
const MAX = ROLE === "worker" ? 8 : 10;
const STATEMENT_TIMEOUT_MS = ROLE === "worker" ? 0 : 15000;

let pool = null;

function databaseUrl() {
  return String(process.env.DATABASE_URL || "").trim();
}

function isConfigured() {
  return !!databaseUrl();
}

function getPool() {
  if (pool) return pool;
  const connectionString = databaseUrl();
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  pool = new Pool({
    connectionString,
    max: MAX,
    idleTimeoutMillis: 30000,
  });
  pool.on("error", (err) => {
    console.error("[db] pool error:", err?.message || err);
    // Idle clients die when Postgres is restarted (SIGTERM / docker stop).
    // Drop the pool so the next query opens a fresh connection instead of
    // hammering a set of already-terminated sockets.
    if (pool) {
      const dying = pool;
      pool = null;
      dying.end().catch(() => {});
    }
  });
  return pool;
}

async function connectWithRetry(maxMs = 60000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < maxMs) {
    try {
      const p = getPool();
      await p.query("SELECT 1");
      if (STATEMENT_TIMEOUT_MS > 0) {
        await p.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      }
      return p;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw last || new Error("Postgres connect timed out");
}

async function query(text, params) {
  return getPool().query(text, params);
}

async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
}

function migrationFiles() {
  const dir = path.join(__dirname, "..", "db", "migrations");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/i.test(f))
    .sort()
    .map((f) => ({
      id: parseInt(f, 10),
      file: f,
      full: path.join(dir, f),
    }))
    .filter((m) => Number.isFinite(m.id));
}

async function migrate() {
  const p = await connectWithRetry();
  await p.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const applied = await p.query("SELECT id FROM schema_migrations");
  const have = new Set(applied.rows.map((r) => Number(r.id)));
  for (const m of migrationFiles()) {
    if (have.has(m.id)) continue;
    const sql = fs.readFileSync(m.full, "utf8");
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING",
        [m.id]
      );
    });
    console.log(`[db] applied migration ${m.file}`);
  }
}

function latestMigrationId() {
  const files = migrationFiles();
  return files.length ? files[files.length - 1].id : 0;
}

async function waitForSchema(version, timeoutMs = 120000) {
  const want = version == null ? latestMigrationId() : Number(version);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id INT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      const r = await query("SELECT COALESCE(MAX(id), 0)::int AS id FROM schema_migrations");
      if (Number(r.rows[0]?.id || 0) >= want) return true;
    } catch (_) {
      /* schema table may not exist yet */
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error(`Timed out waiting for schema_migrations >= ${want}`);
}

async function end() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

module.exports = {
  getPool,
  connectWithRetry,
  query,
  withTransaction,
  migrate,
  waitForSchema,
  latestMigrationId,
  end,
  ROLE,
  isConfigured,
  databaseUrl,
};
