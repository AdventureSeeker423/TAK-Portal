"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const db = require("../db");
const settingsSvc = require("../settings.service");
const pkg = require("../../package.json");
const catalog = require("./catalog");
const files = require("./files");

function serializeRow(row) {
  const o = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (v instanceof Date) o[k] = v.toISOString();
    else o[k] = v;
  }
  return o;
}

async function dumpQuery(sql, params = []) {
  const r = await db.query(sql, params);
  return r.rows.map(serializeRow);
}

function writeCategory(staging, id, payload) {
  const dir = path.join(staging, "categories");
  files.ensureDir(dir);
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(payload, null, 2));
}

function countOf(payload) {
  if (!payload || typeof payload !== "object") return 0;
  if (Array.isArray(payload)) return payload.length;
  if (Array.isArray(payload.rows)) return payload.rows.length;
  if (Array.isArray(payload.users)) return payload.users.length;
  if (Array.isArray(payload.groups)) return payload.groups.length;
  if (Array.isArray(payload.items)) return payload.items.length;
  if (payload.values && typeof payload.values === "object") {
    return Object.keys(payload.values).length;
  }
  return Object.keys(payload).length;
}

async function exportCategory(id, { includeSecrets, staging }) {
  const cat = catalog.getCategory(id);
  if (!cat) return { count: 0 };
  const filesDir = path.join(staging, "files");
  files.ensureDir(filesDir);

  if (id === "regions") {
    const payload = {
      regions: await dumpQuery("SELECT * FROM regions ORDER BY name"),
      locks: await dumpQuery("SELECT * FROM region_county_locks"),
    };
    writeCategory(staging, id, payload);
    return { count: payload.regions.length + payload.locks.length };
  }

  if (id === "agencies") {
    const rows = await dumpQuery("SELECT * FROM agencies ORDER BY suffix");
    writeCategory(staging, id, { rows });
    return { count: rows.length };
  }

  if (id === "templates") {
    const rows = await dumpQuery("SELECT * FROM agency_templates ORDER BY name");
    writeCategory(staging, id, { rows });
    return { count: rows.length };
  }

  if (id === "groups") {
    const groups = await dumpQuery(
      "SELECT * FROM groups WHERE pending_delete = false ORDER BY name"
    );
    writeCategory(staging, id, { groups });
    return { count: groups.length };
  }

  if (id === "users") {
    const users = await dumpQuery(
      "SELECT * FROM users WHERE pending_delete = false ORDER BY username"
    );
    const memberships = await dumpQuery(
      `SELECT u.username, g.name AS group_name
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id
       JOIN groups g ON g.id = gm.group_id
       WHERE u.pending_delete = false AND g.pending_delete = false
       ORDER BY u.username, g.name`
    );
    writeCategory(staging, id, { users, memberships });
    return { count: users.length };
  }

  if (id === "access_roles") {
    const rows = await dumpQuery("SELECT username, allow, deny FROM permission_overrides");
    writeCategory(staging, id, { rows });
    return { count: rows.length };
  }

  if (id === "user_requests") {
    const rows = await dumpQuery("SELECT * FROM user_requests");
    writeCategory(staging, id, { rows });
    return { count: rows.length };
  }

  if (id === "integrations") {
    const users = await dumpQuery(
      `SELECT * FROM users
       WHERE pending_delete = false AND lower(username) LIKE 'nodered-%'
       ORDER BY username`
    );
    const memberships = await dumpQuery(
      `SELECT u.username, g.name AS group_name
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id
       JOIN groups g ON g.id = gm.group_id
       WHERE u.pending_delete = false AND lower(u.username) LIKE 'nodered-%'`
    );
    const n = files.copyDataRelIntoStaging(filesDir, "integration-certs", includeSecrets);
    writeCategory(staging, id, { users, memberships, filesCopied: n });
    return { count: users.length };
  }

  if (id === "mutual_aid") {
    let rows = await dumpQuery("SELECT * FROM mutual_aid");
    if (!includeSecrets) {
      rows = rows.map((r) => ({ ...r, password_enc: "" }));
    }
    files.copyDataRelIntoStaging(filesDir, "mutual-aid-logos", true);
    writeCategory(staging, id, { rows });
    return { count: rows.length };
  }

  if (id === "channel_patches") {
    const rows = await dumpQuery("SELECT * FROM channel_patches");
    writeCategory(staging, id, { rows });
    return { count: rows.length };
  }

  if (id === "geofences") {
    const rows = await dumpQuery("SELECT * FROM geofences");
    writeCategory(staging, id, { rows });
    return { count: rows.length };
  }

  if (id === "locate") {
    const rows = await dumpQuery("SELECT * FROM locators");
    writeCategory(staging, id, { rows });
    return { count: rows.length };
  }

  if (id === "locate_pings") {
    const rows = await dumpQuery("SELECT * FROM locator_pings ORDER BY at");
    writeCategory(staging, id, { rows });
    return { count: rows.length };
  }

  if (id === "mou") {
    const payload = {
      streams: await dumpQuery("SELECT * FROM mou_streams"),
      agreement: await dumpQuery("SELECT * FROM mou_user_agreement"),
      archived: await dumpQuery("SELECT * FROM mou_archived"),
      acks: await dumpQuery("SELECT * FROM mou_acks"),
      views: await dumpQuery("SELECT * FROM mou_views"),
      reminders: await dumpQuery("SELECT * FROM mou_reminders"),
      invites: await dumpQuery("SELECT * FROM mou_sign_invites"),
    };
    files.copyDataRelIntoStaging(filesDir, "mou", true);
    writeCategory(staging, id, payload);
    return {
      count:
        payload.streams.length +
        payload.acks.length +
        payload.archived.length +
        payload.invites.length,
    };
  }

  if (id === "plugins") {
    const n = files.copyDataRelIntoStaging(filesDir, "plugins", true);
    const manifestRel = "plugin-manifest.json";
    const abs = path.join(files.DATA_DIR, manifestRel);
    if (fs.existsSync(abs)) {
      let manifest = {};
      try {
        manifest = JSON.parse(fs.readFileSync(abs, "utf8"));
      } catch (_) {}
      if (!includeSecrets && manifest && manifest.takGovLink) {
        manifest = {
          ...manifest,
          takGovLink: {
            ...manifest.takGovLink,
            refreshToken: null,
            deviceCode: null,
            accessToken: null,
          },
        };
      }
      const dest = path.join(filesDir, manifestRel);
      files.ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, JSON.stringify(manifest, null, 2));
    }
    writeCategory(staging, id, { filesCopied: n });
    return { count: n };
  }

  if (id === "auto_create_ledgers") {
    const payload = {
      groups: await dumpQuery("SELECT * FROM auto_create_groups"),
      dataSync: await dumpQuery("SELECT * FROM auto_create_data_sync"),
    };
    writeCategory(staging, id, payload);
    return { count: payload.groups.length + payload.dataSync.length };
  }

  if (id === "email_templates" || id === "branding_assets" || catalog.isSettingsCategory(id)) {
    if (cat.requiresSecrets && !includeSecrets) {
      writeCategory(staging, id, { values: {}, skippedSecrets: true });
      return { count: 0 };
    }
    const settings = settingsSvc.getSettings() || {};
    const keys = [...(cat.keys || []), ...(cat.settingsKeys || [])];
    const values = catalog.pickSettingsKeys(settings, keys, includeSecrets);
    for (const rel of cat.files || []) {
      files.copyDataRelIntoStaging(filesDir, rel, includeSecrets);
    }
    writeCategory(staging, id, { values });
    return { count: Object.keys(values).length };
  }

  if (id === "audit_log") {
    const rows = await dumpQuery("SELECT * FROM audit_events ORDER BY timestamp");
    writeCategory(staging, id, { rows });
    return { count: rows.length };
  }

  return { count: 0 };
}

async function runExport({ categories, includeSecrets, passphrase, onProgress }) {
  const resolved = catalog.resolveDependencies(categories, { allowMissing: true });
  const selected = catalog.orderedSelected(resolved.selected);
  const unknown = catalog.unknownCategoryIds(categories);
  if (unknown.length) throw new Error("Unknown categories: " + unknown.join(", "));
  if (!selected.length) throw new Error("Select at least one category to export");

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "tak-backup-ex-"));
  const counts = {};
  try {
    files.ensureDir(path.join(staging, "categories"));
    files.ensureDir(path.join(staging, "files"));
    const total = selected.length;
    for (let i = 0; i < selected.length; i++) {
      const id = selected[i];
      if (onProgress) {
        await onProgress({
          phase: "export",
          percent: Math.round((i / total) * 80),
          message: "Exporting " + id,
          category: id,
        });
      }
      const out = await exportCategory(id, { includeSecrets: !!includeSecrets, staging });
      counts[id] = out.count;
    }

    const manifest = {
      version: catalog.MANIFEST_VERSION,
      appVersion: pkg.version || "",
      createdAt: new Date().toISOString(),
      categories: selected,
      includeSecrets: !!includeSecrets,
      encrypted: !!String(passphrase || "").trim(),
      counts,
    };
    fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));

    if (onProgress) {
      await onProgress({ phase: "zip", percent: 85, message: "Compressing archive" });
    }
    files.ensureDir(files.BACKUPS_DIR);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const zipName = `tak-portal-backup-${stamp}.zip`;
    const zipPath = path.join(files.BACKUPS_DIR, zipName);
    await files.zipDirectory(staging, zipPath);

    let artifactPath = zipPath;
    if (String(passphrase || "").trim()) {
      if (onProgress) {
        await onProgress({ phase: "encrypt", percent: 93, message: "Encrypting archive" });
      }
      const encPath = path.join(files.BACKUPS_DIR, `tak-portal-backup-${stamp}.takbackup`);
      await files.encryptFileTo(zipPath, encPath, passphrase);
      try {
        fs.unlinkSync(zipPath);
      } catch (_) {}
      artifactPath = encPath;
      manifest.encrypted = true;
    }

    files.cleanupOldBackups();
    if (onProgress) {
      await onProgress({ phase: "complete", percent: 100, message: "Export complete" });
    }
    return {
      artifactPath,
      downloadName: path.basename(artifactPath),
      manifest,
      counts,
    };
  } finally {
    files.rmrf(staging);
  }
}

module.exports = {
  runExport,
  serializeRow,
};
