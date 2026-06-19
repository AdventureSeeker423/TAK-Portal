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

  const MAP_GLYPHS = "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf";
  const MAP_LABEL_FONT = ["Open Sans Semibold"];
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
  let mapRefreshTimer = null;
  let uiTimer = null;
  let mapRefreshPending = false;
  let lastGeoMeta = { total: 0, visible: 0 };
  let filterText = "";
  let layerFilterText = "";
  let layerListTimer = null;

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

  function markerCoords(m) {
    const lon = Number(m && m.lon);
    const lat = Number(m && m.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    return { lon, lat };
  }

  function storeMarker(m) {
    const normalized = normalizeMarkerRecord(m);
    if (!normalized) return;
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

  function scheduleMapRefresh() {
    if (mapRefreshTimer) clearTimeout(mapRefreshTimer);
    mapRefreshTimer = setTimeout(refreshMapFromMarkers, 150);
  }

  function scheduleUiRefresh() {
    if (uiTimer) clearTimeout(uiTimer);
    uiTimer = setTimeout(function () {
      renderList();
      updateVisibleCounts();
    }, 120);
  }

  function markerGeoJsonFeatures(m) {
    const pos = markerCoords(m);
    if (!pos) return [];
    const color = markerDisplayColor(m);
    const coords = [pos.lon, pos.lat];
    const apiIconId = markerUsesMapIcon(m) ? String(m.iconId) : "";
    const tint = markerIconTint(m);
    const mapImageId = apiIconId ? registerMapImageId(apiIconId, tint) : "";
    const features = [
      {
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
          showCircle: mapImageId ? 0 : 1,
          selected: m.uid === selectedUid,
        },
      },
    ];

    if (mapImageId && apiIconId) loadMapIcon(apiIconId, mapImageId, tint);

    const course = Number(m.course);
    const speed = Number(m.speed);
    if (
      Number.isFinite(course) &&
      course >= 0 &&
      Number.isFinite(speed) &&
      speed > 2
    ) {
      const rad = (course * Math.PI) / 180;
      const len = 0.02 / Math.max(map.getZoom(), 4);
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            coords,
            [pos.lon + Math.sin(rad) * len, pos.lat + Math.cos(rad) * len],
          ],
        },
        properties: { uid: m.uid, color, kind: "course-line" },
      });
    }

    return features;
  }

  function refreshMapFromMarkers() {
    mapRefreshTimer = null;
    if (!markerLayersReady) {
      mapRefreshPending = true;
      return;
    }
    const src = map.getSource(SOURCE_ID);
    if (!src) return;

    const visible = getVisibleMarkers();
    const iconIds = new Set();
    const iconLoads = [];
    for (let i = 0; i < visible.length; i++) {
      const m = visible[i];
      if (!markerUsesMapIcon(m)) continue;
      const apiIconId = String(m.iconId);
      const tint = markerIconTint(m);
      const key = iconImageKey(apiIconId, tint);
      if (iconIds.has(key)) continue;
      iconIds.add(key);
      const mapImageId = registerMapImageId(apiIconId, tint);
      iconLoads.push(loadMapIcon(apiIconId, mapImageId, tint));
    }

    Promise.all(iconLoads).finally(function () {
      if (!map.getSource(SOURCE_ID)) return;
      const features = [];
      for (let i = 0; i < visible.length; i++) {
        features.push.apply(features, markerGeoJsonFeatures(visible[i]));
      }
      src.setData({ type: "FeatureCollection", features: features });
      lastGeoMeta = {
        total: markersByUid.size,
        visible: visible.length,
        mapped: features.filter(function (f) {
          return f && f.properties && f.properties.kind === "marker";
        }).length,
      };
      updateVisibleCounts();
      if (map.getLayer(CIRCLE_LAYER)) map.triggerRepaint();
    });
  }

  function syncMapSource() {
    scheduleMapRefresh();
    scheduleUiRefresh();
    if (markerLayersReady) refreshMapFromMarkers();
  }

  function scheduleLayerListRefresh() {
    if (layerListTimer) clearTimeout(layerListTimer);
    layerListTimer = setTimeout(function () {
      layerListTimer = null;
      renderLayerList();
    }, 300);
  }

  function loadMarkersFromServer() {
    return fetch("/api/map/markers")
      .then(function (resp) {
        if (!resp.ok) throw new Error("markers " + resp.status);
        return resp.json();
      })
      .then(function (data) {
        markersByUid.clear();
        const list = Array.isArray(data.markers) ? data.markers : [];
        for (let i = 0; i < list.length; i++) {
          storeMarker(list[i]);
        }
        recomputeGroupCounts();
      });
  }
  let followSelected = false;
  let activeTab = "channels";
  let popup = null;
  let markerLayersReady = false;
  let pendingFitVisible = true;
  let copyToastTimer = null;
  let defaultIconIds = {};
  const iconLoadPending = new Map();
  const mapImageIdByKey = new Map();
  const iconIdByMapImageId = new Map();

  function iconImageKey(apiIconId, tintHex) {
    return String(apiIconId || "") + (tintHex ? "@" + String(tintHex).toLowerCase() : "");
  }

  function registerMapImageId(apiIconId, tintHex) {
    if (!apiIconId) return "";
    const key = iconImageKey(apiIconId, tintHex);
    let mapped = mapImageIdByKey.get(key);
    if (!mapped) {
      mapped = "tak-icon-" + mapImageIdByKey.size;
      mapImageIdByKey.set(key, mapped);
      iconIdByMapImageId.set(mapped, { apiIconId: String(apiIconId), tint: tintHex || null });
    }
    return mapped;
  }

  function resetMapIconCache() {
    mapImageIdByKey.clear();
    iconIdByMapImageId.clear();
    iconLoadPending.clear();
  }

  function hexToRgb(hex) {
    const raw = String(hex || "").trim().replace("#", "");
    if (!raw) return null;
    const norm =
      raw.length === 3
        ? raw
            .split("")
            .map(function (c) {
              return c + c;
            })
            .join("")
        : raw.slice(0, 6);
    if (!/^[0-9a-f]{6}$/i.test(norm)) return null;
    return {
      r: parseInt(norm.slice(0, 2), 16),
      g: parseInt(norm.slice(2, 4), 16),
      b: parseInt(norm.slice(4, 6), 16),
    };
  }

  function tintIconSource(source, tintHex) {
    const rgb = hexToRgb(tintHex);
    if (!rgb || !source) return source;
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return source;
    ctx.drawImage(source, 0, 0);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = tintHex;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function iconApiUrl(iconId) {
    return "/api/map/icons?id=" + encodeURIComponent(iconId);
  }

  /** PNG icons for explicit usericon/path feeds, and 2525 sprites for air (a-*-A-*) types. */
  function isAirCotType(type) {
    const parts = String(type || "")
      .trim()
      .split("-");
    return parts.length >= 3 && parts[2].toUpperCase() === "A";
  }

  function markerUsesMapIcon(m) {
    if (!m || !m.iconId) return false;
    const src = String(m.iconSource || "").toLowerCase();
    if (src === "usericon" || src === "path") return true;
    if (src === "type2525b" && isAirCotType(m.type)) return true;
    return false;
  }

  function markerIconTint(m) {
    if (!markerUsesMapIcon(m)) return null;
    const src = String(m.iconSource || "").toLowerCase();
    if (src === "type2525b") return null;
    return markerDisplayColor(m);
  }

  function loadMapIcon(iconId, mapImageId, tintHex) {
    const imageName = mapImageId || registerMapImageId(iconId, tintHex);
    if (!iconId || map.hasImage(imageName)) return Promise.resolve();
    const pendingKey = imageName;
    if (iconLoadPending.has(pendingKey)) return iconLoadPending.get(pendingKey);

    const promise = fetch(iconApiUrl(iconId))
      .then(function (resp) {
        if (!resp.ok) throw new Error("icon " + resp.status);
        return resp.blob();
      })
      .then(function (blob) {
        function addToMap(source) {
          const finalSource = tintHex ? tintIconSource(source, tintHex) : source;
          if (!map.hasImage(imageName)) {
            map.addImage(imageName, finalSource, { pixelRatio: 1 });
          }
        }
        if (typeof createImageBitmap === "function") {
          return createImageBitmap(blob).then(function (bitmap) {
            addToMap(bitmap);
          });
        }
        return new Promise(function (resolve, reject) {
          const img = new Image();
          img.onload = function () {
            try {
              addToMap(img);
              resolve();
            } catch (err) {
              reject(err);
            }
          };
          img.onerror = reject;
          img.src = URL.createObjectURL(blob);
        });
      })
      .then(function () {
        if (map.getLayer(ICON_LAYER)) map.triggerRepaint();
      })
      .catch(function () {})
      .finally(function () {
        iconLoadPending.delete(pendingKey);
      });

    iconLoadPending.set(pendingKey, promise);
    return promise;
  }

  function preloadMarkerIcons() {
    const jobs = [];
    for (const m of markersByUid.values()) {
      if (!markerUsesMapIcon(m)) continue;
      const apiIconId = String(m.iconId);
      const tint = markerIconTint(m);
      const mapImageId = registerMapImageId(apiIconId, tint);
      jobs.push(loadMapIcon(apiIconId, mapImageId, tint));
    }
    return Promise.all(jobs);
  }

  function onStyleImageMissing(e) {
    const mapImageId = e.id;
    const info = iconIdByMapImageId.get(mapImageId);
    const iconId = info?.apiIconId || mapImageId;
    const tint = info?.tint || null;
    if (!iconId || iconLoadPending.has(mapImageId)) return;
    loadMapIcon(iconId, mapImageId, tint).then(function () {
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

  function loadEnabledGroups() {
    try {
      const raw = localStorage.getItem(LS_GROUPS);
      if (raw === null) return null;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      if (parsed.length === 0) return new Set();
      return new Set(parsed);
    } catch (_) {
      return null;
    }
  }

  function normalizeEnabledGroups(set) {
    if (!set) return null;
    if (set.size === 0) return new Set();
    const out = new Set();
    for (const name of set) {
      const key = channelGroupKey(name);
      if (!key) continue;
      const match = groupsCatalog.find((g) => channelGroupKey(g.name) === key);
      out.add(match ? match.name : name);
    }
    return out.size ? out : new Set();
  }

  function saveEnabledGroups() {
    if (!enabledGroups) {
      localStorage.removeItem(LS_GROUPS);
      return;
    }
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
    for (const id of [LABEL_LAYER, ICON_LAYER, CIRCLE_LAYER, COURSE_LAYER]) {
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
    const fromTeam = teamNameToColor(m && m.team);
    if (fromTeam) return fromTeam;
    return normalizeMarkerColor(m && m.teamColor, affiliationColor(m && m.affiliation));
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
    if (!enabledGroups || enabledGroups.size === 0) return;
    const names = groupsCatalog.filter((g) => isMapChannelName(g.name)).map((g) => g.name);
    if (!names.length) return;
    for (let i = 0; i < names.length; i++) {
      if (!isGroupEnabled(names[i])) return;
    }
    enabledGroups = null;
    saveEnabledGroups();
  }

  function ensureEnabledGroupsInitialized() {
    if (enabledGroups) return;
    enabledGroups = new Set(
      groupsCatalog.filter((g) => isMapChannelName(g.name)).map((g) => g.name)
    );
  }

  function channelGroupKey(name) {
    const base = stripChannelBehaviorSuffix(name);
    if (!base || base.toLowerCase() === "unassigned") return "";
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
    if (isChannelFilterActive()) {
      if (enabledGroups.size === 0) return false;
      const keys = markerChannelKeys(m);
      if (!keys.length) return false;
      if (!keys.some((k) => isChannelKeyEnabled(k))) return false;
    }
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
    // null enabledGroups = show all markers until the user narrows the filter
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
    syncEnabledGroupsWithCatalog();
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
        markerCount: counts.get(channelBaseKeyForName(g.name)) || 0,
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
        "line-opacity": 1,
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
          11,
          8,
        ],
        "circle-color": ["get", "color"],
        "circle-stroke-width": 0,
        "circle-opacity": 1,
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
          1,
          0.85,
        ],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "icon-optional": true,
      },
      paint: {
        "icon-opacity": 1,
      },
    });

    map.addLayer({
      id: LABEL_LAYER,
      type: "symbol",
      source: SOURCE_ID,
      filter: MARKER_FILTER,
      layout: {
        "text-field": ["get", "callsign"],
        "text-font": MAP_LABEL_FONT,
        "text-size": 11,
        "text-anchor": "bottom",
        "text-offset": [0, -1.65],
        "text-allow-overlap": true,
        "text-ignore-placement": true,
        "text-optional": true,
        "text-max-width": 14,
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-width": 0,
        "text-opacity": 1,
      },
    });

    markerLayersReady = true;
    if (mapRefreshPending) {
      mapRefreshPending = false;
    }
    refreshMapFromMarkers();
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
        if (!enabledGroups) ensureEnabledGroupsInitialized();
        if (ev.target.checked) enabledGroups.add(g.name);
        else enabledGroups.delete(g.name);
        syncEnabledGroupsWithCatalog();
        saveEnabledGroups();
        renderLayerList();
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
        '<span class="map-aff-dot" style="' +
        markerDotStyle(m) +
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
      }
      if (showPopupFlag) showPopup(m);
    }
  }

  function applyBatch(msg) {
    for (const uid of msg.removes || []) {
      markersByUid.delete(String(uid));
      if (selectedUid === uid) {
        selectedUid = null;
        renderDetail(null);
        if (popup) popup.remove();
      }
    }
    for (const m of msg.updates || []) {
      storeMarker(m);
    }
    if (msg.groupsCatalog) mergeGroupsCatalog(msg.groupsCatalog);
    else recomputeGroupCounts();
    syncMapSource();
    scheduleLayerListRefresh();
  }

  function upsertMarker(m) {
    if (!m || !m.uid) return;
    applyBatch({ updates: [m] });
    maybeFitVisibleOnLoad();
    if (selectedUid === m.uid) {
      renderDetail(m);
      if (followSelected && Number.isFinite(m.lon)) {
        map.easeTo({ center: [m.lon, m.lat], duration: 300 });
      }
    }
  }

  function removeMarker(uid) {
    applyBatch({ removes: [String(uid)] });
  }

  function applySnapshot(state) {
    mergeGroupsCatalog(state?.groupsCatalog || []);
    if (state && state.icons && state.icons.defaultIcons) {
      defaultIconIds = state.icons.defaultIcons;
    }
    loadMarkersFromServer()
      .then(function () {
        syncMapSource();
        renderLayerList();
        renderList();
        maybeFitVisibleOnLoad();
        preloadMarkerIcons();
      })
      .catch(function () {});
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

  function restoreMapAfterStyleChange() {
    markerLayersReady = false;
    resetMapIconCache();
    if (!map.isStyleLoaded()) {
      requestAnimationFrame(restoreMapAfterStyleChange);
      return;
    }
    try {
      ensureMarkerLayers();
      refreshMapFromMarkers();
    } catch (_) {
      map.once("idle", restoreMapAfterStyleChange);
    }
  }

  function setBasemap(id) {
    const def = BASEMAPS[id] || BASEMAPS.dark;
    localStorage.setItem(LS_BASEMAP, id);
    elBasemapLabel.textContent = def.label;
    markerLayersReady = false;
    map.setStyle(withMapGlyphs(def.style));
  }

  map.on("styleimagemissing", onStyleImageMissing);

  map.on("style.load", restoreMapAfterStyleChange);

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
    enabledGroups = null;
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
    } else if (msg.type === "batch") {
      applyBatch(msg);
      if (msg.at) elUpdated.textContent = "Updated " + msg.at;
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
