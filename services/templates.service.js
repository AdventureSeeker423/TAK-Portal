const pgCache = require("./pgCache");

const FILE = null;

function load() {
  return Array.isArray(pgCache.caches.templates) ? pgCache.caches.templates : [];
}

function save(data) {
  pgCache.replaceTemplates(Array.isArray(data) ? data : []);
}

function getDefaultTemplateForAgency(agencySuffix) {
  const sfx = String(agencySuffix || "").trim().toLowerCase();
  if (!sfx) return null;
  const found = load().find((t) => {
    if (!t || !t.isDefault) return false;
    const tSfx = String(t.agencySuffix || "").trim().toLowerCase();
    const name = String(t.name || "").trim();
    return tSfx === sfx && !!name;
  });
  return found || null;
}

function countVisibleToUser({ isGlobalAdmin, allowedAgencySuffixes } = {}) {
  const all = load();
  if (isGlobalAdmin) return all.length;
  const allowedSet = new Set(
    (Array.isArray(allowedAgencySuffixes) ? allowedAgencySuffixes : [])
      .map((s) => String(s || "").trim().toLowerCase())
      .filter(Boolean)
  );
  if (!allowedSet.size) return 0;
  return all.filter((t) =>
    allowedSet.has(String(t.agencySuffix || "").trim().toLowerCase())
  ).length;
}

module.exports = { load, save, FILE, getDefaultTemplateForAgency, countVisibleToUser };
