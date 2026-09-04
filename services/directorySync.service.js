const api = require("./authentik");
const db = require("./db");
const { getString, getInt } = require("./env");
const outbox = require("./authentikOutbox.service");
const repo = require("./directoryRepo.service");
const { extractUserColumns, extractGroupColumns, membershipHash } = require("./userAttributes.util");
const agenciesStore = require("./agencies.service");
const accessSvc = require("./access.service");

let _snapshotRunning = false;

function pageSize() {
  return getInt("AUTHENTIK_USER_PAGE_SIZE", 500) || 500;
}

async function paginateAuthentik(path, paramsBase = {}) {
  const all = [];
  let page = 1;
  let hasNext = true;
  const size = pageSize();
  while (hasNext) {
    const params = { ...paramsBase, page, page_size: size };
    const res = await api.get(path, { params });
    const data = res?.data || {};
    const results = Array.isArray(data.results) ? data.results : [];
    all.push(...results);
    const pagination = data.pagination || {};
    if (pagination && pagination.next) {
      page = pagination.next;
      hasNext = true;
    } else {
      hasNext = false;
    }
  }
  return all;
}

async function setDirectoryError(message) {
  await db.query(
    `UPDATE directory_sync SET last_error = $1, last_started_at = COALESCE(last_started_at, now()) WHERE id = 1`,
    [message ? String(message).slice(0, 2000) : null]
  );
}

async function getDirectorySyncStatus() {
  const r = await db.query("SELECT * FROM directory_sync WHERE id = 1");
  const row = r.rows[0] || {};
  return {
    ok: !row.last_error,
    lastError: row.last_error || null,
    lastSuccessAt: row.last_success_at || null,
    completed: !!row.completed,
  };
}

async function revertDeadLetter(row) {
  const kind = String(row.kind || "");
  const entityId = row.entity_id;
  try {
    if (kind === "create_user" && entityId) {
      await repo.deleteLocalUser(entityId);
    } else if (kind === "create_group" && entityId) {
      await repo.deleteLocalGroup(entityId);
    } else if (kind === "delete_user" && entityId) {
      await db.query("UPDATE users SET pending_delete = false, sync_status = 'ok' WHERE id = $1", [entityId]);
    } else if (kind === "delete_group" && entityId) {
      await db.query("UPDATE groups SET pending_delete = false, sync_status = 'ok' WHERE id = $1", [entityId]);
    }
  } catch (e) {
    console.warn("[outbox] revert failed:", kind, e?.message || e);
  }
  const label = row.username || entityId || row.authentik_pk || row.id;
  await setDirectoryError(`Authentik could not apply ${kind} for ${label}: ${row.last_error || "unknown error"}`);
}

async function sendOnboardingEmail(user, groups, hasPassword) {
  try {
    const usersSvc = require("./users.service");
    await usersSvc.emailUserCreated({ user, groups, hasPassword });
  } catch (e) {
    console.error("[EMAIL] user creation notice failed:", e?.message || e);
  }
}

async function handleOutboxRow(row) {
  const payload = outbox.decryptPayload(row.payload || {});
  const kind = String(row.kind || "");

  if (kind === "create_user") {
    const body = {
      username: payload.username,
      email: payload.email || "",
      name: payload.name,
      is_active: payload.is_active !== false,
      attributes: payload.attributes || {},
    };
    if (payload.path) body.path = payload.path;
    const res = await api.post("/core/users/", body);
    const created = res.data;
    const pk = created.pk;
    if (payload.password) {
      await api.post(`/core/users/${pk}/set_password/`, { password: payload.password });
    }
    const groupPks = (payload.groupPks || []).map(String).filter((x) => repo.isAuthentikPkToken(x));
    if (groupPks.length) {
      await api.patch(`/core/users/${pk}/`, { groups: groupPks });
    }
    if (row.entity_id) {
      await db.query(
        `UPDATE users SET authentik_pk = $2, sync_status = 'ok', updated_at = now() WHERE id = $1`,
        [row.entity_id, pk]
      );
    }
    if (payload.sendOnboardingEmail) {
      let user = created;
      try {
        const fresh = await api.get(`/core/users/${pk}/`);
        user = fresh.data;
      } catch (_) {}
      const groups = [];
      if (groupPks.length) {
        const found = await repo.getGroupsByPks(groupPks);
        groups.push(...found);
      }
      await sendOnboardingEmail(user, groups, !!payload.password);
    }
    return;
  }

  if (kind === "set_password") {
    const pk = row.authentik_pk || payload.authentikPk;
    if (!pk) throw new Error("No authentik pk for set_password");
    await api.post(`/core/users/${pk}/set_password/`, { password: payload.password });
    return;
  }

  if (kind === "patch_user") {
    const pk = row.authentik_pk || payload.authentikPk;
    if (!pk) throw new Error("No authentik pk for patch_user");
    const body = { ...(payload.patch || {}) };
    await api.patch(`/core/users/${pk}/`, body);
    if (row.entity_id) {
      await db.query(`UPDATE users SET sync_status = 'ok', updated_at = now() WHERE id = $1`, [row.entity_id]);
    }
    return;
  }

  if (kind === "set_groups") {
    const pk = row.authentik_pk || payload.authentikPk;
    if (!pk) throw new Error("No authentik pk for set_groups");
    const groupPks = (payload.groupPks || []).map(String).filter((x) => repo.isAuthentikPkToken(x));
    await api.patch(`/core/users/${pk}/`, { groups: groupPks });
    if (row.entity_id) {
      await db.query(`UPDATE users SET sync_status = 'ok', updated_at = now() WHERE id = $1`, [row.entity_id]);
    }
    return;
  }

  if (kind === "delete_user") {
    const pk = row.authentik_pk || payload.authentikPk;
    if (pk) await api.delete(`/core/users/${pk}/`);
    if (row.entity_id) await repo.deleteLocalUser(row.entity_id);
    return;
  }

  if (kind === "create_group") {
    const body = { name: payload.name, attributes: payload.attributes || {} };
    const res = await api.post("/core/groups/", body);
    const pk = res.data.pk;
    if (row.entity_id) {
      await db.query(
        `UPDATE groups SET authentik_pk = $2, sync_status = 'ok', updated_at = now() WHERE id = $1`,
        [row.entity_id, pk]
      );
    }
    return;
  }

  if (kind === "patch_group") {
    const pk = row.authentik_pk || payload.authentikPk;
    if (!pk) throw new Error("No authentik pk for patch_group");
    await api.patch(`/core/groups/${pk}/`, payload.patch || {});
    if (row.entity_id) {
      await db.query(`UPDATE groups SET sync_status = 'ok', updated_at = now() WHERE id = $1`, [row.entity_id]);
    }
    return;
  }

  if (kind === "delete_group") {
    const pk = row.authentik_pk || payload.authentikPk;
    if (pk) await api.delete(`/core/groups/${pk}/`);
    if (row.entity_id) await repo.deleteLocalGroup(row.entity_id);
    return;
  }

  if (kind === "add_members" || kind === "remove_members") {
    const pk = row.authentik_pk || payload.authentikPk;
    if (!pk) throw new Error("No authentik pk for membership change");
    const users = payload.userPks || [];
    if (kind === "add_members") {
      await api.post(`/core/groups/${pk}/add_user/`, { pk: users }).catch(async () => {
        const g = await api.get(`/core/groups/${pk}/`);
        const current = Array.isArray(g.data.users) ? g.data.users.map(String) : [];
        const next = Array.from(new Set([...current, ...users.map(String)]));
        await api.patch(`/core/groups/${pk}/`, { users: next });
      });
    } else {
      await api.post(`/core/groups/${pk}/remove_user/`, { pk: users }).catch(async () => {
        const g = await api.get(`/core/groups/${pk}/`);
        const current = Array.isArray(g.data.users) ? g.data.users.map(String) : [];
        const drop = new Set(users.map(String));
        await api.patch(`/core/groups/${pk}/`, { users: current.filter((x) => !drop.has(String(x))) });
      });
    }
    return;
  }

  throw new Error(`Unknown outbox kind: ${kind}`);
}

async function drainOutbox() {
  const batch = await outbox.claimBatch(20);
  for (const row of batch) {
    try {
      await handleOutboxRow(row);
      await outbox.deleteRow(row.id);
    } catch (e) {
      const attempts = Number(row.attempts || 0) + 1;
      const msg = e?.message || String(e);
      console.warn(`[outbox] ${row.kind} id=${row.id} attempt ${attempts}:`, msg);
      if (attempts >= 20) {
        row.last_error = msg;
        await revertDeadLetter(row);
        await outbox.deleteRow(row.id);
      } else {
        await outbox.markAttempt(row.id, msg, attempts);
      }
    }
  }
  return batch.length;
}

async function upsertAuthentikUser(akUser, pending, groupUuidByPk) {
  const pk = akUser.pk;
  const username = String(akUser.username || "").trim();
  if (!username) return;
  if (pending.byPk.has(String(pk)) || pending.byUsername.has(username.toLowerCase())) {
    return;
  }
  const attrs = akUser.attributes || {};
  const cols = extractUserColumns(attrs, akUser);
  const hasGroupsField = Array.isArray(akUser.groups);
  const groupPks = hasGroupsField ? akUser.groups.map(String) : [];
  const hash = hasGroupsField ? membershipHash(groupPks) : null;
  const existing = await db.query(
    `SELECT id, groups_hash FROM users WHERE authentik_pk = $1 OR lower(username) = lower($2) LIMIT 1`,
    [pk, username]
  );
  const priorHash = existing.rows[0] ? String(existing.rows[0].groups_hash || "") : "";
  await db.query(
    `INSERT INTO users (
      authentik_pk, username, name, email, is_active, is_superuser, path, type, attributes,
      agency, agency_name, agency_abbreviation, agency_color, badge_number, role,
      radio_callsign, current_template, created_template, created_at_attr, created_method,
      created_by_username, created_by_display_name, mutual_aid, mutual_aid_type, mutual_aid_group,
      integration_type, integration_scope, integration_title, tak_integration_group, state, county,
      groups_hash, sync_status, pending_delete, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,
      $10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,
      $32,'ok', false, now()
    )
    ON CONFLICT (username) DO UPDATE SET
      authentik_pk = EXCLUDED.authentik_pk,
      name = EXCLUDED.name,
      email = EXCLUDED.email,
      is_active = EXCLUDED.is_active,
      is_superuser = EXCLUDED.is_superuser,
      path = EXCLUDED.path,
      type = EXCLUDED.type,
      attributes = EXCLUDED.attributes,
      agency = EXCLUDED.agency,
      agency_name = EXCLUDED.agency_name,
      agency_abbreviation = EXCLUDED.agency_abbreviation,
      agency_color = EXCLUDED.agency_color,
      badge_number = EXCLUDED.badge_number,
      role = EXCLUDED.role,
      radio_callsign = EXCLUDED.radio_callsign,
      current_template = EXCLUDED.current_template,
      created_template = EXCLUDED.created_template,
      created_at_attr = EXCLUDED.created_at_attr,
      created_method = EXCLUDED.created_method,
      created_by_username = EXCLUDED.created_by_username,
      created_by_display_name = EXCLUDED.created_by_display_name,
      mutual_aid = EXCLUDED.mutual_aid,
      mutual_aid_type = EXCLUDED.mutual_aid_type,
      mutual_aid_group = EXCLUDED.mutual_aid_group,
      integration_type = EXCLUDED.integration_type,
      integration_scope = EXCLUDED.integration_scope,
      integration_title = EXCLUDED.integration_title,
      tak_integration_group = EXCLUDED.tak_integration_group,
      state = EXCLUDED.state,
      county = EXCLUDED.county,
      sync_status = 'ok',
      pending_delete = false,
      updated_at = now()`,
    [
      pk, username, akUser.name || null, akUser.email || null, akUser.is_active !== false,
      !!akUser.is_superuser, akUser.path || null, akUser.type || null, JSON.stringify(attrs),
      cols.agency, cols.agency_name, cols.agency_abbreviation, cols.agency_color, cols.badge_number, cols.role,
      cols.radio_callsign, cols.current_template, cols.created_template, cols.created_at_attr, cols.created_method,
      cols.created_by_username, cols.created_by_display_name, cols.mutual_aid, cols.mutual_aid_type, cols.mutual_aid_group,
      cols.integration_type, cols.integration_scope, cols.integration_title, cols.tak_integration_group, cols.state, cols.county,
      hash || priorHash || null,
    ]
  );
  if (!hasGroupsField) return;
  const local = await db.query("SELECT id, groups_hash FROM users WHERE authentik_pk = $1", [pk]);
  const localId = local.rows[0]?.id;
  if (!localId) return;
  if (priorHash && priorHash === hash) return;
  const uuids = [];
  for (const gpk of groupPks) {
    const uuid = groupUuidByPk && groupUuidByPk.get(String(gpk));
    if (uuid) uuids.push(uuid);
  }
  await repo.replaceUserMembershipsFromUuids(localId, uuids, hash);
}

async function upsertAuthentikGroup(akGroup, pending) {
  const pk = akGroup.pk;
  const name = String(akGroup.name || "").trim();
  if (!name) return;
  if (pending.byPk.has(String(pk))) return;
  const attrs = akGroup.attributes || {};
  const cols = extractGroupColumns(attrs);
  await db.query(
    `INSERT INTO groups (
      authentik_pk, name, cn, description, is_superuser, parent_pk, num_pk, attributes,
      created_type, created_type_detail, created_at_attr, created_by_username, created_by_display_name,
      sync_status, pending_delete, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,'ok', false, now()
    )
    ON CONFLICT (authentik_pk) DO UPDATE SET
      name = EXCLUDED.name,
      cn = EXCLUDED.cn,
      description = EXCLUDED.description,
      is_superuser = EXCLUDED.is_superuser,
      parent_pk = EXCLUDED.parent_pk,
      num_pk = EXCLUDED.num_pk,
      attributes = EXCLUDED.attributes,
      created_type = EXCLUDED.created_type,
      created_type_detail = EXCLUDED.created_type_detail,
      created_at_attr = EXCLUDED.created_at_attr,
      created_by_username = EXCLUDED.created_by_username,
      created_by_display_name = EXCLUDED.created_by_display_name,
      sync_status = 'ok',
      pending_delete = false,
      updated_at = now()`,
    [
      pk, name, cols.cn, akGroup.is_superuser ? null : (akGroup.attributes?.notes || null),
      !!akGroup.is_superuser, akGroup.parent || null, akGroup.num_pk || null, JSON.stringify(attrs),
      cols.created_type, cols.created_type_detail, cols.created_at_attr, cols.created_by_username, cols.created_by_display_name,
    ]
  );
}

async function writeDashboardStats() {
  const agencies = agenciesStore.load() || [];
  const hidden = repo.hiddenUserPrefixes();
  const hiddenSql =
    hidden.length
      ? `AND NOT EXISTS (SELECT 1 FROM unnest($1::text[]) AS p WHERE lower(u.username) LIKE p || '%')`
      : "";
  const params = hidden.length ? [hidden] : [];
  const vis = await db.query(
    `SELECT COUNT(*)::int AS n FROM users u WHERE pending_delete = false AND is_active = true ${hiddenSql}`,
    params
  );
  const integ = await db.query(
    `SELECT COUNT(*)::int AS n FROM users WHERE pending_delete = false AND lower(username) LIKE 'nodered-%'`
  );
  const grp = await db.query(`SELECT COUNT(*)::int AS n FROM groups WHERE pending_delete = false`);
  const byAgency = await db.query(
    `SELECT COALESCE(NULLIF(agency_name,''), '(unknown)') AS k, COUNT(*)::int AS n
     FROM users WHERE pending_delete = false ${hidden.length ? "AND NOT EXISTS (SELECT 1 FROM unnest($1::text[]) AS p WHERE lower(username) LIKE p || '%')" : ""}
     GROUP BY 1`,
    params
  );
  const byType = await db.query(
    `SELECT COALESCE(NULLIF(a.type,''), 'Unknown') AS k, COUNT(*)::int AS n
     FROM users u
     LEFT JOIN agencies a ON lower(a.suffix) = lower(u.agency)
     WHERE u.pending_delete = false ${hidden.length ? "AND NOT EXISTS (SELECT 1 FROM unnest($1::text[]) AS p WHERE lower(u.username) LIKE p || '%')" : ""}
     GROUP BY 1`,
    params
  );
  const usersByAgency = {};
  let unknownAgency = 0;
  for (const row of byAgency.rows) {
    if (row.k === "(unknown)") unknownAgency += row.n;
    else usersByAgency[row.k] = row.n;
  }
  const usersByType = {};
  let unknownType = 0;
  for (const row of byType.rows) {
    if (row.k === "Unknown") unknownType += row.n;
    else usersByType[row.k] = row.n;
  }
  const payload = {
    stats: {
      totalUsers: vis.rows[0]?.n || 0,
      totalGroups: grp.rows[0]?.n || 0,
      totalAgencies: agencies.length,
      totalIntegrations: integ.rows[0]?.n || 0,
    },
    charts: { usersByAgency, unknownAgency, usersByType, unknownType },
  };
  await db.query(
    `INSERT INTO dashboard_stats (id, payload, updated_at) VALUES (1, $1::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
    [JSON.stringify(payload)]
  );
}

async function inboundSnapshot() {
  if (_snapshotRunning) return;
  _snapshotRunning = true;
  await db.query(`UPDATE directory_sync SET last_started_at = now() WHERE id = 1`);
  try {
    const pending = await outbox.pendingEntityKeys();
    let users;
    let groups;
    try {
      groups = await paginateAuthentik("/core/groups/", { include_users: false });
      // Group pks only (not nested group objects). Skip membership rewrite when groups_hash matches.
      users = await paginateAuthentik("/core/users/", { include_groups: true, include_roles: false });
    } catch (e) {
      await setDirectoryError(e?.message || String(e));
      return;
    }

    const seenUserPks = new Set();
    const seenGroupPks = new Set();
    for (const g of groups) {
      seenGroupPks.add(String(g.pk));
      await upsertAuthentikGroup(g, pending);
    }
    const localGroups = await db.query(
      `SELECT id, authentik_pk FROM groups WHERE pending_delete = false`
    );
    const groupUuidByPk = new Map();
    for (const row of localGroups.rows) {
      if (row.authentik_pk != null) groupUuidByPk.set(String(row.authentik_pk), row.id);
      groupUuidByPk.set(String(row.id), row.id);
    }
    for (const u of users) {
      seenUserPks.add(String(u.pk));
      await upsertAuthentikUser(u, pending, groupUuidByPk);
    }

    if (users.length > 0) {
      const pendingCreate = new Set(
        pending.rows.filter((r) => r.kind === "create_user").map((r) => String(r.username || "").toLowerCase())
      );
      const seenArr = Array.from(seenUserPks);
      await db.query(
        `UPDATE users SET is_active = false, updated_at = now()
         WHERE authentik_pk IS NOT NULL
           AND pending_delete = false
           AND NOT (authentik_pk = ANY($1::text[]))
           AND lower(username) <> ALL($2::text[])`,
        [seenArr, Array.from(pendingCreate)]
      );
    }

    await db.query(
      `UPDATE directory_sync SET
         last_success_at = now(), last_error = NULL, completed = true,
         user_count = $1, group_count = $2
       WHERE id = 1`,
      [users.length, groups.length]
    );
    await writeDashboardStats();
  } catch (e) {
    await setDirectoryError(e?.message || String(e));
    console.warn("[directory-sync] snapshot failed:", e?.message || e);
  } finally {
    _snapshotRunning = false;
  }
}

module.exports = {
  drainOutbox,
  inboundSnapshot,
  writeDashboardStats,
  getDirectorySyncStatus,
  revertDeadLetter,
  handleOutboxRow,
};
