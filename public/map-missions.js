/**
 * Read-only Data Sync mission overlays on the live map.
 */
(function () {
  "use strict";

  const LS_PREFIX = "tak-portal-map-missions:";
  const MISSION_FILTER = ["==", ["get", "kind"], "mission-feature"];

  const openMissions = new Map();
  let bridge = null;
  let map = null;
  let storageKey = "anonymous";
  let listEl = null;
  let searchEl = null;
  let missionsCatalog = [];
  let labelDeclutterTimer = null;
  const missionLabelDeclutterKey = new Map();
  const missionLayerClickHandlers = new Map();

  function slugMission(name) {
    return String(name || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
  }

  function missionSourceId(name) {
    return "mission-src-" + slugMission(name);
  }

  function missionLayerIds(name) {
    const base = "mission-" + slugMission(name);
    return {
      fill: base + "-fill",
      line: base + "-line",
      symbol: base + "-symbol",
      dot: base + "-symbol-dot",
      label: base + "-label",
    };
  }

  function missionRasterIds(name, hash) {
    const slug = slugMission(name);
    const h = String(hash || "").slice(0, 16);
    return {
      source: "mission-raster-" + slug + "-" + h,
      layer: "mission-raster-" + slug + "-" + h + "-layer",
    };
  }

  let missionStyleRestoreGen = 0;

  function whenLiveReady(fn) {
    if (bridge && typeof bridge.ensureLiveMarkersLoaded === "function") {
      return bridge.ensureLiveMarkersLoaded().then(fn);
    }
    return Promise.resolve().then(fn);
  }

  function readState() {
    try {
      const raw = localStorage.getItem(LS_PREFIX + storageKey);
      if (!raw) return { open: [], settings: {} };
      const parsed = JSON.parse(raw);
      return {
        open: Array.isArray(parsed.open) ? parsed.open : [],
        settings: parsed.settings && typeof parsed.settings === "object" ? parsed.settings : {},
      };
    } catch (_) {
      return { open: [], settings: {} };
    }
  }

  function writeState() {
    const open = [];
    const settings = {};
    openMissions.forEach(function (entry, name) {
      open.push(name);
      settings[name] = {
        visible: !!entry.visible,
        hiddenUids: Array.from(entry.hiddenUids || []),
        hiddenPaths: Array.from(entry.hiddenPaths || []),
      };
    });
    try {
      localStorage.setItem(LS_PREFIX + storageKey, JSON.stringify({ open, settings }));
    } catch (_) {}
  }

  function missionKeywords(m) {
    const raw = m?.keywords || m?.Keywords || [];
    if (Array.isArray(raw)) return raw.map(String);
    return String(raw || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function isArchivedMission(m) {
    return missionKeywords(m).some((k) => k.toLowerCase() === "archived_mission");
  }

  function hiddenUidFilter(hiddenUids) {
    if (!hiddenUids || !hiddenUids.size) {
      return true;
    }
    return ["!", ["in", ["get", "id"], ["literal", Array.from(hiddenUids)]]];
  }

  function missionVisibilityFilter() {
    return ["==", ["get", "missionVisible"], 1];
  }

  function missionLayersReady() {
    if (bridge && typeof bridge.isMarkerLayersReady === "function") {
      return bridge.isMarkerLayersReady();
    }
    return !!(
      bridge &&
      bridge.getMissionBeforeLayerId &&
      bridge.getMissionBeforeLayerId()
    );
  }

  function applyMissionLayerVisibility(name) {
    if (!map) return;
    const entry = openMissions.get(name);
    if (!entry) return;
    const ids = missionLayerIds(name);
    const vis = entry.visible ? "visible" : "none";
    const hiddenFilter = hiddenUidFilter(entry.hiddenUids);
    const baseFilter = ["all", MISSION_FILTER, missionVisibilityFilter(), hiddenFilter];

    const layerIds = [ids.fill, ids.line, ids.symbol, ids.label];
    for (let i = 0; i < layerIds.length; i++) {
      const layerId = layerIds[i];
      if (!map.getLayer(layerId)) continue;
      map.setLayoutProperty(layerId, "visibility", vis);
      map.setFilter(layerId, baseFilter);
    }

    const rasters = entry.rasterOverlays || [];
    for (let j = 0; j < rasters.length; j++) {
      const rasterIds = missionRasterIds(name, rasters[j].hash);
      if (map.getLayer(rasterIds.layer)) {
        map.setLayoutProperty(rasterIds.layer, "visibility", vis);
        map.setPaintProperty(rasterIds.layer, "raster-opacity", entry.visible ? 0.92 : 0);
      }
    }
    map.triggerRepaint();
  }

  function rasterAbsoluteUrl(url) {
    const raw = String(url || "").trim();
    if (!raw) return raw;
    if (/^https?:\/\//i.test(raw)) return raw;
    return window.location.origin + raw;
  }

  function getImageryBeforeLayerId() {
    const style = map.getStyle();
    if (style && Array.isArray(style.layers)) {
      for (let i = 0; i < style.layers.length; i++) {
        const id = style.layers[i].id;
        if (id.indexOf("mission-") === 0 || id.indexOf("tak-markers") === 0) {
          return id;
        }
      }
    }
    return bridge && bridge.getMissionBeforeLayerId ? bridge.getMissionBeforeLayerId() : undefined;
  }

  function missionLabelLayout() {
    const font = bridge && bridge.getLabelFont ? bridge.getLabelFont() : ["Open Sans Semibold"];
    return {
      "text-field": [
        "case",
        ["==", ["get", "showLabel"], 1],
        ["coalesce", ["get", "callsign"], ["get", "name"], ""],
        "",
      ],
      "text-font": font,
      "text-size": 11,
      "text-anchor": "bottom",
      "text-offset": [0, -2],
      "text-allow-overlap": true,
      "text-ignore-placement": true,
      "text-optional": false,
      "text-max-width": 14,
      "text-padding": 2,
      "symbol-sort-key": ["get", "labelSort"],
    };
  }

  function missionLabelPaint() {
    return {
      "text-color": "#ffffff",
      "text-halo-color": "rgba(0, 0, 0, 0.75)",
      "text-halo-width": 1.25,
      "text-opacity": 1,
    };
  }

  function labelBoxOverlaps(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function estimateLabelBox(lon, lat, callsign) {
    const pt = map.project([lon, lat]);
    const w = Math.max(36, String(callsign || "").length * 6.5);
    const h = 13;
    return { x: pt.x - w / 2, y: pt.y - 28, w: w, h: h };
  }

  function featureLabelAnchor(feature) {
    const geom = feature && feature.geometry;
    if (!geom) return null;
    if (geom.type === "Point") {
      return geom.coordinates;
    }
    if (geom.type === "LineString" && geom.coordinates.length) {
      return geom.coordinates[0];
    }
    if (geom.type === "Polygon" && geom.coordinates.length && geom.coordinates[0].length) {
      const ring = geom.coordinates[0];
      let lon = 0;
      let lat = 0;
      for (let i = 0; i < ring.length; i++) {
        lon += ring[i][0];
        lat += ring[i][1];
      }
      return [lon / ring.length, lat / ring.length];
    }
    return null;
  }

  function missionLabelDeclutterSignature(name, candidates) {
    return (
      name +
      "|" +
      String(Math.round(map.getZoom() * 4)) +
      "|" +
      candidates.length
    );
  }

  function applyMissionLabelDeclutter(name, options) {
    if (!map) return;
    const entry = openMissions.get(name);
    if (!entry || !entry.geojson || !Array.isArray(entry.geojson.features)) return;

    const forceRecompute = !!(options && options.forceRecompute);
    const candidates = entry.geojson.features.filter(function (feature) {
      const props = feature.properties || {};
      const label = props.callsign || props.name || "";
      if (!label) return false;
      const anchor = featureLabelAnchor(feature);
      return !!anchor;
    });

    const key = missionLabelDeclutterSignature(name, candidates);
    if (!forceRecompute && missionLabelDeclutterKey.get(name) === key) return;

    const sorted = candidates.slice().sort(function (a, b) {
      const aPri = Number(a.properties?.labelSort) || 4;
      const bPri = Number(b.properties?.labelSort) || 4;
      if (aPri !== bPri) return aPri - bPri;
      return String(a.properties?.callsign || "").localeCompare(String(b.properties?.callsign || ""));
    });

    const placed = [];
    const visibility = new Map();
    for (let i = 0; i < sorted.length; i++) {
      const feature = sorted[i];
      const props = feature.properties || {};
      const uid = String(props.uid || feature.id || i);
      const anchor = featureLabelAnchor(feature);
      if (!anchor) continue;
      const box = estimateLabelBox(anchor[0], anchor[1], props.callsign || props.name);
      let overlap = false;
      for (let j = 0; j < placed.length; j++) {
        if (labelBoxOverlaps(box, placed[j])) {
          overlap = true;
          break;
        }
      }
      visibility.set(uid, overlap ? 0 : 1);
      if (!overlap) placed.push(box);
    }

    let changed = false;
    const features = entry.geojson.features.map(function (feature, index) {
      const props = feature.properties || {};
      const uid = String(props.uid || feature.id || index);
      const label = props.callsign || props.name || "";
      const showLabel = label && visibility.has(uid) ? visibility.get(uid) : 0;
      const labelSort = visibility.has(uid) ? index : Number(props.labelSort) || 4;
      if (props.showLabel === showLabel && props.labelSort === labelSort) return feature;
      changed = true;
      return {
        type: feature.type,
        geometry: feature.geometry,
        properties: Object.assign({}, props, {
          showLabel: showLabel,
          labelSort: labelSort,
          missionVisible: entry.visible === false ? 0 : 1,
        }),
      };
    });

    if (!changed) {
      missionLabelDeclutterKey.set(name, key);
      return;
    }

    entry.geojson = Object.assign({}, entry.geojson, { features: features });
    const srcId = missionSourceId(name);
    const src = map.getSource(srcId);
    if (src) src.setData(entry.geojson);
    missionLabelDeclutterKey.set(name, key);
  }

  function applyAllMissionLabelDeclutter(options) {
    openMissions.forEach(function (_, name) {
      applyMissionLabelDeclutter(name, options);
    });
  }

  function scheduleMissionLabelDeclutter() {
    if (labelDeclutterTimer) clearTimeout(labelDeclutterTimer);
    labelDeclutterTimer = setTimeout(function () {
      labelDeclutterTimer = null;
      applyAllMissionLabelDeclutter();
    }, 80);
  }

  function ensureRasterOverlays(name, entry) {
    if (!map || !entry) return;
    const overlays = entry.rasterOverlays || [];
    const beforeId = getImageryBeforeLayerId();

    for (let i = 0; i < overlays.length; i++) {
      const ov = overlays[i];
      if (!ov.bounds || !ov.url) continue;
      const ids = missionRasterIds(name, ov.hash);
      const coords =
        ov.coordinates ||
        (function () {
          const b = ov.bounds;
          return [
            [b[0], b[3]],
            [b[2], b[3]],
            [b[2], b[1]],
            [b[0], b[1]],
          ];
        })();
      const url = rasterAbsoluteUrl(ov.url);

      const existing = map.getSource(ids.source);
      if (existing && typeof existing.updateImage === "function") {
        existing.updateImage({ url: url, coordinates: coords });
      } else {
        if (map.getLayer(ids.layer)) {
          try {
            map.removeLayer(ids.layer);
          } catch (_) {}
        }
        if (existing) {
          try {
            map.removeSource(ids.source);
          } catch (_) {}
        }
        map.addSource(ids.source, {
          type: "image",
          url: url,
          coordinates: coords,
        });
      }

      if (!map.getLayer(ids.layer)) {
        map.addLayer(
          {
            id: ids.layer,
            type: "raster",
            source: ids.source,
            paint: {
              "raster-opacity": entry.visible === false ? 0 : 0.92,
              "raster-fade-duration": 0,
            },
          },
          beforeId
        );
      } else {
        map.setPaintProperty(
          ids.layer,
          "raster-opacity",
          entry.visible === false ? 0 : 0.92
        );
      }
    }
  }

  function removeRasterOverlays(name, entry) {
    if (!map) return;
    const overlays = (entry && entry.rasterOverlays) || [];
    for (let i = 0; i < overlays.length; i++) {
      const ids = missionRasterIds(name, overlays[i].hash);
      if (map.getLayer(ids.layer)) {
        try {
          map.removeLayer(ids.layer);
        } catch (_) {}
      }
      if (map.getSource(ids.source)) {
        try {
          map.removeSource(ids.source);
        } catch (_) {}
      }
    }
  }

  function stampMissionVisibility(geojson, visible) {
    const show = visible !== false;
    const features = (geojson.features || []).map(function (feature) {
      return {
        type: feature.type,
        geometry: feature.geometry,
        properties: Object.assign({}, feature.properties || {}, { missionVisible: show ? 1 : 0 }),
      };
    });
    return Object.assign({}, geojson, { features: features });
  }

  function ensureMissionLayers(name, geojson) {
    const entry = openMissions.get(name);
    const srcId = missionSourceId(name);
    const ids = missionLayerIds(name);
    const data = stampMissionVisibility(
      geojson || { type: "FeatureCollection", features: [] },
      entry ? entry.visible : true
    );

    if (map.getLayer(ids.dot)) {
      try {
        map.removeLayer(ids.dot);
      } catch (_) {}
    }

    if (map.getSource(srcId)) {
      map.getSource(srcId).setData(data);
    } else {
      map.addSource(srcId, { type: "geojson", data: data });
    }

    const beforeId = bridge.getMissionBeforeLayerId();
    const baseFilter = [
      "all",
      MISSION_FILTER,
      missionVisibilityFilter(),
      hiddenUidFilter(entry ? entry.hiddenUids : null),
    ];

    if (!map.getLayer(ids.fill)) {
      map.addLayer(
        {
          id: ids.fill,
          type: "fill",
          source: srcId,
          filter: ["all", baseFilter, ["==", ["get", "geometryType"], "polygon"]],
          paint: {
            "fill-color": ["coalesce", ["get", "fill"], "#22d3ee"],
            "fill-opacity": ["coalesce", ["get", "fill-opacity"], 0.35],
          },
        },
        bridge.getMissionBeforeLayerId()
      );
    }

    if (!map.getLayer(ids.line)) {
      map.addLayer(
        {
          id: ids.line,
          type: "line",
          source: srcId,
          filter: [
            "all",
            baseFilter,
            ["in", ["get", "geometryType"], ["literal", ["line", "polygon"]]],
          ],
          paint: {
            "line-color": ["coalesce", ["get", "stroke"], "#22d3ee"],
            "line-width": ["coalesce", ["get", "stroke-width"], 2],
            "line-opacity": ["coalesce", ["get", "stroke-opacity"], 1],
          },
        },
        bridge.getMissionBeforeLayerId()
      );
    }

    if (!map.getLayer(ids.symbol)) {
      map.addLayer(
        {
          id: ids.symbol,
          type: "symbol",
          source: srcId,
          filter: [
            "all",
            baseFilter,
            ["==", ["get", "geometryType"], "point"],
            ["!=", ["get", "iconId"], ""],
          ],
          layout: {
            "icon-image": ["get", "iconId"],
            "icon-size": 0.88,
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
            "icon-optional": true,
          },
          paint: {
            "icon-opacity": 1,
          },
        },
        beforeId
      );
    }

    if (!map.getLayer(ids.label)) {
      map.addLayer(
        {
          id: ids.label,
          type: "symbol",
          source: srcId,
          filter: [
            "all",
            baseFilter,
            ["==", ["get", "showLabel"], 1],
            ["!=", ["coalesce", ["get", "callsign"], ["get", "name"], ""], ""],
          ],
          layout: missionLabelLayout(),
          paint: missionLabelPaint(),
        },
        beforeId
      );
    } else {
      const layerIds = [ids.fill, ids.line, ids.symbol, ids.label];
      for (let i = 0; i < layerIds.length; i++) {
        const layerId = layerIds[i];
        if (map.getLayer(layerId)) {
          map.setFilter(layerId, baseFilter);
        }
      }
    }

    applyMissionLayerVisibility(name);
  }

  function removeMissionLayers(name) {
    if (!map) return;
    const entry = openMissions.get(name);
    if (bridge && typeof bridge.clearMissionMarkers === "function") {
      bridge.clearMissionMarkers(name);
    }
    removeRasterOverlays(name, entry);
    missionLabelDeclutterKey.delete(name);
    const ids = missionLayerIds(name);
    const allIds = [ids.fill, ids.line, ids.symbol, ids.label];
    for (let i = 0; i < allIds.length; i++) {
      const layerId = allIds[i];
      const handler = missionLayerClickHandlers.get(layerId);
      if (handler) {
        try {
          map.off("click", layerId, handler);
        } catch (_) {}
        missionLayerClickHandlers.delete(layerId);
      }
      if (map.getLayer(layerId)) {
        try {
          map.removeLayer(layerId);
        } catch (_) {}
      }
    }
    const srcId = missionSourceId(name);
    if (map.getSource(srcId)) {
      try {
        map.removeSource(srcId);
      } catch (_) {}
    }
  }

  async function fetchMissionGeojson(name, options) {
    const opts = options || {};
    let url =
      "/api/map/missions/" +
      encodeURIComponent(name) +
      "/geojson?refresh=" +
      (opts.refresh ? "1" : "0") +
      "&attachments=1";
    const resp = await fetch(url, { credentials: "same-origin" });
    if (!resp.ok) throw new Error("geojson " + resp.status);
    return resp.json();
  }

  async function fetchMissionLayers(name) {
    const resp = await fetch(
      "/api/map/missions/" + encodeURIComponent(name) + "/layers",
      { credentials: "same-origin" }
    );
    if (!resp.ok) throw new Error("layers " + resp.status);
    return resp.json();
  }

  function collectOpenMissionIconManifest() {
    const out = [];
    const seen = new Set();
    openMissions.forEach(function (missionEntry) {
      const list =
        missionEntry.geojson && missionEntry.geojson.meta && missionEntry.geojson.meta.iconManifest
          ? missionEntry.geojson.meta.iconManifest
          : [];
      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        const id = String(item.mapImageId || "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(item);
      }
    });
    return out;
  }

  async function installMissionOverlays(name, entry) {
    const manifest =
      entry.geojson && entry.geojson.meta && entry.geojson.meta.iconManifest
        ? entry.geojson.meta.iconManifest
        : [];
    if (bridge) {
      if (typeof bridge.registerMissionIconManifest === "function") {
        bridge.registerMissionIconManifest(collectOpenMissionIconManifest());
      }
    }
    ensureMissionLayers(name, entry.geojson);
    applyMissionLayerVisibility(name);
    syncMissionMarkers(name, entry);
    bindMissionLayerHandlers();
    applyMissionLabelDeclutter(name, { forceRecompute: true });

    if (manifest.length && bridge && typeof bridge.preloadMarkerIcons === "function") {
      try {
        await bridge.preloadMarkerIcons(manifest);
      } catch (_) {}
      applyMissionLabelDeclutter(name, { forceRecompute: true });
      if (map) map.triggerRepaint();
    }

    ensureRasterOverlays(name, entry);
    applyMissionLayerVisibility(name);
    if (map) map.triggerRepaint();
  }

  function featureLabel(props) {
    return (
      props?.callsign ||
      props?.name ||
      props?.cotType ||
      props?.uid ||
      props?.id ||
      "Feature"
    );
  }

  function extendBoundsPoint(bounds, lon, lat) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return bounds;
    if (!bounds) {
      return { west: lon, south: lat, east: lon, north: lat };
    }
    return {
      west: Math.min(bounds.west, lon),
      south: Math.min(bounds.south, lat),
      east: Math.max(bounds.east, lon),
      north: Math.max(bounds.north, lat),
    };
  }

  function extendBoundsFromGeometry(bounds, geom) {
    if (!geom || !geom.coordinates) return bounds;
    const type = String(geom.type || "");
    if (type === "Point") {
      return extendBoundsPoint(bounds, geom.coordinates[0], geom.coordinates[1]);
    }
    if (type === "LineString") {
      for (let i = 0; i < geom.coordinates.length; i++) {
        bounds = extendBoundsPoint(bounds, geom.coordinates[i][0], geom.coordinates[i][1]);
      }
      return bounds;
    }
    if (type === "Polygon") {
      for (let r = 0; r < geom.coordinates.length; r++) {
        const ring = geom.coordinates[r] || [];
        for (let i = 0; i < ring.length; i++) {
          bounds = extendBoundsPoint(bounds, ring[i][0], ring[i][1]);
        }
      }
      return bounds;
    }
    if (type === "MultiLineString") {
      for (let g = 0; g < geom.coordinates.length; g++) {
        const line = geom.coordinates[g] || [];
        for (let i = 0; i < line.length; i++) {
          bounds = extendBoundsPoint(bounds, line[i][0], line[i][1]);
        }
      }
      return bounds;
    }
    if (type === "MultiPolygon") {
      for (let p = 0; p < geom.coordinates.length; p++) {
        const poly = geom.coordinates[p] || [];
        for (let r = 0; r < poly.length; r++) {
          const ring = poly[r] || [];
          for (let i = 0; i < ring.length; i++) {
            bounds = extendBoundsPoint(bounds, ring[i][0], ring[i][1]);
          }
        }
      }
    }
    return bounds;
  }

  function computeMissionBounds(entry) {
    if (!entry) return null;
    let bounds = null;
    const features = entry.geojson && entry.geojson.features ? entry.geojson.features : [];
    for (let i = 0; i < features.length; i++) {
      bounds = extendBoundsFromGeometry(bounds, features[i].geometry);
    }
    const rasters = entry.rasterOverlays || [];
    for (let j = 0; j < rasters.length; j++) {
      const b = rasters[j].bounds;
      if (!b || b.length < 4) continue;
      bounds = extendBoundsPoint(bounds, b[0], b[1]);
      bounds = extendBoundsPoint(bounds, b[2], b[3]);
    }
    if (!bounds) return null;
    if (bounds.west === bounds.east && bounds.south === bounds.north) {
      return {
        center: [bounds.west, bounds.south],
        single: true,
      };
    }
    return {
      bounds: [
        [bounds.west, bounds.south],
        [bounds.east, bounds.north],
      ],
      single: false,
    };
  }

  function flyToMissionExtent(name) {
    if (!map) return Promise.resolve();
    const missionName = String(name || "").trim();
    if (!missionName) return Promise.resolve();

    function applyFit(entry) {
      const fit = computeMissionBounds(entry);
      if (!fit) return;
      if (fit.single && fit.center) {
        map.flyTo({
          center: fit.center,
          zoom: Math.max(map.getZoom(), 12),
          duration: 800,
        });
        return;
      }
      if (fit.bounds) {
        map.fitBounds(fit.bounds, { padding: 64, maxZoom: 16, duration: 800 });
      }
    }

    let entry = openMissions.get(missionName);
    const ensureLoaded =
      entry && entry.geojson
        ? Promise.resolve()
        : loadMission(missionName).then(function () {
            entry = openMissions.get(missionName);
          });

    return ensureLoaded
      .then(function () {
        entry = openMissions.get(missionName);
        if (!entry) return;
        if (!entry.visible) {
          entry.visible = true;
          if (entry.geojson) {
            entry.geojson = stampMissionVisibility(entry.geojson, true);
          }
          return installMissionOverlays(missionName, entry).then(function () {
            writeState();
            renderMissionList();
            applyFit(entry);
          });
        }
        applyFit(entry);
      })
      .catch(function (err) {
        console.warn("[map-missions] fly to mission failed", err);
      });
  }

  function setAllMissionsEnabled(enabled) {
    const wantOn = !!enabled;
    const names = missionsCatalog
      .map(function (m) {
        return String(m.name || m.Name || "").trim();
      })
      .filter(Boolean);
    for (let i = 0; i < names.length; i++) {
      setMissionEnabled(names[i], wantOn);
    }
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function affiliationFromCotType(cotType) {
    const parts = String(cotType || "").trim().split("-");
    if (parts.length < 2) return "other";
    const aff = parts[1].toLowerCase();
    if (aff === "f") return "friend";
    if (aff === "h") return "hostile";
    if (aff === "n") return "neutral";
    if (aff === "u") return "unknown";
    return "other";
  }

  function featureToMarkerRecord(feature) {
    const props = feature && feature.properties ? feature.properties : {};
    const uid = String(props.uid || props.id || feature.id || "");
    if (!uid) return null;
    const anchor = featureLabelAnchor(feature);
    if (!anchor) return null;
    const missionName = String(props.missionName || "");
    const cotType = String(props.cotType || props.type || "");
    const usesMapIcon = props.usesMapIcon === 1 || props.usesMapIcon === true;
    const mapImageId = String(props.iconId || "");
    const apiIconId = String(props.apiIconId || "");
    return {
      uid: uid,
      callsign: props.callsign || props.name || uid.slice(0, 16),
      type: cotType,
      lon: anchor[0],
      lat: anchor[1],
      remarks: props.remarks || props.description || "",
      team: props.team || "",
      role: props.role || "",
      hae: props.hae,
      how: props.how || "",
      origin: "mission",
      missionName: missionName,
      groups: missionName ? [missionName] : [],
      affiliation: affiliationFromCotType(cotType),
      iconId: apiIconId,
      mapImageId: mapImageId,
      iconSource: String(props.iconSource || ""),
      usesMapIcon: usesMapIcon,
      teamColor: props.teamColor || props.color || "",
      color: props.color || props.teamColor || "",
      showCircle:
        props.showCircle === 1
          ? true
          : props.showCircle === 0
            ? false
            : !mapImageId,
      stale: props.stale || props.time || null,
      start: props.start || null,
    };
  }

  function isMarkerSearchable(uid, missionName) {
    const name = String(missionName || "").trim();
    const entry = openMissions.get(name);
    if (!entry || !entry.visible) return false;
    const id = String(uid || "");
    if (!id) return false;
    if (entry.hiddenUids && entry.hiddenUids.has(id)) return false;
    return true;
  }

  function syncMissionMarkers(name, entry) {
    if (!bridge || typeof bridge.registerMissionMarkers !== "function") return;
    if (!entry || !entry.visible || !entry.geojson || !Array.isArray(entry.geojson.features)) {
      if (typeof bridge.clearMissionMarkers === "function") {
        bridge.clearMissionMarkers(name);
      }
      return;
    }
    const markers = [];
    for (let i = 0; i < entry.geojson.features.length; i++) {
      const marker = featureToMarkerRecord(entry.geojson.features[i]);
      if (marker) markers.push(marker);
    }
    bridge.registerMissionMarkers(name, markers);
    if (bridge && typeof bridge.refreshGoToIfOpen === "function") {
      bridge.refreshGoToIfOpen();
    }
  }

  function getMissionHitLayers() {
    const layers = [];
    if (!map) return layers;
    openMissions.forEach(function (entry, name) {
      if (!entry || !entry.visible) return;
      const ids = missionLayerIds(name);
      const layerIds = [ids.symbol, ids.fill, ids.line];
      for (let i = 0; i < layerIds.length; i++) {
        const layerId = layerIds[i];
        if (map.getLayer(layerId)) layers.push(layerId);
      }
    });
    return layers;
  }

  function queryMissionMarkersAtPoint(point, radiusPx) {
    if (bridge && typeof bridge.queryMarkersAtPoint === "function") {
      return bridge.queryMarkersAtPoint(point, radiusPx);
    }
    const r = radiusPx == null ? 18 : radiusPx;
    const layers = getMissionHitLayers();
    if (!map || !layers.length) return [];

    const bbox = [
      [point.x - r, point.y - r],
      [point.x + r, point.y + r],
    ];
    const features = map.queryRenderedFeatures(bbox, { layers: layers });
    const seen = new Set();
    const markers = [];
    for (let i = 0; i < features.length; i++) {
      const props = features[i].properties || {};
      const uid = String(props.uid || props.id || features[i].id || "");
      if (!uid || seen.has(uid)) continue;
      seen.add(uid);
      const marker =
        bridge && typeof bridge.getMarkerRecord === "function"
          ? bridge.getMarkerRecord(uid)
          : featureToMarkerRecord(features[i]);
      if (marker) markers.push(marker);
    }
    markers.sort(function (a, b) {
      const rankDiff =
        (bridge && typeof bridge.markerOriginRank === "function"
          ? bridge.markerOriginRank(b) - bridge.markerOriginRank(a)
          : 0);
      if (rankDiff !== 0) return rankDiff;
      return String(a.callsign || a.uid).localeCompare(String(b.callsign || b.uid));
    });
    return markers;
  }

  function onMissionLayerClick(e) {
    if (!bridge || typeof bridge.handleMapFeatureClick !== "function") return;
    bridge.handleMapFeatureClick(e);
  }

  function bindMissionLayerHandlers() {
    if (!map) return;
    missionLayerClickHandlers.forEach(function (handler, layerId) {
      if (map.getLayer(layerId)) {
        try {
          map.off("click", layerId, handler);
        } catch (_) {}
      }
    });
    missionLayerClickHandlers.clear();

    openMissions.forEach(function (entry, name) {
      if (!entry || !entry.visible) return;
      const ids = missionLayerIds(name);
      const layerIds = [ids.symbol, ids.fill, ids.line];
      for (let i = 0; i < layerIds.length; i++) {
        const layerId = layerIds[i];
        if (!map.getLayer(layerId)) continue;
        const handler = onMissionLayerClick;
        map.on("click", layerId, handler);
        missionLayerClickHandlers.set(layerId, handler);
      }
    });
  }

  function setMissionEnabled(name, enabled) {
    const wantOn = !!enabled;
    let entry = openMissions.get(name);

    if (wantOn) {
      if (!entry) {
        loadMission(name);
        return;
      }
      if (entry.loading) return;
      entry.visible = true;
      if (entry.geojson) {
        entry.geojson = stampMissionVisibility(entry.geojson, true);
        whenLiveReady(function () {
          return installMissionOverlays(name, entry);
        })
          .then(function () {
            writeState();
            renderMissionList();
          })
          .catch(function (err) {
            entry.error = err?.message || String(err);
            renderMissionList();
          });
        return;
      }
      loadMission(name);
      return;
    }

    if (!entry) return;
    entry.visible = false;
    if (bridge && typeof bridge.clearMissionMarkers === "function") {
      bridge.clearMissionMarkers(name);
    }
    if (entry.geojson) {
      entry.geojson = stampMissionVisibility(entry.geojson, false);
      const srcId = missionSourceId(name);
      const src = map.getSource(srcId);
      if (src) src.setData(entry.geojson);
    }
    applyMissionLayerVisibility(name);
    writeState();
    renderMissionList();
  }

  async function loadMission(name, options) {
    const opts = options || {};
    await whenLiveReady(function () {});
    let entry = openMissions.get(name);
    if (!entry) {
      entry = {
        visible: true,
        geojson: null,
        layers: null,
        hiddenUids: new Set(),
        hiddenPaths: new Set(),
        rasterOverlays: [],
        attachmentSummary: null,
        loading: false,
        error: null,
      };
      openMissions.set(name, entry);
    }

    entry.loading = true;
    renderMissionList();
    try {
      const [geojson, layers] = await Promise.all([
        fetchMissionGeojson(name, { refresh: !!opts.refresh }),
        fetchMissionLayers(name).catch(function () {
          return { folders: [], orphaned: [] };
        }),
      ]);
      entry.geojson = geojson;
      entry.layers = layers;
      entry.rasterOverlays = geojson.meta && geojson.meta.rasterOverlays ? geojson.meta.rasterOverlays : [];
      entry.attachmentSummary = geojson.meta && geojson.meta.attachmentSummary ? geojson.meta.attachmentSummary : null;
      entry.error = null;
      entry.geojson = stampMissionVisibility(geojson, entry.visible);
      await installMissionOverlays(name, entry);
    } catch (err) {
      entry.error = err?.message || String(err);
    } finally {
      entry.loading = false;
      writeState();
      renderMissionList();
    }
  }

  function toggleUidVisible(name, uid) {
    const entry = openMissions.get(name);
    if (!entry) return;
    const id = String(uid);
    if (entry.hiddenUids.has(id)) entry.hiddenUids.delete(id);
    else entry.hiddenUids.add(id);
    applyMissionLayerVisibility(name);
    writeState();
    renderMissionList();
    if (bridge && typeof bridge.refreshGoToIfOpen === "function") {
      bridge.refreshGoToIfOpen();
    }
  }

  function toggleFolderVisible(name, folder) {
    const entry = openMissions.get(name);
    if (!entry || !folder) return;
    const path = String(folder.path || "");
    const hide = !entry.hiddenPaths.has(path);
    if (hide) entry.hiddenPaths.add(path);
    else entry.hiddenPaths.delete(path);
    for (const uid of folder.uids || []) {
      if (hide) entry.hiddenUids.add(String(uid));
      else entry.hiddenUids.delete(String(uid));
    }
    applyMissionLayerVisibility(name);
    writeState();
    renderMissionList();
    if (bridge && typeof bridge.refreshGoToIfOpen === "function") {
      bridge.refreshGoToIfOpen();
    }
  }

  function renderMissionList() {
    if (!listEl) return;
    const q = String(searchEl?.value || "")
      .trim()
      .toLowerCase();
    const catalog = missionsCatalog.filter(function (m) {
      const name = String(m.name || m.Name || "").toLowerCase();
      return !q || name.includes(q);
    });

    listEl.innerHTML = "";

    if (!catalog.length) {
      listEl.innerHTML = '<div class="map-mission-empty">No missions available.</div>';
      return;
    }

    for (const m of catalog) {
      const name = String(m.name || m.Name || "").trim();
      if (!name) continue;
      const entry = openMissions.get(name);
      const isOn = !!(entry && entry.visible);
      const row = document.createElement("div");
      row.className = "map-mission-row" + (isOn ? " is-on" : "");

      const head = document.createElement("div");
      head.className = "map-mission-row-head";

      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "map-mission-toggle" + (isOn ? " is-on" : " is-off");
      toggleBtn.title = isOn ? "Hide mission overlays" : "Show mission overlays";
      toggleBtn.setAttribute("aria-pressed", isOn ? "true" : "false");
      toggleBtn.setAttribute("aria-label", (isOn ? "Hide " : "Show ") + name);
      toggleBtn.addEventListener("click", function () {
        setMissionEnabled(name, !isOn);
      });

      const title = document.createElement("span");
      title.className = "map-mission-name is-clickable";
      title.textContent = name;
      title.title = "Zoom map to mission extent";
      title.addEventListener("click", function (ev) {
        ev.stopPropagation();
        flyToMissionExtent(name);
      });
      if (isArchivedMission(m)) {
        const badge = document.createElement("span");
        badge.className = "map-mission-badge";
        badge.textContent = "archived";
        title.appendChild(document.createTextNode(" "));
        title.appendChild(badge);
      }

      const refreshBtn = document.createElement("button");
      refreshBtn.type = "button";
      refreshBtn.className = "map-mission-refresh-btn";
      refreshBtn.textContent = "↻";
      refreshBtn.title = "Refresh mission";
      refreshBtn.disabled = !isOn || (entry && entry.loading);
      refreshBtn.addEventListener("click", function () {
        loadMission(name, { refresh: true });
      });

      head.appendChild(toggleBtn);
      head.appendChild(title);
      head.appendChild(refreshBtn);
      row.appendChild(head);

      if (entry && entry.loading) {
        const status = document.createElement("div");
        status.className = "map-mission-status";
        status.textContent = "Loading…";
        row.appendChild(status);
      } else if (entry && entry.error) {
        const status = document.createElement("div");
        status.className = "map-mission-status map-mission-status-error";
        status.textContent = entry.error;
        row.appendChild(status);
      }

      if (entry && isOn) {
        if (entry.attachmentSummary) {
          const attachHint = document.createElement("div");
          attachHint.className = "map-mission-hint";
          attachHint.textContent =
            "Attachments: " +
            entry.attachmentSummary.kml +
            " KML feature(s), " +
            entry.attachmentSummary.raster +
            " raster overlay(s)";
          row.appendChild(attachHint);
        }

        const tree = document.createElement("div");
        tree.className = "map-mission-tree";
        const folders = entry.layers?.folders || [];
        for (const folder of folders) {
          const folderRow = document.createElement("div");
          folderRow.className = "map-mission-folder";
          const folderBtn = document.createElement("button");
          folderBtn.type = "button";
          folderBtn.className = "map-mission-folder-btn";
          const hidden = entry.hiddenPaths.has(folder.path);
          folderBtn.textContent = (hidden ? "○ " : "● ") + (folder.name || folder.path);
          folderBtn.addEventListener("click", function () {
            toggleFolderVisible(name, folder);
          });
          folderRow.appendChild(folderBtn);
          tree.appendChild(folderRow);
        }
        const orphaned = entry.layers?.orphaned || [];
        for (const uid of orphaned) {
          const itemRow = document.createElement("div");
          itemRow.className = "map-mission-item";
          const itemBtn = document.createElement("button");
          itemBtn.type = "button";
          itemBtn.className = "map-mission-item-btn";
          const hidden = entry.hiddenUids.has(String(uid));
          const feat = (entry.geojson?.features || []).find(function (f) {
            return String(f.id || f.properties?.uid) === String(uid);
          });
          const label = feat ? featureLabel(feat.properties) : uid.slice(0, 12);
          itemBtn.textContent = (hidden ? "○ " : "● ") + label;
          itemBtn.addEventListener("click", function () {
            toggleUidVisible(name, uid);
          });
          itemRow.appendChild(itemBtn);
          tree.appendChild(itemRow);
        }
        if (!folders.length && !orphaned.length && entry.geojson) {
          const count = (entry.geojson.features || []).length;
          const rasterCount = (entry.rasterOverlays || []).length;
          const hint = document.createElement("div");
          hint.className = "map-mission-hint";
          hint.textContent =
            count +
            " vector feature(s)" +
            (rasterCount ? ", " + rasterCount + " raster overlay(s)" : "");
          tree.appendChild(hint);
        }
        row.appendChild(tree);
      }

      listEl.appendChild(row);
    }
  }

  async function refreshMissionCatalog() {
    try {
      const resp = await fetch("/api/map/missions", { credentials: "same-origin" });
      if (!resp.ok) throw new Error("missions " + resp.status);
      const data = await resp.json();
      missionsCatalog = Array.isArray(data.missions) ? data.missions : [];
      renderMissionList();
    } catch (err) {
      if (listEl) {
        listEl.innerHTML =
          '<div class="map-mission-empty map-mission-status-error">' +
          escapeHtml(err?.message || "Failed to load missions") +
          "</div>";
      }
    }
  }

  function restoreOpenMissions() {
    const state = readState();
    for (const name of state.open) {
      const settings = state.settings[name] || {};
      const visible = settings.visible !== false;
      const entry = {
        visible: visible,
        geojson: null,
        layers: null,
        hiddenUids: new Set(settings.hiddenUids || []),
        hiddenPaths: new Set(settings.hiddenPaths || []),
        rasterOverlays: [],
        attachmentSummary: null,
        loading: false,
        error: null,
      };
      openMissions.set(name, entry);
    }
    whenLiveReady(function () {
      const pending = readState();
      for (const name of pending.open) {
        const settings = pending.settings[name] || {};
        if (settings.visible !== false) loadMission(name);
      }
    });
  }

  function reinstallMissionOverlays(name, entry) {
    removeMissionLayers(name);
    if (!entry || !entry.geojson || !entry.visible) {
      if (entry && entry.geojson) {
        entry.geojson = stampMissionVisibility(entry.geojson, false);
      }
      return Promise.resolve();
    }
    entry.geojson = stampMissionVisibility(entry.geojson, true);
    return installMissionOverlays(name, entry);
  }

  function restoreAfterStyleChange() {
    if (!map) return Promise.resolve();
    missionStyleRestoreGen++;
    const gen = missionStyleRestoreGen;
    missionLabelDeclutterKey.clear();

    return new Promise(function (resolve) {
      function tryRestore(attempt) {
        if (gen !== missionStyleRestoreGen || !map) {
          resolve();
          return;
        }
        if (!map.isStyleLoaded() || !missionLayersReady()) {
          if (attempt < 400) {
            setTimeout(function () {
              tryRestore(attempt + 1);
            }, 50);
            return;
          }
          resolve();
          return;
        }

        const jobs = [];
        openMissions.forEach(function (entry, name) {
          if (!entry.geojson) {
            if (entry.visible) jobs.push(loadMission(name));
            return;
          }
          jobs.push(reinstallMissionOverlays(name, entry));
        });

        Promise.all(jobs)
          .then(function () {
            if (bridge && typeof bridge.registerMissionIconManifest === "function") {
              bridge.registerMissionIconManifest(collectOpenMissionIconManifest());
            }
            openMissions.forEach(function (entry, name) {
              applyMissionLayerVisibility(name);
              syncMissionMarkers(name, entry);
            });
            bindMissionLayerHandlers();
            applyAllMissionLabelDeclutter({ forceRecompute: true });
            if (map) {
              map.once("idle", function () {
                if (gen !== missionStyleRestoreGen) return;
                applyAllMissionLabelDeclutter({ forceRecompute: true });
                map.triggerRepaint();
              });
              map.triggerRepaint();
            }
            resolve();
          })
          .catch(function (err) {
            console.warn("[map-missions] style restore failed", err);
            if (attempt < 40) {
              setTimeout(function () {
                tryRestore(attempt + 1);
              }, 100);
            } else {
              resolve();
            }
          });
      }

      tryRestore(0);
    });
  }

  function init(api) {
    bridge = api;
    map = api.getMap();
    storageKey = api.getStorageKey ? api.getStorageKey() : "anonymous";
    listEl = document.getElementById("mapMissionList");
    searchEl = document.getElementById("mapMissionSearch");

    if (searchEl) {
      searchEl.addEventListener("input", renderMissionList);
    }

    const missionsAllBtn = document.getElementById("mapMissionsAll");
    const missionsNoneBtn = document.getElementById("mapMissionsNone");
    if (missionsAllBtn) {
      missionsAllBtn.addEventListener("click", function () {
        setAllMissionsEnabled(true);
      });
    }
    if (missionsNoneBtn) {
      missionsNoneBtn.addEventListener("click", function () {
        setAllMissionsEnabled(false);
      });
    }

    const tabChannels = document.getElementById("mapTabChannels");
    const tabMissions = document.getElementById("mapTabMissions");
    const panelChannels = document.getElementById("mapPanelChannels");
    const panelMissions = document.getElementById("mapPanelMissions");

    function setTab(tab) {
      const missions = tab === "missions";
      if (tabChannels) {
        tabChannels.classList.toggle("active", !missions);
      }
      if (tabMissions) {
        tabMissions.classList.toggle("active", missions);
      }
      if (panelChannels) {
        panelChannels.classList.toggle("is-active", !missions);
        panelChannels.hidden = missions;
      }
      if (panelMissions) {
        panelMissions.classList.toggle("is-active", missions);
        panelMissions.hidden = !missions;
      }
      if (missions && !missionsCatalog.length) refreshMissionCatalog();
    }

    setTab("channels");

    if (tabChannels) tabChannels.addEventListener("click", function () { setTab("channels"); });
    if (tabMissions) tabMissions.addEventListener("click", function () { setTab("missions"); });

    map.on("moveend", scheduleMissionLabelDeclutter);
    map.on("zoomend", scheduleMissionLabelDeclutter);
    refreshMissionCatalog().then(restoreOpenMissions);
  }

  window.TakMapMissions = {
    init: init,
    restoreAfterStyleChange: restoreAfterStyleChange,
    queryMarkersAtPoint: queryMissionMarkersAtPoint,
    getHitLayers: getMissionHitLayers,
    isMarkerSearchable: isMarkerSearchable,
    flyToMissionExtent: flyToMissionExtent,
    setAllMissionsEnabled: setAllMissionsEnabled,
  };
})();
