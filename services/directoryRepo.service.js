const db = require("./db");
const { getString } = require("./env");
const { extractUserColumns, extractGroupColumns, membershipHash } = require("./userAttributes.util");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(v) {
  return UUID_RE.test(String(v || "").trim());
}

function normalizePath(p) {
  return String(p || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
}

function hiddenUserPrefixes() {
  return String(getString("USERS_HIDDEN_PREFIXES", ""))
    .split(",")
    .map((p) => String(p || "").trim().toLowerCase())
    .filter(Boolean);
}

function hiddenGroupPrefixes() {
  return String(getString("GROUPS_HIDDEN_PREFIXES", ""))
    .split(",")
    .map((p) => String(p || "").trim().toLowerCase())
    .filter(Boolean);
}

function userPathClause(params) {
  const folderRaw = String(getString("AUTHENTIK_USER_PATH", "")).trim();
  if (!folderRaw) return "";
  const target = normalizePath(folderRaw);
  params.push(target);
  const i = params.length;
  return ` AND (path = $${i} OR path LIKE $${i} || '/%')`;
}

function hiddenUserClause(params, includeHiddenPrefixes) {
  if (includeHiddenPrefixes) return "";
  const prefixes = hiddenUserPrefixes();
  if (!prefixes.length) return "";
  params.push(prefixes);
  return ` AND NOT EXISTS (SELECT 1 FROM unnest($${params.length}::text[]) AS p WHERE lower(username) LIKE p || '%')`;
}

function hiddenGroupClause(params, includeHidden) {
  if (includeHidden) return "";
  const prefixes = hiddenGroupPrefixes();
  if (!prefixes.length) return "";
  params.push(prefixes);
  return ` AND NOT EXISTS (SELECT 1 FROM unnest($${params.length}::text[]) AS p WHERE lower(name) LIKE p || '%')`;
}

function isAuthentikPkToken(v) {
  const s = String(v || "").trim();
  return /^\d+$/.test(s) || isUuid(s);
}

function pkStr(v) {
  if (v == null || v === "") return null;
  return String(v);
}

function rowToUser(r, groupPks) {
  if (!r) return null;
  const pk = r.authentik_pk != null ? r.authentik_pk : r.id;
  return {
    pk,
    id: r.id,
    uuid: r.id,
    authentik_pk: r.authentik_pk,
    username: r.username,
    name: r.name,
    email: r.email,
    is_active: r.is_active,
    is_superuser: r.is_superuser,
    path: r.path,
    type: r.type,
    attributes: r.attributes || {},
    groups: Array.isArray(groupPks) ? groupPks : r.groups || [],
    pending_delete: r.pending_delete,
    sync_status: r.sync_status,
  };
}

function rowToGroup(r) {
  if (!r) return null;
  const pk = r.authentik_pk != null ? r.authentik_pk : r.id;
  return {
    pk,
    id: r.id,
    uuid: r.id,
    authentik_pk: r.authentik_pk,
    name: r.name,
    is_superuser: r.is_superuser,
    parent: r.parent_pk,
    num_pk: r.num_pk,
    attributes: r.attributes || {},
    pending_delete: r.pending_delete,
    sync_status: r.sync_status,
  };
}

function sortSql(sortKey, sortDir) {
  const dir = String(sortDir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
  const key = String(sortKey || "username").toLowerCase();
  if (key === "name") return `name ${dir} NULLS LAST, username ASC`;
  if (key === "email") return `email ${dir} NULLS LAST, username ASC`;
  if (key === "status" || key === "is_active") return `is_active ${dir}, username ASC`;
  return `username ${dir}`;
}

async function attachGroups(users) {
  if (!users.length) return users;
  const ids = users.map((u) => u.id);
  const r = await db.query(
    `SELECT gm.user_id, g.authentik_pk, g.id AS group_uuid
     FROM group_members gm
     JOIN groups g ON g.id = gm.group_id
     WHERE gm.user_id = ANY($1::uuid[])`,
    [ids]
  );
  const map = new Map();
  for (const row of r.rows) {
    const pk = row.authentik_pk != null ? String(row.authentik_pk) : String(row.group_uuid);
    if (!map.has(row.user_id)) map.set(row.user_id, []);
    map.get(row.user_id).push(pk);
  }
  return users.map((u) => {
    u.groups = map.get(u.id) || [];
    return u;
  });
}

async function getUserByUsername(username) {
  const u = String(username || "").trim();
  if (!u) return null;
  const r = await db.query(
    `SELECT * FROM users WHERE lower(username) = lower($1) AND pending_delete = false LIMIT 1`,
    [u]
  );
  if (!r.rows[0]) return null;
  const user = rowToUser(r.rows[0]);
  await attachGroups([user]);
  return user;
}

async function getUserById(id) {
  const raw = String(id || "").trim();
  if (!raw) return null;
  let r;
  if (isUuid(raw)) {
    r = await db.query(
      `SELECT * FROM users WHERE id = $1::uuid OR authentik_pk = $1 LIMIT 1`,
      [raw]
    );
  } else if (/^\d+$/.test(raw)) {
    r = await db.query(`SELECT * FROM users WHERE authentik_pk = $1 LIMIT 1`, [raw]);
  } else {
    r = await db.query(
      `SELECT * FROM users WHERE lower(username) = lower($1) LIMIT 1`,
      [raw]
    );
  }
  if (!r.rows[0]) return null;
  const user = rowToUser(r.rows[0]);
  await attachGroups([user]);
  return user;
}

async function getUsersByIds(ids) {
  const list = (Array.isArray(ids) ? ids : []).map((x) => String(x).trim()).filter(Boolean);
  if (!list.length) return [];
  const uuids = list.filter(isUuid);
  const names = list.filter((x) => !isUuid(x) && !/^\d+$/.test(x)).map((x) => x.toLowerCase());
  const r = await db.query(
    `SELECT * FROM users
     WHERE pending_delete = false
       AND (id = ANY($1::uuid[]) OR authentik_pk = ANY($2::text[]) OR lower(username) = ANY($3::text[]))`,
    [uuids, list, names]
  );
  const users = r.rows.map((row) => rowToUser(row));
  await attachGroups(users);
  return users;
}

async function getUsersByUsernames(usernames) {
  const list = (Array.isArray(usernames) ? usernames : [])
    .map((n) => String(n || "").trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) return [];
  const r = await db.query(
    `SELECT * FROM users WHERE pending_delete = false AND lower(username) = ANY($1::text[])`,
    [list]
  );
  const users = r.rows.map((row) => rowToUser(row));
  await attachGroups(users);
  return users;
}

async function listUserEmailRows({ includeHiddenPrefixes = false, agencySuffixes } = {}) {
  const params = [];
  let where = `pending_delete = false AND email IS NOT NULL AND btrim(email) <> ''`;
  where += hiddenUserClause(params, includeHiddenPrefixes);
  where += userPathClause(params);
  if (Array.isArray(agencySuffixes) && agencySuffixes.length) {
    params.push(agencySuffixes.map((s) => String(s || "").trim().toLowerCase()).filter(Boolean));
    where += ` AND lower(agency) = ANY($${params.length}::text[])`;
  }
  const r = await db.query(
    `SELECT username, name, email, agency, attributes FROM users WHERE ${where}`,
    params
  );
  return r.rows.map((row) => ({
    username: row.username,
    name: row.name,
    email: row.email,
    attributes: row.attributes || {},
    agency: row.agency,
  }));
}

async function getGroupsByPks(pks) {
  const list = (Array.isArray(pks) ? pks : []).map((x) => String(x).trim()).filter(Boolean);
  if (!list.length) return [];
  const uuids = list.filter(isUuid);
  const r = await db.query(
    `SELECT * FROM groups
     WHERE pending_delete = false
       AND (id = ANY($1::uuid[]) OR authentik_pk = ANY($2::text[]))`,
    [uuids, list]
  );
  return r.rows.map(rowToGroup);
}

async function getGroupsByNames(names) {
  const list = (Array.isArray(names) ? names : [])
    .map((n) => String(n || "").trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) return [];
  const r = await db.query(
    `SELECT * FROM groups WHERE pending_delete = false AND lower(name) = ANY($1::text[])`,
    [list]
  );
  return r.rows.map(rowToGroup);
}

async function getGroupById(id) {
  const raw = String(id || "").trim();
  if (!raw) return null;
  let r;
  if (isUuid(raw)) {
    r = await db.query(
      `SELECT * FROM groups WHERE id = $1::uuid OR authentik_pk = $1 LIMIT 1`,
      [raw]
    );
  } else if (/^\d+$/.test(raw)) {
    r = await db.query(`SELECT * FROM groups WHERE authentik_pk = $1 LIMIT 1`, [raw]);
  } else {
    r = await db.query(
      `SELECT * FROM groups WHERE lower(name) = lower($1) LIMIT 1`,
      [raw]
    );
  }
  return r.rows[0] ? rowToGroup(r.rows[0]) : null;
}

async function searchUsersPaged({
  q,
  page = 1,
  pageSize = 25,
  sortKey = "username",
  sortDir = "asc",
  currentTemplate,
  agencyName,
  agencySuffix,
  agencyAbbreviation,
  usernamePrefix,
  includeHiddenPrefixes = false,
  includeGroups = true,
  activeOnly,
} = {}) {
  const params = [];
  let where = `pending_delete = false`;
  where += hiddenUserClause(params, includeHiddenPrefixes);
  where += userPathClause(params);

  if (q && String(q).trim()) {
    const needle = `%${String(q).trim()}%`;
    params.push(needle);
    const i = params.length;
    where += ` AND (username ILIKE $${i} OR name ILIKE $${i} OR email ILIKE $${i} OR badge_number ILIKE $${i})`;
  }
  if (currentTemplate && String(currentTemplate).trim()) {
    params.push(String(currentTemplate).trim());
    where += ` AND current_template = $${params.length}`;
  }
  if (agencyName && String(agencyName).trim()) {
    params.push(String(agencyName).trim());
    where += ` AND lower(agency_name) = lower($${params.length})`;
  }
  if (agencySuffix && String(agencySuffix).trim()) {
    params.push(String(agencySuffix).trim().toLowerCase());
    where += ` AND lower(agency) = $${params.length}`;
  }
  if (agencyAbbreviation && String(agencyAbbreviation).trim()) {
    params.push(String(agencyAbbreviation).trim());
    where += ` AND lower(agency_abbreviation) = lower($${params.length})`;
  }
  if (usernamePrefix && String(usernamePrefix).trim()) {
    params.push(`${String(usernamePrefix).trim().toLowerCase()}%`);
    where += ` AND lower(username) LIKE $${params.length}`;
  }
  if (activeOnly === true) {
    where += ` AND is_active = true`;
  } else if (activeOnly === false) {
    where += ` AND is_active = false`;
  }

  const ps = Math.max(1, Math.min(200, Number(pageSize) || 25));
  const p = Math.max(1, Number(page) || 1);
  const count = await db.query(`SELECT COUNT(*)::int AS n FROM users WHERE ${where}`, params);
  const total = count.rows[0]?.n || 0;
  params.push(ps, (p - 1) * ps);
  const rows = await db.query(
    `SELECT * FROM users WHERE ${where} ORDER BY ${sortSql(sortKey, sortDir)} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  let users = rows.rows.map((row) => rowToUser(row));
  if (includeGroups) await attachGroups(users);
  return {
    users,
    total,
    page: p,
    pageSize: ps,
    hasNext: p * ps < total,
    hasPrev: p > 1,
  };
}

async function listUsersByAgencyName(agencyName, { activeOnly = false } = {}) {
  const name = String(agencyName || "").trim();
  if (!name) return [];
  const params = [name];
  let sql = `SELECT * FROM users WHERE pending_delete = false AND lower(agency_name) = lower($1)`;
  sql += hiddenUserClause(params, false);
  if (activeOnly) sql += ` AND is_active = true`;
  const r = await db.query(sql, params);
  const users = r.rows.map((row) => rowToUser(row));
  await attachGroups(users);
  return users;
}

async function listUsersByAgencySuffix(agencySuffix) {
  const sfx = String(agencySuffix || "").trim().toLowerCase();
  if (!sfx) return [];
  const r = await db.query(
    `SELECT * FROM users WHERE pending_delete = false AND lower(agency) = $1`,
    [sfx]
  );
  const users = r.rows.map((row) => rowToUser(row));
  await attachGroups(users);
  return users;
}

async function countUsersByAgencyName(agencyName) {
  const name = String(agencyName || "").trim();
  if (!name) return 0;
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM users WHERE pending_delete = false AND lower(agency_name) = lower($1)`,
    [name]
  );
  return r.rows[0]?.n || 0;
}

async function listUsersByTemplate(agencySuffix, templateName) {
  const sfx = String(agencySuffix || "").trim().toLowerCase();
  const tmpl = String(templateName || "").trim();
  const r = await db.query(
    `SELECT * FROM users WHERE pending_delete = false AND lower(agency) = $1 AND current_template = $2`,
    [sfx, tmpl]
  );
  const users = r.rows.map((row) => rowToUser(row));
  await attachGroups(users);
  return users;
}

async function searchGroupsPaged({
  q,
  includeHidden = false,
  page = 1,
  pageSize = 50,
  prefix,
  agencyName,
  createdType,
  createdTypeDetail,
} = {}) {
  const params = [];
  let where = `pending_delete = false`;
  where += hiddenGroupClause(params, includeHidden);
  if (q && String(q).trim()) {
    params.push(`%${String(q).trim()}%`);
    where += ` AND (name ILIKE $${params.length} OR cn ILIKE $${params.length})`;
  }
  if (prefix && String(prefix).trim()) {
    params.push(`${String(prefix).trim()}%`);
    where += ` AND name ILIKE $${params.length}`;
  }
  if (agencyName && String(agencyName).trim()) {
    params.push(String(agencyName).trim());
    where += ` AND (
      created_type_detail ILIKE $${params.length}
      OR attributes->>'agency_name' ILIKE $${params.length}
    )`;
  }
  if (createdType) {
    params.push(String(createdType));
    where += ` AND created_type = $${params.length}`;
  }
  if (createdTypeDetail) {
    params.push(String(createdTypeDetail));
    where += ` AND created_type_detail = $${params.length}`;
  }
  const ps = Math.max(1, Math.min(500, Number(pageSize) || 50));
  const p = Math.max(1, Number(page) || 1);
  const count = await db.query(`SELECT COUNT(*)::int AS n FROM groups WHERE ${where}`, params);
  const total = count.rows[0]?.n || 0;
  params.push(ps, (p - 1) * ps);
  const rows = await db.query(
    `SELECT * FROM groups WHERE ${where} ORDER BY name ASC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return {
    groups: rows.rows.map(rowToGroup),
    total,
    page: p,
    pageSize: ps,
    hasNext: p * ps < total,
    hasPrev: p > 1,
  };
}

async function listGroupsMatching({ includeHidden = false, names, prefix, q, limit = 500 } = {}) {
  if (names && names.length) return getGroupsByNames(names);
  const pageSize = Math.min(1000, Number(limit) || 500);
  const r = await searchGroupsPaged({ q, includeHidden, prefix, page: 1, pageSize });
  return r.groups;
}

async function getGroupMemberPks(groupId) {
  const g = await getGroupById(groupId);
  if (!g) return [];
  const r = await db.query(
    `SELECT u.authentik_pk, u.id
     FROM group_members gm
     JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = $1 AND u.pending_delete = false`,
    [g.uuid || g.id]
  );
  return r.rows.map((row) => (row.authentik_pk != null ? String(row.authentik_pk) : String(row.id)));
}

async function getGroupMembersPaged(groupId, { page = 1, pageSize = 100, agencyAbbreviation } = {}) {
  const g = await getGroupById(groupId);
  if (!g) return { users: [], total: 0, page: 1, pageSize, hasNext: false, hasPrev: false };
  const params = [g.uuid || g.id];
  let extra = "";
  if (agencyAbbreviation) {
    params.push(String(agencyAbbreviation).trim());
    extra += ` AND lower(u.agency_abbreviation) = lower($${params.length})`;
  }
  extra += hiddenUserClause(params, false);
  const count = await db.query(
    `SELECT COUNT(*)::int AS n FROM group_members gm JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = $1 AND u.pending_delete = false ${extra}`,
    params
  );
  const total = count.rows[0]?.n || 0;
  const ps = Math.max(1, Number(pageSize) || 100);
  const p = Math.max(1, Number(page) || 1);
  params.push(ps, (p - 1) * ps);
  const rows = await db.query(
    `SELECT u.* FROM group_members gm JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = $1 AND u.pending_delete = false ${extra}
     ORDER BY u.name NULLS LAST, u.username
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const users = rows.rows.map((row) => rowToUser(row));
  return { users, total, page: p, pageSize: ps, hasNext: p * ps < total, hasPrev: p > 1 };
}

async function insertLocalUser({ username, name, email, path, attributes, isActive = true }, client) {
  const q = client || db;
  const cols = extractUserColumns(attributes);
  const r = await q.query(
    `INSERT INTO users (
      username, name, email, is_active, path, attributes,
      agency, agency_name, agency_abbreviation, agency_color, badge_number, role,
      radio_callsign, current_template, created_template, created_at_attr, created_method,
      created_by_username, created_by_display_name, mutual_aid, mutual_aid_type, mutual_aid_group,
      integration_type, integration_scope, integration_title, tak_integration_group, state, county,
      sync_status
    ) VALUES (
      $1,$2,$3,$4,$5,$6::jsonb,
      $7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,'pending'
    ) RETURNING *`,
    [
      username, name || null, email || null, !!isActive, path || null, JSON.stringify(attributes || {}),
      cols.agency, cols.agency_name, cols.agency_abbreviation, cols.agency_color, cols.badge_number, cols.role,
      cols.radio_callsign, cols.current_template, cols.created_template, cols.created_at_attr, cols.created_method,
      cols.created_by_username, cols.created_by_display_name, cols.mutual_aid, cols.mutual_aid_type, cols.mutual_aid_group,
      cols.integration_type, cols.integration_scope, cols.integration_title, cols.tak_integration_group, cols.state, cols.county,
    ]
  );
  return rowToUser(r.rows[0]);
}

async function insertLocalGroup({ name, attributes }, client) {
  const q = client || db;
  const cols = extractGroupColumns(attributes);
  const r = await q.query(
    `INSERT INTO groups (name, cn, attributes, created_type, created_type_detail, created_at_attr, created_by_username, created_by_display_name, sync_status)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,'pending') RETURNING *`,
    [
      name,
      cols.cn,
      JSON.stringify(attributes || {}),
      cols.created_type,
      cols.created_type_detail,
      cols.created_at_attr,
      cols.created_by_username,
      cols.created_by_display_name,
    ]
  );
  return rowToGroup(r.rows[0]);
}

async function setUserMemberships(userUuid, groupIds, client) {
  const q = client || db;
  const groups = await getGroupsByPks(groupIds);
  await q.query("DELETE FROM group_members WHERE user_id = $1", [userUuid]);
  const pks = [];
  for (const g of groups) {
    await q.query(
      "INSERT INTO group_members (user_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [userUuid, g.uuid || g.id]
    );
    pks.push(g.authentik_pk != null ? String(g.authentik_pk) : String(g.uuid || g.id));
  }
  const hash = membershipHash(pks);
  await q.query("UPDATE users SET groups_hash = $2, updated_at = now() WHERE id = $1", [userUuid, hash]);
  return pks;
}

async function updateLocalGroup(id, patch, client) {
  const existing = await getGroupById(id);
  if (!existing) return null;
  const q = client || db;
  const nextAttrs = patch.attributes ? patch.attributes : existing.attributes || {};
  const cols = extractGroupColumns(nextAttrs);
  const r = await q.query(
    `UPDATE groups SET
      name = COALESCE($2, name),
      cn = COALESCE($3, cn),
      attributes = COALESCE($4::jsonb, attributes),
      created_type = COALESCE($5, created_type),
      created_type_detail = COALESCE($6, created_type_detail),
      sync_status = COALESCE($7, sync_status),
      updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [
      existing.uuid || existing.id,
      patch.name !== undefined ? patch.name : null,
      cols.cn || null,
      patch.attributes ? JSON.stringify(nextAttrs) : null,
      cols.created_type || null,
      cols.created_type_detail || null,
      patch.sync_status || "pending",
    ]
  );
  return rowToGroup(r.rows[0]);
}

async function addLocalMembers(groupId, userIds, client) {
  const g = await getGroupById(groupId);
  if (!g) return [];
  const users = await getUsersByIds(userIds);
  const q = client || db;
  for (const u of users) {
    await q.query(
      "INSERT INTO group_members (user_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [u.uuid || u.id, g.uuid || g.id]
    );
  }
  return users;
}

async function removeLocalMembers(groupId, userIds, client) {
  const g = await getGroupById(groupId);
  if (!g) return [];
  const users = await getUsersByIds(userIds);
  const q = client || db;
  const ids = users.map((u) => u.uuid || u.id);
  if (ids.length) {
    await q.query(
      "DELETE FROM group_members WHERE group_id = $1 AND user_id = ANY($2::uuid[])",
      [g.uuid || g.id, ids]
    );
  }
  return users;
}

async function updateLocalUser(id, patch, client) {
  const existing = await getUserById(id);
  if (!existing) return null;
  const q = client || db;
  const attrs = { ...(existing.attributes || {}), ...(patch.attributes || {}) };
  if (patch.attributes === undefined) {
    /* keep */
  }
  const nextAttrs = patch.attributes ? attrs : existing.attributes || {};
  const cols = extractUserColumns(nextAttrs, patch);
  const r = await q.query(
    `UPDATE users SET
      name = COALESCE($2, name),
      email = COALESCE($3, email),
      is_active = COALESCE($4, is_active),
      path = COALESCE($5, path),
      attributes = COALESCE($6::jsonb, attributes),
      agency = COALESCE($7, agency),
      agency_name = COALESCE($8, agency_name),
      agency_abbreviation = COALESCE($9, agency_abbreviation),
      agency_color = COALESCE($10, agency_color),
      badge_number = COALESCE($11, badge_number),
      role = COALESCE($12, role),
      radio_callsign = COALESCE($13, radio_callsign),
      current_template = COALESCE($14, current_template),
      pending_delete = COALESCE($15, pending_delete),
      sync_status = COALESCE($16, sync_status),
      updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [
      existing.uuid || existing.id,
      patch.name !== undefined ? patch.name : null,
      patch.email !== undefined ? patch.email : null,
      patch.is_active !== undefined ? patch.is_active : null,
      patch.path !== undefined ? patch.path : null,
      patch.attributes ? JSON.stringify(nextAttrs) : null,
      cols.agency, cols.agency_name, cols.agency_abbreviation, cols.agency_color,
      cols.badge_number, cols.role, cols.radio_callsign, cols.current_template,
      patch.pending_delete !== undefined ? patch.pending_delete : null,
      patch.sync_status || "pending",
    ]
  );
  const user = rowToUser(r.rows[0]);
  await attachGroups([user]);
  return user;
}

async function deleteLocalUser(id, client) {
  const existing = await getUserById(id);
  if (!existing) return;
  const q = client || db;
  await q.query("DELETE FROM users WHERE id = $1", [existing.uuid || existing.id]);
}

async function deleteLocalGroup(id, client) {
  const existing = await getGroupById(id);
  if (!existing) return;
  const q = client || db;
  await q.query("DELETE FROM groups WHERE id = $1", [existing.uuid || existing.id]);
}

async function userExists(username) {
  const u = String(username || "").trim();
  if (!u) return false;
  const r = await db.query(
    `SELECT 1 FROM users WHERE lower(username) = lower($1) LIMIT 1`,
    [u]
  );
  return r.rows.length > 0;
}

async function waitForAuthentikPk(username, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const u = await getUserByUsername(username);
    if (u && u.authentik_pk != null) return u.authentik_pk;
    await new Promise((r) => setTimeout(r, 400));
  }
  const err = new Error("Still syncing to Authentik — try again in a moment.");
  err.code = "AUTHENTIK_SYNC_PENDING";
  throw err;
}

module.exports = {
  isUuid,
  isAuthentikPkToken,
  pkStr,
  rowToUser,
  rowToGroup,
  getUserByUsername,
  getUserById,
  getUsersByIds,
  getUsersByUsernames,
  listUserEmailRows,
  getGroupsByPks,
  getGroupsByNames,
  getGroupById,
  searchUsersPaged,
  listUsersByAgencyName,
  listUsersByAgencySuffix,
  countUsersByAgencyName,
  listUsersByTemplate,
  searchGroupsPaged,
  listGroupsMatching,
  getGroupMemberPks,
  getGroupMembersPaged,
  insertLocalUser,
  insertLocalGroup,
  setUserMemberships,
  updateLocalUser,
  updateLocalGroup,
  addLocalMembers,
  removeLocalMembers,
  deleteLocalUser,
  deleteLocalGroup,
  userExists,
  waitForAuthentikPk,
  attachGroups,
  hiddenUserPrefixes,
  hiddenGroupPrefixes,
};
