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
  let popup = null;
  let labelDeclutterTimer = null;
  const missionLabelDeclutterKey = new Map();

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
    removeRasterOverlays(name, entry);
    missionLabelDeclutterKey.delete(name);
    const srcId = missionSourceId(name);
    const ids = missionLayerIds(name);
    const allIds = [ids.fill, ids.line, ids.symbol, ids.label];
    for (let i = 0; i < allIds.length; i++) {
      const layerId = allIds[i];
      if (map.getLayer(layerId)) {
        try {
          map.removeLayer(layerId);
        } catch (_) {}
      }
    }
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
      if (manifest.length && typeof bridge.preloadMarkerIcons === "function") {
        await bridge.preloadMarkerIcons(manifest);
      }
    }
    ensureRasterOverlays(name, entry);
    ensureMissionLayers(name, entry.geojson);
    applyMissionLayerVisibility(name);
    applyMissionLabelDeclutter(name, { forceRecompute: true });
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
        installMissionOverlays(name, entry)
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

  function showFeaturePopup(props) {
    if (!map) return;
    if (!popup) popup = new maplibregl.Popup({ closeButton: true, maxWidth: "280px" });
    const coords = props?._clickCoords;
    if (!coords) return;
    const html =
      '<div class="map-mission-popup">' +
      '<div class="map-mission-popup-title">' +
      escapeHtml(featureLabel(props)) +
      "</div>" +
      (props.missionName
        ? '<div class="map-mission-popup-meta">Mission: ' + escapeHtml(props.missionName) + "</div>"
        : "") +
      (props.cotType
        ? '<div class="map-mission-popup-meta">Type: ' + escapeHtml(props.cotType) + "</div>"
        : "") +
      (props.remarks
        ? '<div class="map-mission-popup-remarks">' + escapeHtml(String(props.remarks)) + "</div>"
        : "") +
      "</div>";
    popup.setLngLat(coords).setHTML(html).addTo(map);
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function onMapClick(e) {
    if (!map) return;
    const layers = [];
    openMissions.forEach(function (_, name) {
      const ids = missionLayerIds(name);
      layers.push(ids.fill, ids.line, ids.symbol, ids.label);
    });
    const hits = map.queryRenderedFeatures(e.point, { layers: layers.filter((id) => map.getLayer(id)) });
    if (!hits.length) return;
    const feat = hits[0];
    const props = Object.assign({}, feat.properties || {}, { _clickCoords: e.lngLat });
    showFeaturePopup(props);
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
      title.className = "map-mission-name";
      title.textContent = name;
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
      if (visible) loadMission(name);
    }
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
            });
            map.triggerRepaint();
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

    map.on("click", onMapClick);
    map.on("moveend", scheduleMissionLabelDeclutter);
    map.on("zoomend", scheduleMissionLabelDeclutter);
    refreshMissionCatalog().then(restoreOpenMissions);
  }

  window.TakMapMissions = {
    init: init,
    restoreAfterStyleChange: restoreAfterStyleChange,
  };
})();
