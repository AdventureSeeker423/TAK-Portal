const db = require("./db");
const cryptoSecrets = require("./cryptoSecrets");

const SECRET_KEYS = ["password", "token", "key", "secret", "app_password"];

function encryptPayload(payload) {
  const out = payload && typeof payload === "object" ? { ...payload } : {};
  for (const k of SECRET_KEYS) {
    if (out[k] != null && String(out[k]).trim() && !String(out[k]).startsWith("v1:")) {
      out[k] = cryptoSecrets.encryptSecret(String(out[k]));
    }
  }
  if (out.password_enc && !String(out.password_enc).startsWith("v1:")) {
    out.password_enc = cryptoSecrets.encryptSecret(String(out.password_enc));
  }
  return out;
}

function decryptPayload(payload) {
  const out = payload && typeof payload === "object" ? { ...payload } : {};
  for (const k of SECRET_KEYS) {
    if (out[k] && String(out[k]).startsWith("v1:")) {
      try {
        out[k] = cryptoSecrets.decryptSecret(String(out[k]));
      } catch (_) {
        out[k] = "";
      }
    }
  }
  if (out.password_enc && String(out.password_enc).startsWith("v1:")) {
    try {
      out.password = cryptoSecrets.decryptSecret(String(out.password_enc));
    } catch (_) {
      out.password = "";
    }
  }
  return out;
}

/**
 * Enqueue an Authentik outbox row. Prefer passing `client` from an open transaction
 * so the directory write and outbox insert commit together.
 */
async function enqueue(row, client) {
  const q = client || db;
  const payload = encryptPayload(row.payload || {});
  const r = await q.query(
    `INSERT INTO authentik_outbox (
      kind, entity_type, entity_id, authentik_pk, username, payload, next_attempt_at
    ) VALUES ($1,$2,$3,$4,$5,$6::jsonb, now())
    RETURNING id`,
    [
      row.kind,
      row.entityType || null,
      row.entityId || null,
      row.authentikPk != null ? Number(row.authentikPk) : null,
      row.username || null,
      JSON.stringify(payload),
    ]
  );
  return r.rows[0].id;
}

async function waitForOutbox(id, timeoutMs = 8000) {
  const oid = Number(id);
  if (!Number.isFinite(oid)) return { done: false, timedOut: true };
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const r = await db.query("SELECT id, last_error, attempts FROM authentik_outbox WHERE id = $1", [oid]);
    if (!r.rows.length) return { done: true, timedOut: false };
    await new Promise((res) => setTimeout(res, 200));
  }
  return { done: false, timedOut: true };
}

async function pendingEntityKeys() {
  const r = await db.query(
    `SELECT entity_id, username, authentik_pk, kind FROM authentik_outbox`
  );
  const byUserId = new Set();
  const byUsername = new Set();
  const byPk = new Set();
  const byKind = new Map();
  for (const row of r.rows) {
    if (row.entity_id) byUserId.add(String(row.entity_id));
    if (row.username) byUsername.add(String(row.username).toLowerCase());
    if (row.authentik_pk != null) byPk.add(Number(row.authentik_pk));
    const k = `${row.kind}:${row.entity_id || row.username || row.authentik_pk}`;
    byKind.set(k, row);
  }
  return { byUserId, byUsername, byPk, rows: r.rows };
}

async function claimBatch(limit = 20) {
  const r = await db.query(
    `UPDATE authentik_outbox SET next_attempt_at = now() + interval '2 minutes'
     WHERE id IN (
       SELECT id FROM authentik_outbox
       WHERE next_attempt_at <= now()
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     RETURNING *`,
    [limit]
  );
  return r.rows;
}

async function markAttempt(id, error, attempts) {
  const backoffSec = Math.min(300, Math.pow(2, Math.max(1, attempts)));
  const msg = String(error || "").slice(0, 2000);
  await db.query(
    `UPDATE authentik_outbox
     SET attempts = $2, last_error = $3, next_attempt_at = now() + ($4 || ' seconds')::interval
     WHERE id = $1`,
    [id, attempts, msg, String(backoffSec)]
  );
}

async function deleteRow(id) {
  await db.query("DELETE FROM authentik_outbox WHERE id = $1", [id]);
}

module.exports = {
  enqueue,
  waitForOutbox,
  encryptPayload,
  decryptPayload,
  pendingEntityKeys,
  claimBatch,
  markAttempt,
  deleteRow,
};
