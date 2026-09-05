"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const db = require("../db");
const settingsSvc = require("../settings.service");
const catalog = require("./catalog");
const files = require("./files");
const ak = require("./authentik");

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function loadCategory(categoriesRoot, id) {
  return readJson(path.join(categoriesRoot, `${id}.json`), null);
}

function bump(report, id, field, n = 1) {
  if (!report[id]) report[id] = { create: 0, update: 0, skip: 0, conflict: 0, errors: [] };
  report[id][field] = (report[id][field] || 0) + n;
}

function addError(report, id, message) {
  if (!report[id]) report[id] = { create: 0, update: 0, skip: 0, conflict: 0, errors: [] };
  report[id].errors.push(String(message || "").slice(0, 500));
}

async function replaceTables(ids) {
  const set = new Set(ids);
  if (set.has("locate_pings") || set.has("locate")) {
    await db.query("DELETE FROM locator_pings");
  }
  if (set.has("locate")) await db.query("DELETE FROM locators");
  if (set.has("users") || set.has("groups")) {
    await db.query("DELETE FROM group_members");
  }
  if (set.has("users")) await db.query("DELETE FROM users");
  if (set.has("groups")) await db.query("DELETE FROM groups");
  if (set.has("agencies")) await db.query("DELETE FROM agencies");
  if (set.has("templates")) await db.query("DELETE FROM agency_templates");
  if (set.has("regions")) {
    await db.query("DELETE FROM region_county_locks");
    await db.query("DELETE FROM regions");
  }
  if (set.has("access_roles")) await db.query("DELETE FROM permission_overrides");
  if (set.has("user_requests")) await db.query("DELETE FROM user_requests");
  if (set.has("mutual_aid")) await db.query("DELETE FROM mutual_aid");
  if (set.has("channel_patches")) await db.query("DELETE FROM channel_patches");
  if (set.has("geofences")) await db.query("DELETE FROM geofences");
  if (set.has("auto_create_ledgers")) {
    await db.query("DELETE FROM auto_create_groups");
    await db.query("DELETE FROM auto_create_data_sync");
  }
  if (set.has("audit_log")) await db.query("DELETE FROM audit_events");
  if (set.has("mou")) {
    await db.query("DELETE FROM mou_acks");
    await db.query("DELETE FROM mou_views");
    await db.query("DELETE FROM mou_reminders");
    await db.query("DELETE FROM mou_sign_invites");
    await db.query("DELETE FROM mou_archived");
    await db.query("DELETE FROM mou_streams");
    await db.query("DELETE FROM mou_user_agreement");
  }
}

function applySettingsValues(values, dryRun) {
  const patch = values && typeof values === "object" ? values : {};
  const keys = Object.keys(patch);
  if (dryRun || !keys.length) return keys.length;
  settingsSvc.updateSettings(patch);
  return keys.length;
}

async function upsertByPk(table, pk, row, jsonCols = []) {
  const cols = Object.keys(row || {}).filter((c) => row[c] !== undefined);
  if (!cols.length) return "skip";
  const json = new Set(jsonCols);
  const existing = await db.query(`SELECT 1 FROM ${table} WHERE ${pk} = $1`, [row[pk]]);
  const paramVal = (c) => (json.has(c) ? JSON.stringify(row[c] ?? {}) : row[c]);
  const placeholder = (c, i) => (json.has(c) ? `$${i}::jsonb` : `$${i}`);
  if (existing.rows.length) {
    const updateCols = cols.filter((c) => c !== pk);
    if (!updateCols.length) return "update";
    const sets = updateCols.map((c, i) => `${c} = ${placeholder(c, i + 2)}`);
    await db.query(`UPDATE ${table} SET ${sets.join(", ")} WHERE ${pk} = $1`, [
      row[pk],
      ...updateCols.map(paramVal),
    ]);
    return "update";
  }
  const placeholders = cols.map((c, i) => placeholder(c, i + 1));
  await db.query(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders.join(",")})`,
    cols.map(paramVal)
  );
  return "create";
}

async function applySimpleRows(table, pk, rows, jsonCols, dryRun, report, catId) {
  for (const row of rows || []) {
    if (!row || row[pk] == null) {
      bump(report, catId, "skip");
      continue;
    }
    if (dryRun) {
      const existing = await db.query(`SELECT 1 FROM ${table} WHERE ${pk} = $1`, [row[pk]]);
      bump(report, catId, existing.rows.length ? "update" : "create");
      continue;
    }
    try {
      const action = await upsertByPk(table, pk, row, jsonCols);
      bump(report, catId, action);
    } catch (e) {
      bump(report, catId, "conflict");
      addError(report, catId, `${row[pk]}: ${e.message}`);
    }
  }
}

const USER_COLS = [
  "authentik_pk",
  "username",
  "name",
  "email",
  "is_active",
  "is_superuser",
  "path",
  "type",
  "sync_status",
  "pending_delete",
  "groups_hash",
  "agency",
  "agency_name",
  "agency_abbreviation",
  "agency_color",
  "badge_number",
  "role",
  "radio_callsign",
  "current_template",
  "created_template",
  "created_at_attr",
  "created_method",
  "created_by_username",
  "created_by_display_name",
  "mutual_aid",
  "mutual_aid_type",
  "mutual_aid_group",
  "integration_type",
  "integration_scope",
  "integration_title",
  "tak_integration_group",
  "state",
  "county",
  "attributes",
  "created_at",
];

function userColValue(row, col) {
  if (col === "attributes") return JSON.stringify(row.attributes || {});
  if (col === "is_active" || col === "is_superuser" || col === "pending_delete") {
    return !!row[col];
  }
  return row[col] == null ? null : row[col];
}

async function upsertUserRow(row, idMap) {
  const username = String(row.username || "").trim();
  if (!username) return { action: "skip" };
  const found = await db.query("SELECT id FROM users WHERE lower(username) = lower($1)", [
    username,
  ]);
  const vals = USER_COLS.map((c) => userColValue(row, c));
  if (found.rows[0]) {
    const id = found.rows[0].id;
    idMap.set(String(row.id), id);
    const sets = USER_COLS.map((c, i) =>
      `${c} = $${i + 2}${c === "attributes" ? "::jsonb" : ""}`
    ).join(", ");
    await db.query(
      `UPDATE users SET ${sets}, updated_at = now() WHERE id = $1`,
      [id, ...vals]
    );
    return { action: "update", id };
  }
  const insertCols = ["id", ...USER_COLS];
  const insertPlace = insertCols.map((c, i) =>
    c === "attributes" ? `$${i + 1}::jsonb` : `$${i + 1}`
  );
  const insertVals = [row.id, ...vals];
  try {
    await db.query(
      `INSERT INTO users (${insertCols.join(",")}) VALUES (${insertPlace.join(",")})`,
      insertVals
    );
    idMap.set(String(row.id), row.id);
    return { action: "create", id: row.id };
  } catch (_) {
    const r = await db.query(
      `INSERT INTO users (${USER_COLS.join(",")}) VALUES (${USER_COLS.map((c, i) =>
        c === "attributes" ? `$${i + 1}::jsonb` : `$${i + 1}`
      ).join(",")}) RETURNING id`,
      vals
    );
    const id = r.rows[0].id;
    idMap.set(String(row.id), id);
    return { action: "create", id };
  }
}

const GROUP_COLS = [
  "authentik_pk",
  "name",
  "cn",
  "description",
  "is_private",
  "is_superuser",
  "parent_pk",
  "num_pk",
  "created_type",
  "created_type_detail",
  "created_at_attr",
  "created_by_username",
  "created_by_display_name",
  "sync_status",
  "pending_delete",
  "attributes",
  "created_at",
];

function groupColValue(row, col) {
  if (col === "attributes") return JSON.stringify(row.attributes || {});
  if (col === "is_private" || col === "is_superuser" || col === "pending_delete") {
    return !!row[col];
  }
  return row[col] == null ? null : row[col];
}

async function upsertGroupRow(row, idMap) {
  const name = String(row.name || "").trim();
  if (!name) return { action: "skip" };
  const found = await db.query("SELECT id FROM groups WHERE lower(name) = lower($1) LIMIT 1", [
    name,
  ]);
  const vals = GROUP_COLS.map((c) => groupColValue(row, c));
  if (found.rows[0]) {
    const id = found.rows[0].id;
    idMap.set(String(row.id), id);
    const sets = GROUP_COLS.map((c, i) =>
      `${c} = $${i + 2}${c === "attributes" ? "::jsonb" : ""}`
    ).join(", ");
    await db.query(`UPDATE groups SET ${sets}, updated_at = now() WHERE id = $1`, [
      id,
      ...vals,
    ]);
    return { action: "update", id };
  }
  try {
    await db.query(
      `INSERT INTO groups (id, ${GROUP_COLS.join(",")}) VALUES ($1, ${GROUP_COLS.map((c, i) =>
        c === "attributes" ? `$${i + 2}::jsonb` : `$${i + 2}`
      ).join(",")})`,
      [row.id, ...vals]
    );
    idMap.set(String(row.id), row.id);
    return { action: "create", id: row.id };
  } catch (_) {
    const r = await db.query(
      `INSERT INTO groups (${GROUP_COLS.join(",")}) VALUES (${GROUP_COLS.map((c, i) =>
        c === "attributes" ? `$${i + 1}::jsonb` : `$${i + 1}`
      ).join(",")}) RETURNING id`,
      vals
    );
    const id = r.rows[0].id;
    idMap.set(String(row.id), id);
    return { action: "create", id };
  }
}

async function restoreMemberships(memberships, dryRun, report) {
  for (const m of memberships || []) {
    const username = String(m.username || "").trim();
    const groupName = String(m.group_name || "").trim();
    if (!username || !groupName) {
      bump(report, "users", "skip");
      continue;
    }
    if (dryRun) continue;
    const u = await db.query("SELECT id FROM users WHERE lower(username) = lower($1)", [
      username,
    ]);
    const g = await db.query("SELECT id FROM groups WHERE lower(name) = lower($1) LIMIT 1", [
      groupName,
    ]);
    if (!u.rows[0] || !g.rows[0]) {
      bump(report, "users", "skip");
      continue;
    }
    await db.query(
      "INSERT INTO group_members (user_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [u.rows[0].id, g.rows[0].id]
    );
  }
}

async function syncGroupAuthentik(row, localId, dryRun, report) {
  try {
    const existing = await ak.findGroupByName(row.name);
    if (dryRun) {
      return existing ? String(existing.pk) : null;
    }
    let pk;
    if (existing) {
      if (!dryRun) {
        await ak.patchGroup(existing.pk, {
          attributes: row.attributes || {},
          is_superuser: !!row.is_superuser,
        });
      }
      pk = String(existing.pk);
    } else {
      const created = await ak.createGroup(row.name, row.attributes || {});
      pk = String(created.pk);
    }
    await db.query(
      "UPDATE groups SET authentik_pk = $2, sync_status = 'ok', updated_at = now() WHERE id = $1",
      [localId, pk]
    );
    return pk;
  } catch (e) {
    addError(report, "groups", `${row.name}: Authentik ${e.message}`);
    if (!dryRun && localId) {
      await db.query("UPDATE groups SET sync_status = 'error', updated_at = now() WHERE id = $1", [
        localId,
      ]);
    }
    return null;
  }
}

async function syncUserAuthentik(row, localId, groupPks, dryRun, report, sendMail) {
  try {
    const existing = await ak.findUserByUsername(row.username);
    if (dryRun) {
      return existing ? String(existing.pk) : null;
    }
    const patch = {
      email: row.email || "",
      name: row.name || "",
      is_active: row.is_active !== false,
      attributes: row.attributes || {},
    };
    if (row.path) patch.path = row.path;
    if (groupPks && groupPks.length) patch.groups = groupPks;
    let pk;
    let created = false;
    if (existing) {
      await ak.patchUser(existing.pk, patch);
      pk = String(existing.pk);
    } else {
      const createdUser = await ak.createUser({
        username: row.username,
        email: row.email,
        name: row.name,
        isActive: row.is_active !== false,
        attributes: row.attributes || {},
        path: row.path,
      });
      pk = String(createdUser.pk);
      created = true;
      if (groupPks && groupPks.length) {
        await ak.patchUser(pk, { groups: groupPks });
      }
    }
    await db.query(
      "UPDATE users SET authentik_pk = $2, sync_status = 'ok', updated_at = now() WHERE id = $1",
      [localId, pk]
    );
    if (created && sendMail) {
      await maybeSendRestoreEmail(row);
    }
    return pk;
  } catch (e) {
    addError(report, "users", `${row.username}: Authentik ${e.message}`);
    if (!dryRun && localId) {
      await db.query("UPDATE users SET sync_status = 'error', updated_at = now() WHERE id = $1", [
        localId,
      ]);
    }
    return null;
  }
}

async function maybeSendRestoreEmail(user) {
  try {
    const { getBool, getString } = require("../env");
    if (!getBool("EMAIL_ENABLED", false)) return false;
    const to = String(user.email || "").trim();
    if (!to) return false;
    const email = require("../email.service");
    const publicUrl =
      getString("AUTHENTIK_PUBLIC_URL", "") || getString("TAK_PORTAL_PUBLIC_URL", "");
    await email.sendMail({
      to,
      subject: "TAK Portal account restored",
      text:
        `Your TAK Portal account (${user.username}) was restored onto a server. ` +
        `Your previous password was not transferred. Use Forgot password in Authentik` +
        (publicUrl ? ` (${publicUrl})` : "") +
        ` or ask an administrator to set a password.`,
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function authentikGroupPksForUser(username, memberships, groupPkByName) {
  const names = (memberships || [])
    .filter((m) => String(m.username || "").toLowerCase() === String(username).toLowerCase())
    .map((m) => String(m.group_name || "").trim())
    .filter(Boolean);
  const pks = [];
  for (const n of names) {
    const pk = groupPkByName.get(n.toLowerCase());
    if (pk) pks.push(pk);
  }
  return pks;
}

async function applyCategory(id, payload, ctx) {
  const { dryRun, report, includeSecrets, selectedSet } = ctx;
  if (!payload) {
    bump(report, id, "skip");
    return;
  }

  if (catalog.isSettingsCategory(id) || id === "email_templates" || id === "branding_assets") {
    if (payload.skippedSecrets) {
      bump(report, id, "skip");
      return;
    }
    const n = applySettingsValues(payload.values || {}, dryRun);
    if (n) bump(report, id, "update", n);
    else bump(report, id, "skip");
    return;
  }

  if (id === "regions") {
    await applySimpleRows("regions", "id", payload.regions, ["extra"], dryRun, report, id);
    await applySimpleRows(
      "region_county_locks",
      "id",
      payload.locks,
      ["extra"],
      dryRun,
      report,
      id
    );
    return;
  }

  if (id === "agencies") {
    await applySimpleRows(
      "agencies",
      "suffix",
      payload.rows,
      ["allowed_admin_group_ids", "agency_disabled_user_ids", "admin_groups", "extra"],
      dryRun,
      report,
      id
    );
    return;
  }

  if (id === "templates") {
    await applySimpleRows(
      "agency_templates",
      "id",
      payload.rows,
      ["groups", "extra"],
      dryRun,
      report,
      id
    );
    return;
  }

  if (id === "auto_create_ledgers") {
    if (dryRun) {
      bump(report, id, "update", (payload.groups || []).length + (payload.dataSync || []).length);
      return;
    }
    for (const row of payload.groups || []) {
      await db.query(
        `INSERT INTO auto_create_groups (scope, key, payload) VALUES ($1,$2,$3::jsonb)
         ON CONFLICT (scope, key) DO UPDATE SET payload = EXCLUDED.payload`,
        [row.scope, row.key, JSON.stringify(row.payload || {})]
      );
      bump(report, id, "update");
    }
    for (const row of payload.dataSync || []) {
      await db.query(
        `INSERT INTO auto_create_data_sync (scope, key, payload) VALUES ($1,$2,$3::jsonb)
         ON CONFLICT (scope, key) DO UPDATE SET payload = EXCLUDED.payload`,
        [row.scope, row.key, JSON.stringify(row.payload || {})]
      );
      bump(report, id, "update");
    }
    return;
  }

  if (id === "groups") {
    ctx.groupIdMap = ctx.groupIdMap || new Map();
    ctx.groupPkByName = ctx.groupPkByName || new Map();
    for (const row of payload.groups || []) {
      if (dryRun) {
        const existing = await db.query(
          "SELECT id FROM groups WHERE lower(name) = lower($1) LIMIT 1",
          [row.name]
        );
        bump(report, id, existing.rows[0] ? "update" : "create");
        if (ctx.syncAuthentik) await syncGroupAuthentik(row, null, true, report);
        continue;
      }
      const out = await upsertGroupRow(row, ctx.groupIdMap);
      bump(report, id, out.action);
      if (out.id && ctx.syncAuthentik) {
        const pk = await syncGroupAuthentik(row, out.id, false, report);
        if (pk) ctx.groupPkByName.set(String(row.name).toLowerCase(), pk);
      } else if (out.id) {
        const g = await db.query("SELECT authentik_pk FROM groups WHERE id = $1", [out.id]);
        if (g.rows[0]?.authentik_pk) {
          ctx.groupPkByName.set(String(row.name).toLowerCase(), String(g.rows[0].authentik_pk));
        }
      }
    }
    return;
  }

  if (id === "users" || id === "integrations") {
    const users = payload.users || [];
    const memberships = payload.memberships || [];
    ctx.userIdMap = ctx.userIdMap || new Map();
    const skipIfUsers =
      id === "integrations" && selectedSet.has("users");
    if (skipIfUsers) {
      bump(report, id, "skip", users.length);
      return;
    }
    const reportId = id === "integrations" ? "integrations" : "users";
    for (const row of users) {
      if (dryRun) {
        const existing = await db.query(
          "SELECT id FROM users WHERE lower(username) = lower($1)",
          [row.username]
        );
        bump(report, reportId, existing.rows[0] ? "update" : "create");
        if (ctx.syncAuthentik) {
          await syncUserAuthentik(row, null, [], true, report, false);
        }
        continue;
      }
      const out = await upsertUserRow(row, ctx.userIdMap);
      bump(report, reportId, out.action);
      if (out.id && ctx.syncAuthentik) {
        const groupPks = await authentikGroupPksForUser(
          row.username,
          memberships,
          ctx.groupPkByName || new Map()
        );
        await syncUserAuthentik(row, out.id, groupPks, false, report, ctx.sendOnboardingEmail);
      }
    }
    if (id === "users") await restoreMemberships(memberships, dryRun, report);
    else if (!skipIfUsers) await restoreMemberships(memberships, dryRun, report);
    return;
  }

  if (id === "access_roles") {
    await applySimpleRows(
      "permission_overrides",
      "username",
      payload.rows,
      ["allow", "deny"],
      dryRun,
      report,
      id
    );
    return;
  }

  if (id === "user_requests") {
    await applySimpleRows("user_requests", "id", payload.rows, ["payload"], dryRun, report, id);
    return;
  }

  if (id === "mutual_aid") {
    const cryptoKeyPresent = String(
      settingsSvc.get("MUTUAL_AID_ENCRYPTION_KEY", "") || ""
    ).trim();
    const rows = (payload.rows || []).map((r) => {
      if (!includeSecrets || !cryptoKeyPresent) return { ...r, password_enc: r.password_enc && includeSecrets && cryptoKeyPresent ? r.password_enc : null };
      return r;
    });
    await applySimpleRows("mutual_aid", "id", rows, ["extra"], dryRun, report, id);
    return;
  }

  if (id === "channel_patches") {
    await applySimpleRows("channel_patches", "id", payload.rows, ["payload"], dryRun, report, id);
    return;
  }

  if (id === "geofences") {
    await applySimpleRows("geofences", "id", payload.rows, ["payload"], dryRun, report, id);
    return;
  }

  if (id === "locate") {
    await applySimpleRows("locators", "id", payload.rows, ["payload"], dryRun, report, id);
    return;
  }

  if (id === "locate_pings") {
    await applySimpleRows("locator_pings", "id", payload.rows, ["payload"], dryRun, report, id);
    return;
  }

  if (id === "mou") {
    await applySimpleRows("mou_streams", "id", payload.streams, ["payload"], dryRun, report, id);
    await applySimpleRows(
      "mou_user_agreement",
      "id",
      payload.agreement,
      ["payload"],
      dryRun,
      report,
      id
    );
    await applySimpleRows("mou_archived", "archive_id", payload.archived, ["payload"], dryRun, report, id);
    if (dryRun) {
      bump(report, id, "update", (payload.acks || []).length);
    } else {
      for (const row of payload.acks || []) {
        await db.query(
          `INSERT INTO mou_acks (user_key, version_id, at, payload)
           VALUES ($1,$2,$3,$4::jsonb)
           ON CONFLICT (user_key, version_id) DO UPDATE SET at = EXCLUDED.at, payload = EXCLUDED.payload`,
          [row.user_key, row.version_id, row.at, JSON.stringify(row.payload || {})]
        );
        bump(report, id, "update");
      }
    }
    await applySimpleRows("mou_views", "key", payload.views, ["payload"], dryRun, report, id);
    await applySimpleRows("mou_reminders", "key", payload.reminders, ["payload"], dryRun, report, id);
    await applySimpleRows(
      "mou_sign_invites",
      "invite_id",
      payload.invites,
      ["payload"],
      dryRun,
      report,
      id
    );
    return;
  }

  if (id === "audit_log") {
    await applySimpleRows("audit_events", "id", payload.rows, ["actor", "request", "details"], dryRun, report, id);
    return;
  }

  if (id === "plugins") {
    bump(report, id, dryRun ? "update" : "update");
  }
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new Error("Backup manifest is missing");
  const version = Number(manifest.version);
  if (version !== catalog.MANIFEST_VERSION) {
    throw new Error(
      `Unsupported backup version ${manifest.version}. This portal reads version ${catalog.MANIFEST_VERSION}.`
    );
  }
  return manifest;
}

async function inspectArchive(srcPath, passphrase) {
  const encrypted = files.peekIsEncrypted(srcPath);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tak-backup-in-"));
  try {
    const zipPath = files.maybeDecryptToZip(srcPath, passphrase, tmp);
    const buf = await files.readZipEntryBuffer(zipPath, "manifest.json");
    if (!buf) throw new Error("Archive has no manifest.json");
    const manifest = validateManifest(JSON.parse(buf.toString("utf8")));
    return { encrypted, manifest };
  } finally {
    files.rmrf(tmp);
  }
}

async function runImport({
  archivePath,
  passphrase,
  categories,
  mode,
  dryRun,
  includeSecrets,
  sendOnboardingEmail,
  onProgress,
}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tak-backup-im-"));
  const directorySync = require("../directorySync.service");
  let paused = false;
  const report = {};
  try {
    if (onProgress) {
      await onProgress({ phase: "unpack", percent: 5, message: "Reading archive" });
    }
    const zipPath = files.maybeDecryptToZip(archivePath, passphrase, tmp);
    await files.extractZip(zipPath, tmp);
    const manifest = validateManifest(readJson(files.findManifestPath(tmp), null));
    const available = new Set(manifest.categories || []);
    const requested = catalog.orderedSelected(
      catalog.resolveDependencies(categories && categories.length ? categories : [...available], {
        allowMissing: true,
      }).selected
    );
    const selected = requested.filter((id) => available.has(id));
    if (!selected.length) throw new Error("No selected categories are present in this archive");

    const secrets = includeSecrets !== undefined ? !!includeSecrets : !!manifest.includeSecrets;
    const categoriesRoot = files.findCategoriesRoot(tmp);
    const replace = String(mode || "merge").toLowerCase() === "replace";

    const needsAk = selected.some((id) => id === "users" || id === "groups" || id === "integrations");
    let syncAuthentik = false;
    if (needsAk) {
      try {
        await ak.pingAuthentik();
        syncAuthentik = true;
      } catch (e) {
        addError(
          report,
          "groups",
          "Authentik unreachable: " + (e.message || e) + ". Directory objects will be local-only."
        );
      }
    }

    if (!dryRun && replace) await replaceTables(selected);
    if (!dryRun) {
      directorySync.pauseInboundSnapshot();
      paused = true;
    }

    const ctx = {
      dryRun: !!dryRun,
      report,
      includeSecrets: secrets,
      selectedSet: new Set(selected),
      syncAuthentik,
      sendOnboardingEmail: !!sendOnboardingEmail,
      groupIdMap: new Map(),
      userIdMap: new Map(),
      groupPkByName: new Map(),
    };

    const total = selected.length + 1;
    for (let i = 0; i < selected.length; i++) {
      const id = selected[i];
      if (onProgress) {
        await onProgress({
          phase: dryRun ? "dry-run" : "import",
          percent: Math.round(((i + 1) / total) * 90),
          message: (dryRun ? "Checking " : "Importing ") + id,
          category: id,
        });
      }
      const payload = loadCategory(categoriesRoot, id);
      await applyCategory(id, payload, ctx);
    }

    if (!dryRun) {
      if (onProgress) {
        await onProgress({ phase: "files", percent: 94, message: "Restoring files" });
      }
      files.restoreExtractedFiles(tmp, secrets);
      try {
        const pgCache = require("../pgCache");
        await pgCache.hydrate();
      } catch (_) {}
    }

    if (onProgress) {
      await onProgress({ phase: "complete", percent: 100, message: dryRun ? "Dry run complete" : "Import complete" });
    }
    return {
      dryRun: !!dryRun,
      mode: replace ? "replace" : "merge",
      categories: selected,
      report,
      warnings: selected.filter((id) => (report[id]?.errors || []).length).map((id) => id),
    };
  } finally {
    if (paused) {
      try {
        directorySync.resumeInboundSnapshot();
      } catch (_) {}
    }
    files.rmrf(tmp);
  }
}

module.exports = {
  validateManifest,
  inspectArchive,
  runImport,
};
