const db = require("./db");

const MAX_FILE_BYTES =
  parseInt(process.env.AUDIT_LOG_MAX_FILE_BYTES, 10) || 5 * 1024 * 1024 * 1024;
const TRIM_TARGET_BYTES = Math.floor(MAX_FILE_BYTES * 0.92);

const FILE = null;

let _writesSinceTrim = 0;

function jsonByteLength() {
  return 0;
}

function trimOldestToMaxBytes(items) {
  return { items: Array.isArray(items) ? items : [], removed: 0 };
}

async function trimIfNeeded() {
  if (!db.isConfigured()) return;
  try {
    const r = await db.query(`SELECT pg_total_relation_size('audit_events') AS bytes`);
    const bytes = Number(r.rows[0]?.bytes || 0);
    if (bytes <= MAX_FILE_BYTES) return;
    await db.query(`
      DELETE FROM audit_events
      WHERE ctid IN (
        SELECT ctid FROM audit_events ORDER BY timestamp ASC LIMIT 20000
      )
    `);
    console.warn(
      `[audit] trimmed oldest audit_events (relation ~${Math.round(bytes / (1024 * 1024))} MB, limit ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB)`
    );
  } catch (e) {
    console.warn("[audit] size-cap trim failed:", e?.message || e);
  }
}

function load() {
  return [];
}

function save() {}

async function insertEvent(ev) {
  if (!db.isConfigured()) return;
  await db.query(
    `INSERT INTO audit_events (
      id, timestamp, actor, request, action, target_type, target_id,
      agency_suffix, agency_name, agency_prefix, details
    ) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8,$9,$10,$11::jsonb)
    ON CONFLICT (id) DO NOTHING`,
    [
      ev.id,
      ev.timestamp || new Date().toISOString(),
      JSON.stringify(ev.actor || null),
      JSON.stringify(ev.request || null),
      ev.action || null,
      ev.targetType || null,
      ev.targetId || null,
      ev.agencySuffix || null,
      ev.agencyName || null,
      ev.agencyPrefix || null,
      JSON.stringify(ev.details || null),
    ]
  );
  _writesSinceTrim += 1;
  if (_writesSinceTrim >= 50) {
    _writesSinceTrim = 0;
    trimIfNeeded().catch(() => {});
  }
}

function rowToLog(r) {
  return {
    id: r.id,
    timestamp: r.timestamp,
    actor: r.actor,
    request: r.request,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    agencySuffix: r.agency_suffix,
    agencyName: r.agency_name,
    agencyPrefix: r.agency_prefix,
    details: r.details,
  };
}

async function queryRows({
  q,
  actorNeedles,
  actionNeedles,
  targetNeedles,
  agencyNeedles,
  from,
  to,
  page,
  pageSize,
} = {}) {
  if (!db.isConfigured()) {
    return { items: [], total: 0 };
  }
  const where = [];
  const params = [];
  const add = (sql, val) => {
    params.push(val);
    where.push(sql.replace("?", `$${params.length}`));
  };

  if (q && String(q).trim()) {
    const needle = `%${String(q).trim()}%`;
    params.push(needle);
    const i = params.length;
    where.push(
      `(action ILIKE $${i} OR target_type ILIKE $${i} OR target_id ILIKE $${i} OR actor::text ILIKE $${i} OR details::text ILIKE $${i})`
    );
  }
  if (actorNeedles && actorNeedles.length) {
    params.push(actorNeedles);
    where.push(`LOWER(COALESCE(actor->>'username','')) = ANY($${params.length})`);
  }
  if (actionNeedles && actionNeedles.length) {
    params.push(actionNeedles);
    where.push(`LOWER(COALESCE(action,'')) = ANY($${params.length})`);
  }
  if (targetNeedles && targetNeedles.length) {
    params.push(targetNeedles);
    where.push(`LOWER(COALESCE(target_type,'')) = ANY($${params.length})`);
  }
  if (agencyNeedles && agencyNeedles.length) {
    params.push(agencyNeedles);
    where.push(`LOWER(COALESCE(agency_suffix,'')) = ANY($${params.length})`);
  }
  if (from && !Number.isNaN(Date.parse(from))) {
    params.push(new Date(from).toISOString());
    where.push(`timestamp >= $${params.length}`);
  }
  if (to && !Number.isNaN(Date.parse(to))) {
    params.push(new Date(to).toISOString());
    where.push(`timestamp <= $${params.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const count = await db.query(`SELECT COUNT(*)::int AS n FROM audit_events ${clause}`, params);
  const total = count.rows[0]?.n || 0;
  const ps = Math.max(1, Number(pageSize) || 50);
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * ps;
  params.push(ps, offset);
  const rows = await db.query(
    `SELECT * FROM audit_events ${clause} ORDER BY timestamp DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: rows.rows.map(rowToLog), total };
}

async function listDistinct(field, limit = 250) {
  if (!db.isConfigured()) return [];
  let sql = "";
  if (field === "actions") sql = "SELECT DISTINCT action AS v FROM audit_events WHERE action IS NOT NULL";
  else if (field === "targetTypes") sql = "SELECT DISTINCT target_type AS v FROM audit_events WHERE target_type IS NOT NULL";
  else if (field === "agencies") sql = "SELECT DISTINCT agency_suffix AS v FROM audit_events WHERE agency_suffix IS NOT NULL";
  else if (field === "actors") sql = "SELECT DISTINCT actor->>'username' AS v FROM audit_events WHERE actor->>'username' IS NOT NULL";
  else return [];
  const r = await db.query(`${sql} ORDER BY 1 LIMIT $1`, [limit]);
  return r.rows.map((x) => x.v).filter(Boolean);
}

async function listDistinctActors(limit = 250) {
  if (!db.isConfigured()) return [];
  const r = await db.query(
    `SELECT actor->>'username' AS username,
            MIN(NULLIF(BTRIM(actor->>'displayName'), '')) AS display_name
     FROM audit_events
     WHERE actor->>'username' IS NOT NULL
       AND BTRIM(actor->>'username') <> ''
     GROUP BY 1
     ORDER BY 1
     LIMIT $1`,
    [limit]
  );
  return r.rows.map((row) => ({
    username: row.username,
    displayName: row.display_name || null,
  }));
}

module.exports = {
  FILE,
  MAX_FILE_BYTES,
  TRIM_TARGET_BYTES,
  trimOldestToMaxBytes,
  jsonByteLength,
  load,
  save,
  insertEvent,
  queryRows,
  listDistinct,
  listDistinctActors,
  trimIfNeeded,
};
