(function () {
  "use strict";

  const LS_BASEMAP = "tak-portal-map-basemap";
  const LS_GROUPS_LEGACY = "tak-portal-map-groups";
  const LS_GROUPS_PREFIX = "tak-portal-map-enabled-channels";
  const MAP_USER_KEY = (function () {
    const el = document.body && document.body.getAttribute("data-map-user");
    return String(el || "anonymous").trim() || "anonymous";
  })();
  const LS_PANEL_LEFT = "tak-portal-map-panel-left";
  const LS_DETAIL_PANEL_WIDTH = "tak-portal-map-detail-panel-width";
  const LS_COORD_FORMAT = "tak-portal-map-coord-format";
  const DETAIL_PANEL_MIN_PX = 340;
  const DETAIL_PANEL_MIN_VW = 0.38;
  const DETAIL_PANEL_MAX_VW = 0.5;
  const DETAIL_PANEL_RIGHT_OFFSET = 12;
  const MAX_DETAIL_SLOTS = 3;
  const LAYOUT_NARROW_MAX = 990;

  function isMapLayoutNarrow() {
    return window.innerWidth <= LAYOUT_NARROW_MAX;
  }

  const AFFILIATION_COLORS = {
    friend: "#22c55e",
    hostile: "#ef4444",
    neutral: "#eab308",
    unknown: "#f97316",
    other: "#38bdf8",
  };

  /** ATAK team palette — same as dashboard / ATAK device prefs. */
  const ATAK_TEAM_COLORS = {
    Blue: "#1e88e5",
    "Dark Blue": "#0d47a1",
    Brown: "#6d4c41",
    Cyan: "#00acc1",
    Green: "#43a047",
    "Dark Green": "#1b5e20",
    Magenta: "#d81b60",
    Maroon: "#800000",
    Orange: "#ff7b00",
    Purple: "#8e24aa",
    Red: "#e53935",
    Teal: "#00897b",
    White: "#ffffff",
    Yellow: "#fdd835",
  };

  const ATAK_TEAM_COLORS_LC = Object.fromEntries(
    Object.entries(ATAK_TEAM_COLORS).map(function (entry) {
      return [entry[0].toLowerCase(), entry[1]];
    })
  );

  const MAP_LABEL_FONT = ["Open Sans Semibold"];
  const MARKER_FILTER = ["==", ["get", "kind"], "marker"];
  const SOURCE_ID = "tak-markers";
  const LIVE_SHAPES_SOURCE_ID = "tak-live-shapes";
  const LIVE_SHAPES_FILL_LAYER = "tak-live-shapes-fill";
  const LIVE_SHAPES_LINE_LAYER = "tak-live-shapes-line";
  const CIRCLE_LAYER_LOW = "tak-markers-circle-low";
  const ICON_LAYER_LOW = "tak-markers-icon-low";
  const CIRCLE_LAYER_HIGH = "tak-markers-circle-high";
  const ICON_LAYER_HIGH = "tak-markers-icon-high";
  const LABEL_LAYER = "tak-markers-label";
  const LABEL_PRIORITY_LAYER = "tak-markers-label-priority";
  const MARKER_HIT_LAYER_IDS = [
    CIRCLE_LAYER_LOW,
    ICON_LAYER_LOW,
    CIRCLE_LAYER_HIGH,
    ICON_LAYER_HIGH,
  ];
  const MARKER_LAYER_IDS = [
    CIRCLE_LAYER_LOW,
    ICON_LAYER_LOW,
    CIRCLE_LAYER_HIGH,
    ICON_LAYER_HIGH,
    LABEL_LAYER,
    LABEL_PRIORITY_LAYER,
  ];
  /** Legacy layer ids removed during style restore. */
  const LEGACY_MARKER_LAYER_IDS = [
    "tak-markers-circle",
    "tak-markers-icon",
    "tak-markers-course",
  ];
  /** Must match cotStream.service.js STALE_GRACE_MS */
  const STALE_GRACE_MS = 30000;

  const mapBasemaps = window.TAK_MAP_BASEMAPS || {};
  const MAP_GLYPHS = mapBasemaps.MAP_GLYPHS || "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf";
  const BASEMAPS = mapBasemaps.BASEMAPS || {};
  const withMapGlyphs =
    typeof mapBasemaps.withMapGlyphs === "function"
      ? mapBasemaps.withMapGlyphs
      : function (style) {
          if (typeof style === "string") return style;
          return { ...style, glyphs: MAP_GLYPHS };
        };
  const normalizeBasemapId =
    typeof mapBasemaps.normalizeBasemapId === "function"
      ? mapBasemaps.normalizeBasemapId
      : function (id) {
          const saved = String(id || "").trim() || "dark-matter";
          return BASEMAPS[saved] ? saved : "dark-matter";
        };

  function isMissionMapSourceId(id) {
    const s = String(id || "");
    return s.indexOf("mission-src-") === 0 || s.indexOf("mission-raster-") === 0;
  }

  function isMissionMapLayerId(id) {
    return String(id || "").indexOf("mission-") === 0;
  }

  function preserveMarkerLayersInStyle(prev, next) {
    if (!next || typeof next !== "object") return next;
    const out = { ...next, glyphs: next.glyphs || MAP_GLYPHS };
    if (!prev || typeof prev !== "object") return out;
    if (prev.sources) {
      const mergedSources = { ...(out.sources || {}) };
      let changed = false;
      if (prev.sources[SOURCE_ID]) {
        mergedSources[SOURCE_ID] = prev.sources[SOURCE_ID];
        changed = true;
      }
      for (const [id, source] of Object.entries(prev.sources)) {
        if (isMissionMapSourceId(id)) {
          mergedSources[id] = source;
          changed = true;
        }
      }
      if (changed) out.sources = mergedSources;
    }
    const preservedLayers = (prev.layers || []).filter(function (layer) {
      return MARKER_LAYER_IDS.includes(layer.id) || isMissionMapLayerId(layer.id);
    });
    if (preservedLayers.length) {
      const baseIds = new Set((out.layers || []).map(function (layer) {
        return layer.id;
      }));
      const extra = preservedLayers.filter(function (layer) {
        return !baseIds.has(layer.id);
      });
      if (extra.length) {
        out.layers = [...(out.layers || []), ...extra];
      }
    }
    return out;
  }

  function applyBasemapStyle(style) {
    const opts = {
      transformStyle: function (prev, next) {
        return preserveMarkerLayersInStyle(prev, next);
      },
    };
    if (typeof style === "string") {
      map.setStyle(style, opts);
      return;
    }
    map.setStyle(withMapGlyphs(style), opts);
  }

  const markersByUid = new Map();
  const missionMarkersByUid = new Map();
  const liveShapesByUid = new Map();
  let groupsCatalog = [];
  let mapChannelScope = "all";
  let allowedMemberChannelKeys = null;
  let enabledGroups = null;
  let enabledGroupsScopeLoaded = null;
  let storedEnabledGroupKeys = undefined;
  let selectedUid = null;
  let detailSlots = [];
  let auxDetailActive = false;
  let focusedDetailIndex = 0;
  let detailPaneUserCollapsed = false;
  let mapRefreshTimer = null;
  let uiTimer = null;
  let mapRefreshPending = false;
  let lastGeoMeta = { total: 0, visible: 0 };
  let layerFilterText = "";
  let layerListTimer = null;
  const labelVisibleByUid = new Map();
  let labelDeclutterKey = "";
  let pendingStyleLabelDeclutter = false;
  let labelDeclutterAfterStyleTimer = null;
  let lastMarkerRevision = 0;
  let lastLoadedMarkerRevision = 0;
  let appliedSnapshotRevision = null;
  let lastServerGeoJsonFull = null;
  let lastServerGeoJson = null;
  let serverGeoFetchInFlight = null;
  let lastGeoJsonFetchOk = false;
  let liveMarkersLoadGen = 0;
  const mapIconImageCache = new Map();
  const iconUidByMapImageId = new Map();
  const pendingMapAdds = new Map();
  const pendingMapUpdates = new Map();
  const pendingMapRemoves = new Set();
  let mapDiffTimer = null;
  let mapDiffFlushPending = false;
  const SERVER_GEO_DEBOUNCE_MS = 50;
  const MAP_DIFF_FLUSH_MS = 500;
  const VIEWPORT_PAD_RATIO = 0.55;
  const VIEWPORT_SYNC_DEBOUNCE_MS = 200;
  const LABEL_STREAM_DECLUTTER_MS = 1500;
  const GEO_RECONCILE_MS = 45000;
  /** Below this zoom, paint all in-view COTs as cheap team-color dots (no icons). */
  const OVERVIEW_MODE_ZOOM = 5;
  const ICON_DB_NAME = "tak-portal-map-icons";
  const ICON_DB_STORE = "icons";
  let iconDbPromise = null;
  let paddedViewportBounds = null;
  let viewportSourceUids = new Set();
  let viewportSyncTimer = null;
  let labelStreamDeclutterTimer = null;
  let geoReconcileTimer = null;
  let pendingLabelStreamDeclutter = false;
  let overviewMode = false;
  let lastGeoFetchKey = "";

  function getPaddedViewportBounds() {
    if (!map) return null;
    try {
      const b = map.getBounds();
      if (!b) return null;
      const west = b.getWest();
      const east = b.getEast();
      const south = b.getSouth();
      const north = b.getNorth();
      const latSpan = Math.max(0.0001, north - south);
      const lonSpan = Math.max(0.0001, east - west);
      const latPad = latSpan * VIEWPORT_PAD_RATIO;
      const lonPad = lonSpan * VIEWPORT_PAD_RATIO;
      return {
        west: west - lonPad,
        south: Math.max(-90, south - latPad),
        east: east + lonPad,
        north: Math.min(90, north + latPad),
      };
    } catch (_) {
      return null;
    }
  }

  function refreshPaddedViewportBounds() {
    paddedViewportBounds = getPaddedViewportBounds();
    return paddedViewportBounds;
  }

  function expandBounds(bounds, factor) {
    if (!bounds) return null;
    const f = Number(factor) > 0 ? Number(factor) : 1;
    const latMid = (bounds.south + bounds.north) / 2;
    const lonMid = (bounds.west + bounds.east) / 2;
    const latHalf = ((bounds.north - bounds.south) / 2) * f;
    const lonHalf = ((bounds.east - bounds.west) / 2) * f;
    return {
      west: lonMid - lonHalf,
      south: Math.max(-90, latMid - latHalf),
      east: lonMid + lonHalf,
      north: Math.min(90, latMid + latHalf),
    };
  }

  function formatBoundsQuery(bounds) {
    if (!bounds) return "";
    return [bounds.west, bounds.south, bounds.east, bounds.north]
      .map(function (n) {
        return Number(n).toFixed(5);
      })
      .join(",");
  }

  function isPriorityMapUid(uid) {
    const id = uid != null ? String(uid) : "";
    return !!(id && (id === selectedUid || id === lockedUid));
  }

  function lonLatInBounds(lon, lat, bounds) {
    if (!bounds) return true;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    if (lat < bounds.south || lat > bounds.north) return false;
    if (bounds.west <= bounds.east) {
      return lon >= bounds.west && lon <= bounds.east;
    }
    return lon >= bounds.west || lon <= bounds.east;
  }

  function markerInPaddedViewport(m, bounds) {
    if (!m) return false;
    if (isPriorityMapUid(m.uid)) return true;
    return lonLatInBounds(
      Number(m.lon),
      Number(m.lat),
      bounds || paddedViewportBounds
    );
  }

  function featureInPaddedViewport(feature, bounds) {
    const uid = feature && feature.properties && feature.properties.uid;
    if (isPriorityMapUid(uid)) return true;
    const coords =
      feature && feature.geometry && feature.geometry.coordinates;
    if (!coords) return false;
    return lonLatInBounds(
      Number(coords[0]),
      Number(coords[1]),
      bounds || paddedViewportBounds
    );
  }

  function sourceHasUid(uid) {
    return viewportSourceUids.has(String(uid));
  }

  function upsertCanonicalFeature(feature) {
    if (!feature || !feature.properties || !feature.properties.uid) return;
    const uid = String(feature.properties.uid);
    if (!lastServerGeoJsonFull || !Array.isArray(lastServerGeoJsonFull.features)) {
      lastServerGeoJsonFull = {
        type: "FeatureCollection",
        features: [feature],
        meta: lastServerGeoJsonFull && lastServerGeoJsonFull.meta
          ? lastServerGeoJsonFull.meta
          : {},
      };
      return;
    }
    let found = false;
    const features = lastServerGeoJsonFull.features.map(function (existing) {
      const existingUid =
        existing && existing.properties && existing.properties.uid;
      if (String(existingUid) !== uid) return existing;
      found = true;
      return feature;
    });
    if (!found) features.push(feature);
    lastServerGeoJsonFull = Object.assign({}, lastServerGeoJsonFull, {
      features: features,
    });
  }

  function pruneCanonicalFeaturesOutside(bounds) {
    if (
      !bounds ||
      !lastServerGeoJsonFull ||
      !Array.isArray(lastServerGeoJsonFull.features)
    ) {
      return;
    }
    const next = lastServerGeoJsonFull.features.filter(function (feature) {
      const uid = feature && feature.properties && feature.properties.uid;
      if (isPriorityMapUid(uid)) return true;
      return featureInPaddedViewport(feature, bounds);
    });
    if (next.length === lastServerGeoJsonFull.features.length) return;
    lastServerGeoJsonFull = Object.assign({}, lastServerGeoJsonFull, {
      features: next,
    });
  }

  function normalizeMapImageId(mapImageId) {
    const id = String(mapImageId || "").trim();
    if (!id) return "";
    if (id.startsWith("mimg-")) return id;
    const match = /^(?:wing|rotor|vehicle|boat|ship|track|car|mimg)-([0-9a-f]{16})$/i.exec(id);
    if (match) return "mimg-" + match[1].toLowerCase();
    return id;
  }

  function isRenderedMapImageId(mapImageId) {
    const id = String(mapImageId || "");
    return /^(?:mimg|wing|rotor|vehicle|boat|ship|track|car)-[0-9a-f]{16}$/i.test(id);
  }

  function shouldSuppressLiveMarkerGraphic(uid) {
    const id = uid != null ? String(uid) : "";
    if (!id) return false;
    const missionMarker = missionMarkersByUid.get(id);
    if (!missionMarker || !missionMarker.missionName) return false;
    if (
      window.TakMapMissions &&
      typeof window.TakMapMissions.isMarkerSearchable === "function"
    ) {
      return window.TakMapMissions.isMarkerSearchable(id, missionMarker.missionName);
    }
    return false;
  }

  function refreshLiveMarkersForMissionOverlay() {
    if (!markerLayersReady || !lastServerGeoJsonFull) return;
    applyLocalChannelFilter();
  }

  function markerIconDisplayProps(props) {
    const uid = props && props.uid ? String(props.uid) : "";
    if (uid && shouldSuppressLiveMarkerGraphic(uid)) {
      return { iconId: "", showCircle: 0 };
    }
    if (overviewMode) {
      return { iconId: "", showCircle: 1 };
    }
    const iconId = props && props.iconId ? normalizeMapImageId(props.iconId) : "";
    const showCircle =
      props && props.showCircle != null ? (props.showCircle ? 1 : 0) : iconId ? 0 : 1;
    return { iconId: iconId, showCircle: showCircle };
  }

  function markerCircleOpacityPaint() {
    return ["case", ["==", ["get", "showCircle"], 1], 1, 0];
  }

  function markerIconOpacityPaint() {
    return ["case", ["!=", ["get", "iconId"], ""], 1, 0];
  }

  function rebuildIconUidIndex(features) {
    iconUidByMapImageId.clear();
    for (let i = 0; i < (features || []).length; i++) {
      const props = features[i] && features[i].properties;
      if (!props || !props.uid || !props.iconId) continue;
      const mapImageId = String(props.iconId);
      let uids = iconUidByMapImageId.get(mapImageId);
      if (!uids) {
        uids = new Set();
        iconUidByMapImageId.set(mapImageId, uids);
      }
      uids.add(String(props.uid));
    }
  }

  function patchShowCircleInCache(uids, showCircle) {
    if (!lastServerGeoJson || !Array.isArray(lastServerGeoJson.features)) return;
    const uidSet = new Set(uids.map(String));
    let changed = false;
    const features = lastServerGeoJson.features.map(function (feature) {
      const uid = feature && feature.properties && feature.properties.uid;
      if (!uid || !uidSet.has(String(uid))) return feature;
      if (feature.properties.showCircle === showCircle) return feature;
      changed = true;
      return {
        type: feature.type,
        geometry: feature.geometry,
        properties: Object.assign({}, feature.properties, { showCircle: showCircle }),
      };
    });
    if (changed) {
      lastServerGeoJson = Object.assign({}, lastServerGeoJson, { features: features });
    }
  }

  /** Stable numeric MapLibre feature id (must match worker vectorId / featureBuild). */
  function markerFeatureId(uid) {
    const s = String(uid || "");
    if (!s) return 1;
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0 || 1;
  }

  function hideCirclesForMapImage(mapImageId) {
    if (!map || !mapImageId) return;
    const uids = iconUidByMapImageId.get(String(mapImageId));
    if (!uids || !uids.size) return;
    const uidList = Array.from(uids);
    patchShowCircleInCache(uidList, 0);
    const src = map.getSource(SOURCE_ID);
    if (!src || typeof src.updateData !== "function") {
      triggerMarkerRepaint();
      return;
    }
    const updates = uidList.map(function (uid) {
      return {
        id: markerFeatureId(uid),
        addOrUpdateProperties: [{ key: "showCircle", value: 0 }],
      };
    });
    try {
      src.updateData({ update: updates });
    } catch (_) {}
    triggerMarkerRepaint();
  }

  function canonicalFeatureHasUid(uid) {
    if (!lastServerGeoJsonFull || !Array.isArray(lastServerGeoJsonFull.features)) {
      return false;
    }
    for (let i = 0; i < lastServerGeoJsonFull.features.length; i++) {
      const featureUid =
        lastServerGeoJsonFull.features[i] &&
        lastServerGeoJsonFull.features[i].properties &&
        lastServerGeoJsonFull.features[i].properties.uid;
      if (String(featureUid) === String(uid)) return true;
    }
    return false;
  }

  function buildMapFeatureFromMarker(m) {
    if (!m || !m.uid) return null;
    const lat = Number(m.lat);
    const lon = Number(m.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const mapImageId = normalizeMapImageId(
      m.mapImageId || (isRenderedMapImageId(m.iconId) ? m.iconId : "")
    );
    const apiIconId = mapImageId ? String(m.iconId || "") : "";
    const color = m.color || m.teamColor || "#1e88e5";
    const uid = String(m.uid);
    if (shouldSuppressLiveMarkerGraphic(uid)) return null;
    if (
      window.TakMapMissions &&
      typeof window.TakMapMissions.isShapeDecorMarker === "function" &&
      window.TakMapMissions.isShapeDecorMarker(lon, lat, {
        type: m.type || "",
        how: m.how || "",
        icon: m.iconsetpath || "",
        iconsetpath: m.iconsetpath || "",
      })
    ) {
      return null;
    }
    if (mapImageId) {
      registerServerMapImageMeta(mapImageId, apiIconId, m);
    }
    const displayIconId = overviewMode ? "" : mapImageId;
    const displayShowCircle = overviewMode
      ? 1
      : m.showCircle != null
        ? m.showCircle
          ? 1
          : 0
        : mapImageId
          ? 0
          : 1;
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: {
        kind: "marker",
        uid: uid,
        callsign: m.callsign || uid.slice(0, 16),
        type: m.type || "",
        affiliation: m.affiliation || "other",
        color: color,
        iconId: displayIconId,
        apiIconId: apiIconId,
        iconSource: m.iconSource || "",
        origin: m.origin || "",
        showCircle: displayShowCircle,
        usesMapIcon:
          m.usesMapIcon != null ? (m.usesMapIcon ? 1 : 0) : mapImageId ? 1 : 0,
        drawTier: 0,
        selected: uid === selectedUid,
        locked: uid === lockedUid,
        renderSort: 0,
        labelSort: 0,
        showLabel: featureShowLabelValue(uid, m),
        channelKeys: m.channelKeys || "",
      },
    };
  }

  function applyDiffToLocalGeoJson(diff) {
    if (!lastServerGeoJson || !Array.isArray(lastServerGeoJson.features)) return;
    let features = lastServerGeoJson.features.slice();
    if (diff.remove && diff.remove.length) {
      const removeSet = new Set(diff.remove.map(String));
      features = features.filter(function (feature) {
        return !removeSet.has(
          String(feature && feature.properties && feature.properties.uid)
        );
      });
    }
    if (diff.add && diff.add.length) {
      const byUid = new Map();
      for (let i = 0; i < features.length; i++) {
        const uid = features[i] && features[i].properties && features[i].properties.uid;
        if (uid) byUid.set(String(uid), features[i]);
      }
      for (let i = 0; i < diff.add.length; i++) {
        const feature = diff.add[i];
        const uid = feature && feature.properties && feature.properties.uid;
        if (uid) byUid.set(String(uid), feature);
      }
      features = Array.from(byUid.values());
    }
    if (diff.update && diff.update.length) {
      const byUid = new Map();
      for (let i = 0; i < features.length; i++) {
        const uid = features[i] && features[i].properties && features[i].properties.uid;
        if (uid) byUid.set(String(uid), features[i]);
      }
      for (let i = 0; i < diff.update.length; i++) {
        const entry = diff.update[i];
        const uid = String(entry.id);
        const existing = byUid.get(uid);
        if (!existing) continue;
        const props = Object.assign({}, existing.properties);
        if (entry.addOrUpdateProperties) {
          for (let j = 0; j < entry.addOrUpdateProperties.length; j++) {
            const pair = entry.addOrUpdateProperties[j];
            props[pair.key] = pair.value;
          }
        }
        byUid.set(uid, {
          type: existing.type,
          geometry: entry.newGeometry || existing.geometry,
          properties: props,
        });
      }
      features = Array.from(byUid.values());
    }
    lastServerGeoJson = Object.assign({}, lastServerGeoJson, { features: features });
    rebuildIconUidIndex(features);
  }

  function scheduleMapDiffFlush() {
    if (mapDiffTimer) return;
    if (!map || !markerLayersReady || !lastServerGeoJson) {
      mapDiffFlushPending = true;
      return;
    }
    mapDiffTimer = setTimeout(flushMapDiff, MAP_DIFF_FLUSH_MS);
  }

  function flushMapDiff() {
    mapDiffTimer = null;
    mapDiffFlushPending = false;
    if (!map || !markerLayersReady || !lastServerGeoJson) return;
    const src = map.getSource(SOURCE_ID);
    if (!src) return;

    if (!pendingMapAdds.size && !pendingMapUpdates.size && !pendingMapRemoves.size) {
      return;
    }

    if (pendingMapUpdates.size || pendingMapAdds.size) {
      scheduleLabelStreamDeclutter();
    }

    const diff = { add: [], remove: [], update: [] };
    pendingMapRemoves.forEach(function (uid) {
      diff.remove.push(uid);
      pendingMapAdds.delete(uid);
      pendingMapUpdates.delete(uid);
      viewportSourceUids.delete(String(uid));
    });

    pendingMapAdds.forEach(function (_feature, uid) {
      if (pendingMapRemoves.has(uid)) return;
      const marker = markersByUid.get(uid);
      const feature = marker ? buildMapFeatureFromMarker(marker) : _feature;
      if (feature) {
        diff.add.push(feature);
        upsertCanonicalFeature(feature);
        viewportSourceUids.add(String(uid));
      }
    });

    pendingMapUpdates.forEach(function (marker, uid) {
      if (pendingMapRemoves.has(uid) || pendingMapAdds.has(uid)) return;
      const lat = Number(marker.lat);
      const lon = Number(marker.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      diff.update.push({
        id: uid,
        newGeometry: { type: "Point", coordinates: [lon, lat] },
        addOrUpdateProperties: [
          { key: "selected", value: uid === selectedUid },
          { key: "locked", value: uid === lockedUid },
          { key: "showLabel", value: featureShowLabelValue(uid, marker) },
        ],
      });
    });

    pendingMapAdds.clear();
    pendingMapUpdates.clear();
    pendingMapRemoves.clear();

    if (!diff.add.length && !diff.remove.length && !diff.update.length) return;

    applyDiffToLocalGeoJson(diff);
    updateChannelVisibleMeta();

    if (typeof src.updateData === "function") {
      try {
        src.updateData(diff);
        return;
      } catch (err) {
        console.warn("[map] updateData failed, falling back to setData", err);
      }
    }
    src.setData({ type: "FeatureCollection", features: lastServerGeoJson.features });
  }

  function scheduleLabelStreamDeclutter() {
    pendingLabelStreamDeclutter = true;
    if (labelStreamDeclutterTimer) return;
    labelStreamDeclutterTimer = setTimeout(function () {
      labelStreamDeclutterTimer = null;
      if (!pendingLabelStreamDeclutter) return;
      pendingLabelStreamDeclutter = false;
      applyClientLabelDeclutterToSource({ forceRecompute: true });
    }, LABEL_STREAM_DECLUTTER_MS);
  }

  function queueMapDiffFromBatch(updates, removes) {
    if (!paddedViewportBounds) refreshPaddedViewportBounds();
    const bounds = paddedViewportBounds;

    for (let i = 0; i < (removes || []).length; i++) {
      const uid = String(removes[i]);
      if (sourceHasUid(uid) || pendingMapAdds.has(uid)) {
        pendingMapRemoves.add(uid);
      }
      pendingMapAdds.delete(uid);
      pendingMapUpdates.delete(uid);
    }
    for (let i = 0; i < (updates || []).length; i++) {
      const m = updates[i];
      if (!m || !m.uid) continue;
      const uid = String(m.uid);
      if (pendingMapRemoves.has(uid) && !markerInPaddedViewport(m, bounds)) {
        continue;
      }
      const inView = markerInPaddedViewport(m, bounds);
      if (!inView) {
        if (sourceHasUid(uid) || pendingMapAdds.has(uid)) {
          pendingMapRemoves.add(uid);
          pendingMapAdds.delete(uid);
          pendingMapUpdates.delete(uid);
        }
        continue;
      }
      pendingMapRemoves.delete(uid);
      if (sourceHasUid(uid)) {
        pendingMapUpdates.set(uid, m);
      } else {
        const feature = buildMapFeatureFromMarker(m);
        if (feature) pendingMapAdds.set(uid, feature);
      }
    }
    scheduleMapDiffFlush();
  }

  function openIconDb() {
    if (iconDbPromise) return iconDbPromise;
    iconDbPromise = new Promise(function (resolve, reject) {
      if (!("indexedDB" in window)) {
        resolve(null);
        return;
      }
      const req = indexedDB.open(ICON_DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(ICON_DB_STORE);
      };
      req.onsuccess = function () {
        resolve(req.result);
      };
      req.onerror = function () {
        iconDbPromise = null;
        reject(req.error);
      };
    });
    return iconDbPromise;
  }

  function readIconCache(mapImageId) {
    return openIconDb()
      .then(function (db) {
        if (!db) return null;
        return new Promise(function (resolve, reject) {
          const tx = db.transaction(ICON_DB_STORE, "readonly");
          const req = tx.objectStore(ICON_DB_STORE).get(String(mapImageId));
          req.onsuccess = function () {
            resolve(req.result || null);
          };
          req.onerror = function () {
            reject(req.error);
          };
        });
      })
      .catch(function () {
        return null;
      });
  }

  function writeIconCache(mapImageId, blob) {
    return openIconDb()
      .then(function (db) {
        if (!db || !blob) return;
        return new Promise(function (resolve, reject) {
          const tx = db.transaction(ICON_DB_STORE, "readwrite");
          tx.objectStore(ICON_DB_STORE).put(blob, String(mapImageId));
          tx.oncomplete = function () {
            resolve();
          };
          tx.onerror = function () {
            reject(tx.error);
          };
        });
      })
      .catch(function () {});
  }

  function channelKeyInFeature(channelKeysCsv, key) {
    if (!key) return false;
    return ("," + String(channelKeysCsv || "") + ",").indexOf("," + key + ",") >= 0;
  }

  function featureMatchesChannelKeys(feature) {
    const props = feature && feature.properties;
    if (!props) return false;
    const channelKeys = String(props.channelKeys || "");
    if (mapChannelScope === "member" && allowedMemberChannelKeys) {
      if (!allowedMemberChannelKeys.size) return false;
      let allowed = false;
      for (const key of allowedMemberChannelKeys) {
        if (channelKeyInFeature(channelKeys, key)) {
          allowed = true;
          break;
        }
      }
      if (!allowed) return false;
    }
    const enabledKeys = enabledChannelKeysForFilter();
    if (enabledKeys === null) return true;
    if (!enabledKeys.size) return false;
    for (const key of enabledKeys) {
      if (channelKeyInFeature(channelKeys, key)) return true;
    }
    return false;
  }

  function applyLoadedIconCircles() {
    if (!map) return;
    iconUidByMapImageId.forEach(function (uids, mapImageId) {
      if (map.hasImage(mapImageId)) hideCirclesForMapImage(mapImageId);
    });
  }

  function applyMapChannelScope(scope, allowedKeys) {
    mapChannelScope = scope === "member" ? "member" : "all";
    if (mapChannelScope === "member" && Array.isArray(allowedKeys)) {
      allowedMemberChannelKeys = new Set(
        allowedKeys.map(function (k) {
          return String(k || "").trim().toLowerCase();
        }).filter(Boolean)
      );
    } else {
      allowedMemberChannelKeys = null;
    }
    if (mapChannelScope === "member") {
      pruneGroupsCatalogToChannelScope();
    }
    reloadEnabledGroupsForScope();
  }

  function groupsStorageKey(scope) {
    const scopeKey = scope === "member" ? "member" : "all";
    return LS_GROUPS_PREFIX + ":" + MAP_USER_KEY + ":" + scopeKey;
  }

  function readStoredEnabledGroups(scope) {
    try {
      let raw = localStorage.getItem(groupsStorageKey(scope));
      if (raw === null && scope === "all") {
        raw = localStorage.getItem(LS_GROUPS_LEGACY);
      }
      if (raw === null) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.v === 2 && Array.isArray(parsed.keys)) {
        return parsed.keys.length ? new Set(parsed.keys) : new Set();
      }
      if (Array.isArray(parsed)) {
        return parsed.length ? new Set(parsed) : new Set();
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  function reloadEnabledGroupsForScope() {
    const scope = mapChannelScope === "member" ? "member" : "all";
    if (enabledGroupsScopeLoaded === scope) return;
    enabledGroupsScopeLoaded = scope;
    storedEnabledGroupKeys = readStoredEnabledGroups(scope);
    syncEnabledGroupsFromStorage();
  }

  function syncEnabledGroupsFromStorage() {
    if (storedEnabledGroupKeys === undefined) return;
    if (storedEnabledGroupKeys === null) {
      enabledGroups = null;
      return;
    }
    enabledGroups = normalizeEnabledGroups(storedEnabledGroupKeys);
  }

  function isMemberChannelKeyAllowed(key) {
    if (mapChannelScope !== "member" || !allowedMemberChannelKeys) return true;
    const k = String(key || "").trim().toLowerCase();
    return k && allowedMemberChannelKeys.has(k);
  }

  function isGroupInChannelScope(g) {
    if (!g || !isMapChannelName(g.name)) return false;
    if (mapChannelScope !== "member" || !allowedMemberChannelKeys) return true;
    const key = channelGroupKey(g.name);
    return isMemberChannelKeyAllowed(key);
  }

  function pruneGroupsCatalogToChannelScope() {
    if (mapChannelScope !== "member" || !allowedMemberChannelKeys) return;
    groupsCatalog = groupsCatalog.filter(isGroupInChannelScope);
  }

  function normalizeMarkerRecord(m) {
    if (!m || !m.uid) return null;
    const lon = Number(m.lon);
    const lat = Number(m.lat);
    return {
      ...m,
      uid: String(m.uid),
      lon: Number.isFinite(lon) ? lon : m.lon,
      lat: Number.isFinite(lat) ? lat : m.lat,
    };
  }

  function getMarkerRecord(uid) {
    const id = uid != null ? String(uid) : "";
    if (!id) return null;
    return markersByUid.get(id) || missionMarkersByUid.get(id) || null;
  }

  function registerMissionMarkers(missionName, markers) {
    const name = String(missionName || "").trim();
    for (const [uid, marker] of missionMarkersByUid) {
      if (marker && marker.missionName === name) missionMarkersByUid.delete(uid);
    }
    const list = Array.isArray(markers) ? markers : [];
    for (let i = 0; i < list.length; i++) {
      const normalized = normalizeMarkerRecord(list[i]);
      if (!normalized) continue;
      const mapImageId = normalizeMapImageId(normalized.mapImageId || "");
      if (mapImageId) {
        registerServerMapImageMeta(mapImageId, String(normalized.iconId || ""), normalized);
      }
      missionMarkersByUid.set(normalized.uid, normalized);
    }
    refreshLiveMarkersForMissionOverlay();
  }

  function clearMissionMarkers(missionName) {
    const name = String(missionName || "").trim();
    for (const [uid, marker] of missionMarkersByUid) {
      if (marker && marker.missionName === name) missionMarkersByUid.delete(uid);
    }
    refreshLiveMarkersForMissionOverlay();
  }

  function queryMissionMarkersAtPoint(point, radiusPx) {
    return queryMarkersAtPoint(point, radiusPx);
  }

  function getVisibleMissionMarkers() {
    const out = [];
    const isSearchable =
      window.TakMapMissions &&
      typeof window.TakMapMissions.isMarkerSearchable === "function"
        ? window.TakMapMissions.isMarkerSearchable.bind(window.TakMapMissions)
        : null;
    if (!isSearchable) return out;
    for (const m of missionMarkersByUid.values()) {
      if (!m || !m.uid) continue;
      if (!isSearchable(m.uid, m.missionName)) continue;
      out.push(m);
    }
    return out;
  }

  function markerCoords(m) {
    const lon = Number(m && m.lon);
    const lat = Number(m && m.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    return { lon, lat };
  }

  /** Higher rank = draw above data feeds (EUD on top). */
  function markerOriginRank(m) {
    const origin = String(m?.origin || "").toLowerCase();
    if (origin === "eud" || origin === "federation" || origin === "spi") return 2;
    if (origin === "feed") return 0;
    if (origin === "unknown") return 1;
    const type = String(m?.type || "");
    if (/^b-m-p-s-p-/i.test(type)) return 2;
    if (/^a-f-G-/i.test(type)) return 2;
    if (/^a-[fnhu]-A-/i.test(type)) return 0;
    if (/^a-f-[GUS]-/i.test(type)) return 2;
    return 1;
  }

  function markerRenderSort(m) {
    return (
      markerOriginRank(m) * 100 +
      (m.uid === selectedUid ? 50 : m.uid === lockedUid ? 25 : 0)
    );
  }

  /** 0 = feed/unknown (draw below), 1 = live EUD (draw above feeds). */
  function markerDrawTier(m) {
    return markerOriginRank(m) >= 2 ? 1 : 0;
  }

  function markerHitLayers() {
    return MARKER_HIT_LAYER_IDS.filter(function (id) {
      return map.getLayer(id);
    });
  }

  function triggerMarkerRepaint() {
    if (!map) return;
    map.triggerRepaint();
  }

  function markerLabelDeclutterPriority(m) {
    if (m.uid === selectedUid) return 0;
    if (m.uid === lockedUid) return 1;
    const origin = String((m && m.origin) || "").toLowerCase();
    if (origin === "spi") return 2;
    // Keep EUD and live feed/AVL at the same tier so dense car layers label evenly.
    if (
      origin === "eud" ||
      origin === "user" ||
      origin === "federation" ||
      origin === "feed"
    ) {
      return 3;
    }
    if (markerOriginRank(m) === 2) return 3;
    if (markerOriginRank(m) === 1) return 4;
    return 5;
  }

  function isMarkerExpiredAtIngest(m) {
    if (!m || !m.stale) return false;
    const t = Date.parse(m.stale);
    return Number.isFinite(t) && Date.now() > t + STALE_GRACE_MS;
  }

  function storeMarker(m) {
    const normalized = normalizeMarkerRecord(m);
    if (!normalized) return;
    if (isMarkerExpiredAtIngest(normalized)) return;
    markersByUid.set(String(normalized.uid), normalized);
  }

  function channelBaseKeyForName(name) {
    const key = channelGroupKey(name);
    if (!key) return "";
    const match = groupsCatalog.find((g) => {
      if (g.baseKey && g.baseKey === key) return true;
      return channelGroupKey(g.name) === key;
    });
    return match && match.baseKey ? match.baseKey : key;
  }

  function enabledChannelKeysForFilter() {
    if (enabledGroups === null) return null;
    if (enabledGroups.size === 0) return new Set();
    const keys = new Set();
    for (const name of enabledGroups) {
      const key = channelBaseKeyForName(name);
      if (key) keys.add(key);
    }
    return keys;
  }

  function buildGeoJsonChannelParam() {
    const keys = enabledChannelKeysForFilter();
    if (keys === null) return "";
    if (keys.size === 0) return "__none__";
    return Array.from(keys)
      .map(function (k) {
        return encodeURIComponent(k);
      })
      .join(",");
  }

  function buildGeoJsonScopeParam() {
    if (mapChannelScope !== "member" || !allowedMemberChannelKeys) return "";
    return Array.from(allowedMemberChannelKeys)
      .map(function (k) {
        return encodeURIComponent(k);
      })
      .join(",");
  }

  function buildGeoJsonFetchQueryString() {
    const parts = [];
    const scope = buildGeoJsonScopeParam();
    if (scope) parts.push("scopeKeys=" + scope);
    if (!paddedViewportBounds) refreshPaddedViewportBounds();
    if (paddedViewportBounds) {
      parts.push(
        "bounds=" + encodeURIComponent(formatBoundsQuery(paddedViewportBounds))
      );
    }
    if (map) {
      const zoom = map.getZoom();
      if (Number.isFinite(zoom)) {
        parts.push("zoom=" + encodeURIComponent(String(Math.round(zoom * 10) / 10)));
      }
    }
    if (selectedUid) parts.push("selected=" + encodeURIComponent(selectedUid));
    if (lockedUid) parts.push("locked=" + encodeURIComponent(lockedUid));
    return parts.join("&");
  }

  function buildGeoJsonQueryString() {
    const parts = [];
    const channels = buildGeoJsonChannelParam();
    if (channels !== "") parts.push("channels=" + channels);
    const scope = buildGeoJsonScopeParam();
    if (scope) parts.push("scopeKeys=" + scope);
    if (selectedUid) parts.push("selected=" + encodeURIComponent(selectedUid));
    if (lockedUid) parts.push("locked=" + encodeURIComponent(lockedUid));
    return parts.join("&");
  }

  function featureMatchesChannelFilter(feature) {
    const uid = feature && feature.properties && feature.properties.uid;
    if (!uid) return false;
    const marker = markersByUid.get(String(uid));
    if (marker) return markerVisible(marker);
    if (feature.properties && feature.properties.channelKeys) {
      return featureMatchesChannelKeys(feature);
    }
    return !isChannelFilterActive();
  }

  function enrichFeatureChannelKeys(feature) {
    if (!feature || !feature.properties) return feature;
    if (feature.properties.channelKeys) return feature;
    const uid = feature.properties.uid;
    const marker = uid ? markersByUid.get(String(uid)) : null;
    if (!marker) return feature;
    return {
      type: feature.type,
      geometry: feature.geometry,
      properties: Object.assign({}, feature.properties, {
        channelKeys: markerChannelKeys(marker).join(","),
      }),
    };
  }

  function channelKeyMatchExpr(key) {
    return [
      ">=",
      [
        "index-of",
        ["concat", ",", key, ","],
        ["concat", ",", ["coalesce", ["get", "channelKeys"], ""], ","],
      ],
      0,
    ];
  }

  function buildChannelKeySetFilterExpr(keySet) {
    if (!keySet || keySet.size === 0) return ["==", ["get", "kind"], ""];
    const keys = Array.from(keySet);
    if (keys.length === 1) return channelKeyMatchExpr(keys[0]);
    return ["any"].concat(keys.map(channelKeyMatchExpr));
  }

  function allScopedChannelsEnabled() {
    if (enabledGroups === null) return false;
    const scoped = groupsCatalog.filter(isGroupInChannelScope);
    if (!scoped.length) return enabledGroups.size === 0;
    for (let i = 0; i < scoped.length; i++) {
      if (!enabledGroups.has(scoped[i].name)) return false;
    }
    return true;
  }

  function buildChannelVisibilityFilterExpr() {
    const parts = [];
    if (mapChannelScope === "member" && allowedMemberChannelKeys) {
      parts.push(buildChannelKeySetFilterExpr(allowedMemberChannelKeys));
    }
    const enabledKeys = enabledChannelKeysForFilter();
    if (enabledKeys !== null) {
      if (enabledKeys.size === 0) {
        parts.push(["==", ["get", "kind"], ""]);
      } else if (!allScopedChannelsEnabled()) {
        parts.push(buildChannelKeySetFilterExpr(enabledKeys));
      }
    }
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    return ["all"].concat(parts);
  }

  function mergeMarkerLayerFilter(extraParts) {
    const channelExpr = buildChannelVisibilityFilterExpr();
    const parts = [MARKER_FILTER];
    if (channelExpr) parts.push(channelExpr);
    if (extraParts && extraParts.length) parts.push.apply(parts, extraParts);
    return ["all"].concat(parts);
  }

  function withChannelFilter(baseFilter) {
    const channelExpr = buildChannelVisibilityFilterExpr();
    if (!channelExpr) return baseFilter;
    return ["all", MARKER_FILTER, channelExpr].concat(baseFilter.slice(2));
  }

  function applyMapChannelLayerFilters() {
    if (!map || !markerLayersReady || !markerLayersComplete()) return false;
    try {
      map.setFilter(
        CIRCLE_LAYER_LOW,
        mergeMarkerLayerFilter([
          ["==", ["get", "showCircle"], 1],
          ["==", ["get", "drawTier"], 0],
        ])
      );
      map.setFilter(
        CIRCLE_LAYER_HIGH,
        mergeMarkerLayerFilter([
          ["==", ["get", "showCircle"], 1],
          ["==", ["get", "drawTier"], 1],
        ])
      );
      map.setFilter(
        ICON_LAYER_LOW,
        mergeMarkerLayerFilter([
          ["!=", ["get", "iconId"], ""],
          ["==", ["get", "drawTier"], 0],
        ])
      );
      map.setFilter(
        ICON_LAYER_HIGH,
        mergeMarkerLayerFilter([
          ["!=", ["get", "iconId"], ""],
          ["==", ["get", "drawTier"], 1],
        ])
      );
      map.setFilter(LABEL_LAYER, withChannelFilter(labelStandardFilter()));
      map.setFilter(LABEL_PRIORITY_LAYER, withChannelFilter(labelPriorityFilter()));
      applyLiveShapeChannelFilters();
      return true;
    } catch (err) {
      console.warn("[map] applyMapChannelLayerFilters failed", err);
      return false;
    }
  }

  function liveShapeChannelFilter() {
    const channelExpr = buildChannelVisibilityFilterExpr();
    if (!channelExpr) return null;
    return channelExpr;
  }

  function applyLiveShapeChannelFilters() {
    if (!map || !map.getLayer(LIVE_SHAPES_FILL_LAYER)) return;
    const channelExpr = liveShapeChannelFilter();
    const fillFilter = channelExpr
      ? ["all", ["==", ["geometry-type"], "Polygon"], channelExpr]
      : ["==", ["geometry-type"], "Polygon"];
    const lineFilter = channelExpr
      ? [
          "all",
          ["any", ["==", ["geometry-type"], "Polygon"], ["==", ["geometry-type"], "LineString"]],
          channelExpr,
        ]
      : ["any", ["==", ["geometry-type"], "Polygon"], ["==", ["geometry-type"], "LineString"]];
    try {
      map.setFilter(LIVE_SHAPES_FILL_LAYER, fillFilter);
      map.setFilter(LIVE_SHAPES_LINE_LAYER, lineFilter);
    } catch (_) {}
  }

  function liveShapesFeatureCollection() {
    return {
      type: "FeatureCollection",
      features: Array.from(liveShapesByUid.values()),
    };
  }

  function syncLiveShapesSource() {
    if (!map || typeof map.isStyleLoaded !== "function" || !map.isStyleLoaded()) {
      return;
    }
    ensureLiveShapeLayers();
    const src = map.getSource(LIVE_SHAPES_SOURCE_ID);
    if (src) src.setData(liveShapesFeatureCollection());
    applyLiveShapeChannelFilters();
  }

  function ensureLiveShapeLayers() {
    if (!map || typeof map.isStyleLoaded !== "function" || !map.isStyleLoaded()) {
      return;
    }
    const beforeId = map.getLayer(CIRCLE_LAYER_LOW) ? CIRCLE_LAYER_LOW : undefined;
    if (!map.getSource(LIVE_SHAPES_SOURCE_ID)) {
      map.addSource(LIVE_SHAPES_SOURCE_ID, {
        type: "geojson",
        data: liveShapesFeatureCollection(),
      });
    }
    if (!map.getLayer(LIVE_SHAPES_FILL_LAYER)) {
      map.addLayer(
        {
          id: LIVE_SHAPES_FILL_LAYER,
          type: "fill",
          source: LIVE_SHAPES_SOURCE_ID,
          filter: ["==", ["geometry-type"], "Polygon"],
          paint: {
            "fill-color": ["coalesce", ["get", "fill"], "#ffffff"],
            "fill-opacity": ["coalesce", ["get", "fill-opacity"], 0.1],
          },
        },
        beforeId
      );
    }
    if (!map.getLayer(LIVE_SHAPES_LINE_LAYER)) {
      map.addLayer(
        {
          id: LIVE_SHAPES_LINE_LAYER,
          type: "line",
          source: LIVE_SHAPES_SOURCE_ID,
          filter: [
            "any",
            ["==", ["geometry-type"], "Polygon"],
            ["==", ["geometry-type"], "LineString"],
          ],
          paint: {
            "line-color": ["coalesce", ["get", "stroke"], "#ffffff"],
            "line-width": ["coalesce", ["get", "stroke-width"], 2],
            "line-opacity": ["coalesce", ["get", "stroke-opacity"], 0.9],
          },
        },
        beforeId
      );
    }
  }

  function applyLiveShapesSnapshot(shapes) {
    liveShapesByUid.clear();
    const features = shapes && Array.isArray(shapes.features) ? shapes.features : [];
    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      const uid = String((f && f.properties && f.properties.uid) || f.id || "").trim();
      if (!uid || !f || !f.geometry) continue;
      liveShapesByUid.set(uid, f);
    }
    syncLiveShapesSource();
  }

  function applyLiveShapeBatch(shapeUpdates, shapeRemoves) {
    let changed = false;
    for (let i = 0; i < (shapeRemoves || []).length; i++) {
      const id = String(shapeRemoves[i] || "").trim();
      if (id && liveShapesByUid.delete(id)) changed = true;
    }
    for (let i = 0; i < (shapeUpdates || []).length; i++) {
      const f = shapeUpdates[i];
      const uid = String((f && f.properties && f.properties.uid) || f.id || "").trim();
      if (!uid || !f || !f.geometry) continue;
      liveShapesByUid.set(uid, f);
      changed = true;
    }
    if (changed) syncLiveShapesSource();
  }

  function countChannelVisibleFeatures() {
    let visible = 0;
    markersByUid.forEach(function (m) {
      if (markerVisible(m)) visible++;
    });
    return visible;
  }

  function updateChannelVisibleMeta() {
    const visible = countChannelVisibleFeatures();
    lastGeoMeta = {
      total:
        lastServerGeoJsonFull &&
        lastServerGeoJsonFull.meta &&
        lastServerGeoJsonFull.meta.total != null
          ? lastServerGeoJsonFull.meta.total
          : markersByUid.size,
      visible: visible,
      mapped: visible,
    };
    updateVisibleCounts();
  }

  function syncFullGeoJsonToMapSource(options) {
    if (!map || !markerLayersReady) return false;
    const src = map.getSource(SOURCE_ID);
    if (!src) return false;

    const opts = options || {};
    refreshPaddedViewportBounds();
    const bounds = paddedViewportBounds;

    const byUid = new Map();
    if (lastServerGeoJsonFull && Array.isArray(lastServerGeoJsonFull.features)) {
      for (let i = 0; i < lastServerGeoJsonFull.features.length; i++) {
        const feature = lastServerGeoJsonFull.features[i];
        const uid = feature && feature.properties && feature.properties.uid;
        if (uid) byUid.set(String(uid), feature);
      }
    }

    markersByUid.forEach(function (m) {
      if (!m || !m.uid) return;
      if (!markerVisible(m)) return;
      if (!markerInPaddedViewport(m, bounds)) return;
      const uid = String(m.uid);
      if (byUid.has(uid)) return;
      const built = buildMapFeatureFromMarker(m);
      if (built) byUid.set(uid, built);
    });

    [selectedUid, lockedUid].forEach(function (uid) {
      if (!uid) return;
      const id = String(uid);
      if (byUid.has(id)) return;
      const m = markersByUid.get(id);
      if (!m) return;
      const built = buildMapFeatureFromMarker(m);
      if (built) byUid.set(id, built);
    });

    if (!byUid.size && !lastServerGeoJsonFull) return false;

    const declutterMarkers = getViewportDeclutterMarkers();
    syncLabelVisibility(declutterMarkers, {
      forceRecompute: !!(opts.forceLabels || opts.forceRecompute),
    });

    const features = [];
    const nextSourceUids = new Set();
    byUid.forEach(function (feature, uid) {
      if (!isPriorityMapUid(uid) && !featureMatchesChannelFilter(feature)) return;
      if (!isPriorityMapUid(uid) && !featureInPaddedViewport(feature, bounds)) {
        return;
      }
      const display = buildDisplayFeature(feature);
      if (!display) return;
      features.push(display);
      nextSourceUids.add(String(uid));
    });

    viewportSourceUids = nextSourceUids;
    const baseMeta =
      (lastServerGeoJsonFull && lastServerGeoJsonFull.meta) || lastGeoMeta || {};
    lastServerGeoJson = {
      type: "FeatureCollection",
      features: features,
      meta: Object.assign({}, baseMeta, {
        visible: countChannelVisibleFeatures(),
        mapped: features.length,
      }),
    };
    if (!lastServerGeoJsonFull) {
      lastServerGeoJsonFull = {
        type: "FeatureCollection",
        features: Array.from(byUid.values()),
        meta: baseMeta,
      };
    } else {
      pruneCanonicalFeaturesOutside(expandBounds(bounds, 2));
    }

    src.setData({ type: "FeatureCollection", features: features });
    rebuildIconUidIndex(features);
    applyLoadedIconCircles();
    applyMapChannelLayerFilters();
    updateChannelVisibleMeta();
    scheduleMissingIconSweep();
    pendingMapAdds.clear();
    pendingMapUpdates.clear();
    pendingMapRemoves.clear();
    mapDiffFlushPending = false;
    if (mapDiffTimer) {
      clearTimeout(mapDiffTimer);
      mapDiffTimer = null;
    }
    if (!opts.deferLabels) {
      applyClientLabelDeclutterToSource(
        opts.forceLabels || opts.forceRecompute
          ? { forceRecompute: true }
          : undefined
      );
    }
    return true;
  }

  function applyLocalChannelFilter(options) {
    const opts = options || {};
    if (opts.layersOnly) {
      if (!applyMapChannelLayerFilters()) return false;
      updateChannelVisibleMeta();
      applyClientLabelDeclutterToSource(
        opts.forceLabels ? { forceRecompute: true } : undefined
      );
      return true;
    }
    return syncFullGeoJsonToMapSource(opts);
  }

  function registerServerMapImageMeta(mapImageId, apiIconId, markerProps) {
    if (!mapImageId) return;
    const canonicalId = normalizeMapImageId(mapImageId);
    const meta = {
      apiIconId: String(apiIconId || ""),
      mapImageId: canonicalId,
      iconSource: markerProps && markerProps.iconSource ? markerProps.iconSource : "",
      origin: markerProps && markerProps.origin ? markerProps.origin : "",
      type: markerProps && markerProps.type ? markerProps.type : "",
      affiliation: markerProps && markerProps.affiliation ? markerProps.affiliation : "",
      color: markerProps && markerProps.color ? markerProps.color : "",
      teamColor:
        markerProps && markerProps.teamColor != null && markerProps.teamColor !== ""
          ? markerProps.teamColor
          : "",
    };
    iconIdByMapImageId.set(canonicalId, meta);
    if (canonicalId !== String(mapImageId)) {
      iconIdByMapImageId.set(String(mapImageId), meta);
    }
  }

  function resolveIconMetaForImageId(mapImageId) {
    const rawId = String(mapImageId || "");
    const canonicalId = normalizeMapImageId(rawId);
    let info = iconIdByMapImageId.get(canonicalId) || iconIdByMapImageId.get(rawId);
    if (info && info.apiIconId) return info;

    if (lastServerGeoJson && Array.isArray(lastServerGeoJson.features)) {
      for (let i = 0; i < lastServerGeoJson.features.length; i++) {
        const props = lastServerGeoJson.features[i] && lastServerGeoJson.features[i].properties;
        if (!props || !props.iconId) continue;
        const featureIconId = normalizeMapImageId(props.iconId);
        if (featureIconId !== canonicalId && props.iconId !== rawId) continue;
        info = {
          apiIconId: props.apiIconId || "",
          mapImageId: canonicalId,
          iconSource: props.iconSource || "",
          origin: props.origin || "",
          type: props.type || "",
          affiliation: props.affiliation || "",
          color: props.color || "",
          teamColor: props.teamColor != null ? props.teamColor : "",
        };
        registerServerMapImageMeta(canonicalId, info.apiIconId, info);
        return info;
      }
    }

    for (const marker of markersByUid.values()) {
      const markerImageId = normalizeMapImageId(marker.mapImageId || "");
      if (markerImageId !== canonicalId) continue;
      info = {
        apiIconId: marker.iconId || "",
        mapImageId: canonicalId,
        iconSource: marker.iconSource || "",
        origin: marker.origin || "",
        type: marker.type || "",
        affiliation: marker.affiliation || "",
        color: marker.color || "",
        teamColor: marker.teamColor != null ? marker.teamColor : "",
      };
      registerServerMapImageMeta(canonicalId, info.apiIconId, marker);
      return info;
    }

    for (let i = 0; i < missionIconManifest.length; i++) {
      const entry = missionIconManifest[i];
      const entryId = normalizeMapImageId(entry.mapImageId || "");
      if (entryId !== canonicalId) continue;
      info = {
        apiIconId: entry.apiIconId || "",
        mapImageId: canonicalId,
        iconSource: entry.iconSource || "",
        origin: entry.origin || "mission",
        type: entry.type || "",
        affiliation: entry.affiliation || "",
        color: entry.color || "",
        teamColor: entry.teamColor != null ? entry.teamColor : "",
      };
      registerServerMapImageMeta(canonicalId, info.apiIconId, info);
      return info;
    }

    return info || null;
  }

  function registerMissionIconManifest(manifest) {
    const incoming = Array.isArray(manifest) ? manifest : [];
    const byId = new Map();
    for (let i = 0; i < missionIconManifest.length; i++) {
      const entry = missionIconManifest[i];
      const id = normalizeMapImageId(entry && entry.mapImageId);
      if (id) byId.set(id, entry);
    }
    for (let j = 0; j < incoming.length; j++) {
      const entry = incoming[j];
      const id = normalizeMapImageId(entry && entry.mapImageId);
      if (id) byId.set(id, entry);
    }
    missionIconManifest = Array.from(byId.values());
    for (let k = 0; k < missionIconManifest.length; k++) {
      const entry = missionIconManifest[k];
      registerServerMapImageMeta(entry.mapImageId, entry.apiIconId, entry);
    }
  }

  function loadRenderedMapIcon(mapImageId, apiIconId, markerProps) {
    if (!mapImageId) return Promise.resolve();
    const canonicalId = normalizeMapImageId(mapImageId);
    registerServerMapImageMeta(canonicalId, apiIconId, markerProps);
    if (map.hasImage(canonicalId)) {
      hideCirclesForMapImage(canonicalId);
      return Promise.resolve();
    }
    if (iconLoadPending.has(canonicalId)) return iconLoadPending.get(canonicalId);

    const cachedImage = mapIconImageCache.get(canonicalId);
    if (cachedImage) {
      const cachedPromise = installMapImage(canonicalId, cachedImage).then(function () {
        hideCirclesForMapImage(canonicalId);
        triggerMarkerRepaint();
      });
      iconLoadPending.set(canonicalId, cachedPromise);
      cachedPromise.finally(function () {
        iconLoadPending.delete(canonicalId);
      });
      return cachedPromise;
    }

    let url =
      "/api/map/icons/rendered?mapImageId=" + encodeURIComponent(canonicalId);
    const meta = iconIdByMapImageId.get(canonicalId);
    if (meta && meta.apiIconId) {
      url += "&apiIconId=" + encodeURIComponent(meta.apiIconId);
      if (meta.teamColor) url += "&teamColor=" + encodeURIComponent(meta.teamColor);
      if (meta.iconSource) url += "&iconSource=" + encodeURIComponent(meta.iconSource);
      if (meta.origin) url += "&origin=" + encodeURIComponent(meta.origin);
      if (meta.type) url += "&type=" + encodeURIComponent(meta.type);
      if (meta.affiliation) {
        url += "&affiliation=" + encodeURIComponent(meta.affiliation);
      }
    } else if (apiIconId) {
      url += "&apiIconId=" + encodeURIComponent(apiIconId);
    }

    const promise = readIconCache(canonicalId)
      .then(function (cachedBlob) {
        if (cachedBlob) return cachedBlob;
        return fetch(url).then(function (resp) {
          if (!resp.ok) throw new Error("rendered icon " + resp.status);
          return resp.blob();
        });
      })
      .then(function (blob) {
        void writeIconCache(canonicalId, blob);
        return decodeIconBlob(blob);
      })
      .then(function (image) {
        mapIconImageCache.set(canonicalId, image);
        return installMapImage(canonicalId, image);
      })
      .then(function () {
        hideCirclesForMapImage(canonicalId);
        triggerMarkerRepaint();
      })
      .catch(function (err) {
        console.warn("Failed to load rendered map icon", {
          mapImageId: canonicalId,
          err: err,
        });
      })
      .finally(function () {
        iconLoadPending.delete(canonicalId);
      });

    iconLoadPending.set(canonicalId, promise);
    return promise;
  }

  function applyServerGeoJsonToMap(geojson) {
    if (!geojson || !Array.isArray(geojson.features)) return false;
    if (geojson.meta && geojson.meta.revision != null) {
      lastMarkerRevision = Number(geojson.meta.revision) || lastMarkerRevision;
    }

    const features = geojson.features;
    for (let i = 0; i < features.length; i++) {
      const props = features[i] && features[i].properties;
      if (props && props.iconId) {
        registerServerMapImageMeta(props.iconId, props.apiIconId, props);
      }
    }

    preloadMarkerIcons(geojson.meta && geojson.meta.iconManifest);

    const byUid = new Map();
    if (lastServerGeoJsonFull && Array.isArray(lastServerGeoJsonFull.features)) {
      for (let i = 0; i < lastServerGeoJsonFull.features.length; i++) {
        const feature = lastServerGeoJsonFull.features[i];
        const uid = feature && feature.properties && feature.properties.uid;
        if (uid) byUid.set(String(uid), feature);
      }
    }
    for (let i = 0; i < features.length; i++) {
      const feature = features[i];
      const uid = feature && feature.properties && feature.properties.uid;
      if (uid) byUid.set(String(uid), feature);
    }

    refreshPaddedViewportBounds();
    const pruneBounds = expandBounds(paddedViewportBounds, 2);
    if (pruneBounds) {
      byUid.forEach(function (feature, uid) {
        if (isPriorityMapUid(uid)) return;
        if (!featureInPaddedViewport(feature, pruneBounds)) {
          byUid.delete(uid);
        }
      });
    }

    lastServerGeoJsonFull = {
      type: "FeatureCollection",
      features: Array.from(byUid.values()),
      meta: Object.assign({}, geojson.meta || {}, {
        total:
          geojson.meta && geojson.meta.total != null
            ? geojson.meta.total
            : markersByUid.size,
      }),
    };
    return applyLocalChannelFilter();
  }

  function applyClientLabelDeclutterToSource(options) {
    if (!map || !markerLayersReady || !lastServerGeoJson) return false;
    const src = map.getSource(SOURCE_ID);
    if (!src || !Array.isArray(lastServerGeoJson.features)) return false;

    const opts = options && typeof options === "object" ? options : {};
    const forceRecompute = !!opts.forceRecompute || pendingStyleLabelDeclutter;
    const visible = getViewportDeclutterMarkers();
    syncLabelVisibility(visible, { forceRecompute: forceRecompute });

    const updates = [];
    const patched = lastServerGeoJson.features.map(function (feature) {
      if (!feature || !feature.properties) return feature;
      const uid = feature.properties.uid;
      const marker = uid ? markersByUid.get(uid) : null;
      const showLabel = featureShowLabelValue(uid, marker);
      if (feature.properties.showLabel === showLabel) return feature;
      if (uid && typeof src.updateData === "function") {
        updates.push({
          id: String(uid),
          addOrUpdateProperties: [{ key: "showLabel", value: showLabel }],
        });
      }
      return {
        type: feature.type,
        geometry: feature.geometry,
        properties: Object.assign({}, feature.properties, { showLabel: showLabel }),
      };
    });

    const changed = updates.length > 0 || patched.some(function (feature, i) {
      return feature !== lastServerGeoJson.features[i];
    });
    if (!changed) return true;

    lastServerGeoJson = Object.assign({}, lastServerGeoJson, { features: patched });
    if (updates.length && typeof src.updateData === "function") {
      try {
        src.updateData({ update: updates });
        return true;
      } catch (_) {}
    }
    src.setData({ type: "FeatureCollection", features: patched });
    return true;
  }

  function schedulePostStyleLabelDeclutter() {
    pendingStyleLabelDeclutter = true;
    labelDeclutterKey = "";

    function runDeclutter(force) {
      if (!map || !markerLayersReady) return;
      applyClientLabelDeclutterToSource({ forceRecompute: !!force });
      if (
        window.TakMapMissions &&
        typeof window.TakMapMissions.applyLabelDeclutter === "function"
      ) {
        window.TakMapMissions.applyLabelDeclutter({ forceRecompute: !!force });
      }
      if (
        window.TakMapPackages &&
        typeof window.TakMapPackages.applyLabelDeclutter === "function"
      ) {
        window.TakMapPackages.applyLabelDeclutter({ forceRecompute: !!force });
      }
    }

    runDeclutter(true);
    if (labelDeclutterAfterStyleTimer) clearTimeout(labelDeclutterAfterStyleTimer);
    labelDeclutterAfterStyleTimer = setTimeout(function () {
      labelDeclutterAfterStyleTimer = null;
      runDeclutter(true);
      pendingStyleLabelDeclutter = false;
    }, 120);

    if (map) {
      map.once("idle", function () {
        runDeclutter(true);
        pendingStyleLabelDeclutter = false;
      });
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          runDeclutter(true);
        });
      });
    }
  }

  function patchServerGeoJsonFromBatch(updates, removes) {
    if (!lastServerGeoJsonFull || !Array.isArray(lastServerGeoJsonFull.features)) {
      if (Array.isArray(updates) && updates.length) {
        const seeded = [];
        for (let i = 0; i < updates.length; i++) {
          const feature = buildMapFeatureFromMarker(updates[i]);
          if (feature) seeded.push(feature);
        }
        if (seeded.length) {
          lastServerGeoJsonFull = {
            type: "FeatureCollection",
            features: seeded,
            meta: {},
          };
          return true;
        }
      }
      return false;
    }

    let changed = false;
    let features = lastServerGeoJsonFull.features;

    if (Array.isArray(removes) && removes.length) {
      const removeSet = new Set(
        removes.map(function (uid) {
          return String(uid);
        })
      );
      const next = features.filter(function (feature) {
        return !removeSet.has(String(feature && feature.properties && feature.properties.uid));
      });
      if (next.length !== features.length) {
        features = next;
        changed = true;
      }
    }

    if (Array.isArray(updates) && updates.length) {
      const byUid = new Map();
      for (let i = 0; i < updates.length; i++) {
        const m = updates[i];
        if (m && m.uid) byUid.set(String(m.uid), m);
      }
      if (byUid.size) {
        const seen = new Set();
        features = features.map(function (feature) {
          if (!feature || !feature.properties) return feature;
          const uid = String(feature.properties.uid);
          const m = byUid.get(uid);
          if (!m) return feature;
          seen.add(uid);
          const lat = Number(m.lat);
          const lon = Number(m.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return feature;
          const coords = feature.geometry && feature.geometry.coordinates;
          const selected = m.uid === selectedUid;
          const locked = m.uid === lockedUid;
          if (
            coords &&
            coords[0] === lon &&
            coords[1] === lat &&
            feature.properties.selected === selected &&
            feature.properties.locked === locked
          ) {
            return feature;
          }
          changed = true;
          return {
            type: feature.type,
            geometry: { type: "Point", coordinates: [lon, lat] },
            properties: Object.assign({}, feature.properties, {
              selected: selected,
              locked: locked,
            }),
          };
        });
        byUid.forEach(function (m, uid) {
          if (seen.has(uid)) return;
          const feature = buildMapFeatureFromMarker(m);
          if (!feature) return;
          features.push(feature);
          changed = true;
        });
      }
    }

    if (!changed) return false;
    lastServerGeoJsonFull = Object.assign({}, lastServerGeoJsonFull, {
      features: features,
    });
    return true;
  }

  function batchNeedsFullGeoRefresh(updates) {
    if (!lastServerGeoJsonFull && markersByUid.size === 0) {
      return true;
    }
    // New UIDs are built from slim SSE markers; periodic reconcile enriches icons.
    void updates;
    return false;
  }

  function fetchServerGeoJson() {
    refreshPaddedViewportBounds();
    let url = "/api/map/geojson";
    const qs = buildGeoJsonFetchQueryString();
    if (qs) url += "?" + qs;
    const fetchKey = String(lastMarkerRevision || 0) + "|" + qs;
    if (fetchKey === lastGeoFetchKey && lastServerGeoJsonFull) {
      return Promise.resolve(lastServerGeoJsonFull);
    }

    return fetch(url, {
      credentials: "same-origin",
    }).then(function (resp) {
      if (!resp.ok) throw new Error("geojson " + resp.status);
      return resp.json().then(function (geojson) {
        lastGeoFetchKey = fetchKey;
        return geojson;
      });
    });
  }

  function runServerGeoJsonRefresh() {
    if (!markerLayersReady) {
      mapRefreshPending = true;
      return Promise.resolve(false);
    }
    if (serverGeoFetchInFlight) return serverGeoFetchInFlight;

    serverGeoFetchInFlight = fetchServerGeoJson()
      .then(function (geojson) {
        if (!geojson) return false;
        if (geojson === lastServerGeoJsonFull) {
          applyLocalChannelFilter({
            layersOnly: true,
            forceLabels: pendingStyleLabelDeclutter,
          });
          lastGeoJsonFetchOk = true;
          mapRefreshPending = false;
          return true;
        }
        const ok = applyServerGeoJsonToMap(geojson);
        lastGeoJsonFetchOk = ok;
        mapRefreshPending = !ok;
        return ok;
      })
      .catch(function (err) {
        console.warn("Server GeoJSON refresh failed", err);
        lastGeoJsonFetchOk = false;
        mapRefreshPending = true;
        return false;
      })
      .finally(function () {
        serverGeoFetchInFlight = null;
      });

    return serverGeoFetchInFlight;
  }

  function areLiveMarkersLoaded() {
    return !!(
      markerLayersReady &&
      markerLayersComplete() &&
      lastGeoJsonFetchOk &&
      lastServerGeoJsonFull
    );
  }

  function ensureLiveMarkersLoaded() {
    const gen = liveMarkersLoadGen;
    if (areLiveMarkersLoaded()) return Promise.resolve();
    return new Promise(function (resolve) {
      function tryReady(attempt) {
        if (gen !== liveMarkersLoadGen) {
          resolve();
          return;
        }
        if (areLiveMarkersLoaded()) {
          resolve();
          return;
        }
        if (attempt >= 400) {
          resolve();
          return;
        }
        setTimeout(function () {
          tryReady(attempt + 1);
        }, 50);
      }
      tryReady(0);
    });
  }

  function scheduleMapRefresh() {
    if (mapRefreshTimer) clearTimeout(mapRefreshTimer);
    mapRefreshTimer = setTimeout(refreshMapFromMarkers, SERVER_GEO_DEBOUNCE_MS);
  }

  function scheduleUiRefresh() {
    if (uiTimer) clearTimeout(uiTimer);
    uiTimer = setTimeout(function () {
      updateVisibleCounts();
    }, 120);
  }

  function refreshMapFromMarkers() {
    mapRefreshTimer = null;
    runServerGeoJsonRefresh();
  }

  function pushMarkerGeoJsonToSource(options) {
    if (lastServerGeoJson) {
      return applyServerGeoJsonToMap(lastServerGeoJson);
    }
    return false;
  }

  function syncMapSource(options) {
    scheduleUiRefresh();
    if (options && options.server) {
      scheduleMapRefresh();
      return;
    }
    if (!applyLocalChannelFilter()) {
      scheduleMapRefresh();
    }
  }

  function syncChannelFilterToMap() {
    if (!applyLocalChannelFilter({ forceRecompute: true })) {
      syncMapSource({ server: true });
      return;
    }
    scheduleUiRefresh();
  }

  function scheduleLayerListRefresh() {
    if (layerListTimer) clearTimeout(layerListTimer);
    layerListTimer = setTimeout(function () {
      layerListTimer = null;
      updateLayerListCounts();
    }, 300);
  }

  function updateLayerListCounts() {
    if (!elLayerList) return;
    recomputeGroupCounts();
    const rows = elLayerList.querySelectorAll(".map-layer-row");
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const input = row.querySelector(".map-mission-toggle[data-group]");
      if (!input) continue;
      const groupName = input.getAttribute("data-group");
      const group = groupsCatalog.find(function (g) {
        return g.name === groupName;
      });
      const countEl = row.querySelector(".map-layer-count");
      if (countEl && group) {
        countEl.textContent = String(group.markerCount || 0);
      }
    }
  }

  function handleChannelGroupToggle(groupName, checked) {
    if (!groupName) return;
    if (!enabledGroups) {
      ensureEnabledGroupsInitialized();
    }
    if (checked) enabledGroups.add(groupName);
    else enabledGroups.delete(groupName);
    syncEnabledGroupsWithCatalog();
    saveEnabledGroups();
    syncChannelFilterToMap();
    refreshGoToIfOpen();
  }

  function loadMarkersFromServer() {
    return fetch("/api/map/markers")
      .then(function (resp) {
        if (!resp.ok) throw new Error("markers " + resp.status);
        return resp.json();
      })
      .then(function (data) {
        if (data && data.revision != null) {
          lastLoadedMarkerRevision = Number(data.revision) || 0;
          lastMarkerRevision = lastLoadedMarkerRevision;
        }
        markersByUid.clear();
        const list = Array.isArray(data.markers) ? data.markers : [];
        for (let i = 0; i < list.length; i++) {
          storeMarker(list[i]);
        }
        recomputeGroupCounts();
      });
  }
  let lockedUid = null;
  let lockMoveFromCode = false;
  let popup = null;
  let stackPickerEl = null;
  let stackPickerOutsideListener = null;
  let markerLayersReady = false;
  let suppressMapBackgroundClickUntil = 0;
  let pendingFitVisible = true;
  let copyToastTimer = null;
  let lastCursorLngLat = null;
  let goToPaletteOpen = false;
  let goToSubmitting = false;
  let goToResults = [];
  let goToActiveIndex = -1;
  let goToGeocodeTimer = null;
  let goToGeocodeSeq = 0;
  const GO_TO_CONTACT_LIMIT = 8;
  const GO_TO_ADDRESS_LIMIT = 5;
  const GO_TO_GEOCODE_TIMEOUT_MS = 15000;
  const CURSOR_COORD_FORMATS = [
    { id: "decimal_degrees", label: "Decimal Degrees" },
    { id: "degrees_minutes", label: "Degrees, Minutes" },
    { id: "degrees_minutes_seconds", label: "Degrees, Minutes, Seconds" },
    { id: "utm", label: "UTM" },
    { id: "mgrs", label: "MGRS" },
  ];

  function mapPrefsStorageKey() {
    return "tak-portal-map-prefs:" + MAP_USER_KEY;
  }

  function serverDefaultBasemap() {
    const fromServer =
      window.TAK_PORTAL_MAP_DEFAULTS && window.TAK_PORTAL_MAP_DEFAULTS.basemap;
    return normalizeBasemapId(
      fromServer || mapBasemaps.DEFAULT_BASEMAP_ID || "dark-matter"
    );
  }

  function coordFormatIndexFromStored(stored) {
    if (!stored) return 0;
    const asNum = Number(stored);
    if (Number.isFinite(asNum) && String(asNum) === String(stored).trim()) {
      return Math.max(0, Math.min(CURSOR_COORD_FORMATS.length - 1, asNum));
    }
    const idx = CURSOR_COORD_FORMATS.findIndex(function (f) {
      return f.id === stored;
    });
    return idx >= 0 ? idx : 0;
  }

  function readMapPrefs() {
    const serverDefault = serverDefaultBasemap();
    const defaults = {
      basemap: serverDefault,
      coordFormat: "decimal_degrees",
      viewport: null,
    };
    try {
      const raw = localStorage.getItem(mapPrefsStorageKey());
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          return {
            basemap: parsed.basemap || serverDefault,
            coordFormat: parsed.coordFormat || defaults.coordFormat,
            viewport:
              parsed.viewport && typeof parsed.viewport === "object"
                ? parsed.viewport
                : null,
          };
        }
      }
    } catch (_) {}
    return {
      basemap: localStorage.getItem(LS_BASEMAP) || serverDefault,
      coordFormat: localStorage.getItem(LS_COORD_FORMAT) || defaults.coordFormat,
      viewport: null,
    };
  }

  function writeMapPrefs(patch) {
    const current = readMapPrefs();
    const next = {
      v: 1,
      basemap: patch.basemap != null ? patch.basemap : current.basemap,
      coordFormat:
        patch.coordFormat != null ? patch.coordFormat : current.coordFormat,
      viewport:
        patch.viewport !== undefined ? patch.viewport : current.viewport,
    };
    next.basemap = normalizeBasemapId(next.basemap);
    try {
      localStorage.setItem(mapPrefsStorageKey(), JSON.stringify(next));
    } catch (_) {}
    return next;
  }

  function parseStoredViewport(viewport) {
    if (!viewport || typeof viewport !== "object") return null;
    const lng = Number(viewport.lng);
    const lat = Number(viewport.lat);
    const zoom = Number(viewport.zoom);
    if (
      !Number.isFinite(lng) ||
      !Number.isFinite(lat) ||
      !Number.isFinite(zoom) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      return null;
    }
    return {
      lng: lng,
      lat: lat,
      zoom: Math.min(22, Math.max(0, zoom)),
    };
  }

  const mapPrefs = readMapPrefs();
  const storedViewport = parseStoredViewport(mapPrefs.viewport);
  if (storedViewport) pendingFitVisible = false;
  let cursorCoordFormatIndex = coordFormatIndexFromStored(mapPrefs.coordFormat);
  let defaultIconIds = {};
  const iconLoadPending = new Map();
  const iconIdByMapImageId = new Map();
  let missionIconManifest = [];

  function resetMapIconCache() {
    iconLoadPending.clear();
    iconIdByMapImageId.clear();
    purgeMapIconImages();
  }

  function purgeMapIconImages() {
    if (!map || typeof map.listImages !== "function") return;
    for (const name of map.listImages()) {
      const id = String(name);
      if (id.startsWith("mimg-")) {
        try {
          map.removeImage(name);
        } catch (_) {}
      }
    }
  }

  function reinstallMapIconsFromCache() {
    if (!map || !map.isStyleLoaded()) return;
    iconLoadPending.clear();
    triggerMarkerRepaint();
  }

  function base64ToBlob(b64, mime) {
    const bytes = atob(String(b64 || ""));
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return new Blob([arr], { type: mime || "image/png" });
  }

  function iconApiUrl(iconId) {
    return "/api/map/icons?id=" + encodeURIComponent(iconId);
  }

  function markerPreviewUsesIcon(m) {
    if (!m) return false;
    if (m.usesMapIcon != null) return !!m.usesMapIcon;
    const mapImageId = normalizeMapImageId(m.mapImageId || m.iconId || "");
    return !!(mapImageId && isRenderedMapImageId(mapImageId));
  }

  function preloadMarkerIcons(manifest) {
    const entries = Array.isArray(manifest) ? manifest : [];
    if (!entries.length || !map) return Promise.resolve();

    const needed = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const mapImageId = normalizeMapImageId(entry.mapImageId || "");
      if (!mapImageId || !isRenderedMapImageId(mapImageId)) continue;
      if (map.hasImage(mapImageId) || iconLoadPending.has(mapImageId)) continue;
      registerServerMapImageMeta(mapImageId, entry.apiIconId, entry);
      needed.push(entry);
    }
    if (!needed.length) return Promise.resolve();

    const batchKey = "batch:" + needed.map(function (e) {
      return normalizeMapImageId(e.mapImageId);
    }).join(",");
    if (iconLoadPending.has(batchKey)) return iconLoadPending.get(batchKey);

    const promise = fetch("/api/map/icons/rendered/batch", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        icons: needed.map(function (entry) {
          return {
            mapImageId: normalizeMapImageId(entry.mapImageId),
            apiIconId: entry.apiIconId || "",
            color: entry.color || "",
            teamColor: entry.teamColor != null ? entry.teamColor : "",
            iconSource: entry.iconSource || "",
            origin: entry.origin || "",
            type: entry.type || "",
            affiliation: entry.affiliation || "",
          };
        }),
      }),
    })
      .then(function (resp) {
        if (!resp.ok) throw new Error("batch icons " + resp.status);
        return resp.json();
      })
      .then(function (data) {
        const icons = data.icons || {};
        const installs = [];
        for (const mapImageId of Object.keys(icons)) {
          const b64 = icons[mapImageId];
          if (!b64) continue;
          const canonicalId = normalizeMapImageId(mapImageId);
          const blob = base64ToBlob(b64, "image/png");
          installs.push(
            decodeIconBlob(blob)
              .then(function (image) {
                mapIconImageCache.set(canonicalId, image);
                void writeIconCache(canonicalId, blob);
                return installMapImage(canonicalId, image);
              })
              .then(function () {
                hideCirclesForMapImage(canonicalId);
              })
          );
        }
        return Promise.all(installs);
      })
      .then(function () {
        triggerMarkerRepaint();
        scheduleMissingIconSweep();
      })
      .catch(function (err) {
        console.warn("Batch icon preload failed", err);
        scheduleMissingIconSweep();
      })
      .finally(function () {
        iconLoadPending.delete(batchKey);
      });

    iconLoadPending.set(batchKey, promise);
    return promise;
  }

  let missingIconSweepTimer = null;

  function sweepMissingIcons() {
    if (!map || !markerLayersReady) return;
    const seen = new Set();
    function consider(mapImageId, apiIconId, meta) {
      const canonicalId = normalizeMapImageId(mapImageId);
      if (!canonicalId || !isRenderedMapImageId(canonicalId) || seen.has(canonicalId)) return;
      seen.add(canonicalId);
      if (map.hasImage(canonicalId) || iconLoadPending.has(canonicalId)) return;
      const info =
        meta ||
        resolveIconMetaForImageId(canonicalId) ||
        (apiIconId
          ? { apiIconId: String(apiIconId), mapImageId: canonicalId }
          : null);
      if (!info || !info.apiIconId) return;
      loadRenderedMapIcon(canonicalId, info.apiIconId, info);
    }

    const features =
      (lastServerGeoJson && lastServerGeoJson.features) ||
      (lastServerGeoJsonFull && lastServerGeoJsonFull.features) ||
      [];
    for (let i = 0; i < features.length; i++) {
      const props = features[i] && features[i].properties;
      if (!props || !props.iconId) continue;
      consider(props.iconId, props.apiIconId, props);
    }

    // Worker path may paint icons before lastServerGeoJson is rebuilt — also scan slim markers.
    markersByUid.forEach(function (m) {
      if (!m) return;
      const mapImageId = normalizeMapImageId(m.mapImageId || "");
      if (!mapImageId) return;
      consider(mapImageId, m.iconId, m);
    });
  }

  /** Build batch-preload manifest from slim markers (worker / SSE path). */
  function buildIconManifestFromMarkers(markerList) {
    const out = [];
    const seen = new Set();
    const list = Array.isArray(markerList) ? markerList : [];
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!m) continue;
      const mapImageId = normalizeMapImageId(m.mapImageId || "");
      if (!mapImageId || !isRenderedMapImageId(mapImageId) || seen.has(mapImageId)) continue;
      seen.add(mapImageId);
      registerServerMapImageMeta(mapImageId, String(m.iconId || ""), m);
      out.push({
        mapImageId: mapImageId,
        apiIconId: String(m.iconId || ""),
        color: m.color || "",
        teamColor: m.teamColor != null ? m.teamColor : "",
        iconSource: m.iconSource || "",
        origin: m.origin || "",
        type: m.type || "",
        affiliation: m.affiliation || "",
      });
    }
    return out;
  }

  function preloadIconsForMarkers(markerList) {
    const manifest = buildIconManifestFromMarkers(markerList);
    if (!manifest.length) {
      scheduleMissingIconSweep();
      return Promise.resolve();
    }
    return preloadMarkerIcons(manifest);
  }

  function scheduleMissingIconSweep() {
    if (missingIconSweepTimer) clearTimeout(missingIconSweepTimer);
    missingIconSweepTimer = setTimeout(function () {
      missingIconSweepTimer = null;
      sweepMissingIcons();
    }, 250);
  }

  function onStyleImageMissing(e) {
    const mapImageId = e.id;
    if (!isRenderedMapImageId(mapImageId)) {
      triggerMarkerRepaint();
      return;
    }
    const canonicalId = normalizeMapImageId(mapImageId);
    if (iconLoadPending.has(canonicalId)) return;
    const info = resolveIconMetaForImageId(canonicalId);
    loadRenderedMapIcon(canonicalId, info && info.apiIconId, info || {});
  }

  function decodeIconBlob(blob) {
    if (typeof createImageBitmap === "function") {
      return createImageBitmap(blob).catch(function () {
        return decodeIconBlobLegacy(blob);
      });
    }
    return decodeIconBlobLegacy(blob);
  }

  function decodeIconBlobLegacy(blob) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = function () {
        try {
          const w = img.naturalWidth || img.width;
          const h = img.naturalHeight || img.height;
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            reject(new Error("canvas unavailable"));
            return;
          }
          ctx.drawImage(img, 0, 0);
          resolve(ctx.getImageData(0, 0, w, h));
        } catch (err) {
          reject(err);
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("icon decode failed"));
      };
      img.src = url;
    });
  }

  function formatMarkerGroupNames(m) {
    return markerGroups(m)
      .map(function (g) {
        return stripTakPrefix(g);
      })
      .join(", ");
  }

  function installMapImage(imageName, source) {
    if (!map.isStyleLoaded() || !source) {
      return Promise.resolve(false);
    }
    const addOpts = { pixelRatio: 1 };
    function putImage(img) {
      try {
        if (map.hasImage(imageName)) {
          map.updateImage(imageName, img);
        } else {
          map.addImage(imageName, img, addOpts);
        }
        return true;
      } catch (_) {
        return false;
      }
    }
    if (typeof ImageData !== "undefined" && source instanceof ImageData) {
      return Promise.resolve(
        putImage({
          width: source.width,
          height: source.height,
          data: source.data,
        })
      );
    }
    if (source instanceof HTMLCanvasElement) {
      if (typeof createImageBitmap === "function") {
        return createImageBitmap(source).then(putImage).catch(function () {
          return new Promise(function (resolve) {
            const img = new Image();
            img.onload = function () {
              resolve(putImage(img));
            };
            img.onerror = function () {
              resolve(false);
            };
            img.src = source.toDataURL("image/png");
          });
        });
      }
      return new Promise(function (resolve) {
        const img = new Image();
        img.onload = function () {
          resolve(putImage(img));
        };
        img.onerror = function () {
          resolve(false);
        };
        img.src = source.toDataURL("image/png");
      });
    }
    return Promise.resolve(putImage(source));
  }

  const elLayerList = document.getElementById("mapLayerList");
  const elDetailStack = document.getElementById("mapDetailStack");
  const elVisibleCounts = document.getElementById("mapVisibleCounts");
  const elCursor = document.getElementById("mapCursor");
  const elCursorBtn = document.getElementById("mapCursorBtn");
  const elGoToOverlay = document.getElementById("mapGoToOverlay");
  const elGoToInput = document.getElementById("mapGoToInput");
  const elGoToResultsWrap = document.getElementById("mapGoToResultsWrap");
  const elGoToResults = document.getElementById("mapGoToResults");
  const elGoToHint = document.getElementById("mapGoToHint");
  const elGoToBackdrop = document.getElementById("mapGoToBackdrop");
  const elZoomIn = document.getElementById("mapZoomIn");
  const elZoomOut = document.getElementById("mapZoomOut");
  const elLayerSearch = document.getElementById("mapLayerSearch");
  const elHudFit = document.getElementById("mapHudFit");
  const elBasemapSelect = document.getElementById("mapBasemapSelect");
  const elOffline = document.getElementById("mapOfflineBanner");
  const elPanelLeft = document.getElementById("mapPanelLeft");
  const elDetailResize = document.getElementById("mapDetailResize");
  const elExpandLeft = document.getElementById("mapExpandLeft");
  const elExpandRight = document.getElementById("mapExpandRight");

  let savedBasemap = normalizeBasemapId(mapPrefs.basemap);
  elBasemapSelect.innerHTML = Object.entries(BASEMAPS)
    .map(([id, def]) => `<option value="${id}">${def.label}</option>`)
    .join("");
  elBasemapSelect.value = savedBasemap;

  const initialBasemap = BASEMAPS[savedBasemap] || BASEMAPS["dark-matter"];
  const initialCenter = storedViewport
    ? [storedViewport.lng, storedViewport.lat]
    : [-98.5795, 39.8283];
  const initialZoom = storedViewport ? storedViewport.zoom : 4;

  const map = new maplibregl.Map({
    container: "map",
    style: withMapGlyphs(initialBasemap.style),
    center: initialCenter,
    zoom: initialZoom,
    bearing: 0,
    pitch: 0,
    minPitch: 0,
    maxPitch: 0,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    rollEnabled: false,
    attributionControl: true,
  });

  if (typeof ResizeObserver !== "undefined") {
    const mapEl = document.getElementById("map");
    if (mapEl) {
      const ro = new ResizeObserver(function () {
        if (map && typeof map.resize === "function") map.resize();
      });
      ro.observe(mapEl);
    }
  }

  function lockMapNorthUp() {
    if (map.dragRotate) map.dragRotate.disable();
    if (map.touchPitch) map.touchPitch.disable();
    if (map.touchZoomRotate && typeof map.touchZoomRotate.disableRotation === "function") {
      map.touchZoomRotate.disableRotation();
    }
    if (typeof map.setMinPitch === "function") map.setMinPitch(0);
    if (typeof map.setMaxPitch === "function") map.setMaxPitch(0);
    const bearing = map.getBearing();
    const pitch = map.getPitch();
    if (Math.abs(bearing) > 0.001 || Math.abs(pitch) > 0.001) {
      map.jumpTo({
        center: map.getCenter(),
        zoom: map.getZoom(),
        bearing: 0,
        pitch: 0,
      });
    }
  }

  function clampMapNorthUp() {
    if (Math.abs(map.getBearing()) > 0.001) map.setBearing(0);
    if (Math.abs(map.getPitch()) > 0.001) map.setPitch(0);
  }

  lockMapNorthUp();

  map.on("rotate", clampMapNorthUp);
  map.on("pitch", clampMapNorthUp);
  map.on("style.load", function () {
    requestAnimationFrame(lockMapNorthUp);
  });
  map.on("load", lockMapNorthUp);

  let viewportSaveTimer = null;
  function scheduleSaveViewport() {
    if (viewportSaveTimer) clearTimeout(viewportSaveTimer);
    viewportSaveTimer = setTimeout(function () {
      viewportSaveTimer = null;
      if (lockedUid || lockMoveFromCode) return;
      const center = map.getCenter();
      writeMapPrefs({
        viewport: {
          lng: center.lng,
          lat: center.lat,
          zoom: map.getZoom(),
        },
      });
    }, 400);
  }
  map.on("moveend", scheduleSaveViewport);

  restorePanelState();
  loadDetailPanelWidth();
  initDetailPanelResize();

  let lastLayoutNarrow = isMapLayoutNarrow();
  window.addEventListener("resize", function () {
    const narrow = isMapLayoutNarrow();
    if (narrow === lastLayoutNarrow) return;
    lastLayoutNarrow = narrow;
    if (narrow) {
      setPanelLeftCollapsed(true, { persist: false });
    } else {
      setPanelLeftCollapsed(localStorage.getItem(LS_PANEL_LEFT) === "collapsed");
    }
  });

  function normalizeEnabledGroups(set) {
    if (!set) return null;
    if (set.size === 0) return new Set();
    const out = new Set();
    for (const item of set) {
      const itemStr = String(item || "").trim();
      if (!itemStr) continue;
      let match = groupsCatalog.find(function (g) {
        const baseKey = channelBaseKeyForName(g.name);
        return baseKey === itemStr || g.baseKey === itemStr;
      });
      if (!match) {
        const key = channelGroupKey(itemStr);
        if (key) {
          match = groupsCatalog.find(function (g) {
            return channelGroupKey(g.name) === key;
          });
        }
      }
      if (match) out.add(match.name);
    }
    return out;
  }

  function enabledGroupStorageKeys() {
    const keys = new Set();
    if (!enabledGroups) return keys;
    for (const name of enabledGroups) {
      const key = channelBaseKeyForName(name);
      if (key) keys.add(key);
    }
    return keys;
  }

  function saveEnabledGroups() {
    const scope = mapChannelScope === "member" ? "member" : "all";
    if (!enabledGroups) {
      localStorage.removeItem(groupsStorageKey(scope));
      storedEnabledGroupKeys = null;
      return;
    }
    const keys = Array.from(enabledGroupStorageKeys()).sort();
    storedEnabledGroupKeys = new Set(keys);
    localStorage.setItem(
      groupsStorageKey(scope),
      JSON.stringify({ v: 2, keys: keys })
    );
  }

  function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (_) {}
    document.body.removeChild(ta);
    return Promise.resolve();
  }

  function showCopyToast(text) {
    if (!elCursor) return;
    elCursor.textContent = text;
    if (copyToastTimer) clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(function () {
      copyToastTimer = null;
      renderCursorCoords();
    }, 1500);
  }

  function coordHemisphere(deg, isLat) {
    if (isLat) return deg >= 0 ? "N" : "S";
    return deg >= 0 ? "E" : "W";
  }

  function toDmPart(deg) {
    const abs = Math.abs(deg);
    const d = Math.floor(abs);
    const m = (abs - d) * 60;
    return String(d) + "\u00B0" + m.toFixed(3).padStart(6, "0") + "'";
  }

  function toDmsPart(deg) {
    const abs = Math.abs(deg);
    const d = Math.floor(abs);
    const mFloat = (abs - d) * 60;
    const m = Math.floor(mFloat);
    const s = (mFloat - m) * 60;
    return (
      String(d) +
      "\u00B0" +
      String(m).padStart(2, "0") +
      "'" +
      s.toFixed(1) +
      '"'
    );
  }

  const MGRS_LAT_BANDS = "CDEFGHJKLMNPQRSTUVWXX";
  const MGRS_E100K = ["ABCDEFGH", "JKLMNPQR", "STUVWXYZ"];
  const MGRS_N100K = ["ABCDEFGHJKLMNPQRSTUV", "FGHJKLMNPQRSTUVABCDE"];

  function latLonToUtm(lat, lon) {
    const a = 6378137;
    const f = 1 / 298.257223563;
    const k0 = 0.9996;
    const eccSq = f * (2 - f);
    const ecc2Sq = eccSq / (1 - eccSq);

    let zone = Math.floor((lon + 180) / 6) + 1;
    const latBand = MGRS_LAT_BANDS.charAt(Math.floor(lat / 8 + 10));
    if (zone === 31 && latBand === "V" && lon >= 3) zone++;
    if (zone === 32 && latBand === "X" && lon < 9) zone--;
    if (zone === 32 && latBand === "X" && lon >= 9) zone++;
    if (zone === 34 && latBand === "X" && lon < 21) zone--;
    if (zone === 34 && latBand === "X" && lon >= 21) zone++;
    if (zone === 36 && latBand === "X" && lon < 33) zone--;
    if (zone === 36 && latBand === "X" && lon >= 33) zone++;

    const latRad = (lat * Math.PI) / 180;
    const lonRad = (lon * Math.PI) / 180;
    const lonOrigin = (zone - 1) * 6 - 180 + 3;
    const lonOriginRad = (lonOrigin * Math.PI) / 180;

    const N = a / Math.sqrt(1 - eccSq * Math.sin(latRad) ** 2);
    const T = Math.tan(latRad) ** 2;
    const C = ecc2Sq * Math.cos(latRad) ** 2;
    const A = Math.cos(latRad) * (lonRad - lonOriginRad);

    const M =
      a *
      ((1 - eccSq / 4 - (3 * eccSq ** 2) / 64 - (5 * eccSq ** 3) / 256) * latRad -
        ((3 * eccSq) / 8 + (3 * eccSq ** 2) / 32 + (45 * eccSq ** 3) / 1024) *
          Math.sin(2 * latRad) +
        ((15 * eccSq ** 2) / 256 + (45 * eccSq ** 3) / 1024) * Math.sin(4 * latRad) -
        ((35 * eccSq ** 3) / 3072) * Math.sin(6 * latRad));

    let easting =
      k0 *
        N *
        (A +
          ((1 - T + C) * A ** 3) / 6 +
          ((5 - 18 * T + T ** 2 + 72 * C - 58 * ecc2Sq) * A ** 5) / 120) +
      500000;
    let northing =
      k0 *
      (M +
        N *
          Math.tan(latRad) *
          (A ** 2 / 2 +
            ((5 - T + 9 * C + 4 * C ** 2) * A ** 4) / 24 +
            ((61 - 58 * T + T ** 2 + 600 * C - 330 * ecc2Sq) * A ** 6) / 720));
    if (lat < 0) northing += 10000000;

    return {
      zone: zone,
      hemisphere: lat >= 0 ? "N" : "S",
      easting: Math.round(easting),
      northing: Math.round(northing),
    };
  }

  function latLonToMgrs(lat, lon, precision) {
    if (precision == null) precision = 5;
    const utm = latLonToUtm(lat, lon);
    const zone = utm.zone;
    const band = MGRS_LAT_BANDS.charAt(Math.floor(lat / 8 + 10));
    const col = Math.floor(utm.easting / 100000);
    const e100k = MGRS_E100K[(zone - 1) % 3].charAt(col - 1);
    const row = Math.floor(utm.northing / 100000) % 20;
    const n100k = MGRS_N100K[(zone - 1) % 2].charAt(row);
    const easting = Math.floor(utm.easting % 100000);
    const northing = Math.floor(utm.northing % 100000);
    const eRounded = Math.floor(easting / Math.pow(10, 5 - precision));
    const nRounded = Math.floor(northing / Math.pow(10, 5 - precision));
    return (
      String(zone).padStart(2, "0") +
      band +
      " " +
      e100k +
      n100k +
      " " +
      String(eRounded).padStart(precision, "0") +
      " " +
      String(nRounded).padStart(precision, "0")
    );
  }

  function formatCursorCoords(lat, lon, formatId) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "—";
    const fmt = formatId || CURSOR_COORD_FORMATS[cursorCoordFormatIndex].id;
    if (fmt === "degrees_minutes") {
      return (
        toDmPart(lat) +
        coordHemisphere(lat, true) +
        " " +
        toDmPart(lon) +
        coordHemisphere(lon, false)
      );
    }
    if (fmt === "degrees_minutes_seconds") {
      return (
        toDmsPart(lat) +
        coordHemisphere(lat, true) +
        " " +
        toDmsPart(lon) +
        coordHemisphere(lon, false)
      );
    }
    if (fmt === "utm") {
      const utm = latLonToUtm(lat, lon);
      return (
        String(utm.zone) +
        utm.hemisphere +
        " " +
        utm.easting +
        " " +
        utm.northing
      );
    }
    if (fmt === "mgrs") {
      return latLonToMgrs(lat, lon);
    }
    return lat.toFixed(5) + ", " + lon.toFixed(5);
  }

  function renderCursorCoords() {
    if (!elCursor || copyToastTimer) return;
    const fmt = CURSOR_COORD_FORMATS[cursorCoordFormatIndex];
    if (!lastCursorLngLat) {
      elCursor.textContent = fmt.label + ": —";
      return;
    }
    elCursor.textContent =
      fmt.label +
      ": " +
      formatCursorCoords(lastCursorLngLat.lat, lastCursorLngLat.lng, fmt.id);
  }

  function cycleCursorCoordFormat() {
    cursorCoordFormatIndex =
      (cursorCoordFormatIndex + 1) % CURSOR_COORD_FORMATS.length;
    writeMapPrefs({
      coordFormat: CURSOR_COORD_FORMATS[cursorCoordFormatIndex].id,
    });
    renderCursorCoords();
    refreshOpenDetailPaneCoords();
  }

  function cursorCoordsCopyText(lat, lon) {
    return formatCursorCoords(lat, lon);
  }

  function isTypingTarget(el) {
    if (!el || el === elGoToInput) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function isGoToTypingKey(key) {
    return key.length === 1 && !/[\x00-\x1f]/.test(key);
  }

  function dmsTokenToDecimal(deg, min, sec, hemi) {
    let v =
      Math.abs(Number(deg)) +
      (Number(min) || 0) / 60 +
      (Number(sec) || 0) / 3600;
    const h = String(hemi || "").toUpperCase();
    if (h === "S" || h === "W") v = -v;
    else if (Number(deg) < 0) v = -Math.abs(v);
    return v;
  }

  function parseSingleCoordToken(token) {
    const t = String(token || "").trim();
    if (!t) return null;

    let m = t.match(/^([+-]?\d+(?:\.\d+)?)\s*([NSEW])$/i);
    if (m) {
      const val = Number(m[1]);
      const hemi = m[2].toUpperCase();
      if (/[NS]/.test(hemi)) {
        if (Math.abs(val) > 90) return null;
        return { lat: hemi === "S" ? -Math.abs(val) : Math.abs(val) };
      }
      if (Math.abs(val) > 180) return null;
      return { lon: hemi === "W" ? -Math.abs(val) : Math.abs(val) };
    }

    m = t.match(
      /^([+-]?\d+(?:\.\d+)?)\s*(?:°|º|deg)?\s*(\d+(?:\.\d+)?)\s*(?:'|′|m)\s*(\d+(?:\.\d+)?)\s*(?:\"|″|s)?\s*([NSEW])$/i
    );
    if (m) {
      const val = dmsTokenToDecimal(m[1], m[2], m[3], m[4]);
      if (/[NS]/i.test(m[4])) return { lat: val };
      return { lon: val };
    }

    m = t.match(
      /^([+-]?\d+(?:\.\d+)?)\s*(?:°|º|deg)?\s*(\d+(?:\.\d+)?)\s*(?:'|′|m)\s*([NSEW])$/i
    );
    if (m) {
      const val = dmsTokenToDecimal(m[1], m[2], 0, m[3]);
      if (/[NS]/i.test(m[3])) return { lat: val };
      return { lon: val };
    }

    return null;
  }

  function parseGoToCoords(query) {
    const q = String(query || "").trim();
    if (!q) return null;

    const dec = q.match(/^([+-]?\d+(?:\.\d+)?)\s*[,;\s]\s*([+-]?\d+(?:\.\d+)?)$/);
    if (dec) {
      const a = Number(dec[1]);
      const b = Number(dec[2]);
      if (Math.abs(a) <= 90 && Math.abs(b) <= 180) {
        return { lat: a, lon: b };
      }
      if (Math.abs(b) <= 90 && Math.abs(a) <= 180) {
        return { lat: b, lon: a };
      }
    }

    const tokens = q.match(
      /[+-]?\d+(?:\.\d+)?(?:\s*(?:°|º|deg))?(?:\s*\d+(?:\.\d+)?(?:\s*(?:'|′|m))?(?:\s*\d+(?:\.\d+)?(?:\s*(?:\"|″|s))?)?\s*)?[NSEW]/gi
    );
    if (tokens && tokens.length >= 2) {
      const latTok = tokens.find(function (part) {
        return /[NS]/i.test(part);
      });
      const lonTok = tokens.find(function (part) {
        return /[EW]/i.test(part);
      });
      if (latTok && lonTok) {
        const latPart = parseSingleCoordToken(latTok);
        const lonPart = parseSingleCoordToken(lonTok);
        if (
          latPart &&
          lonPart &&
          Number.isFinite(latPart.lat) &&
          Number.isFinite(lonPart.lon)
        ) {
          return { lat: latPart.lat, lon: lonPart.lon };
        }
      }
    }

    return null;
  }

  function findCallsignMatches(query, maxResults) {
    const limit = maxResults == null ? GO_TO_CONTACT_LIMIT : maxResults;
    const q = String(query || "").trim().toLowerCase();
    if (!q) return [];
    const all = getVisibleMarkers();
    const scored = [];
    for (let i = 0; i < all.length; i++) {
      const m = all[i];
      const cs = String(m.callsign || "").trim().toLowerCase();
      const uid = String(m.uid || "").trim().toLowerCase();
      let rank = -1;
      if (cs === q || uid === q) rank = 0;
      else if (cs.startsWith(q) || uid.startsWith(q)) rank = 1;
      else if (cs.includes(q) || uid.includes(q)) rank = 2;
      if (rank < 0) continue;
      scored.push({ m: m, rank: rank, label: cs || uid });
    }
    scored.sort(function (a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.label.localeCompare(b.label);
    });
    const out = [];
    for (let i = 0; i < scored.length && out.length < limit; i++) {
      out.push(scored[i].m);
    }
    return out;
  }

  function buildGoToContactResults(query) {
    return findCallsignMatches(query, GO_TO_CONTACT_LIMIT).map(function (m) {
      return {
        kind: "contact",
        id: "contact:" + m.uid,
        title: m.callsign || m.uid,
        marker: m,
      };
    });
  }

  function buildGoToCoordResult(query) {
    const coords = parseGoToCoords(query);
    if (!coords) return null;
    return {
      kind: "coords",
      id: "coords",
      title: coords.lat.toFixed(5) + ", " + coords.lon.toFixed(5),
      meta: "Coordinates",
      lat: coords.lat,
      lon: coords.lon,
    };
  }

  function setGoToHint(text, isError) {
    if (!elGoToHint) return;
    elGoToHint.textContent = text || "";
    elGoToHint.classList.toggle("is-error", !!isError);
  }

  function cancelGoToGeocode() {
    if (goToGeocodeTimer) {
      clearTimeout(goToGeocodeTimer);
      goToGeocodeTimer = null;
    }
    goToGeocodeSeq++;
  }

  function refreshGoToIfOpen() {
    if (goToPaletteOpen && elGoToInput) {
      updateGoToResults(elGoToInput.value);
    }
  }

  function mapViewportCenter() {
    if (!map || typeof map.getCenter !== "function") return null;
    const center = map.getCenter();
    if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lng)) {
      return null;
    }
    return { lat: center.lat, lon: center.lng };
  }

  function distanceKm(lat1, lon1, lat2, lon2) {
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

  function sortGoToAddressesByViewport(addresses) {
    const center = mapViewportCenter();
    if (!center || !Array.isArray(addresses) || addresses.length < 2) {
      return addresses;
    }
    return addresses.slice().sort(function (a, b) {
      const da = distanceKm(center.lat, center.lon, a.lat, a.lon);
      const db = distanceKm(center.lat, center.lon, b.lat, b.lon);
      return da - db;
    });
  }

  function resortGoToAddressesByViewport() {
    if (!goToPaletteOpen || !goToResults.length) return;
    const addressIdx = [];
    const addressItems = [];
    for (let i = 0; i < goToResults.length; i++) {
      if (goToResults[i].kind === "address") {
        addressIdx.push(i);
        addressItems.push(goToResults[i]);
      }
    }
    if (addressItems.length < 2) return;
    const sorted = sortGoToAddressesByViewport(addressItems);
    let changed = false;
    for (let i = 0; i < addressIdx.length; i++) {
      if (goToResults[addressIdx[i]] !== sorted[i]) {
        goToResults[addressIdx[i]] = sorted[i];
        changed = true;
      }
    }
    if (changed) {
      syncGoToActiveIndex();
      renderGoToResults();
    }
  }

  function normalizeGoToGeocodeHit(hit) {
    if (!hit || typeof hit !== "object") return null;
    const lat = Number(hit.lat);
    const lon = Number(hit.lon != null ? hit.lon : hit.lng);
    const label = String(hit.label || hit.display_name || "").trim();
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !label) return null;
    return { lat, lon, label };
  }

  function parseGoToGeocodePayload(data) {
    if (!data || typeof data !== "object") {
      return { hits: [], lookupFailed: false };
    }
    const lookupFailed = !!data.lookupFailed;
    if (Array.isArray(data.results)) {
      return {
        lookupFailed,
        hits: data.results.map(normalizeGoToGeocodeHit).filter(Boolean),
      };
    }
    if (Array.isArray(data)) {
      return {
        lookupFailed: false,
        hits: data.map(normalizeGoToGeocodeHit).filter(Boolean),
      };
    }
    const single = normalizeGoToGeocodeHit(data);
    return {
      lookupFailed,
      hits: single ? [single] : [],
    };
  }

  function mapGoToGeocodeHits(hits, query) {
    return sortGoToAddressesByViewport(
      hits.map(function (hit, idx) {
        return {
          kind: "address",
          id: "address:" + idx + ":" + hit.lat + "," + hit.lon,
          title: String(hit.label || query),
          lat: hit.lat,
          lon: hit.lon,
        };
      })
    );
  }

  function setGoToEmptyHint(contacts, coordResult, lookupFailed) {
    if (contacts.length || coordResult) {
      setGoToHint("");
      return;
    }
    if (lookupFailed) {
      setGoToHint("Address lookup unavailable", true);
      return;
    }
    setGoToHint("No results found", true);
  }

  function flattenGoToResults(contacts, coordResult, addresses) {
    const out = contacts.slice();
    if (coordResult) out.push(coordResult);
    for (let i = 0; i < addresses.length; i++) {
      out.push(addresses[i]);
    }
    return out;
  }

  function fillMarkerPreview(container, m) {
    container.innerHTML = "";

    function showDot() {
      container.innerHTML = "";
      const dot = document.createElement("span");
      dot.className = "map-aff-dot map-marker-preview-dot";
      dot.style.cssText = markerDotStyle(m);
      container.appendChild(dot);
    }

    if (!markerPreviewUsesIcon(m)) {
      showDot();
      return;
    }

    const mapImageId = normalizeMapImageId(m.mapImageId || m.iconId || "");
    const img = document.createElement("img");
    img.className = "map-marker-preview-icon";
    img.alt = "";
    if (mapImageId && isRenderedMapImageId(mapImageId)) {
      let url = "/api/map/icons/rendered?mapImageId=" + encodeURIComponent(mapImageId);
      const apiIconId = String(m.iconId || "");
      if (apiIconId) url += "&apiIconId=" + encodeURIComponent(apiIconId);
      const teamColor = normalizeMarkerColor(m && m.teamColor, null);
      if (teamColor) url += "&teamColor=" + encodeURIComponent(teamColor);
      if (m.iconSource) url += "&iconSource=" + encodeURIComponent(m.iconSource);
      if (m.origin) url += "&origin=" + encodeURIComponent(m.origin);
      if (m.type) url += "&type=" + encodeURIComponent(m.type);
      if (m.affiliation) url += "&affiliation=" + encodeURIComponent(m.affiliation);
      img.src = url;
    } else if (m.iconId) {
      img.src = iconApiUrl(m.iconId);
    } else {
      showDot();
      return;
    }
    img.addEventListener("error", showDot);
    container.appendChild(img);
  }

  function appendMarkerListName(parent, m, label) {
    const nameEl = document.createElement("div");
    nameEl.className = "name";
    const previewEl = document.createElement("span");
    previewEl.className = "map-marker-preview";
    fillMarkerPreview(previewEl, m);
    nameEl.appendChild(previewEl);
    nameEl.appendChild(document.createTextNode(label || m.callsign || m.uid || ""));
    parent.appendChild(nameEl);
    return nameEl;
  }

  function renderGoToResults() {
    if (!elGoToResults || !elGoToResultsWrap) return;
    elGoToResults.innerHTML = "";

    if (!goToResults.length) {
      elGoToResultsWrap.hidden = true;
      return;
    }

    elGoToResultsWrap.hidden = false;
    let contactHeaderAdded = false;
    let addressHeaderAdded = false;

    for (let i = 0; i < goToResults.length; i++) {
      const item = goToResults[i];
      if (item.kind === "loading") {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "map-goto-result is-loading";
        btn.disabled = true;
        btn.textContent = item.title;
        li.appendChild(btn);
        elGoToResults.appendChild(li);
        continue;
      }

      if (item.kind === "contact" && !contactHeaderAdded) {
        contactHeaderAdded = true;
        const head = document.createElement("li");
        head.className = "map-goto-section";
        head.textContent = "Contacts";
        elGoToResults.appendChild(head);
      }
      if (item.kind === "address" && !addressHeaderAdded) {
        addressHeaderAdded = true;
        const head = document.createElement("li");
        head.className = "map-goto-section";
        head.textContent = "Addresses";
        elGoToResults.appendChild(head);
      }
      if (item.kind === "coords" && !contactHeaderAdded) {
        contactHeaderAdded = true;
        const head = document.createElement("li");
        head.className = "map-goto-section";
        head.textContent = "Location";
        elGoToResults.appendChild(head);
      }

      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "map-goto-result" + (i === goToActiveIndex ? " active" : "");
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", i === goToActiveIndex ? "true" : "false");
      btn.dataset.index = String(i);

      const nameEl = document.createElement("div");
      nameEl.className = "name";
      if (item.kind === "contact" && item.marker) {
        const previewEl = document.createElement("span");
        previewEl.className = "map-marker-preview";
        fillMarkerPreview(previewEl, item.marker);
        nameEl.appendChild(previewEl);
        nameEl.appendChild(document.createTextNode(item.title || ""));
        btn.appendChild(nameEl);
      } else {
        nameEl.textContent = item.title || "";
        btn.appendChild(nameEl);
        if (item.meta) {
          const metaEl = document.createElement("div");
          metaEl.className = "meta";
          metaEl.textContent = item.meta;
          btn.appendChild(metaEl);
        }
      }

      btn.addEventListener("mousedown", function (ev) {
        ev.preventDefault();
      });
      btn.addEventListener("click", function () {
        activateGoToResult(item);
      });

      li.appendChild(btn);
      elGoToResults.appendChild(li);
    }

    if (goToActiveIndex >= 0) {
      const activeEl = elGoToResults.querySelector(".map-goto-result.active");
      if (activeEl && typeof activeEl.scrollIntoView === "function") {
        activeEl.scrollIntoView({ block: "nearest" });
      }
    }
  }

  function syncGoToActiveIndex() {
    if (!goToResults.length) {
      goToActiveIndex = -1;
      return;
    }
    if (goToActiveIndex < 0) goToActiveIndex = 0;
    if (goToActiveIndex >= goToResults.length) {
      goToActiveIndex = goToResults.length - 1;
    }
  }

  function updateGoToResults(query) {
    cancelGoToGeocode();
    const q = String(query || "").trim();
    if (!q) {
      goToResults = [];
      goToActiveIndex = -1;
      setGoToHint("");
      renderGoToResults();
      return;
    }

    const contacts = buildGoToContactResults(q);
    const coordResult = buildGoToCoordResult(q);
    const shouldGeocode = q.length >= 3 && !coordResult;

    if (shouldGeocode) {
      goToResults = flattenGoToResults(contacts, coordResult, [
        {
          kind: "loading",
          id: "loading",
          title: "Searching addresses…",
        },
      ]);
    } else {
      goToResults = flattenGoToResults(contacts, coordResult, []);
    }

    syncGoToActiveIndex();
    setGoToHint("");
    renderGoToResults();

    if (!shouldGeocode) {
      if (q.length >= 3 && !contacts.length && !coordResult) {
        setGoToHint("No results found", true);
      }
      return;
    }

    const seq = goToGeocodeSeq;
    goToGeocodeTimer = setTimeout(function () {
      goToGeocodeTimer = null;
      if (seq !== goToGeocodeSeq || !goToPaletteOpen) return;
      if (String(elGoToInput?.value || "").trim() !== q) return;

      fetchGoToAddressResults(q).then(function (out) {
        if (seq !== goToGeocodeSeq || !goToPaletteOpen) return;
        if (String(elGoToInput?.value || "").trim() !== q) return;
        const contactsNow = buildGoToContactResults(q);
        const coordNow = buildGoToCoordResult(q);
        const addresses = out.addresses || [];
        goToResults = flattenGoToResults(contactsNow, coordNow, addresses);
        syncGoToActiveIndex();
        setGoToEmptyHint(contactsNow, coordNow, !!out.lookupFailed);
        renderGoToResults();
      });
    }, 300);
  }

  function openGoToPalette(initialText) {
    if (!elGoToOverlay || !elGoToInput) return;
    goToPaletteOpen = true;
    goToSubmitting = false;
    elGoToOverlay.hidden = false;
    elGoToInput.value = initialText || "";
    updateGoToResults(elGoToInput.value);
    requestAnimationFrame(function () {
      elGoToInput.focus();
      const len = elGoToInput.value.length;
      elGoToInput.setSelectionRange(len, len);
    });
  }

  function closeGoToPalette() {
    if (!elGoToOverlay || !elGoToInput) return;
    goToPaletteOpen = false;
    goToSubmitting = false;
    cancelGoToGeocode();
    goToResults = [];
    goToActiveIndex = -1;
    elGoToOverlay.hidden = true;
    elGoToInput.value = "";
    setGoToHint("");
    renderGoToResults();
  }

  function flyToLocation(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    pendingFitVisible = false;
    lockMoveFromCode = true;
    map.flyTo({
      center: [lon, lat],
      zoom: Math.max(map.getZoom(), 14),
      duration: 800,
    });
    return true;
  }

  function goToMarker(m) {
    if (!m || !Number.isFinite(m.lat) || !Number.isFinite(m.lon)) return false;
    selectMarker(m.uid, false);
    return flyToLocation(m.lat, m.lon);
  }

  async function fetchGoToAddressResults(query) {
    try {
      let url =
        "/api/map/geocode?q=" +
        encodeURIComponent(String(query || "").trim()) +
        "&limit=" +
        GO_TO_ADDRESS_LIMIT;
      const center = mapViewportCenter();
      if (center) {
        url +=
          "&nearLat=" +
          encodeURIComponent(String(center.lat)) +
          "&nearLon=" +
          encodeURIComponent(String(center.lon));
      }
      const controller = new AbortController();
      const timeoutId = setTimeout(function () {
        controller.abort();
      }, GO_TO_GEOCODE_TIMEOUT_MS);
      const r = await fetch(url, {
        credentials: "same-origin",
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!r.ok) {
        return { addresses: [], lookupFailed: true };
      }
      const data = await r.json();
      const parsed = parseGoToGeocodePayload(data);
      return {
        lookupFailed: parsed.lookupFailed,
        addresses: mapGoToGeocodeHits(parsed.hits, query),
      };
    } catch (_) {
      return { addresses: [], lookupFailed: true };
    }
  }

  function activateGoToResult(item) {
    if (!item || item.kind === "loading") return;
    if (item.kind === "contact" && item.marker) {
      goToMarker(item.marker);
      closeGoToPalette();
      return;
    }
    if (
      (item.kind === "coords" || item.kind === "address") &&
      Number.isFinite(item.lat) &&
      Number.isFinite(item.lon)
    ) {
      flyToLocation(item.lat, item.lon);
      closeGoToPalette();
    }
  }

  function moveGoToSelection(delta) {
    const selectable = goToResults.filter(function (item) {
      return item.kind !== "loading";
    });
    if (!selectable.length) return;
    let idx = goToActiveIndex;
    if (idx < 0) idx = delta > 0 ? 0 : selectable.length - 1;
    else {
      const current = goToResults[idx];
      let pos = selectable.indexOf(current);
      if (pos < 0) pos = 0;
      pos = Math.max(0, Math.min(selectable.length - 1, pos + delta));
      idx = goToResults.indexOf(selectable[pos]);
    }
    goToActiveIndex = idx;
    renderGoToResults();
  }

  async function submitGoToQuery() {
    if (!elGoToInput || goToSubmitting) return;
    const q = elGoToInput.value.trim();
    if (!q) {
      closeGoToPalette();
      return;
    }

    if (goToActiveIndex >= 0 && goToResults[goToActiveIndex]) {
      activateGoToResult(goToResults[goToActiveIndex]);
      return;
    }

    const coords = parseGoToCoords(q);
    if (coords) {
      flyToLocation(coords.lat, coords.lon);
      closeGoToPalette();
      return;
    }

    const matches = findCallsignMatches(q, 1);
    if (matches.length === 1) {
      goToMarker(matches[0]);
      closeGoToPalette();
      return;
    }

    const visibleContacts = goToResults.filter(function (item) {
      return item.kind === "contact" && item.marker;
    });
    if (visibleContacts.length === 1) {
      activateGoToResult(visibleContacts[0]);
      return;
    }

    goToSubmitting = true;
    setGoToHint("Searching…");
    const out = await fetchGoToAddressResults(q);
    goToSubmitting = false;
    if (out.addresses.length) {
      flyToLocation(out.addresses[0].lat, out.addresses[0].lon);
      closeGoToPalette();
      return;
    }
    if (visibleContacts.length) {
      activateGoToResult(visibleContacts[0]);
      return;
    }
    setGoToEmptyHint([], null, !!out.lookupFailed);
  }

  function removeMarkerLayers() {
    for (const id of [
      LABEL_PRIORITY_LAYER,
      LABEL_LAYER,
      ICON_LAYER_HIGH,
      CIRCLE_LAYER_HIGH,
      ICON_LAYER_LOW,
      CIRCLE_LAYER_LOW,
      ...LEGACY_MARKER_LAYER_IDS,
    ]) {
      if (map.getLayer(id)) {
        try {
          map.removeLayer(id);
        } catch (_) {}
      }
    }
    if (map.getSource(SOURCE_ID)) {
      try {
        map.removeSource(SOURCE_ID);
      } catch (_) {}
    }
    markerLayersReady = false;
  }

  function fitVisibleMarkers(animate) {
    const coords = getVisibleMarkers()
      .map(function (m) {
        return markerCoords(m);
      })
      .filter(Boolean)
      .map(function (pos) {
        return [pos.lon, pos.lat];
      });
    if (!coords.length) return false;

    pendingFitVisible = false;
    const opts = animate ? { duration: 800 } : {};

    if (coords.length === 1) {
      map.flyTo({ center: coords[0], zoom: 12, ...opts });
      return true;
    }

    const bounds = coords.reduce(
      (b, c) => b.extend(c),
      new maplibregl.LngLatBounds(coords[0], coords[0])
    );
    map.fitBounds(bounds, { padding: 80, maxZoom: 14, ...opts });
    return true;
  }

  function maybeFitVisibleOnLoad() {
    if (!pendingFitVisible) return;
    fitVisibleMarkers(true);
  }

  function setPanelLeftCollapsed(collapsed, opts) {
    elPanelLeft.classList.toggle("collapsed", collapsed);
    if (elExpandLeft) {
      elExpandLeft.classList.toggle("is-active", !collapsed);
      elExpandLeft.setAttribute("aria-expanded", collapsed ? "false" : "true");
      elExpandLeft.title = collapsed ? "Show channels" : "Hide channels";
      elExpandLeft.setAttribute("aria-label", elExpandLeft.title);
    }
    if (!opts || opts.persist !== false) {
      if (!isMapLayoutNarrow()) {
        localStorage.setItem(LS_PANEL_LEFT, collapsed ? "collapsed" : "open");
      }
    }
    if (!collapsed && isMapLayoutNarrow()) {
      setDetailStackCollapsed(true);
    }
  }

  function isDetailPaneOpen() {
    return elDetailStack && !elDetailStack.classList.contains("collapsed");
  }

  function syncDetailStackVisibility() {
    if (!elDetailStack) return;
    const hasSlots = detailSlots.length > 0 || auxDetailActive;
    const hasPinned = detailSlots.some(function (s) {
      return s.pinned;
    });

    if (!hasSlots) {
      elDetailStack.classList.add("collapsed");
      elExpandRight.hidden = true;
      detailPaneUserCollapsed = false;
      return;
    }

    if (detailPaneUserCollapsed) {
      elDetailStack.classList.add("collapsed");
      elExpandRight.hidden = !hasPinned && !hasSlots;
    } else {
      elDetailStack.classList.remove("collapsed");
      elExpandRight.hidden = true;
      if (isMapLayoutNarrow() && elPanelLeft && !elPanelLeft.classList.contains("collapsed")) {
        setPanelLeftCollapsed(true, { persist: false });
      }
    }
  }

  function setDetailStackCollapsed(collapsed) {
    if (!detailSlots.length && !auxDetailActive && collapsed) return;
    detailPaneUserCollapsed = collapsed;
    syncDetailStackVisibility();
    if (!collapsed) {
      closeMapPopup();
      if (isMapLayoutNarrow() && elPanelLeft && !elPanelLeft.classList.contains("collapsed")) {
        setPanelLeftCollapsed(true, { persist: false });
      }
    }
  }

  function detailPanelDefaultWidth() {
    return Math.min(DETAIL_PANEL_MIN_PX, window.innerWidth * DETAIL_PANEL_MIN_VW);
  }

  function detailPanelMinWidth() {
    const count = Math.max(1, detailSlots.length || 1);
    const perPaneMax = Math.floor(
      (window.innerWidth * DETAIL_PANEL_MAX_VW) / count
    );
    return Math.min(detailPanelDefaultWidth(), perPaneMax);
  }

  function detailPanelMaxWidth() {
    const count = Math.max(1, detailSlots.length || 1);
    return Math.floor((window.innerWidth * DETAIL_PANEL_MAX_VW) / count);
  }

  function clampDetailPanelWidth(width) {
    return Math.max(
      detailPanelMinWidth(),
      Math.min(detailPanelMaxWidth(), Math.round(width))
    );
  }

  function applyDetailPanelWidth(width, persist) {
    if (!elDetailStack || isMapLayoutNarrow()) return;
    const clamped = clampDetailPanelWidth(width);
    elDetailStack.style.setProperty("--map-detail-pane-width", clamped + "px");
    if (persist !== false) {
      localStorage.setItem(LS_DETAIL_PANEL_WIDTH, String(clamped));
    }
    if (map && typeof map.resize === "function") {
      map.resize();
    }
    return clamped;
  }

  function loadDetailPanelWidth() {
    if (!elDetailStack || isMapLayoutNarrow()) return;
    const stored = Number(localStorage.getItem(LS_DETAIL_PANEL_WIDTH));
    const initial = Number.isFinite(stored)
      ? stored
      : detailPanelDefaultWidth();
    applyDetailPanelWidth(initial, false);
  }

  function initDetailPanelResize() {
    if (!elDetailResize || !elDetailStack) return;

    let dragging = false;

    function onPointerMove(e) {
      if (!dragging) return;
      const totalWidth =
        window.innerWidth - DETAIL_PANEL_RIGHT_OFFSET - e.clientX;
      const count = Math.max(1, detailSlots.length || 1);
      const gap = 8 * (count - 1);
      const perPane = (totalWidth - gap) / count;
      applyDetailPanelWidth(perPane);
    }

    function stopDrag() {
      if (!dragging) return;
      dragging = false;
      elDetailResize.classList.remove("is-dragging");
      elDetailStack.classList.remove("is-resizing");
      document.body.classList.remove("map-detail-resizing");
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", stopDrag);
      document.removeEventListener("pointercancel", stopDrag);
      if (map && typeof map.resize === "function") {
        map.resize();
      }
    }

    elDetailResize.addEventListener("pointerdown", function (e) {
      if (elDetailStack.classList.contains("collapsed") || isMapLayoutNarrow()) {
        return;
      }
      e.preventDefault();
      dragging = true;
      elDetailResize.classList.add("is-dragging");
      elDetailStack.classList.add("is-resizing");
      document.body.classList.add("map-detail-resizing");
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", stopDrag);
      document.addEventListener("pointercancel", stopDrag);
    });

    elDetailResize.addEventListener("dblclick", function () {
      if (detailSlots.length) setDetailStackCollapsed(true);
    });

    window.addEventListener("resize", function () {
      if (isMapLayoutNarrow()) {
        elDetailStack.style.removeProperty("--map-detail-pane-width");
        return;
      }
      const stored = Number(localStorage.getItem(LS_DETAIL_PANEL_WIDTH));
      applyDetailPanelWidth(
        Number.isFinite(stored) ? stored : detailPanelDefaultWidth()
      );
    });
  }

  function restorePanelState() {
    if (isMapLayoutNarrow()) {
      setPanelLeftCollapsed(true, { persist: false });
    } else {
      setPanelLeftCollapsed(localStorage.getItem(LS_PANEL_LEFT) === "collapsed");
    }
    syncDetailStackVisibility();
  }

  function affiliationColor(aff) {
    return AFFILIATION_COLORS[aff] || AFFILIATION_COLORS.other;
  }

  function teamNameToColor(name) {
    const n = String(name || "").trim();
    if (!n) return null;
    if (ATAK_TEAM_COLORS[n]) return ATAK_TEAM_COLORS[n];
    return ATAK_TEAM_COLORS_LC[n.toLowerCase()] || null;
  }

  function normalizeMarkerColor(raw, fallback) {
    if (raw == null || raw === "") return fallback;
    const s = String(raw).trim();
    if (/^#[0-9a-f]{3,8}$/i.test(s)) {
      if (s.toLowerCase() === "#ffffff" || s.toLowerCase() === "#fff") return fallback;
      if (s.length === 4 || s.length === 7) return s;
      return s.slice(0, 7);
    }
    const n = Number(s);
    if (!Number.isFinite(n)) return fallback;
    if (n === -1 || (n >>> 0) === 0xffffffff) return fallback;
    const argb = n >>> 0;
    const a = (argb >>> 24) & 0xff;
    if (a === 0) return fallback;
    const r = (argb >>> 16) & 0xff;
    const g = (argb >>> 8) & 0xff;
    const b = argb & 0xff;
    return (
      "#" +
      r.toString(16).padStart(2, "0") +
      g.toString(16).padStart(2, "0") +
      b.toString(16).padStart(2, "0")
    );
  }

  function markerDisplayColor(m) {
    const fromAttr = normalizeMarkerColor(m && m.teamColor, null);
    if (fromAttr) return fromAttr;
    const fromTeam = teamNameToColor(m && m.team);
    if (fromTeam) return fromTeam;
    return affiliationColor(m && m.affiliation);
  }

  function isLightMarkerColor(hex) {
    const s = String(hex || "").trim();
    if (!/^#[0-9a-f]{6}$/i.test(s)) return false;
    const r = parseInt(s.slice(1, 3), 16);
    const g = parseInt(s.slice(3, 5), 16);
    const b = parseInt(s.slice(5, 7), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 210;
  }

  function markerDotStyle(m) {
    const color = markerDisplayColor(m);
    let style = "background:" + color;
    if (isLightMarkerColor(color)) {
      style += ";box-shadow:inset 0 0 0 1px rgba(100,116,139,0.75)";
    }
    return style;
  }

  function stripTakPrefix(name) {
    const n = String(name || "").trim();
    return n.toLowerCase().startsWith("tak_") ? n.slice(4) : n;
  }

  function stripChannelBehaviorSuffix(name) {
    let n = stripTakPrefix(name);
    const lower = n.toLowerCase();
    if (lower.endsWith("_read")) n = n.slice(0, -5);
    else if (lower.endsWith("_write")) n = n.slice(0, -6);
    return n.trim();
  }

  function isMapChannelName(name) {
    const n = String(name || "").trim();
    if (!n.toLowerCase().startsWith("tak_") || n.startsWith("_")) return false;
    const display = stripChannelBehaviorSuffix(n).toLowerCase();
    if (display.startsWith("__")) return false;
    if (display.includes("authentik")) return false;
    if (display.startsWith("cn=")) return false;
    return true;
  }

  function catalogChannelKeys() {
    return groupsCatalog
      .filter((g) => isMapChannelName(g.name))
      .map((g) => channelGroupKey(g.name))
      .filter(Boolean);
  }

  function isChannelFilterActive() {
    if (enabledGroups === null) return false;
    return true;
  }

  function syncEnabledGroupsWithCatalog() {
    const names = groupsCatalog.filter(isGroupInChannelScope).map((g) => g.name);
    const nameSet = new Set(names);
    if (enabledGroups && enabledGroups.size) {
      let pruned = false;
      for (const n of Array.from(enabledGroups)) {
        if (!nameSet.has(n)) {
          enabledGroups.delete(n);
          pruned = true;
        }
      }
      if (pruned) saveEnabledGroups();
    }
    if (!enabledGroups || enabledGroups.size === 0) return;
    if (!names.length) return;
  }

  function ensureEnabledGroupsInitialized() {
    if (enabledGroups) return;
    enabledGroups = new Set(groupsCatalog.filter(isGroupInChannelScope).map((g) => g.name));
  }

  function channelGroupKey(name) {
    const raw = String(name || "").trim();
    if (!raw) return "";
    if (raw.toLowerCase() === "unassigned" || raw.toLowerCase() === "__unassigned__") {
      return "__unassigned__";
    }
    const base = stripChannelBehaviorSuffix(name);
    if (!base || base.toLowerCase() === "unassigned") return "__unassigned__";
    return base.toLowerCase().replace(/\s+/g, " ").trim();
  }

  function markerChannelKeys(m) {
    return markerGroups(m)
      .map((g) => {
        const key = channelGroupKey(g);
        if (!key) return "";
        const match = groupsCatalog.find(
          (entry) => entry.baseKey === key || channelGroupKey(entry.name) === key
        );
        return match && match.baseKey ? match.baseKey : key;
      })
      .filter(Boolean);
  }

  function markerGroups(m) {
    if (Array.isArray(m.groups) && m.groups.length) return m.groups;
    return ["Unassigned"];
  }

  function isChannelKeyEnabled(key) {
    if (!enabledGroups) return true;
    if (!key) return false;
    const enabledKeys = enabledChannelKeysForFilter();
    if (!enabledKeys) return true;
    return enabledKeys.has(key);
  }

  function isGroupEnabled(groupName) {
    if (!enabledGroups) return true;
    return isChannelKeyEnabled(channelBaseKeyForName(groupName));
  }

  function markerVisible(m) {
    if (mapChannelScope === "member" && allowedMemberChannelKeys) {
      const memberKeys = markerChannelKeys(m);
      if (!memberKeys.length) return false;
      if (!memberKeys.some((k) => isMemberChannelKeyAllowed(k))) return false;
    }
    if (isChannelFilterActive()) {
      if (enabledGroups.size === 0) return false;
      const keys = markerChannelKeys(m);
      if (!keys.length) return false;
      if (!keys.some((k) => isChannelKeyEnabled(k))) return false;
    }
    return true;
  }

  function getVisibleMarkers() {
    const merged = new Map();
    const mission = getVisibleMissionMarkers();
    for (let i = 0; i < mission.length; i++) {
      merged.set(String(mission[i].uid), mission[i]);
    }
    const live = Array.from(markersByUid.values()).filter(markerVisible);
    for (let i = 0; i < live.length; i++) {
      merged.set(String(live[i].uid), live[i]);
    }
    return Array.from(merged.values());
  }

  function getViewportDeclutterMarkers() {
    if (!paddedViewportBounds) refreshPaddedViewportBounds();
    const bounds = paddedViewportBounds;
    return getVisibleMarkers().filter(function (m) {
      return markerInPaddedViewport(m, bounds);
    });
  }

  function labelDeclutterSignature(visible) {
    let originWeight = 0;
    for (let i = 0; i < visible.length; i++) {
      originWeight += markerOriginRank(visible[i]);
    }
    return (
      String(Math.round(map.getZoom() * 4)) +
      "|" +
      visible.length +
      "|" +
      originWeight +
      "|" +
      (selectedUid || "") +
      "|" +
      (lockedUid || "")
    );
  }

  function labelBoxOverlaps(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function estimateLabelBox(lon, lat, callsign) {
    const pt = map.project([lon, lat]);
    const zoom = map.getZoom();
    let density = 1.25;
    if (Number.isFinite(zoom)) {
      if (zoom >= 13) density = 1;
      else if (zoom >= 11) density = 1.08;
      else if (zoom >= 9) density = 1.15;
    }
    const label = String(callsign || "");
    const maxW = 144;
    const rawW = Math.max(24, label.length * 6.8);
    const lines = Math.max(1, Math.ceil(rawW / maxW));
    const w = (Math.min(rawW, maxW) + 8) * density;
    const h = (lines * 14.5 + 8) * density;
    const offsetY = 1.55 * 12 * density;
    return { x: pt.x - w / 2, y: pt.y - offsetY - h, w: w, h: h };
  }

  function markerIsSpiLikeForLabel(m) {
    const origin = String((m && m.origin) || "").toLowerCase();
    if (origin === "spi") return true;
    const type = String((m && m.type) || "")
      .trim()
      .toLowerCase();
    return type.indexOf("b-m-p-s-p-i") === 0 || type.indexOf("b-m-p-s-p-loc") === 0;
  }

  function recomputeLabelVisibility(visible) {
    const CELL = 64;
    const grid = new Map();

    function cellKey(cx, cy) {
      return cx + "," + cy;
    }

    function nearbyBoxes(box) {
      const x0 = Math.floor(box.x / CELL);
      const y0 = Math.floor(box.y / CELL);
      const x1 = Math.floor((box.x + box.w) / CELL);
      const y1 = Math.floor((box.y + box.h) / CELL);
      const out = [];
      for (let cx = x0 - 1; cx <= x1 + 1; cx++) {
        for (let cy = y0 - 1; cy <= y1 + 1; cy++) {
          const list = grid.get(cellKey(cx, cy));
          if (!list) continue;
          for (let i = 0; i < list.length; i++) out.push(list[i]);
        }
      }
      return out;
    }

    function placeBox(box) {
      const cx = Math.floor((box.x + box.w / 2) / CELL);
      const cy = Math.floor((box.y + box.h / 2) / CELL);
      const key = cellKey(cx, cy);
      let list = grid.get(key);
      if (!list) {
        list = [];
        grid.set(key, list);
      }
      list.push(box);
    }

    const sorted = visible.slice().sort(function (a, b) {
      const aPri = markerLabelDeclutterPriority(a);
      const bPri = markerLabelDeclutterPriority(b);
      if (aPri !== bPri) return aPri - bPri;
      const la = String(a.callsign || "").length;
      const lb = String(b.callsign || "").length;
      if (la !== lb) return la - lb;
      return String(a.callsign).localeCompare(String(b.callsign));
    });
    labelVisibleByUid.clear();
    for (let i = 0; i < sorted.length; i++) {
      const m = sorted[i];
      const forced =
        m.uid === selectedUid || m.uid === lockedUid || markerIsSpiLikeForLabel(m);
      const box = estimateLabelBox(m.lon, m.lat, m.callsign);
      if (forced) {
        labelVisibleByUid.set(m.uid, 1);
        placeBox(box);
        continue;
      }
      const nearby = nearbyBoxes(box);
      let overlap = false;
      for (let j = 0; j < nearby.length; j++) {
        if (labelBoxOverlaps(box, nearby[j])) {
          overlap = true;
          break;
        }
      }
      labelVisibleByUid.set(m.uid, overlap ? 0 : 1);
      if (!overlap) placeBox(box);
    }
  }

  function syncLabelVisibility(visible, options) {
    const forceRecompute = !!(options && options.forceRecompute);
    const key = labelDeclutterSignature(visible);
    if (forceRecompute || key !== labelDeclutterKey) {
      recomputeLabelVisibility(visible);
      labelDeclutterKey = key;
      return;
    }
    for (const uid of labelVisibleByUid.keys()) {
      if (!markersByUid.has(uid)) labelVisibleByUid.delete(uid);
    }
    for (let i = 0; i < visible.length; i++) {
      const m = visible[i];
      if (!labelVisibleByUid.has(m.uid)) {
        labelVisibleByUid.set(m.uid, 0);
      }
    }
  }

  function markerShowLabel(m) {
    if (m.uid === selectedUid || m.uid === lockedUid) return 1;
    if (!labelVisibleByUid.has(m.uid)) return 0;
    return labelVisibleByUid.get(m.uid);
  }

  function featureShowLabelValue(uid, marker) {
    if (uid === selectedUid || uid === lockedUid) return 1;
    if (marker) return markerShowLabel(marker);
    if (uid && labelVisibleByUid.has(uid)) return labelVisibleByUid.get(uid);
    return 0;
  }

  function buildDisplayFeature(feature) {
    const enriched = enrichFeatureChannelKeys(feature);
    const uid = enriched.properties && enriched.properties.uid;
    if (uid && shouldSuppressLiveMarkerGraphic(uid)) return null;
    const geom = enriched.geometry;
    const coords = geom && String(geom.type || "").toLowerCase() === "point" ? geom.coordinates : null;
    const marker = uid ? markersByUid.get(String(uid)) : null;
    if (
      coords &&
      window.TakMapMissions &&
      typeof window.TakMapMissions.isShapeDecorMarker === "function" &&
      window.TakMapMissions.isShapeDecorMarker(coords[0], coords[1], {
        type: (marker && marker.type) || enriched.properties.type || "",
        how: (marker && marker.how) || enriched.properties.how || "",
        icon: (marker && marker.iconsetpath) || enriched.properties.icon || "",
        iconsetpath: (marker && marker.iconsetpath) || enriched.properties.iconsetpath || "",
        callsign: (marker && marker.callsign) || enriched.properties.callsign || "",
      })
    ) {
      return null;
    }
    const display = markerIconDisplayProps(enriched.properties);
    return {
      type: enriched.type,
      geometry: enriched.geometry,
      properties: Object.assign({}, enriched.properties, display, {
        selected: uid === selectedUid,
        locked: uid === lockedUid,
        showLabel: featureShowLabelValue(uid, marker),
      }),
    };
  }

  function ensureDefaultGroupsEnabled() {
    if (!enabledGroups) return;
    const unassigned = groupsCatalog.find(function (g) {
      return channelGroupKey(g.name) === "__unassigned__";
    });
    if (!unassigned || enabledGroups.has(unassigned.name)) return;
    // Always surface Unassigned when markers land there (federation often does).
    enabledGroups.add(unassigned.name);
    saveEnabledGroups();
  }

  function mergeGroupsCatalog(incoming) {
    const list = Array.isArray(incoming) ? incoming : [];
    const prevNames = groupsCatalog
      .filter(isGroupInChannelScope)
      .map(function (g) {
        return g.name;
      })
      .sort()
      .join("\0");
    const byKey = new Map();

    for (const g of groupsCatalog) {
      if (!isGroupInChannelScope(g)) continue;
      const key = channelGroupKey(g.name);
      if (key) byKey.set(key, g);
    }
    for (const g of list) {
      if (!isGroupInChannelScope(g)) continue;
      const key = channelGroupKey(g.name);
      if (!key) continue;
      byKey.set(key, { ...byKey.get(key), ...g, name: g.name });
    }

    groupsCatalog = Array.from(byKey.values()).sort((a, b) =>
      String(a.displayName || stripChannelBehaviorSuffix(a.name)).localeCompare(
        String(b.displayName || stripChannelBehaviorSuffix(b.name))
      )
    );
    recomputeGroupCounts();
    syncEnabledGroupsFromStorage();
    if (enabledGroups) {
      enabledGroups = normalizeEnabledGroups(enabledGroups);
    }
    syncEnabledGroupsWithCatalog();
    ensureDefaultGroupsEnabled();
    const nextNames = groupsCatalog
      .filter(isGroupInChannelScope)
      .map(function (g) {
        return g.name;
      })
      .sort()
      .join("\0");
    if (nextNames !== prevNames) {
      renderLayerList();
    } else {
      updateLayerListCounts();
    }
  }

  function recomputeGroupCounts() {
    const counts = new Map();
    for (const m of markersByUid.values()) {
      for (const key of markerChannelKeys(m)) {
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    groupsCatalog = groupsCatalog
      .filter(isGroupInChannelScope)
      .map((g) => ({
        ...g,
        markerCount: counts.get(channelBaseKeyForName(g.name)) || 0,
      }));
  }

  function markerLayersComplete() {
    return (
      map.getSource(SOURCE_ID) &&
      map.getLayer(CIRCLE_LAYER_LOW) &&
      map.getLayer(ICON_LAYER_LOW) &&
      map.getLayer(CIRCLE_LAYER_HIGH) &&
      map.getLayer(ICON_LAYER_HIGH) &&
      map.getLayer(LABEL_LAYER) &&
      map.getLayer(LABEL_PRIORITY_LAYER)
    );
  }

  function markerSelectedExpr() {
    return ["==", ["get", "selected"], true];
  }

  function markerLockedExpr() {
    return ["==", ["get", "locked"], true];
  }

  function markerSelectedOrLockedExpr() {
    return ["any", markerSelectedExpr(), markerLockedExpr()];
  }

  function labelPriorityFilter() {
    return ["all", MARKER_FILTER, markerSelectedOrLockedExpr()];
  }

  function labelStandardFilter() {
    return [
      "all",
      MARKER_FILTER,
      ["!", markerSelectedOrLockedExpr()],
      ["any", ["==", ["get", "showLabel"], 1], ["==", ["get", "showLabel"], true]],
    ];
  }

  function syncSelectionToMapSource() {
    if (!map || !markerLayersReady) return false;
    if (!lastServerGeoJsonFull || !Array.isArray(lastServerGeoJsonFull.features)) {
      if (selectedUid || lockedUid) {
        [selectedUid, lockedUid].forEach(function (uid) {
          if (!uid) return;
          const m = markersByUid.get(String(uid));
          if (!m) return;
          const feature = buildMapFeatureFromMarker(m);
          if (feature) upsertCanonicalFeature(feature);
        });
      }
      if (!lastServerGeoJsonFull) return false;
    }

    let canonicalChanged = false;
    const canonicalFeatures = lastServerGeoJsonFull.features.map(function (feature) {
      const uid = feature.properties && feature.properties.uid;
      const selected = uid === selectedUid;
      const locked = uid === lockedUid;
      if (
        feature.properties &&
        feature.properties.selected === selected &&
        feature.properties.locked === locked
      ) {
        return feature;
      }
      canonicalChanged = true;
      return {
        type: feature.type,
        geometry: feature.geometry,
        properties: Object.assign({}, feature.properties, {
          selected: selected,
          locked: locked,
        }),
      };
    });

    if (canonicalChanged) {
      lastServerGeoJsonFull = Object.assign({}, lastServerGeoJsonFull, {
        features: canonicalFeatures,
      });
    }

    [selectedUid, lockedUid].forEach(function (uid) {
      if (!uid) return;
      if (canonicalFeatureHasUid(uid)) return;
      const m = markersByUid.get(String(uid));
      if (!m) return;
      const feature = buildMapFeatureFromMarker(m);
      if (feature) upsertCanonicalFeature(feature);
    });

    return syncFullGeoJsonToMapSource({ forceRecompute: true });
  }

  function applyOverviewRenderForZoom() {
    if (!map) return false;
    const zoom = map.getZoom();
    const next = Number.isFinite(zoom) && zoom < OVERVIEW_MODE_ZOOM;
    const changed = next !== overviewMode;
    overviewMode = next;
    if (!markerLayersReady) return changed;
    const radius = overviewMode
      ? ["case", markerSelectedExpr(), 9, 5]
      : ["case", markerSelectedExpr(), 16, 13];
    [CIRCLE_LAYER_LOW, CIRCLE_LAYER_HIGH].forEach(function (layerId) {
      if (!map.getLayer(layerId)) return;
      try {
        map.setPaintProperty(layerId, "circle-radius", radius);
      } catch (_) {}
    });
    return changed;
  }

  function scheduleViewportSync(options) {
    const opts = options || {};
    if (viewportSyncTimer) clearTimeout(viewportSyncTimer);
    viewportSyncTimer = setTimeout(function () {
      viewportSyncTimer = null;
      refreshPaddedViewportBounds();
      applyOverviewRenderForZoom();
      if (opts.server || !lastServerGeoJsonFull) {
        lastGeoFetchKey = "";
        runServerGeoJsonRefresh().finally(function () {
          if (lastServerGeoJsonFull) {
            syncFullGeoJsonToMapSource({ forceRecompute: true });
          }
        });
        return;
      }
      syncFullGeoJsonToMapSource({ forceRecompute: true });
    }, VIEWPORT_SYNC_DEBOUNCE_MS);
  }

  function ensureGeoReconcileTimer() {
    if (geoReconcileTimer) return;
    geoReconcileTimer = setInterval(function () {
      if (!markerLayersReady) return;
      refreshPaddedViewportBounds();
      lastGeoFetchKey = "";
      runServerGeoJsonRefresh();
    }, GEO_RECONCILE_MS);
  }

  function markerLabelLayout(options) {
    const opts = options || {};
    const priority = !!opts.priority;
    return {
      "text-field": [
        "case",
        ["any", ["==", ["get", "showLabel"], 1], ["==", ["get", "showLabel"], true]],
        ["get", "callsign"],
        "",
      ],
      "text-font": MAP_LABEL_FONT,
      "text-size": 14,
      "text-anchor": "bottom",
      "text-offset": [0, -1.55],
      // Always allow overlap — MapLibre collision reshuffles on every CoT move and
      // makes labels blink away/back. Visibility is gated by showLabel + zoom.
      "text-allow-overlap": true,
      "text-ignore-placement": true,
      "text-optional": false,
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "text-max-width": 12,
      "text-padding": 1.5,
      "text-letter-spacing": 0.01,
      "symbol-sort-key": ["get", "labelSort"],
      "symbol-z-order": "source",
    };
  }

  function markerLabelPaint() {
    return {
      "text-color": "#f8fafc",
      "text-halo-color": "rgba(0, 0, 0, 0.92)",
      "text-halo-width": 2,
      "text-halo-blur": 0.35,
      "text-opacity": 1,
    };
  }

  function markerCircleLayerSpec(id, drawTier) {
    return {
      id: id,
      type: "circle",
      source: SOURCE_ID,
      filter: [
        "all",
        MARKER_FILTER,
        ["==", ["get", "showCircle"], 1],
        ["==", ["get", "drawTier"], drawTier],
      ],
      layout: {
        "circle-sort-key": ["get", "renderSort"],
      },
      paint: {
        "circle-radius": ["case", markerSelectedExpr(), 16, 13],
        "circle-color": ["get", "color"],
        "circle-stroke-width": ["case", markerSelectedExpr(), 2, 1.5],
        "circle-stroke-color": "#ffffff",
        "circle-opacity": markerCircleOpacityPaint(),
      },
    };
  }

  function markerIconLayerSpec(id, drawTier) {
    return {
      id: id,
      type: "symbol",
      source: SOURCE_ID,
      filter: [
        "all",
        MARKER_FILTER,
        ["!=", ["get", "iconId"], ""],
        ["==", ["get", "drawTier"], drawTier],
      ],
      layout: {
        "icon-image": ["get", "iconId"],
        "icon-size": ["case", markerSelectedExpr(), 1.28, 1.1],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "icon-optional": true,
        "symbol-sort-key": ["get", "renderSort"],
      },
      paint: {
        "icon-opacity": markerIconOpacityPaint(),
        "icon-halo-color": "#ffffff",
        "icon-halo-width": 4,
      },
    };
  }

  function addMarkerLayers() {
    if (!map.isStyleLoaded()) return false;
    if (markerLayersComplete()) return true;
    try {
      if (map.getSource(SOURCE_ID)) removeMarkerLayers();

      map.addSource(SOURCE_ID, {
        type: "geojson",
        promoteId: "uid",
        data: { type: "FeatureCollection", features: [] },
      });

      map.addLayer(markerCircleLayerSpec(CIRCLE_LAYER_LOW, 0));
      map.addLayer(markerIconLayerSpec(ICON_LAYER_LOW, 0));
      map.addLayer(markerCircleLayerSpec(CIRCLE_LAYER_HIGH, 1));
      map.addLayer(markerIconLayerSpec(ICON_LAYER_HIGH, 1));

      map.addLayer({
        id: LABEL_LAYER,
        type: "symbol",
        source: SOURCE_ID,
        filter: withChannelFilter(labelStandardFilter()),
        layout: markerLabelLayout({ priority: false }),
        paint: markerLabelPaint(),
      });

      map.addLayer({
        id: LABEL_PRIORITY_LAYER,
        type: "symbol",
        source: SOURCE_ID,
        filter: withChannelFilter(labelPriorityFilter()),
        layout: markerLabelLayout({ priority: true }),
        paint: markerLabelPaint(),
      });
    } catch (err) {
      console.warn("[map] addMarkerLayers failed", err);
      removeMarkerLayers();
      return false;
    }

    markerLayersReady = true;
    ensureLiveShapeLayers();
    applyMapChannelLayerFilters();
    applyOverviewRenderForZoom();
    ensureGeoReconcileTimer();
    if (mapDiffFlushPending) {
      scheduleMapDiffFlush();
    }
    if (!lastServerGeoJsonFull && !serverGeoFetchInFlight) {
      runServerGeoJsonRefresh();
    }
    bindMarkerLayerHandlers();
    return true;
  }

  function ensureMarkerLayers() {
    if (!map.isStyleLoaded()) return false;
    if (markerLayersComplete()) {
      markerLayersReady = true;
      bindMarkerLayerHandlers();
      return true;
    }
    if (!addMarkerLayers()) return false;
    bindMarkerLayerHandlers();
    return true;
  }

  function disarmStackPickerOutsideClose() {
    if (!stackPickerOutsideListener) return;
    document.removeEventListener("mousedown", stackPickerOutsideListener, true);
    stackPickerOutsideListener = null;
  }

  function armStackPickerOutsideClose() {
    disarmStackPickerOutsideClose();
    stackPickerOutsideListener = function (ev) {
      if (!stackPickerEl) {
        disarmStackPickerOutsideClose();
        return;
      }
      if (stackPickerEl.contains(ev.target)) return;
      closeStackPicker();
    };
    setTimeout(function () {
      if (stackPickerOutsideListener) {
        document.addEventListener("mousedown", stackPickerOutsideListener, true);
      }
    }, 0);
  }

  function closeStackPicker() {
    if (!stackPickerEl) return;
    stackPickerEl.remove();
    stackPickerEl = null;
    disarmStackPickerOutsideClose();
  }

  function queryMarkersAtPoint(point, radiusPx) {
    const r = radiusPx == null ? 18 : radiusPx;
    const layers = markerHitLayers();
    if (
      window.TakMapMissions &&
      typeof window.TakMapMissions.getHitLayers === "function"
    ) {
      const missionLayers = window.TakMapMissions.getHitLayers();
      for (let i = 0; i < missionLayers.length; i++) {
        layers.push(missionLayers[i]);
      }
    }
    if (
      window.TakMapPackages &&
      typeof window.TakMapPackages.getHitLayers === "function"
    ) {
      const packageLayers = window.TakMapPackages.getHitLayers();
      for (let i = 0; i < packageLayers.length; i++) {
        layers.push(packageLayers[i]);
      }
    }
    if (!layers.length) return [];

    const bbox = [
      [point.x - r, point.y - r],
      [point.x + r, point.y + r],
    ];
    const features = map.queryRenderedFeatures(bbox, { layers: layers });
    const seen = new Set();
    const markers = [];
    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      const props = f.properties || {};
      const kind = props.kind;
      if (kind !== "marker" && kind !== "mission-feature" && kind !== "package-feature") continue;
      const uid = String(props.uid || "");
      if (!uid || seen.has(uid)) continue;
      seen.add(uid);
      const m = getMarkerRecord(uid);
      if (m) markers.push(m);
    }
    markers.sort(function (a, b) {
      const rankDiff = markerOriginRank(b) - markerOriginRank(a);
      if (rankDiff !== 0) return rankDiff;
      return String(a.callsign || a.uid).localeCompare(String(b.callsign || b.uid));
    });
    return markers;
  }

  function positionStackPicker(el, point) {
    const container = map.getContainer();
    container.appendChild(el);
    const maxLeft = Math.max(8, container.clientWidth - el.offsetWidth - 8);
    const maxTop = Math.max(8, container.clientHeight - el.offsetHeight - 8);
    el.style.left = Math.min(Math.max(8, point.x + 10), maxLeft) + "px";
    el.style.top = Math.min(Math.max(8, point.y + 10), maxTop) + "px";
  }

  function showStackPicker(markers, point) {
    closeStackPicker();
    closeMapPopup();

    const el = document.createElement("div");
    el.className = "map-stack-picker";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Select marker");

    const list = document.createElement("div");
    list.className = "map-stack-picker-list";
    for (let i = 0; i < markers.length; i++) {
      const m = markers[i];
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "map-stack-picker-item";
      appendMarkerListName(btn, m, m.callsign || m.uid);
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        closeStackPicker();
        selectMarker(m.uid, false);
      });
      list.appendChild(btn);
    }
    el.appendChild(list);

    el.addEventListener("click", function (ev) {
      ev.stopPropagation();
    });

    positionStackPicker(el, point);
    stackPickerEl = el;
    armStackPickerOutsideClose();
  }

  function handleMapFeatureClick(e) {
    if (
      window.TakMapGeofences &&
      typeof window.TakMapGeofences.isDrawing === "function" &&
      window.TakMapGeofences.isDrawing()
    ) {
      return;
    }
    if (e.originalEvent) e.originalEvent.stopPropagation();
    suppressMapBackgroundClickUntil = Date.now() + 150;
    const markers = queryMarkersAtPoint(e.point);
    if (!markers.length) return;
    if (markers.length === 1) {
      closeStackPicker();
      selectMarker(markers[0].uid, false);
      return;
    }
    showStackPicker(markers, e.point);
  }

  function onMarkerIconClick(e) {
    handleMapFeatureClick(e);
  }

  function onMarkerIconEnter() {
    map.getCanvas().style.cursor = "pointer";
  }

  function onMarkerIconLeave() {
    map.getCanvas().style.cursor = "";
  }

  function bindMarkerLayerHandlers() {
    for (const layer of MARKER_HIT_LAYER_IDS) {
      map.off("click", layer, onMarkerIconClick);
      map.off("mouseenter", layer, onMarkerIconEnter);
      map.off("mouseleave", layer, onMarkerIconLeave);
      map.on("click", layer, onMarkerIconClick);
      map.on("mouseenter", layer, onMarkerIconEnter);
      map.on("mouseleave", layer, onMarkerIconLeave);
    }
  }

  function updateVisibleCounts() {
    const total = lastGeoMeta.total || markersByUid.size;
    const mapped =
      lastGeoMeta.mapped != null
        ? lastGeoMeta.mapped
        : getVisibleMarkers().filter(function (m) {
            return markerCoords(m);
          }).length;
    const visible =
      lastGeoMeta.visible != null ? lastGeoMeta.visible : getVisibleMarkers().length;
    elVisibleCounts.textContent = mapped + " / " + total + " visible";
  }

  function fmtCoord(n) {
    return Number.isFinite(n) ? n.toFixed(5) : "—";
  }

  function markerCoordsDisplayText(lat, lon) {
    return formatCursorCoords(lat, lon);
  }

  function refreshOpenDetailPaneCoords() {
    if (!elDetailStack || !detailSlots.length) return;
    detailSlots.forEach(function (slot, index) {
      const m = markersByUid.get(slot.uid);
      if (!m) return;
      const pane = elDetailStack.querySelector(
        '.map-detail-pane[data-slot-index="' + index + '"]'
      );
      if (!pane) return;
      const coordsEl = pane.querySelector(".map-detail-coords-val");
      if (coordsEl) {
        coordsEl.textContent = markerCoordsDisplayText(m.lat, m.lon);
      }
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function staleAgeLabel(m) {
    if (!m.stale) return "";
    const staleMs = Date.parse(m.stale);
    if (!Number.isFinite(staleMs)) return "";
    const sec = Math.round((staleMs - Date.now()) / 1000);
    if (sec <= 0) {
      const graceSec = Math.round((staleMs + STALE_GRACE_MS - Date.now()) / 1000);
      if (graceSec > 0) return "stale · " + graceSec + "s left";
      return "stale";
    }
    if (sec < 120) return "stale in " + sec + "s";
    return "";
  }

  /** CoT point hae is meters above the WGS84 ellipsoid. */
  const METERS_TO_FEET = 3.280839895;

  function fmtHae(n) {
    const meters = Number(n);
    if (!Number.isFinite(meters)) return "—";
    return String(Math.round(meters * METERS_TO_FEET)) + " ft";
  }

  function fmtCourse(n) {
    return Number.isFinite(Number(n)) ? String(Math.round(Number(n))) + "°" : "—";
  }

  /** CoT track/point speed is meters per second. */
  const MPS_TO_MPH = 2.2369362921;

  function fmtSpeed(n) {
    const mps = Number(n);
    if (!Number.isFinite(mps)) return "—";
    return String(Math.round(mps * MPS_TO_MPH)) + " mph";
  }

  function isUnknownHae(n) {
    return Math.round(Number(n)) === 9999999;
  }

  const COPY_COORDS_ICON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>' +
    '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>' +
    "</svg>";

  const PIN_ICON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 17v5"></path>' +
    '<path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a3 3 0 0 0-6 0z"></path>' +
    "</svg>";

  const CLOSE_ICON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M18 6 6 18"></path>' +
    '<path d="m6 6 12 12"></path>' +
    "</svg>";

  const detailAgeTimers = new Map();

  function clearDetailAgeTimer(uid) {
    if (uid) {
      const t = detailAgeTimers.get(uid);
      if (t) clearInterval(t);
      detailAgeTimers.delete(uid);
      return;
    }
    for (const t of detailAgeTimers.values()) {
      clearInterval(t);
    }
    detailAgeTimers.clear();
  }

  function startDetailAgeTimer(paneEl, marker) {
    if (!paneEl || !marker) return;
    const el = paneEl.querySelector(".map-detail-updated");
    if (!el) return;

    function tick() {
      const current = markersByUid.get(marker.uid);
      if (!current) {
        clearDetailAgeTimer(marker.uid);
        return;
      }
      el.textContent = updatedAgeLabel(current.updatedAt);
    }

    if (detailAgeTimers.has(marker.uid)) {
      tick();
      return;
    }

    tick();
    detailAgeTimers.set(marker.uid, setInterval(tick, 1000));
  }

  function pinnedDetailCount() {
    let n = 0;
    for (let i = 0; i < detailSlots.length; i++) {
      if (detailSlots[i].pinned) n++;
    }
    return n;
  }

  function ensureDetailSlotForUid(uid) {
    const id = String(uid);
    let idx = detailSlots.findIndex(function (s) {
      return s.uid === id;
    });
    if (idx >= 0) {
      focusedDetailIndex = idx;
      return idx;
    }

    if (detailSlots.length === 0) {
      detailSlots.push({ uid: id, pinned: false });
      focusedDetailIndex = 0;
      return 0;
    }

    const unpinnedIdx = detailSlots.findIndex(function (s) {
      return !s.pinned;
    });
    if (unpinnedIdx >= 0) {
      detailSlots[unpinnedIdx].uid = id;
      focusedDetailIndex = unpinnedIdx;
      return unpinnedIdx;
    }

    if (detailSlots.length < MAX_DETAIL_SLOTS) {
      detailSlots.push({ uid: id, pinned: false });
      focusedDetailIndex = detailSlots.length - 1;
      return focusedDetailIndex;
    }

    showCopyToast("Unpin a details pane to view another marker");
    return -1;
  }

  function removeDetailSlotAt(index) {
    if (index < 0 || index >= detailSlots.length) return;
    const removed = detailSlots[index];
    clearDetailAgeTimer(removed.uid);
    detailSlots.splice(index, 1);
    if (selectedUid === removed.uid) {
      selectedUid = null;
    }
    if (focusedDetailIndex >= detailSlots.length) {
      focusedDetailIndex = Math.max(0, detailSlots.length - 1);
    }
    if (lockedUid === removed.uid) {
      clearLock();
    }
    syncDetailStackDom();
    syncDetailStackVisibility();
    syncSelectionToMapSource();
    applyDetailPanelWidth(
      Number(localStorage.getItem(LS_DETAIL_PANEL_WIDTH)) ||
        detailPanelDefaultWidth(),
      false
    );
  }

  function toggleDetailPin(index) {
    const slot = detailSlots[index];
    if (!slot) return;
    if (slot.pinned) {
      slot.pinned = false;
      if (selectedUid !== slot.uid) {
        removeDetailSlotAt(index);
      } else {
        syncDetailStackDom();
      }
      return;
    }
    if (pinnedDetailCount() >= MAX_DETAIL_SLOTS) {
      showCopyToast("At most " + MAX_DETAIL_SLOTS + " pinned details panes");
      return;
    }
    slot.pinned = true;
    syncDetailStackDom();
  }

  function formatDetailBatteryLabel(value) {
    if (value == null || value === "") return "";
    const n = Number(value);
    if (Number.isFinite(n)) return Math.round(n) + "%";
    const s = String(value).trim();
    if (!s) return "";
    return /%$/.test(s) ? s : s + "%";
  }

  function markerDetailMetaLine(m) {
    const parts = [];
    const platform = m && m.platform ? String(m.platform).trim() : "";
    if (platform) parts.push(platform);
    const battery = m ? formatDetailBatteryLabel(m.battery) : "";
    if (battery) parts.push(battery);
    return parts.join(" · ");
  }

  function syncDetailPaneTitle(pane, m) {
    const titleEl = pane.querySelector(".map-detail-title");
    const platformEl = pane.querySelector(".map-detail-platform");
    if (!titleEl) return;
    if (!m) {
      titleEl.textContent = "Details";
      if (platformEl) platformEl.hidden = true;
      return;
    }
    titleEl.textContent = m.callsign || "Details";
    if (platformEl) {
      const metaLine = markerDetailMetaLine(m);
      platformEl.textContent = metaLine;
      platformEl.hidden = !metaLine;
    }
  }

  function buildDetailPaneElement(slotIndex, slot) {
    const pane = document.createElement("aside");
    pane.className = "map-detail-pane";
    pane.setAttribute("data-slot-index", String(slotIndex));
    pane.setAttribute("aria-label", "Marker details");
    pane.innerHTML =
      '<div class="map-panel-head">' +
      '<button type="button" class="map-detail-pin-btn' +
      (slot.pinned ? " active" : "") +
      '" title="' +
      (slot.pinned ? "Unpin details" : "Pin details") +
      '" aria-pressed="' +
      (slot.pinned ? "true" : "false") +
      '" aria-label="' +
      (slot.pinned ? "Unpin details" : "Pin details") +
      '">' +
      PIN_ICON +
      "</button>" +
      '<div class="map-detail-title-wrap">' +
      '<h2 class="map-detail-title">Details</h2>' +
      '<div class="map-detail-platform" hidden></div>' +
      "</div>" +
      '<button type="button" class="map-detail-close-btn" title="Close details" aria-label="Close details">' +
      CLOSE_ICON +
      "</button>" +
      "</div>" +
      '<div class="map-detail-body"></div>' +
      '<div class="map-detail-actions">' +
      '<button type="button" class="map-btn map-btn-sm map-detail-center-btn">Center</button>' +
      '<button type="button" class="map-btn map-btn-sm map-detail-lock-btn">Lock</button>' +
      '<button type="button" class="map-btn map-btn-sm map-detail-copy-raw-btn">Copy RAW</button>' +
      "</div>";

    pane.querySelector(".map-detail-pin-btn").addEventListener("click", function () {
      toggleDetailPin(slotIndex);
    });
    const titleEl = pane.querySelector(".map-detail-title");
    if (titleEl) {
      titleEl.addEventListener("click", function () {
        if (!titleEl.classList.contains("is-client-action")) return;
        toggleDetailCallsignPanel(pane);
      });
      titleEl.addEventListener("keydown", function (e) {
        if (!titleEl.classList.contains("is-client-action")) return;
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        toggleDetailCallsignPanel(pane);
      });
    }
    pane.querySelector(".map-detail-close-btn").addEventListener("click", function () {
      removeDetailSlotAt(slotIndex);
    });
    pane.querySelector(".map-detail-center-btn").addEventListener("click", function () {
      const m = getMarkerRecord(slot.uid);
      if (!m) return;
      lockMoveFromCode = true;
      map.flyTo({ center: [m.lon, m.lat], zoom: Math.max(map.getZoom(), 12) });
    });
    pane.querySelector(".map-detail-lock-btn").addEventListener("click", function () {
      toggleLock(slot.uid);
    });
    pane.querySelector(".map-detail-copy-raw-btn").addEventListener("click", function () {
      const m = getMarkerRecord(slot.uid);
      const origin = m ? String(m.origin || "").toLowerCase() : "";

      function copyRawText(text) {
        return copyTextToClipboard(text).then(function () {
          showCopyToast("Copied raw CoT");
        });
      }

      if (m && m.cotRawXml && String(m.cotRawXml).trim()) {
        copyRawText(String(m.cotRawXml)).catch(function () {
          showCopyToast("Raw CoT not available");
        });
        return;
      }
      if (m && m.cotRaw != null) {
        const text =
          typeof m.cotRaw === "string" ? m.cotRaw : JSON.stringify(m.cotRaw, null, 2);
        copyRawText(text).catch(function () {
          showCopyToast("Raw CoT not available");
        });
        return;
      }

      let rawUrl = "/api/map/cot-raw?uid=" + encodeURIComponent(slot.uid);
      if (origin === "mission" && m && m.missionName) {
        rawUrl =
          "/api/map/missions/" +
          encodeURIComponent(m.missionName) +
          "/cot-raw?uid=" +
          encodeURIComponent(slot.uid);
      } else if (origin === "package" && m && m.packageHash) {
        rawUrl =
          "/api/map/packages/" +
          encodeURIComponent(m.packageHash) +
          "/cot-raw?uid=" +
          encodeURIComponent(slot.uid);
      }
      fetch(rawUrl)
        .then(function (resp) {
          if (!resp.ok) throw new Error("raw " + resp.status);
          return resp.text();
        })
        .then(function (text) {
          return copyRawText(text);
        })
        .catch(function () {
          showCopyToast("Raw CoT not available");
        });
    });

    return pane;
  }

  function markerDetailLinks(m) {
    return Array.isArray(m?.links)
      ? m.links.filter(function (link) {
          return link && isHttpDetailLinkUrl(link.url);
        })
      : [];
  }

  function markerDetailLinksForDisplay(m) {
    const videoUrl = markerVideoUrl(m);
    return markerDetailLinks(m).filter(function (link) {
      const url = String(link.url || "").trim();
      if (videoUrl && url === videoUrl) return false;
      if (videoUrl && isLikelyVideoStreamUrl(url)) return false;
      return true;
    });
  }

  function isHttpDetailLinkUrl(value) {
    return /^https?:\/\//i.test(String(value || "").trim());
  }

  function buildDetailLinkAnchorsHtml(links) {
    const list = Array.isArray(links) ? links : [];
    return list
      .map(function (link) {
        const url = String(link.url || "").trim();
        if (!isHttpDetailLinkUrl(url)) return "";
        const label = String(link.label || url).trim() || url;
        return (
          '<a class="map-detail-link" href="' +
          escapeHtml(url) +
          '" target="_blank" rel="noopener noreferrer">' +
          escapeHtml(label) +
          "</a>"
        );
      })
      .filter(Boolean)
      .join("");
  }

  function buildDetailLinksHtml(links) {
    const anchors = buildDetailLinkAnchorsHtml(links);
    if (!anchors) return "";
    return (
      '<section class="map-detail-links-section">' +
      '<div class="map-detail-links" data-detail-key="links">' +
      anchors +
      "</div></section>"
    );
  }

  function isPackageMarker(m) {
    return String(m?.origin || "").toLowerCase() === "package";
  }

  function markerPackageDisplayName(m) {
    const name = String(m?.packageName || "").trim();
    if (name) return name;
    const hash = String(m?.packageHash || "").trim();
    return hash ? hash.slice(0, 12) : "—";
  }

  function detailBodyStructureKey(m) {
    const groups = markerGroups(m);
    const linkCount = markerDetailLinksForDisplay(m).length;
    const videoUrl = markerVideoUrl(m);
    const pkg = isPackageMarker(m);
    return [
      pkg ? "pkg" : groups.length === 1 ? "1g" : "ng",
      pkg ? "p:" + markerPackageDisplayName(m) : "",
      m.team && String(m.team).trim() ? "t" : "",
      m.role && String(m.role).trim() ? "r" : "",
      isUnknownHae(m.hae) ? "" : "h",
      pkg ? "" : "c",
      pkg ? "" : "s",
      pkg ? "" : "u",
      linkCount ? "l" + linkCount : "",
      videoUrl ? "v" : "",
    ].join("|");
  }

  function markerVideoUrl(m) {
    const direct = String(m?.videoUrl || "").trim();
    if (direct && isHttpDetailLinkUrl(direct)) return direct;
    const links = markerDetailLinks(m);
    for (let i = 0; i < links.length; i++) {
      const url = String(links[i].url || "").trim();
      if (isHttpDetailLinkUrl(url) && isLikelyVideoStreamUrl(url)) return url;
    }
    return "";
  }

  function isLikelyVideoStreamUrl(url) {
    const u = String(url || "").toLowerCase();
    return (
      /\.m3u8(\?|$)/i.test(u) ||
      /\.(mp4|webm|ogg)(\?|$)/i.test(u) ||
      /\/playlist\.m3u8/i.test(u) ||
      /\/(live|stream|hls)\b/i.test(u)
    );
  }

  function isHlsStreamUrl(url) {
    return /\.m3u8(\?|$)/i.test(String(url || "")) || /\/playlist\.m3u8/i.test(String(url || ""));
  }

  function buildDetailVideoHtml(m) {
    const url = markerVideoUrl(m);
    if (!url) return "";
    return (
      '<section class="map-video-section">' +
      '<h3 class="map-remarks-title">Video</h3>' +
      '<div class="map-video-wrap" data-detail-key="video" data-video-url="' +
      escapeHtml(url) +
      '">' +
      '<video class="map-detail-video" controls playsinline muted preload="metadata"></video>' +
      '<div class="map-video-status" data-video-status></div>' +
      '<a class="map-detail-link map-video-open-link" href="' +
      escapeHtml(url) +
      '" target="_blank" rel="noopener noreferrer">Open Stream</a>' +
      "</div></section>"
    );
  }

  const PREFERENCE_CONFIG_CLIENTS = {
    "ATAK-CIV": true,
    "TAKAWARE-CIV": true,
    WINTAKTRACKER: true,
    ANDROIDTAKTRACKER: true,
  };
  const CLIENT_CTRL_NODERED_PREFIX = "nodered-";
  const CLIENT_CTRL_TLS_PREFIX = "tls:";
  const connectedSubsCache = { at: 0, list: null, promise: null };
  const CONNECTED_SUBS_TTL_MS = 8000;
  const detailClientUiByUid = Object.create(null);

  function mapCanControlClients() {
    return !!(
      window.TAK_PORTAL_MAP_DEFAULTS &&
      window.TAK_PORTAL_MAP_DEFAULTS.canControlClients
    );
  }

  function paneSlotUid(pane) {
    const idx = Number(pane && pane.getAttribute("data-slot-index"));
    const slot = Number.isFinite(idx) ? detailSlots[idx] : null;
    return slot && slot.uid != null ? String(slot.uid) : "";
  }

  function clientCtrlNorm(value) {
    return String(value || "").trim().toLowerCase();
  }

  function isExcludedConnectedSub(item) {
    const u = clientCtrlNorm(item && item.username);
    if (u.indexOf(CLIENT_CTRL_NODERED_PREFIX) === 0) return true;
    const c = clientCtrlNorm(item && item.callsign);
    return c.indexOf(CLIENT_CTRL_TLS_PREFIX) === 0;
  }

  function subscriptionClientId(sub) {
    if (!sub) return "";
    return (
      String(sub.clientUid || "").trim() ||
      String(sub.subscriptionUid || "").trim() ||
      String(sub.uid || "").trim()
    );
  }

  function subscriptionTakClient(sub) {
    if (!sub) return "";
    let raw = sub.takClient != null ? String(sub.takClient).trim() : "";
    if (!raw || raw === "—") {
      raw = sub.platform != null ? String(sub.platform).trim() : "";
    }
    return raw;
  }

  function isPreferenceConfigClient(sub) {
    return !!PREFERENCE_CONFIG_CLIENTS[subscriptionTakClient(sub).toUpperCase()];
  }

  function collectIdentityTokens() {
    const tokens = new Set();
    for (let i = 0; i < arguments.length; i++) {
      const s = clientCtrlNorm(arguments[i]);
      if (!s) continue;
      const matches = s.match(/\d{3,}/g) || [];
      for (let j = 0; j < matches.length; j++) tokens.add(matches[j]);
    }
    return tokens;
  }

  function callsignMatchesToken(callsign, token) {
    const cs = clientCtrlNorm(callsign);
    const t = clientCtrlNorm(token);
    if (!cs || !t) return false;
    if (cs === t) return true;
    if (cs.endsWith("-" + t) || cs.endsWith("_" + t)) return true;
    const parts = cs.split(/[-_./\s]+/).filter(Boolean);
    return parts.length > 0 && parts[parts.length - 1] === t;
  }

  function matchSubscriptionForMarker(marker, list) {
    if (!marker || !Array.isArray(list) || !list.length) return null;
    const uid = clientCtrlNorm(marker.uid);
    const cs = clientCtrlNorm(marker.callsign);
    let i;
    for (i = 0; i < list.length; i++) {
      const s = list[i];
      if (isExcludedConnectedSub(s)) continue;
      const clientUid = clientCtrlNorm(s.clientUid || s.uid);
      const subUid = clientCtrlNorm(s.subscriptionUid);
      if (uid && (uid === clientUid || uid === subUid)) return s;
    }
    const exact = [];
    for (i = 0; i < list.length; i++) {
      const s = list[i];
      if (isExcludedConnectedSub(s)) continue;
      const scs = clientCtrlNorm(s.callsign);
      const un = clientCtrlNorm(s.username);
      if (cs && (cs === scs || cs === un)) exact.push(s);
    }
    if (exact.length === 1) return exact[0];
    const tokenHits = [];
    for (i = 0; i < list.length; i++) {
      const s = list[i];
      if (isExcludedConnectedSub(s)) continue;
      const tokens = collectIdentityTokens(s.username, s.callsign);
      let hit = false;
      tokens.forEach(function (t) {
        if (callsignMatchesToken(cs, t)) hit = true;
      });
      if (hit) tokenHits.push(s);
    }
    if (tokenHits.length === 1) return tokenHits[0];
    return exact.length ? exact[0] : null;
  }

  function loadConnectedSubscriptions() {
    if (!mapCanControlClients()) return Promise.resolve([]);
    const now = Date.now();
    if (connectedSubsCache.list && now - connectedSubsCache.at < CONNECTED_SUBS_TTL_MS) {
      return Promise.resolve(connectedSubsCache.list);
    }
    if (connectedSubsCache.promise) return connectedSubsCache.promise;
    connectedSubsCache.promise = fetch("/api/tak/subscriptions", {
      headers: { Accept: "application/json" },
    })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || "subscriptions");
          return body;
        });
      })
      .then(function (body) {
        const list = body && Array.isArray(body.data) ? body.data : [];
        connectedSubsCache.at = Date.now();
        connectedSubsCache.list = list;
        connectedSubsCache.promise = null;
        return list;
      })
      .catch(function () {
        connectedSubsCache.promise = null;
        connectedSubsCache.at = Date.now();
        connectedSubsCache.list = connectedSubsCache.list || [];
        return connectedSubsCache.list;
      });
    return connectedSubsCache.promise;
  }

  function markerMayBeConnectedClient(m) {
    if (!m || isPackageMarker(m)) return false;
    const origin = String(m.origin || "").toLowerCase();
    if (origin === "package" || origin === "mission") return false;
    return true;
  }

  function clientDetailPanelsHtml() {
    if (!mapCanControlClients()) return "";
    return (
      '<section class="map-client-panel map-client-groups-panel" hidden>' +
      '<h3 class="map-client-panel-title">Group / Channel Control</h3>' +
      '<div class="map-client-panel-msg" data-groups-msg hidden></div>' +
      '<div class="map-client-panel-loading" data-groups-loading hidden>Loading groups…</div>' +
      '<div class="map-client-groups-list" data-groups-list></div>' +
      "</section>" +
      '<section class="map-client-panel map-client-callsign-panel" hidden>' +
      '<h3 class="map-client-panel-title">Send Callsign Preferences</h3>' +
      '<div class="map-client-panel-msg" data-pref-msg hidden></div>' +
      '<div class="map-client-panel-loading" data-pref-loading hidden>Loading configuration…</div>' +
      '<div class="map-client-pref-form" data-pref-form>' +
      '<label class="map-client-pref-field"><span>Callsign</span>' +
      '<input type="text" data-pref-callsign autocomplete="off" /></label>' +
      '<label class="map-client-pref-field"><span>Team</span>' +
      '<select data-pref-team></select></label>' +
      '<label class="map-client-pref-field"><span>Role</span>' +
      '<select data-pref-role></select></label>' +
      '<div class="map-client-pref-actions">' +
      '<button type="button" class="map-btn map-btn-sm" data-pref-send>Send Configuration</button>' +
      "</div></div></section>"
    );
  }

  function groupControlDisplayName(g) {
    if (!g) return "—";
    if (g.displayName) return g.displayName;
    const name = g.name || "";
    const mode = String(g.accessMode || g.typeLabel || "").toUpperCase();
    if (mode === "READ") return name + "_READ";
    if (mode === "WRITE") return name + "_WRITE";
    return name || "—";
  }

  function setSettingsToggleVisual(btn, on) {
    if (!btn) return;
    btn.classList.toggle("is-on", !!on);
    btn.classList.toggle("is-off", !on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  function fillClientSelect(selectEl, options, selectedValue, emptyLabel) {
    if (!selectEl) return;
    selectEl.innerHTML = "";
    if (emptyLabel) {
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = emptyLabel;
      selectEl.appendChild(empty);
    }
    (options || []).forEach(function (opt) {
      const o = document.createElement("option");
      if (opt && typeof opt === "object") {
        o.value = opt.value != null ? String(opt.value) : "";
        o.textContent = opt.label != null ? String(opt.label) : o.value;
      } else {
        o.value = String(opt);
        o.textContent = String(opt);
      }
      selectEl.appendChild(o);
    });
    const sel = selectedValue != null ? String(selectedValue).trim() : "";
    if (!sel) return;
    const match = Array.prototype.find.call(selectEl.options, function (opt) {
      return String(opt.value).toLowerCase() === sel.toLowerCase();
    });
    if (match) {
      selectEl.value = match.value;
      return;
    }
    const custom = document.createElement("option");
    custom.value = sel;
    custom.textContent = sel;
    selectEl.appendChild(custom);
    selectEl.value = sel;
  }

  function setClientPanelMsg(el, msg, kind) {
    if (!el) return;
    if (!msg) {
      el.textContent = "";
      el.hidden = true;
      el.className = "map-client-panel-msg";
      return;
    }
    el.hidden = false;
    el.textContent = msg;
    el.className =
      "map-client-panel-msg" +
      (kind === "error" ? " is-error" : kind === "success" ? " is-success" : "");
  }

  function detailClientState(uid) {
    const id = uid != null ? String(uid) : "";
    if (!id) return { groupsOpen: false, callsignOpen: false, clientId: "", canPref: false };
    if (!detailClientUiByUid[id]) {
      detailClientUiByUid[id] = {
        groupsOpen: false,
        callsignOpen: false,
        clientId: "",
        canPref: false,
      };
    }
    return detailClientUiByUid[id];
  }

  function applyDetailClientActionState(pane, wrap, connected, canPref) {
    const titleEl = pane.querySelector(".map-detail-title");
    if (titleEl) {
      titleEl.classList.toggle("is-client-action", !!(connected && canPref));
      if (connected && canPref) {
        titleEl.setAttribute("title", "Send callsign preferences");
        titleEl.setAttribute("role", "button");
        titleEl.setAttribute("tabindex", "0");
      } else {
        titleEl.removeAttribute("title");
        titleEl.removeAttribute("role");
        titleEl.removeAttribute("tabindex");
      }
    }
    const groupNodes = wrap
      ? wrap.querySelectorAll('[data-detail-row="groups"]')
      : [];
    for (let i = 0; i < groupNodes.length; i++) {
      groupNodes[i].classList.toggle("is-client-action", !!connected);
      if (connected) {
        groupNodes[i].setAttribute("title", "Toggle this user's groups");
        groupNodes[i].setAttribute("role", "button");
        groupNodes[i].setAttribute("tabindex", "0");
      } else {
        groupNodes[i].removeAttribute("title");
        groupNodes[i].removeAttribute("role");
        groupNodes[i].removeAttribute("tabindex");
      }
    }
  }

  function renderDetailGroupRows(listEl, groups) {
    if (!listEl) return;
    listEl.innerHTML = "";
    (groups || []).forEach(function (g) {
      const row = document.createElement("div");
      row.className =
        "map-client-group-row " + (g.active ? "is-on" : "is-off");
      row.setAttribute("data-group-name", g.name || "");
      row.setAttribute("data-access-mode", g.accessMode || g.typeLabel || "");
      if (g.locked) row.setAttribute("data-locked", "true");
      if (g.locked && g.active) row.classList.add("is-locked");

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "settings-toggle " + (g.active ? "is-on" : "is-off");
      toggle.setAttribute("aria-pressed", g.active ? "true" : "false");
      toggle.setAttribute("aria-label", "Enable " + groupControlDisplayName(g));
      if (g.locked && g.active) toggle.disabled = true;

      const name = document.createElement("span");
      name.className = "map-client-group-row-name";
      name.textContent = groupControlDisplayName(g);

      row.appendChild(toggle);
      row.appendChild(name);
      listEl.appendChild(row);
    });
  }

  function loadDetailGroups(wrap, clientId) {
    const loadingEl = wrap.querySelector("[data-groups-loading]");
    const msgEl = wrap.querySelector("[data-groups-msg]");
    const listEl = wrap.querySelector("[data-groups-list]");
    if (loadingEl) loadingEl.hidden = false;
    setClientPanelMsg(msgEl, "", "");
    return fetch("/api/tak/clients/" + encodeURIComponent(clientId) + "/groups", {
      headers: { Accept: "application/json" },
    })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || "Failed to load groups");
          return body;
        });
      })
      .then(function (data) {
        if (loadingEl) loadingEl.hidden = true;
        renderDetailGroupRows(listEl, data.groups || []);
        return data;
      })
      .catch(function (err) {
        if (loadingEl) loadingEl.hidden = true;
        setClientPanelMsg(msgEl, err.message || "Failed to load groups", "error");
        throw err;
      });
  }

  function applyDetailGroupToggle(wrap, row, clientId, active) {
    const toggle = row.querySelector(".settings-toggle");
    if (!toggle || toggle.disabled || wrap._groupToggleBusy) return;
    if (row.getAttribute("data-locked") === "true" && !active) {
      setClientPanelMsg(
        wrap.querySelector("[data-groups-msg]"),
        "The only assigned group cannot be disabled.",
        "error"
      );
      return;
    }
    const groupName = row.getAttribute("data-group-name") || "";
    const accessMode = row.getAttribute("data-access-mode") || "";
    const previous = !active;
    setSettingsToggleVisual(toggle, active);
    row.classList.toggle("is-on", active);
    row.classList.toggle("is-off", !active);
    wrap._groupToggleBusy = true;
    toggle.disabled = true;
    setClientPanelMsg(wrap.querySelector("[data-groups-msg]"), "", "");
    fetch("/api/tak/clients/" + encodeURIComponent(clientId) + "/groups", {
      method: "PUT",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        groupName: groupName,
        accessMode: accessMode,
        active: active,
      }),
    })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || "Failed to update group");
          return body;
        });
      })
      .then(function (data) {
        renderDetailGroupRows(wrap.querySelector("[data-groups-list]"), data.groups || []);
      })
      .catch(function (err) {
        setSettingsToggleVisual(toggle, previous);
        row.classList.toggle("is-on", previous);
        row.classList.toggle("is-off", !previous);
        setClientPanelMsg(
          wrap.querySelector("[data-groups-msg]"),
          err.message || "Failed to update group",
          "error"
        );
      })
      .finally(function () {
        const locked = row.getAttribute("data-locked") === "true";
        toggle.disabled = locked && toggle.classList.contains("is-on");
        wrap._groupToggleBusy = false;
      });
  }

  function loadDetailPreferenceConfig(wrap, clientId) {
    const loadingEl = wrap.querySelector("[data-pref-loading]");
    const msgEl = wrap.querySelector("[data-pref-msg]");
    const formEl = wrap.querySelector("[data-pref-form]");
    if (loadingEl) loadingEl.hidden = false;
    if (formEl) formEl.hidden = false;
    setClientPanelMsg(msgEl, "", "");
    return fetch(
      "/api/tak/clients/" + encodeURIComponent(clientId) + "/preference-config",
      { headers: { Accept: "application/json" } }
    )
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || "Failed to load configuration");
          return body;
        });
      })
      .then(function (data) {
        if (loadingEl) loadingEl.hidden = true;
        const callsignEl = wrap.querySelector("[data-pref-callsign]");
        if (callsignEl) callsignEl.value = data.callsign || "";
        fillClientSelect(
          wrap.querySelector("[data-pref-team]"),
          data.teamOptions || [],
          data.teamLabel || "",
          "Select team…"
        );
        fillClientSelect(
          wrap.querySelector("[data-pref-role]"),
          data.roleOptions || [],
          data.roleLabel || "Team Member",
          null
        );
        return data;
      })
      .catch(function (err) {
        if (loadingEl) loadingEl.hidden = true;
        setClientPanelMsg(msgEl, err.message || "Failed to load configuration", "error");
        throw err;
      });
  }

  function sendDetailPreferenceConfig(wrap, clientId) {
    if (wrap._prefSendBusy) return;
    const callsignEl = wrap.querySelector("[data-pref-callsign]");
    const teamEl = wrap.querySelector("[data-pref-team]");
    const roleEl = wrap.querySelector("[data-pref-role]");
    const sendBtn = wrap.querySelector("[data-pref-send]");
    const msgEl = wrap.querySelector("[data-pref-msg]");
    const callsign = callsignEl ? String(callsignEl.value || "").trim() : "";
    const teamLabel = teamEl ? String(teamEl.value || "").trim() : "";
    const roleLabel = roleEl ? String(roleEl.value || "").trim() : "";
    if (!callsign) {
      setClientPanelMsg(msgEl, "Callsign is required.", "error");
      return;
    }
    wrap._prefSendBusy = true;
    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.textContent = "Sending…";
    }
    setClientPanelMsg(msgEl, "", "");
    fetch(
      "/api/tak/clients/" + encodeURIComponent(clientId) + "/send-preference-config",
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          callsign: callsign,
          teamLabel: teamLabel,
          roleLabel: roleLabel,
        }),
      }
    )
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error((body && body.error) || "Failed to send configuration");
          return body;
        });
      })
      .then(function (data) {
        const label = data.callsign || data.username || "client";
        setClientPanelMsg(msgEl, "Configuration sent to " + label + ".", "success");
        showCopyToast("Configuration sent");
      })
      .catch(function (err) {
        setClientPanelMsg(msgEl, err.message || "Failed to send configuration", "error");
      })
      .finally(function () {
        wrap._prefSendBusy = false;
        if (sendBtn) {
          sendBtn.disabled = false;
          sendBtn.textContent = "Send Configuration";
        }
      });
  }

  function setDetailGroupsPanelOpen(pane, wrap, uid, open) {
    const panel = wrap.querySelector(".map-client-groups-panel");
    if (!panel) return;
    const state = detailClientState(uid);
    state.groupsOpen = !!open;
    panel.hidden = !open;
    if (open && state.clientId) loadDetailGroups(wrap, state.clientId).catch(function () {});
  }

  function setDetailCallsignPanelOpen(pane, wrap, uid, open) {
    const panel = wrap.querySelector(".map-client-callsign-panel");
    if (!panel) return;
    const state = detailClientState(uid);
    state.callsignOpen = !!open;
    panel.hidden = !open;
    if (open && state.clientId && state.canPref) {
      loadDetailPreferenceConfig(wrap, state.clientId).catch(function () {});
    }
  }

  function toggleDetailGroupsPanel(pane) {
    const uid = paneSlotUid(pane);
    const wrap = pane.querySelector(".map-detail-wrap");
    const state = detailClientState(uid);
    if (!wrap || !state.clientId) return;
    setDetailGroupsPanelOpen(pane, wrap, uid, !state.groupsOpen);
  }

  function toggleDetailCallsignPanel(pane) {
    const uid = paneSlotUid(pane);
    const wrap = pane.querySelector(".map-detail-wrap");
    const state = detailClientState(uid);
    if (!wrap || !state.clientId || !state.canPref) return;
    setDetailCallsignPanelOpen(pane, wrap, uid, !state.callsignOpen);
  }

  function bindDetailClientPanelEvents(pane, wrap) {
    wrap.addEventListener("click", function (e) {
      const groupHit = e.target.closest('[data-detail-row="groups"]');
      if (groupHit && wrap.contains(groupHit) && groupHit.classList.contains("is-client-action")) {
        toggleDetailGroupsPanel(pane);
        return;
      }
      const groupRow = e.target.closest(".map-client-group-row");
      if (groupRow && wrap.contains(groupRow)) {
        const uid = paneSlotUid(pane);
        const clientId = detailClientState(uid).clientId;
        const toggle = groupRow.querySelector(".settings-toggle");
        if (!clientId || !toggle || toggle.disabled) return;
        applyDetailGroupToggle(
          wrap,
          groupRow,
          clientId,
          !toggle.classList.contains("is-on")
        );
        return;
      }
      const sendBtn = e.target.closest("[data-pref-send]");
      if (sendBtn && wrap.contains(sendBtn)) {
        const uid = paneSlotUid(pane);
        const clientId = detailClientState(uid).clientId;
        if (clientId) sendDetailPreferenceConfig(wrap, clientId);
      }
    });
    wrap.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      const groupHit = e.target.closest('[data-detail-row="groups"]');
      if (!groupHit || !wrap.contains(groupHit) || !groupHit.classList.contains("is-client-action")) {
        return;
      }
      e.preventDefault();
      toggleDetailGroupsPanel(pane);
    });
  }

  function refreshDetailClientConnection(pane, wrap, uid) {
    const m = getMarkerRecord(uid);
    const state = detailClientState(uid);
    if (!markerMayBeConnectedClient(m)) {
      state.clientId = "";
      state.canPref = false;
      applyDetailClientActionState(pane, wrap, false, false);
      setDetailGroupsPanelOpen(pane, wrap, uid, false);
      setDetailCallsignPanelOpen(pane, wrap, uid, false);
      return;
    }
    const gen = (Number(wrap._clientResolveGen) || 0) + 1;
    wrap._clientResolveGen = gen;
    loadConnectedSubscriptions().then(function (list) {
      if (wrap._clientResolveGen !== gen) return;
      if (paneSlotUid(pane) !== String(uid)) return;
      const sub = matchSubscriptionForMarker(m, list);
      const clientId = subscriptionClientId(sub);
      const canPref = !!(sub && isPreferenceConfigClient(sub));
      state.clientId = clientId;
      state.canPref = canPref;
      applyDetailClientActionState(pane, wrap, !!clientId, canPref);
      if (!clientId) {
        setDetailGroupsPanelOpen(pane, wrap, uid, false);
        setDetailCallsignPanelOpen(pane, wrap, uid, false);
        return;
      }
      if (state.groupsOpen) setDetailGroupsPanelOpen(pane, wrap, uid, true);
      if (state.callsignOpen && canPref) setDetailCallsignPanelOpen(pane, wrap, uid, true);
      else if (!canPref) setDetailCallsignPanelOpen(pane, wrap, uid, false);
    });
  }

  function wireDetailClientControls(pane, bodyEl, uid) {
    if (!mapCanControlClients() || !pane || !bodyEl) return;
    const wrap = bodyEl.querySelector(".map-detail-wrap");
    if (!wrap) return;
    if (wrap.getAttribute("data-client-ui-bound") !== "1") {
      wrap.setAttribute("data-client-ui-bound", "1");
      bindDetailClientPanelEvents(pane, wrap);
    }
    refreshDetailClientConnection(pane, wrap, uid);
  }

  function buildDetailBodyHtml(m) {
    const packageMarker = isPackageMarker(m);
    const groups = markerGroups(m);
    const groupHtml = groups
      .map(function (g) {
        return '<span class="map-chip">' + escapeHtml(stripTakPrefix(g)) + "</span>";
      })
      .join(" ");
    const remarksText = m.remarks ? String(m.remarks).trim() : "";
    const coordText = markerCoordsDisplayText(m.lat, m.lon);
    const team = m.team ? String(m.team).trim() : "";
    const role = m.role ? String(m.role).trim() : "";
    const kvRows = [];
    if (packageMarker) {
      kvRows.push(
        detailKvRow(
          "Data Package",
          '<span data-detail-key="package">' +
            escapeHtml(markerPackageDisplayName(m)) +
            "</span>"
        )
      );
    } else {
      kvRows.push(
        detailKvRow(
          groups.length === 1 ? "Group" : "Groups",
          '<span data-detail-key="groups">' + (groupHtml || "—") + "</span>",
          "map-chips",
          "groups"
        )
      );
    }
    if (team) {
      kvRows.push(
        detailKvRow("Team", '<span data-detail-key="team">' + escapeHtml(team) + "</span>")
      );
    }
    if (role) {
      kvRows.push(
        detailKvRow("Role", '<span data-detail-key="role">' + escapeHtml(role) + "</span>")
      );
    }
    kvRows.push(
      detailKvRow(
        "Lat / Lon",
        '<span class="map-detail-coords-val">' +
          coordText +
          "</span>" +
          '<button type="button" class="map-copy-btn map-copy-coords-btn" title="Copy coordinates" aria-label="Copy coordinates">' +
          COPY_COORDS_ICON +
          "</button>",
        "map-coords-row"
      )
    );
    if (!isUnknownHae(m.hae)) {
      kvRows.push(
        detailKvRow(
          "HAE",
          '<span data-detail-key="hae">' + fmtHae(m.hae) + "</span>"
        )
      );
    }
    if (!packageMarker) {
      kvRows.push(
        detailKvRow(
          "Course",
          '<span data-detail-key="course">' + escapeHtml(fmtCourse(m.course)) + "</span>"
        ),
        detailKvRow(
          "Speed",
          '<span data-detail-key="speed">' + escapeHtml(fmtSpeed(m.speed)) + "</span>"
        ),
        detailKvRow(
          "Last Updated",
          '<span class="map-detail-updated">' +
            escapeHtml(updatedAgeLabel(m.updatedAt)) +
            "</span>"
        )
      );
    }

    return (
      '<div class="map-detail-wrap" data-detail-structure="' +
      escapeHtml(detailBodyStructureKey(m)) +
      '">' +
      '<dl class="map-kv map-kv-compact">' +
      kvRows.join("") +
      "</dl>" +
      clientDetailPanelsHtml() +
      '<section class="map-remarks-section">' +
      '<h3 class="map-remarks-title">Remarks</h3>' +
      '<div class="map-remarks-box' +
      (remarksText ? "" : " empty") +
      '" data-detail-key="remarks">' +
      escapeHtml(remarksText || "No remarks.") +
      "</div></section>" +
      buildDetailVideoHtml(m) +
      buildDetailLinksHtml(markerDetailLinksForDisplay(m)) +
      "</div>"
    );
  }

  function wireDetailCoordsCopy(bodyEl, uid) {
    const copyBtn = bodyEl.querySelector(".map-copy-coords-btn");
    if (!copyBtn || copyBtn.dataset.wired === "1") return;
    copyBtn.dataset.wired = "1";
    copyBtn.addEventListener("click", function () {
      const current = markersByUid.get(uid);
      if (!current) return;
      const text = cursorCoordsCopyText(current.lat, current.lon);
      copyTextToClipboard(text).then(
        function () {
          showCopyToast("Copied " + text);
        },
        function () {
          showCopyToast(text);
        }
      );
    });
  }

  let hlsScriptPromise = null;
  const detailVideoPlayers = new WeakMap();

  function loadHlsScript() {
    if (window.Hls) return Promise.resolve(window.Hls);
    if (hlsScriptPromise) return hlsScriptPromise;
    hlsScriptPromise = new Promise(function (resolve, reject) {
      const existing = document.querySelector("script[data-tak-hls]");
      if (existing) {
        existing.addEventListener("load", function () {
          resolve(window.Hls);
        });
        existing.addEventListener("error", reject);
        return;
      }
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js";
      script.async = true;
      script.dataset.takHls = "1";
      script.onload = function () {
        resolve(window.Hls);
      };
      script.onerror = function () {
        hlsScriptPromise = null;
        reject(new Error("Failed to load HLS library"));
      };
      document.head.appendChild(script);
    });
    return hlsScriptPromise;
  }

  function destroyDetailVideoPlayers(rootEl) {
    if (!rootEl) return;
    const wraps = rootEl.querySelectorAll
      ? rootEl.querySelectorAll("[data-detail-key='video']")
      : [];
    for (let i = 0; i < wraps.length; i++) {
      const wrap = wraps[i];
      const state = detailVideoPlayers.get(wrap);
      if (state && state.hls && typeof state.hls.destroy === "function") {
        try {
          state.hls.destroy();
        } catch (_) {}
      }
      detailVideoPlayers.delete(wrap);
      const video = wrap.querySelector("video");
      if (video) {
        try {
          video.pause();
          video.removeAttribute("src");
          video.load();
        } catch (_) {}
      }
    }
  }

  function setDetailVideoStatus(wrap, text, isError) {
    const statusEl = wrap.querySelector("[data-video-status]");
    if (!statusEl) return;
    statusEl.textContent = text || "";
    statusEl.classList.toggle("is-error", !!isError);
    statusEl.hidden = !text;
  }

  function attachNativeVideo(videoEl, url) {
    videoEl.src = url;
    return videoEl.play().catch(function () {
      // Autoplay may be blocked; controls remain available.
    });
  }

  function wireDetailVideoPlayer(bodyEl, uid) {
    if (!bodyEl) return;
    const wrap = bodyEl.querySelector('[data-detail-key="video"]');
    if (!wrap) return;
    const url = String(wrap.getAttribute("data-video-url") || "").trim();
    const videoEl = wrap.querySelector("video.map-detail-video");
    if (!url || !videoEl) return;

    const existing = detailVideoPlayers.get(wrap);
    if (existing && existing.url === url && existing.wired) return;

    if (existing && existing.hls && typeof existing.hls.destroy === "function") {
      try {
        existing.hls.destroy();
      } catch (_) {}
    }

    detailVideoPlayers.set(wrap, { url: url, wired: true, hls: null });
    setDetailVideoStatus(wrap, "Loading stream…", false);

    if (isHlsStreamUrl(url)) {
      if (videoEl.canPlayType("application/vnd.apple.mpegurl")) {
        attachNativeVideo(videoEl, url);
        setDetailVideoStatus(wrap, "", false);
        return;
      }
      loadHlsScript()
        .then(function (Hls) {
          if (!Hls || !Hls.isSupported()) {
            setDetailVideoStatus(
              wrap,
              "HLS not supported in this browser. Use Open stream.",
              true
            );
            return;
          }
          const current = getMarkerRecord(uid);
          const stillUrl = markerVideoUrl(current) || url;
          if (stillUrl !== url) return;
          const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: true,
          });
          hls.loadSource(url);
          hls.attachMedia(videoEl);
          hls.on(Hls.Events.MANIFEST_PARSED, function () {
            setDetailVideoStatus(wrap, "", false);
            videoEl.play().catch(function () {});
          });
          hls.on(Hls.Events.ERROR, function (_event, data) {
            if (!data || !data.fatal) return;
            setDetailVideoStatus(
              wrap,
              "Stream unavailable. Try Open stream.",
              true
            );
          });
          detailVideoPlayers.set(wrap, { url: url, wired: true, hls: hls });
        })
        .catch(function () {
          setDetailVideoStatus(
            wrap,
            "Could not load video player. Try Open stream.",
            true
          );
        });
      return;
    }

    attachNativeVideo(videoEl, url);
    setDetailVideoStatus(wrap, "", false);
  }

  function patchDetailPaneBody(bodyEl, m) {
    const wrap = bodyEl.querySelector(".map-detail-wrap");
    if (!wrap) return false;

    const coordsEl = bodyEl.querySelector(".map-detail-coords-val");
    if (coordsEl) {
      coordsEl.textContent = markerCoordsDisplayText(m.lat, m.lon);
    }

    const haeEl = bodyEl.querySelector('[data-detail-key="hae"]');
    if (haeEl) haeEl.textContent = fmtHae(m.hae);

    const courseEl = bodyEl.querySelector('[data-detail-key="course"]');
    if (courseEl) courseEl.textContent = fmtCourse(m.course);

    const speedEl = bodyEl.querySelector('[data-detail-key="speed"]');
    if (speedEl) speedEl.textContent = fmtSpeed(m.speed);

    const groupsEl = bodyEl.querySelector('[data-detail-key="groups"]');
    if (groupsEl) {
      const groups = markerGroups(m);
      const groupHtml = groups
        .map(function (g) {
          return '<span class="map-chip">' + escapeHtml(stripTakPrefix(g)) + "</span>";
        })
        .join(" ");
      groupsEl.innerHTML = groupHtml || "—";
    }

    const packageEl = bodyEl.querySelector('[data-detail-key="package"]');
    if (packageEl) {
      packageEl.textContent = markerPackageDisplayName(m);
    }

    const teamEl = bodyEl.querySelector('[data-detail-key="team"]');
    if (teamEl) teamEl.textContent = m.team ? String(m.team).trim() : "";

    const roleEl = bodyEl.querySelector('[data-detail-key="role"]');
    if (roleEl) roleEl.textContent = m.role ? String(m.role).trim() : "";

    const remarksEl = bodyEl.querySelector('[data-detail-key="remarks"]');
    if (remarksEl) {
      const remarksText = m.remarks ? String(m.remarks).trim() : "";
      remarksEl.textContent = remarksText || "No remarks.";
      remarksEl.classList.toggle("empty", !remarksText);
    }

    const linksEl = bodyEl.querySelector('[data-detail-key="links"]');
    const linksSection = bodyEl.querySelector(".map-detail-links-section");
    const links = markerDetailLinksForDisplay(m);
    if (links.length) {
      const anchors = buildDetailLinkAnchorsHtml(links);
      if (linksEl) {
        linksEl.innerHTML = anchors;
      } else if (anchors) {
        const wrap = bodyEl.querySelector(".map-detail-wrap");
        if (wrap) wrap.insertAdjacentHTML("beforeend", buildDetailLinksHtml(links));
      }
    } else if (linksSection) {
      linksSection.remove();
    }

    const videoUrl = markerVideoUrl(m);
    const videoSection = bodyEl.querySelector(".map-video-section");
    if (videoUrl) {
      const wrap = bodyEl.querySelector('[data-detail-key="video"]');
      if (wrap) {
        wrap.setAttribute("data-video-url", videoUrl);
        const openLink = wrap.querySelector(".map-video-open-link");
        if (openLink) openLink.href = videoUrl;
      } else {
        const detailWrap = bodyEl.querySelector(".map-detail-wrap");
        if (detailWrap) {
          const remarks = detailWrap.querySelector(".map-remarks-section");
          const html = buildDetailVideoHtml(m);
          if (remarks) remarks.insertAdjacentHTML("afterend", html);
          else detailWrap.insertAdjacentHTML("beforeend", html);
        }
      }
    } else if (videoSection) {
      destroyDetailVideoPlayers(videoSection);
      videoSection.remove();
    }

    const updatedEl = bodyEl.querySelector(".map-detail-updated");
    if (updatedEl) updatedEl.textContent = updatedAgeLabel(m.updatedAt);

    return true;
  }

  function syncDetailStackDom() {
    if (!elDetailStack) return;
    const resizeHandle = elDetailResize;
    const geofencePane = document.getElementById("mapGeofenceDetailPane");
    elDetailStack.innerHTML = "";
    if (resizeHandle) elDetailStack.appendChild(resizeHandle);

    detailSlots.forEach(function (slot, index) {
      const pane = buildDetailPaneElement(index, slot);
      elDetailStack.appendChild(pane);
      renderDetailPane(index);
    });
    if (geofencePane) elDetailStack.appendChild(geofencePane);
  }

  function renderDetailPane(slotIndex) {
    if (!elDetailStack) return;
    const slot = detailSlots[slotIndex];
    if (!slot) return;
    const pane = elDetailStack.querySelector(
      '.map-detail-pane[data-slot-index="' + slotIndex + '"]'
    );
    if (!pane) return;
    const m = getMarkerRecord(slot.uid);
    const bodyEl = pane.querySelector(".map-detail-body");
    const actionsEl = pane.querySelector(".map-detail-actions");
    const pinBtn = pane.querySelector(".map-detail-pin-btn");
    const lockBtn = pane.querySelector(".map-detail-lock-btn");

    if (!m) {
      syncDetailPaneTitle(pane, null);
      if (bodyEl) {
        bodyEl.innerHTML =
          '<div class="map-detail-empty">Marker no longer available.</div>';
      }
      if (actionsEl) actionsEl.hidden = true;
      clearDetailAgeTimer(slot.uid);
      return;
    }

    syncDetailPaneTitle(pane, m);
    if (actionsEl) actionsEl.hidden = false;
    if (pinBtn) {
      pinBtn.classList.toggle("active", !!slot.pinned);
      pinBtn.setAttribute("aria-pressed", slot.pinned ? "true" : "false");
      pinBtn.title = slot.pinned ? "Unpin details" : "Pin details";
    }
    if (lockBtn) {
      const lockActive = lockedUid === m.uid;
      lockBtn.classList.toggle("active", lockActive);
      lockBtn.setAttribute("aria-pressed", lockActive ? "true" : "false");
    }

    if (bodyEl) {
      const wrap = bodyEl.querySelector(".map-detail-wrap");
      const structureKey = detailBodyStructureKey(m);
      if (
        wrap &&
        wrap.getAttribute("data-detail-structure") === structureKey &&
        patchDetailPaneBody(bodyEl, m)
      ) {
        wireDetailCoordsCopy(bodyEl, slot.uid);
        wireDetailVideoPlayer(bodyEl, slot.uid);
        wireDetailClientControls(pane, bodyEl, slot.uid);
      } else {
        destroyDetailVideoPlayers(bodyEl);
        bodyEl.innerHTML = buildDetailBodyHtml(m);
        wireDetailCoordsCopy(bodyEl, slot.uid);
        wireDetailVideoPlayer(bodyEl, slot.uid);
        wireDetailClientControls(pane, bodyEl, slot.uid);
      }
    }

    startDetailAgeTimer(pane, m);
  }

  function renderAllDetailSlots() {
    if (!detailSlots.length) {
      clearDetailAgeTimer();
      syncDetailStackDom();
      syncDetailStackVisibility();
      return;
    }
    detailSlots.forEach(function (_slot, index) {
      renderDetailPane(index);
    });
    syncDetailStackVisibility();
  }

  function updatedAgeLabel(updatedAt) {
    if (!updatedAt) return "—";
    const t = Date.parse(updatedAt);
    if (!Number.isFinite(t)) return "—";
    const totalSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (totalSec < 60) return totalSec + " sec ago";
    if (totalSec < 3600) {
      const min = Math.floor(totalSec / 60);
      const sec = totalSec % 60;
      return min + "m " + sec + " sec ago";
    }
    if (totalSec < 86400) {
      const hr = Math.floor(totalSec / 3600);
      const min = Math.floor((totalSec % 3600) / 60);
      return min > 0 ? hr + "h " + min + "m ago" : hr + "h ago";
    }
    const days = Math.floor(totalSec / 86400);
    const hr = Math.floor((totalSec % 86400) / 3600);
    return hr > 0 ? days + "d " + hr + "h ago" : days + "d ago";
  }

  function detailKvRow(label, valueHtml, ddClass, rowKey) {
    const cls = ddClass ? ' class="' + ddClass + '"' : "";
    const rowAttr = rowKey ? ' data-detail-row="' + escapeHtml(rowKey) + '"' : "";
    return (
      "<dt" +
      rowAttr +
      ">" +
      escapeHtml(label) +
      "</dt><dd" +
      cls +
      rowAttr +
      ">" +
      valueHtml +
      "</dd>"
    );
  }

  function lockedMarkerCoords() {
    const m = lockedUid ? markersByUid.get(lockedUid) : null;
    if (!m || !Number.isFinite(m.lon) || !Number.isFinite(m.lat)) return null;
    return [m.lon, m.lat];
  }

  function clearLock() {
    lockedUid = null;
    updateLockButtonsUi();
    syncSelectionToMapSource();
  }

  function updateLockButtonsUi() {
    if (!elDetailStack) return;
    detailSlots.forEach(function (slot, index) {
      const pane = elDetailStack.querySelector(
        '.map-detail-pane[data-slot-index="' + index + '"]'
      );
      if (!pane) return;
      const lockBtn = pane.querySelector(".map-detail-lock-btn");
      if (!lockBtn) return;
      const lockActive = lockedUid === slot.uid;
      lockBtn.classList.toggle("active", lockActive);
      lockBtn.setAttribute("aria-pressed", lockActive ? "true" : "false");
    });
  }

  function toggleLock(uid) {
    const id = uid != null ? String(uid) : selectedUid;
    const m = id ? getMarkerRecord(id) : null;
    if (!m || !Number.isFinite(m.lon) || !Number.isFinite(m.lat)) return;
    if (lockedUid === m.uid) {
      clearLock();
      return;
    }
    lockedUid = m.uid;
    lockMoveFromCode = true;
    map.easeTo({ center: [m.lon, m.lat], zoom: map.getZoom(), duration: 400 });
    updateLockButtonsUi();
    syncSelectionToMapSource();
  }

  function trackLockedMarker(m) {
    if (!lockedUid || !m || m.uid !== lockedUid) return;
    if (!Number.isFinite(m.lon) || !Number.isFinite(m.lat)) return;
    lockMoveFromCode = true;
    map.easeTo({ center: [m.lon, m.lat], zoom: map.getZoom(), duration: 300 });
  }

  function isLockBreakingMove(e) {
    const oe = e.originalEvent;
    if (!oe) return false;
    if (oe.type === "wheel") return false;
    if (oe.type === "touchmove" || oe.type === "touchstart") {
      if (oe.touches && oe.touches.length > 1) return false;
    }
    return true;
  }

  function onLockedMapWheel(e) {
    if (!lockedUid) return;
    const coords = lockedMarkerCoords();
    if (!coords) {
      clearLock();
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    lockMoveFromCode = true;
    const zoom = map.getZoom();
    let delta = 0;
    if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      delta = -e.deltaY * 0.25;
    } else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      delta = -e.deltaY * 0.5;
    } else {
      delta = -e.deltaY * 0.0025;
    }
    const newZoom = Math.min(
      map.getMaxZoom(),
      Math.max(map.getMinZoom(), zoom + delta)
    );
    map.zoomTo(newZoom, { around: coords, duration: 0 });
  }

  function recenterLockedMarkerAtCurrentZoom() {
    const coords = lockedMarkerCoords();
    if (!coords) return;
    lockMoveFromCode = true;
    map.easeTo({ center: coords, zoom: map.getZoom(), duration: 0 });
  }

  function renderLayerList() {
    recomputeGroupCounts();
    elLayerList.innerHTML = "";
    const q = layerFilterText.toLowerCase();
    const items = groupsCatalog.filter((g) => {
      if (!isGroupInChannelScope(g)) return false;
      if (!q) return true;
      const label = String(g.displayName || g.name).toLowerCase();
      return label.includes(q) || String(g.name).toLowerCase().includes(q);
    });

    if (!items.length) {
      elLayerList.innerHTML = '<div class="map-detail-empty">No channels match.</div>';
      return;
    }

    for (const g of items) {
      const checked = isGroupEnabled(g.name);
      const label = g.displayName || stripChannelBehaviorSuffix(g.name);
      const row = document.createElement("div");
      row.className = "map-layer-row" + (checked ? " is-on" : "");
      row.setAttribute("data-group", g.name);

      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "map-mission-toggle" + (checked ? " is-on" : " is-off");
      toggleBtn.setAttribute("data-group", g.name);
      toggleBtn.setAttribute("aria-pressed", checked ? "true" : "false");
      toggleBtn.setAttribute("aria-label", (checked ? "Hide " : "Show ") + label);
      toggleBtn.title = checked ? "Hide channel" : "Show channel";

      const name = document.createElement("span");
      name.className = "map-layer-name";
      name.textContent = label;

      const count = document.createElement("span");
      count.className = "map-layer-count";
      count.textContent = String(g.markerCount || 0);

      row.appendChild(toggleBtn);
      row.appendChild(name);
      row.appendChild(count);
      elLayerList.appendChild(row);
    }
  }

  function closeMapPopup() {
    closeStackPicker();
    if (!popup) return;
    popup.remove();
    popup = null;
  }

  function showPopup(m) {
    closeMapPopup();
    if (!m) return;
    popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, offset: 12 })
      .setLngLat([m.lon, m.lat])
      .setHTML(
        "<strong>" +
          escapeHtml(m.callsign) +
          "</strong><br/><span class=\"map-popup-groups\">" +
          escapeHtml(formatMarkerGroupNames(m)) +
          "</span>"
      )
      .addTo(map);
  }

  function selectMarker(uid, showPopupFlag) {
    if (
      window.TakMapGeofences &&
      typeof window.TakMapGeofences.deselect === "function"
    ) {
      window.TakMapGeofences.deselect();
    }
    const id = String(uid);
    const hadSlot = detailSlots.some(function (s) {
      return s.uid === id;
    });
    const prevLen = detailSlots.length;
    const idx = ensureDetailSlotForUid(id);

    selectedUid = id;
    detailPaneUserCollapsed = false;
    closeMapPopup();

    if (idx >= 0) {
      if (detailSlots.length !== prevLen || !hadSlot) {
        syncDetailStackDom();
      } else {
        renderDetailPane(idx);
      }
      syncDetailStackVisibility();
    } else if (showPopupFlag) {
      const m = getMarkerRecord(id);
      if (m && Number.isFinite(m.lon) && Number.isFinite(m.lat)) {
        showPopup(m);
      }
    }

    syncSelectionToMapSource();
  }

  let scopedGroupsTimer = null;

  function scheduleScopedGroupsRefresh() {
    if (scopedGroupsTimer) clearTimeout(scopedGroupsTimer);
    scopedGroupsTimer = setTimeout(function () {
      scopedGroupsTimer = null;
      refreshScopedGroupsCatalog();
    }, 300);
  }

  function applyBatch(msg) {
    if (msg.revision != null) {
      lastMarkerRevision = Number(msg.revision) || lastMarkerRevision;
    }
    let slotsChanged = false;
    for (const uid of msg.removes || []) {
      const id = String(uid);
      markersByUid.delete(id);
      if (lockedUid === id) {
        clearLock();
      }
      if (selectedUid === id) {
        selectedUid = null;
        closeMapPopup();
      }
      for (let i = detailSlots.length - 1; i >= 0; i--) {
        if (detailSlots[i].uid === id) {
          clearDetailAgeTimer(id);
          detailSlots.splice(i, 1);
          slotsChanged = true;
        }
      }
    }
    for (const m of msg.updates || []) {
      storeMarker(m);
    }
    patchServerGeoJsonFromBatch(msg.updates || [], msg.removes || []);
    applyLiveShapeBatch(msg.shapeUpdates || [], msg.shapeRemoves || []);
    const needsFullGeoRefresh = batchNeedsFullGeoRefresh(msg.updates);
    if (needsFullGeoRefresh) {
      syncMapSource({ server: true });
    } else {
      queueMapDiffFromBatch(msg.updates || [], msg.removes || []);
      ensureGeoReconcileTimer();
    }
    // SSE groupsCatalog is global (no per-user scope); agency admins refresh scoped catalog.
    if (msg.groupsCatalog && mapChannelScope !== "member") {
      mergeGroupsCatalog(msg.groupsCatalog);
    } else if (mapChannelScope === "member" && msg.revision != null) {
      scheduleScopedGroupsRefresh();
    } else {
      recomputeGroupCounts();
    }
    scheduleLayerListRefresh();
    if (slotsChanged) {
      syncDetailStackDom();
      syncDetailStackVisibility();
    } else if (msg.updates && msg.updates.length && detailSlots.length) {
      for (const m of msg.updates) {
        const idx = detailSlots.findIndex(function (s) {
          return s.uid === m.uid;
        });
        if (idx >= 0) renderDetailPane(idx);
      }
      updateLockButtonsUi();
    }
    if (lockedUid) {
      const locked = getMarkerRecord(lockedUid);
      if (locked) trackLockedMarker(locked);
    }
  }

  function upsertMarker(m) {
    if (!m || !m.uid) return;
    applyBatch({ updates: [m] });
    maybeFitVisibleOnLoad();
  }

  function removeMarker(uid) {
    applyBatch({ removes: [String(uid)] });
  }

  function refreshScopedGroupsCatalog() {
    return fetch("/api/map/groups")
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        applyMapChannelScope(data.channelScope, data.allowedChannelKeys);
        mergeGroupsCatalog(data.groups || []);
        renderLayerList();
        syncChannelFilterToMap();
      })
      .catch(function () {});
  }

  function applySnapshot(state) {
    const snapshotRevision =
      state && state.revision != null ? Number(state.revision) : null;
    if (
      snapshotRevision != null &&
      snapshotRevision === appliedSnapshotRevision &&
      markersByUid.size > 0
    ) {
      return;
    }
    if (snapshotRevision != null) {
      appliedSnapshotRevision = snapshotRevision;
    }

    const hasChannelScope =
      state?.channelScope === "member" || state?.channelScope === "all";

    if (hasChannelScope) {
      applyMapChannelScope(state.channelScope, state.allowedChannelKeys);
      mergeGroupsCatalog(state?.groupsCatalog || []);
    } else if (mapChannelScope === "member") {
      // SSE reconnect snapshots are not user-scoped — keep agency channel list.
      recomputeGroupCounts();
      refreshScopedGroupsCatalog();
    } else if (state?.groupsCatalog) {
      mergeGroupsCatalog(state.groupsCatalog);
    } else {
      recomputeGroupCounts();
    }

    if (state && state.icons && state.icons.defaultIcons) {
      defaultIconIds = state.icons.defaultIcons;
    }

    if (state && state.liveShapes) {
      // Style may not be ready yet on first SSE snapshot — defer until load.
      if (map && typeof map.isStyleLoaded === "function" && map.isStyleLoaded()) {
        applyLiveShapesSnapshot(state.liveShapes);
      } else if (map) {
        map.once("load", function () {
          applyLiveShapesSnapshot(state.liveShapes);
        });
      }
    }

    const skipMarkerReload =
      markersByUid.size > 0 &&
      state &&
      state.revision != null &&
      Number(state.revision) === lastLoadedMarkerRevision;

    if (state && state.revision != null) {
      lastMarkerRevision = Number(state.revision) || lastMarkerRevision;
    }

    function afterMarkersReady() {
      iconLoadPending.clear();
      renderLayerList();
      maybeFitVisibleOnLoad();
      if (!markerLayersReady) return;
      reinstallMapIconsFromCache();
      if (lastServerGeoJsonFull) {
        applyLocalChannelFilter({ deferLabels: true });
        triggerMarkerRepaint();
        return;
      }
      runServerGeoJsonRefresh().finally(function () {
        triggerMarkerRepaint();
      });
    }

    if (markerLayersReady && !lastServerGeoJsonFull && !serverGeoFetchInFlight) {
      runServerGeoJsonRefresh();
    }

    if (skipMarkerReload) {
      afterMarkersReady();
    } else {
      loadMarkersFromServer()
        .then(afterMarkersReady)
        .catch(function () {});
    }
    setConnStatus(!!state.connected, state.lastError);
    elOffline.hidden = true;
  }

  function setConnStatus(connected) {
    if (connected && elOffline) elOffline.hidden = true;
  }

  let styleRestoreTimer = null;
  let styleRestoreFallbackTimer = null;
  let styleRestoreGen = 0;

  function restoreMapAfterStyleChange() {
    const gen = styleRestoreGen;
    liveMarkersLoadGen++;
    lastGeoJsonFetchOk = false;
    if (styleRestoreTimer) clearTimeout(styleRestoreTimer);
    if (styleRestoreFallbackTimer) clearTimeout(styleRestoreFallbackTimer);

    styleRestoreTimer = setTimeout(function () {
      styleRestoreTimer = null;
      if (gen !== styleRestoreGen) return;

      function finalizeRestore() {
        if (gen !== styleRestoreGen) return;
        markerLayersReady = true;
        mapRefreshPending = false;
        labelDeclutterKey = "";
        pendingStyleLabelDeclutter = true;
        reinstallMapIconsFromCache();
        bindMarkerLayerHandlers();

        function afterMissionsRestore() {
          if (gen !== styleRestoreGen) return;
          schedulePostStyleLabelDeclutter();
          triggerMarkerRepaint();
        }

        runServerGeoJsonRefresh()
          .finally(function () {
            if (gen !== styleRestoreGen) return;
            const missionRestore =
              window.TakMapMissions &&
              typeof window.TakMapMissions.restoreAfterStyleChange === "function"
                ? Promise.resolve(window.TakMapMissions.restoreAfterStyleChange())
                : Promise.resolve();
            const packageRestore =
              window.TakMapPackages &&
              typeof window.TakMapPackages.restoreAfterStyleChange === "function"
                ? Promise.resolve(window.TakMapPackages.restoreAfterStyleChange())
                : Promise.resolve();
            const geofenceRestore =
              window.TakMapGeofences &&
              typeof window.TakMapGeofences.restoreAfterStyleChange === "function"
                ? Promise.resolve(window.TakMapGeofences.restoreAfterStyleChange())
                : Promise.resolve();
            return Promise.all([missionRestore, packageRestore, geofenceRestore])
              .then(afterMissionsRestore)
              .catch(function (err) {
                console.warn("[map] overlay restore after style change failed", err);
                afterMissionsRestore();
              });
          });
      }

      function tryRestore(attempt) {
        if (gen !== styleRestoreGen) return;
        if (!map.isStyleLoaded()) {
          if (attempt < 400) {
            setTimeout(function () {
              tryRestore(attempt + 1);
            }, 50);
          }
          return;
        }

        if (!markerLayersComplete()) {
          try {
            removeMarkerLayers();
          } catch (err) {
            console.warn("[map] removeMarkerLayers failed during style restore", err);
          }
          if (!ensureMarkerLayers()) {
            if (attempt < 400) {
              setTimeout(function () {
                tryRestore(attempt + 1);
              }, 50);
            }
            return;
          }
        } else {
          bindMarkerLayerHandlers();
        }

        finalizeRestore();
      }

      markerLayersReady = false;
      mapRefreshPending = true;
      closeMapPopup();
      tryRestore(0);

      map.once("idle", function () {
        if (gen !== styleRestoreGen || markerLayersReady) return;
        tryRestore(0);
      });

      styleRestoreFallbackTimer = setTimeout(function () {
        styleRestoreFallbackTimer = null;
        if (gen !== styleRestoreGen || markerLayersReady) return;
        console.warn("[map] style restore fallback — forcing marker layer rebuild");
        tryRestore(0);
      }, 3000);
    }, 0);
  }

  function setBasemap(id) {
    const def = BASEMAPS[id] || BASEMAPS["dark-matter"];
    writeMapPrefs({ basemap: id });
    styleRestoreGen++;
    liveMarkersLoadGen++;
    lastGeoJsonFetchOk = false;
    markerLayersReady = false;
    mapRefreshPending = true;
    closeMapPopup();
    applyBasemapStyle(def.style);
  }

  function deselectMarker() {
    if (
      window.TakMapGeofences &&
      typeof window.TakMapGeofences.deselect === "function"
    ) {
      window.TakMapGeofences.deselect();
    }
    if (!selectedUid && !detailSlots.length) return;
    selectedUid = null;
    for (let i = detailSlots.length - 1; i >= 0; i--) {
      if (!detailSlots[i].pinned) {
        clearDetailAgeTimer(detailSlots[i].uid);
        detailSlots.splice(i, 1);
      }
    }
    syncDetailStackDom();
    syncDetailStackVisibility();
    syncSelectionToMapSource();
    closeStackPicker();
    closeMapPopup();
  }

  let mapPointerDown = null;
  const MAP_CLICK_DRAG_PX = 5;

  function isMapClickNotDrag(e) {
    if (!mapPointerDown) return true;
    const dx = e.point.x - mapPointerDown.x;
    const dy = e.point.y - mapPointerDown.y;
    return dx * dx + dy * dy <= MAP_CLICK_DRAG_PX * MAP_CLICK_DRAG_PX;
  }

  function onMapBackgroundClick(e) {
    if (Date.now() < suppressMapBackgroundClickUntil) return;
    if (!isMapClickNotDrag(e)) return;
    const layers = markerHitLayers();
    if (map.getLayer(LABEL_PRIORITY_LAYER)) layers.push(LABEL_PRIORITY_LAYER);
    if (map.getLayer(LABEL_LAYER)) layers.push(LABEL_LAYER);
    if (
      window.TakMapMissions &&
      typeof window.TakMapMissions.getHitLayers === "function"
    ) {
      const missionLayers = window.TakMapMissions.getHitLayers();
      for (let i = 0; i < missionLayers.length; i++) {
        layers.push(missionLayers[i]);
      }
    }
    if (
      window.TakMapPackages &&
      typeof window.TakMapPackages.getHitLayers === "function"
    ) {
      const packageLayers = window.TakMapPackages.getHitLayers();
      for (let i = 0; i < packageLayers.length; i++) {
        layers.push(packageLayers[i]);
      }
    }
    if (
      window.TakMapGeofences &&
      typeof window.TakMapGeofences.getHitLayers === "function"
    ) {
      const geofenceLayers = window.TakMapGeofences.getHitLayers();
      for (let i = 0; i < geofenceLayers.length; i++) {
        layers.push(geofenceLayers[i]);
      }
    }
    if (layers.length) {
      const hit = map.queryRenderedFeatures(e.point, { layers: layers });
      if (hit && hit.length) return;
    }
    deselectMarker();
  }

  map.on("styleimagemissing", onStyleImageMissing);

  map.on("style.load", restoreMapAfterStyleChange);

  map.on("load", function () {
    restoreMapAfterStyleChange();
  });

  map.on("movestart", function (e) {
    closeStackPicker();
    if (lockMoveFromCode) return;
    if (lockedUid && isLockBreakingMove(e)) {
      clearLock();
    }
  });

  map.on("moveend", () => {
    lockMoveFromCode = false;
    resortGoToAddressesByViewport();
    scheduleViewportSync();
    scheduleMissingIconSweep();
  });

  map.on("zoomend", () => {
    if (lockedUid && !lockMoveFromCode) {
      recenterLockedMarkerAtCurrentZoom();
    }
    labelDeclutterKey = "";
    applyOverviewRenderForZoom();
    scheduleViewportSync();
    resortGoToAddressesByViewport();
  });

  map.getCanvasContainer().addEventListener("wheel", onLockedMapWheel, {
    passive: false,
    capture: true,
  });

  map.on("mousedown", function (e) {
    mapPointerDown = { x: e.point.x, y: e.point.y };
  });

  map.on("click", onMapBackgroundClick);

  map.on("mousemove", (e) => {
    if (copyToastTimer) return;
    lastCursorLngLat = { lat: e.lngLat.lat, lng: e.lngLat.lng };
    renderCursorCoords();
  });

  map.on("contextmenu", (e) => {
    e.preventDefault();
    const text = cursorCoordsCopyText(e.lngLat.lat, e.lngLat.lng);
    copyTextToClipboard(text).then(
      () => showCopyToast("Copied " + text),
      () => showCopyToast(text)
    );
  });

  if (elCursorBtn) {
    elCursorBtn.addEventListener("click", cycleCursorCoordFormat);
  }

  function zoomMapBy(delta) {
    const newZoom = Math.min(
      map.getMaxZoom(),
      Math.max(map.getMinZoom(), map.getZoom() + delta)
    );
    const coords = lockedUid ? lockedMarkerCoords() : null;
    if (coords) {
      lockMoveFromCode = true;
      map.zoomTo(newZoom, { around: coords, duration: 200 });
      return;
    }
    map.zoomTo(newZoom, { duration: 200 });
  }

  if (elZoomIn) {
    elZoomIn.addEventListener("click", function () {
      zoomMapBy(1);
    });
  }
  if (elZoomOut) {
    elZoomOut.addEventListener("click", function () {
      zoomMapBy(-1);
    });
  }

  elBasemapSelect.addEventListener("change", () => {
    setBasemap(elBasemapSelect.value);
  });

  elLayerSearch.addEventListener("input", () => {
    layerFilterText = elLayerSearch.value.trim();
    renderLayerList();
  });

  if (elLayerList) {
    elLayerList.addEventListener("click", function (ev) {
      const row = ev.target.closest(".map-layer-row[data-group]");
      if (!row || !elLayerList.contains(row)) return;
      const groupName = row.getAttribute("data-group");
      if (!groupName) return;
      const btn = row.querySelector(".map-mission-toggle");
      const checked = !(btn && btn.classList.contains("is-on"));
      handleChannelGroupToggle(groupName, checked);
      if (btn) {
        btn.classList.toggle("is-on", checked);
        btn.classList.toggle("is-off", !checked);
        btn.setAttribute("aria-pressed", checked ? "true" : "false");
        btn.title = checked ? "Hide channel" : "Show channel";
      }
      row.classList.toggle("is-on", checked);
    });
  }

  document.getElementById("mapGroupsAll").addEventListener("click", () => {
    enabledGroups = new Set(
      groupsCatalog.filter(isGroupInChannelScope).map(function (g) {
        return g.name;
      })
    );
    saveEnabledGroups();
    renderLayerList();
    syncChannelFilterToMap();
    refreshGoToIfOpen();
  });

  document.getElementById("mapGroupsNone").addEventListener("click", () => {
    enabledGroups = new Set();
    saveEnabledGroups();
    renderLayerList();
    syncChannelFilterToMap();
    refreshGoToIfOpen();
  });

  function triggerFitVisible() {
    if (lockedUid) clearLock();
    fitVisibleMarkers(true);
  }

  if (elHudFit) {
    elHudFit.addEventListener("click", triggerFitVisible);
    elHudFit.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        triggerFitVisible();
      }
    });
  }

  const elGoToBtn = document.getElementById("mapGoToBtn");
  if (elGoToBtn) {
    elGoToBtn.addEventListener("click", function () {
      openGoToPalette("");
    });
  }

  document.getElementById("mapCollapseLeft").addEventListener("click", () => {
    setPanelLeftCollapsed(!elPanelLeft.classList.contains("collapsed"));
  });

  elExpandLeft.addEventListener("click", () => {
    setPanelLeftCollapsed(!elPanelLeft.classList.contains("collapsed"));
  });

  elExpandRight.addEventListener("click", () => {
    setDetailStackCollapsed(false);
  });

  document.addEventListener("keydown", (ev) => {
    if (goToPaletteOpen) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        closeGoToPalette();
        return;
      }
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        moveGoToSelection(1);
        return;
      }
      if (ev.key === "ArrowUp") {
        ev.preventDefault();
        moveGoToSelection(-1);
        return;
      }
      if (ev.key === "Enter") {
        ev.preventDefault();
        submitGoToQuery();
        return;
      }
      return;
    }

    if (
      !ev.ctrlKey &&
      !ev.metaKey &&
      !ev.altKey &&
      isGoToTypingKey(ev.key) &&
      !isTypingTarget(document.activeElement)
    ) {
      ev.preventDefault();
      openGoToPalette(ev.key);
      return;
    }

    if (ev.key === "/" && document.activeElement !== elLayerSearch) {
      ev.preventDefault();
      elLayerSearch.focus();
    }
    if (ev.key === "Escape") {
      closeGoToPalette();
      closeStackPicker();
      deselectMarker();
    }
  });

  if (elGoToInput) {
    elGoToInput.addEventListener("input", function () {
      updateGoToResults(elGoToInput.value);
    });
  }
  if (elGoToBackdrop) {
    elGoToBackdrop.addEventListener("click", closeGoToPalette);
  }

  document.addEventListener("paste", function (ev) {
    if (document.activeElement === elGoToInput) return;
    if (isTypingTarget(document.activeElement)) return;
    if (goToPaletteOpen) return;

    const text = String(ev.clipboardData?.getData("text/plain") || "").trim();
    if (!text) return;

    ev.preventDefault();
    openGoToPalette(text);
  });

  setInterval(function () {
    if (mapRefreshPending && markerLayersReady && !serverGeoFetchInFlight && !lastGeoJsonFetchOk) {
      refreshMapFromMarkers();
    }
  }, 2000);

  const es = new EventSource("/api/map/stream");
  es.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (_) {
      return;
    }
    if (msg.type === "snapshot" && msg.state) {
      applySnapshot(msg.state);
    } else if (msg.type === "shapes" && msg.shapes) {
      applyLiveShapesSnapshot(msg.shapes);
    } else if (msg.type === "batch") {
      applyBatch(msg);
    } else if (msg.type === "update" && msg.marker) {
      upsertMarker(msg.marker);
    } else if (msg.type === "remove" && msg.uid) {
      removeMarker(msg.uid);
    } else if (msg.type === "status") {
      setConnStatus(!!msg.connected, msg.lastError);
    }
  };
  es.onerror = () => {
    setConnStatus(false, "SSE disconnected");
    elOffline.hidden = false;
  };

  fetch("/api/map/state")
    .then((r) => r.json())
    .then((state) => applySnapshot(state))
    .catch(() => {});

  fetch("/api/map/groups")
    .then((r) => r.json())
    .then((data) => refreshScopedGroupsCatalog())
    .catch(() => {});

  function getStorageUserKey() {
    const body = document.body;
    return body && body.getAttribute("data-map-user")
      ? body.getAttribute("data-map-user")
      : "anonymous";
  }

  window.TakMapBridge = {
    getMap: function () {
      return map;
    },
    getStorageKey: getStorageUserKey,
    getMissionBeforeLayerId: function () {
      return map.getLayer(CIRCLE_LAYER_LOW) ? CIRCLE_LAYER_LOW : undefined;
    },
    isMarkerLayersReady: function () {
      return !!(markerLayersReady && markerLayersComplete());
    },
    getLabelFont: function () {
      return MAP_LABEL_FONT;
    },
    preloadMarkerIcons: preloadMarkerIcons,
    registerMissionIconManifest: registerMissionIconManifest,
    registerMissionMarkers: registerMissionMarkers,
    clearMissionMarkers: clearMissionMarkers,
    handleMapFeatureClick: handleMapFeatureClick,
    getMarkerRecord: getMarkerRecord,
    refreshGoToIfOpen: refreshGoToIfOpen,
    refreshLiveMarkersForMissionOverlay: refreshLiveMarkersForMissionOverlay,
    queryMarkersAtPoint: queryMarkersAtPoint,
    markerOriginRank: markerOriginRank,
    ensureLiveMarkersLoaded: ensureLiveMarkersLoaded,
    suppressBackgroundClick: function () {
      suppressMapBackgroundClickUntil = Date.now() + 150;
    },
    closeStackPicker: closeStackPicker,
    setAuxDetailActive: function (active) {
      auxDetailActive = !!active;
      if (active) detailPaneUserCollapsed = false;
      syncDetailStackVisibility();
    },
    deselectMarkersForAux: function () {
      selectedUid = null;
      for (let i = detailSlots.length - 1; i >= 0; i--) {
        if (!detailSlots[i].pinned) {
          clearDetailAgeTimer(detailSlots[i].uid);
          detailSlots.splice(i, 1);
        }
      }
      syncDetailStackDom();
      syncDetailStackVisibility();
      syncSelectionToMapSource();
      closeStackPicker();
      closeMapPopup();
    },
    whenReady: function (cb) {
      if (markerLayersReady && map) {
        cb();
        return;
      }
      const timer = setInterval(function () {
        if (markerLayersReady && map) {
          clearInterval(timer);
          cb();
        }
      }, 100);
    },
  };

  window.TakMapBridge.whenReady(function () {
    if (window.TakMapMissions && typeof window.TakMapMissions.init === "function") {
      window.TakMapMissions.init(window.TakMapBridge);
    }
    if (window.TakMapPackages && typeof window.TakMapPackages.init === "function") {
      window.TakMapPackages.init(window.TakMapBridge);
    }
    if (window.TakMapGeofences && typeof window.TakMapGeofences.init === "function") {
      window.TakMapGeofences.init(window.TakMapBridge);
    }
  });
})();
