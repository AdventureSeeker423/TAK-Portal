/**
 * Self-hosted OpenAddresses collections for Live Map search.
 *
 * Catalog: GET https://batch.openaddresses.io/api/collections (public).
 * Download: GET /api/collections/:id/data with Bearer token (required).
 * Index: address GeoJSON/CSV → SQLite FTS5 via node:sqlite. Zip is deleted after import.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const zlib = require("zlib");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");
const { getString } = require("./env");

const OA_API = "https://batch.openaddresses.io/api";
const USER_AGENT = "TAK-Portal (OpenAddresses collections)";
const CATALOG_TTL_MS = 60 * 1000;
const SEARCH_CANDIDATES = 250;
const GLOBAL_SIZE_WARN_BYTES = 40 * 1024 * 1024 * 1024;

function loadSqlite() {
  try {
    return require("node:sqlite");
  } catch (err) {
    const e = new Error(
      "Local OpenAddresses search needs Node.js 22+ with the built-in node:sqlite module."
    );
    e.cause = err;
    throw e;
  }
}

function formatBytes(n) {
  const bytes = Number(n);
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 ? 0 : v >= 10 ? 1 : 2;
  return v.toFixed(digits) + " " + units[i];
}

function formatDateMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "—";
  try {
    return new Date(n).toISOString().slice(0, 10);
  } catch (_) {
    return "—";
  }
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  const s = String(line || "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function isAddressDataPath(filePath) {
  const p = String(filePath || "")
    .replace(/\\/g, "/")
    .toLowerCase();
  if (!p || p.endsWith("/") || p.includes("__macosx")) return false;
  if (p.endsWith(".meta") || p.endsWith(".txt") || p.endsWith(".md")) return false;
  if (p.includes("parcel") || p.includes("building") || p.includes("centerline")) {
    return false;
  }
  if (p.endsWith(".geojson") || p.endsWith(".json") || p.endsWith(".geojson.gz") || p.endsWith(".json.gz")) {
    return true;
  }
  if (p.endsWith(".csv") || p.endsWith(".csv.gz")) return true;
  return false;
}

function isAddressCsvPath(filePath) {
  return isAddressDataPath(filePath);
}

function coordsFromGeometry(geom) {
  if (!geom || typeof geom !== "object") return null;
  const coords = geom.coordinates;
  if (geom.type === "Point" && Array.isArray(coords) && coords.length >= 2) {
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon };
  }
  return null;
}

function prop(props, key) {
  if (!props || typeof props !== "object") return "";
  const v = props[key] != null ? props[key] : props[String(key).toUpperCase()];
  return String(v == null ? "" : v).trim();
}

function featureToRecord(obj) {
  if (!obj || typeof obj !== "object") return null;
  const feature = obj.type === "Feature" ? obj : obj.type === "Point" ? { geometry: obj, properties: {} } : obj;
  const coords = coordsFromGeometry(feature.geometry);
  if (!coords) return null;
  const props = feature.properties && typeof feature.properties === "object" ? feature.properties : {};
  const number = prop(props, "number");
  const street = prop(props, "street");
  if (!number && !street) return null;
  const label = buildAddressLabel({
    number,
    street,
    unit: prop(props, "unit"),
    city: prop(props, "city"),
    region: prop(props, "region"),
    postcode: prop(props, "postcode"),
  });
  if (!label) return null;
  return { lat: coords.lat, lon: coords.lon, label };
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch (_) {
    return null;
  }
}

function headerIndexMap(cells) {
  const map = {};
  for (let i = 0; i < cells.length; i++) {
    const key = String(cells[i] || "")
      .replace(/^\uFEFF/, "")
      .trim()
      .toUpperCase();
    if (key) map[key] = i;
  }
  return map;
}

function isAddressHeader(map) {
  return (
    map &&
    (map.LON != null || map.LONGITUDE != null) &&
    (map.LAT != null || map.LATITUDE != null) &&
    (map.STREET != null || map.NUMBER != null)
  );
}

function cell(row, map, name) {
  const idx = map[name];
  if (idx == null) return "";
  return String(row[idx] || "").trim();
}

function buildAddressLabel(fields) {
  const number = String(fields.number || "").trim();
  const street = String(fields.street || "").trim();
  const unit = String(fields.unit || "").trim();
  const city = String(fields.city || "").trim();
  const region = String(fields.region || "").trim();
  const postcode = String(fields.postcode || "").trim();
  const line1 = [number, street].filter(Boolean).join(" ");
  const cityRegion = [city, region].filter(Boolean).join(", ");
  return [line1, unit, cityRegion, postcode].filter(Boolean).join(", ");
}

function rowToRecord(row, map) {
  const lon = Number(cell(row, map, "LON") || cell(row, map, "LONGITUDE"));
  const lat = Number(cell(row, map, "LAT") || cell(row, map, "LATITUDE"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const number = cell(row, map, "NUMBER");
  const street = cell(row, map, "STREET");
  if (!number && !street) return null;
  const label = buildAddressLabel({
    number,
    street,
    unit: cell(row, map, "UNIT"),
    city: cell(row, map, "CITY"),
    region: cell(row, map, "REGION"),
    postcode: cell(row, map, "POSTCODE"),
  });
  if (!label) return null;
  return { lat, lon, label };
}

function tokenizeQuery(query) {
  return String(query || "")
    .toLowerCase()
    .replace(/['"]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function toFtsQuery(query) {
  const tokens = tokenizeQuery(query);
  if (!tokens.length) return "";
  return tokens
    .map(function (t) {
      return t + "*";
    })
    .join(" AND ");
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toRad) *
      Math.cos(lat2 * toRad) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function scoreLabel(label, tokens) {
  const lower = String(label || "").toLowerCase();
  let score = 70;
  for (const t of tokens) {
    if (lower.includes(t)) score += 6;
  }
  if (tokens[0] && lower.startsWith(tokens[0])) score += 10;
  return score;
}

function safeCollectionName(name, id) {
  const n = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return n || "collection-" + String(id);
}

function isGlobalCollection(row) {
  const name = String(row?.name || "").toLowerCase();
  const human = String(row?.human || "").toLowerCase();
  const size = Number(row?.size) || 0;
  return name === "global" || human === "global" || size >= GLOBAL_SIZE_WARN_BYTES;
}

function getToken() {
  return getString("OPENADDRESSES_TOKEN", "").trim();
}

function extractDownloadUrl(payload) {
  if (!payload || typeof payload !== "object") return "";
  const keys = ["url", "download", "href", "code", "s3"];
  for (const key of keys) {
    const v = payload[key];
    if (typeof v === "string" && /^https?:\/\//i.test(v)) return v;
  }
  return "";
}

function iterateStatement(statement, param) {
  if (typeof statement.iterate === "function") {
    return param === undefined ? statement.iterate() : statement.iterate(param);
  }
  const rows = param === undefined ? statement.all() : statement.all(param);
  return Array.isArray(rows) ? rows : [];
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function createOpenAddressesService(options = {}) {
  const rootDir =
    options.rootDir || path.join(__dirname, "..", "data", "openaddresses");
  const fetchImpl =
    options.fetch ||
    function (url, init) {
      if (typeof fetch !== "function") {
        return Promise.reject(new Error("fetch is not available"));
      }
      return fetch(url, init);
    };
  const getTokenFn = options.getToken || getToken;

  const downloadsDir = path.join(rootDir, "downloads");
  const dbLivePath = path.join(rootDir, "addresses.sqlite");
  const dbBuildPath = path.join(rootDir, "addresses.sqlite.build");
  const manifestPath = path.join(rootDir, "manifest.json");

  let job = null;
  let searchDb = null;
  let catalogCache = { at: 0, rows: null, error: "" };

  function ensureDirs() {
    fs.mkdirSync(downloadsDir, { recursive: true });
  }

  function readManifest() {
    try {
      const raw = fs.readFileSync(manifestPath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return emptyManifest();
      if (!parsed.collections || typeof parsed.collections !== "object") {
        parsed.collections = {};
      }
      return parsed;
    } catch (_) {
      return emptyManifest();
    }
  }

  function emptyManifest() {
    return { ready: false, collections: {}, rowCount: 0 };
  }

  function writeManifest(next) {
    ensureDirs();
    const tmp = manifestPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, manifestPath);
  }

  function closeSearchDb() {
    if (!searchDb) return;
    try {
      searchDb.close();
    } catch (_) {
      /* ignore */
    }
    searchDb = null;
  }

  function openSearchDb() {
    closeSearchDb();
    if (!fs.existsSync(dbLivePath)) return null;
    const { DatabaseSync } = loadSqlite();
    try {
      searchDb = new DatabaseSync(dbLivePath, { readOnly: true });
    } catch (_) {
      searchDb = new DatabaseSync(dbLivePath);
    }
    return searchDb;
  }

  function isIndexReady() {
    const manifest = readManifest();
    if (!manifest.ready) return false;
    if (!fs.existsSync(dbLivePath)) return false;
    return Object.keys(manifest.collections || {}).length > 0;
  }

  function createBuildDb(filePath) {
    try {
      fs.unlinkSync(filePath);
    } catch (_) {
      /* ignore */
    }
    const { DatabaseSync } = loadSqlite();
    const db = new DatabaseSync(filePath);
    db.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      PRAGMA temp_store = MEMORY;
      CREATE VIRTUAL TABLE addresses USING fts5(
        label,
        lat UNINDEXED,
        lon UNINDEXED,
        collection_id UNINDEXED,
        tokenize='unicode61'
      );
    `);
    return db;
  }

  function copyAddressesExcept(fromPath, toDb, exceptId) {
    if (!fromPath || !fs.existsSync(fromPath)) return 0;
    const { DatabaseSync } = loadSqlite();
    const from = new DatabaseSync(fromPath);
    let copied = 0;
    try {
      const sql =
        exceptId == null
          ? "SELECT collection_id, lat, lon, label FROM addresses"
          : "SELECT collection_id, lat, lon, label FROM addresses WHERE collection_id != ?";
      const stmt = from.prepare(sql);
      const insert = toDb.prepare(
        "INSERT INTO addresses (label, lat, lon, collection_id) VALUES (?, ?, ?, ?)"
      );
      const iter =
        exceptId == null ? iterateStatement(stmt) : iterateStatement(stmt, String(exceptId));
      toDb.exec("BEGIN");
      for (const row of iter) {
        insert.run(row.label, row.lat, row.lon, row.collection_id);
        copied++;
        if (copied % 8000 === 0) {
          toDb.exec("COMMIT");
          toDb.exec("BEGIN");
        }
      }
      toDb.exec("COMMIT");
    } catch (err) {
      try {
        toDb.exec("ROLLBACK");
      } catch (_) {
        /* ignore */
      }
      from.close();
      throw err;
    }
    from.close();
    return copied;
  }

  async function importAddressStream(db, stream, collectionId) {
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });
    let mode = null;
    let map = null;
    let count = 0;
    const insert = db.prepare(
      "INSERT INTO addresses (label, lat, lon, collection_id) VALUES (?, ?, ?, ?)"
    );
    const cid = String(collectionId);

    function bumpProgress() {
      if (count % 8000 !== 0) return;
      db.exec("COMMIT");
      db.exec("BEGIN");
      if (job && job.running) {
        job.importedRows = (Number(job.importedRows) || 0) + 8000;
        job.message =
          "Indexing addresses… " + Number(job.importedRows).toLocaleString() + " rows";
      }
    }

    db.exec("BEGIN");
    try {
      for await (const rawLine of rl) {
        const line = String(rawLine || "").replace(/^\uFEFF/, "").trim();
        if (!line) continue;
        if (!mode) {
          if (line.charAt(0) === "{") {
            mode = "geojson";
            const rec = featureToRecord(parseJsonLine(line));
            if (rec) {
              insert.run(rec.label, rec.lat, rec.lon, cid);
              count++;
              bumpProgress();
            }
            continue;
          }
          map = headerIndexMap(parseCsvLine(line));
          if (!isAddressHeader(map)) {
            if (typeof stream.destroy === "function") {
              try {
                stream.destroy();
              } catch (_) {
                /* ignore */
              }
            }
            break;
          }
          mode = "csv";
          continue;
        }
        const rec =
          mode === "geojson"
            ? featureToRecord(parseJsonLine(line))
            : rowToRecord(parseCsvLine(line), map);
        if (!rec) continue;
        insert.run(rec.label, rec.lat, rec.lon, cid);
        count++;
        bumpProgress();
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch (_) {
        /* ignore */
      }
      throw err;
    } finally {
      rl.close();
    }

    return count;
  }

  function swapLiveDb(buildPath) {
    closeSearchDb();
    const bak = dbLivePath + ".old";
    try {
      fs.unlinkSync(bak);
    } catch (_) {
      /* ignore */
    }
    if (fs.existsSync(dbLivePath)) {
      fs.renameSync(dbLivePath, bak);
    }
    try {
      fs.renameSync(buildPath, dbLivePath);
    } catch (err) {
      if (fs.existsSync(bak)) {
        try {
          fs.renameSync(bak, dbLivePath);
        } catch (_) {
          /* ignore */
        }
      }
      throw err;
    }
    try {
      fs.unlinkSync(bak);
    } catch (_) {
      /* ignore */
    }
    try {
      fs.unlinkSync(dbLivePath + "-wal");
    } catch (_) {
      /* ignore */
    }
    try {
      fs.unlinkSync(dbLivePath + "-shm");
    } catch (_) {
      /* ignore */
    }
    openSearchDb();
  }

  function removeLiveIndex() {
    closeSearchDb();
    for (const p of [dbLivePath, dbLivePath + "-wal", dbLivePath + "-shm", dbBuildPath]) {
      try {
        fs.unlinkSync(p);
      } catch (_) {
        /* ignore */
      }
    }
  }

  function zipPathFor(name, id) {
    return path.join(downloadsDir, safeCollectionName(name, id) + ".zip");
  }

  function unlinkQuiet(filePath) {
    try {
      fs.unlinkSync(filePath);
    } catch (_) {
      /* ignore */
    }
  }

  function deleteDownloadArtifacts(name, id) {
    const paths = downloadArtifactPaths(name, id);
    for (const p of paths) unlinkQuiet(p);
  }

  function downloadArtifactPaths(name, id) {
    const zip = zipPathFor(name, id);
    const out = [
      zip,
      zip + ".part",
      path.join(downloadsDir, "collection-" + String(id) + ".zip"),
      path.join(downloadsDir, "collection-" + String(id) + ".zip.part"),
      path.join(downloadsDir, safeCollectionName(name, id) + ".zip.part"),
    ];
    try {
      const needle = safeCollectionName(name, id).toLowerCase();
      const files = fs.readdirSync(downloadsDir);
      for (const file of files) {
        const lower = String(file).toLowerCase();
        if (
          (needle && lower.indexOf(needle) !== -1) ||
          lower === "collection-" + String(id) + ".zip" ||
          lower.indexOf("collection-" + String(id) + ".") === 0
        ) {
          out.push(path.join(downloadsDir, file));
        }
      }
    } catch (_) {
      /* ignore */
    }
    return out;
  }

  function hasDownloadArtifacts(name, id) {
    return downloadArtifactPaths(name, id).some(function (p) {
      try {
        return fs.existsSync(p);
      } catch (_) {
        return false;
      }
    });
  }

  function setJob(patch) {
    if (!job) job = {};
    Object.assign(job, patch);
    return job;
  }

  function publicJob() {
    if (!job) return null;
    return {
      running: !!job.running,
      action: job.action || "",
      collectionId: job.collectionId != null ? String(job.collectionId) : "",
      collectionName: job.collectionName || "",
      status: job.status || "",
      message: job.message || "",
      error: job.error || "",
      bytesReceived: Number(job.bytesReceived) || 0,
      bytesTotal: Number(job.bytesTotal) || 0,
      importedRows: Number(job.importedRows) || 0,
    };
  }

  function assertNoJob() {
    if (job && job.running) {
      throw httpError(409, "A collection job is already running.");
    }
  }

  async function fetchCatalogRows(force) {
    const now = Date.now();
    if (!force && catalogCache.rows && now - catalogCache.at < CATALOG_TTL_MS) {
      return catalogCache.rows;
    }
    const res = await fetchImpl(OA_API + "/collections", {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      signal:
        typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(20000)
          : undefined,
    });
    if (!res.ok) {
      throw new Error("OpenAddresses catalog HTTP " + res.status);
    }
    const data = await res.json();
    const rows = Array.isArray(data) ? data : [];
    catalogCache = { at: Date.now(), rows, error: "" };
    return rows;
  }

  async function downloadUrlToFile(url, token, destPath) {
    const tmp = destPath + ".part";
    unlinkQuiet(tmp);
    try {
      const res = await fetchImpl(url, {
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/zip, application/octet-stream, application/json, */*",
          "User-Agent": USER_AGENT,
        },
        redirect: "follow",
      });
      if (!res.ok) {
        let detail = "";
        try {
          detail = (await res.text()).slice(0, 180);
        } catch (_) {
          detail = "";
        }
        if (res.status === 401 || res.status === 403) {
          throw httpError(
            403,
            "OpenAddresses rejected the download (HTTP " +
              res.status +
              "). Check the API token from batch.openaddresses.io/login."
          );
        }
        throw httpError(
          res.status,
          "OpenAddresses download failed (HTTP " +
            res.status +
            (detail ? ": " + detail : "") +
            ")."
        );
      }

      const ctype = String(res.headers.get("content-type") || "").toLowerCase();
      if (ctype.includes("json") && !ctype.includes("zip")) {
        const payload = await res.json();
        const next = extractDownloadUrl(payload);
        if (!next) {
          throw new Error(
            "OpenAddresses did not return a downloadable file. Confirm the token can access collection downloads."
          );
        }
        return downloadUrlToFile(next, token, destPath);
      }

      const total = Number(res.headers.get("content-length")) || 0;
      if (job) {
        job.bytesTotal = total;
        job.bytesReceived = 0;
        job.status = "downloading";
        job.message = total
          ? "Downloading… 0 B / " + formatBytes(total)
          : "Downloading…";
      }

      if (!res.body) {
        throw new Error("OpenAddresses download returned an empty body.");
      }

      const input = Readable.fromWeb(res.body);
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          if (job) {
            job.bytesReceived = (job.bytesReceived || 0) + chunk.length;
            const rec = formatBytes(job.bytesReceived);
            job.message = job.bytesTotal
              ? "Downloading… " + rec + " / " + formatBytes(job.bytesTotal)
              : "Downloading… " + rec;
          }
          cb(null, chunk);
        },
      });
      await pipeline(input, counter, fs.createWriteStream(tmp));
      fs.renameSync(tmp, destPath);
      return destPath;
    } catch (err) {
      unlinkQuiet(tmp);
      throw err;
    }
  }

  async function downloadCollectionZip(id, token, destPath) {
    const url = OA_API + "/collections/" + encodeURIComponent(id) + "/data";
    return downloadUrlToFile(url, token, destPath);
  }

  async function importZipIntoDb(zipPath, db, collectionId) {
    const unzipper = require("unzipper");
    if (job) {
      job.status = "importing";
      job.message = "Reading zip…";
    }
    const directory = await unzipper.Open.file(zipPath);
    let imported = 0;
    let files = 0;
    for (const entry of directory.files) {
      if (!isAddressDataPath(entry.path)) continue;
      files++;
      if (job) {
        job.message = "Indexing " + path.basename(entry.path) + "…";
      }
      let stream = entry.stream();
      if (/\.gz$/i.test(entry.path)) {
        stream = stream.pipe(zlib.createGunzip());
      }
      imported += await importAddressStream(db, stream, collectionId);
    }
    return { imported, files };
  }

  function countLiveRows() {
    if (!searchDb && fs.existsSync(dbLivePath)) openSearchDb();
    if (!searchDb) return 0;
    try {
      const row = searchDb.prepare("SELECT COUNT(*) AS n FROM addresses").get();
      return Number(row?.n) || 0;
    } catch (_) {
      return 0;
    }
  }

  async function runInstall(collection, { replace, token }) {
    const id = String(collection.id);
    ensureDirs();
    const destZip = zipPathFor(collection.name, id);
    setJob({
      running: true,
      action: replace ? "update" : "download",
      collectionId: id,
      collectionName: collection.human || collection.name || id,
      status: "downloading",
      message: "Starting download…",
      error: "",
      bytesReceived: 0,
      bytesTotal: Number(collection.size) || 0,
      importedRows: 0,
    });

    await downloadCollectionZip(id, token, destZip);

    try {
    setJob({ status: "importing", message: "Building search index…" });
    try {
      fs.unlinkSync(dbBuildPath);
    } catch (_) {
      /* ignore */
    }
    const db = createBuildDb(dbBuildPath);
    let imported = 0;
    try {
      if (fs.existsSync(dbLivePath)) {
        if (job) job.message = "Copying existing addresses…";
        copyAddressesExcept(dbLivePath, db, replace ? id : null);
      }
      const result = await importZipIntoDb(destZip, db, id);
      imported = result.imported;
      if (imported <= 0) {
        throw new Error(
          "No address rows found in this collection (parcels, buildings, and rows without a street or coordinates are skipped)."
        );
      }
      db.close();
      if (job) {
        job.status = "importing";
        job.message = "Finalizing index…";
      }
      swapLiveDb(dbBuildPath);
    } catch (err) {
      try {
        db.close();
      } catch (_) {
        /* ignore */
      }
      try {
        fs.unlinkSync(dbBuildPath);
      } catch (_) {
        /* ignore */
      }
      throw err;
    }

    const manifest = readManifest();
    manifest.collections[id] = {
      id,
      name: collection.name || "",
      human: collection.human || collection.name || "",
      created: Number(collection.created) || 0,
      size: Number(collection.size) || 0,
      zipName: "",
      installedAt: new Date().toISOString(),
      rowCount: imported,
    };
    manifest.ready = true;
    manifest.rowCount = countLiveRows();
    writeManifest(manifest);
    setJob({
      running: false,
      status: "ready",
      message: "Ready — " + imported.toLocaleString() + " addresses imported.",
      importedRows: imported,
      error: "",
    });
    } finally {
      deleteDownloadArtifacts(collection.name, id);
    }
  }

  async function runRemove(collectionId) {
    const id = String(collectionId);
    const manifest = readManifest();
    const installed = manifest.collections[id];
    if (!installed) {
      throw httpError(404, "That collection is not installed.");
    }
    setJob({
      running: true,
      action: "remove",
      collectionId: id,
      collectionName: installed.human || installed.name || id,
      status: "importing",
      message: "Removing collection…",
      error: "",
      bytesReceived: 0,
      bytesTotal: 0,
      importedRows: 0,
    });

    const remaining = Object.keys(manifest.collections).filter(function (key) {
      return key !== id;
    });

    if (!remaining.length) {
      removeLiveIndex();
      deleteDownloadArtifacts(installed.name, id);
      writeManifest(emptyManifest());
      setJob({
        running: false,
        status: "not_installed",
        message: "Collection deleted.",
        error: "",
      });
      return;
    }

    try {
      fs.unlinkSync(dbBuildPath);
    } catch (_) {
      /* ignore */
    }
    const db = createBuildDb(dbBuildPath);
    try {
      copyAddressesExcept(dbLivePath, db, id);
      db.close();
      swapLiveDb(dbBuildPath);
    } catch (err) {
      try {
        db.close();
      } catch (_) {
        /* ignore */
      }
      try {
        fs.unlinkSync(dbBuildPath);
      } catch (_) {
        /* ignore */
      }
      throw err;
    }

    deleteDownloadArtifacts(installed.name, id);
    delete manifest.collections[id];
    manifest.ready = Object.keys(manifest.collections).length > 0;
    manifest.rowCount = countLiveRows();
    writeManifest(manifest);
    setJob({
      running: false,
      status: "ready",
      message: "Collection deleted.",
      error: "",
    });
  }

  function failJob(err) {
    const message = err && err.message ? err.message : String(err || "Collection job failed.");
    console.warn("[openaddresses]", message);
    setJob({
      running: false,
      status: "error",
      error: message,
      message,
    });
  }

  function startBackground(fn) {
    Promise.resolve()
      .then(fn)
      .catch(failJob);
  }

  async function findCatalogRow(id, force) {
    const rows = await fetchCatalogRows(!!force);
    const match = rows.find(function (row) {
      return String(row.id) === String(id);
    });
    if (!match) throw httpError(404, "Unknown OpenAddresses collection.");
    return match;
  }

  function startDownload(collectionId) {
    assertNoJob();
    const token = getTokenFn();
    if (!token) {
      throw httpError(
        400,
        "Add an OpenAddresses API token first (free account at batch.openaddresses.io/login)."
      );
    }
    const id = String(collectionId || "").trim();
    if (!id) throw httpError(400, "Missing collection id.");
    const manifest = readManifest();
    if (manifest.collections[id]) {
      throw httpError(409, "That collection is already installed. Use Update to refresh it.");
    }
    setJob({
      running: true,
      action: "download",
      collectionId: id,
      collectionName: id,
      status: "downloading",
      message: "Looking up collection…",
      error: "",
      bytesReceived: 0,
      bytesTotal: 0,
      importedRows: 0,
    });
    startBackground(async function () {
      const row = await findCatalogRow(id, true);
      job.collectionName = row.human || row.name || id;
      job.bytesTotal = Number(row.size) || 0;
      await runInstall(row, { replace: false, token });
    });
    return publicJob();
  }

  function startUpdate(collectionId) {
    assertNoJob();
    const token = getTokenFn();
    if (!token) {
      throw httpError(
        400,
        "Add an OpenAddresses API token first (free account at batch.openaddresses.io/login)."
      );
    }
    const id = String(collectionId || "").trim();
    if (!id) throw httpError(400, "Missing collection id.");
    const manifest = readManifest();
    if (!manifest.collections[id]) {
      throw httpError(404, "That collection is not installed.");
    }
    setJob({
      running: true,
      action: "update",
      collectionId: id,
      collectionName: manifest.collections[id].human || id,
      status: "downloading",
      message: "Looking up collection…",
      error: "",
      bytesReceived: 0,
      bytesTotal: 0,
      importedRows: 0,
    });
    startBackground(async function () {
      const row = await findCatalogRow(id, true);
      job.collectionName = row.human || row.name || id;
      await runInstall(row, { replace: true, token });
    });
    return publicJob();
  }

  function startRemove(collectionId) {
    assertNoJob();
    const id = String(collectionId || "").trim();
    if (!id) throw httpError(400, "Missing collection id.");
    const manifest = readManifest();
    const installed = manifest.collections[id];
    const catalogRow = (catalogCache.rows || []).find(function (row) {
      return String(row.id) === id;
    });
    const name = (installed && installed.name) || (catalogRow && catalogRow.name) || "";
    if (!installed) {
      if (!hasDownloadArtifacts(name, id)) {
        throw httpError(404, "That collection is not installed.");
      }
      deleteDownloadArtifacts(name, id);
      if (job && String(job.collectionId) === id) {
        setJob({
          running: false,
          action: "remove",
          collectionId: id,
          status: "not_installed",
          message: "Leftover download deleted.",
          error: "",
        });
      }
      return {
        running: false,
        action: "remove",
        collectionId: id,
        collectionName: (catalogRow && (catalogRow.human || catalogRow.name)) || name || id,
        status: "not_installed",
        message: "Leftover download deleted.",
        error: "",
        bytesReceived: 0,
        bytesTotal: 0,
        importedRows: 0,
      };
    }
    setJob({
      running: true,
      action: "remove",
      collectionId: id,
      collectionName: installed.human || installed.name || id,
      status: "importing",
      message: "Removing collection…",
      error: "",
      bytesReceived: 0,
      bytesTotal: 0,
      importedRows: 0,
    });
    startBackground(function () {
      return runRemove(id);
    });
    return publicJob();
  }

  function mergeCollectionRow(remote, manifest) {
    const id = String(remote.id);
    const installed = manifest.collections[id] || null;
    const size = Number(remote.size) || 0;
    const created = Number(remote.created) || 0;
    const global = isGlobalCollection(remote);
    const active = job && job.running && String(job.collectionId) === id;
    let status = "not_installed";
    let statusLabel = "Not installed";
    const leftover = hasDownloadArtifacts(remote.name, id);
    if (active) {
      status = job.status === "downloading" ? "downloading" : "importing";
      statusLabel = job.message || (status === "downloading" ? "Downloading…" : "Importing…");
    } else if (job && !job.running && job.status === "error" && String(job.collectionId) === id) {
      status = "error";
      statusLabel = leftover ? "Failed — zip still on disk" : job.error || "Error";
    } else if (installed) {
      const newer =
        (created && created > Number(installed.created || 0)) ||
        (size && Number(installed.size || 0) > 0 && size !== Number(installed.size || 0));
      if (newer) {
        status = "update_available";
        statusLabel = "Update available";
      } else {
        status = "ready";
        statusLabel = "Ready";
      }
    }
    return {
      id,
      name: remote.name || "",
      human: remote.human || remote.name || id,
      created,
      updatedLabel: formatDateMs(created),
      size,
      sizeLabel: formatBytes(size),
      isGlobal: global,
      estimatedDiskBytes: size * 2,
      estimatedDiskLabel: formatBytes(size * 2),
      installed: !!installed,
      installedCreated: installed ? Number(installed.created) || 0 : 0,
      installedSize: installed ? Number(installed.size) || 0 : 0,
      rowCount: installed ? Number(installed.rowCount) || 0 : 0,
      status,
      statusLabel,
      canDownload: !installed && !active,
      canUpdate: !!installed && !active,
      canRemove: !active && (!!installed || leftover),
    };
  }

  async function getStatus(opts = {}) {
    const manifest = readManifest();
    let catalog = [];
    let catalogError = "";
    try {
      catalog = await fetchCatalogRows(!!opts.forceCatalog);
    } catch (err) {
      catalogError = err && err.message ? err.message : "Could not load OpenAddresses catalog.";
      catalog = catalogCache.rows || [];
      if (!catalogCache.error) catalogCache.error = catalogError;
    }

    const collections = catalog.map(function (row) {
      return mergeCollectionRow(row, manifest);
    });

    const installedMissing = Object.keys(manifest.collections).filter(function (id) {
      return !collections.some(function (c) {
        return c.id === id;
      });
    });
    for (const id of installedMissing) {
      const local = manifest.collections[id];
      collections.push(
        mergeCollectionRow(
          {
            id,
            name: local.name,
            human: local.human,
            created: local.created,
            size: local.size,
          },
          manifest
        )
      );
    }

    return {
      hasToken: !!getTokenFn(),
      indexReady: isIndexReady(),
      catalogError,
      job: publicJob(),
      collections,
      rowCount: Number(manifest.rowCount) || 0,
      installedCount: Object.keys(manifest.collections).length,
    };
  }

  function search(query, options = {}) {
    if (!isIndexReady()) return [];
    const q = String(query || "").trim();
    if (!q) return [];
    const fts = toFtsQuery(q);
    if (!fts) return [];
    if (!searchDb) openSearchDb();
    if (!searchDb) return [];

    const limit = Math.min(20, Math.max(1, Number(options.limit) || 5));
    const tokens = tokenizeQuery(q);
    let rows = [];
    try {
      const stmt = searchDb.prepare(`
        SELECT lat, lon, label
        FROM addresses
        WHERE addresses MATCH ?
        LIMIT ${SEARCH_CANDIDATES}
      `);
      rows = stmt.all(fts);
    } catch (_) {
      return [];
    }
    if (!Array.isArray(rows) || !rows.length) return [];

    const nearLat = Number(options.nearLat);
    const nearLon = Number(options.nearLon);
    const hasNear = Number.isFinite(nearLat) && Number.isFinite(nearLon);

    const hits = rows
      .map(function (row) {
        const lat = Number(row.lat);
        const lon = Number(row.lon);
        const label = String(row.label || "").trim();
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || !label) return null;
        return {
          lat,
          lon,
          label,
          source: "openaddresses",
          score: scoreLabel(label, tokens),
        };
      })
      .filter(Boolean);

    hits.sort(function (a, b) {
      if (hasNear) {
        const da = haversineKm(nearLat, nearLon, a.lat, a.lon);
        const db = haversineKm(nearLat, nearLon, b.lat, b.lon);
        if (da !== db) return da - db;
      }
      return b.score - a.score || a.label.localeCompare(b.label);
    });

    return hits.slice(0, limit).map(function (hit) {
      return { lat: hit.lat, lon: hit.lon, label: hit.label, source: hit.source };
    });
  }

  async function importCsvText(collectionId, csvText, meta = {}) {
    const id = String(collectionId || "test").trim() || "test";
    ensureDirs();
    try {
      fs.unlinkSync(dbBuildPath);
    } catch (_) {
      /* ignore */
    }
    const db = createBuildDb(dbBuildPath);
    let imported = 0;
    try {
      if (fs.existsSync(dbLivePath) && meta.replace) {
        copyAddressesExcept(dbLivePath, db, id);
      } else if (fs.existsSync(dbLivePath) && !meta.replace) {
        copyAddressesExcept(dbLivePath, db, null);
      }
      imported = await importAddressStream(db, Readable.from(String(csvText || "")), id);
      db.close();
      if (imported <= 0) throw new Error("No address rows imported.");
      swapLiveDb(dbBuildPath);
    } catch (err) {
      try {
        db.close();
      } catch (_) {
        /* ignore */
      }
      try {
        fs.unlinkSync(dbBuildPath);
      } catch (_) {
        /* ignore */
      }
      throw err;
    }
    const manifest = readManifest();
    manifest.collections[id] = {
      id,
      name: meta.name || id,
      human: meta.human || meta.name || id,
      created: Number(meta.created) || Date.now(),
      size: Number(meta.size) || String(csvText || "").length,
      zipName: "",
      installedAt: new Date().toISOString(),
      rowCount: imported,
    };
    manifest.ready = true;
    manifest.rowCount = countLiveRows();
    writeManifest(manifest);
    return { imported };
  }

  function close() {
    closeSearchDb();
  }

  return {
    getStatus,
    startDownload,
    startUpdate,
    startRemove,
    isIndexReady,
    search,
    importCsvText,
    close,
    _paths: { rootDir, dbLivePath, manifestPath, downloadsDir },
  };
}

const singleton = createOpenAddressesService();

module.exports = Object.assign(singleton, {
  createOpenAddressesService,
  buildAddressLabel,
  parseCsvLine,
  isAddressCsvPath,
  isAddressDataPath,
  featureToRecord,
  toFtsQuery,
  formatBytes,
  rowToRecord,
  headerIndexMap,
  isAddressHeader,
  isGlobalCollection,
  OA_API,
});
