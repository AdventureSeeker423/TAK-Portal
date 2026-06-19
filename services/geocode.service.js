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

function dedupeKey(hit) {
  return (
    hit.label.toLowerCase().replace(/\s+/g, " ").slice(0, 80) +
    "|" +
    hit.lat.toFixed(4) +
    "," +
    hit.lon.toFixed(4)
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
      if (Math.abs(da - db) > 0.05) return da - db;
    }
    return b.score - a.score || a.label.localeCompare(b.label);
  });
}

function mergeHits(lists, limit, options = {}) {
  const best = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const hit = normalizeHit(raw);
      if (!hit) continue;
      const key = dedupeKey(hit);
      const prev = best.get(key);
      if (!prev || hit.score > prev.score) {
        best.set(key, hit);
      }
    }
  }
  return sortHits(Array.from(best.values()), options)
    .slice(0, limit)
    .map(function (hit) {
      return { lat: hit.lat, lon: hit.lon, label: hit.label, source: hit.source };
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

  const settled = await Promise.allSettled([
    searchPhoton(q, providerLimit, near),
    searchNominatim(q, providerLimit, near),
    variants.length > 1
      ? searchPhoton(variants[1], providerLimit, near)
      : Promise.resolve([]),
    variants.length > 1
      ? searchNominatim(variants[1], providerLimit, near)
      : Promise.resolve([]),
  ]);

  for (const entry of settled) {
    if (entry.status === "fulfilled" && Array.isArray(entry.value)) {
      lists.push(entry.value);
    }
  }

  return mergeHits(lists, limit, options);
}

module.exports = {
  geocodeSearch,
  mergeHits,
  normalizeHit,
  isUnitedStatesHit,
  buildQueryVariants,
  haversineKm,
  sortHits,
};
