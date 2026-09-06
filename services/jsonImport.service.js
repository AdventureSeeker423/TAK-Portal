const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const db = require("./db");
const cryptoSecrets = require("./cryptoSecrets");
const jsonImportFiles = require("./jsonImport.files");

const DATA_DIR = path.join(__dirname, "..", "data");
const MIGRATED_DIR = path.join(DATA_DIR, "migrated");
const ADVISORY_LOCK = 738201;

const IMPORT_FILES = [
  { name: "regions.json", rel: "regions.json" },
  { name: "regionCountyLocks.json", rel: "regionCountyLocks.json" },
  { name: "agencies.json", rel: "agencies.json" },
  { name: "agency-templates.json", rel: "agency-templates.json" },
  { name: "permission-overrides.json", rel: "permission-overrides.json" },
  { name: "autoCreateGroups.json", rel: "autoCreateGroups.json" },
  { name: "autoCreateDataSync.json", rel: "autoCreateDataSync.json" },
  { name: "user-requests.json", rel: "user-requests.json" },
  { name: "mutual-aid.json", rel: "mutual-aid.json" },
  { name: "geofences.json", rel: "geofences.json" },
  { name: "geofence-state.json", rel: "geofence-state.json" },
  { name: "locators.json", rel: "locators.json" },
  { name: "channel-patches.json", rel: "channel-patches.json" },
  { name: "mou-index.json", rel: path.join("mou", "index.json") },
  { name: "mou-user-agreement.json", rel: path.join("mou", "user-agreement.json") },
  { name: "mou-archived-documents.json", rel: path.join("mou", "archived-documents.json") },
  { name: "mou-acks.json", rel: path.join("mou", "acks.json") },
  { name: "mou-views.json", rel: path.join("mou", "views.json") },
  { name: "mou-reminders.json", rel: path.join("mou", "reminders.json") },
  { name: "mou-sign-invites.json", rel: path.join("mou", "sign-invites.json") },
  { name: "audit-log.json", rel: "audit-log.json" },
];

let _progressTimer = null;
let _bytesPerSecEma = 0;
let _lastBytes = 0;
let _lastTick = 0;

function filePath(rel) {
  return path.join(DATA_DIR, rel);
}

function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function humanizeEta(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return "Calculating time remaining…";
  if (seconds < 60) return "Less than a minute remaining";
  const mins = Math.ceil(seconds / 60);
  return `About ${mins} minute${mins === 1 ? "" : "s"} remaining`;
}

async function getProgressRow() {
  const r = await db.query("SELECT * FROM json_import_progress WHERE id = 1");
  return r.rows[0] || { phase: "idle" };
}

async function setProgress(patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 1}`);
  const vals = keys.map((k) => patch[k]);
  vals.push(new Date());
  sets.push(`updated_at = $${vals.length}`);
  await db.query(
    `UPDATE json_import_progress SET ${sets.join(", ")} WHERE id = 1`,
    vals
  );
}

async function readStatusJson() {
  const row = await getProgressRow();
  const phase = row.phase || "idle";
  const active = phase === "running" || phase === "failed";
  const percent = Number(row.percent || 0);
  const etaSeconds = row.eta_seconds == null ? null : Number(row.eta_seconds);
  return {
    active,
    phase,
    percent,
    etaSeconds,
    etaLabel:
      phase === "failed"
        ? "Paused — import failed"
        : humanizeEta(etaSeconds),
    currentFile: row.current_file ? path.basename(String(row.current_file)) : "",
    filesDone: Number(row.files_done || 0),
    filesTotal: Number(row.files_total || 0),
    message: phase === "failed" ? String(row.error || row.message || "Import failed") : String(row.message || ""),
  };
}

async function alreadyOk(fileName) {
  const r = await db.query("SELECT status FROM json_import_runs WHERE file_name = $1", [fileName]);
  return r.rows[0]?.status === "ok";
}

async function markRun(fileName, status, rowCount, error) {
  await db.query(
    `INSERT INTO json_import_runs (file_name, row_count, status, finished_at, error)
     VALUES ($1,$2,$3, now(), $4)
     ON CONFLICT (file_name) DO UPDATE SET
       row_count = EXCLUDED.row_count,
       status = EXCLUDED.status,
       finished_at = EXCLUDED.finished_at,
       error = EXCLUDED.error`,
    [fileName, rowCount || 0, status, error || null]
  );
}

function retireFile(absPath, fileName) {
  if (!fs.existsSync(absPath)) return;
  fs.mkdirSync(MIGRATED_DIR, { recursive: true });
  const dest = path.join(MIGRATED_DIR, `${fileName}.${isoStamp()}.json`);
  fs.renameSync(absPath, dest);
}

function inspectLegacySources() {
  return jsonImportFiles.inspectLegacySourcesIn(DATA_DIR, MIGRATED_DIR, IMPORT_FILES);
}

function restoreLatestBackups(opts) {
  return jsonImportFiles.restoreLatestBackupsIn(DATA_DIR, MIGRATED_DIR, IMPORT_FILES, opts);
}

function readJson(absPath) {
  const raw = fs.readFileSync(absPath, "utf8");
  return JSON.parse(raw);
}

async function importRegions(data) {
  const arr = Array.isArray(data) ? data : [];
  await db.withTransaction(async (c) => {
    await c.query("DELETE FROM regions");
    for (const r of arr) {
      const id = String(r.id || "").trim();
      if (!id) continue;
      await c.query(
        "INSERT INTO regions (id, name, extra) VALUES ($1,$2,$3::jsonb)",
        [id, r.name || id, JSON.stringify(r)]
      );
    }
  });
  return arr.length;
}

async function importLocks(data) {
  const arr = Array.isArray(data) ? data : [];
  await db.withTransaction(async (c) => {
    await c.query("DELETE FROM region_county_locks");
    for (const r of arr) {
      await c.query(
        `INSERT INTO region_county_locks (scope, region_id, state, county, extra)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [r.scope || "state", r.regionId || null, r.state || null, r.county || null, JSON.stringify(r)]
      );
    }
  });
  return arr.length;
}

async function importAgencies(data) {
  const arr = Array.isArray(data) ? data : [];
  const { replaceAgencies } = require("./pgCache");
  await replaceAgencies(arr);
  return arr.length;
}

async function importTemplates(data) {
  const arr = Array.isArray(data) ? data : [];
  const { replaceTemplates } = require("./pgCache");
  await replaceTemplates(arr);
  return arr.length;
}

async function importPermissions(data) {
  const obj = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  await db.withTransaction(async (c) => {
    await c.query("DELETE FROM permission_overrides");
    for (const [username, ov] of Object.entries(obj)) {
      const u = String(username || "").trim().toLowerCase();
      if (!u) continue;
      await c.query(
        `INSERT INTO permission_overrides (username, allow, deny) VALUES ($1,$2::jsonb,$3::jsonb)`,
        [u, JSON.stringify(ov?.allow || []), JSON.stringify(ov?.deny || [])]
      );
    }
  });
  return Object.keys(obj).length;
}

async function importLedger(table, data) {
  const obj = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  await db.withTransaction(async (c) => {
    await c.query(`DELETE FROM ${table}`);
    for (const [scope, map] of Object.entries(obj)) {
      if (!map || typeof map !== "object") continue;
      for (const [key, payload] of Object.entries(map)) {
        await c.query(
          `INSERT INTO ${table} (scope, key, payload) VALUES ($1,$2,$3::jsonb)`,
          [scope, key, JSON.stringify(payload || {})]
        );
      }
    }
  });
  return Object.keys(obj).length;
}

async function importUserRequests(data) {
  const arr = Array.isArray(data) ? data : [];
  await db.withTransaction(async (c) => {
    await c.query("DELETE FROM user_requests");
    for (const item of arr) {
      const id = String(item.id || "").trim();
      if (!id) continue;
      await c.query(
        `INSERT INTO user_requests (id, payload, status, created_at) VALUES ($1,$2::jsonb,$3,$4)`,
        [id, JSON.stringify(item), item.status || null, item.createdAt || null]
      );
    }
  });
  return arr.length;
}

async function importMutualAid(data) {
  const arr = Array.isArray(data) ? data : [];
  await db.withTransaction(async (c) => {
    await c.query("DELETE FROM mutual_aid");
    for (const item of arr) {
      const id = String(item.id || "").trim();
      if (!id) continue;
      const enc = item.password ? cryptoSecrets.encryptSecret(item.password) : "";
      await c.query(
        `INSERT INTO mutual_aid (
          id, type, title, group_id, group_name, group_mode, group_was_created,
          group_master_id, user_id, username, password_enc, expire_enabled, expire_at,
          logo_url, created_by, created_at, updated_at, extra
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)`,
        [
          id, item.type || null, item.title || null, item.groupId || null, item.groupName || null,
          item.groupMode || null, !!item.groupWasCreated, item.groupMasterId || null,
          item.userId || null, item.username || null, enc, !!item.expireEnabled,
          item.expireAt || null, item.logoUrl || null, item.createdBy || null,
          item.createdAt || null, item.updatedAt || null, JSON.stringify(item),
        ]
      );
    }
  });
  return arr.length;
}

async function importGeofences(data) {
  const fences = Array.isArray(data) ? data : Array.isArray(data?.fences) ? data.fences : [];
  await db.withTransaction(async (c) => {
    await c.query("DELETE FROM geofences");
    for (const f of fences) {
      const id = String(f.id || "").trim();
      if (!id) continue;
      await c.query(
        `INSERT INTO geofences (id, payload, updated_at) VALUES ($1,$2::jsonb, now())`,
        [id, JSON.stringify(f)]
      );
    }
  });
  return fences.length;
}

async function importGeofenceState(data) {
  const membership = data?.membership && typeof data.membership === "object" ? data.membership : {};
  await db.withTransaction(async (c) => {
    await c.query("DELETE FROM geofence_memberships");
    for (const [fenceId, users] of Object.entries(membership)) {
      if (!users || typeof users !== "object") continue;
      for (const [uid, st] of Object.entries(users)) {
        await c.query(
          `INSERT INTO geofence_memberships (fence_id, client_uid, inside, last_enter_at, last_seen_at, last_exit_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [fenceId, uid, !!st.inside, st.lastEnterAt || null, st.lastSeenAt || null, st.lastExitAt || null]
        );
      }
    }
  });
  return Object.keys(membership).length;
}

async function importLocators(data) {
  const locators = Array.isArray(data?.locators) ? data.locators : [];
  const history = Array.isArray(data?.history) ? data.history : [];
  await db.withTransaction(async (c) => {
    await c.query("DELETE FROM locator_pings");
    await c.query("DELETE FROM locators");
    for (const loc of locators) {
      const id = String(loc.id || "").trim();
      if (!id) continue;
      await c.query(
        `INSERT INTO locators (id, slug, payload, updated_at) VALUES ($1,$2,$3::jsonb, now())`,
        [id, loc.slug || null, JSON.stringify(loc)]
      );
    }
    for (const h of history) {
      const id = String(h.id || crypto.randomUUID()).trim();
      const locatorId = String(h.locatorId || "").trim();
      if (!locatorId) continue;
      await c.query(
        `INSERT INTO locator_pings (id, locator_id, at, payload) VALUES ($1,$2,$3,$4::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [id, locatorId, h.at || new Date().toISOString(), JSON.stringify(h)]
      );
    }
  });
  return locators.length;
}

async function importChannelPatches(data) {
  const arr = Array.isArray(data) ? data : [];
  await db.withTransaction(async (c) => {
    await c.query("DELETE FROM channel_patches");
    for (const p of arr) {
      const id = String(p.id || "").trim();
      if (!id) continue;
      await c.query(
        `INSERT INTO channel_patches (id, payload, updated_at) VALUES ($1,$2::jsonb, now())`,
        [id, JSON.stringify(p)]
      );
    }
  });
  return arr.length;
}

async function importMouStreams(data) {
  const streams = Array.isArray(data?.streams) ? data.streams : [];
  await db.withTransaction(async (c) => {
    await c.query("DELETE FROM mou_streams");
    for (const s of streams) {
      const id = String(s.mouId || s.id || "").trim();
      if (!id) continue;
      await c.query(
        `INSERT INTO mou_streams (id, payload, updated_at) VALUES ($1,$2::jsonb, now())`,
        [id, JSON.stringify(s)]
      );
    }
  });
  return streams.length;
}

async function importMouAgreement(data) {
  await db.query(
    `INSERT INTO mou_user_agreement (id, payload) VALUES (1, $1::jsonb)
     ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload`,
    [JSON.stringify(data && typeof data === "object" ? data : {})]
  );
  return 1;
}

async function importMouArchived(data) {
  const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
  await db.withTransaction(async (c) => {
    await c.query("DELETE FROM mou_archived");
    for (const item of items) {
      const id = String(item.archiveId || item.id || "").trim();
      if (!id) continue;
      await c.query(`INSERT INTO mou_archived (archive_id, payload) VALUES ($1,$2::jsonb)`, [
        id,
        JSON.stringify(item),
      ]);
    }
  });
  return items.length;
}

async function importMouAcks(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  await db.withTransaction(async (c) => {
    await c.query("DELETE FROM mou_acks");
    for (const item of items) {
      await c.query(
        `INSERT INTO mou_acks (user_key, version_id, at, payload) VALUES ($1,$2,$3,$4::jsonb)
         ON CONFLICT (user_key, version_id) DO UPDATE SET at = EXCLUDED.at, payload = EXCLUDED.payload`,
        [String(item.user_key || item.userKey || item.username || ""), String(item.version_id || item.versionId || item.version || ""), item.at || null, JSON.stringify(item)]
      );
    }
  });
  return items.length;
}

async function importMouViews(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  await db.withTransaction(async (c) => {
    await c.query("DELETE FROM mou_views");
    for (const item of items) {
      const key = String(item.key || "").trim();
      if (!key) continue;
      await c.query(`INSERT INTO mou_views (key, payload) VALUES ($1,$2::jsonb)`, [key, JSON.stringify(item)]);
    }
  });
  return items.length;
}

async function importMouReminders(data) {
  const agency = data?.agency && typeof data.agency === "object" ? data.agency : {};
  await db.withTransaction(async (c) => {
    await c.query("DELETE FROM mou_reminders");
    for (const [key, val] of Object.entries(agency)) {
      await c.query(
        `INSERT INTO mou_reminders (key, last_sent_at, payload) VALUES ($1,$2,$3::jsonb)`,
        [key, val?.lastSentAt || null, JSON.stringify(val || {})]
      );
    }
  });
  return Object.keys(agency).length;
}

async function importMouInvites(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  await db.withTransaction(async (c) => {
    await c.query("DELETE FROM mou_sign_invites");
    for (const item of items) {
      const id = String(item.inviteId || item.id || "").trim();
      if (!id) continue;
      await c.query(
        `INSERT INTO mou_sign_invites (invite_id, token, payload) VALUES ($1,$2,$3::jsonb)`,
        [id, item.token || null, JSON.stringify(item)]
      );
    }
  });
  return items.length;
}

async function importAudit(absPath, onProgress) {
  if (!fs.existsSync(absPath)) return 0;
  const raw = fs.readFileSync(absPath, "utf8");
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch (e) {
    throw new Error("audit-log.json is not valid JSON");
  }
  if (!Array.isArray(arr)) arr = [];
  let n = 0;
  const batch = [];
  async function flush() {
    if (!batch.length) return;
    const values = [];
    const params = [];
    let i = 1;
    for (const ev of batch) {
      values.push(`($${i++},$${i++},$${i++}::jsonb,$${i++}::jsonb,$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++}::jsonb)`);
      params.push(
        String(ev.id || crypto.randomUUID()),
        ev.timestamp || new Date().toISOString(),
        JSON.stringify(ev.actor || null),
        JSON.stringify(ev.request || null),
        ev.action || null,
        ev.targetType || null,
        ev.targetId || null,
        ev.agencySuffix || null,
        ev.agencyName || null,
        ev.agencyPrefix || null,
        JSON.stringify(ev.details || null)
      );
    }
    await db.query(
      `INSERT INTO audit_events (id, timestamp, actor, request, action, target_type, target_id, agency_suffix, agency_name, agency_prefix, details)
       VALUES ${values.join(",")}
       ON CONFLICT (id) DO NOTHING`,
      params
    );
    n += batch.length;
    batch.length = 0;
    if (onProgress) await onProgress(n);
  }
  for (const ev of arr) {
    batch.push(ev);
    if (batch.length >= 500) await flush();
    if (n > 0 && n % 10000 === 0 && onProgress) await onProgress(n);
  }
  await flush();
  return n;
}

const HANDLERS = {
  "regions.json": importRegions,
  "regionCountyLocks.json": importLocks,
  "agencies.json": importAgencies,
  "agency-templates.json": importTemplates,
  "permission-overrides.json": importPermissions,
  "autoCreateGroups.json": (d) => importLedger("auto_create_groups", d),
  "autoCreateDataSync.json": (d) => importLedger("auto_create_data_sync", d),
  "user-requests.json": importUserRequests,
  "mutual-aid.json": importMutualAid,
  "geofences.json": importGeofences,
  "geofence-state.json": importGeofenceState,
  "locators.json": importLocators,
  "channel-patches.json": importChannelPatches,
  "mou-index.json": importMouStreams,
  "mou-user-agreement.json": importMouAgreement,
  "mou-archived-documents.json": importMouArchived,
  "mou-acks.json": importMouAcks,
  "mou-views.json": importMouViews,
  "mou-reminders.json": importMouReminders,
  "mou-sign-invites.json": importMouInvites,
  "audit-log.json": null,
};

async function pendingFiles() {
  const out = [];
  for (const f of IMPORT_FILES) {
    const abs = filePath(f.rel);
    if (await alreadyOk(f.name)) {
      if (fs.existsSync(abs)) {
        console.warn(`[json-import] ignoring leftover data/${f.rel} (already imported)`);
      }
      continue;
    }
    if (!fs.existsSync(abs)) {
      await markRun(f.name, "ok", 0, null);
      continue;
    }
    out.push({ ...f, abs, size: fs.statSync(abs).size });
  }
  return out;
}

function tickRate(bytesDone, bytesTotal) {
  const now = Date.now();
  if (!_lastTick) {
    _lastTick = now;
    _lastBytes = bytesDone;
    return { percent: bytesTotal ? Math.max(1, Math.min(99, Math.floor((100 * bytesDone) / bytesTotal))) : 0, eta: null };
  }
  const dt = (now - _lastTick) / 1000;
  if (dt >= 0.4) {
    const inst = (bytesDone - _lastBytes) / Math.max(0.001, dt);
    _bytesPerSecEma = _bytesPerSecEma ? _bytesPerSecEma * 0.7 + inst * 0.3 : inst;
    _lastTick = now;
    _lastBytes = bytesDone;
  }
  const percent = bytesTotal
    ? Math.max(1, Math.min(99, Math.floor((100 * bytesDone) / bytesTotal)))
    : 0;
  const remain = Math.max(0, bytesTotal - bytesDone);
  const eta =
    _bytesPerSecEma > 1 && (now - (_lastTick || now) + 2000)
      ? Math.ceil(remain / _bytesPerSecEma)
      : null;
  const rateKnown = Date.now() - (_lastTick || Date.now()) > -1 && _bytesPerSecEma > 1;
  return { percent, eta: rateKnown ? eta : null };
}

async function run() {
  const client = await db.getPool().connect();
  let locked = false;
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [ADVISORY_LOCK]);
    if (!lock.rows[0]?.ok) {
      console.log("[json-import] another importer holds the lock; skipping");
      return;
    }
    locked = true;

    const pending = await pendingFiles();
    if (!pending.length) {
      await setProgress({
        phase: "complete",
        percent: 100,
        files_done: IMPORT_FILES.length,
        files_total: IMPORT_FILES.length,
        current_file: null,
        eta_seconds: 0,
        message: "Import complete",
        error: null,
      });
      return;
    }

    const bytesTotal = pending.reduce((s, f) => s + f.size, 0);
    _bytesPerSecEma = 0;
    _lastTick = 0;
    let bytesDone = 0;
    let filesDone = 0;
    await setProgress({
      phase: "running",
      started_at: new Date(),
      files_total: pending.length,
      files_done: 0,
      bytes_total: bytesTotal,
      bytes_done: 0,
      percent: 1,
      eta_seconds: null,
      current_file: pending[0].name,
      message: "Starting import",
      error: null,
    });

    for (const f of pending) {
      await setProgress({ current_file: f.name, message: `Importing ${f.name}` });
      console.log(`[json-import] ${f.name} (${filesDone + 1}/${pending.length})`);
      try {
        let count = 0;
        if (f.name === "audit-log.json") {
          count = await importAudit(f.abs, async (n) => {
            const approx = Math.min(f.size, Math.floor((n / 10000) * (f.size / 10) + 1));
            const { percent, eta } = tickRate(bytesDone + approx, bytesTotal);
            await setProgress({
              percent,
              eta_seconds: eta,
              bytes_done: bytesDone + approx,
              message: `Importing audit log (${n} rows)`,
            });
          });
        } else {
          const data = readJson(f.abs);
          count = await HANDLERS[f.name](data);
        }
        await markRun(f.name, "ok", count, null);
        retireFile(f.abs, f.name);
        filesDone += 1;
        bytesDone += f.size;
        const { percent, eta } = tickRate(bytesDone, bytesTotal);
        await setProgress({
          files_done: filesDone,
          bytes_done: bytesDone,
          percent: filesDone === pending.length ? 100 : percent,
          eta_seconds: eta,
        });
        const p = filesDone === pending.length ? 100 : percent;
        console.log(`[json-import] ${f.name} (${filesDone}/${pending.length}) ${p}% eta ${eta == null ? "?" : eta + "s"}`);
      } catch (e) {
        const msg = e?.message || String(e);
        await markRun(f.name, "error", 0, msg);
        await setProgress({
          phase: "failed",
          error: msg,
          message: msg,
          current_file: f.name,
        });
        console.error(`[json-import] failed ${f.name}:`, msg);
        return;
      }
    }

    await setProgress({
      phase: "complete",
      percent: 100,
      eta_seconds: 0,
      current_file: null,
      message: "Import complete",
      error: null,
    });
    try {
      await db.query("ANALYZE agencies");
      await db.query("ANALYZE users");
      await db.query("ANALYZE groups");
      await db.query("ANALYZE audit_events");
    } catch (_) {
      /* ignore */
    }
    try {
      const pgCache = require("./pgCache");
      await pgCache.hydrate();
    } catch (e) {
      console.warn("[json-import] hydrate cache:", e?.message || e);
    }
  } finally {
    if (locked) {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK]);
      } catch (_) {
        /* ignore */
      }
    }
    client.release();
  }
}

async function retry() {
  const row = await getProgressRow();
  if (String(row.phase || "") !== "failed") {
    return readStatusJson();
  }
  return run();
}

async function listImportRuns() {
  const r = await db.query(
    `SELECT file_name, row_count, status, error, finished_at
     FROM json_import_runs
     ORDER BY file_name`
  );
  return r.rows || [];
}

async function readRecoveryStatus() {
  const progress = await readStatusJson();
  const sources = inspectLegacySources();
  let runs = [];
  try {
    runs = await listImportRuns();
  } catch (e) {
    console.warn("[json-import] read runs:", e?.message || e);
  }
  const byName = new Map(runs.map((row) => [row.file_name, row]));
  const files = sources.map((s) => {
    const run = byName.get(s.name) || null;
    return {
      ...s,
      importStatus: run ? String(run.status || "") : "",
      importRows: run ? Number(run.row_count || 0) : 0,
      importError: run && run.error ? String(run.error) : "",
      importFinishedAt: run && run.finished_at ? run.finished_at : null,
    };
  });
  const hasSource = files.some((f) => f.originalPresent || f.latestBackup);
  const running = progress.phase === "running";
  return {
    progress,
    files,
    canRerun: hasSource && !running,
    hasSource,
    running,
  };
}

async function startRerunFromBackup() {
  const row = await getProgressRow();
  if (String(row.phase || "") === "running") {
    const err = new Error("Legacy JSON import is already running");
    err.code = "import_running";
    throw err;
  }
  const restore = restoreLatestBackups({ overwriteExisting: false });
  const queued = restore.filter((r) => r.usable).map((r) => r.name);
  if (!queued.length) {
    const err = new Error(
      "No legacy JSON files or migrated backups were found in the data volume"
    );
    err.code = "nothing_to_import";
    throw err;
  }
  await db.query("DELETE FROM json_import_runs WHERE file_name = ANY($1::text[])", [queued]);
  await setProgress({
    phase: "idle",
    percent: 0,
    files_done: 0,
    files_total: queued.length,
    current_file: null,
    eta_seconds: null,
    message: "Retrying import from restored JSON",
    error: null,
  });
  run().catch((e) => console.error("[json-import] rerun:", e?.message || e));
  return { restore, queuedFiles: queued };
}

module.exports = {
  run,
  retry,
  getProgressRow,
  readStatusJson,
  pendingFiles,
  retireFile,
  inspectLegacySources,
  restoreLatestBackups,
  readRecoveryStatus,
  startRerunFromBackup,
  IMPORT_FILES,
};
