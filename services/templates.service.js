const pgCache = require("./pgCache");

const FILE = null;

function load() {
  return Array.isArray(pgCache.caches.templates) ? pgCache.caches.templates : [];
}

function save(data) {
  pgCache.replaceTemplates(Array.isArray(data) ? data : []);
}

module.exports = { load, save, FILE };
