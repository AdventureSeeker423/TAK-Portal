"use strict";

const api = require("../authentik");

async function findUserByUsername(username) {
  const uname = String(username || "").trim();
  if (!uname) return null;
  try {
    const res = await api.get("/core/users/", {
      params: { username: uname, include_groups: true, page_size: 20 },
    });
    const results = Array.isArray(res.data?.results) ? res.data.results : [];
    const exact = results.find(
      (u) => String(u.username || "").toLowerCase() === uname.toLowerCase()
    );
    if (exact) return exact;
  } catch (_) {}
  try {
    const res = await api.get("/core/users/", {
      params: { search: uname, include_groups: true, page_size: 50 },
    });
    const results = Array.isArray(res.data?.results) ? res.data.results : [];
    return (
      results.find((u) => String(u.username || "").toLowerCase() === uname.toLowerCase()) ||
      null
    );
  } catch (e) {
    throw e;
  }
}

async function findGroupByName(name) {
  const n = String(name || "").trim();
  if (!n) return null;
  try {
    const res = await api.get("/core/groups/", {
      params: { name: n, include_users: false, page_size: 20 },
    });
    const results = Array.isArray(res.data?.results) ? res.data.results : [];
    const exact = results.find(
      (g) => String(g.name || "").toLowerCase() === n.toLowerCase()
    );
    if (exact) return exact;
  } catch (_) {}
  try {
    const res = await api.get("/core/groups/", {
      params: { search: n, include_users: false, page_size: 50 },
    });
    const results = Array.isArray(res.data?.results) ? res.data.results : [];
    return (
      results.find((g) => String(g.name || "").toLowerCase() === n.toLowerCase()) || null
    );
  } catch (e) {
    throw e;
  }
}

async function createGroup(name, attributes) {
  const body = { name: String(name || "").trim(), attributes: attributes || {} };
  const res = await api.post("/core/groups/", body);
  return res.data;
}

async function patchGroup(pk, patch) {
  const res = await api.patch(`/core/groups/${pk}/`, patch);
  return res.data;
}

async function createUser({ username, email, name, isActive, attributes, path }) {
  const body = {
    username: String(username || "").trim(),
    email: email || "",
    name: name || "",
    is_active: isActive !== false,
    attributes: attributes || {},
  };
  if (path) body.path = path;
  const res = await api.post("/core/users/", body);
  return res.data;
}

async function patchUser(pk, patch) {
  const res = await api.patch(`/core/users/${pk}/`, patch);
  return res.data;
}

async function pingAuthentik() {
  await api.get("/core/users/", { params: { page_size: 1 } });
}

module.exports = {
  findUserByUsername,
  findGroupByName,
  createGroup,
  patchGroup,
  createUser,
  patchUser,
  pingAuthentik,
};
