const assert = require("assert");

const jsonImport = require("../services/jsonImport.service");
const db = require("../services/db");
const stackHealth = require("../services/stackHealth.service");

jsonImport.readStatusJson = async () => ({
  active: true,
  phase: "running",
  percent: 10,
  etaSeconds: 30,
  message: "Importing",
});

db.isConfigured = () => true;
db.query = async (sql) => {
  if (String(sql).includes("SELECT 1")) return { rows: [{}] };
  if (String(sql).includes("worker_heartbeat")) return { rows: [] };
  throw new Error("unexpected query: " + sql);
};

(async () => {
  const migrating = await stackHealth.getStackHealth();
  assert.strictEqual(migrating.ok, true);
  assert.strictEqual(migrating.migrating, true);
  assert.strictEqual(migrating.postgres.ok, true);
  assert.strictEqual(migrating.worker.ok, true);

  jsonImport.readStatusJson = async () => ({ active: false, phase: "complete" });
  let pings = 0;
  db.query = async (sql) => {
    if (String(sql).includes("SELECT 1")) {
      pings += 1;
      if (pings === 1) {
        const err = new Error("terminating connection due to administrator command");
        err.code = "57P01";
        throw err;
      }
      return { rows: [{}] };
    }
    if (String(sql).includes("worker_heartbeat")) {
      return { rows: [{ updated_at: new Date() }] };
    }
    throw new Error("unexpected query: " + sql);
  };
  const recovered = await stackHealth.getStackHealth();
  assert.strictEqual(recovered.ok, true);
  assert.strictEqual(recovered.postgres.ok, true);

  db.query = async (sql) => {
    if (String(sql).includes("SELECT 1")) return { rows: [{}] };
    if (String(sql).includes("worker_heartbeat")) {
      return { rows: [{ updated_at: new Date() }] };
    }
    throw new Error("unexpected query: " + sql);
  };
  const healthy = await stackHealth.getStackHealth();
  assert.strictEqual(healthy.ok, true);
  assert.strictEqual(healthy.migrating, false);
  assert.strictEqual(healthy.worker.ok, true);

  db.query = async (sql) => {
    if (String(sql).includes("SELECT 1")) return { rows: [{}] };
    if (String(sql).includes("worker_heartbeat")) {
      return { rows: [{ updated_at: new Date(Date.now() - 5 * 60 * 1000) }] };
    }
    throw new Error("unexpected query: " + sql);
  };
  const stale = await stackHealth.getStackHealth();
  assert.strictEqual(stale.ok, false);
  assert.strictEqual(stale.postgres.ok, true);
  assert.strictEqual(stale.worker.ok, false);
  assert.strictEqual(stale.worker.detail, "stale");
  assert.ok(String(stale.title).includes("worker"));
  assert.ok(String(stale.message).length > 0);

  db.query = async (sql) => {
    if (String(sql).includes("SELECT 1")) return { rows: [{}] };
    if (String(sql).includes("worker_heartbeat")) return { rows: [] };
    throw new Error("unexpected query: " + sql);
  };
  const starting = await stackHealth.getStackHealth();
  assert.strictEqual(starting.ok, true);
  assert.strictEqual(starting.worker.detail, "starting");

  db.query = async (sql) => {
    if (String(sql).includes("SELECT 1")) {
      const err = new Error("the database system is starting up");
      err.code = "57P03";
      throw err;
    }
    throw new Error("unexpected query: " + sql);
  };
  const down = await stackHealth.getStackHealth();
  assert.strictEqual(down.ok, false);
  assert.strictEqual(down.postgres.ok, false);
  assert.strictEqual(down.worker.ok, false);
  assert.strictEqual(down.worker.detail, "postgres_down");
  assert.ok(String(down.title).toLowerCase().includes("database"));

  console.log("health.migration.test.js: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
