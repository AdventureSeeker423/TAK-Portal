/**
 * Read-only Data Package overlays on the live map (missions-style toggles).
 */
(function () {
  "use strict";

  const LS_PREFIX = "tak-portal-map-packages:";
  const PACKAGE_FILTER = ["==", ["get", "kind"], "package-feature"];

  const openPackages = new Map();
  let bridge = null;
  let map = null;
  let storageKey = "anonymous";
  let listEl = null;
  let searchEl = null;
  let packagesCatalog = [];
  let labelDeclutterTimer = null;
  const packageLabelDeclutterKey = new Map();
  const packageLayerClickHandlers = new Map();
  const packageLoadGen = new Map();
  let renderPackageListTimer = null;
  let packageStyleRestoreGen = 0;
  let styleRestoreTimer = null;

  function slugPackage(hash) {
    return String(hash || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
  }

  function packageSourceId(hash) {
    return "package-" + slugPackage(hash);
  }

  function packageLayerIds(hash) {
    const base = "package-" + slugPackage(hash);
    return {
      fill: base + "-fill",
      line: base + "-line",
      symbol: base + "-symbol",
      dot: base + "-symbol-dot",
      label: base + "-label",
    };
  }

  function packageRasterIds(hash, entryHash) {
    const slug = slugPackage(hash);
    const h = String(entryHash || "").slice(0, 16);
    return {
      source: "package-raster-" + slug + "-" + h,
      layer: "package-raster-" + slug + "-" + h + "-layer",
    };
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
        if (
          id.indexOf("package-") === 0 ||
          id.indexOf("mission-") === 0 ||
          id.indexOf("tak-markers") === 0
        ) {
          return id;
        }
      }
    }
    return bridge && bridge.getMissionBeforeLayerId ? bridge.getMissionBeforeLayerId() : undefined;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

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
    openPackages.forEach(function (entry, hash) {
      open.push(hash);
      settings[hash] = { visible: !!entry.visible };
    });
    try {
      localStorage.setItem(LS_PREFIX + storageKey, JSON.stringify({ open, settings }));
    } catch (_) {}
  }

  function packageVisibilityFilter() {
    return ["==", ["get", "packageVisible"], 1];
  }

  function packageBaseFilter() {
    return ["all", PACKAGE_FILTER, packageVisibilityFilter()];
  }

  function packageLayerFilters(baseFilter) {
    return {
      fill: [
        "all",
        baseFilter,
        ["==", ["geometry-type"], "Polygon"],
        ["!=", ["get", "fill-opacity"], 0],
      ],
      line: [
        "all",
        baseFilter,
        [
          "any",
          ["==", ["geometry-type"], "Polygon"],
          ["==", ["geometry-type"], "LineString"],
        ],
      ],
      dot: [
        "all",
        baseFilter,
        ["==", ["geometry-type"], "Point"],
        ["==", ["get", "showCircle"], 1],
      ],
      symbol: [
        "all",
        baseFilter,
        ["==", ["geometry-type"], "Point"],
        ["!=", ["get", "iconId"], ""],
      ],
      label: [
        "all",
        baseFilter,
        ["==", ["get", "showLabel"], 1],
        ["!=", ["coalesce", ["get", "callsign"], ["get", "name"], ""], ""],
      ],
    };
  }

  function packageLinePaint() {
    return {
      "line-color": ["coalesce", ["get", "stroke"], "#22d3ee"],
      "line-width": ["coalesce", ["get", "stroke-width"], 2],
      "line-opacity": ["coalesce", ["get", "stroke-opacity"], 1],
      "line-dasharray": [
        "case",
        ["==", ["get", "stroke-style"], "dashed"],
        ["literal", [2, 3]],
        ["==", ["get", "stroke-style"], "dotted"],
        ["literal", [0.1, 3]],
        ["literal", [1, 0]],
      ],
    };
  }

  function packageLabelLayout() {
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

  function packageLabelPaint() {
    return {
      "text-color": "#ffffff",
      "text-halo-color": "rgba(0, 0, 0, 0.75)",
      "text-halo-width": 1.25,
      "text-opacity": 1,
    };
  }

  function stampPackageVisibility(geojson, visible) {
    const show = visible !== false;
    const features = (geojson.features || []).map(function (feature) {
      return {
        type: feature.type,
        geometry: feature.geometry,
        properties: Object.assign({}, feature.properties || {}, {
          packageVisible: show ? 1 : 0,
        }),
      };
    });
    return Object.assign({}, geojson, { features: features });
  }

  function packageLayersReady() {
    if (bridge && typeof bridge.isMarkerLayersReady === "function") {
      return bridge.isMarkerLayersReady();
    }
    return !!(bridge && bridge.getMissionBeforeLayerId && bridge.getMissionBeforeLayerId());
  }

  function bumpPackageOp(hash) {
    const next = (packageLoadGen.get(hash) || 0) + 1;
    packageLoadGen.set(hash, next);
    return next;
  }

  function packageOpStale(hash, gen) {
    return (packageLoadGen.get(hash) || 0) !== gen;
  }

  function finishPackageBusy(hash, entry, gen) {
    if (packageOpStale(hash, gen)) return;
    entry.loading = false;
    if (entry.pendingVisible === false) {
      entry.pendingVisible = null;
      setPackageEnabled(hash, false);
      return;
    }
    if (entry.pendingVisible === true) {
      entry.pendingVisible = null;
    }
    writeState();
    renderPackageList();
  }

  function ensurePackageEntry(hash) {
    let entry = openPackages.get(hash);
    if (!entry) {
      entry = {
        visible: true,
        geojson: null,
        rasterOverlays: [],
        loading: false,
        pendingVisible: null,
        error: null,
        filename: "",
      };
      openPackages.set(hash, entry);
    }
    return entry;
  }

  function catalogEntry(hash) {
    for (let i = 0; i < packagesCatalog.length; i++) {
      if (String(packagesCatalog[i].hash || "") === String(hash)) return packagesCatalog[i];
    }
    return null;
  }

  function displayName(hash, entry) {
    const cat = catalogEntry(hash);
    if (cat && cat.filename) return cat.filename;
    if (entry && entry.filename) return entry.filename;
    return String(hash || "").slice(0, 12);
  }

  function packageIconManifest(entry) {
    if (!entry || !entry.geojson || !entry.geojson.meta) return [];
    return Array.isArray(entry.geojson.meta.iconManifest) ? entry.geojson.meta.iconManifest : [];
  }

  function collectOpenPackageIconManifest() {
    const out = [];
    const seen = new Set();
    openPackages.forEach(function (entry) {
      if (!entry || !entry.visible) return;
      const list = packageIconManifest(entry);
      for (let i = 0; i < list.length; i++) {
        const id = list[i] && list[i].mapImageId;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(list[i]);
      }
    });
    return out;
  }

  function registerPackageIconManifests() {
    if (bridge && typeof bridge.registerMissionIconManifest === "function") {
      bridge.registerMissionIconManifest(collectOpenPackageIconManifest());
    }
  }

  async function preloadPackageIcons(manifest, options) {
    const opts = options || {};
    const list = Array.isArray(manifest) ? manifest : [];
    if (!list.length || !bridge || typeof bridge.preloadMarkerIcons !== "function") {
      return;
    }
    // Register the exact manifest being loaded (merge), then any other open packages.
    if (typeof bridge.registerMissionIconManifest === "function") {
      bridge.registerMissionIconManifest(list);
    }
    registerPackageIconManifests();
    if (opts.prioritize) {
      try {
        await bridge.preloadMarkerIcons(list);
      } catch (_) {}
      return;
    }
    bridge.preloadMarkerIcons(list).catch(function () {});
  }

  function applyPackageLayerFilters(hash) {
    if (!map) return;
    const ids = packageLayerIds(hash);
    const filters = packageLayerFilters(packageBaseFilter());
    if (map.getLayer(ids.fill)) map.setFilter(ids.fill, filters.fill);
    if (map.getLayer(ids.line)) map.setFilter(ids.line, filters.line);
    if (map.getLayer(ids.dot)) map.setFilter(ids.dot, filters.dot);
    if (map.getLayer(ids.symbol)) map.setFilter(ids.symbol, filters.symbol);
    if (map.getLayer(ids.label)) map.setFilter(ids.label, filters.label);
  }

  function applyPackageLayerVisibility(hash) {
    if (!map) return;
    const entry = openPackages.get(hash);
    if (!entry) return;
    const ids = packageLayerIds(hash);
    const vis = entry.visible ? "visible" : "none";
    const layerIds = [ids.fill, ids.line, ids.symbol, ids.dot, ids.label];
    for (let i = 0; i < layerIds.length; i++) {
      if (map.getLayer(layerIds[i])) {
        map.setLayoutProperty(layerIds[i], "visibility", vis);
      }
    }
    applyPackageLayerFilters(hash);

    const rasters = entry.rasterOverlays || [];
    for (let j = 0; j < rasters.length; j++) {
      const rasterIds = packageRasterIds(hash, rasters[j].hash);
      if (map.getLayer(rasterIds.layer)) {
        map.setLayoutProperty(rasterIds.layer, "visibility", vis);
        map.setPaintProperty(rasterIds.layer, "raster-opacity", entry.visible ? 0.92 : 0);
      }
    }
    map.triggerRepaint();
  }

  function packageLayersInstalled(hash) {
    if (!map) return false;
    const ids = packageLayerIds(hash);
    return !!(map.getSource(packageSourceId(hash)) && map.getLayer(ids.fill));
  }

  function removePackageLayers(hash) {
    if (!map) return;
    const entry = openPackages.get(hash);
    removeRasterOverlays(hash, entry);
    const ids = packageLayerIds(hash);
    const layerIds = [ids.label, ids.symbol, ids.dot, ids.line, ids.fill];
    for (let i = 0; i < layerIds.length; i++) {
      if (map.getLayer(layerIds[i])) {
        try {
          map.removeLayer(layerIds[i]);
        } catch (_) {}
      }
      if (packageLayerClickHandlers.has(layerIds[i])) {
        try {
          map.off("click", layerIds[i], packageLayerClickHandlers.get(layerIds[i]));
        } catch (_) {}
        packageLayerClickHandlers.delete(layerIds[i]);
      }
    }
    const srcId = packageSourceId(hash);
    if (map.getSource(srcId)) {
      try {
        map.removeSource(srcId);
      } catch (_) {}
    }
  }

  function ensureRasterOverlays(hash, entry) {
    if (!map || !entry) return;
    const overlays = entry.rasterOverlays || [];
    const beforeId = getImageryBeforeLayerId();

    for (let i = 0; i < overlays.length; i++) {
      const ov = overlays[i];
      if (!ov.bounds || !ov.url) continue;
      const ids = packageRasterIds(hash, ov.hash);
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

  function removeRasterOverlays(hash, entry) {
    if (!map) return;
    const overlays = (entry && entry.rasterOverlays) || [];
    for (let i = 0; i < overlays.length; i++) {
      const ids = packageRasterIds(hash, overlays[i].hash);
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

  function ensurePackageLayers(hash, geojson) {
    const entry = openPackages.get(hash);
    const srcId = packageSourceId(hash);
    const ids = packageLayerIds(hash);
    const data = stampPackageVisibility(
      geojson || { type: "FeatureCollection", features: [] },
      entry ? entry.visible : true
    );
    const beforeId = bridge.getMissionBeforeLayerId();
    const filters = packageLayerFilters(packageBaseFilter());

    if (map.getSource(srcId)) {
      map.getSource(srcId).setData(data);
    } else {
      map.addSource(srcId, { type: "geojson", data: data });
    }

    if (!map.getLayer(ids.fill)) {
      map.addLayer(
        {
          id: ids.fill,
          type: "fill",
          source: srcId,
          filter: filters.fill,
          paint: {
            "fill-color": ["coalesce", ["get", "fill"], "#22d3ee"],
            "fill-opacity": ["coalesce", ["get", "fill-opacity"], 0.35],
          },
        },
        beforeId
      );
    }

    if (!map.getLayer(ids.line)) {
      map.addLayer(
        {
          id: ids.line,
          type: "line",
          source: srcId,
          filter: filters.line,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: packageLinePaint(),
        },
        beforeId
      );
    }

    if (!map.getLayer(ids.dot)) {
      map.addLayer(
        {
          id: ids.dot,
          type: "circle",
          source: srcId,
          filter: filters.dot,
          paint: {
            "circle-radius": 10,
            "circle-color": ["coalesce", ["get", "color"], ["get", "fill"], "#22d3ee"],
            "circle-stroke-width": 1.5,
            "circle-stroke-color": "#ffffff",
            "circle-opacity": 1,
          },
        },
        beforeId
      );
    }

    if (!map.getLayer(ids.symbol)) {
      map.addLayer(
        {
          id: ids.symbol,
          type: "symbol",
          source: srcId,
          filter: filters.symbol,
          layout: {
            "icon-image": ["get", "iconId"],
            "icon-size": 0.88,
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
            "icon-optional": true,
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
          filter: filters.label,
          layout: packageLabelLayout(),
          paint: packageLabelPaint(),
        },
        beforeId
      );
    }
  }

  function featureToMarkerRecord(feature) {
    const props = feature.properties || {};
    const geom = feature.geometry;
    if (!geom || geom.type !== "Point") return null;
    const uid = String(props.uid || feature.id || "");
    if (!uid) return null;
    return {
      uid: uid,
      callsign: props.callsign || props.name || uid.slice(0, 16),
      lon: geom.coordinates[0],
      lat: geom.coordinates[1],
      type: props.cotType || props.type || "",
      origin: "package",
      missionName: props.packageHash || props.missionName || "",
      iconId: props.apiIconId || "",
      teamColor: props.teamColor || null,
      color: props.color || null,
    };
  }

  function syncPackageMarkers(hash, entry) {
    if (!bridge || typeof bridge.registerMissionMarkers !== "function") return;
    const key = "pkg:" + hash;
    if (!entry || !entry.visible || !entry.geojson || !Array.isArray(entry.geojson.features)) {
      if (typeof bridge.clearMissionMarkers === "function") {
        bridge.clearMissionMarkers(key);
      }
      return;
    }
    const markers = [];
    for (let i = 0; i < entry.geojson.features.length; i++) {
      const marker = featureToMarkerRecord(entry.geojson.features[i]);
      if (marker) {
        marker.missionName = key;
        markers.push(marker);
      }
    }
    bridge.registerMissionMarkers(key, markers);
    if (typeof bridge.refreshGoToIfOpen === "function") {
      bridge.refreshGoToIfOpen();
    }
  }

  function bindPackageLayerHandlers() {
    if (!map || !bridge || typeof bridge.handleMapFeatureClick !== "function") return;
    openPackages.forEach(function (entry, hash) {
      if (!entry || !entry.visible) return;
      const ids = packageLayerIds(hash);
      const layerIds = [ids.symbol, ids.dot, ids.fill, ids.line];
      for (let i = 0; i < layerIds.length; i++) {
        const layerId = layerIds[i];
        if (!map.getLayer(layerId) || packageLayerClickHandlers.has(layerId)) continue;
        const handler = function (e) {
          if (bridge.suppressBackgroundClick) bridge.suppressBackgroundClick();
          bridge.handleMapFeatureClick(e);
        };
        map.on("click", layerId, handler);
        packageLayerClickHandlers.set(layerId, handler);
      }
    });
  }

  function getPackageHitLayers() {
    const layers = [];
    if (!map) return layers;
    openPackages.forEach(function (entry, hash) {
      if (!entry || !entry.visible) return;
      const ids = packageLayerIds(hash);
      const layerIds = [ids.symbol, ids.dot, ids.fill, ids.line];
      for (let i = 0; i < layerIds.length; i++) {
        if (map.getLayer(layerIds[i])) layers.push(layerIds[i]);
      }
    });
    return layers;
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
    if (geom.type === "Point") return geom.coordinates;
    if (geom.type === "LineString" && geom.coordinates.length) return geom.coordinates[0];
    if (geom.type === "Polygon" && geom.coordinates[0] && geom.coordinates[0].length) {
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

  function applyPackageLabelDeclutter(hash, options) {
    if (!map) return;
    const entry = openPackages.get(hash);
    if (!entry || !entry.geojson || !Array.isArray(entry.geojson.features)) return;

    const forceRecompute = !!(options && options.forceRecompute);
    const candidates = entry.geojson.features.filter(function (feature) {
      const props = feature.properties || {};
      const label = props.callsign || props.name || "";
      return !!label && !!featureLabelAnchor(feature);
    });
    const key =
      hash + "|" + String(Math.round(map.getZoom() * 4)) + "|" + candidates.length;
    if (!forceRecompute && packageLabelDeclutterKey.get(hash) === key) return;

    const sorted = candidates.slice().sort(function (a, b) {
      return String(a.properties?.callsign || "").localeCompare(
        String(b.properties?.callsign || "")
      );
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
      if (props.showLabel === showLabel) return feature;
      changed = true;
      return {
        type: feature.type,
        geometry: feature.geometry,
        properties: Object.assign({}, props, {
          showLabel: showLabel,
          packageVisible: entry.visible === false ? 0 : 1,
        }),
      };
    });

    if (!changed) {
      packageLabelDeclutterKey.set(hash, key);
      return;
    }
    entry.geojson = Object.assign({}, entry.geojson, { features: features });
    const src = map.getSource(packageSourceId(hash));
    if (src) src.setData(entry.geojson);
    packageLabelDeclutterKey.set(hash, key);
  }

  function applyAllPackageLabelDeclutter(options) {
    openPackages.forEach(function (_, hash) {
      applyPackageLabelDeclutter(hash, options);
    });
  }

  function applyLabelDeclutter(options) {
    applyAllPackageLabelDeclutter(options);
  }

  function schedulePackageLabelDeclutter() {
    if (labelDeclutterTimer) clearTimeout(labelDeclutterTimer);
    labelDeclutterTimer = setTimeout(function () {
      labelDeclutterTimer = null;
      applyAllPackageLabelDeclutter();
    }, 80);
  }

  async function installPackageOverlays(hash, entry, opGen, options) {
    const opts = options || {};
    const gen = opGen != null ? opGen : packageLoadGen.get(hash) || 0;
    if (!entry || !entry.visible || !entry.geojson) return;
    if (packageOpStale(hash, gen)) return;

    const manifest = packageIconManifest(entry);
    if (!opts.skipIconPreload && manifest.length) {
      await preloadPackageIcons(manifest, { prioritize: opts.prioritizeIcons !== false });
      if (packageOpStale(hash, gen) || !entry.visible) return;
    }

    ensurePackageLayers(hash, entry.geojson);
    applyPackageLayerVisibility(hash);
    ensureRasterOverlays(hash, entry);
    syncPackageMarkers(hash, entry);
    bindPackageLayerHandlers();
    applyPackageLabelDeclutter(hash, { forceRecompute: true });
    // Re-bind GeoJSON after icon preload so symbol layers pick up installed images.
    const src = map && map.getSource(packageSourceId(hash));
    if (src && entry.geojson) {
      try {
        src.setData(entry.geojson);
      } catch (_) {}
    }
    if (map) map.triggerRepaint();
  }

  function showPackageOverlaysSync(hash, entry) {
    if (!map || !entry || !entry.geojson || !entry.visible) return false;
    if (!packageLayersInstalled(hash)) return false;
    entry.geojson = stampPackageVisibility(entry.geojson, true);
    const src = map.getSource(packageSourceId(hash));
    if (src) src.setData(entry.geojson);
    applyPackageLayerVisibility(hash);
    ensureRasterOverlays(hash, entry);
    syncPackageMarkers(hash, entry);
    applyPackageLabelDeclutter(hash, { forceRecompute: true });
    writeState();
    renderPackageList();
    return true;
  }

  function showPackageOverlays(hash, entry) {
    entry.geojson = stampPackageVisibility(entry.geojson, true);
    if (packageLayersInstalled(hash)) {
      const manifest = packageIconManifest(entry);
      return preloadPackageIcons(manifest, { prioritize: true }).then(function () {
        if (!entry.visible) return;
        showPackageOverlaysSync(hash, entry);
      });
    }
    const gen = bumpPackageOp(hash);
    entry.loading = true;
    entry.error = null;
    renderPackageList();
    return whenLiveReady(function () {
      return installPackageOverlays(hash, entry, gen, { prioritizeIcons: true });
    })
      .catch(function (err) {
        if (!packageOpStale(hash, gen)) {
          entry.error = err?.message || String(err);
        }
      })
      .finally(function () {
        finishPackageBusy(hash, entry, gen);
      });
  }

  async function fetchPackageGeojson(hash, options) {
    const opts = options || {};
    const cat = catalogEntry(hash);
    const qs = new URLSearchParams();
    if (opts.refresh) qs.set("refresh", "1");
    if (cat && cat.filename) qs.set("filename", cat.filename);
    const url =
      "/api/map/packages/" +
      encodeURIComponent(hash) +
      "/geojson" +
      (qs.toString() ? "?" + qs.toString() : "");
    const resp = await fetch(url, { credentials: "same-origin" });
    if (!resp.ok) {
      let msg = "package " + resp.status;
      try {
        const body = await resp.json();
        if (body && body.error) msg = body.error;
      } catch (_) {}
      throw new Error(msg);
    }
    return resp.json();
  }

  async function loadPackage(hash, options) {
    const opts = options || {};
    const gen = bumpPackageOp(hash);
    const entry = ensurePackageEntry(hash);
    const cat = catalogEntry(hash);
    if (cat && cat.filename) entry.filename = cat.filename;
    entry.loading = true;
    entry.error = null;
    renderPackageList();

    try {
      const [geojson] = await Promise.all([
        fetchPackageGeojson(hash, { refresh: !!opts.refresh }),
        whenLiveReady(function () {}),
      ]);
      if (packageOpStale(hash, gen)) return;

      entry.error = null;
      entry.geojson = stampPackageVisibility(geojson, entry.visible);
      entry.rasterOverlays =
        geojson.meta && Array.isArray(geojson.meta.rasterOverlays)
          ? geojson.meta.rasterOverlays
          : [];
      if (geojson.meta && geojson.meta.packageName) {
        entry.filename = geojson.meta.packageName;
      }

      if (entry.visible) {
        await preloadPackageIcons(packageIconManifest(entry), { prioritize: true });
        if (packageOpStale(hash, gen)) return;
        await installPackageOverlays(hash, entry, gen, {
          skipIconPreload: true,
          prioritizeIcons: true,
        });
      }
    } catch (err) {
      if (!packageOpStale(hash, gen)) {
        entry.error = err?.message || String(err);
      }
    } finally {
      finishPackageBusy(hash, entry, gen);
    }
  }

  function setPackageEnabled(hash, enabled) {
    const wantOn = !!enabled;
    let entry = openPackages.get(hash);

    if (wantOn) {
      if (!entry) {
        entry = ensurePackageEntry(hash);
        entry.visible = true;
        loadPackage(hash);
        return;
      }
      if (entry.loading) {
        entry.pendingVisible = true;
        entry.visible = true;
        writeState();
        renderPackageList();
        return;
      }
      entry.pendingVisible = null;
      entry.visible = true;
      if (entry.geojson) {
        showPackageOverlays(hash, entry).catch(function (err) {
          entry.error = err?.message || String(err);
          renderPackageList();
        });
        return;
      }
      loadPackage(hash);
      return;
    }

    if (!entry) return;
    bumpPackageOp(hash);
    entry.pendingVisible = false;
    entry.visible = false;
    entry.loading = false;
    if (bridge && typeof bridge.clearMissionMarkers === "function") {
      bridge.clearMissionMarkers("pkg:" + hash);
    }
    if (entry.geojson) {
      entry.geojson = stampPackageVisibility(entry.geojson, false);
      const src = map && map.getSource(packageSourceId(hash));
      if (src) src.setData(entry.geojson);
    }
    applyPackageLayerVisibility(hash);
    writeState();
    renderPackageList();
  }

  function setAllPackagesEnabled(enabled) {
    const wantOn = !!enabled;
    for (let i = 0; i < packagesCatalog.length; i++) {
      const hash = String(packagesCatalog[i].hash || "").trim();
      if (!hash) continue;
      setPackageEnabled(hash, wantOn);
    }
  }

  function extendBoundsPoint(bounds, lon, lat) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return bounds;
    if (!bounds) return { west: lon, south: lat, east: lon, north: lat };
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
    }
    return bounds;
  }

  function flyToPackageExtent(hash) {
    const entry = openPackages.get(hash);
    if (!map || !entry) return;
    let bounds = null;
    const features =
      entry.geojson && Array.isArray(entry.geojson.features) ? entry.geojson.features : [];
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
    if (!bounds) return;
    if (bounds.west === bounds.east && bounds.south === bounds.north) {
      map.easeTo({ center: [bounds.west, bounds.south], zoom: Math.max(map.getZoom(), 14) });
      return;
    }
    map.fitBounds(
      [
        [bounds.west, bounds.south],
        [bounds.east, bounds.north],
      ],
      { padding: 48, maxZoom: 16, duration: 700 }
    );
  }

  function packageMetaLine(entry) {
    if (!entry || !entry.geojson) return "";
    const parts = [];
    const n = Array.isArray(entry.geojson.features) ? entry.geojson.features.length : 0;
    parts.push(n + " feat");
    const att = entry.geojson.meta && entry.geojson.meta.attachmentSummary;
    if (att && att.kml > 0) parts.push(att.kml + " kml");
    if (att && att.cotFiles > 0) parts.push(att.cotFiles + " cot");
    const rasterCount = Math.max(
      (entry.rasterOverlays || []).length,
      att && att.raster ? att.raster : 0
    );
    if (rasterCount > 0) parts.push(rasterCount + " raster");
    return parts.join(" · ");
  }

  function scheduleRenderPackageList() {
    if (renderPackageListTimer) return;
    renderPackageListTimer = setTimeout(function () {
      renderPackageListTimer = null;
      renderPackageListNow();
    }, 32);
  }

  function renderPackageList() {
    scheduleRenderPackageList();
  }

  function renderPackageListNow() {
    if (!listEl) return;
    const q = String(searchEl?.value || "")
      .trim()
      .toLowerCase();
    const catalog = packagesCatalog.filter(function (p) {
      const name = String(p.filename || p.hash || "").toLowerCase();
      return !q || name.includes(q);
    });

    listEl.innerHTML = "";
    if (!catalog.length) {
      listEl.innerHTML = '<div class="map-mission-empty">No data packages available.</div>';
      return;
    }

    for (let i = 0; i < catalog.length; i++) {
      const pkg = catalog[i];
      const hash = String(pkg.hash || "").trim();
      if (!hash) continue;
      const entry = openPackages.get(hash);
      const isOn = !!(entry && entry.visible);
      const name = String(pkg.filename || hash).trim();

      const row = document.createElement("div");
      row.className = "map-mission-row" + (isOn ? " is-on" : "");

      const head = document.createElement("div");
      head.className = "map-mission-row-head";

      const headTop = document.createElement("div");
      headTop.className = "map-mission-row-top";

      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "map-mission-toggle" + (isOn ? " is-on" : " is-off");
      toggleBtn.title = isOn ? "Hide package overlays" : "Show package overlays";
      toggleBtn.setAttribute("aria-pressed", isOn ? "true" : "false");
      toggleBtn.setAttribute("aria-label", (isOn ? "Hide " : "Show ") + name);
      toggleBtn.addEventListener("click", function () {
        setPackageEnabled(hash, !isOn);
      });

      const title = document.createElement("span");
      title.className = "map-mission-name is-clickable";
      title.textContent = name;
      title.title = "Zoom map to package extent";
      title.addEventListener("click", function (ev) {
        ev.stopPropagation();
        flyToPackageExtent(hash);
      });
      if (pkg.archived) {
        const badge = document.createElement("span");
        badge.className = "map-mission-badge";
        badge.textContent = "archived";
        title.appendChild(document.createTextNode(" "));
        title.appendChild(badge);
      }

      const downloadBtn = document.createElement("button");
      downloadBtn.type = "button";
      downloadBtn.className = "map-mission-refresh-btn map-package-download-btn";
      downloadBtn.textContent = "⬇";
      downloadBtn.title = "Download package";
      downloadBtn.setAttribute("aria-label", "Download " + name);
      downloadBtn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        const qs = new URLSearchParams();
        if (name) qs.set("fileName", name);
        const url =
          "/api/map/packages/" +
          encodeURIComponent(hash) +
          "/download" +
          (qs.toString() ? "?" + qs.toString() : "");
        window.location.assign(url);
      });

      const refreshBtn = document.createElement("button");
      refreshBtn.type = "button";
      refreshBtn.className = "map-mission-refresh-btn";
      refreshBtn.textContent = "↻";
      refreshBtn.title = "Refresh package";
      refreshBtn.disabled = !isOn || (entry && entry.loading);
      refreshBtn.addEventListener("click", function () {
        loadPackage(hash, { refresh: true });
      });

      headTop.appendChild(toggleBtn);
      headTop.appendChild(title);
      headTop.appendChild(downloadBtn);
      headTop.appendChild(refreshBtn);
      head.appendChild(headTop);

      if (entry && entry.loading) {
        const status = document.createElement("div");
        status.className = "map-mission-meta map-mission-meta-status";
        status.textContent = "Loading…";
        head.appendChild(status);
      } else if (entry && entry.error) {
        const status = document.createElement("div");
        status.className = "map-mission-meta map-mission-meta-error";
        status.textContent = entry.error;
        head.appendChild(status);
      } else if (entry && isOn) {
        const meta = packageMetaLine(entry);
        if (meta) {
          const metaEl = document.createElement("div");
          metaEl.className = "map-mission-meta";
          metaEl.textContent = meta;
          head.appendChild(metaEl);
        }
      }

      row.appendChild(head);
      listEl.appendChild(row);
    }
  }

  async function refreshPackageCatalog() {
    try {
      const resp = await fetch("/api/map/packages", { credentials: "same-origin" });
      if (!resp.ok) throw new Error("packages " + resp.status);
      const data = await resp.json();
      packagesCatalog = Array.isArray(data.packages) ? data.packages : [];
      renderPackageList();
    } catch (err) {
      if (listEl) {
        listEl.innerHTML =
          '<div class="map-mission-empty map-mission-status-error">' +
          escapeHtml(err?.message || "Failed to load packages") +
          "</div>";
      }
    }
  }

  function restoreOpenPackages() {
    const state = readState();
    for (let i = 0; i < state.open.length; i++) {
      const hash = state.open[i];
      const settings = state.settings[hash] || {};
      openPackages.set(hash, {
        visible: settings.visible !== false,
        geojson: null,
        rasterOverlays: [],
        loading: false,
        pendingVisible: null,
        error: null,
        filename: "",
      });
    }
    whenLiveReady(function () {
      const pending = readState();
      for (let i = 0; i < pending.open.length; i++) {
        const hash = pending.open[i];
        const settings = pending.settings[hash] || {};
        if (settings.visible !== false) loadPackage(hash);
      }
    });
  }

  function reinstallPackageOverlays(hash, entry) {
    removePackageLayers(hash);
    if (!entry || !entry.geojson || !entry.visible) {
      if (entry && entry.geojson) {
        entry.geojson = stampPackageVisibility(entry.geojson, false);
      }
      return Promise.resolve();
    }
    return showPackageOverlays(hash, entry);
  }

  function restoreAfterStyleChange(options) {
    if (!map) return Promise.resolve();
    if (styleRestoreTimer) clearTimeout(styleRestoreTimer);
    packageStyleRestoreGen++;
    const gen = packageStyleRestoreGen;
    packageLabelDeclutterKey.clear();

    return new Promise(function (resolve) {
      function finishRestore(jobs) {
        Promise.all(Array.isArray(jobs) ? jobs : [])
          .then(function () {
            if (gen !== packageStyleRestoreGen || !map) {
              resolve();
              return;
            }
            registerPackageIconManifests();
            openPackages.forEach(function (entry, hash) {
              applyPackageLayerVisibility(hash);
              syncPackageMarkers(hash, entry);
            });
            bindPackageLayerHandlers();
            applyAllPackageLabelDeclutter({ forceRecompute: true });
            resolve();
          })
          .catch(function () {
            resolve();
          });
      }

      function tryRestore(attempt) {
        if (gen !== packageStyleRestoreGen || !map) {
          resolve();
          return;
        }
        if (!map.isStyleLoaded() || !packageLayersReady()) {
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
        openPackages.forEach(function (entry, hash) {
          if (!entry || !entry.visible) return;
          if (!entry.geojson) {
            jobs.push(loadPackage(hash));
            return;
          }
          if (packageLayersInstalled(hash)) {
            jobs.push(
              Promise.resolve().then(function () {
                showPackageOverlaysSync(hash, entry);
              })
            );
            return;
          }
          jobs.push(reinstallPackageOverlays(hash, entry));
        });
        finishRestore(jobs);
      }

      tryRestore(0);
    });
  }

  function ensureCatalog() {
    if (!packagesCatalog.length) return refreshPackageCatalog();
    return Promise.resolve();
  }

  function init(api) {
    bridge = api;
    map = api.getMap();
    storageKey = api.getStorageKey ? api.getStorageKey() : "anonymous";
    listEl = document.getElementById("mapPackageList");
    searchEl = document.getElementById("mapPackageSearch");

    if (searchEl) {
      searchEl.addEventListener("input", renderPackageList);
    }

    const allBtn = document.getElementById("mapPackagesAll");
    const noneBtn = document.getElementById("mapPackagesNone");
    if (allBtn) {
      allBtn.addEventListener("click", function () {
        setAllPackagesEnabled(true);
      });
    }
    if (noneBtn) {
      noneBtn.addEventListener("click", function () {
        setAllPackagesEnabled(false);
      });
    }

    map.on("moveend", schedulePackageLabelDeclutter);
    map.on("zoomend", schedulePackageLabelDeclutter);
    refreshPackageCatalog().then(restoreOpenPackages);
  }

  window.TakMapPackages = {
    init: init,
    ensureCatalog: ensureCatalog,
    restoreAfterStyleChange: restoreAfterStyleChange,
    applyLabelDeclutter: applyLabelDeclutter,
    getHitLayers: getPackageHitLayers,
    setAllPackagesEnabled: setAllPackagesEnabled,
    flyToPackageExtent: flyToPackageExtent,
  };
})();
