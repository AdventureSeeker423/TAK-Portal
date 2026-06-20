/**
 * US-focused forward geocoding with multi-provider fallback.
 *
 * Optional: set GEOCODIO_API_KEY for best US street/intersection coverage
 * (free tier: 2,500 lookups/day at https://www.geocod.io).
 *
 * Without an API key, requests fan out to Census (US addresses), Photon, and
 * Nominatim (US-biased) and merge/deduplicate results.
 */
const { getString } = require("./env");

const FETCH_TIMEOUT_MS = 9000;
const USER_AGENT = "TAK-Portal/1.0 (live map geocoding)";
const PROVIDER_FETCH_LIMIT = 10;
/** ~120 m — treat as the same rooftop/interpolation point. */
const DEDUPE_RADIUS_KM = 0.12;
/** Drop street-only hits when a numbered address is nearby on the same road. */
const VAGUE_SUPPRESS_RADIUS_KM = 0.35;

/** Rough CONUS bbox bias for OSM providers (Alaska/Hawaii still allowed via country filter). */
const US_PHOTON_BBOX = "-125.0,24.0,-66.0,49.5";

function geocodioApiKey() {
  return getString("GEOCODIO_API_KEY", "").trim();
}

function fetchJson(url, headers = {}) {
  return fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      ...headers,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }).then(function (r) {
    if (!r.ok) {
      const err = new Error("Geocoder HTTP " + r.status);
      err.status = r.status;
      throw err;
    }
    return r.json();
  });
}

function normalizeHit(hit) {
  if (!hit) return null;
  const lat = Number(hit.lat);
  const lon = Number(hit.lon);
  const label = String(hit.label || "").trim();
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !label) return null;
  return {
    lat,
    lon,
    label,
    source: String(hit.source || "unknown"),
    score: Number.isFinite(Number(hit.score)) ? Number(hit.score) : 0,
  };
}

function extractHouseNumber(label) {
  const match = String(label || "").match(/\b(\d+[a-z0-9-]*)\b/i);
  return match ? match[1].toLowerCase() : "";
}

function normalizeStreetKey(label) {
  return String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(
      /\b(street|st|avenue|ave|boulevard|blvd|drive|dr|road|rd|lane|ln|court|ct|place|pl|parkway|pkwy|highway|hwy|way|pike)\b/g,
      " "
    )
    .replace(/\b(united states|usa|tennessee|tn|county|east tennessee|north|south|east|west)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isVagueStreetLabel(label) {
  const text = String(label || "").trim();
  if (!text || extractHouseNumber(text)) return false;
  return /\b(st|street|ave|avenue|blvd|boulevard|dr|drive|rd|road|ln|lane|ct|court|pl|place|pkwy|parkway|hwy|highway|way|pike)\b/i.test(
    text
  );
}

function labelQualityScore(hit) {
  let quality = hit.score;
  if (hit.source === "geocod.io") quality += 6;
  if (hit.source === "census") quality += 5;
  if (extractHouseNumber(hit.label)) quality += 4;
  if (isVagueStreetLabel(hit.label)) quality -= 12;
  if (hit.label.length > 90) quality -= 4;
  if (hit.label.length <= 64) quality += 2;
  return quality;
}

function pickClusterLabel(cluster) {
  const ordered = cluster.slice().sort(function (a, b) {
    const qa = labelQualityScore(a);
    const qb = labelQualityScore(b);
    if (qa !== qb) return qb - qa;
    return a.label.length - b.label.length;
  });
  const census = ordered.find(function (hit) {
    return hit.source === "census";
  });
  if (census) return census.label;
  const geocodio = ordered.find(function (hit) {
    return hit.source === "geocod.io";
  });
  if (geocodio) return geocodio.label;
  return ordered[0].label;
}

function shouldSuppressVagueHit(hit, allHits) {
  if (!isVagueStreetLabel(hit.label)) return false;
  const vagueStreet = normalizeStreetKey(hit.label);
  for (const other of allHits) {
    if (other === hit) continue;
    const house = extractHouseNumber(other.label);
    if (!house) continue;
    if (haversineKm(hit.lat, hit.lon, other.lat, other.lon) > VAGUE_SUPPRESS_RADIUS_KM) {
      continue;
    }
    const otherStreet = normalizeStreetKey(other.label);
    if (!otherStreet || !vagueStreet) continue;
    if (
      otherStreet.includes(vagueStreet) ||
      vagueStreet.includes(otherStreet)
    ) {
      return true;
    }
  }
  return false;
}

function clusterHits(hits) {
  const clusters = [];
  for (const hit of hits) {
    let placed = false;
    for (const cluster of clusters) {
      const rep = cluster[0];
      if (haversineKm(hit.lat, hit.lon, rep.lat, rep.lon) <= DEDUPE_RADIUS_KM) {
        cluster.push(hit);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([hit]);
  }

  const representatives = [];
  for (const cluster of clusters) {
    const best = cluster.slice().sort(function (a, b) {
      return labelQualityScore(b) - labelQualityScore(a);
    })[0];
    representatives.push({
      lat: best.lat,
      lon: best.lon,
      label: pickClusterLabel(cluster),
      source: best.source,
      score: Math.max.apply(
        null,
        cluster.map(function (h) {
          return labelQualityScore(h);
        })
      ),
    });
  }
  return representatives;
}

function dedupeKey(hit) {
  return (
    extractHouseNumber(hit.label) +
    "|" +
    normalizeStreetKey(hit.label).slice(0, 48) +
    "|" +
    hit.lat.toFixed(3) +
    "," +
    hit.lon.toFixed(3)
  );
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

function sortHits(hits, options = {}) {
  const nearLat = Number(options.nearLat);
  const nearLon = Number(options.nearLon);
  const hasNear = Number.isFinite(nearLat) && Number.isFinite(nearLon);

  return hits.slice().sort(function (a, b) {
    if (hasNear) {
      const da = haversineKm(nearLat, nearLon, a.lat, a.lon);
      const db = haversineKm(nearLat, nearLon, b.lat, b.lon);
      if (da !== db) return da - db;
    }
    return b.score - a.score || a.label.localeCompare(b.label);
  });
}

function collapseDuplicateLabels(hits) {
  const out = [];
  const seen = new Set();
  for (const hit of hits) {
    const key = String(hit.label || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

function mergeHits(lists, limit, options = {}) {
  const raw = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const hit = normalizeHit(item);
      if (hit) raw.push(hit);
    }
  }

  const clustered = clusterHits(raw).filter(function (hit) {
    return !shouldSuppressVagueHit(hit, raw);
  });

  const best = new Map();
  for (const hit of clustered) {
    const key = dedupeKey(hit);
    const prev = best.get(key);
    if (!prev || hit.score > prev.score) {
      best.set(key, hit);
    }
  }

  return collapseDuplicateLabels(sortHits(Array.from(best.values()), options))
    .slice(0, limit)
    .map(function (hit) {
      return { lat: hit.lat, lon: hit.lon, label: hit.label };
    });
}

function isUnitedStatesHit(countryCode, countryName) {
  const cc = String(countryCode || "")
    .trim()
    .toUpperCase();
  if (cc === "US" || cc === "USA") return true;
  const cn = String(countryName || "").trim().toLowerCase();
  return cn === "united states" || cn === "united states of america";
}

function expandStreetAbbreviations(query) {
  return String(query || "")
    .replace(/\s+/g, " ")
    .replace(/\bst\b\.?(?=\s|,|$)/gi, "Street")
    .replace(/\bave\b\.?(?=\s|,|$)/gi, "Avenue")
    .replace(/\bblvd\b\.?(?=\s|,|$)/gi, "Boulevard")
    .replace(/\bdr\b\.?(?=\s|,|$)/gi, "Drive")
    .replace(/\brd\b\.?(?=\s|,|$)/gi, "Road")
    .replace(/\bln\b\.?(?=\s|,|$)/gi, "Lane")
    .replace(/\bct\b\.?(?=\s|,|$)/gi, "Court")
    .replace(/\bpl\b\.?(?=\s|,|$)/gi, "Place")
    .replace(/\bpkwy\b\.?(?=\s|,|$)/gi, "Parkway")
    .replace(/\bhwy\b\.?(?=\s|,|$)/gi, "Highway")
    .trim();
}

function buildQueryVariants(query) {
  const base = String(query || "").trim().replace(/\s+/g, " ");
  if (!base) return [];

  const variants = new Set([base]);
  const expanded = expandStreetAbbreviations(base);
  if (expanded) variants.add(expanded);

  const cityStateSuffix = function (text, city, state) {
    const re = new RegExp("\\b" + city + "\\b", "i");
    if (re.test(text) && !new RegExp("\\b(" + state + "|tennessee|tn)\\b", "i").test(text)) {
      variants.add(text.replace(re, city + ", " + state));
    }
  };

  cityStateSuffix(base, "Chattanooga", "TN");
  cityStateSuffix(expanded, "Chattanooga", "TN");

  const commaMatch = base.match(/^(\d+\s+[^,]+?)\s+([A-Za-z .'-]+)$/);
  if (commaMatch && !base.includes(",")) {
    variants.add(commaMatch[1].trim() + ", " + commaMatch[2].trim());
    variants.add(commaMatch[1].trim() + ", " + commaMatch[2].trim() + ", TN");
  }

  return Array.from(variants);
}

function nearOptions(options = {}) {
  const nearLat = Number(options.nearLat);
  const nearLon = Number(options.nearLon);
  if (!Number.isFinite(nearLat) || !Number.isFinite(nearLon)) {
    return null;
  }
  return { lat: nearLat, lon: nearLon };
}

function nominatimViewbox(near) {
  const delta = 0.85;
  const left = near.lon - delta;
  const right = near.lon + delta;
  const top = near.lat + delta;
  const bottom = near.lat - delta;
  return left + "," + top + "," + right + "," + bottom;
}

async function searchGeocodio(query, limit, near) {
  const apiKey = geocodioApiKey();
  if (!apiKey) return [];

  const url = new URL("https://api.geocod.io/v1.7/autocomplete");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("limit", String(Math.max(limit, 5)));
  if (near) {
    url.searchParams.set("lat", String(near.lat));
    url.searchParams.set("lon", String(near.lon));
  }

  const data = await fetchJson(url.toString());
  const rows = Array.isArray(data?.results) ? data.results : [];
  const out = [];

  for (const row of rows) {
    const loc = row?.location || {};
    const lat = Number(loc.lat);
    const lon = Number(loc.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const components = row?.address_components || {};
    if (
      components.country &&
      !isUnitedStatesHit(components.country, components.country)
    ) {
      continue;
    }

    const label =
      String(row?.formatted_address || "").trim() ||
      [
        components.number,
        components.formatted_street,
        components.city,
        components.state,
        components.zip,
      ]
        .filter(Boolean)
        .join(", ");

    const accuracy = Number(row?.accuracy);
    const score = 100 - (Number.isFinite(accuracy) ? accuracy : 5);
    out.push({ lat, lon, label, source: "geocod.io", score });
    if (out.length >= limit) break;
  }

  if (out.length) return out;

  const geocodeUrl = new URL("https://api.geocod.io/v1.7/geocode");
  geocodeUrl.searchParams.set("q", query);
  geocodeUrl.searchParams.set("api_key", apiKey);
  geocodeUrl.searchParams.set("limit", String(limit));
  geocodeUrl.searchParams.set("country", "US");

  const geocodeData = await fetchJson(geocodeUrl.toString());
  const geocodeRows = Array.isArray(geocodeData?.results)
    ? geocodeData.results
    : [];

  for (const row of geocodeRows) {
    const loc = row?.location || {};
    const lat = Number(loc.lat);
    const lon = Number(loc.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const label = String(row?.formatted_address || query).trim();
    const accuracy = Number(row?.accuracy);
    out.push({
      lat,
      lon,
      label,
      source: "geocod.io",
      score: 95 - (Number.isFinite(accuracy) ? accuracy : 5),
    });
    if (out.length >= limit) break;
  }

  return out;
}

async function searchCensus(query, limit) {
  const url = new URL(
    "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
  );
  url.searchParams.set("address", query);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("format", "json");

  const data = await fetchJson(url.toString());
  const matches = Array.isArray(data?.result?.addressMatches)
    ? data.result.addressMatches
    : [];
  const out = [];

  for (const row of matches) {
    const coords = row?.coordinates || {};
    const lat = Number(coords.y);
    const lon = Number(coords.x);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const label = String(row?.matchedAddress || query).trim();
    const score =
      String(row?.matchCode || "").toUpperCase() === "Exact" ? 92 : 86;
    out.push({ lat, lon, label, source: "census", score });
    if (out.length >= limit) break;
  }

  return out;
}

function photonLabel(props) {
  if (!props || typeof props !== "object") return "";
  if (props.housenumber && props.street) {
    return (
      [props.housenumber, props.street, props.city, props.state, props.postcode]
        .filter(Boolean)
        .join(", ")
    );
  }
  if (props.name && props.city && props.state) {
    return props.name + ", " + props.city + ", " + props.state;
  }
  if (props.street && props.city && props.state) {
    return (
      [props.housenumber, props.street].filter(Boolean).join(" ") +
      ", " +
      props.city +
      ", " +
      props.state
    );
  }
  return [
    props.name,
    props.street,
    props.city,
    props.state,
    props.postcode,
    props.country,
  ]
    .filter(Boolean)
    .join(", ");
}

async function searchPhoton(query, limit, near) {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(Math.max(limit, 5)));
  url.searchParams.set("lang", "en");
  url.searchParams.set("bbox", US_PHOTON_BBOX);
  if (near) {
    url.searchParams.set("lat", String(near.lat));
    url.searchParams.set("lon", String(near.lon));
  }

  const data = await fetchJson(url.toString());
  const features = Array.isArray(data?.features) ? data.features : [];
  const out = [];

  for (const feature of features) {
    const coords = feature?.geometry?.coordinates;
    const props = feature?.properties || {};
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (
      props.countrycode &&
      !isUnitedStatesHit(props.countrycode, props.country)
    ) {
      continue;
    }
    const label = photonLabel(props).trim() || query;
    let score = 72 - Math.min(10, Number(props.importance || 0) * 10);
    if (props.housenumber && props.street) score += 8;
    out.push({ lat, lon, label, source: "photon", score });
    if (out.length >= limit) break;
  }

  return out;
}

async function searchNominatim(query, limit, near) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "json");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("countrycodes", "us");
  url.searchParams.set("limit", String(Math.max(limit, 5)));
  url.searchParams.set("q", query);
  if (near) {
    url.searchParams.set("viewbox", nominatimViewbox(near));
    url.searchParams.set("bounded", "0");
  }

  const data = await fetchJson(url.toString());
  if (!Array.isArray(data)) return [];
  const out = [];

  for (const row of data) {
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const addr = row.address || {};
    if (
      addr.country_code &&
      !isUnitedStatesHit(addr.country_code, addr.country)
    ) {
      continue;
    }
    const label = String(row.display_name || query).trim();
    const importance = Number(row.importance);
    let score = 58 + (Number.isFinite(importance) ? importance * 10 : 0);
    if (row.type === "house" || row.class === "building") score += 10;
    out.push({ lat, lon, label, source: "nominatim", score });
    if (out.length >= limit) break;
  }

  return out;
}

async function geocodeSearch(query, options = {}) {
  const q = String(query || "").trim();
  const limit = Math.min(10, Math.max(1, Number(options.limit) || 5));
  if (!q) return [];

  const near = nearOptions(options);
  const variants = buildQueryVariants(q);
  const lists = [];
  const providerLimit = Math.max(limit, PROVIDER_FETCH_LIMIT);

  if (geocodioApiKey()) {
    lists.push(await searchGeocodio(q, providerLimit, near).catch(function () {
      return [];
    }));
  }

  const censusTasks = variants.map(function (variant) {
    return searchCensus(variant, providerLimit);
  });
  const censusResults = await Promise.allSettled(censusTasks);
  for (const entry of censusResults) {
    if (entry.status === "fulfilled" && Array.isArray(entry.value)) {
      lists.push(entry.value);
    }
  }

  const settled = await Promise.allSettled(
    variants.flatMap(function (variant) {
      return [
        searchPhoton(variant, providerLimit, near),
        searchNominatim(variant, providerLimit, near),
      ];
    })
  );

  for (const entry of settled) {
    if (entry.status === "fulfilled" && Array.isArray(entry.value)) {
      lists.push(entry.value);
    }
  }

  return mergeHits(lists, limit, options);
}

function streetLineFromPhotonProps(props) {
  if (!props || typeof props !== "object") return "";
  const street = [props.housenumber, props.street].filter(Boolean).join(" ").trim();
  const city = props.city || props.locality || props.district || props.county;
  const state = props.state;
  if (street && city && state) return street + ", " + city + ", " + state;
  if (street && city) return street + ", " + city;
  if (street && state) return street + ", " + state;
  if (street) return street;
  if (props.name && city && state) return props.name + ", " + city + ", " + state;
  return photonLabel(props);
}

function streetLineFromNominatimAddress(addr, displayName) {
  if (!addr || typeof addr !== "object") {
    return String(displayName || "").trim();
  }
  const street = [addr.house_number, addr.road || addr.pedestrian || addr.footway]
    .filter(Boolean)
    .join(" ")
    .trim();
  const city =
    addr.city ||
    addr.town ||
    addr.village ||
    addr.hamlet ||
    addr.municipality ||
    addr.county;
  const state = addr.state;
  if (street && city && state) return street + ", " + city + ", " + state;
  if (street && city) return street + ", " + city;
  if (street && state) return street + ", " + state;
  if (street) return street;
  const fallback = String(displayName || "")
    .split(",")
    .slice(0, 3)
    .join(",")
    .trim();
  return fallback;
}

function streetLineFromGeocodioComponents(components, formatted) {
  const c = components || {};
  const street = String(c.formatted_street || "").trim();
  const city = String(c.city || "").trim();
  const state = String(c.state || "").trim();
  if (street && city && state) return street + ", " + city + ", " + state;
  if (street && city) return street + ", " + city;
  if (street && state) return street + ", " + state;
  if (street) return street;
  return String(formatted || "").trim();
}

async function reverseGeocodio(lat, lon) {
  const apiKey = geocodioApiKey();
  if (!apiKey) return null;
  const url = new URL("https://api.geocod.io/v1.7/reverse");
  url.searchParams.set("q", lat + "," + lon);
  url.searchParams.set("api_key", apiKey);
  const data = await fetchJson(url.toString());
  const row = data?.results?.[0]?.response?.results?.[0];
  if (!row) return null;
  const components = row.address_components || {};
  const label = streetLineFromGeocodioComponents(
    components,
    row.formatted_address || row.formatted_street
  );
  return label || null;
}

async function reversePhoton(lat, lon) {
  const url = new URL("https://photon.komoot.io/reverse");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("lang", "en");
  const data = await fetchJson(url.toString());
  const feature = Array.isArray(data?.features) ? data.features[0] : null;
  const props = feature?.properties || {};
  if (
    props.countrycode &&
    !isUnitedStatesHit(props.countrycode, props.country)
  ) {
    return null;
  }
  const label = streetLineFromPhotonProps(props).trim();
  return label || null;
}

async function reverseNominatim(lat, lon) {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "json");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("zoom", "18");
  const data = await fetchJson(url.toString());
  const addr = data?.address || {};
  if (
    addr.country_code &&
    !isUnitedStatesHit(addr.country_code, addr.country)
  ) {
    return null;
  }
  const label = streetLineFromNominatimAddress(addr, data?.display_name).trim();
  return label || null;
}

const REVERSE_CACHE_MAX = 3000;

/** @type {Map<string, string|null>} */
const reverseCache = new Map();

function reverseCacheKey(lat, lon) {
  return Number(lat).toFixed(4) + "," + Number(lon).toFixed(4);
}

function getReverseCached(lat, lon) {
  const key = reverseCacheKey(lat, lon);
  if (!reverseCache.has(key)) return undefined;
  return reverseCache.get(key);
}

function setReverseCached(lat, lon, label) {
  const key = reverseCacheKey(lat, lon);
  if (reverseCache.size >= REVERSE_CACHE_MAX) {
    const oldest = reverseCache.keys().next().value;
    if (oldest) reverseCache.delete(oldest);
  }
  reverseCache.set(key, label || null);
}

async function reverseGeocode(lat, lon) {
  const latNum = Number(lat);
  const lonNum = Number(lon);
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) return null;

  const cached = getReverseCached(latNum, lonNum);
  if (cached !== undefined) return cached;

  let label = null;

  if (geocodioApiKey()) {
    label = await reverseGeocodio(latNum, lonNum).catch(function () {
      return null;
    });
  }

  if (!label) {
    label = await reversePhoton(latNum, lonNum).catch(function () {
      return null;
    });
  }

  if (!label) {
    label = await reverseNominatim(latNum, lonNum).catch(function () {
      return null;
    });
  }

  setReverseCached(latNum, lonNum, label);
  return label;
}

async function reverseGeocodeBatch(points, options = {}) {
  const list = Array.isArray(points) ? points : [];
  const max = Math.min(12, Math.max(1, Number(options.limit) || 12));
  const results = {};
  const toFetch = [];

  for (const point of list.slice(0, max)) {
    const key = String(point?.key || "").trim();
    const lat = Number(point?.lat);
    const lon = Number(point?.lon);
    if (!key || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const cached = getReverseCached(lat, lon);
    if (cached !== undefined) {
      results[key] = cached;
      continue;
    }
    toFetch.push({ key, lat, lon });
  }

  for (const point of toFetch) {
    results[point.key] = await reverseGeocode(point.lat, point.lon);
  }

  return results;
}

module.exports = {
  geocodeSearch,
  reverseGeocode,
  reverseGeocodeBatch,
  mergeHits,
  normalizeHit,
  isUnitedStatesHit,
  buildQueryVariants,
  haversineKm,
  sortHits,
  clusterHits,
  labelQualityScore,
  streetLineFromPhotonProps,
  streetLineFromNominatimAddress,
};
