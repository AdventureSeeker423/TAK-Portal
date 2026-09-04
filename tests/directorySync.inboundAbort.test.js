const assert = require("assert");

const sqlCalls = [];
const db = require("../services/db");
db.query = async (sql, params) => {
  sqlCalls.push({ sql, params });
  if (/directory_sync/.test(sql) && /SELECT/.test(sql)) {
    return { rows: [{ last_error: null, completed: false }] };
  }
  return { rows: [] };
};

const api = require("../services/authentik");
api.get = async () => {
  throw new Error("Authentik unavailable");
};

const outbox = require("../services/authentikOutbox.service");
outbox.pendingEntityKeys = async () => ({
  byUserId: new Set(),
  byUsername: new Set(),
  byPk: new Set(),
  rows: [],
});

const { inboundSnapshot } = require("../services/directorySync.service");

(async () => {
  await inboundSnapshot();
  const disable = sqlCalls.filter((c) => /is_active = false/.test(c.sql));
  assert.strictEqual(
    disable.length,
    0,
    "aborted inbound snapshot must not disable missing users"
  );
  console.log("directorySync.inboundAbort.test.js: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
