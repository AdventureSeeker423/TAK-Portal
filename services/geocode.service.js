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

function mergeHits(lists, limit) {
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
  return Array.from(best.values())
    .sort(function (a, b) {
      return b.score - a.score || a.label.localeCompare(b.label);
    })
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

async function searchGeocodio(query, limit) {
  const apiKey = geocodioApiKey();
  if (!apiKey) return [];

  const url = new URL("https://api.geocod.io/v1.7/autocomplete");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("limit", String(Math.max(limit, 5)));

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
      String(row?.matchCode || "").toUpperCase() === "Exact" ? 88 : 82;
    out.push({ lat, lon, label, source: "census", score });
    if (out.length >= limit) break;
  }

  return out;
}

function photonLabel(props) {
  if (!props || typeof props !== "object") return "";
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

async function searchPhoton(query, limit) {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(Math.max(limit, 5)));
  url.searchParams.set("lang", "en");
  url.searchParams.set("bbox", US_PHOTON_BBOX);

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
    const score = 70 - Math.min(10, Number(props.importance || 0) * 10);
    out.push({ lat, lon, label, source: "photon", score });
    if (out.length >= limit) break;
  }

  return out;
}

async function searchNominatim(query, limit) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "json");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("countrycodes", "us");
  url.searchParams.set("limit", String(Math.max(limit, 5)));
  url.searchParams.set("q", query);

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
    const score = 55 + (Number.isFinite(importance) ? importance * 10 : 0);
    out.push({ lat, lon, label, source: "nominatim", score });
    if (out.length >= limit) break;
  }

  return out;
}

async function geocodeSearch(query, options = {}) {
  const q = String(query || "").trim();
  const limit = Math.min(10, Math.max(1, Number(options.limit) || 5));
  if (!q) return [];

  const tasks = [searchCensus(q, limit), searchPhoton(q, limit), searchNominatim(q, limit)];
  if (geocodioApiKey()) {
    tasks.unshift(searchGeocodio(q, limit));
  }

  const settled = await Promise.allSettled(tasks);
  const lists = settled
    .filter(function (entry) {
      return entry.status === "fulfilled";
    })
    .map(function (entry) {
      return entry.value;
    });

  return mergeHits(lists, limit);
}

module.exports = {
  geocodeSearch,
  mergeHits,
  normalizeHit,
  isUnitedStatesHit,
};
