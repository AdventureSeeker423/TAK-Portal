/**
 * Shared shape editor-handle filtering for mission GeoJSON and live markers.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.ShapeDecorFilter = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function geometryKind(geom) {
    const t = String(geom?.type || "").toLowerCase();
    if (t === "point") return "point";
    if (t === "linestring" || t === "multilinestring") return "line";
    if (t === "polygon" || t === "multipolygon") return "polygon";
    return "other";
  }

  function coordKey(lon, lat, decimals) {
    const d = decimals == null ? 5 : decimals;
    return `${Number(lon).toFixed(d)},${Number(lat).toFixed(d)}`;
  }

  function addVertexKey(keys, lon, lat) {
    keys.add(coordKey(lon, lat, 5));
    keys.add(coordKey(lon, lat, 4));
    keys.add(coordKey(lon, lat, 3));
  }

  function coordMatchesVertex(lon, lat, vertexKeys) {
    return (
      vertexKeys.has(coordKey(lon, lat, 5)) ||
      vertexKeys.has(coordKey(lon, lat, 4)) ||
      vertexKeys.has(coordKey(lon, lat, 3))
    );
  }

  function isShapeControlCotType(type) {
    const t = String(type || "").toLowerCase();
    return (
      t.startsWith("u-d-") ||
      t.startsWith("b-m-p-") ||
      t.startsWith("b-m-r-") ||
      t.startsWith("b-m-c-")
    );
  }

  function missionHasShapeGeometry(features) {
    return (features || []).some(function (feature) {
      const kind = geometryKind(feature?.geometry);
      return kind === "line" || kind === "polygon";
    });
  }

  function collectShapeSegments(features) {
    const segments = [];
    function addRing(coords) {
      for (let i = 0; i < (coords || []).length - 1; i++) {
        const a = coords[i];
        const b = coords[i + 1];
        if (a && b) segments.push([a, b]);
      }
    }
    for (const feature of features || []) {
      const geom = feature?.geometry;
      if (!geom) continue;
      const type = String(geom.type || "");
      if (type === "LineString") {
        addRing(geom.coordinates || []);
      } else if (type === "MultiLineString") {
        for (const line of geom.coordinates || []) addRing(line || []);
      } else if (type === "Polygon") {
        for (const ring of geom.coordinates || []) addRing(ring || []);
      } else if (type === "MultiPolygon") {
        for (const poly of geom.coordinates || []) {
          for (const ring of poly || []) addRing(ring || []);
        }
      }
    }
    return segments;
  }

  function distPointToSegment(lon, lat, a, b) {
    const x = Number(lon);
    const y = Number(lat);
    const x1 = Number(a[0]);
    const y1 = Number(a[1]);
    const x2 = Number(b[0]);
    const y2 = Number(b[1]);
    const dx = x2 - x1;
    const dy = y2 - y1;
    if (dx === 0 && dy === 0) {
      const ddx = x - x1;
      const ddy = y - y1;
      return Math.sqrt(ddx * ddx + ddy * ddy);
    }
    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
    const px = x1 + t * dx;
    const py = y1 + t * dy;
    const ddx = x - px;
    const ddy = y - py;
    return Math.sqrt(ddx * ddx + ddy * ddy);
  }

  function distDeg(lon1, lat1, lon2, lat2) {
    const dx = Number(lon2) - Number(lon1);
    const dy = Number(lat2) - Number(lat1);
    return Math.sqrt(dx * dx + dy * dy);
  }

  function isPointNearShapeBoundary(lon, lat, segments, epsilonDeg) {
    const eps = epsilonDeg != null ? epsilonDeg : 0.00015;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (distPointToSegment(lon, lat, seg[0], seg[1]) <= eps) return true;
    }
    return false;
  }

  function isCircleShapeCotType(type) {
    const t = String(type || "").toLowerCase();
    return (
      t.startsWith("u-d-c-c") ||
      t.startsWith("u-r-b-c-c") ||
      t.startsWith("u-d-c-e")
    );
  }

  function collectCircleRingProfiles(features) {
    const profiles = [];
    for (const feature of features || []) {
      const geom = feature?.geometry;
      if (!geom || String(geom.type || "") !== "Polygon") continue;
      const ring = geom.coordinates?.[0];
      if (!ring || ring.length < 4) continue;
      const props = feature.properties || {};
      if (!isCircleShapeCotType(props.type || props.cotType)) continue;

      let cx;
      let cy;
      if (Array.isArray(props.center) && props.center.length >= 2) {
        cx = Number(props.center[0]);
        cy = Number(props.center[1]);
      } else {
        cx = 0;
        cy = 0;
        const limit = Math.max(1, ring.length - 1);
        for (let i = 0; i < limit; i++) {
          cx += Number(ring[i][0]);
          cy += Number(ring[i][1]);
        }
        cx /= limit;
        cy /= limit;
      }
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;

      let minRadius = Infinity;
      let maxRadius = 0;
      const limit = Math.max(1, ring.length - 1);
      for (let i = 0; i < limit; i++) {
        const d = distDeg(cx, cy, ring[i][0], ring[i][1]);
        if (d < minRadius) minRadius = d;
        if (d > maxRadius) maxRadius = d;
      }
      if (!Number.isFinite(minRadius) || !Number.isFinite(maxRadius)) continue;
      profiles.push({ cx, cy, minRadiusDeg: minRadius, maxRadiusDeg: maxRadius });
    }
    return profiles;
  }

  function isPointNearCircleRing(lon, lat, profiles, epsilonDeg) {
    const eps = epsilonDeg != null ? epsilonDeg : 0.00015;
    for (let i = 0; i < profiles.length; i++) {
      const profile = profiles[i];
      const d = distDeg(profile.cx, profile.cy, lon, lat);
      if (d + eps >= profile.minRadiusDeg && d - eps <= profile.maxRadiusDeg) {
        return true;
      }
    }
    return false;
  }

  function collectShapeVertexKeys(features) {
    const keys = new Set();
    for (const feature of features || []) {
      const geom = feature?.geometry;
      if (!geom) continue;
      const type = String(geom.type || "");
      if (type === "LineString") {
        for (const coord of geom.coordinates || []) {
          addVertexKey(keys, coord[0], coord[1]);
        }
      } else if (type === "MultiLineString") {
        for (const line of geom.coordinates || []) {
          for (const coord of line || []) {
            addVertexKey(keys, coord[0], coord[1]);
          }
        }
      } else if (type === "Polygon") {
        for (const ring of geom.coordinates || []) {
          for (const coord of ring || []) {
            addVertexKey(keys, coord[0], coord[1]);
          }
        }
      } else if (type === "MultiPolygon") {
        for (const poly of geom.coordinates || []) {
          for (const ring of poly || []) {
            for (const coord of ring || []) {
              addVertexKey(keys, coord[0], coord[1]);
            }
          }
        }
      }
    }
    return keys;
  }

  function looksLikeUserIconPath(raw) {
    const s = String(raw || "").trim();
    if (!s || !s.includes("/")) return false;
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(s)) return true;
    return /^[0-9a-f-]{36}\//i.test(s) || /^[0-9a-f]{32,64}\//i.test(s);
  }

  function hasExplicitUserIcon(props) {
    if (!props || typeof props !== "object") return false;
    if (looksLikeUserIconPath(props.iconsetpath)) return true;
    if (looksLikeUserIconPath(props.icon)) return true;
    return !!props.usericon;
  }

  function isLikelyTacticalMarker(type, props) {
    const t = String(type || "").toLowerCase();
    if (hasExplicitUserIcon(props)) return true;
    if (t.startsWith("a-f-")) return true;
    if (t.startsWith("b-i-")) return true;
    return false;
  }

  function collectShapeOwnerUids(features) {
    const uids = new Set();
    for (const feature of features || []) {
      const props = feature.properties || {};
      const type = String(props.type || props.cotType || "").toLowerCase();
      const geom = geometryKind(feature?.geometry);
      if (geom !== "polygon" && geom !== "line") continue;
      if (
        type.startsWith("u-d-") ||
        type.startsWith("u-r-") ||
        type.startsWith("b-m-r") ||
        isCircleShapeCotType(type)
      ) {
        const uid = String(feature.id || props.uid || "");
        if (uid) uids.add(uid);
      }
    }
    return uids;
  }

  function isPointOwnedByShape(feature, shapeUids) {
    if (!shapeUids || !shapeUids.size) return false;
    const uid = String(feature.id || feature.properties?.uid || "");
    for (const shapeUid of shapeUids) {
      if (!shapeUid || uid === shapeUid) continue;
      if (uid.startsWith(shapeUid + ".") || uid.startsWith(shapeUid + "-")) return true;
    }
    const links = feature.properties?.links;
    const linkList = Array.isArray(links) ? links : links ? [links] : [];
    for (let i = 0; i < linkList.length; i++) {
      const linkUid = String(linkList[i]?.uid || linkList[i]?.Uid || "");
      if (shapeUids.has(linkUid)) return true;
    }
    return false;
  }

  function summarizeDecorPoint(feature) {
    const props = feature.properties || {};
    const coords = feature.geometry?.coordinates || [];
    return {
      uid: String(feature.id || props.uid || ""),
      type: String(props.type || props.cotType || ""),
      callsign: String(props.callsign || props.name || ""),
      how: String(props.how || ""),
      lon: coords[0],
      lat: coords[1],
      icon: String(props.icon || props.iconsetpath || ""),
      showCircle: props.showCircle,
    };
  }

  function buildShapeDecorIndex(features) {
    const list = Array.isArray(features) ? features : [];
    return {
      vertexKeys: collectShapeVertexKeys(list),
      segments: collectShapeSegments(list),
      ringProfiles: collectCircleRingProfiles(list),
      shapeUids: collectShapeOwnerUids(list),
      hasShapes: missionHasShapeGeometry(list),
    };
  }

  function shouldDropShapeDecorPoint(feature, index) {
    const idx = index || {};
    const vertexKeys = idx.vertexKeys || new Set();
    const segments = idx.segments || [];
    const ringProfiles = idx.ringProfiles || [];
    const shapeUids = idx.shapeUids || new Set();
    const hasShapes = !!idx.hasShapes;

    if (geometryKind(feature?.geometry) !== "point") return false;
    const coords = feature.geometry.coordinates;
    if (!coords || coords.length < 2) return false;
    const props = feature.properties || {};
    if (hasExplicitUserIcon(props)) return false;

    const type = String(props.type || props.cotType || "").toLowerCase();
    if (isLikelyTacticalMarker(type, props)) return false;
    const lon = coords[0];
    const lat = coords[1];

    if (hasShapes && isShapeControlCotType(type)) return true;
    if (shapeUids.size && isPointOwnedByShape(feature, shapeUids)) return true;
    if (coordMatchesVertex(lon, lat, vertexKeys)) return true;
    if (!hasShapes) return false;

    const onBoundary =
      segments.length > 0 && isPointNearShapeBoundary(lon, lat, segments);
    const onCircleRing =
      ringProfiles.length > 0 && isPointNearCircleRing(lon, lat, ringProfiles);
    return onBoundary || onCircleRing;
  }

  function auditShapeDecor(features) {
    const list = Array.isArray(features) ? features : [];
    const index = buildShapeDecorIndex(list);
    const rawPoints = list.filter(function (feature) {
      return geometryKind(feature?.geometry) === "point";
    });
    const dropped = [];
    const kept = [];
    for (let i = 0; i < rawPoints.length; i++) {
      const feature = rawPoints[i];
      const summary = summarizeDecorPoint(feature);
      if (shouldDropShapeDecorPoint(feature, index)) {
        dropped.push(summary);
      } else {
        kept.push(summary);
      }
    }
    const dotMarkers = list.filter(function (feature) {
      const props = feature.properties || {};
      return (
        geometryKind(feature?.geometry) === "point" &&
        (props.showCircle === 1 || props.showCircle === true)
      );
    });
    return {
      featureCount: list.length,
      polygonCount: list.filter(function (f) {
        return geometryKind(f?.geometry) === "polygon";
      }).length,
      shapeIndex: {
        hasShapes: index.hasShapes,
        vertexKeys: index.vertexKeys.size,
        segments: index.segments.length,
        ringProfiles: index.ringProfiles.length,
        shapeUids: index.shapeUids.size,
        shapeUidSample: Array.from(index.shapeUids).slice(0, 8),
      },
      rawPointCount: rawPoints.length,
      droppedPointCount: dropped.length,
      keptPointCount: kept.length,
      normalizedDotCount: dotMarkers.length,
      keptPointSample: kept.slice(0, 15),
      normalizedDotSample: dotMarkers.slice(0, 15).map(summarizeDecorPoint),
      droppedPointSample: dropped.slice(0, 15),
    };
  }

  function filterShapeVertexPoints(features) {
    const index = buildShapeDecorIndex(features);
    if (!index.vertexKeys.size && !index.segments.length && !index.ringProfiles.length) {
      return features;
    }
    return (features || []).filter(function (feature) {
      return !shouldDropShapeDecorPoint(feature, index);
    });
  }

  function shouldSkipLiveStreamMarker(marker) {
    const type = String(marker?.type || marker?.cotType || "").toLowerCase();
    if (
      type.startsWith("u-d-") ||
      type.startsWith("b-m-p-") ||
      type.startsWith("b-m-r-") ||
      type.startsWith("b-m-c-")
    ) {
      return true;
    }
    const how = String(marker?.how || "").toLowerCase();
    const hasIcon = hasExplicitUserIcon({
      icon: marker?.icon || marker?.iconsetpath,
      iconsetpath: marker?.iconsetpath,
    });
    if (!hasIcon && (how === "m-g" || how.startsWith("m-g-"))) {
      if (type.startsWith("a-n-") || type.startsWith("a-u-") || type.startsWith("a-p-")) {
        return true;
      }
    }
    return false;
  }

  return {
    buildShapeDecorIndex: buildShapeDecorIndex,
    shouldDropShapeDecorPoint: shouldDropShapeDecorPoint,
    filterShapeVertexPoints: filterShapeVertexPoints,
    auditShapeDecor: auditShapeDecor,
    shouldSkipLiveStreamMarker: shouldSkipLiveStreamMarker,
  };
});
