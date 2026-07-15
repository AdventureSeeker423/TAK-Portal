/**
 * Geofence spatial helpers (no external geo deps).
 */

const EARTH_RADIUS_M = 6371008.8;
const CIRCLE_STEPS = 64;

function toFiniteNumber(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function haversineMeters(lon1, lat1, lon2, lat2) {
  const rLat1 = (lat1 * Math.PI) / 180;
  const rLat2 = (lat2 * Math.PI) / 180;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function offsetLonLat(lon, lat, bearingDeg, distanceM) {
  const br = (bearingDeg * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lon1 = (lon * Math.PI) / 180;
  const ang = distanceM / EARTH_RADIUS_M;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(ang) + Math.cos(lat1) * Math.sin(ang) * Math.cos(br)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(br) * Math.sin(ang) * Math.cos(lat1),
      Math.cos(ang) - Math.sin(lat1) * Math.sin(lat2)
    );
  return [(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI];
}

function circleRing(centerLon, centerLat, radiusMeters, steps = CIRCLE_STEPS) {
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const bearing = (360 * i) / steps;
    ring.push(offsetLonLat(centerLon, centerLat, bearing, radiusMeters));
  }
  return ring;
}

function normalizeRectangle(geometry) {
  if (!geometry || geometry.type !== "rectangle") return null;
  if (
    Array.isArray(geometry.sw) &&
    geometry.sw.length >= 2 &&
    Array.isArray(geometry.ne) &&
    geometry.ne.length >= 2
  ) {
    const swLon = toFiniteNumber(geometry.sw[0]);
    const swLat = toFiniteNumber(geometry.sw[1]);
    const neLon = toFiniteNumber(geometry.ne[0]);
    const neLat = toFiniteNumber(geometry.ne[1]);
    if (swLon == null || swLat == null || neLon == null || neLat == null) return null;
    return {
      minLon: Math.min(swLon, neLon),
      maxLon: Math.max(swLon, neLon),
      minLat: Math.min(swLat, neLat),
      maxLat: Math.max(swLat, neLat),
    };
  }
  const coords = Array.isArray(geometry.coordinates) ? geometry.coordinates : null;
  if (!coords || coords.length < 2) return null;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const c of coords) {
    if (!Array.isArray(c) || c.length < 2) continue;
    const lon = toFiniteNumber(c[0]);
    const lat = toFiniteNumber(c[1]);
    if (lon == null || lat == null) continue;
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  if (!Number.isFinite(minLon) || !Number.isFinite(minLat)) return null;
  return { minLon, maxLon, minLat, maxLat };
}

/** Ray-casting point-in-polygon. ring is [[lon,lat],...] (open or closed). */
function pointInRing(lon, lat, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = toFiniteNumber(ring[i][0]);
    const yi = toFiniteNumber(ring[i][1]);
    const xj = toFiniteNumber(ring[j][0]);
    const yj = toFiniteNumber(ring[j][1]);
    if (xi == null || yi == null || xj == null || yj == null) continue;
    const intersect =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInGeometry(lon, lat, geometry) {
  const x = toFiniteNumber(lon);
  const y = toFiniteNumber(lat);
  if (x == null || y == null || !geometry || typeof geometry !== "object") return false;

  const type = String(geometry.type || "").toLowerCase();
  if (type === "circle") {
    const center = Array.isArray(geometry.center) ? geometry.center : null;
    const radius = toFiniteNumber(geometry.radiusMeters);
    if (!center || center.length < 2 || radius == null || radius < 0) return false;
    const cLon = toFiniteNumber(center[0]);
    const cLat = toFiniteNumber(center[1]);
    if (cLon == null || cLat == null) return false;
    return haversineMeters(cLon, cLat, x, y) <= radius;
  }

  if (type === "rectangle") {
    const box = normalizeRectangle(geometry);
    if (!box) return false;
    return x >= box.minLon && x <= box.maxLon && y >= box.minLat && y <= box.maxLat;
  }

  if (type === "polygon") {
    const coords = Array.isArray(geometry.coordinates) ? geometry.coordinates : null;
    if (!coords || coords.length < 3) return false;
    return pointInRing(x, y, coords);
  }

  return false;
}

function geometryToPolygonCoordinates(geometry) {
  if (!geometry || typeof geometry !== "object") return null;
  const type = String(geometry.type || "").toLowerCase();

  if (type === "circle") {
    const center = Array.isArray(geometry.center) ? geometry.center : null;
    const radius = toFiniteNumber(geometry.radiusMeters);
    if (!center || center.length < 2 || radius == null || radius <= 0) return null;
    const cLon = toFiniteNumber(center[0]);
    const cLat = toFiniteNumber(center[1]);
    if (cLon == null || cLat == null) return null;
    return [circleRing(cLon, cLat, radius)];
  }

  if (type === "rectangle") {
    const box = normalizeRectangle(geometry);
    if (!box) return null;
    return [
      [
        [box.minLon, box.minLat],
        [box.maxLon, box.minLat],
        [box.maxLon, box.maxLat],
        [box.minLon, box.maxLat],
        [box.minLon, box.minLat],
      ],
    ];
  }

  if (type === "polygon") {
    const coords = Array.isArray(geometry.coordinates) ? geometry.coordinates : null;
    if (!coords || coords.length < 3) return null;
    const ring = coords.map((c) => [toFiniteNumber(c[0]), toFiniteNumber(c[1])]);
    if (ring.some((p) => p[0] == null || p[1] == null)) return null;
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ring.push([first[0], first[1]]);
    }
    return [ring];
  }

  return null;
}

function fenceToGeoJsonFeature(fence) {
  if (!fence || !fence.id) return null;
  const coords = geometryToPolygonCoordinates(fence.geometry);
  if (!coords) return null;
  return {
    type: "Feature",
    id: fence.id,
    properties: {
      id: fence.id,
      name: fence.name || "",
      active: fence.active === true,
      geometryType: fence.geometry?.type || "",
      selected: false,
    },
    geometry: {
      type: "Polygon",
      coordinates: coords,
    },
  };
}

function validateGeometry(geometry) {
  if (!geometry || typeof geometry !== "object") {
    return { ok: false, error: "geometry is required." };
  }
  const type = String(geometry.type || "").toLowerCase();
  if (type !== "circle" && type !== "rectangle" && type !== "polygon") {
    return { ok: false, error: "geometry.type must be circle, rectangle, or polygon." };
  }

  if (type === "circle") {
    const center = Array.isArray(geometry.center) ? geometry.center : null;
    const radius = toFiniteNumber(geometry.radiusMeters);
    if (!center || center.length < 2) {
      return { ok: false, error: "circle geometry requires center [lon, lat]." };
    }
    if (toFiniteNumber(center[0]) == null || toFiniteNumber(center[1]) == null) {
      return { ok: false, error: "circle center must be numeric lon/lat." };
    }
    if (radius == null || radius <= 0) {
      return { ok: false, error: "circle radiusMeters must be a positive number." };
    }
    return {
      ok: true,
      geometry: {
        type: "circle",
        center: [toFiniteNumber(center[0]), toFiniteNumber(center[1])],
        radiusMeters: radius,
      },
    };
  }

  if (type === "rectangle") {
    const box = normalizeRectangle(geometry);
    if (!box || box.minLon === box.maxLon || box.minLat === box.maxLat) {
      return { ok: false, error: "rectangle geometry requires two distinct corners." };
    }
    return {
      ok: true,
      geometry: {
        type: "rectangle",
        sw: [box.minLon, box.minLat],
        ne: [box.maxLon, box.maxLat],
      },
    };
  }

  const coords = Array.isArray(geometry.coordinates) ? geometry.coordinates : null;
  if (!coords || coords.length < 3) {
    return { ok: false, error: "polygon requires at least 3 coordinates." };
  }
  const cleaned = [];
  for (const c of coords) {
    if (!Array.isArray(c) || c.length < 2) {
      return { ok: false, error: "polygon coordinates must be [lon, lat] pairs." };
    }
    const lon = toFiniteNumber(c[0]);
    const lat = toFiniteNumber(c[1]);
    if (lon == null || lat == null) {
      return { ok: false, error: "polygon coordinates must be numeric." };
    }
    cleaned.push([lon, lat]);
  }
  return { ok: true, geometry: { type: "polygon", coordinates: cleaned } };
}

module.exports = {
  haversineMeters,
  circleRing,
  pointInGeometry,
  pointInRing,
  normalizeRectangle,
  geometryToPolygonCoordinates,
  fenceToGeoJsonFeature,
  validateGeometry,
};
