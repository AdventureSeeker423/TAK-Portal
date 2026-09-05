const db = require("./db");

const caches = {
  agencies: [],
  templates: [],
  regions: [],
  locks: [],
  userRequests: [],
  mutualAid: [],
  permissionOverrides: {},
  autoCreateGroups: { county: {}, state: {}, region: {} },
  autoCreateDataSync: { county: {}, state: {} },
  channelPatches: [],
  locators: { locators: [], history: [] },
  geofences: { fences: [], updatedAt: null },
  geofenceState: { membership: {}, updatedAt: null },
  mouIndex: { schemaVersion: 1, streams: [] },
  mouAgreement: { schemaVersion: 1, currentVersion: 0, versions: [] },
  mouAcks: { schemaVersion: 1, items: [] },
  mouViews: { schemaVersion: 1, items: [] },
  mouReminders: { schemaVersion: 1, agency: {} },
  mouArchived: { schemaVersion: 1, items: [] },
  mouInvites: { schemaVersion: 1, items: [] },
};

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function rowToAgency(r) {
  const extra = r.extra && typeof r.extra === "object" ? r.extra : {};
  return {
    ...extra,
    name: r.name,
    type: r.type,
    county: r.county,
    countyAbbrev: r.county_abbrev,
    state: r.state,
    suffix: r.suffix,
    groupPrefix: r.group_prefix,
    color: r.color,
    stateFederalAgency: r.state_federal_agency,
    usernameTokenPlacement: r.username_token_placement,
    allowedAdminGroupIds: r.allowed_admin_group_ids || [],
    isActive: r.is_active,
    agencyDisabledUserIds: r.agency_disabled_user_ids || [],
    regionId: r.region_id,
    lookupDomain: r.lookup_domain,
    lookupEnabled: r.lookup_enabled,
    autoApproveRequests: r.auto_approve_requests === true,
    adminGroups: r.admin_groups,
  };
}

function agencyToRow(a) {
  const known = new Set([
    "name", "type", "county", "countyAbbrev", "state", "suffix", "groupPrefix",
    "color", "stateFederalAgency", "usernameTokenPlacement", "allowedAdminGroupIds",
    "isActive", "agencyDisabledUserIds", "regionId", "lookupDomain", "lookupEnabled",
    "autoApproveRequests", "adminGroups",
  ]);
  const extra = {};
  for (const [k, v] of Object.entries(a || {})) {
    if (!known.has(k)) extra[k] = v;
  }
  return extra;
}

async function hydrate() {
  if (!db.isConfigured()) return;
  const cryptoSecrets = require("./cryptoSecrets");
  const [ag, tmpl, regions, locks, reqs, ma, perms, acg, acds, patches, locs, pings, fences, members, streams, agreement, acks, views, reminders, archived, invites] =
    await Promise.all([
      db.query("SELECT * FROM agencies ORDER BY name NULLS LAST"),
      db.query("SELECT * FROM agency_templates"),
      db.query("SELECT * FROM regions"),
      db.query("SELECT * FROM region_county_locks"),
      db.query("SELECT payload FROM user_requests"),
      db.query("SELECT * FROM mutual_aid"),
      db.query("SELECT username, allow, deny FROM permission_overrides"),
      db.query("SELECT scope, key, payload FROM auto_create_groups"),
      db.query("SELECT scope, key, payload FROM auto_create_data_sync"),
      db.query("SELECT payload FROM channel_patches"),
      db.query("SELECT id, slug, payload FROM locators"),
      db.query("SELECT locator_id, payload FROM locator_pings ORDER BY at DESC"),
      db.query("SELECT payload FROM geofences"),
      db.query("SELECT fence_id, client_uid, inside, last_enter_at, last_seen_at, last_exit_at FROM geofence_memberships"),
      db.query("SELECT payload FROM mou_streams"),
      db.query("SELECT payload FROM mou_user_agreement WHERE id = 1"),
      db.query("SELECT payload FROM mou_acks"),
      db.query("SELECT payload FROM mou_views"),
      db.query("SELECT key, last_sent_at, payload FROM mou_reminders"),
      db.query("SELECT payload FROM mou_archived"),
      db.query("SELECT payload FROM mou_sign_invites"),
    ]);

  caches.agencies = ag.rows.map(rowToAgency);
  caches.templates = tmpl.rows.map((r) => ({
    ...(r.extra && typeof r.extra === "object" ? r.extra : {}),
    name: r.name,
    agencySuffix: r.agency_suffix,
    colorOverride: r.color_override,
    role: r.role,
    groups: r.groups || [],
    isDefault: r.is_default,
  }));
  caches.regions = regions.rows.map((r) => ({ id: r.id, name: r.name, ...(r.extra || {}) }));
  caches.locks = locks.rows.map((r) => ({
    scope: r.scope,
    regionId: r.region_id,
    state: r.state,
    county: r.county,
    ...(r.extra || {}),
  }));
  caches.userRequests = reqs.rows.map((r) => r.payload);
  caches.mutualAid = ma.rows.map((r) => {
    let password = "";
    try {
      password = r.password_enc ? cryptoSecrets.decryptSecret(r.password_enc) : "";
    } catch (_) {
      password = "";
    }
    return {
      ...(r.extra && typeof r.extra === "object" ? r.extra : {}),
      id: r.id,
      type: r.type,
      title: r.title,
      groupId: r.group_id,
      groupName: r.group_name,
      groupMode: r.group_mode,
      groupWasCreated: r.group_was_created,
      groupMasterId: r.group_master_id,
      userId: r.user_id,
      username: r.username,
      password,
      expireEnabled: r.expire_enabled,
      expireAt: r.expire_at,
      logoUrl: r.logo_url,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
  const po = {};
  for (const r of perms.rows) {
    po[r.username] = { allow: r.allow || [], deny: r.deny || [] };
  }
  caches.permissionOverrides = po;

  const acgLed = { county: {}, state: {}, region: {} };
  for (const r of acg.rows) {
    if (acgLed[r.scope]) acgLed[r.scope][r.key] = r.payload;
  }
  caches.autoCreateGroups = acgLed;
  const acdsLed = { county: {}, state: {} };
  for (const r of acds.rows) {
    if (acdsLed[r.scope]) acdsLed[r.scope][r.key] = r.payload;
  }
  caches.autoCreateDataSync = acdsLed;

  caches.channelPatches = patches.rows.map((r) => r.payload);
  const history = pings.rows.map((r) => ({ locatorId: r.locator_id, ...(r.payload || {}) }));
  caches.locators = {
    locators: locs.rows.map((r) => ({ id: r.id, slug: r.slug, ...(r.payload || {}) })),
    history,
  };
  caches.geofences = {
    fences: fences.rows.map((r) => r.payload),
    updatedAt: new Date().toISOString(),
  };
  const membership = {};
  for (const r of members.rows) {
    if (!membership[r.fence_id]) membership[r.fence_id] = {};
    membership[r.fence_id][r.client_uid] = {
      inside: r.inside,
      lastEnterAt: r.last_enter_at,
      lastSeenAt: r.last_seen_at,
      lastExitAt: r.last_exit_at,
    };
  }
  caches.geofenceState = { membership, updatedAt: new Date().toISOString() };

  caches.mouIndex = { schemaVersion: 1, streams: streams.rows.map((r) => r.payload) };
  caches.mouAgreement = agreement.rows[0]?.payload || { schemaVersion: 1, currentVersion: 0, versions: [] };
  caches.mouAcks = { schemaVersion: 1, items: acks.rows.map((r) => r.payload) };
  caches.mouViews = { schemaVersion: 1, items: views.rows.map((r) => r.payload) };
  const agency = {};
  for (const r of reminders.rows) agency[r.key] = r.payload || { lastSentAt: r.last_sent_at };
  caches.mouReminders = { schemaVersion: 1, agency };
  caches.mouArchived = { schemaVersion: 1, items: archived.rows.map((r) => r.payload) };
  caches.mouInvites = { schemaVersion: 1, items: invites.rows.map((r) => r.payload) };
}

function persistCatch(label, fn) {
  if (!db.isConfigured()) return Promise.resolve();
  const p = Promise.resolve().then(fn);
  p.catch((e) => console.error(`[pg-cache] ${label} persist failed:`, e?.message || e));
  return p;
}

async function persistAgenciesSql(list) {
  await db.withTransaction(async (c) => {
    await c.query("DELETE FROM agencies");
    for (const a of list || []) {
      const suffix = String(a.suffix || "").trim();
      if (!suffix) continue;
      await c.query(
        `INSERT INTO agencies (
          suffix, name, type, county, county_abbrev, state, group_prefix, color,
          state_federal_agency, username_token_placement, allowed_admin_group_ids,
          is_active, agency_disabled_user_ids, region_id, lookup_domain, lookup_enabled,
          auto_approve_requests, admin_groups, extra, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb,$14,$15,$16,$17,$18::jsonb,$19::jsonb, now())`,
        [
          suffix,
          a.name || null,
          a.type || null,
          a.county || null,
          a.countyAbbrev || null,
          a.state || null,
          a.groupPrefix || null,
          a.color || null,
          !!a.stateFederalAgency,
          a.usernameTokenPlacement || null,
          JSON.stringify(a.allowedAdminGroupIds || []),
          a.isActive !== false,
          JSON.stringify(a.agencyDisabledUserIds || []),
          a.regionId || null,
          a.lookupDomain || null,
          !!a.lookupEnabled,
          !!a.autoApproveRequests,
          a.adminGroups != null ? JSON.stringify(a.adminGroups) : null,
          JSON.stringify(agencyToRow(a)),
        ]
      );
    }
  });
}

async function replaceAgencies(list) {
  caches.agencies = clone(list || []);
  return persistCatch("agencies", () => persistAgenciesSql(caches.agencies));
}

async function persistTemplatesSql(list) {
  await db.withTransaction(async (c) => {
    await c.query("DELETE FROM agency_templates");
    for (const t of list || []) {
      await c.query(
        `INSERT INTO agency_templates (name, agency_suffix, color_override, role, groups, is_default, extra)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,'{}'::jsonb)`,
        [t.name || null, t.agencySuffix || null, t.colorOverride || null, t.role || null, JSON.stringify(t.groups || []), !!t.isDefault]
      );
    }
  });
}

async function replaceTemplates(list) {
  caches.templates = clone(list || []);
  return persistCatch("templates", () => persistTemplatesSql(caches.templates));
}

async function persistRegionsSql(list) {
  await db.withTransaction(async (c) => {
    await c.query("DELETE FROM regions");
    for (const r of list || []) {
      const id = String(r.id || "").trim();
      if (!id) continue;
      await c.query("INSERT INTO regions (id, name, extra) VALUES ($1,$2,$3::jsonb)", [
        id,
        r.name || id,
        JSON.stringify(r),
      ]);
    }
  });
}

async function replaceRegions(list) {
  caches.regions = clone(list || []);
  return persistCatch("regions", () => persistRegionsSql(caches.regions));
}

async function persistLocksSql(list) {
  await db.withTransaction(async (c) => {
    await c.query("DELETE FROM region_county_locks");
    for (const r of list || []) {
      await c.query(
        `INSERT INTO region_county_locks (scope, region_id, state, county, extra)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [r.scope || "state", r.regionId || null, r.state || null, r.county || null, JSON.stringify(r)]
      );
    }
  });
}

async function replaceLocks(list) {
  caches.locks = clone(list || []);
  return persistCatch("locks", () => persistLocksSql(caches.locks));
}

async function persistUserRequestsSql(list) {
  await db.withTransaction(async (c) => {
    await c.query("DELETE FROM user_requests");
    for (const item of list || []) {
      const id = String(item.id || "").trim();
      if (!id) continue;
      await c.query(
        `INSERT INTO user_requests (id, payload, status, created_at) VALUES ($1,$2::jsonb,$3,$4)`,
        [id, JSON.stringify(item), item.status || null, item.createdAt || null]
      );
    }
  });
}

async function replaceUserRequests(list) {
  caches.userRequests = clone(list || []);
  return persistCatch("user-requests", () => persistUserRequestsSql(caches.userRequests));
}

async function persistMutualAidSql(list) {
  const cryptoSecrets = require("./cryptoSecrets");
  await db.withTransaction(async (c) => {
    await c.query("DELETE FROM mutual_aid");
    for (const item of list || []) {
      const id = String(item.id || "").trim();
      if (!id) continue;
      const extra = { ...item };
      delete extra.password;
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
          item.createdAt || null, item.updatedAt || null, JSON.stringify(extra),
        ]
      );
    }
  });
}

async function replaceMutualAid(list) {
  caches.mutualAid = clone(list || []);
  return persistCatch("mutual-aid", () => persistMutualAidSql(caches.mutualAid));
}

async function persistPermissionsSql(obj) {
  await db.withTransaction(async (c) => {
    await c.query("DELETE FROM permission_overrides");
    for (const [username, ov] of Object.entries(obj || {})) {
      const u = String(username || "").trim().toLowerCase();
      if (!u) continue;
      await c.query(
        `INSERT INTO permission_overrides (username, allow, deny) VALUES ($1,$2::jsonb,$3::jsonb)`,
        [u, JSON.stringify(ov?.allow || []), JSON.stringify(ov?.deny || [])]
      );
    }
  });
}

async function replacePermissionOverrides(obj) {
  caches.permissionOverrides = clone(obj || {});
  return persistCatch("permissions", () => persistPermissionsSql(caches.permissionOverrides));
}

async function persistLedgerSql(table, obj) {
  await db.withTransaction(async (c) => {
    await c.query(`DELETE FROM ${table}`);
    for (const [scope, map] of Object.entries(obj || {})) {
      if (!map || typeof map !== "object") continue;
      for (const [key, payload] of Object.entries(map)) {
        await c.query(
          `INSERT INTO ${table} (scope, key, payload) VALUES ($1,$2,$3::jsonb)`,
          [scope, key, JSON.stringify(payload || {})]
        );
      }
    }
  });
}

async function replaceAutoCreateGroups(obj) {
  caches.autoCreateGroups = clone(obj || { county: {}, state: {}, region: {} });
  return persistCatch("autoCreateGroups", () => persistLedgerSql("auto_create_groups", caches.autoCreateGroups));
}

async function replaceAutoCreateDataSync(obj) {
  caches.autoCreateDataSync = clone(obj || { county: {}, state: {} });
  return persistCatch("autoCreateDataSync", () => persistLedgerSql("auto_create_data_sync", caches.autoCreateDataSync));
}

async function persistChannelPatchesSql(list) {
  await db.withTransaction(async (c) => {
    await c.query("DELETE FROM channel_patches");
    for (const p of list || []) {
      const id = String(p.id || "").trim();
      if (!id) continue;
      await c.query(
        `INSERT INTO channel_patches (id, payload, updated_at) VALUES ($1,$2::jsonb, now())`,
        [id, JSON.stringify(p)]
      );
    }
  });
}

async function replaceChannelPatches(list) {
  caches.channelPatches = clone(list || []);
  return persistCatch("channel-patches", () => persistChannelPatchesSql(caches.channelPatches));
}

async function persistLocatorsSql(store) {
  const locators = Array.isArray(store?.locators) ? store.locators : [];
  const history = Array.isArray(store?.history) ? store.history : [];
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
      const id = String(h.id || require("crypto").randomUUID()).trim();
      const locatorId = String(h.locatorId || "").trim();
      if (!locatorId) continue;
      await c.query(
        `INSERT INTO locator_pings (id, locator_id, at, payload) VALUES ($1,$2,$3,$4::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [id, locatorId, h.at || new Date().toISOString(), JSON.stringify(h)]
      );
    }
  });
}

async function replaceLocators(store) {
  caches.locators = clone(store || { locators: [], history: [] });
  return persistCatch("locators", () => persistLocatorsSql(caches.locators));
}

async function persistGeofencesSql(fences) {
  await db.withTransaction(async (c) => {
    await c.query("DELETE FROM geofences");
    for (const f of fences || []) {
      const id = String(f.id || "").trim();
      if (!id) continue;
      await c.query(
        `INSERT INTO geofences (id, payload, updated_at) VALUES ($1,$2::jsonb, now())`,
        [id, JSON.stringify(f)]
      );
    }
  });
}

async function replaceGeofences(fences) {
  caches.geofences = { fences: clone(fences || []), updatedAt: new Date().toISOString() };
  return persistCatch("geofences", () => persistGeofencesSql(caches.geofences.fences));
}

async function persistGeofenceMembershipsSql(membership) {
  await db.withTransaction(async (c) => {
    await c.query("DELETE FROM geofence_memberships");
    for (const [fenceId, users] of Object.entries(membership || {})) {
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
}

async function upsertGeofenceMemberships(dirtyEntries) {
  if (!dirtyEntries || !dirtyEntries.length || !db.isConfigured()) return;
  await db.withTransaction(async (c) => {
    for (const row of dirtyEntries) {
      if (row.delete) {
        if (row.clientUid) {
          await c.query(
            "DELETE FROM geofence_memberships WHERE fence_id = $1 AND client_uid = $2",
            [row.fenceId, row.clientUid]
          );
        } else {
          await c.query("DELETE FROM geofence_memberships WHERE fence_id = $1", [row.fenceId]);
        }
      } else {
        await c.query(
          `INSERT INTO geofence_memberships (fence_id, client_uid, inside, last_enter_at, last_seen_at, last_exit_at)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (fence_id, client_uid) DO UPDATE SET
             inside = EXCLUDED.inside,
             last_enter_at = EXCLUDED.last_enter_at,
             last_seen_at = EXCLUDED.last_seen_at,
             last_exit_at = EXCLUDED.last_exit_at`,
          [row.fenceId, row.clientUid, !!row.inside, row.lastEnterAt || null, row.lastSeenAt || null, row.lastExitAt || null]
        );
      }
    }
  });
}

async function persistMouStreamsSql(data) {
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
}

async function replaceMouIndex(data) {
  caches.mouIndex = clone(data || { schemaVersion: 1, streams: [] });
  return persistCatch("mou-index", () => persistMouStreamsSql(caches.mouIndex));
}

async function replaceMouAgreement(data) {
  caches.mouAgreement = clone(data || { schemaVersion: 1, currentVersion: 0, versions: [] });
  return persistCatch("mou-agreement", () =>
    db.query(
      `INSERT INTO mou_user_agreement (id, payload) VALUES (1, $1::jsonb)
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload`,
      [JSON.stringify(caches.mouAgreement)]
    )
  );
}

async function persistMouAcksSql(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  await db.withTransaction(async (c) => {
    await c.query("DELETE FROM mou_acks");
    for (const item of items) {
      await c.query(
        `INSERT INTO mou_acks (user_key, version_id, at, payload) VALUES ($1,$2,$3,$4::jsonb)
         ON CONFLICT (user_key, version_id) DO UPDATE SET at = EXCLUDED.at, payload = EXCLUDED.payload`,
        [
          String(item.user_key || item.userKey || item.username || ""),
          String(item.version_id || item.versionId || item.version || ""),
          item.at || null,
          JSON.stringify(item),
        ]
      );
    }
  });
}

async function replaceMouAcks(data) {
  caches.mouAcks = clone(data || { schemaVersion: 1, items: [] });
  return persistCatch("mou-acks", () => persistMouAcksSql(caches.mouAcks));
}

async function persistMouViewsSql(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  await db.withTransaction(async (c) => {
    await c.query("DELETE FROM mou_views");
    for (const item of items) {
      const key = String(item.key || "").trim();
      if (!key) continue;
      await c.query(`INSERT INTO mou_views (key, payload) VALUES ($1,$2::jsonb)`, [key, JSON.stringify(item)]);
    }
  });
}

async function replaceMouViews(data) {
  caches.mouViews = clone(data || { schemaVersion: 1, items: [] });
  return persistCatch("mou-views", () => persistMouViewsSql(caches.mouViews));
}

async function persistMouRemindersSql(data) {
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
}

async function replaceMouReminders(data) {
  caches.mouReminders = clone(data || { schemaVersion: 1, agency: {} });
  return persistCatch("mou-reminders", () => persistMouRemindersSql(caches.mouReminders));
}

async function persistMouArchivedSql(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
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
}

async function replaceMouArchived(data) {
  caches.mouArchived = clone(data || { schemaVersion: 1, items: [] });
  return persistCatch("mou-archived", () => persistMouArchivedSql(caches.mouArchived));
}

async function persistMouInvitesSql(data) {
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
}

async function replaceMouInvites(data) {
  caches.mouInvites = clone(data || { schemaVersion: 1, items: [] });
  return persistCatch("mou-invites", () => persistMouInvitesSql(caches.mouInvites));
}

module.exports = {
  caches,
  clone,
  hydrate,
  persistCatch,
  replaceAgencies,
  replaceTemplates,
  replaceRegions,
  replaceLocks,
  replaceUserRequests,
  replaceMutualAid,
  replacePermissionOverrides,
  replaceAutoCreateGroups,
  replaceAutoCreateDataSync,
  replaceChannelPatches,
  replaceLocators,
  replaceGeofences,
  persistGeofenceMembershipsSql,
  upsertGeofenceMemberships,
  replaceMouIndex,
  replaceMouAgreement,
  replaceMouAcks,
  replaceMouViews,
  replaceMouReminders,
  replaceMouArchived,
  replaceMouInvites,
  rowToAgency,
};
