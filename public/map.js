(function () {
  "use strict";

  const LS_BASEMAP = "tak-portal-map-basemap";
  const LS_GROUPS = "tak-portal-map-groups";
  const LS_PANEL_LEFT = "tak-portal-map-panel-left";
  const LS_PANEL_RIGHT = "tak-portal-map-panel-right";

  const AFFILIATION_COLORS = {
    friend: "#22c55e",
    hostile: "#ef4444",
    neutral: "#eab308",
    unknown: "#f97316",
    other: "#38bdf8",
  };

  const MAP_GLYPHS = "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf";
  const MARKER_FILTER = ["==", ["get", "kind"], "marker"];

  function withMapGlyphs(style) {
    if (typeof style === "string") return style;
    return { ...style, glyphs: MAP_GLYPHS };
  }

  function rasterBasemapStyle(label, tileUrl, attribution, maxzoom) {
    return withMapGlyphs({
      version: 8,
      sources: {
        basemap: {
          type: "raster",
          tiles: [tileUrl.replace(/\{\$x\}/g, "{x}").replace(/\{\$y\}/g, "{y}").replace(/\{\$z\}/g, "{z}")],
          tileSize: 256,
          attribution,
          maxzoom: maxzoom || 18,
        },
      },
      layers: [{ id: "basemap", type: "raster", source: "basemap" }],
    });
  }

  const BASEMAPS = {
    dark: {
      label: "Dark",
      style: withMapGlyphs({
        version: 8,
        sources: {
          basemap: {
            type: "raster",
            tiles: [
              "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
              "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
              "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
            ],
            tileSize: 256,
            attribution:
              '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
          },
        },
        layers: [{ id: "basemap", type: "raster", source: "basemap" }],
      }),
    },
    "dark-matter": {
      label: "Dark Matter",
      style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    },
    light: {
      label: "Light",
      style: withMapGlyphs({
        version: 8,
        sources: {
          basemap: {
            type: "raster",
            tiles: [
              "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png",
              "https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png",
              "https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png",
            ],
            tileSize: 256,
            attribution:
              '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
          },
        },
        layers: [{ id: "basemap", type: "raster", source: "basemap" }],
      }),
    },
    satellite: {
      label: "Satellite",
      style: withMapGlyphs({
        version: 8,
        sources: {
          basemap: {
            type: "raster",
            tiles: [
              "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
            ],
            tileSize: 256,
            attribution: "Esri, Maxar, Earthstar Geographics",
          },
        },
        layers: [{ id: "basemap", type: "raster", source: "basemap" }],
      }),
    },
    topo: {
      label: "Topographic",
      style: withMapGlyphs({
        version: 8,
        sources: {
          basemap: {
            type: "raster",
            tiles: ["https://tile.opentopomap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution:
              '&copy; <a href="https://opentopomap.org">OpenTopoMap</a>, OSM',
          },
        },
        layers: [{ id: "basemap", type: "raster", source: "basemap" }],
      }),
    },
    "google-maps": {
      label: "Google Maps",
      style: rasterBasemapStyle(
        "Google Maps",
        "https://mts1.google.com/vt/lyrs=m&hl=en&x={x}&y={y}&z={z}&s=Gal&apistyle=s.t:2|s.e:l|p.v:off",
        "Google",
        18
      ),
    },
    "google-satellite": {
      label: "Google Satellite",
      style: rasterBasemapStyle(
        "Google Satellite",
        "https://mt1.google.com/vt/lyrs=s&hl=en&x={x}&y={y}&z={z}",
        "Google",
        22
      ),
    },
    "google-terrain": {
      label: "Google Terrain",
      style: rasterBasemapStyle(
        "Google Terrain",
        "https://mts1.google.com/vt/lyrs=p&hl=en&x={x}&y={y}&z={z}",
        "Google",
        18
      ),
    },
    "google-traffic": {
      label: "Google Traffic",
      style: rasterBasemapStyle(
        "Google Traffic",
        "https://mt0.google.com/vt/lyrs=m,parking,traffic&hl=en&x={x}&y={y}&z={z}&apistyle=s.t:2|s.e:l|p.v:off",
        "Google",
        18
      ),
    },
    "google-transit": {
      label: "Google Transit",
      style: rasterBasemapStyle(
        "Google Transit",
        "https://mt0.google.com/vt/lyrs=m,transit&hl=en&x={x}&y={y}&z={z}&apistyle=s.t:2|s.e:l|p.v:off",
        "Google",
        18
      ),
    },
  };

  const markersByUid = new Map();
  let groupsCatalog = [];
  let enabledGroups = loadEnabledGroups();
  let selectedUid = null;
  let filterText = "";
  let layerFilterText = "";
  let followSelected = false;
  let activeTab = "channels";
  let popup = null;
  let markerLayersReady = false;
  let pendingFitVisible = true;
  let copyToastTimer = null;
  let defaultIconIds = {};
  const iconLoadPending = new Map();
  const mapImageIdByIconId = new Map();
  const iconIdByMapImageId = new Map();

  function registerMapImageId(iconId) {
    if (!iconId) return "";
    let mapped = mapImageIdByIconId.get(iconId);
    if (!mapped) {
      mapped = "tak-icon-" + mapImageIdByIconId.size;
      mapImageIdByIconId.set(iconId, mapped);
      iconIdByMapImageId.set(mapped, iconId);
    }
    return mapped;
  }

  function iconApiUrl(iconId) {
    return "/api/map/icons?id=" + encodeURIComponent(iconId);
  }

  function milIconCacheKey(plan) {
    if (plan.sidc2525D) return "mil:" + plan.sidc2525D;
    return "mil:" + plan.cotType;
  }

  function resolveMarkerIconPlan(m) {
    if (m.iconId && (m.iconSource === "path" || m.iconSource === "usericon")) {
      return { kind: "png", apiIconId: m.iconId };
    }
    if (window.MapSymbology && MapSymbology.is2525Convertable(m.type)) {
      return {
        kind: "mil",
        cotType: m.type,
        sidc2525D: m.symbolSidc2525D || null,
      };
    }
    if (m.iconId) return { kind: "png", apiIconId: m.iconId };
    const aff = m.affiliation || "other";
    const fallback =
      defaultIconIds[aff] || defaultIconIds.friend || defaultIconIds.unknown || "";
    if (fallback) return { kind: "png", apiIconId: fallback };
    return { kind: "circle" };
  }

  function resolveMarkerIconId(m) {
    return resolveMarkerIconPlan(m).apiIconId || "";
  }

  function loadMilSymbolIcon(plan, mapImageId, course) {
    if (!window.MapSymbology || !plan.cotType) return Promise.resolve();
    if (map.hasImage(mapImageId)) return Promise.resolve();
    if (iconLoadPending.has(mapImageId)) return iconLoadPending.get(mapImageId);

    const promise = Promise.resolve()
      .then(() => {
        const canvas = MapSymbology.renderMilSymbolCanvas(plan.cotType, {
          size: 48,
          course: Number.isFinite(course) ? course : undefined,
          sidc2525D: plan.sidc2525D || undefined,
        });
        if (!canvas) throw new Error("invalid symbol");
        if (!map.hasImage(mapImageId)) map.addImage(mapImageId, canvas, { pixelRatio: 2 });
      })
      .then(() => {
        if (map.getLayer(ICON_LAYER)) map.triggerRepaint();
      })
      .catch(() => {})
      .finally(() => {
        iconLoadPending.delete(mapImageId);
      });

    iconLoadPending.set(mapImageId, promise);
    return promise;
  }

  function loadMapIcon(iconId, mapImageId) {
    const imageName = mapImageId || registerMapImageId(iconId);
    if (!iconId || map.hasImage(imageName)) return Promise.resolve();
    const pendingKey = imageName;
    if (iconLoadPending.has(pendingKey)) return iconLoadPending.get(pendingKey);

    const promise = fetch(iconApiUrl(iconId))
      .then((resp) => {
        if (!resp.ok) throw new Error("icon " + resp.status);
        return resp.blob();
      })
      .then((blob) => {
        if (typeof createImageBitmap === "function") {
          return createImageBitmap(blob).then((bitmap) => {
            if (!map.hasImage(imageName)) map.addImage(imageName, bitmap, { pixelRatio: 2 });
          });
        }
        return new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            try {
              if (!map.hasImage(imageName)) map.addImage(imageName, img, { pixelRatio: 2 });
              resolve();
            } catch (err) {
              reject(err);
            }
          };
          img.onerror = reject;
          img.src = URL.createObjectURL(blob);
        });
      })
      .then(() => {
        if (map.getLayer(ICON_LAYER)) map.triggerRepaint();
      })
      .catch(() => {})
      .finally(() => {
        iconLoadPending.delete(pendingKey);
      });

    iconLoadPending.set(pendingKey, promise);
    return promise;
  }

  function ensureMarkerIcon(m, mapImageId) {
    const plan = resolveMarkerIconPlan(m);
    if (plan.kind === "mil") {
      return loadMilSymbolIcon(plan, mapImageId, m.course);
    }
    if (plan.kind === "png" && plan.apiIconId) {
      return loadMapIcon(plan.apiIconId, mapImageId);
    }
    return Promise.resolve();
  }

  function preloadMarkerIcons() {
    const jobs = [];
    for (const m of markersByUid.values()) {
      const plan = resolveMarkerIconPlan(m);
      if (plan.kind === "circle") continue;
      const mapImageId = registerMapImageId(
        plan.kind === "mil" ? milIconCacheKey(plan) : plan.apiIconId
      );
      jobs.push(ensureMarkerIcon(m, mapImageId));
    }
    for (const id of Object.values(defaultIconIds).filter(Boolean)) {
      jobs.push(loadMapIcon(id, registerMapImageId(id)));
    }
    return Promise.all(jobs);
  }

  function onStyleImageMissing(e) {
    const mapImageId = e.id;
    if (!mapImageId || iconLoadPending.has(mapImageId)) return;
    const raw = iconIdByMapImageId.get(mapImageId) || mapImageId;
    if (String(raw).startsWith("mil:")) {
      const payload = raw.slice(4);
      const plan =
        /^\d{10,}$/.test(payload)
          ? { kind: "mil", cotType: "", sidc2525D: payload }
          : { kind: "mil", cotType: payload };
      loadMilSymbolIcon(plan, mapImageId).then(() => {
        if (map.getLayer(ICON_LAYER)) map.triggerRepaint();
      });
      return;
    }
    loadMapIcon(raw, mapImageId).then(() => {
      if (map.getLayer(ICON_LAYER)) map.triggerRepaint();
    });
  }

  const elLayerList = document.getElementById("mapLayerList");
  const elList = document.getElementById("mapMarkerList");
  const elDetail = document.getElementById("mapDetail");
  const elDetailActions = document.getElementById("mapDetailActions");
  const elVisibleCounts = document.getElementById("mapVisibleCounts");
  const elConnLabel = document.getElementById("mapConnLabel");
  const elConnDot = document.getElementById("mapConnDot");
  const elHost = document.getElementById("mapStreamHost");
  const elUpdated = document.getElementById("mapUpdated");
  const elCursor = document.getElementById("mapCursor");
  const elZoom = document.getElementById("mapZoom");
  const elBasemapLabel = document.getElementById("mapBasemapLabel");
  const elSearch = document.getElementById("mapSearch");
  const elLayerSearch = document.getElementById("mapLayerSearch");
  const elFit = document.getElementById("mapFitBtn");
  const elBasemapSelect = document.getElementById("mapBasemapSelect");
  const elFollowCheck = document.getElementById("mapFollowCheck");
  const elZulu = document.getElementById("mapZulu");
  const elOffline = document.getElementById("mapOfflineBanner");
  const elPanelLeft = document.getElementById("mapPanelLeft");
  const elPanelRight = document.getElementById("mapPanelRight");
  const elExpandLeft = document.getElementById("mapExpandLeft");
  const elExpandRight = document.getElementById("mapExpandRight");
  const elCenterBtn = document.getElementById("mapCenterBtn");
  const elCopyCoordsBtn = document.getElementById("mapCopyCoordsBtn");

  const savedBasemap = localStorage.getItem(LS_BASEMAP) || "dark";
  elBasemapSelect.innerHTML = Object.entries(BASEMAPS)
    .map(([id, def]) => `<option value="${id}">${def.label}</option>`)
    .join("");
  if (BASEMAPS[savedBasemap]) elBasemapSelect.value = savedBasemap;

  const initialBasemap = BASEMAPS[elBasemapSelect.value] || BASEMAPS.dark;
  elBasemapLabel.textContent = initialBasemap.label;

  const map = new maplibregl.Map({
    container: "map",
    style: withMapGlyphs(initialBasemap.style),
    center: [-98.5795, 39.8283],
    zoom: 4,
    attributionControl: true,
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

  restorePanelState();

  const SOURCE_ID = "tak-markers";
  const ICON_LAYER = "tak-markers-icon";
  const CIRCLE_LAYER = "tak-markers-circle";
  const LABEL_LAYER = "tak-markers-label";
  const COURSE_LAYER = "tak-markers-course";
  const TAG_LAYER = "tak-markers-tag";

  function loadEnabledGroups() {
    try {
      const raw = localStorage.getItem(LS_GROUPS);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? new Set(parsed) : null;
    } catch (_) {
      return null;
    }
  }

  function normalizeEnabledGroups(set) {
    if (!set) return set;
    const out = new Set();
    for (const name of set) {
      const key = channelGroupKey(name);
      if (!key) continue;
      const match = groupsCatalog.find((g) => channelGroupKey(g.name) === key);
      out.add(match ? match.name : name);
    }
    return out.size ? out : null;
  }

  function saveEnabledGroups() {
    if (!enabledGroups) return;
    localStorage.setItem(LS_GROUPS, JSON.stringify(Array.from(enabledGroups)));
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
    elCursor.textContent = text;
    if (copyToastTimer) clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(() => {
      copyToastTimer = null;
    }, 1500);
  }

  function removeMarkerLayers() {
    for (const id of [TAG_LAYER, LABEL_LAYER, ICON_LAYER, CIRCLE_LAYER, COURSE_LAYER]) {
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
      .filter((m) => Number.isFinite(m.lon) && Number.isFinite(m.lat))
      .map((m) => [m.lon, m.lat]);
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

  function setPanelLeftCollapsed(collapsed) {
    elPanelLeft.classList.toggle("collapsed", collapsed);
    elExpandLeft.hidden = !collapsed;
    localStorage.setItem(LS_PANEL_LEFT, collapsed ? "collapsed" : "open");
  }

  function setPanelRightCollapsed(collapsed) {
    elPanelRight.classList.toggle("collapsed", collapsed);
    elExpandRight.hidden = !collapsed;
    localStorage.setItem(LS_PANEL_RIGHT, collapsed ? "collapsed" : "open");
  }

  function restorePanelState() {
    setPanelLeftCollapsed(localStorage.getItem(LS_PANEL_LEFT) === "collapsed");
    setPanelRightCollapsed(localStorage.getItem(LS_PANEL_RIGHT) === "collapsed");
  }

  function affiliationColor(aff) {
    return AFFILIATION_COLORS[aff] || AFFILIATION_COLORS.other;
  }

  function normalizeMarkerColor(raw, fallback) {
    if (raw == null || raw === "") return fallback;
    const s = String(raw).trim();
    if (/^#[0-9a-f]{3,8}$/i.test(s)) {
      if (s.length === 4 || s.length === 7) return s;
      return s.slice(0, 7);
    }
    const n = Number(s);
    if (!Number.isFinite(n)) return fallback;
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
    return normalizeMarkerColor(m.teamColor, affiliationColor(m.affiliation));
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
    return n.toLowerCase().startsWith("tak_") && !n.startsWith("_");
  }

  function channelGroupKey(name) {
    const base = stripChannelBehaviorSuffix(name);
    if (!base || base.toLowerCase() === "unassigned") return "";
    return base.toLowerCase().replace(/\s+/g, " ").trim();
  }

  function markerChannelKeys(m) {
    return markerGroups(m).map(channelGroupKey).filter(Boolean);
  }

  function isChannelKeyEnabled(key) {
    if (!enabledGroups || !key) return true;
    for (const enabled of enabledGroups) {
      if (channelGroupKey(enabled) === key) return true;
    }
    return false;
  }

  function markerGroups(m) {
    if (Array.isArray(m.groups) && m.groups.length) return m.groups;
    return ["Unassigned"];
  }

  function isGroupEnabled(groupName) {
    return isChannelKeyEnabled(channelGroupKey(groupName));
  }

  function markerVisible(m) {
    const keys = markerChannelKeys(m);
    if (enabledGroups && (!keys.length || !keys.some((k) => isChannelKeyEnabled(k)))) return false;
    if (!markerMatchesSearch(m)) return false;
    return true;
  }

  function markerMatchesSearch(m) {
    if (!filterText) return true;
    const q = filterText.toLowerCase();
    return (
      String(m.callsign || "").toLowerCase().includes(q) ||
      String(m.uid || "").toLowerCase().includes(q) ||
      String(m.type || "").toLowerCase().includes(q) ||
      markerGroups(m).some((g) => String(g).toLowerCase().includes(q))
    );
  }

  function getVisibleMarkers() {
    return Array.from(markersByUid.values()).filter(markerVisible);
  }

  function ensureDefaultGroupsEnabled() {
    if (enabledGroups) return;
    enabledGroups = new Set();
    for (const g of groupsCatalog) {
      if (isMapChannelName(g.name)) enabledGroups.add(g.name);
    }
    for (const m of markersByUid.values()) {
      for (const gn of markerGroups(m)) {
        if (isMapChannelName(gn)) enabledGroups.add(gn);
      }
    }
    saveEnabledGroups();
  }

  function mergeGroupsCatalog(incoming) {
    const byKey = new Map();
    for (const g of groupsCatalog) {
      const key = channelGroupKey(g.name);
      if (key) byKey.set(key, g);
    }
    for (const g of incoming || []) {
      if (!isMapChannelName(g.name)) continue;
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
    enabledGroups = normalizeEnabledGroups(enabledGroups);
    ensureDefaultGroupsEnabled();
  }

  function recomputeGroupCounts() {
    const counts = new Map();
    for (const m of markersByUid.values()) {
      for (const key of markerChannelKeys(m)) {
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    groupsCatalog = groupsCatalog
      .filter((g) => isMapChannelName(g.name))
      .map((g) => ({
        ...g,
        markerCount: counts.get(channelGroupKey(g.name)) || 0,
      }));
  }

  function addMarkerLayers() {
    removeMarkerLayers();

    map.addSource(SOURCE_ID, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });

    map.addLayer({
      id: COURSE_LAYER,
      type: "line",
      source: SOURCE_ID,
      filter: ["==", ["get", "kind"], "course-line"],
      paint: {
        "line-color": ["get", "color"],
        "line-width": 2,
        "line-opacity": 0.75,
      },
    });

    map.addLayer({
      id: CIRCLE_LAYER,
      type: "circle",
      source: SOURCE_ID,
      filter: ["all", MARKER_FILTER, ["==", ["get", "showCircle"], 1]],
      paint: {
        "circle-radius": [
          "case",
          ["==", ["get", "selected"], true],
          10,
          7,
        ],
        "circle-color": ["get", "color"],
        "circle-stroke-width": 2,
        "circle-stroke-color": "#f8fafc",
        "circle-opacity": ["get", "opacity"],
      },
    });

    map.addLayer({
      id: ICON_LAYER,
      type: "symbol",
      source: SOURCE_ID,
      filter: ["all", MARKER_FILTER, ["!=", ["get", "iconId"], ""]],
      layout: {
        "icon-image": ["get", "iconId"],
        "icon-size": [
          "case",
          ["==", ["get", "selected"], true],
          0.95,
          0.82,
        ],
        "icon-rotate": ["coalesce", ["get", "course"], 0],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "icon-optional": true,
      },
      paint: {
        "icon-opacity": ["get", "opacity"],
      },
    });

    // Dark pill behind callsign text (always visible above marker)
    map.addLayer({
      id: TAG_LAYER,
      type: "symbol",
      source: SOURCE_ID,
      filter: MARKER_FILTER,
      layout: {
        "text-field": ["get", "callsign"],
        "text-font": ["Open Sans Semibold", "Arial Unicode MS Bold"],
        "text-size": 11,
        "text-anchor": "bottom",
        "text-offset": [0, -1.35],
        "text-allow-overlap": true,
        "text-ignore-placement": true,
        "text-optional": false,
        "text-max-width": 14,
      },
      paint: {
        "text-color": "rgba(0,0,0,0)",
        "text-halo-color": "rgba(8, 12, 18, 0.94)",
        "text-halo-width": 7,
        "text-halo-blur": 0,
        "text-opacity": ["get", "labelOpacity"],
      },
    });

    map.addLayer({
      id: LABEL_LAYER,
      type: "symbol",
      source: SOURCE_ID,
      filter: MARKER_FILTER,
      layout: {
        "text-field": ["get", "callsign"],
        "text-font": ["Open Sans Semibold", "Arial Unicode MS Bold"],
        "text-size": 11,
        "text-anchor": "bottom",
        "text-offset": [0, -1.35],
        "text-allow-overlap": true,
        "text-ignore-placement": true,
        "text-optional": false,
        "text-max-width": 14,
      },
      paint: {
        "text-color": "#f1f5f9",
        "text-halo-color": ["get", "color"],
        "text-halo-width": 1,
        "text-halo-blur": 0,
        "text-opacity": ["get", "labelOpacity"],
      },
    });

    markerLayersReady = true;
    syncMapSource();
    preloadMarkerIcons();
  }

  function onMarkerIconClick(e) {
    const f = e.features && e.features[0];
    if (!f) return;
    selectMarker(String(f.properties.uid), true);
  }

  function onMarkerIconEnter() {
    map.getCanvas().style.cursor = "pointer";
  }

  function onMarkerIconLeave() {
    map.getCanvas().style.cursor = "";
  }

  function bindMarkerLayerHandlers() {
    for (const layer of [ICON_LAYER, CIRCLE_LAYER]) {
      map.off("click", layer, onMarkerIconClick);
      map.off("mouseenter", layer, onMarkerIconEnter);
      map.off("mouseleave", layer, onMarkerIconLeave);
      map.on("click", layer, onMarkerIconClick);
      map.on("mouseenter", layer, onMarkerIconEnter);
      map.on("mouseleave", layer, onMarkerIconLeave);
    }
  }

  function ensureMarkerLayers() {
    if (!map.isStyleLoaded()) return;
    addMarkerLayers();
    bindMarkerLayerHandlers();
  }

  function markerOpacity(m) {
    if (!m.stale) return 1;
    const staleMs = Date.parse(m.stale);
    if (!Number.isFinite(staleMs)) return 1;
    const remaining = staleMs - Date.now();
    if (remaining <= 0) return 0.35;
    if (remaining < 60000) return 0.55;
    return 1;
  }

  function markerGeoJsonFeature(m) {
    const color = markerDisplayColor(m);
    const visible = markerVisible(m);
    const coords = [m.lon, m.lat];
    const features = [];
    const plan = visible ? resolveMarkerIconPlan(m) : { kind: "circle" };
    let mapImageId = "";
    if (plan.kind === "mil") {
      mapImageId = registerMapImageId(milIconCacheKey(plan));
    } else if (plan.kind === "png" && plan.apiIconId) {
      mapImageId = registerMapImageId(plan.apiIconId);
    }

    const pointFeature = {
      type: "Feature",
      geometry: { type: "Point", coordinates: coords },
      properties: {
        kind: "marker",
        uid: m.uid,
        callsign: m.callsign,
        type: m.type,
        affiliation: m.affiliation || "other",
        color,
        iconId: mapImageId,
        showCircle: plan.kind === "circle" ? 1 : 0,
        opacity: visible ? markerOpacity(m) : 0,
        labelOpacity: visible ? markerOpacity(m) : 0,
        selected: m.uid === selectedUid,
        course: Number.isFinite(m.course) && m.course >= 0 ? m.course : 0,
      },
    };
    features.push(pointFeature);

    if (visible && mapImageId) ensureMarkerIcon(m, mapImageId);

    if (visible && Number.isFinite(m.course) && m.course >= 0) {
      const rad = (m.course * Math.PI) / 180;
      const len = 0.02 / Math.max(map.getZoom(), 4);
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            coords,
            [m.lon + Math.sin(rad) * len, m.lat + Math.cos(rad) * len],
          ],
        },
        properties: { uid: m.uid, color, kind: "course-line" },
      });
    }

    return features;
  }

  function syncMapSource() {
    if (!markerLayersReady) return;
    const src = map.getSource(SOURCE_ID);
    if (!src) return;
    const features = [];
    for (const m of markersByUid.values()) {
      features.push(...markerGeoJsonFeature(m));
    }
    src.setData({ type: "FeatureCollection", features });
    updateVisibleCounts();
  }

  function updateVisibleCounts() {
    const total = markersByUid.size;
    const visible = getVisibleMarkers().length;
    elVisibleCounts.textContent = visible + " / " + total + " visible";
  }

  function fmtCoord(n) {
    return Number.isFinite(n) ? n.toFixed(5) : "—";
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
    if (sec <= 0) return "stale";
    if (sec < 120) return "stale in " + sec + "s";
    return "";
  }

  function renderDetail(m) {
    if (!m) {
      elDetail.innerHTML =
        '<div class="map-detail-empty">Select a marker to view details.</div>';
      elDetailActions.hidden = true;
      return;
    }
    elDetailActions.hidden = false;
    const groupHtml = markerGroups(m)
      .map((g) => '<span class="map-chip">' + escapeHtml(g) + "</span>")
      .join(" ");
    elDetail.innerHTML =
      '<dl class="map-kv">' +
      "<dt>Callsign</dt><dd>" + escapeHtml(m.callsign) + "</dd>" +
      "<dt>UID</dt><dd>" + escapeHtml(m.uid) + "</dd>" +
      "<dt>Type</dt><dd>" + escapeHtml(m.type || "—") + "</dd>" +
      "<dt>Affiliation</dt><dd>" + escapeHtml(m.affiliation || "other") + "</dd>" +
      "<dt>Groups</dt><dd class=\"map-chips\">" + (groupHtml || "—") + "</dd>" +
      "<dt>Team</dt><dd>" + escapeHtml(m.team || "—") + "</dd>" +
      "<dt>Lat / Lon</dt><dd>" + fmtCoord(m.lat) + ", " + fmtCoord(m.lon) + "</dd>" +
      "<dt>HAE</dt><dd>" + (m.hae != null ? escapeHtml(String(m.hae)) : "—") + "</dd>" +
      "<dt>Course</dt><dd>" + (m.course != null ? escapeHtml(String(m.course)) + "°" : "—") + "</dd>" +
      "<dt>Speed</dt><dd>" + (m.speed != null ? escapeHtml(String(m.speed)) : "—") + "</dd>" +
      "<dt>Stale</dt><dd>" + escapeHtml(m.stale || "—") + "</dd>" +
      "<dt>Updated</dt><dd>" + escapeHtml(m.updatedAt || "—") + "</dd>" +
      "</dl>";
  }

  function renderLayerList() {
    recomputeGroupCounts();
    elLayerList.innerHTML = "";
    const q = layerFilterText.toLowerCase();
    const items = groupsCatalog.filter((g) => {
      if (!isMapChannelName(g.name)) return false;
      if (!q) return true;
      const label = String(g.displayName || g.name).toLowerCase();
      return label.includes(q) || String(g.name).toLowerCase().includes(q);
    });

    if (!items.length) {
      elLayerList.innerHTML = '<div class="map-detail-empty">No channels match.</div>';
      return;
    }

    for (const g of items) {
      const row = document.createElement("label");
      row.className = "map-layer-row";
      const checked = isGroupEnabled(g.name);
      row.innerHTML =
        '<input type="checkbox" data-group="' +
        escapeHtml(g.name) +
        '" ' +
        (checked ? "checked" : "") +
        " />" +
        '<span class="map-layer-name">' +
        escapeHtml(g.displayName || stripChannelBehaviorSuffix(g.name)) +
        "</span>" +
        '<span class="map-layer-count">' +
        String(g.markerCount || 0) +
        "</span>";
      row.querySelector("input").addEventListener("change", (ev) => {
        if (!enabledGroups) enabledGroups = new Set(groupsCatalog.map((x) => x.name));
        if (ev.target.checked) enabledGroups.add(g.name);
        else enabledGroups.delete(g.name);
        saveEnabledGroups();
        syncMapSource();
        renderList();
      });
      elLayerList.appendChild(row);
    }
  }

  function renderList() {
    const items = getVisibleMarkers().sort((a, b) =>
      String(a.callsign).localeCompare(String(b.callsign))
    );

    elList.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "map-detail-empty";
      empty.textContent = markersByUid.size
        ? "No contacts match current filters."
        : "Waiting for CoT markers…";
      elList.appendChild(empty);
      return;
    }

    for (const m of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      const staleCls = staleAgeLabel(m) ? " stale" : "";
      btn.className =
        "map-marker-item" + (m.uid === selectedUid ? " active" : "") + staleCls;
      const chips = markerGroups(m)
        .slice(0, 3)
        .map((g) => escapeHtml(g))
        .join(" · ");
      btn.innerHTML =
        '<div class="name">' +
        '<span class="map-aff-dot" style="background:' +
        affiliationColor(m.affiliation) +
        '"></span>' +
        escapeHtml(m.callsign) +
        "</div>" +
        '<div class="meta">' +
        escapeHtml(m.type || "unknown") +
        (chips ? " · " + chips : "") +
        "</div>";
      btn.addEventListener("click", () => selectMarker(m.uid, true));
      elList.appendChild(btn);
    }
  }

  function showPopup(m) {
    if (popup) popup.remove();
    if (!m) return;
    popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, offset: 12 })
      .setLngLat([m.lon, m.lat])
      .setHTML(
        "<strong>" +
          escapeHtml(m.callsign) +
          "</strong><br/>" +
          escapeHtml(m.type || "") +
          "<br/><span class=\"map-popup-groups\">" +
          escapeHtml(markerGroups(m).join(", ")) +
          "</span>"
      )
      .addTo(map);
  }

  function selectMarker(uid, showPopupFlag) {
    selectedUid = uid;
    const m = markersByUid.get(uid);
    renderList();
    renderDetail(m);
    syncMapSource();
    if (m && Number.isFinite(m.lon) && Number.isFinite(m.lat)) {
      if (followSelected) {
        map.easeTo({ center: [m.lon, m.lat], duration: 400 });
      } else if (showPopupFlag) {
        map.flyTo({ center: [m.lon, m.lat], zoom: Math.max(map.getZoom(), 12), duration: 800 });
      }
      if (showPopupFlag) showPopup(m);
    }
  }

  function upsertMarker(m) {
    if (!m || !m.uid) return;
    markersByUid.set(String(m.uid), m);
    mergeGroupsCatalog([]);
    syncMapSource();
    renderLayerList();
    renderList();
    maybeFitVisibleOnLoad();
    if (selectedUid === m.uid) {
      renderDetail(m);
      if (followSelected && Number.isFinite(m.lon)) {
        map.easeTo({ center: [m.lon, m.lat], duration: 300 });
      }
    }
  }

  function removeMarker(uid) {
    markersByUid.delete(String(uid));
    if (selectedUid === uid) {
      selectedUid = null;
      renderDetail(null);
      if (popup) popup.remove();
    }
    recomputeGroupCounts();
    syncMapSource();
    renderLayerList();
    renderList();
  }

  function applySnapshot(state) {
    markersByUid.clear();
    const list = (state && state.markers) || [];
    for (const m of list) markersByUid.set(String(m.uid), m);
    mergeGroupsCatalog(state?.groupsCatalog || []);
    syncMapSource();
    renderLayerList();
    renderList();
    maybeFitVisibleOnLoad();
    if (state && state.icons && state.icons.defaultIcons) {
      defaultIconIds = state.icons.defaultIcons;
      preloadMarkerIcons();
    }
    if (state && state.host) {
      elHost.textContent =
        "TAK stream " +
        state.host +
        (state.port ? ":" + state.port : "") +
        (state.connected ? " · connected" : state.connecting ? " · connecting" : " · offline");
    }
    setConnStatus(!!state.connected, state.lastError);
    elUpdated.textContent = "Updated " + (state.updatedAt || new Date().toISOString());
    elOffline.hidden = true;
  }

  function setConnStatus(connected, errMsg) {
    elConnDot.classList.remove("ok", "bad");
    if (connected) {
      elConnDot.classList.add("ok");
      elConnLabel.textContent = "Live";
      elOffline.hidden = true;
    } else if (errMsg) {
      elConnDot.classList.add("bad");
      elConnLabel.textContent = "Offline";
    } else {
      elConnLabel.textContent = "Connecting";
    }
  }

  function setBasemap(id) {
    const def = BASEMAPS[id] || BASEMAPS.dark;
    localStorage.setItem(LS_BASEMAP, id);
    elBasemapLabel.textContent = def.label;
    removeMarkerLayers();
    map.setStyle(withMapGlyphs(def.style));
  }

  map.on("styleimagemissing", onStyleImageMissing);

  map.on("style.load", () => {
    map.once("idle", () => {
      ensureMarkerLayers();
      syncMapSource();
    });
  });

  map.on("load", () => {
    ensureMarkerLayers();
    elZoom.textContent = map.getZoom().toFixed(1);
  });

  map.on("moveend", () => {
    elZoom.textContent = map.getZoom().toFixed(1);
  });

  map.on("mousemove", (e) => {
    if (copyToastTimer) return;
    elCursor.textContent = e.lngLat.lat.toFixed(5) + ", " + e.lngLat.lng.toFixed(5);
  });

  map.on("contextmenu", (e) => {
    e.preventDefault();
    const text = e.lngLat.lat.toFixed(5) + ", " + e.lngLat.lng.toFixed(5);
    copyTextToClipboard(text).then(
      () => showCopyToast("Copied " + text),
      () => showCopyToast(text)
    );
  });

  elBasemapSelect.addEventListener("change", () => {
    setBasemap(elBasemapSelect.value);
  });

  elFollowCheck.addEventListener("change", () => {
    followSelected = elFollowCheck.checked;
  });

  elSearch.addEventListener("input", () => {
    filterText = elSearch.value.trim();
    renderList();
    syncMapSource();
  });

  elLayerSearch.addEventListener("input", () => {
    layerFilterText = elLayerSearch.value.trim();
    renderLayerList();
  });

  document.getElementById("mapGroupsAll").addEventListener("click", () => {
    enabledGroups = new Set(groupsCatalog.filter((g) => isMapChannelName(g.name)).map((g) => g.name));
    for (const m of markersByUid.values()) {
      for (const gn of markerGroups(m)) {
        if (isMapChannelName(gn)) enabledGroups.add(gn);
      }
    }
    saveEnabledGroups();
    renderLayerList();
    syncMapSource();
    renderList();
  });

  document.getElementById("mapGroupsNone").addEventListener("click", () => {
    enabledGroups = new Set();
    saveEnabledGroups();
    renderLayerList();
    syncMapSource();
    renderList();
  });

  elFit.addEventListener("click", () => {
    fitVisibleMarkers(true);
  });

  document.querySelectorAll(".map-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      activeTab = tab.getAttribute("data-tab");
      document.querySelectorAll(".map-tab").forEach((t) => {
        t.classList.toggle("active", t === tab);
      });
      document.querySelectorAll(".map-tab-panel").forEach((p) => {
        p.classList.toggle("active", p.getAttribute("data-panel") === activeTab);
      });
    });
  });

  document.getElementById("mapCollapseLeft").addEventListener("click", () => {
    setPanelLeftCollapsed(!elPanelLeft.classList.contains("collapsed"));
  });

  document.getElementById("mapCollapseRight").addEventListener("click", () => {
    setPanelRightCollapsed(!elPanelRight.classList.contains("collapsed"));
  });

  elExpandLeft.addEventListener("click", () => {
    setPanelLeftCollapsed(false);
  });

  elExpandRight.addEventListener("click", () => {
    setPanelRightCollapsed(false);
  });

  elCenterBtn.addEventListener("click", () => {
    const m = selectedUid ? markersByUid.get(selectedUid) : null;
    if (m) map.flyTo({ center: [m.lon, m.lat], zoom: Math.max(map.getZoom(), 12) });
  });

  elCopyCoordsBtn.addEventListener("click", () => {
    const m = selectedUid ? markersByUid.get(selectedUid) : null;
    if (!m) return;
    const text = m.lat.toFixed(5) + ", " + m.lon.toFixed(5);
    copyTextToClipboard(text).then(
      () => showCopyToast("Copied " + text),
      () => showCopyToast(text)
    );
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "/" && document.activeElement !== elSearch) {
      ev.preventDefault();
      if (activeTab === "contacts") elSearch.focus();
      else elLayerSearch.focus();
    }
    if (ev.key === "Escape") {
      selectedUid = null;
      if (popup) popup.remove();
      renderList();
      renderDetail(null);
      syncMapSource();
    }
  });

  function tickZulu() {
    const d = new Date();
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    const ss = String(d.getUTCSeconds()).padStart(2, "0");
    elZulu.textContent = hh + ":" + mm + ":" + ss + " Z";
  }
  tickZulu();
  setInterval(tickZulu, 1000);

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
    } else if (msg.type === "update" && msg.marker) {
      upsertMarker(msg.marker);
      elUpdated.textContent = "Updated " + (msg.at || new Date().toISOString());
    } else if (msg.type === "remove" && msg.uid) {
      removeMarker(msg.uid);
    } else if (msg.type === "status") {
      setConnStatus(!!msg.connected, msg.lastError);
      if (msg.host) {
        elHost.textContent =
          "TAK stream " +
          msg.host +
          (msg.port ? ":" + msg.port : "") +
          (msg.connected ? " · connected" : " · offline");
      }
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
    .then((data) => {
      mergeGroupsCatalog(data.groups || []);
      renderLayerList();
    })
    .catch(() => {});
})();
