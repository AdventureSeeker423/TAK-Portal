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
  const attrs = Object.assign({}, r.attributes || {});
  if (r.agency && !attrs.agency) attrs.agency = r.agency;
  if (r.agency_name && !attrs.agency_name) attrs.agency_name = r.agency_name;
  if (r.agency_abbreviation && !attrs.agency_abbreviation) {
    attrs.agency_abbreviation = r.agency_abbreviation;
  }
  if (r.current_template && !attrs.current_template) attrs.current_template = r.current_template;
  if (r.role && !attrs.role) attrs.role = r.role;
  if (r.radio_callsign && !attrs.radio_callsign) attrs.radio_callsign = r.radio_callsign;
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
    attributes: attrs,
    agency: r.agency || attrs.agency || null,
    agency_name: r.agency_name || attrs.agency_name || null,
    agency_abbreviation: r.agency_abbreviation || attrs.agency_abbreviation || null,
    current_template: r.current_template || attrs.current_template || null,
    role: r.role || attrs.role || null,
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
  if (key === "agency") {
    return `lower(COALESCE(agency_name, agency, '')) ${dir} NULLS LAST, name ASC, username ASC`;
  }
  if (key === "template") {
    return `lower(COALESCE(current_template, '')) ${dir} NULLS LAST, username ASC`;
  }
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
      `SELECT * FROM users WHERE id = $1::uuid OR authentik_pk = $2 LIMIT 1`,
      [raw, raw]
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

async function listUserEmailRowsByGroupPks(groupPks, { includeHiddenPrefixes = false } = {}) {
  const list = (Array.isArray(groupPks) ? groupPks : []).map((x) => String(x).trim()).filter(Boolean);
  if (!list.length) return [];
  const params = [list.filter(isUuid), list];
  let where = `u.pending_delete = false AND u.email IS NOT NULL AND btrim(u.email) <> ''
    AND (g.id = ANY($1::uuid[]) OR g.authentik_pk = ANY($2::text[]))`;
  where += hiddenUserClause(params, includeHiddenPrefixes).replace(/\busername\b/g, "u.username");
  where += userPathClause(params).replace(/\bpath\b/g, "u.path");
  const r = await db.query(
    `SELECT DISTINCT u.username, u.name, u.email, u.agency, u.attributes, u.authentik_pk, u.id
     FROM users u
     JOIN group_members gm ON gm.user_id = u.id
     JOIN groups g ON g.id = gm.group_id
     WHERE ${where}`,
    params
  );
  return r.rows.map((row) => ({
    pk: row.authentik_pk != null ? row.authentik_pk : row.id,
    username: row.username,
    name: row.name,
    email: row.email,
    attributes: row.attributes || {},
    agency: row.agency,
  }));
}

async function countUsersByTemplate({ agencyName, agencySuffixes } = {}) {
  const params = [];
  let where = `pending_delete = false`;
  where += hiddenUserClause(params, false);
  where += userPathClause(params);
  if (agencyName && String(agencyName).trim()) {
    params.push(String(agencyName).trim());
    where += ` AND lower(agency_name) = lower($${params.length})`;
  }
  if (Array.isArray(agencySuffixes) && agencySuffixes.length) {
    params.push(agencySuffixes.map((s) => String(s || "").trim().toLowerCase()).filter(Boolean));
    where += ` AND lower(agency) = ANY($${params.length}::text[])`;
  }
  const r = await db.query(
    `SELECT COALESCE(NULLIF(btrim(current_template), ''), 'Manual Group Selection') AS tmpl, COUNT(*)::int AS n
     FROM users WHERE ${where}
     GROUP BY 1`,
    params
  );
  const counts = Object.create(null);
  for (const row of r.rows) counts[row.tmpl] = row.n;
  return counts;
}

async function countCurrentTemplateByAgencySuffix({ agencySuffixes } = {}) {
  const params = [];
  let where = `pending_delete = false AND agency IS NOT NULL AND btrim(agency) <> ''
    AND current_template IS NOT NULL AND btrim(current_template) <> ''
    AND current_template <> 'Manual Group Selection'`;
  where += hiddenUserClause(params, false);
  where += userPathClause(params);
  if (Array.isArray(agencySuffixes) && agencySuffixes.length) {
    params.push(agencySuffixes.map((s) => String(s || "").trim().toLowerCase()).filter(Boolean));
    where += ` AND lower(agency) = ANY($${params.length}::text[])`;
  }
  const r = await db.query(
    `SELECT lower(agency) AS sfx, current_template AS tmpl, COUNT(*)::int AS n
     FROM users WHERE ${where}
     GROUP BY 1, 2`,
    params
  );
  const counts = Object.create(null);
  for (const row of r.rows) {
    counts[`${row.sfx}::${String(row.tmpl).toLowerCase()}`] = row.n;
  }
  return counts;
}

async function countGroupsMatching(opts = {}) {
  const r = await searchGroupsPaged({ ...opts, page: 1, pageSize: 1 });
  return Number(r.total) || 0;
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
      `SELECT * FROM groups WHERE id = $1::uuid OR authentik_pk = $2 LIMIT 1`,
      [raw, raw]
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
  agencySuffixes,
  agencyAbbreviation,
  usernamePrefix,
  includeHiddenPrefixes = false,
  includeGroups = true,
  activeOnly,
  excludeGroupPks,
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
  const suffixList = Array.isArray(agencySuffixes)
    ? agencySuffixes.map((s) => String(s || "").trim().toLowerCase()).filter(Boolean)
    : [];
  if (Array.isArray(agencySuffixes) && !suffixList.length) {
    const psEmpty = Math.max(1, Math.min(200, Number(pageSize) || 25));
    return {
      users: [],
      total: 0,
      page: 1,
      pageSize: psEmpty,
      hasNext: false,
      hasPrev: false,
    };
  }
  if (suffixList.length === 1) {
    params.push(suffixList[0]);
    where += ` AND lower(agency) = $${params.length}`;
  } else if (suffixList.length > 1) {
    params.push(suffixList);
    where += ` AND lower(agency) = ANY($${params.length}::text[])`;
  } else if (agencySuffix && String(agencySuffix).trim()) {
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
  const excludePks = Array.isArray(excludeGroupPks)
    ? excludeGroupPks.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  if (excludePks.length) {
    params.push(excludePks);
    where += ` AND NOT EXISTS (
      SELECT 1 FROM group_members gm
      JOIN groups g ON g.id = gm.group_id
      WHERE gm.user_id = users.id
        AND (g.id::text = ANY($${params.length}::text[]) OR COALESCE(g.authentik_pk, '') = ANY($${params.length}::text[]))
    )`;
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
  agencyNames,
  createdType,
  createdTypeDetail,
  extraGroupPks,
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
  const names = Array.isArray(agencyNames)
    ? agencyNames.map((n) => String(n || "").trim()).filter(Boolean)
    : [];
  if (names.length) {
    params.push(names);
    params.push(names.map((n) => n.toLowerCase()));
    where += ` AND (
      created_type_detail ILIKE ANY($${params.length - 1}::text[])
      OR lower(attributes->>'agency_name') = ANY($${params.length}::text[])
    )`;
  }
  const scope = String(createdType || "").trim().toLowerCase();
  if (scope === "global" || scope === "generic") {
    where += ` AND (
      created_type IS NULL
      OR lower(created_type) IN ('global', 'generic', '')
    )`;
  } else if (scope) {
    params.push(scope);
    where += ` AND lower(created_type) = $${params.length}`;
  }
  if (createdTypeDetail) {
    params.push(String(createdTypeDetail));
    where += ` AND created_type_detail ILIKE $${params.length}`;
  }
  const extra = (Array.isArray(extraGroupPks) ? extraGroupPks : [])
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  if (extra.length) {
    params.push(extra.filter(isUuid), extra);
    where = `(${where}) OR (pending_delete = false AND (id = ANY($${params.length - 1}::uuid[]) OR authentik_pk = ANY($${params.length}::text[])))`;
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

async function listUserPksByAgencySuffixes(suffixes) {
  const list = (Array.isArray(suffixes) ? suffixes : [])
    .map((s) => String(s || "").trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) return [];
  const params = [list];
  let extra = hiddenUserClause(params, false);
  extra += userPathClause(params);
  const r = await db.query(
    `SELECT COALESCE(authentik_pk, id::text) AS pk
     FROM users
     WHERE pending_delete = false
       AND lower(agency) = ANY($1::text[])
       ${extra}`,
    params
  );
  return r.rows.map((row) => String(row.pk));
}

async function listUserPksByGroupIds(groupIds) {
  const ids = (Array.isArray(groupIds) ? groupIds : [])
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  if (!ids.length) return [];
  const uuids = ids.filter(isUuid);
  const params = [uuids, ids];
  let extra = hiddenUserClause(params, false);
  extra = extra.replace(/\busername\b/g, "u.username").replace(/\bpath\b/g, "u.path");
  extra += userPathClause(params).replace(/\bpath\b/g, "u.path");
  const r = await db.query(
    `SELECT DISTINCT COALESCE(u.authentik_pk, u.id::text) AS pk
     FROM group_members gm
     JOIN users u ON u.id = gm.user_id
     JOIN groups g ON g.id = gm.group_id
     WHERE u.pending_delete = false
       AND g.pending_delete = false
       AND (g.id = ANY($1::uuid[]) OR g.authentik_pk = ANY($2::text[]))
       ${extra}`,
    params
  );
  return r.rows.map((row) => String(row.pk));
}

async function filterUserPksByAgencySuffixes(pks, suffixes) {
  const ids = (Array.isArray(pks) ? pks : []).map((x) => String(x || "").trim()).filter(Boolean);
  const list = (Array.isArray(suffixes) ? suffixes : [])
    .map((s) => String(s || "").trim().toLowerCase())
    .filter(Boolean);
  if (!ids.length || !list.length) return [];
  const uuids = ids.filter(isUuid);
  const r = await db.query(
    `SELECT COALESCE(authentik_pk, id::text) AS pk
     FROM users
     WHERE pending_delete = false
       AND lower(agency) = ANY($1::text[])
       AND (authentik_pk = ANY($2::text[]) OR id = ANY($3::uuid[]) OR id::text = ANY($2::text[]))`,
    [list, ids, uuids]
  );
  return r.rows.map((row) => String(row.pk));
}

async function countActiveUsersByAgencyName(agencyName) {
  const name = String(agencyName || "").trim();
  if (!name) return 0;
  const params = [name];
  let extra = hiddenUserClause(params, false);
  extra += userPathClause(params);
  const r = await db.query(
    `SELECT COUNT(*)::int AS n
     FROM users
     WHERE pending_delete = false
       AND is_active = true
       AND lower(agency_name) = lower($1)
       ${extra}`,
    params
  );
  return r.rows[0]?.n || 0;
}

async function listGroupMembersForExport(groupIds, { agencyAbbreviations } = {}) {
  const ids = (Array.isArray(groupIds) ? groupIds : [])
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  const map = new Map();
  for (const id of ids) map.set(id, []);
  if (!ids.length) return map;
  const uuids = ids.filter(isUuid);
  const params = [uuids, ids];
  let extra = "";
  const abbrs = (Array.isArray(agencyAbbreviations) ? agencyAbbreviations : [])
    .map((a) => String(a || "").trim())
    .filter(Boolean);
  if (abbrs.length) {
    params.push(abbrs.map((a) => a.toLowerCase()));
    extra += ` AND lower(u.agency_abbreviation) = ANY($${params.length}::text[])`;
  }
  extra += hiddenUserClause(params, false)
    .replace(/\busername\b/g, "u.username")
    .replace(/\bpath\b/g, "u.path");
  extra += userPathClause(params).replace(/\bpath\b/g, "u.path");
  const r = await db.query(
    `SELECT g.id::text AS gid, g.authentik_pk, u.username, u.name, COALESCE(u.authentik_pk, u.id::text) AS user_pk
     FROM groups g
     LEFT JOIN group_members gm ON gm.group_id = g.id
     LEFT JOIN users u ON u.id = gm.user_id AND u.pending_delete = false ${extra}
     WHERE g.pending_delete = false
       AND (g.id = ANY($1::uuid[]) OR g.authentik_pk = ANY($2::text[]))
     ORDER BY u.username NULLS LAST`,
    params
  );
  for (const row of r.rows) {
    const keys = [String(row.gid || ""), String(row.authentik_pk || "")].filter(Boolean);
    if (!row.username) continue;
    const member = {
      pk: row.user_pk,
      username: row.username,
      name: row.name || "",
    };
    for (const key of keys) {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(member);
    }
  }
  return map;
}

async function replaceUserMembershipsFromUuids(userUuid, groupUuids, groupsHash, client) {
  const q = client || db;
  await q.query("DELETE FROM group_members WHERE user_id = $1", [userUuid]);
  const ids = (Array.isArray(groupUuids) ? groupUuids : []).filter(Boolean);
  if (ids.length) {
    await q.query(
      `INSERT INTO group_members (user_id, group_id)
       SELECT $1, x FROM unnest($2::uuid[]) AS x
       ON CONFLICT DO NOTHING`,
      [userUuid, ids]
    );
  }
  await q.query("UPDATE users SET groups_hash = $2, updated_at = now() WHERE id = $1", [
    userUuid,
    groupsHash || membershipHash([]),
  ]);
}

async function updateUsersAgencyNameColumn(oldName, newName, agencySuffix) {
  const oldN = String(oldName || "").trim();
  const newN = String(newName || "").trim();
  const sfx = String(agencySuffix || "").trim().toLowerCase();
  if (!oldN || !newN || !sfx) return [];
  const r = await db.query(
    `UPDATE users SET
       agency_name = $1,
       attributes = jsonb_set(COALESCE(attributes, '{}'::jsonb), '{agency_name}', to_jsonb($1::text), true),
       sync_status = 'pending',
       updated_at = now()
     WHERE pending_delete = false
       AND lower(agency) = $2
       AND lower(agency_name) = lower($3)
     RETURNING id, authentik_pk, username, attributes`,
    [newN, sfx, oldN]
  );
  return r.rows;
}

async function updateUsersAgencyAbbreviationColumn(agencyName, abbreviation) {
  const name = String(agencyName || "").trim();
  const abbr = String(abbreviation || "").trim();
  if (!name || !abbr) return [];
  const r = await db.query(
    `UPDATE users SET
       agency_abbreviation = $1,
       attributes = jsonb_set(COALESCE(attributes, '{}'::jsonb), '{agency_abbreviation}', to_jsonb($1::text), true),
       sync_status = 'pending',
       updated_at = now()
     WHERE pending_delete = false
       AND lower(agency_name) = lower($2)
       AND COALESCE(agency_abbreviation, '') <> $1
     RETURNING id, authentik_pk, username, attributes`,
    [abbr, name]
  );
  return r.rows;
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
  listUserEmailRowsByGroupPks,
  countUsersByTemplate,
  countCurrentTemplateByAgencySuffix,
  countGroupsMatching,
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
  listUserPksByAgencySuffixes,
  listUserPksByGroupIds,
  filterUserPksByAgencySuffixes,
  countActiveUsersByAgencyName,
  listGroupMembersForExport,
  replaceUserMembershipsFromUuids,
  updateUsersAgencyNameColumn,
  updateUsersAgencyAbbreviationColumn,
};
