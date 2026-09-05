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

module.exports = { load, save, FILE, getDefaultTemplateForAgency };
