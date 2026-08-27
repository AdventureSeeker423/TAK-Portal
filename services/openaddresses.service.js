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
  return cleanAddressField(v);
}

const STREET_TYPES = {
  alley: "Aly",
  aly: "Aly",
  annex: "Anx",
  anx: "Anx",
  arcade: "Arc",
  avenue: "Ave",
  ave: "Ave",
  boulevard: "Blvd",
  blvd: "Blvd",
  branch: "Br",
  bridge: "Brg",
  brook: "Brk",
  bypass: "Byp",
  byp: "Byp",
  causeway: "Cswy",
  center: "Ctr",
  centre: "Ctr",
  cir: "Cir",
  circle: "Cir",
  cliff: "Clf",
  close: "Cl",
  common: "Cmn",
  corner: "Cor",
  court: "Ct",
  ct: "Ct",
  cove: "Cv",
  cv: "Cv",
  creek: "Crk",
  crescent: "Cres",
  cres: "Cres",
  crossing: "Xing",
  xing: "Xing",
  drive: "Dr",
  dr: "Dr",
  estate: "Est",
  expressway: "Expy",
  expy: "Expy",
  extension: "Ext",
  freeway: "Fwy",
  fwy: "Fwy",
  garden: "Gdn",
  gardens: "Gdns",
  gateway: "Gtwy",
  glen: "Gln",
  green: "Grn",
  grove: "Grv",
  harbor: "Hbr",
  heights: "Hts",
  highway: "Hwy",
  hwy: "Hwy",
  hill: "Hl",
  hills: "Hls",
  junction: "Jct",
  jct: "Jct",
  knoll: "Knl",
  lake: "Lk",
  landing: "Lndg",
  lane: "Ln",
  ln: "Ln",
  loop: "Loop",
  manor: "Mnr",
  meadow: "Mdw",
  mews: "Mews",
  mill: "Ml",
  mission: "Msn",
  motorway: "Mtwy",
  mount: "Mt",
  mountain: "Mtn",
  orchard: "Orch",
  oval: "Oval",
  overpass: "Opas",
  park: "Park",
  parkway: "Pkwy",
  pkwy: "Pkwy",
  pass: "Pass",
  path: "Path",
  pike: "Pike",
  pine: "Pne",
  place: "Pl",
  pl: "Pl",
  plain: "Pln",
  plaza: "Plz",
  plz: "Plz",
  point: "Pt",
  pt: "Pt",
  port: "Prt",
  prairie: "Pr",
  radial: "Radl",
  ranch: "Rnch",
  rapid: "Rpd",
  rest: "Rst",
  ridge: "Rdg",
  rdg: "Rdg",
  river: "Riv",
  road: "Rd",
  rd: "Rd",
  route: "Rte",
  rte: "Rte",
  row: "Row",
  rue: "Rue",
  run: "Run",
  shoal: "Shl",
  shore: "Shr",
  skyway: "Skwy",
  spring: "Spg",
  springs: "Spgs",
  spur: "Spur",
  square: "Sq",
  sq: "Sq",
  station: "Sta",
  stravenue: "Stra",
  stream: "Strm",
  street: "St",
  st: "St",
  str: "St",
  summit: "Smt",
  terrace: "Ter",
  ter: "Ter",
  throughway: "Trwy",
  trace: "Trce",
  track: "Trak",
  trafficway: "Trfy",
  trail: "Trl",
  trl: "Trl",
  trailer: "Trlr",
  tunnel: "Tunl",
  turnpike: "Tpke",
  tpke: "Tpke",
  underpass: "Upas",
  union: "Un",
  valley: "Vly",
  viaduct: "Via",
  view: "Vw",
  village: "Vlg",
  ville: "Vl",
  vista: "Vis",
  walk: "Walk",
  wall: "Wall",
  way: "Way",
  well: "Wl",
};

const DIRECTIONALS = {
  north: "N",
  n: "N",
  south: "S",
  s: "S",
  east: "E",
  e: "E",
  west: "W",
  w: "W",
  northeast: "NE",
  ne: "NE",
  northwest: "NW",
  nw: "NW",
  southeast: "SE",
  se: "SE",
  southwest: "SW",
  sw: "SW",
};

const REGION_ABBR = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC",
  alberta: "AB",
  "british columbia": "BC",
  manitoba: "MB",
  "new brunswick": "NB",
  newfoundland: "NL",
  "newfoundland and labrador": "NL",
  "northwest territories": "NT",
  "nova scotia": "NS",
  nunavut: "NU",
  ontario: "ON",
  "prince edward island": "PE",
  quebec: "QC",
  québec: "QC",
  saskatchewan: "SK",
  yukon: "YT",
};

const US_ZIP_RE = /^\d{5}(?:-?\d{4})?$/;
const CA_POST_RE = /^[abceghj-nprstvxy]\d[abceghj-nprstv-z]\s?\d[abceghj-nprstv-z]\d$/i;
const REGION_RE = /^[a-z]{2}$/i;
const UNIT_RE = /^(#|apt|apartment|suite|ste|unit|fl|floor|bldg|building|rm|room|dept|department)\b/i;

function cleanAddressField(value) {
  const s = String(value == null ? "" : value).trim();
  if (!s) return "";
  if (/^(n\/a|na|null|undefined|none|unknown|-)$/i.test(s)) return "";
  return s;
}

function titleCaseName(value) {
  return cleanAddressField(value)
    .split(/\s+/)
    .map(function (word) {
      const bare = word.replace(/\./g, "");
      if (!bare) return "";
      if (/^(po)$/i.test(bare)) return "PO";
      if (/^(ne|nw|se|sw)$/i.test(bare)) return bare.toUpperCase();
      return bare.charAt(0).toUpperCase() + bare.slice(1).toLowerCase();
    })
    .filter(Boolean)
    .join(" ");
}

function formatRegion(value) {
  const raw = cleanAddressField(value);
  if (!raw) return "";
  if (REGION_RE.test(raw)) return raw.toUpperCase();
  const mapped = REGION_ABBR[raw.toLowerCase()];
  if (mapped) return mapped;
  return titleCaseName(raw);
}

function formatPostcode(value) {
  const raw = cleanAddressField(value).toUpperCase().replace(/[\s-]/g, "");
  if (!raw) return "";
  if (/^\d{9}$/.test(raw)) return raw.slice(0, 5) + "-" + raw.slice(5);
  if (/^\d{5}$/.test(raw)) return raw;
  if (/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(raw)) return raw.slice(0, 3) + " " + raw.slice(3);
  return cleanAddressField(value);
}

function isPostcodeToken(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  return US_ZIP_RE.test(raw) || CA_POST_RE.test(raw.replace(/\s/g, ""));
}

function isUnitToken(value) {
  const raw = String(value || "").trim();
  return !!raw && UNIT_RE.test(raw);
}

function formatUnit(value) {
  const raw = cleanAddressField(value);
  if (!raw) return "";
  if (UNIT_RE.test(raw)) return titleCaseName(raw.replace(/^#\s*/, "#"));
  return "#" + raw;
}

function formatStreetName(value) {
  const raw = cleanAddressField(value);
  if (!raw) return "";
  const tokens = raw.split(/\s+/).filter(Boolean);
  const lastIdx = tokens.length - 1;
  return tokens
    .map(function (token, index) {
      const bare = token.replace(/\./g, "");
      if (!bare) return "";
      const lower = bare.toLowerCase();
      const lastIsDir = lastIdx > 0 && DIRECTIONALS[String(tokens[lastIdx] || "").replace(/\./g, "").toLowerCase()];
      const typeIdx = lastIsDir ? lastIdx - 1 : lastIdx;
      if (index === typeIdx && STREET_TYPES[lower]) return STREET_TYPES[lower];
      if ((index === 0 || index === lastIdx) && DIRECTIONALS[lower]) return DIRECTIONALS[lower];
      if (/^\d+[a-z]{0,3}$/i.test(bare)) return bare.toUpperCase();
      if (/^(us|sr|rt|hwy|cr|fm|ih|rr)$/i.test(lower)) return bare.toUpperCase();
      return bare.charAt(0).toUpperCase() + bare.slice(1).toLowerCase();
    })
    .filter(Boolean)
    .join(" ");
}

function parseRegionZipPart(part) {
  const raw = String(part || "").trim();
  const two = raw.match(/^([A-Za-z]{2})\s+(.+)$/);
  if (two && isPostcodeToken(two[2])) {
    return { region: formatRegion(two[1]), postcode: formatPostcode(two[2]) };
  }
  return null;
}

function parseAddressLabel(label) {
  const parts = String(label || "")
    .split(",")
    .map(function (p) {
      return p.trim();
    })
    .filter(Boolean);
  let postcode = "";
  let region = "";
  const kept = parts.slice();
  for (let i = kept.length - 1; i >= 0; i--) {
    const part = kept[i];
    if (!postcode && isPostcodeToken(part)) {
      postcode = formatPostcode(part);
      kept.splice(i, 1);
      continue;
    }
    const combo = parseRegionZipPart(part);
    if (combo && (!region || !postcode)) {
      if (!region) region = combo.region;
      if (!postcode) postcode = combo.postcode;
      kept.splice(i, 1);
      continue;
    }
    if (!region && (REGION_RE.test(part) || REGION_ABBR[part.toLowerCase()])) {
      region = formatRegion(part);
      kept.splice(i, 1);
    }
  }
  const line1 = kept[0] || "";
  const extras = kept.slice(1);
  const units = [];
  const cities = [];
  for (let i = 0; i < extras.length; i++) {
    if (isUnitToken(extras[i])) units.push(formatUnit(extras[i]));
    else cities.push(titleCaseName(extras[i]));
  }
  const houseMatch = line1.match(/^(\d+[a-z0-9-]*)\s+(.*)$/i);
  return {
    number: houseMatch ? houseMatch[1] : "",
    street: formatStreetName(houseMatch ? houseMatch[2] : line1),
    unit: units.join(" "),
    city: cities.join(" "),
    region,
    postcode,
  };
}

function labelCompleteness(parsed) {
  let n = 0;
  if (parsed.number) n += 2;
  if (parsed.street) n += 2;
  if (parsed.city) n += 4;
  if (parsed.region) n += 3;
  if (parsed.postcode) n += 2;
  if (parsed.unit) n += 1;
  return n;
}

function formatAddressLabel(labelOrFields) {
  if (typeof labelOrFields === "string" && labelOrFields.split(",").length > 6) {
    return labelOrFields.trim();
  }
  const parsed =
    labelOrFields && typeof labelOrFields === "object" && !Array.isArray(labelOrFields)
      ? {
          number: cleanAddressField(labelOrFields.number),
          street: formatStreetName(labelOrFields.street),
          unit: labelOrFields.unit ? formatUnit(labelOrFields.unit) : "",
          city: titleCaseName(labelOrFields.city),
          region: formatRegion(labelOrFields.region),
          postcode: formatPostcode(labelOrFields.postcode),
        }
      : parseAddressLabel(labelOrFields);
  const line1 = [parsed.number, parsed.street, parsed.unit].filter(Boolean).join(" ");
  const regionZip = [parsed.region, parsed.postcode].filter(Boolean).join(" ");
  return [line1, parsed.city, regionZip].filter(Boolean).join(", ");
}

function streetKey(street) {
  return formatStreetName(street)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function dedupeAddressHits(hits) {
  const clusters = [];
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    const parsed = parseAddressLabel(hit.label);
    const house = String(parsed.number || "").toLowerCase();
    const street = streetKey(parsed.street);
    let placed = false;
    for (let c = 0; c < clusters.length; c++) {
      const rep = clusters[c][0];
      const dist = haversineKm(hit.lat, hit.lon, rep.lat, rep.lon);
      if (dist > 0.12) continue;
      const other = parseAddressLabel(rep.label);
      const sameHouse = house && house === String(other.number || "").toLowerCase();
      const sameStreet = street && street === streetKey(other.street);
      if ((sameHouse && sameStreet) || (dist < 0.04 && sameHouse)) {
        clusters[c].push(hit);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([hit]);
  }
  return clusters.map(function (cluster) {
    cluster.sort(function (a, b) {
      const ca = labelCompleteness(parseAddressLabel(a.label));
      const cb = labelCompleteness(parseAddressLabel(b.label));
      if (cb !== ca) return cb - ca;
      return b.score - a.score;
    });
    const best = cluster[0];
    return {
      lat: best.lat,
      lon: best.lon,
      label: formatAddressLabel(best.label),
      source: best.source,
      score: Math.max.apply(
        null,
        cluster.map(function (h) {
          return h.score;
        })
      ),
    };
  });
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
    city: prop(props, "city") || prop(props, "district"),
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
  return cleanAddressField(row[idx]);
}

function buildAddressLabel(fields) {
  return formatAddressLabel(fields || {});
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
    city: cell(row, map, "CITY") || cell(row, map, "DISTRICT"),
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
  const parsed = parseAddressLabel(label);
  const streetLine = [parsed.number, parsed.street].filter(Boolean).join(" ").toLowerCase();
  const city = String(parsed.city || "").toLowerCase();
  const region = String(parsed.region || "").toLowerCase();
  const zip = String(parsed.postcode || "")
    .toLowerCase()
    .replace(/\s/g, "");
  const lower = String(label || "").toLowerCase();
  const house = String(parsed.number || "").toLowerCase();
  const queryNum = tokens.find(function (t) {
    return /^\d/.test(t);
  });

  let score = 40;
  if (queryNum) {
    if (house === queryNum) score += 50;
    else if (house.startsWith(queryNum) && queryNum.length >= 3) score += 12;
    else if (zip === queryNum || zip.startsWith(queryNum)) {
      score += queryNum.length >= 5 ? 20 : -20;
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^\d/.test(t)) continue;
    if (streetLine.includes(t)) score += 10;
    else if (city.includes(t) || region === t) score += 6;
    else if (lower.includes(t)) score += 2;
  }
  if (parsed.city) score += 3;
  if (parsed.region) score += 2;
  if (parsed.postcode) score += 1;
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

function cancelledError() {
  const err = new Error("Download cancelled.");
  err.cancelled = true;
  err.status = 499;
  return err;
}

function isAbortErr(err) {
  if (!err) return false;
  if (err.cancelled) return true;
  const name = String(err.name || "");
  const code = String(err.code || "");
  const msg = String(err.message || "").toLowerCase();
  return name === "AbortError" || code === "ABORT_ERR" || msg.indexOf("aborted") !== -1;
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
        if (job && job.cancelled) {
          if (typeof stream.destroy === "function") {
            try {
              stream.destroy();
            } catch (_) {
              /* ignore */
            }
          }
          throw cancelledError();
        }
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
    const running = !!job.running;
    const action = job.action || "";
    return {
      running,
      action,
      collectionId: job.collectionId != null ? String(job.collectionId) : "",
      collectionName: job.collectionName || "",
      status: job.status || "",
      message: job.message || "",
      error: job.error || "",
      bytesReceived: Number(job.bytesReceived) || 0,
      bytesTotal: Number(job.bytesTotal) || 0,
      importedRows: Number(job.importedRows) || 0,
      canCancel: running && (action === "download" || action === "update"),
    };
  }

  function throwIfCancelled() {
    if (job && job.cancelled) throw cancelledError();
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
    throwIfCancelled();
    try {
      if (!job.abortController && typeof AbortController !== "undefined") {
        job.abortController = new AbortController();
      }
      const res = await fetchImpl(url, {
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/zip, application/octet-stream, application/json, */*",
          "User-Agent": USER_AGENT,
        },
        redirect: "follow",
        signal: job.abortController ? job.abortController.signal : undefined,
      });
      throwIfCancelled();
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
      const out = fs.createWriteStream(tmp);
      job.writeStream = out;
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          if (job && job.cancelled) {
            cb(cancelledError());
            return;
          }
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
      await pipeline(input, counter, out);
      job.writeStream = null;
      throwIfCancelled();
      fs.renameSync(tmp, destPath);
      return destPath;
    } catch (err) {
      job.writeStream = null;
      unlinkQuiet(tmp);
      if (job && job.cancelled) throw cancelledError();
      if (isAbortErr(err)) throw cancelledError();
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
    throwIfCancelled();
    let imported = 0;
    let files = 0;
    for (const entry of directory.files) {
      throwIfCancelled();
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
      collectionKey: collection.name || "",
      collectionName: collection.human || collection.name || id,
      status: "downloading",
      message: "Starting download…",
      error: "",
      bytesReceived: 0,
      bytesTotal: Number(collection.size) || 0,
      importedRows: 0,
    });

    await downloadCollectionZip(id, token, destZip);
    throwIfCancelled();

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
      throwIfCancelled();
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
    if ((job && job.cancelled) || (err && err.cancelled) || isAbortErr(err)) {
      const id = job && job.collectionId;
      const name = (job && job.collectionKey) || "";
      if (id) deleteDownloadArtifacts(name, id);
      unlinkQuiet(dbBuildPath);
      setJob({
        running: false,
        status: "cancelled",
        error: "",
        message: "Download cancelled. Partial files were deleted.",
        writeStream: null,
      });
      return;
    }
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

  function cancelJob() {
    if (!job || !job.running) {
      throw httpError(409, "No download is in progress.");
    }
    if (job.action && job.action !== "download" && job.action !== "update") {
      throw httpError(409, "That job cannot be cancelled.");
    }
    job.cancelled = true;
    job.message = "Cancelling…";
    try {
      if (job.abortController) job.abortController.abort();
    } catch (_) {
      /* ignore */
    }
    try {
      if (job.writeStream) job.writeStream.destroy();
    } catch (_) {
      /* ignore */
    }
    const id = job.collectionId;
    const name = job.collectionKey || "";
    if (id) deleteDownloadArtifacts(name, id);
    unlinkQuiet(dbBuildPath);
    setJob({
      running: false,
      status: "cancelled",
      error: "",
      message: "Download cancelled. Partial files were deleted.",
      writeStream: null,
    });
    return publicJob();
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
      cancelled: false,
      abortController: typeof AbortController !== "undefined" ? new AbortController() : null,
      writeStream: null,
      action: "download",
      collectionId: id,
      collectionKey: "",
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
      throwIfCancelled();
      job.collectionName = row.human || row.name || id;
      job.collectionKey = row.name || job.collectionKey || "";
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
      cancelled: false,
      abortController: typeof AbortController !== "undefined" ? new AbortController() : null,
      writeStream: null,
      action: "update",
      collectionId: id,
      collectionKey: (manifest.collections[id] && manifest.collections[id].name) || "",
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
      throwIfCancelled();
      job.collectionName = row.human || row.name || id;
      job.collectionKey = row.name || job.collectionKey || "";
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
      canCancel: active && (job.action === "download" || job.action === "update"),
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
        let score = scoreLabel(label, tokens);
        if (hasNear) {
          const dist = haversineKm(nearLat, nearLon, lat, lon);
          score += Math.max(0, 12 - Math.min(dist, 12));
        }
        return {
          lat,
          lon,
          label,
          source: "openaddresses",
          score,
        };
      })
      .filter(Boolean);

    hits.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      if (hasNear) {
        const da = haversineKm(nearLat, nearLon, a.lat, a.lon);
        const db = haversineKm(nearLat, nearLon, b.lat, b.lon);
        if (da !== db) return da - db;
      }
      return a.label.localeCompare(b.label);
    });

    return dedupeAddressHits(hits).slice(0, limit).map(function (hit) {
      return {
        lat: hit.lat,
        lon: hit.lon,
        label: hit.label,
        source: hit.source,
        score: hit.score,
      };
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
    cancelJob,
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
  formatAddressLabel,
  parseAddressLabel,
  scoreLabel,
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
