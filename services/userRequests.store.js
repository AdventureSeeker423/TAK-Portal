const pgCache = require("./pgCache");

const FILE = null;

function load() {
  return Array.isArray(pgCache.caches.userRequests) ? pgCache.caches.userRequests : [];
}

function save(items) {
  pgCache.replaceUserRequests(Array.isArray(items) ? items : []);
}

module.exports = { FILE, load, save };
