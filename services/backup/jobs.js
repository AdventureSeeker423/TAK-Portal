"use strict";

const path = require("path");
const db = require("../db");
const { BACKUPS_DIR } = require("./files");

const KINDS = new Set(["backup_export", "backup_import"]);

function redactOptions(options) {
  if (!options || typeof options !== "object") return {};
  const out = { ...options };
  if (out.passphrase) out.passphrase = "***";
  return out;
}

function toClient(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    progress: row.progress || {},
    options: redactOptions(row.options),
    result: row.result || null,
    error: row.error || null,
    artifactPath: row.artifact_path || null,
    downloadName: row.artifact_path ? path.basename(row.artifact_path) : null,
    createdBy: row.created_by || null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

async function createJob({ kind, options, createdBy, artifactPath = null }) {
  if (!KINDS.has(kind)) throw new Error("Unknown job kind");
  const r = await db.query(
    `INSERT INTO portal_jobs (kind, status, options, artifact_path, created_by)
     VALUES ($1, 'queued', $2::jsonb, $3, $4)
     RETURNING *`,
    [kind, JSON.stringify(options || {}), artifactPath, createdBy || null]
  );
  return r.rows[0];
}

async function getJob(id) {
  const r = await db.query("SELECT * FROM portal_jobs WHERE id = $1", [id]);
  return r.rows[0] || null;
}

async function claimNext() {
  const r = await db.query(
    `UPDATE portal_jobs SET status = 'running', started_at = now(), heartbeat_at = now()
     WHERE id = (
       SELECT id FROM portal_jobs
       WHERE status = 'queued' AND kind = ANY($1::text[])
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`,
    [[...KINDS]]
  );
  return r.rows[0] || null;
}

async function updateProgress(id, progress) {
  await db.query(
    `UPDATE portal_jobs SET progress = $2::jsonb, heartbeat_at = now() WHERE id = $1`,
    [id, JSON.stringify(progress || {})]
  );
}

async function completeJob(id, { result = null, artifactPath = null } = {}) {
  await db.query(
    `UPDATE portal_jobs
     SET status = 'complete', result = $2::jsonb, artifact_path = COALESCE($3, artifact_path),
         error = NULL, finished_at = now(), heartbeat_at = now(),
         options = options - 'passphrase'
     WHERE id = $1`,
    [id, JSON.stringify(result || {}), artifactPath]
  );
}

async function failJob(id, error) {
  await db.query(
    `UPDATE portal_jobs
     SET status = 'failed', error = $2, finished_at = now(), heartbeat_at = now(),
         options = options - 'passphrase'
     WHERE id = $1`,
    [id, String(error || "Job failed").slice(0, 4000)]
  );
}

async function cancelJob(id) {
  const r = await db.query(
    `UPDATE portal_jobs SET status = 'cancelled', finished_at = now(), options = options - 'passphrase'
     WHERE id = $1 AND status = 'queued'
     RETURNING *`,
    [id]
  );
  return r.rows[0] || null;
}

function artifactAbs(relOrAbs) {
  if (!relOrAbs) return null;
  if (path.isAbsolute(relOrAbs)) return relOrAbs;
  return path.join(BACKUPS_DIR, relOrAbs);
}

module.exports = {
  KINDS,
  redactOptions,
  toClient,
  createJob,
  getJob,
  claimNext,
  updateProgress,
  completeJob,
  failJob,
  cancelJob,
  artifactAbs,
};
