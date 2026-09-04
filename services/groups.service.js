const { getString, getInt } = require("./env");
const api = require("./authentik");
const usersService = require("./users.service");
const templatesStore = require("./templates.service");
const accessSvc = require("./access.service");
const agenciesStore = require("./agencies.service");
const directoryRepo = require("./directoryRepo.service");
const authentikOutbox = require("./authentikOutbox.service");
const db = require("./db");

// ---------------- Action-lock helpers ----------------
// If a group name starts with any prefix in GROUPS_ACTIONS_HIDDEN_PREFIXES,
// the UI hides action buttons AND the API will reject mutating operations.
function getGroupActionLockPrefixes() {
  return String(getString("GROUPS_ACTIONS_HIDDEN_PREFIXES", ""))
    .split(",")
    .map(p => String(p || "").trim().toLowerCase())
    .filter(Boolean);
}

function isGroupActionLocked(groupName) {
  const n = String(groupName || "").trim().toLowerCase();
  if (!n) return false;
  const prefixes = getGroupActionLockPrefixes();
  if (!prefixes.length) return false;
  return prefixes.some(p => n.startsWith(p));
}

function getHiddenUserPrefixes() {
  return String(getString("USERS_HIDDEN_PREFIXES", ""))
    .split(",")
    .map(p => String(p || "").trim().toLowerCase())
    .filter(Boolean);
}

async function assertGroupNotActionLocked(groupId, { ignoreLocks } = {}) {
  const group = await getGroupById(groupId);
  if (!ignoreLocks && isGroupActionLocked(group?.name)) {
    throw new Error(`Actions are locked for group ${group?.name || groupId}`);
  }
  return group;
}

function normalizePath(p) {
  return String(p || "").replace(/^\/+|\/+$/g, "");
}

function normalizeId(x) {
  return String(x ?? "").trim();
}

function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(v => String(v).trim()).filter(Boolean);
}

function getGroupMembersCacheTtlMs() {
  const seconds = getInt("GROUP_MEMBERS_CACHE_TTL_SECONDS", 60);
  const s = Number.isFinite(Number(seconds)) ? Number(seconds) : 60;
  if (s <= 0) return 0;
  return Math.max(5, s) * 1000;
}

function getGroupMembersPageSize() {
  const n = Number(getInt("GROUP_MEMBERS_PAGE_SIZE", 1000) || 1000);
  if (!Number.isFinite(n) || n <= 0) return 1000;
  return Math.min(2000, Math.max(100, n));
}

function ensureTakPrefix(name) {
  const n = String(name || "").trim();
  if (!n) return "";
  return n.toLowerCase().startsWith("tak_") ? n : `tak_${n}`;
}

function stripTakPrefix(name) {
  const n = String(name || "").trim();
  return n.toLowerCase().startsWith("tak_") ? n.slice(4) : n;
}

function isAgencyAdminGroupName(name) {
  return /-AgencyAdmin$/i.test(String(name || "").trim());
}

/** Portal TAK groups get tak_; agency admin groups keep authentik-* names as-is. */
function resolveAuthentikGroupName(raw) {
  const n = String(raw || "").trim();
  if (!n) return "";
  return isAgencyAdminGroupName(n) ? n : ensureTakPrefix(n);
}

function cnBasisForGroupName(resolvedName) {
  const n = String(resolvedName || "").trim();
  if (!n) return "";
  return isAgencyAdminGroupName(n) ? n : stripTakPrefix(n);
}

// Normalize the Authentik CN attribute:
// - attribute key must be "CN" (uppercase)
// - value must be exactly "CN: <nameWithoutTak>" (no surrounding quotes)
// - if caller provides a value, accept either "<nameWithoutTak>" or "CN: <nameWithoutTak>"
function normalizeCNValue(rawValue, nameWithoutTak) {
  // Desired CN attribute value is JUST the group name (without "tak_" and without any "CN:" prefix).
  const fallback = String(nameWithoutTak || "").trim();

  let v = String(rawValue ?? "").trim();
  if (!v) v = fallback;

  // Handle nested/bad forms like:
  // - CN: "CN: Group Name"
  // - "CN: Group Name"
  // - CN: Group Name
  // by repeatedly stripping leading CN: and surrounding quotes.
  for (let i = 0; i < 5; i++) {
    v = v.trim();

    // Strip leading CN:
    const m = v.match(/^cn\s*:\s*(.*)$/i);
    if (m) v = String(m[1] || "").trim();

    // Strip one layer of surrounding quotes
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1).trim();
      continue;
    }

    // If we didn't strip quotes this iteration and there's no CN: prefix left, we're done
    if (!m) break;
  }

  v = v.trim();
  return v || fallback;
}


function applyUserVisibilityFilters(users) {
  let out = Array.isArray(users) ? users : [];

  // Hide users by username prefix for group-related views (USERS_HIDDEN_PREFIXES)
  const hiddenPrefixes = getHiddenUserPrefixes();
  if (hiddenPrefixes.length) {
    out = out.filter(u => {
      const username = String(u?.username || "").trim().toLowerCase();
      return !hiddenPrefixes.some(p => username.startsWith(p));
    });
  }

  // Respect AUTHENTIK_USER_PATH if set
  const folderRaw = String(getString("AUTHENTIK_USER_PATH", "")).trim();
  if (!folderRaw) return out;

  const target = normalizePath(folderRaw);
  return out.filter(u => {
    const up = normalizePath(u.path);
    return up === target || up.startsWith(target + "/");
  });
}

// ---------------- Authentik API helpers (groups) ----------------
async function getAllGroupsRaw(options = {}) {
  const includeHidden = !!options.includeHidden;
  const pageSize = 200;
  const all = [];
  let page = 1;
  for (;;) {
    const r = await directoryRepo.searchGroupsPaged({
      includeHidden,
      page,
      pageSize,
      q: options.q,
      prefix: options.prefix,
    });
    all.push(...(r.groups || []));
    if (!r.hasNext) break;
    page += 1;
  }
  return all;
}

function applyGroupsHiddenPrefixFilter(groups, { includeHidden = false } = {}) {
  const list = Array.isArray(groups) ? groups : [];
  if (includeHidden) return list;

  const prefixes = String(getString("GROUPS_HIDDEN_PREFIXES", ""))
    .split(",")
    .map((p) => String(p || "").trim().toLowerCase())
    .filter(Boolean);
  if (!prefixes.length) return list;

  return list.filter((g) => {
    const name = String(g?.name || "").trim().toLowerCase();
    return !prefixes.some((p) => name.startsWith(p));
  });
}

async function searchGroupsRaw(searchTerm, { includeHidden = false } = {}) {
  const term = String(searchTerm || "").trim();
  if (!term) return [];
  const r = await directoryRepo.searchGroupsPaged({
    q: term,
    includeHidden,
    page: 1,
    pageSize: 200,
  });
  return r.groups;
}

async function getGroupsByPrefix(groupPrefix) {
  const prefix = agenciesStore.normalizeGroupPrefix(groupPrefix);
  if (!prefix) return [];
  const prefixUpper = prefix.toUpperCase();

  const searchTerms = [`tak_${prefix}`, prefix];
  const seen = new Set();
  const matches = [];

  for (const term of searchTerms) {
    const batch = await searchGroupsRaw(term);
    for (const g of batch) {
      const pk = String(g?.pk ?? g?.id ?? "").trim();
      if (!pk || seen.has(pk)) continue;
      if (accessSvc.isGroupMarkedPrivate(g)) continue;
      if (accessSvc.getGroupNamePrefixUpper(g) !== prefixUpper) continue;
      seen.add(pk);
      matches.push(g);
    }
  }

  return matches;
}

/** Groups owned by agency full name (created_type_detail), with search fallback. */
async function getGroupsByAgencyName(agencyName) {
  const name = String(agencyName || "").trim();
  if (!name) return [];
  const agency = { name };
  const searchTerms = [name];
  const gp = (() => {
    const agencies = agenciesStore.load();
    const found = agencies.find(
      (a) => String(a?.name || "").trim().toLowerCase() === name.toLowerCase()
    );
    return agenciesStore.normalizeGroupPrefix(found?.groupPrefix);
  })();
  if (gp) {
    searchTerms.push(`tak_${gp}`, gp);
  }

  const seen = new Set();
  const matches = [];

  for (const term of searchTerms) {
    const batch = await searchGroupsRaw(term);
    for (const g of batch) {
      const pk = String(g?.pk ?? g?.id ?? "").trim();
      if (!pk || seen.has(pk)) continue;
      if (accessSvc.isGroupMarkedPrivate(g)) continue;
      if (!agenciesStore.isAgencyOwnedGroup(g, agency)) continue;
      seen.add(pk);
      matches.push(g);
    }
  }

  return matches;
}

/**
 * Agency / multi-agency admin fast path: attribute-scoped Authentik search per
 * managed agency plus explicitly granted groups (allowedAdminGroupIds).
 */
async function getGroupsForAuthUser(authUser, { forceRefresh = false } = {}) {
  const access = accessSvc.getAgencyAccess(authUser);
  if (access.isGlobalAdmin) {
    return getAllGroups({ forceRefresh });
  }

  const { agencyNames } = accessSvc.getAgencyAndCountyPrefixesForUser(authUser);
  const names = Array.isArray(agencyNames) ? agencyNames : [];
  if (!names.length) return [];

  const byAgency = await Promise.all(names.map((n) => getGroupsByAgencyName(n)));
  const merged = byAgency.flat();

  const havePks = new Set(
    merged
      .map((g) => String(g?.pk ?? g?.id ?? "").trim())
      .filter(Boolean)
  );

  const extraIds = accessSvc.getAllowedAdminGroupIdsForUser(authUser);
  if (extraIds && extraIds.size) {
    const toFetch = [...extraIds].filter((id) => !havePks.has(id));
    const extras = await Promise.all(
      toFetch.map((id) => getGroupById(id).catch(() => null))
    );
    for (const g of extras) {
      if (!g || accessSvc.isGroupMarkedPrivate(g)) continue;
      const pk = String(g?.pk ?? g?.id ?? "").trim();
      if (!pk || havePks.has(pk)) continue;
      havePks.add(pk);
      merged.push(g);
    }
  }

  return accessSvc.filterGroupsForUser(authUser, merged);
}

function normalizeAgencyAbbreviations(agencyAbbreviations, agencyAbbreviation) {
  const fromList = Array.isArray(agencyAbbreviations) ? agencyAbbreviations : [];
  const fromSingle = agencyAbbreviation ? [agencyAbbreviation] : [];
  const seen = new Set();
  const out = [];
  for (const raw of [...fromList, ...fromSingle]) {
    const abbr = String(raw || "").trim();
    if (!abbr) continue;
    const key = abbr.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abbr);
  }
  return out;
}

function resolveAgencyAbbreviationsForAuthUser(authUser) {
  const access = accessSvc.getAgencyAccess(authUser);
  if (access.isGlobalAdmin) return [];

  const allowed = access.allowedAgencySuffixes || [];
  if (!allowed.length) return [];

  const allowedSet = new Set(allowed.map(accessSvc.normalizeSuffix).filter(Boolean));
  const agencies = agenciesStore.load();
  const abbrs = [];
  const seen = new Set();

  for (const agency of agencies) {
    const sfx = accessSvc.normalizeSuffix(agency?.suffix);
    if (!sfx || !allowedSet.has(sfx)) continue;
    const abbr = String(agency.groupPrefix || "").trim();
    if (!abbr) continue;
    const key = abbr.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    abbrs.push(abbr);
  }

  return abbrs;
}

function compareGroupMembersByName(a, b) {
  const av = String(a?.name || a?.username || "").toLowerCase();
  const bv = String(b?.name || b?.username || "").toLowerCase();
  return av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" });
}

function projectGroupMember(u) {
  return {
    pk: u.pk,
    username: u.username,
    name: u.name,
    email: u.email,
    is_active: u.is_active,
    path: u.path,
    attributes: u.attributes || {},
  };
}

async function getGroupMembersMultiAgencyPaged(
  groupId,
  { authUser, agencyAbbreviations, page = 1, pageSize = 100 } = {}
) {
  const gid = normalizeId(groupId);
  const abbrs = normalizeAgencyAbbreviations(agencyAbbreviations);
  if (!gid || !abbrs.length) {
    throw new Error("Group id and agency abbreviations are required");
  }

  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.min(500, Math.max(1, Number(pageSize) || 100));

  const totalEntries = await Promise.all(
    abbrs.map((abbr) =>
      getUsersByGroupIdPagedRaw({
        groupId: gid,
        agencyAbbreviation: abbr,
        page: 1,
        pageSize: 1,
      })
    )
  );
  const totalVisible = totalEntries.reduce(
    (sum, r) => sum + Number(r?.total || 0),
    0
  );

  if (totalVisible === 0) {
    return {
      users: [],
      total: 0,
      page: safePage,
      pageSize: safePageSize,
      hasNext: false,
      hasPrev: false,
    };
  }

  const totalPages = Math.max(1, Math.ceil(totalVisible / safePageSize));
  const currentPage = Math.min(safePage, totalPages);
  const startFiltered = (currentPage - 1) * safePageSize;
  const endFilteredExclusive = startFiltered + safePageSize;

  const cursors = abbrs.map((abbr) => ({
    abbr,
    page: 1,
    rows: [],
    idx: 0,
    done: false,
    loading: null,
  }));

  async function loadNextBatch(cursor) {
    if (cursor.done) return;
    if (cursor.loading) {
      await cursor.loading;
      return;
    }
    cursor.loading = (async () => {
      while (!cursor.done) {
        const res = await getUsersByGroupIdPagedRaw({
          groupId: gid,
          agencyAbbreviation: cursor.abbr,
          page: cursor.page,
          pageSize: Math.max(safePageSize, 50),
        });
        cursor.page += 1;
        const batch = Array.isArray(res?.users) ? res.users : [];
        if (batch.length) {
          cursor.rows = batch;
          cursor.idx = 0;
          return;
        }
        if (!res?.hasNext) {
          cursor.done = true;
          return;
        }
      }
    })();
    await cursor.loading;
    cursor.loading = null;
  }

  async function popNext(cursor) {
    if (cursor.idx >= cursor.rows.length && !cursor.done) {
      await loadNextBatch(cursor);
    }
    if (cursor.idx >= cursor.rows.length) return null;
    return cursor.rows[cursor.idx++];
  }

  async function peekNext(cursor) {
    if (cursor.idx >= cursor.rows.length && !cursor.done) {
      await loadNextBatch(cursor);
    }
    if (cursor.idx >= cursor.rows.length) return null;
    return cursor.rows[cursor.idx];
  }

  const pageUsers = [];
  let filteredIndex = 0;
  const seenPk = new Set();

  while (filteredIndex < endFilteredExclusive) {
    let bestCursor = null;
    let bestUser = null;

    for (const cursor of cursors) {
      const candidate = await peekNext(cursor);
      if (!candidate) continue;
      if (!bestUser || compareGroupMembersByName(candidate, bestUser) < 0) {
        bestUser = candidate;
        bestCursor = cursor;
      }
    }

    if (!bestCursor || !bestUser) break;

    await popNext(bestCursor);
    const pk = String(bestUser?.pk ?? bestUser?.id ?? "").trim();
    if (pk && seenPk.has(pk)) continue;
    if (pk) seenPk.add(pk);

    if (!accessSvc.isUserInAllowedAgencies(authUser || null, bestUser)) continue;

    if (filteredIndex >= startFiltered && filteredIndex < endFilteredExclusive) {
      pageUsers.push(projectGroupMember(bestUser));
    }
    filteredIndex += 1;
  }

  return {
    users: pageUsers,
    total: totalVisible,
    page: currentPage,
    pageSize: safePageSize,
    hasNext: currentPage < totalPages,
    hasPrev: currentPage > 1,
  };
}

async function getGroupMembersMultiAgencyAll(
  groupId,
  { authUser, agencyAbbreviations } = {}
) {
  const gid = normalizeId(groupId);
  const abbrs = normalizeAgencyAbbreviations(agencyAbbreviations);
  if (!gid || !abbrs.length) return [];

  const batches = await Promise.all(
    abbrs.map((abbr) =>
      getUsersByGroupIdRaw({ groupId: gid, agencyAbbreviation: abbr })
    )
  );

  const seenPk = new Set();
  const merged = [];
  for (const batch of batches) {
    for (const u of Array.isArray(batch) ? batch : []) {
      const pk = String(u?.pk ?? u?.id ?? "").trim();
      if (!pk || seenPk.has(pk)) continue;
      if (!accessSvc.isUserInAllowedAgencies(authUser || null, u)) continue;
      seenPk.add(pk);
      merged.push(u);
    }
  }

  merged.sort(compareGroupMembersByName);
  return merged.map(projectGroupMember);
}

async function getGroupById(groupId) {
  const id = normalizeId(groupId);
  if (!id) throw new Error("Group id is required");
  const g = await directoryRepo.getGroupById(id);
  if (!g) throw new Error("Group not found");
  return g;
}

async function getAllUsersRaw() {
  const pageSize = 200;
  const all = [];
  let page = 1;
  for (;;) {
    const r = await directoryRepo.searchUsersPaged({
      page,
      pageSize,
      includeGroups: false,
    });
    all.push(...(r.users || []));
    if (!r.hasNext) break;
    page += 1;
  }
  return all;
}

// Fetch all users who are members of a single group via Authentik filtering.
// This avoids downloading the full user list and filtering in Node.
async function getUsersByGroupIdRaw({ groupId, agencyAbbreviation } = {}) {
  const gid = normalizeId(groupId);
  if (!gid) throw new Error("Group id is required");

  const cacheKey = `${gid}::${String(agencyAbbreviation || "").trim().toUpperCase()}`;
  const now = Date.now();
  const ttlMs = getGroupMembersCacheTtlMs();
  if (ttlMs > 0) {
    const cached = GROUP_USERS_CACHE.get(cacheKey);
    if (cached && now - cached.loadedAt < ttlMs) {
      return cached.data;
    }
  }

  const abbr = String(agencyAbbreviation || "").trim();
  let users = [];
  let page = 1;
  let hasNext = true;
  while (hasNext) {
    const r = await directoryRepo.getGroupMembersPaged(gid, {
      page,
      pageSize: getGroupMembersPageSize(),
      agencyAbbreviation: abbr || undefined,
    });
    users = users.concat(r.users || []);
    hasNext = !!r.hasNext;
    page += 1;
    if (page > 500) break;
  }

  const filtered = applyUserVisibilityFilters(users);
  if (ttlMs > 0) {
    GROUP_USERS_CACHE.set(cacheKey, {
      loadedAt: now,
      data: filtered,
    });
  }
  return filtered;
}

// Fetch one page of users in a group via Authentik filtering.
async function getUsersByGroupIdPagedRaw({ groupId, agencyAbbreviation, page = 1, pageSize = 100 } = {}) {
  const gid = normalizeId(groupId);
  if (!gid) throw new Error("Group id is required");
  return directoryRepo.getGroupMembersPaged(gid, {
    page,
    pageSize,
    agencyAbbreviation,
  });
}

// ---------------- Group CRUD ----------------
async function createGroup(name, opts = {}) {
  const raw = String(name || "").trim();

  const n = resolveAuthentikGroupName(raw);
  if (!n) throw new Error("Group name is required");

  const payload = { name: n };

  // Merge description (if provided) with any attributes passed in opts
  const attributes = Object.assign({}, opts.attributes || {});
  const description = String(opts.description || "").trim();
  if (description) {
    attributes.description = description;
  }

  // Always maintain the Authentik CN attribute (uppercase key).
  // Value should be exactly "CN: <group name without tak_>".
  // Also remove any legacy lowercase "cn" attribute to avoid duplicates.
  delete attributes.cn;
  attributes.CN = normalizeCNValue(
    Object.prototype.hasOwnProperty.call(attributes, "CN") ? attributes.CN : "",
    cnBasisForGroupName(n)
  );

  if (Object.keys(attributes).length > 0) {
    payload.attributes = attributes;
  }

  const outboxId = await db.withTransaction(async (c) => {
    const local = await directoryRepo.insertLocalGroup({ name: n, attributes }, c);
    payload._localId = local.uuid || local.id;
    const oid = await authentikOutbox.enqueue(
      {
        kind: "create_group",
        entityType: "group",
        entityId: local.uuid || local.id,
        payload: { name: n, attributes },
      },
      c
    );
    return { oid, local };
  });
  await authentikOutbox.waitForOutbox(outboxId.oid, 8000);
  invalidateGroupsCache();
  return directoryRepo.getGroupById(outboxId.local.uuid || outboxId.local.id);
}

async function setUserGroups(userId, groupIds) {
  return usersService.setUserGroups(userId, groupIds);
}

async function deleteGroup(groupId) {
  const id = normalizeId(groupId);
  if (!id) throw new Error("Group id is required");
  const g = await directoryRepo.getGroupById(id);
  if (!g) throw new Error("Group not found");
  const outboxId = await db.withTransaction(async (c) => {
    await c.query("UPDATE groups SET pending_delete = true WHERE id = $1", [g.uuid || g.id]);
    return authentikOutbox.enqueue(
      {
        kind: "delete_group",
        entityType: "group",
        entityId: g.uuid || g.id,
        authentikPk: g.authentik_pk,
        payload: { authentikPk: g.authentik_pk },
      },
      c
    );
  });
  await authentikOutbox.waitForOutbox(outboxId, 8000);
  invalidateGroupsCache();
  invalidateGroupUsersCache();
  return true;
}

/**
 * Rename group in Authentik AND update templates store (templates store group *names*, not IDs)
 * Returns the updated group object, with some meta counts attached.
 */
async function renameGroup(groupId, newName, opts = {}) {
  const id = normalizeId(groupId);
  if (!id) throw new Error("Group id is required");

  // Block protected groups unless explicitly overridden
  const current = await assertGroupNotActionLocked(id, opts);

  const n = ensureTakPrefix(String(newName || "").trim());
  if (!n) throw new Error("Group name is required");

  // Need old name so we can update templates that reference it
  const oldName = String(current?.name || "").trim();
  if (!oldName) throw new Error("Could not determine existing group name");

  // Rename (and update attributes) in Authentik
  const payload = { name: n };

  const wantsDescription = Object.prototype.hasOwnProperty.call(opts, "description");
  const wantsPrivate = Object.prototype.hasOwnProperty.call(opts, "private");
  const wantsCN = Object.prototype.hasOwnProperty.call(opts, "CN") ||
                  Object.prototype.hasOwnProperty.call(opts, "cn");

  const existingAttrs =
    current && typeof current.attributes === "object" && current.attributes
      ? current.attributes
      : {};

  const nextAttrs = { ...existingAttrs };

  if (wantsDescription) {
    const desc = String(opts.description || "").trim();
    nextAttrs.description = desc;
  }

  if (wantsPrivate) {
    const priv = String(opts.private || "").trim().toLowerCase();
    // Normalize to "yes"/"no"; treat anything other than "yes" as "no"
    nextAttrs.private = priv === "yes" ? "yes" : "no";
  }

  // Always maintain the Authentik CN attribute (uppercase key).
  // Value should be exactly "CN: <group name without tak_>".
  // Remove any legacy lowercase "cn" attribute to avoid duplicates.
  delete nextAttrs.cn;
  const provided = wantsCN
    ? (Object.prototype.hasOwnProperty.call(opts, "CN") ? opts.CN : opts.cn)
    : "";
  nextAttrs.CN = normalizeCNValue(provided, stripTakPrefix(n));

  payload.attributes = nextAttrs;

  const outboxId = await db.withTransaction(async (c) => {
    await directoryRepo.updateLocalGroup(
      current.uuid || current.id,
      { name: n, attributes: nextAttrs, sync_status: "pending" },
      c
    );
    return authentikOutbox.enqueue(
      {
        kind: "patch_group",
        entityType: "group",
        entityId: current.uuid || current.id,
        authentikPk: current.authentik_pk,
        payload: { authentikPk: current.authentik_pk, patch: payload },
      },
      c
    );
  });
  await authentikOutbox.waitForOutbox(outboxId, 8000);
  const updatedGroup = await directoryRepo.getGroupById(current.uuid || current.id);

  // Update templates (replace oldName -> n)
  const templates = templatesStore.load();
  let templatesUpdated = 0;

  const updatedTemplates = templates.map(t => {
    const groupsArr = Array.isArray(t.groups) ? t.groups : [];
    if (!groupsArr.includes(oldName)) return t;

    templatesUpdated++;
    const nextGroups = groupsArr.map(g => (g === oldName ? n : g));
    return { ...t, groups: nextGroups };
  });

  if (templatesUpdated > 0) {
    templatesStore.save(updatedTemplates);
  }

  invalidateGroupsCache();

  return {
    ...updatedGroup,
    _meta: {
      oldName,
      newName: n,
      templatesUpdated
    }
  };
}

/**
 * Rename a group in Authentik (name + CN). Does not update agency-templates.json
 * (caller batches template updates separately).
 */
async function patchGroupNameAndCn(groupId, newName, opts = {}) {
  const id = normalizeId(groupId);
  if (!id) throw new Error("Group id is required");

  const current = opts.skipActionLock
    ? await getGroupById(id)
    : await assertGroupNotActionLocked(id, opts);

  const n = resolveAuthentikGroupName(newName);
  if (!n) throw new Error("Group name is required");

  const existingAttrs =
    current && typeof current.attributes === "object" && current.attributes
      ? { ...current.attributes }
      : {};

  const nextAttrs = { ...existingAttrs };
  delete nextAttrs.cn;
  delete nextAttrs.CN;

  if (opts.attributes && typeof opts.attributes === "object") {
    const merged = { ...opts.attributes };
    delete merged.cn;
    delete merged.CN;
    Object.assign(nextAttrs, merged);
  }

  const wantsCN =
    Object.prototype.hasOwnProperty.call(opts, "CN") ||
    Object.prototype.hasOwnProperty.call(opts, "cn");
  const provided = wantsCN
    ? Object.prototype.hasOwnProperty.call(opts, "CN")
      ? opts.CN
      : opts.cn
    : "";
  nextAttrs.CN = normalizeCNValue(provided, cnBasisForGroupName(n));

  const wait = opts.waitForOutbox !== false && opts.bulk !== true;
  const outboxId = await db.withTransaction(async (c) => {
    await directoryRepo.updateLocalGroup(
      current.uuid || current.id,
      { name: n, attributes: nextAttrs, sync_status: "pending" },
      c
    );
    return authentikOutbox.enqueue(
      {
        kind: "patch_group",
        entityType: "group",
        entityId: current.uuid || current.id,
        authentikPk: current.authentik_pk,
        payload: { authentikPk: current.authentik_pk, patch: { name: n, attributes: nextAttrs } },
      },
      c
    );
  });
  if (wait) await authentikOutbox.waitForOutbox(outboxId, 8000);
  invalidateGroupsCache();
  return directoryRepo.getGroupById(current.uuid || current.id);
}

function rewriteTakGroupNamePrefix(groupName, oldPrefix, newPrefix) {
  const oldP = agenciesStore.normalizeGroupPrefix(oldPrefix);
  const newP = agenciesStore.normalizeGroupPrefix(newPrefix);
  const original = String(groupName || "").trim();
  if (!oldP || !newP || oldP === newP) return original;

  const oldUpper = oldP.toUpperCase();
  let n = stripTakPrefix(original);
  let behavior = "";
  if (n.endsWith("_READ")) {
    behavior = "_READ";
    n = n.slice(0, -5);
  } else if (n.endsWith("_WRITE")) {
    behavior = "_WRITE";
    n = n.slice(0, -6);
  }

  const nUpper = n.toUpperCase();

  // Prefer full oldPrefix match (supports multi-word short names with spaces).
  if (nUpper.startsWith(oldUpper + " - ")) {
    const right = n.slice(oldP.length + 3);
    return ensureTakPrefix(`${newP} - ${right}${behavior}`);
  }
  if (nUpper.startsWith(oldUpper + " ")) {
    const right = n.slice(oldP.length + 1);
    return ensureTakPrefix(`${newP} ${right}${behavior}`);
  }
  if (nUpper.startsWith(oldUpper + "-") && !nUpper.startsWith(oldUpper + " -")) {
    const right = n.slice(oldP.length);
    // Keep the separator character from the original ("-" or rest after prefix)
    return ensureTakPrefix(`${newP}${right}${behavior}`);
  }
  if (nUpper === oldUpper) {
    return ensureTakPrefix(`${newP}${behavior}`);
  }

  return original;
}

// ---------- impact + cleanup ----------
async function getDeleteImpact(groupId) {
  const id = normalizeId(groupId);
  if (!id) throw new Error("Group id is required");

  // Group name matters because templates store names, not IDs
  const group = await getGroupById(id);
  const groupName = String(group.name || "").trim();

  // Users affected (computed via full user list; reuse users.service cache)
  const members = await directoryRepo.getGroupMembersPaged(id, { page: 1, pageSize: 1 });
  const usersAffected = members.total || 0;

  // Templates affected (by group name; allow tak_ prefix variants)
  const templates = templatesStore.load();
  const groupNameKey = groupName.toLowerCase();
  const groupNameWithoutTak = stripTakPrefix(groupName).toLowerCase();
  const templatesAffected = templates
    .map((t, index) => ({
      index,
      name: String(t.name || ""),
      agencySuffix: String(t.agencySuffix || ""),
      has: Array.isArray(t.groups) && t.groups.some((g) => {
        const raw = String(g || "").trim();
        if (!raw) return false;
        const key = raw.toLowerCase();
        if (key === groupNameKey) return true;
        return stripTakPrefix(raw).toLowerCase() === groupNameWithoutTak;
      })
    }))
    .filter(x => x.has)
    .map(x => ({ index: x.index, name: x.name, agencySuffix: x.agencySuffix }));

  return {
    groupId: id,
    groupName,
    usersAffected,
    templatesAffected,
    templatesAffectedCount: templatesAffected.length
  };
}

async function deleteGroupWithCleanup(groupId, opts = {}) {
  const id = normalizeId(groupId);
  if (!id) throw new Error("Group id is required");

  // Block protected groups unless explicitly overridden
  await assertGroupNotActionLocked(id, opts);

  const impact = await getDeleteImpact(id);
  const groupName = impact.groupName;
  const groupNameKey = String(groupName || "").trim().toLowerCase();
  const groupNameWithoutTak = stripTakPrefix(groupName).toLowerCase();

  function templateGroupMatches(storedName) {
    const raw = String(storedName || "").trim();
    if (!raw || !groupNameKey) return false;
    const key = raw.toLowerCase();
    if (key === groupNameKey) return true;
    return stripTakPrefix(raw).toLowerCase() === groupNameWithoutTak;
  }

  // NOTE:
  // We do NOT manually strip this group from every user.
  // Authentik will take care of cleaning up user/group membership
  // when the group is deleted. Here we only clean up templates.

  // 1) Remove group name from templates
  const templates = templatesStore.load();
  let templatesUpdated = 0;
  let templatesNowEmpty = 0;

  const updatedTemplates = templates.map(t => {
    const groups = Array.isArray(t.groups) ? t.groups : [];
    if (!groupName || !groups.some(templateGroupMatches)) return t;

    const nextGroups = groups.filter(g => !templateGroupMatches(g));
    templatesUpdated++;

    if (nextGroups.length === 0) templatesNowEmpty++;

    return { ...t, groups: nextGroups };
  });

  templatesStore.save(updatedTemplates);

  // 2) Delete group in Authentik
  await deleteGroup(id);

  return {
    success: true,
    groupId: id,
    groupName,
    usersUpdated: 0, // we did not touch users directly
    templatesUpdated,
    templatesNowEmpty
  };
}

// ---------- bulk helpers (group-centric membership updates) ----------
async function bulkAddUsersToGroup(groupId, userPks, { preloadedGroup } = {}) {
  const id = normalizeId(groupId);
  if (!id) throw new Error("Group id is required");

  const toAdd = normalizeIdList(userPks);
  if (!toAdd.length) return { matched: 0, changed: 0 };

  // Use group.users as source of truth so we don't drop unseen members
  const group = preloadedGroup || await getGroupById(id);
  const currentUsers = await directoryRepo.getGroupMemberPks(id);

  const merged = Array.from(
    new Set([...currentUsers, ...toAdd.map(String)])
  );

  if (merged.length === currentUsers.length) {
    // nothing actually changed
    return { matched: toAdd.length, changed: 0, affectedPks: [] };
  }

  await db.withTransaction(async (c) => {
    await directoryRepo.addLocalMembers(id, toAdd, c);
    await authentikOutbox.enqueue(
      {
        kind: "add_members",
        entityType: "group",
        entityId: group.uuid || group.id,
        authentikPk: group.authentik_pk,
        payload: {
          authentikPk: group.authentik_pk,
          userPks: toAdd.filter((x) => directoryRepo.isAuthentikPkToken(x)),
        },
      },
      c
    );
  });
  invalidateGroupUsersCache();

  const currentSet = new Set(currentUsers);
  const affectedPks = toAdd.filter((pk) => !currentSet.has(String(pk)));

  return {
    matched: toAdd.length,
    changed: merged.length - currentUsers.length,
    affectedPks,
  };
}

async function bulkRemoveUsersFromGroup(groupId, userPks, { preloadedGroup } = {}) {
  const id = normalizeId(groupId);
  if (!id) throw new Error("Group id is required");

  const toRemove = new Set(
    normalizeIdList(userPks).map(String)
  );
  if (!toRemove.size) return { matched: 0, changed: 0, affectedPks: [] };

  const group = preloadedGroup || await getGroupById(id);
  const currentUsers = await directoryRepo.getGroupMemberPks(id);

  const remaining = currentUsers.filter(pk => !toRemove.has(String(pk)));

  if (remaining.length === currentUsers.length) {
    // nothing actually changed
    return { matched: toRemove.size, changed: 0, affectedPks: [] };
  }

  await db.withTransaction(async (c) => {
    await directoryRepo.removeLocalMembers(id, Array.from(toRemove), c);
    await authentikOutbox.enqueue(
      {
        kind: "remove_members",
        entityType: "group",
        entityId: group.uuid || group.id,
        authentikPk: group.authentik_pk,
        payload: {
          authentikPk: group.authentik_pk,
          userPks: Array.from(toRemove).filter((x) => directoryRepo.isAuthentikPkToken(x)),
        },
      },
      c
    );
  });
  invalidateGroupUsersCache();

  const affectedPks = currentUsers.filter((pk) => toRemove.has(String(pk)));

  return {
    matched: toRemove.size,
    changed: currentUsers.length - remaining.length,
    affectedPks,
  };
}

/**
 * Apply add/remove to a group with one membership read and at most one PATCH.
 * Filters to users who actually need a membership change.
 */
async function applyBulkGroupMembership(groupId, action, userPks) {
  const id = normalizeId(groupId);
  const pks = normalizeIdList(userPks);
  const normalizedAction = String(action || "").trim().toLowerCase() === "remove" ? "remove" : "add";
  if (!id || !pks.length) return { matched: 0, changed: 0, affectedPks: [] };

  const group = await getGroupById(id);
  const memberSet = new Set(
    (Array.isArray(group?.users) ? group.users : []).map((x) => String(x))
  );
  const filtered =
    normalizedAction === "remove"
      ? pks.filter((pk) => memberSet.has(String(pk)))
      : pks.filter((pk) => !memberSet.has(String(pk)));

  if (!filtered.length) {
    return { matched: pks.length, changed: 0, affectedPks: [] };
  }

  const result =
    normalizedAction === "remove"
      ? await bulkRemoveUsersFromGroup(id, filtered, { preloadedGroup: group })
      : await bulkAddUsersToGroup(id, filtered, { preloadedGroup: group });

  return {
    matched: pks.length,
    changed: Number(result?.changed || 0),
    affectedPks: Array.isArray(result?.affectedPks) ? result.affectedPks : filtered,
  };
}

async function fetchUsersByIds(userIds) {
  const ids = normalizeIdList(userIds);
  if (!ids.length) return [];
  const rows = await Promise.all(
    ids.map((id) => usersService.getUserById(id).catch(() => null))
  );
  return rows.filter(Boolean);
}

async function restrictPksToAllowedAgencies(pks, authUser) {
  const access = accessSvc.getAgencyAccess(authUser || null);
  const ids = Array.isArray(pks) ? pks.map((x) => String(x || "").trim()).filter(Boolean) : [];
  if (!ids.length) return [];
  if (access.isGlobalAdmin) return ids;
  return directoryRepo.filterUserPksByAgencySuffixes(ids, access.allowedAgencySuffixes || []);
}

async function loadUserPksByAgencySuffixes({
  selectedSuffixes,
  emitProgress,
} = {}) {
  const suffixes = Array.isArray(selectedSuffixes) ? selectedSuffixes : [];
  emitProgress({
    phase: "loading_users",
    total: suffixes.length,
    processed: 0,
    matched: 0,
  });
  const pks = await directoryRepo.listUserPksByAgencySuffixes(suffixes);
  emitProgress({
    phase: "loading_users",
    total: suffixes.length,
    processed: suffixes.length,
    matched: pks.length,
  });
  return pks;
}

// ---------- Mass assign / unassign ----------
async function massAssignUsersToGroup({ groupId, suffixes, sourceGroupIds, userIds, authUser, onProgress } = {}) {
  const emitProgress = (p) => {
    if (typeof onProgress === "function") onProgress(p);
  };

  const gid = normalizeId(groupId);
  if (!gid) throw new Error("Target group is required");

  // Block protected groups
  await assertGroupNotActionLocked(gid);

  // Strategy 1: explicit users
  const explicitUsers = normalizeIdList(userIds);
  if (explicitUsers.length) {
    emitProgress({ phase: "matching", total: explicitUsers.length, processed: 0, matched: 0 });
    const targetUserPks = await restrictPksToAllowedAgencies(explicitUsers, authUser);
    emitProgress({
      phase: "matching",
      total: explicitUsers.length,
      processed: explicitUsers.length,
      matched: targetUserPks.length,
    });

    emitProgress({ phase: "applying", total: targetUserPks.length, processed: targetUserPks.length, matched: targetUserPks.length });
    const { changed } = await applyBulkGroupMembership(gid, "add", targetUserPks);

    emitProgress({ phase: "done", total: targetUserPks.length, processed: targetUserPks.length, matched: targetUserPks.length, updated: changed });
    return { matched: targetUserPks.length, updated: changed };
  }

  // Strategy 2: users with an existing group (allow multiple)
  const srcGids = normalizeIdList(sourceGroupIds);
  if (srcGids.length) {
    emitProgress({ phase: "matching", total: srcGids.length, processed: 0, matched: 0 });
    const memberPks = await directoryRepo.listUserPksByGroupIds(srcGids);
    const targetUserPks = await restrictPksToAllowedAgencies(memberPks, authUser);
    emitProgress({
      phase: "matching",
      total: targetUserPks.length,
      processed: targetUserPks.length,
      matched: targetUserPks.length,
    });
    emitProgress({ phase: "applying", total: targetUserPks.length, processed: targetUserPks.length, matched: targetUserPks.length });
    const { changed } = await applyBulkGroupMembership(gid, "add", targetUserPks);

    emitProgress({ phase: "done", total: targetUserPks.length, processed: targetUserPks.length, matched: targetUserPks.length, updated: changed });
    return { matched: targetUserPks.length, updated: changed };
  }

  // Strategy 3: match by agency suffix
  const suffixList = Array.isArray(suffixes)
    ? suffixes.map(s => String(s).trim().toLowerCase()).filter(Boolean)
    : [];
  if (!suffixList.length) {
    throw new Error("Provide suffixes, sourceGroupIds, or userIds to mass-assign.");
  }

  const selectedSuffixes = Array.from(new Set(suffixList));
  let matchedPks = await loadUserPksByAgencySuffixes({
    selectedSuffixes,
    emitProgress,
  });

  emitProgress({
    phase: "matching",
    total: matchedPks.length,
    processed: matchedPks.length,
    matched: matchedPks.length,
  });
  const targetUserPks = await restrictPksToAllowedAgencies(matchedPks, authUser);
  emitProgress({ phase: "applying", total: targetUserPks.length, processed: targetUserPks.length, matched: targetUserPks.length });
  const { changed } = await applyBulkGroupMembership(gid, "add", targetUserPks);

  invalidateGroupUsersCache();

  emitProgress({ phase: "done", total: targetUserPks.length, processed: targetUserPks.length, matched: targetUserPks.length, updated: changed });
  return { matched: targetUserPks.length, updated: changed };
}

// Fetch all members of a single group (lightweight projection)
async function getGroupMembers(groupId, { authUser, agencyAbbreviation, agencyAbbreviations } = {}) {
  const gid = normalizeId(groupId);
  if (!gid) throw new Error("Group id is required");

  const abbrs = normalizeAgencyAbbreviations(agencyAbbreviations, agencyAbbreviation);
  if (abbrs.length > 1) {
    return getGroupMembersMultiAgencyAll(gid, { authUser, agencyAbbreviations: abbrs });
  }

  // Try the fast path: server-side filter by group membership
  // and (for agency admins) by agency_abbreviation.
  let members = await getUsersByGroupIdRaw({
    groupId: gid,
    agencyAbbreviation: abbrs[0] || null,
  });

  // Safety: for agency admins, ensure they don't see users outside of allowed agencies.
  // (This preserves existing behavior even if attributes are missing/misconfigured.)
  const access = accessSvc.getAgencyAccess(authUser || null);
  if (!access.isGlobalAdmin) {
    members = members.filter((u) =>
      accessSvc.isUserInAllowedAgencies(authUser || null, u)
    );
  }

  return members.map(projectGroupMember);
}

async function getGroupMembersPaged(groupId, { authUser, agencyAbbreviation, agencyAbbreviations, page = 1, pageSize = 100 } = {}) {
  const gid = normalizeId(groupId);
  if (!gid) throw new Error("Group id is required");

  const abbrs = normalizeAgencyAbbreviations(agencyAbbreviations, agencyAbbreviation);
  if (abbrs.length > 1) {
    return getGroupMembersMultiAgencyPaged(gid, {
      authUser,
      agencyAbbreviations: abbrs,
      page,
      pageSize,
    });
  }

  const result = await getUsersByGroupIdPagedRaw({
    groupId: gid,
    agencyAbbreviation: abbrs[0] || null,
    page,
    pageSize,
  });

  let members = Array.isArray(result.users) ? result.users : [];
  const access = accessSvc.getAgencyAccess(authUser || null);
  if (!access.isGlobalAdmin) {
    members = members.filter((u) =>
      accessSvc.isUserInAllowedAgencies(authUser || null, u)
    );
  }

  const projected = members.map(projectGroupMember);

  return {
    users: projected,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    hasNext: !!result.hasNext,
    hasPrev: !!result.hasPrev,
  };
}

async function massUnassignUsersFromGroup({ groupId, suffixes, sourceGroupIds, userIds, authUser, onProgress } = {}) {
  const emitProgress = (p) => {
    if (typeof onProgress === "function") onProgress(p);
  };

  const gid = normalizeId(groupId);
  if (!gid) throw new Error("Target group is required");

  // Block protected groups
  await assertGroupNotActionLocked(gid);

  // Strategy 1: explicit users
  const explicitUsers = normalizeIdList(userIds);
  if (explicitUsers.length) {
    emitProgress({ phase: "matching", total: explicitUsers.length, processed: 0, matched: 0 });
    const targetUserPks = await restrictPksToAllowedAgencies(explicitUsers, authUser);
    emitProgress({
      phase: "matching",
      total: explicitUsers.length,
      processed: explicitUsers.length,
      matched: targetUserPks.length,
    });

    emitProgress({ phase: "applying", total: targetUserPks.length, processed: targetUserPks.length, matched: targetUserPks.length });
    const { changed } = await applyBulkGroupMembership(gid, "remove", targetUserPks);

    invalidateGroupUsersCache();

    emitProgress({ phase: "done", total: targetUserPks.length, processed: targetUserPks.length, matched: targetUserPks.length, updated: changed });
    return { matched: targetUserPks.length, updated: changed };
  }

  // Strategy 2: users with an existing group (allow multiple)
  const srcGids = normalizeIdList(sourceGroupIds);
  if (srcGids.length) {
    emitProgress({ phase: "matching", total: srcGids.length, processed: 0, matched: 0 });
    const memberPks = await directoryRepo.listUserPksByGroupIds(srcGids);
    const targetUserPks = await restrictPksToAllowedAgencies(memberPks, authUser);
    emitProgress({
      phase: "matching",
      total: targetUserPks.length,
      processed: targetUserPks.length,
      matched: targetUserPks.length,
    });
    emitProgress({ phase: "applying", total: targetUserPks.length, processed: targetUserPks.length, matched: targetUserPks.length });
    const { changed } = await applyBulkGroupMembership(gid, "remove", targetUserPks);

    invalidateGroupUsersCache();

    emitProgress({ phase: "done", total: targetUserPks.length, processed: targetUserPks.length, matched: targetUserPks.length, updated: changed });
    return { matched: targetUserPks.length, updated: changed };
  }

  // Strategy 3: match by agency suffix
  const suffixList = Array.isArray(suffixes)
    ? suffixes.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
    : [];
  if (!suffixList.length) {
    throw new Error("Provide suffixes, sourceGroupIds, or userIds to mass-unassign.");
  }

  const selectedSuffixes = Array.from(new Set(suffixList));
  let matchedPks = await loadUserPksByAgencySuffixes({
    selectedSuffixes,
    emitProgress,
  });

  emitProgress({
    phase: "matching",
    total: matchedPks.length,
    processed: matchedPks.length,
    matched: matchedPks.length,
  });
  const targetUserPks = await restrictPksToAllowedAgencies(matchedPks, authUser);
  emitProgress({ phase: "applying", total: targetUserPks.length, processed: targetUserPks.length, matched: targetUserPks.length });
  const { changed } = await applyBulkGroupMembership(gid, "remove", targetUserPks);

  emitProgress({ phase: "done", total: targetUserPks.length, processed: targetUserPks.length, matched: targetUserPks.length, updated: changed });
  return { matched: targetUserPks.length, updated: changed };
}


// ---------------- Authentik group/user helpers ----------------
// In-memory TTL cache:
// Groups are read far more often than they change, so caching them drastically
// speeds up endpoints used by the Users page without cutting functionality.
// Default: disabled. Enable by setting GROUPS_CACHE_TTL_SECONDS>0 in env.
const GROUPS_CACHE_TTL_MS = (getInt("GROUPS_CACHE_TTL_SECONDS", 60) || 0) * 1000;
let GROUPS_CACHE_BY_INCLUDE_HIDDEN = {
  true: { data: null, loadedAt: 0 },
  false: { data: null, loadedAt: 0 },
};
let GROUP_USERS_CACHE = new Map();

function invalidateGroupsCache() {
  GROUPS_CACHE_BY_INCLUDE_HIDDEN = {
    true: { data: null, loadedAt: 0 },
    false: { data: null, loadedAt: 0 },
  };
  try {
    require("./dashboardStatsCache.service").refreshAfterGroupsChanged();
  } catch (_) {
    /* dashboard refresh is best-effort */
  }
}

function invalidateGroupUsersCache() {
  GROUP_USERS_CACHE = new Map();
}

async function getAllGroups(options = {}) {
  const { includeHidden = false, forceRefresh = false } = options || {};

  // Allow explicitly disabling caching.
  if (GROUPS_CACHE_TTL_MS <= 0) {
    return await getAllGroupsRaw({ includeHidden });
  }

  const key = !!includeHidden;
  const entry = GROUPS_CACHE_BY_INCLUDE_HIDDEN[key];
  const now = Date.now();

  const cacheValid =
    entry &&
    entry.data &&
    entry.loadedAt &&
    now - entry.loadedAt < GROUPS_CACHE_TTL_MS;

  if (!forceRefresh && cacheValid) return entry.data;

  const data = await getAllGroupsRaw({ includeHidden });
  GROUPS_CACHE_BY_INCLUDE_HIDDEN[key] = { data, loadedAt: now };
  return data;
}

async function getAllUsers(options = {}) {
  // ignore options / forceRefresh; always reload
  return await getAllUsersRaw();
}

function stripTakPrefixForExport(name) {
  const n = String(name || "").trim();
  if (n.toLowerCase().startsWith("tak_")) return n.slice(4);
  return n;
}

function parseChannelBehaviorFromGroupName(fullName) {
  let name = stripTakPrefixForExport(fullName);
  if (name.endsWith("_READ")) return "READ";
  if (name.endsWith("_WRITE")) return "WRITE";
  return "BOTH";
}

function csvEscapeCell(value) {
  const s = String(value == null ? "" : value);
  return `"${s.replace(/"/g, '""')}"`;
}

function getGroupExportColumns(group) {
  const attrs = group?.attributes || {};
  const priv = String(attrs.private || "no").trim().toLowerCase();

  return {
    groupName: stripTakPrefixForExport(group?.name || ""),
    behavior: parseChannelBehaviorFromGroupName(group?.name),
    private: priv === "yes" ? "Yes" : "No",
    type: String(attrs.created_type || "").trim(),
  };
}

/**
 * Build CSV: one row per member; group columns only on the first member row.
 * @param {Array<{ group: object, members: object[] }>} rows
 */
function buildGroupsExportCsv(rows) {
  const header = ["Group Name", "Behavior", "Private", "Type", "Username", "Name"];
  const lines = [header.map(csvEscapeCell).join(",")];

  for (const row of Array.isArray(rows) ? rows : []) {
    const group = row?.group || {};
    const cols = getGroupExportColumns(group);
    const members = (Array.isArray(row?.members) ? row.members : [])
      .map((m) => ({
        username: String(m?.username || "").trim(),
        name: String(m?.name || "").trim(),
      }))
      .filter((m) => m.username)
      .sort((a, b) =>
        a.username.localeCompare(b.username, undefined, {
          numeric: true,
          sensitivity: "base",
        })
      );

    if (!members.length) {
      lines.push(
        [cols.groupName, cols.behavior, cols.private, cols.type, "", ""]
          .map(csvEscapeCell)
          .join(",")
      );
      continue;
    }

    members.forEach((member, idx) => {
      if (idx === 0) {
        lines.push(
          [
            cols.groupName,
            cols.behavior,
            cols.private,
            cols.type,
            member.username,
            member.name,
          ]
            .map(csvEscapeCell)
            .join(",")
        );
      } else {
        lines.push(
          ["", "", "", "", member.username, member.name].map(csvEscapeCell).join(",")
        );
      }
    });
  }

  return `${lines.join("\n")}\n`;
}

async function searchGroupsForAuthUser(
  authUser,
  {
    q,
    scope,
    detail,
    page = 1,
    pageSize = 25,
    includeMutualAid = false,
  } = {}
) {
  const access = accessSvc.getAgencyAccess(authUser);
  const scopeKey = String(scope || "all").trim().toLowerCase();
  const detailRaw = String(detail || "").trim();
  const opts = {
    q: String(q || "").trim(),
    page,
    pageSize,
    includeHidden: !!includeMutualAid,
  };

  if (scopeKey === "agency") {
    opts.createdType = "agency";
    if (detailRaw) opts.agencyName = detailRaw;
  } else if (scopeKey === "state" || scopeKey === "county" || scopeKey === "region") {
    opts.createdType = scopeKey;
    if (detailRaw) opts.createdTypeDetail = detailRaw;
  } else if (scopeKey === "global") {
    opts.createdType = "global";
  }

  if (!access.isGlobalAdmin) {
    const { agencyNames } = accessSvc.getAgencyAndCountyPrefixesForUser(authUser);
    opts.agencyNames = Array.isArray(agencyNames) ? agencyNames : [];
    const extra = accessSvc.getAllowedAdminGroupIdsForUser(authUser);
    if (extra && extra.size) opts.extraGroupPks = Array.from(extra);
    if (!opts.agencyNames.length && !(opts.extraGroupPks && opts.extraGroupPks.length)) {
      return { groups: [], total: 0, page: 1, pageSize, hasNext: false, hasPrev: false };
    }
  }

  return directoryRepo.searchGroupsPaged(opts);
}

/**
 * Collect member lists for export (sequential Authentik calls per group).
 */
async function collectGroupsExportRows(groups, { authUser, agencyAbbreviation, agencyAbbreviations } = {}) {
  const list = Array.isArray(groups) ? groups : [];
  const abbrs = normalizeAgencyAbbreviations(agencyAbbreviations, agencyAbbreviation);
  const ids = list.map((g) => normalizeId(g?.pk ?? g?.id)).filter(Boolean);
  const membersByGroup = await directoryRepo.listGroupMembersForExport(ids, {
    agencyAbbreviations: abbrs,
  });
  void authUser;
  return list.map((group) => {
    const gid = normalizeId(group?.pk ?? group?.id);
    const members = membersByGroup.get(gid) || membersByGroup.get(String(group?.pk || "")) || [];
    return { group, members };
  });
}

module.exports = {
  getAllGroups,
  getGroupsForAuthUser,
  searchGroupsForAuthUser,
  getGroupsByPrefix,
  getGroupsByAgencyName,
  resolveAgencyAbbreviationsForAuthUser,
  getGroupById,
  createGroup,
  deleteGroup,

  renameGroup,
  patchGroupNameAndCn,
  rewriteTakGroupNamePrefix,
  stripTakPrefix,
  ensureTakPrefix,
  invalidateGroupsCache,

  getDeleteImpact,
  deleteGroupWithCleanup,
  massAssignUsersToGroup,
  getGroupMembers,
  getGroupMembersPaged,
  massUnassignUsersFromGroup,
  bulkAddUsersToGroup,
  bulkRemoveUsersFromGroup,
  applyBulkGroupMembership,
  buildGroupsExportCsv,
  collectGroupsExportRows,

  // shared for other services if needed
  getAllUsers,
};
