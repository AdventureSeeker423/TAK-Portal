(function () {
  "use strict";

  const LS_BASEMAP = "tak-portal-map-basemap";
  const LS_GROUPS = "tak-portal-map-groups";
  const LS_PANEL_LEFT = "tak-portal-map-panel-left";
  const LS_DETAIL_PANEL_WIDTH = "tak-portal-map-detail-panel-width";
  const LS_COORD_FORMAT = "tak-portal-map-coord-format";
  const DETAIL_PANEL_MIN_PX = 340;
  const DETAIL_PANEL_MIN_VW = 0.38;
  const DETAIL_PANEL_MAX_VW = 0.5;
  const DETAIL_PANEL_RIGHT_OFFSET = 12;
  const MAX_DETAIL_SLOTS = 2;

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
  /** Must match cotStream.service.js STALE_GRACE_MS */
  const STALE_GRACE_MS = 30000;

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
    "google-hybrid": {
      label: "Google Hybrid",
      style: rasterBasemapStyle(
        "Google Hybrid",
        "https://mt1.google.com/vt/lyrs=y&hl=en&x={x}&y={y}&z={z}",
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
  let detailSlots = [];
  let focusedDetailIndex = 0;
  let detailPaneUserCollapsed = false;
  let mapRefreshTimer = null;
  let uiTimer = null;
  let mapRefreshPending = false;
  let lastGeoMeta = { total: 0, visible: 0 };
  let filterText = "";
  let layerFilterText = "";
  let layerListTimer = null;
  const labelVisibleByUid = new Map();
  let labelDeclutterKey = "";

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
    mapRefreshTimer = setTimeout(refreshMapFromMarkers, 50);
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
    const baseMapImageId = apiIconId ? registerMapImageId(apiIconId) : "";
    let displayIconId = baseMapImageId;
    if (baseMapImageId && color && !iconSkipsRecolor(m, apiIconId)) {
      displayIconId = registerColoredMapImageId(baseMapImageId, color);
      loadColoredMapIcon(apiIconId, baseMapImageId, color);
    } else if (baseMapImageId && apiIconId) {
      loadMapIcon(apiIconId, baseMapImageId);
    }
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
          iconId: displayIconId || "",
          showCircle:
            displayIconId && map.hasImage(displayIconId) ? 0 : 1,
          selected: m.uid === selectedUid,
          locked: m.uid === lockedUid,
          labelSort:
            m.uid === selectedUid ? 0 : m.uid === lockedUid ? 1 : 2,
          showLabel: markerShowLabel(m),
        },
      },
    ];

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
    if (!pushMarkerGeoJsonToSource()) return;

    const seen = new Set();
    const iconLoads = [];
    for (const m of getVisibleMarkers()) {
      if (!markerUsesMapIcon(m)) continue;
      const apiIconId = String(m.iconId);
      const color = markerDisplayColor(m);
      const baseMapImageId = registerMapImageId(apiIconId);
      const loadKey =
        color && !iconSkipsRecolor(m, apiIconId)
          ? baseMapImageId + "|" + color
          : baseMapImageId;
      if (seen.has(loadKey)) continue;
      seen.add(loadKey);
      if (color && !iconSkipsRecolor(m, apiIconId)) {
        const coloredId = registerColoredMapImageId(baseMapImageId, color);
        if (!map.hasImage(coloredId)) {
          iconLoads.push(loadColoredMapIcon(apiIconId, baseMapImageId, color));
        }
      } else if (!map.hasImage(baseMapImageId)) {
        iconLoads.push(loadMapIcon(apiIconId, baseMapImageId));
      }
    }
    if (iconLoads.length) {
      Promise.all(iconLoads).finally(function () {
        pushMarkerGeoJsonToSource();
      });
    }
  }

  function syncMapSource() {
    scheduleMapRefresh();
    scheduleUiRefresh();
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
  let lockedUid = null;
  let lockMoveFromCode = false;
  let activeTab = "channels";
  let popup = null;
  let stackPickerEl = null;
  let stackPickerOutsideListener = null;
  let markerLayersReady = false;
  let pendingFitVisible = true;
  let copyToastTimer = null;
  let lastCursorLngLat = null;
  const CURSOR_COORD_FORMATS = [
    { id: "lat_lon", label: "Lat, Lon (decimal)" },
    { id: "lon_lat", label: "Lon, Lat (decimal)" },
    { id: "dms", label: "DMS" },
    { id: "hemisphere", label: "Degrees + hemisphere" },
  ];
  let cursorCoordFormatIndex = (function () {
    const stored = Number(localStorage.getItem(LS_COORD_FORMAT));
    if (!Number.isFinite(stored)) return 0;
    return Math.max(0, Math.min(CURSOR_COORD_FORMATS.length - 1, stored));
  })();
  let defaultIconIds = {};
  const iconLoadPending = new Map();
  const mapImageIdByKey = new Map();
  const iconIdByMapImageId = new Map();
  /** Raw RGBA pixels for base icons — map.getImage() is unreliable after ImageBitmap addImage. */
  const baseIconPixelCache = new Map();

  function iconImageKey(apiIconId) {
    return String(apiIconId || "");
  }

  function registerMapImageId(apiIconId) {
    if (!apiIconId) return "";
    const key = iconImageKey(apiIconId);
    let mapped = mapImageIdByKey.get(key);
    if (!mapped) {
      mapped = "tak-icon-" + mapImageIdByKey.size;
      mapImageIdByKey.set(key, mapped);
      iconIdByMapImageId.set(mapped, { apiIconId: String(apiIconId) });
    }
    return mapped;
  }

  function resetMapIconCache() {
    iconLoadPending.clear();
    baseIconPixelCache.clear();
    mapImageIdByKey.clear();
    iconIdByMapImageId.clear();
    purgeMapIconImages();
  }

  function purgeMapIconImages() {
    if (!map || typeof map.listImages !== "function") return;
    for (const name of map.listImages()) {
      if (String(name).startsWith("tak-icon-")) {
        try {
          map.removeImage(name);
        } catch (_) {}
      }
    }
  }

  function reinstallMapIconsFromCache() {
    if (!map || !map.isStyleLoaded()) return;
    iconLoadPending.clear();
    for (const [imageName, imageData] of baseIconPixelCache.entries()) {
      installMapImageSync(imageName, cloneImageData(imageData));
    }
    for (const [imageId, info] of iconIdByMapImageId.entries()) {
      if (!info || !info.colored || !info.baseMapImageId || !info.colorHex) continue;
      if (map.hasImage(imageId)) continue;
      tryInstallColoredIconSync(info.baseMapImageId, info.colorHex);
    }
  }

  function decodeIconBlob(blob) {
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

  function cloneImageData(source) {
    return new ImageData(
      new Uint8ClampedArray(source.data),
      source.width,
      source.height
    );
  }

  function installMapImageSync(imageName, source) {
    if (!map.isStyleLoaded() || !source || map.hasImage(imageName)) {
      return map.hasImage(imageName);
    }
    try {
      if (typeof ImageData !== "undefined" && source instanceof ImageData) {
        map.addImage(imageName, {
          width: source.width,
          height: source.height,
          data: source.data,
        });
      } else {
        map.addImage(imageName, source, { pixelRatio: 1 });
      }
      return map.hasImage(imageName);
    } catch (_) {
      return false;
    }
  }

  const COLORED_ICON_SUFFIX = "-colored-";

  function iconSkipsRecolor(m, apiIconId) {
    if (String(apiIconId || "").startsWith("2525D:")) return true;
    if (String((m && m.iconSource) || "").toLowerCase() === "type2525b") return true;
    return false;
  }

  function parseColoredMapImageId(mapImageId) {
    const id = String(mapImageId || "");
    const idx = id.indexOf(COLORED_ICON_SUFFIX);
    if (idx === -1) return null;
    const hex = id.slice(idx + COLORED_ICON_SUFFIX.length);
    if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
    return {
      baseMapImageId: id.slice(0, idx),
      colorHex: "#" + hex.toLowerCase(),
    };
  }

  function registerColoredMapImageId(baseMapImageId, colorHex) {
    const hex = String(colorHex || "")
      .replace(/^#/, "")
      .toLowerCase();
    const coloredId = baseMapImageId + COLORED_ICON_SUFFIX + hex;
    if (!iconIdByMapImageId.has(coloredId)) {
      const base = iconIdByMapImageId.get(baseMapImageId);
      iconIdByMapImageId.set(coloredId, {
        apiIconId: base ? base.apiIconId : "",
        baseMapImageId: baseMapImageId,
        colorHex: "#" + hex,
        colored: true,
      });
    }
    return coloredId;
  }

  function hexToRgb(hex) {
    const s = String(hex || "").replace(/^#/, "");
    if (!/^[0-9a-f]{6}$/i.test(s)) return [0, 255, 0];
    return [
      parseInt(s.slice(0, 2), 16),
      parseInt(s.slice(2, 4), 16),
      parseInt(s.slice(4, 6), 16),
    ];
  }

  function isWhitePixel(r, g, b) {
    return r > 200 && g > 200 && b > 200;
  }

  function recolorWhitePixels(imageData, colorHex) {
    const data = imageData.data;
    const rgb = hexToRgb(colorHex);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      if (isWhitePixel(data[i], data[i + 1], data[i + 2])) {
        data[i] = rgb[0];
        data[i + 1] = rgb[1];
        data[i + 2] = rgb[2];
      }
    }
  }

  function buildColoredImageData(baseMapImageId, colorHex) {
    const cached = baseIconPixelCache.get(baseMapImageId);
    if (!cached) return null;
    const imageData = cloneImageData(cached);
    recolorWhitePixels(imageData, colorHex);
    return imageData;
  }

  function tryInstallColoredIconSync(baseMapImageId, colorHex) {
    const coloredId = registerColoredMapImageId(baseMapImageId, colorHex);
    if (map.hasImage(coloredId)) return true;
    const imageData = buildColoredImageData(baseMapImageId, colorHex);
    if (!imageData) return false;
    return installMapImageSync(coloredId, imageData);
  }

  function createColoredMapIcon(baseMapImageId, colorHex) {
    const coloredId = registerColoredMapImageId(baseMapImageId, colorHex);
    if (map.hasImage(coloredId)) return Promise.resolve(coloredId);

    const imageData = buildColoredImageData(baseMapImageId, colorHex);
    if (!imageData) return Promise.resolve(null);

    return installMapImage(coloredId, imageData).then(function () {
      return coloredId;
    });
  }

  function loadColoredMapIcon(apiIconId, baseMapImageId, colorHex) {
    const coloredId = registerColoredMapImageId(baseMapImageId, colorHex);
    if (map.hasImage(coloredId)) return Promise.resolve();
    const pendingKey = coloredId;
    if (iconLoadPending.has(pendingKey)) return iconLoadPending.get(pendingKey);

    const promise = loadMapIcon(apiIconId, baseMapImageId)
      .then(function () {
        if (!baseIconPixelCache.has(baseMapImageId)) return;
        if (!map.hasImage(baseMapImageId)) {
          installMapImageSync(baseMapImageId, baseIconPixelCache.get(baseMapImageId));
        }
        return createColoredMapIcon(baseMapImageId, colorHex);
      })
      .then(function () {
        if (map.getLayer(ICON_LAYER)) map.triggerRepaint();
        scheduleMapRefresh();
      })
      .catch(function (err) {
        console.warn("Failed to load colored map icon", {
          apiIconId: apiIconId,
          baseMapImageId: baseMapImageId,
          colorHex: colorHex,
          err: err,
        });
      })
      .finally(function () {
        iconLoadPending.delete(pendingKey);
      });

    iconLoadPending.set(pendingKey, promise);
    return promise;
  }

  function pushMarkerGeoJsonToSource(options) {
    const src = map.getSource(SOURCE_ID);
    if (!src) return false;
    const visible = getVisibleMarkers();
    syncLabelVisibility(visible, options);
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
    return true;
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
    if (isAirCotType(m.type)) {
      return (
        src === "type2525b" ||
        src === "default" ||
        src === "type" ||
        src === "path" ||
        !src
      );
    }
    return false;
  }

  function formatMarkerGroupNames(m) {
    return markerGroups(m)
      .map(function (g) {
        return stripTakPrefix(g);
      })
      .join(", ");
  }

  function installMapImage(imageName, source) {
    if (!map.isStyleLoaded() || !source || map.hasImage(imageName)) {
      return Promise.resolve(Boolean(map.hasImage(imageName)));
    }
    const addOpts = { pixelRatio: 1 };
    function putImage(img) {
      try {
        if (!map.hasImage(imageName)) {
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

  function loadMapIcon(iconId, mapImageId) {
    const imageName = mapImageId || registerMapImageId(iconId);
    if (!iconId) return Promise.resolve();
    if (map.hasImage(imageName) && baseIconPixelCache.has(imageName)) {
      return Promise.resolve();
    }
    const pendingKey = imageName;
    if (iconLoadPending.has(pendingKey)) return iconLoadPending.get(pendingKey);

    const promise = fetch(iconApiUrl(iconId))
      .then(function (resp) {
        if (!resp.ok) throw new Error("icon " + resp.status);
        return resp.blob();
      })
      .then(function (blob) {
        return decodeIconBlob(blob);
      })
      .then(function (imageData) {
        baseIconPixelCache.set(imageName, imageData);
        return installMapImage(imageName, imageData);
      })
      .then(function () {
        if (map.getLayer(ICON_LAYER)) map.triggerRepaint();
        scheduleMapRefresh();
      })
      .catch(function (err) {
        console.warn("Failed to load map icon", { iconId: iconId, imageName: imageName, err: err });
      })
      .finally(function () {
        iconLoadPending.delete(pendingKey);
      });

    iconLoadPending.set(pendingKey, promise);
    return promise;
  }

  function preloadMarkerIcons() {
    const jobs = [];
    const seen = new Set();
    for (const m of markersByUid.values()) {
      if (!markerUsesMapIcon(m)) continue;
      const apiIconId = String(m.iconId);
      const color = markerDisplayColor(m);
      const baseMapImageId = registerMapImageId(apiIconId);
      const loadKey =
        color && !iconSkipsRecolor(m, apiIconId)
          ? baseMapImageId + "|" + color
          : baseMapImageId;
      if (seen.has(loadKey)) continue;
      seen.add(loadKey);
      if (color && !iconSkipsRecolor(m, apiIconId)) {
        jobs.push(loadColoredMapIcon(apiIconId, baseMapImageId, color));
      } else {
        jobs.push(loadMapIcon(apiIconId, baseMapImageId));
      }
    }
    return Promise.all(jobs);
  }

  function onStyleImageMissing(e) {
    const mapImageId = e.id;
    const parsed = parseColoredMapImageId(mapImageId);
    if (parsed) {
      registerColoredMapImageId(parsed.baseMapImageId, parsed.colorHex);
      if (tryInstallColoredIconSync(parsed.baseMapImageId, parsed.colorHex)) {
        if (map.getLayer(ICON_LAYER)) map.triggerRepaint();
        return;
      }
      const info =
        iconIdByMapImageId.get(mapImageId) ||
        iconIdByMapImageId.get(parsed.baseMapImageId);
      if (!info || !info.apiIconId) {
        scheduleMapRefresh();
        return;
      }
      if (iconLoadPending.has(mapImageId)) return;
      loadColoredMapIcon(info.apiIconId, parsed.baseMapImageId, parsed.colorHex).then(
        function () {
          if (map.getLayer(ICON_LAYER)) map.triggerRepaint();
          scheduleMapRefresh();
        }
      );
      return;
    }
    const info = iconIdByMapImageId.get(mapImageId);
    if (!info || !info.apiIconId) {
      scheduleMapRefresh();
      return;
    }
    if (iconLoadPending.has(mapImageId)) return;
    loadMapIcon(info.apiIconId, mapImageId).then(function () {
      if (map.getLayer(ICON_LAYER)) map.triggerRepaint();
      scheduleMapRefresh();
    });
  }

  const elLayerList = document.getElementById("mapLayerList");
  const elList = document.getElementById("mapMarkerList");
  const elDetailStack = document.getElementById("mapDetailStack");
  const elVisibleCounts = document.getElementById("mapVisibleCounts");
  const elConnLabel = document.getElementById("mapConnLabel");
  const elConnDot = document.getElementById("mapConnDot");
  const elCursor = document.getElementById("mapCursor");
  const elCursorBtn = document.getElementById("mapCursorBtn");
  const elZoomIn = document.getElementById("mapZoomIn");
  const elZoomOut = document.getElementById("mapZoomOut");
  const elSearch = document.getElementById("mapSearch");
  const elLayerSearch = document.getElementById("mapLayerSearch");
  const elHudFit = document.getElementById("mapHudFit");
  const elBasemapSelect = document.getElementById("mapBasemapSelect");
  const elZulu = document.getElementById("mapZulu");
  const elOffline = document.getElementById("mapOfflineBanner");
  const elPanelLeft = document.getElementById("mapPanelLeft");
  const elDetailResize = document.getElementById("mapDetailResize");
  const elExpandLeft = document.getElementById("mapExpandLeft");
  const elExpandRight = document.getElementById("mapExpandRight");

  let savedBasemap = localStorage.getItem(LS_BASEMAP) || "dark-matter";
  if (savedBasemap === "dark" || !BASEMAPS[savedBasemap]) {
    savedBasemap = "dark-matter";
    localStorage.setItem(LS_BASEMAP, savedBasemap);
  }
  elBasemapSelect.innerHTML = Object.entries(BASEMAPS)
    .map(([id, def]) => `<option value="${id}">${def.label}</option>`)
    .join("");
  elBasemapSelect.value = savedBasemap;

  const initialBasemap = BASEMAPS[savedBasemap] || BASEMAPS["dark-matter"];

  const map = new maplibregl.Map({
    container: "map",
    style: withMapGlyphs(initialBasemap.style),
    center: [-98.5795, 39.8283],
    zoom: 4,
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
  map.on("move", clampMapNorthUp);
  map.on("moveend", lockMapNorthUp);
  map.on("style.load", lockMapNorthUp);
  map.on("load", lockMapNorthUp);

  restorePanelState();
  loadDetailPanelWidth();
  initDetailPanelResize();

  const SOURCE_ID = "tak-markers";
  const ICON_LAYER = "tak-markers-icon";
  const CIRCLE_LAYER = "tak-markers-circle";
  const LABEL_LAYER = "tak-markers-label";
  const LABEL_PRIORITY_LAYER = "tak-markers-label-priority";
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

  function formatCursorCoords(lat, lon, formatId) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "—";
    const fmt = formatId || CURSOR_COORD_FORMATS[cursorCoordFormatIndex].id;
    if (fmt === "lon_lat") {
      return lon.toFixed(5) + ", " + lat.toFixed(5);
    }
    if (fmt === "dms") {
      return (
        toDmsPart(lat) +
        coordHemisphere(lat, true) +
        " " +
        toDmsPart(lon) +
        coordHemisphere(lon, false)
      );
    }
    if (fmt === "hemisphere") {
      return (
        Math.abs(lat).toFixed(5) +
        "\u00B0" +
        coordHemisphere(lat, true) +
        ", " +
        Math.abs(lon).toFixed(5) +
        "\u00B0" +
        coordHemisphere(lon, false)
      );
    }
    return lat.toFixed(5) + ", " + lon.toFixed(5);
  }

  function renderCursorCoords() {
    if (!elCursor || copyToastTimer) return;
    if (!lastCursorLngLat) {
      elCursor.textContent = "—";
      return;
    }
    elCursor.textContent = formatCursorCoords(
      lastCursorLngLat.lat,
      lastCursorLngLat.lng
    );
  }

  function cycleCursorCoordFormat() {
    cursorCoordFormatIndex =
      (cursorCoordFormatIndex + 1) % CURSOR_COORD_FORMATS.length;
    localStorage.setItem(LS_COORD_FORMAT, String(cursorCoordFormatIndex));
    renderCursorCoords();
    showCopyToast(CURSOR_COORD_FORMATS[cursorCoordFormatIndex].label);
  }

  function cursorCoordsCopyText(lat, lon) {
    return formatCursorCoords(lat, lon);
  }

  function removeMarkerLayers() {
    for (const id of [
      LABEL_PRIORITY_LAYER,
      LABEL_LAYER,
      ICON_LAYER,
      CIRCLE_LAYER,
      COURSE_LAYER,
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

  function setPanelLeftCollapsed(collapsed) {
    elPanelLeft.classList.toggle("collapsed", collapsed);
    elExpandLeft.hidden = !collapsed;
    localStorage.setItem(LS_PANEL_LEFT, collapsed ? "collapsed" : "open");
  }

  function isDetailPaneOpen() {
    return elDetailStack && !elDetailStack.classList.contains("collapsed");
  }

  function syncDetailStackVisibility() {
    if (!elDetailStack) return;
    const hasSlots = detailSlots.length > 0;
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
    }
  }

  function setDetailStackCollapsed(collapsed) {
    if (!detailSlots.length && collapsed) return;
    detailPaneUserCollapsed = collapsed;
    syncDetailStackVisibility();
    if (!collapsed) closeMapPopup();
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
    if (!elDetailStack || window.innerWidth <= 900) return;
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
    if (!elDetailStack || window.innerWidth <= 900) return;
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
      if (elDetailStack.classList.contains("collapsed") || window.innerWidth <= 900) {
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
      if (window.innerWidth <= 900) {
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
    setPanelLeftCollapsed(localStorage.getItem(LS_PANEL_LEFT) === "collapsed");
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

  function labelDeclutterSignature(visible) {
    return (
      String(Math.round(map.getZoom() * 4)) +
      "|" +
      visible.length +
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
    const w = Math.max(36, String(callsign || "").length * 6.5);
    const h = 13;
    return { x: pt.x - w / 2, y: pt.y - 28, w: w, h: h };
  }

  function recomputeLabelVisibility(visible) {
    const placed = [];
    const sorted = visible.slice().sort(function (a, b) {
      const aPri = a.uid === selectedUid ? 0 : a.uid === lockedUid ? 1 : 2;
      const bPri = b.uid === selectedUid ? 0 : b.uid === lockedUid ? 1 : 2;
      if (aPri !== bPri) return aPri - bPri;
      return String(a.callsign).localeCompare(String(b.callsign));
    });
    labelVisibleByUid.clear();
    for (let i = 0; i < sorted.length; i++) {
      const m = sorted[i];
      if (m.uid === selectedUid || m.uid === lockedUid) {
        labelVisibleByUid.set(m.uid, 1);
        placed.push(estimateLabelBox(m.lon, m.lat, m.callsign));
        continue;
      }
      const box = estimateLabelBox(m.lon, m.lat, m.callsign);
      let overlap = false;
      for (let j = 0; j < placed.length; j++) {
        if (labelBoxOverlaps(box, placed[j])) {
          overlap = true;
          break;
        }
      }
      labelVisibleByUid.set(m.uid, overlap ? 0 : 1);
      if (!overlap) placed.push(box);
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
        labelVisibleByUid.set(m.uid, 1);
      }
    }
  }

  function markerShowLabel(m) {
    if (m.uid === selectedUid || m.uid === lockedUid) return 1;
    return labelVisibleByUid.has(m.uid) ? labelVisibleByUid.get(m.uid) : 1;
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

  function markerLayersComplete() {
    return (
      map.getSource(SOURCE_ID) &&
      map.getLayer(CIRCLE_LAYER) &&
      map.getLayer(ICON_LAYER) &&
      map.getLayer(LABEL_LAYER) &&
      map.getLayer(LABEL_PRIORITY_LAYER)
    );
  }

  const LABEL_PRIORITY_FILTER = [
    "all",
    MARKER_FILTER,
    ["any", ["==", ["get", "selected"], true], ["==", ["get", "locked"], true]],
  ];

  const LABEL_STANDARD_FILTER = [
    "all",
    MARKER_FILTER,
    [
      "!",
      ["any", ["==", ["get", "selected"], true], ["==", ["get", "locked"], true]],
    ],
  ];

  function markerLabelLayout() {
    return {
      "text-field": [
        "case",
        ["==", ["get", "showLabel"], 1],
        ["get", "callsign"],
        "",
      ],
      "text-font": MAP_LABEL_FONT,
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

  function markerLabelPaint() {
    return {
      "text-color": "#ffffff",
      "text-halo-color": "rgba(0, 0, 0, 0.75)",
      "text-halo-width": 1.25,
      "text-opacity": 1,
    };
  }

  function addMarkerLayers() {
    if (!map.isStyleLoaded()) return false;
    if (markerLayersComplete()) return true;
    if (map.getSource(SOURCE_ID)) removeMarkerLayers();

    map.addSource(SOURCE_ID, {
      type: "geojson",
      promoteId: "uid",
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
          13,
          10,
        ],
        "circle-color": ["get", "color"],
        "circle-stroke-width": [
          "case",
          ["==", ["get", "selected"], true],
          2,
          1.5,
        ],
        "circle-stroke-color": "#ffffff",
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
          1.05,
          0.88,
        ],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "icon-optional": true,
      },
      paint: {
        "icon-opacity": 1,
        "icon-halo-color": "#ffffff",
        "icon-halo-width": 4,
      },
    });

    map.addLayer({
      id: LABEL_LAYER,
      type: "symbol",
      source: SOURCE_ID,
      filter: LABEL_STANDARD_FILTER,
      layout: markerLabelLayout(),
      paint: markerLabelPaint(),
    });

    map.addLayer({
      id: LABEL_PRIORITY_LAYER,
      type: "symbol",
      source: SOURCE_ID,
      filter: LABEL_PRIORITY_FILTER,
      layout: markerLabelLayout(),
      paint: markerLabelPaint(),
    });

    markerLayersReady = true;
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
    const layers = [];
    if (map.getLayer(CIRCLE_LAYER)) layers.push(CIRCLE_LAYER);
    if (map.getLayer(ICON_LAYER)) layers.push(ICON_LAYER);
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
      if (!f.properties || f.properties.kind !== "marker") continue;
      const uid = String(f.properties.uid || "");
      if (!uid || seen.has(uid)) continue;
      seen.add(uid);
      const m = markersByUid.get(uid);
      if (m) markers.push(m);
    }
    markers.sort(function (a, b) {
      return String(a.callsign).localeCompare(String(b.callsign));
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
      const chips = markerGroups(m)
        .slice(0, 2)
        .map(function (g) {
          return escapeHtml(stripTakPrefix(g));
        })
        .join(" · ");
      btn.innerHTML =
        '<div class="name">' +
        '<span class="map-aff-dot" style="' +
        markerDotStyle(m) +
        '"></span>' +
        escapeHtml(m.callsign) +
        "</div>" +
        (chips ? '<div class="meta">' + chips + "</div>" : "");
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        closeStackPicker();
        selectMarker(m.uid, true);
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

  function onMarkerIconClick(e) {
    if (e.originalEvent) e.originalEvent.stopPropagation();
    const markers = queryMarkersAtPoint(e.point);
    if (!markers.length) return;
    if (markers.length === 1) {
      closeStackPicker();
      selectMarker(markers[0].uid, true);
      return;
    }
    showStackPicker(markers, e.point);
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
    if (sec <= 0) {
      const graceSec = Math.round((staleMs + STALE_GRACE_MS - Date.now()) / 1000);
      if (graceSec > 0) return "stale · " + graceSec + "s left";
      return "stale";
    }
    if (sec < 120) return "stale in " + sec + "s";
    return "";
  }

  function fmtHae(n) {
    return Number.isFinite(Number(n)) ? String(Math.round(Number(n))) : "—";
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

    if (detailSlots.length === 1) {
      if (detailSlots[0].pinned) {
        detailSlots.push({ uid: id, pinned: false });
        focusedDetailIndex = 1;
        return 1;
      }
      detailSlots[0].uid = id;
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
    renderList();
    syncMapSource();
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
      showCopyToast("At most 2 pinned details panes");
      return;
    }
    slot.pinned = true;
    syncDetailStackDom();
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
      '<h2 class="map-detail-title">Details</h2>' +
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
    pane.querySelector(".map-detail-close-btn").addEventListener("click", function () {
      removeDetailSlotAt(slotIndex);
    });
    pane.querySelector(".map-detail-center-btn").addEventListener("click", function () {
      const m = markersByUid.get(slot.uid);
      if (!m) return;
      lockMoveFromCode = true;
      map.flyTo({ center: [m.lon, m.lat], zoom: Math.max(map.getZoom(), 12) });
    });
    pane.querySelector(".map-detail-lock-btn").addEventListener("click", function () {
      toggleLock(slot.uid);
    });
    pane.querySelector(".map-detail-copy-raw-btn").addEventListener("click", function () {
      fetch("/api/map/cot-raw?uid=" + encodeURIComponent(slot.uid))
        .then(function (resp) {
          if (!resp.ok) throw new Error("raw " + resp.status);
          return resp.text();
        })
        .then(function (text) {
          return copyTextToClipboard(text).then(function () {
            showCopyToast("Copied raw CoT");
          });
        })
        .catch(function () {
          showCopyToast("Raw CoT not available");
        });
    });

    return pane;
  }

  function detailBodyStructureKey(m) {
    const groups = markerGroups(m);
    return [
      groups.length === 1 ? "1g" : "ng",
      m.team && String(m.team).trim() ? "t" : "",
      m.role && String(m.role).trim() ? "r" : "",
      isUnknownHae(m.hae) ? "" : "h",
    ].join("|");
  }

  function buildDetailBodyHtml(m) {
    const groups = markerGroups(m);
    const groupHtml = groups
      .map(function (g) {
        return '<span class="map-chip">' + escapeHtml(stripTakPrefix(g)) + "</span>";
      })
      .join(" ");
    const remarksText = m.remarks ? String(m.remarks).trim() : "";
    const coordText = fmtCoord(m.lat) + ", " + fmtCoord(m.lon);
    const team = m.team ? String(m.team).trim() : "";
    const role = m.role ? String(m.role).trim() : "";
    const kvRows = [
      detailKvRow(
        groups.length === 1 ? "Group" : "Groups",
        '<span data-detail-key="groups">' + (groupHtml || "—") + "</span>",
        "map-chips"
      ),
    ];
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
    kvRows.push(
      detailKvRow(
        "Course",
        '<span data-detail-key="course">' +
          (m.course != null ? escapeHtml(String(m.course)) + "°" : "—") +
          "</span>"
      ),
      detailKvRow(
        "Speed",
        '<span data-detail-key="speed">' +
          (m.speed != null ? escapeHtml(String(m.speed)) : "—") +
          "</span>"
      ),
      detailKvRow(
        "Last updated",
        '<span class="map-detail-updated">' +
          escapeHtml(updatedAgeLabel(m.updatedAt)) +
          "</span>"
      )
    );

    return (
      '<div class="map-detail-wrap" data-detail-structure="' +
      escapeHtml(detailBodyStructureKey(m)) +
      '">' +
      '<dl class="map-kv map-kv-compact">' +
      kvRows.join("") +
      "</dl>" +
      '<section class="map-remarks-section">' +
      '<h3 class="map-remarks-title">Remarks</h3>' +
      '<div class="map-remarks-box' +
      (remarksText ? "" : " empty") +
      '" data-detail-key="remarks">' +
      escapeHtml(remarksText || "No remarks.") +
      "</div></section></div>"
    );
  }

  function wireDetailCoordsCopy(bodyEl, uid) {
    const copyBtn = bodyEl.querySelector(".map-copy-coords-btn");
    if (!copyBtn || copyBtn.dataset.wired === "1") return;
    copyBtn.dataset.wired = "1";
    copyBtn.addEventListener("click", function () {
      const current = markersByUid.get(uid);
      if (!current) return;
      const text = current.lat.toFixed(5) + ", " + current.lon.toFixed(5);
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

  function patchDetailPaneBody(bodyEl, m) {
    const wrap = bodyEl.querySelector(".map-detail-wrap");
    if (!wrap) return false;

    const coordsEl = bodyEl.querySelector(".map-detail-coords-val");
    if (coordsEl) {
      coordsEl.textContent = fmtCoord(m.lat) + ", " + fmtCoord(m.lon);
    }

    const haeEl = bodyEl.querySelector('[data-detail-key="hae"]');
    if (haeEl) haeEl.textContent = fmtHae(m.hae);

    const courseEl = bodyEl.querySelector('[data-detail-key="course"]');
    if (courseEl) {
      courseEl.textContent = m.course != null ? String(m.course) + "°" : "—";
    }

    const speedEl = bodyEl.querySelector('[data-detail-key="speed"]');
    if (speedEl) {
      speedEl.textContent = m.speed != null ? String(m.speed) : "—";
    }

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

    const updatedEl = bodyEl.querySelector(".map-detail-updated");
    if (updatedEl) updatedEl.textContent = updatedAgeLabel(m.updatedAt);

    return true;
  }

  function syncDetailStackDom() {
    if (!elDetailStack) return;
    const resizeHandle = elDetailResize;
    elDetailStack.innerHTML = "";
    if (resizeHandle) elDetailStack.appendChild(resizeHandle);

    detailSlots.forEach(function (slot, index) {
      const pane = buildDetailPaneElement(index, slot);
      elDetailStack.appendChild(pane);
      renderDetailPane(index);
    });
  }

  function renderDetailPane(slotIndex) {
    if (!elDetailStack) return;
    const slot = detailSlots[slotIndex];
    if (!slot) return;
    const pane = elDetailStack.querySelector(
      '.map-detail-pane[data-slot-index="' + slotIndex + '"]'
    );
    if (!pane) return;
    const m = markersByUid.get(slot.uid);
    const titleEl = pane.querySelector(".map-detail-title");
    const bodyEl = pane.querySelector(".map-detail-body");
    const actionsEl = pane.querySelector(".map-detail-actions");
    const pinBtn = pane.querySelector(".map-detail-pin-btn");
    const lockBtn = pane.querySelector(".map-detail-lock-btn");

    if (!m) {
      if (titleEl) titleEl.textContent = "Details";
      if (bodyEl) {
        bodyEl.innerHTML =
          '<div class="map-detail-empty">Marker no longer available.</div>';
      }
      if (actionsEl) actionsEl.hidden = true;
      clearDetailAgeTimer(slot.uid);
      return;
    }

    if (titleEl) titleEl.textContent = m.callsign || "Details";
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
      } else {
        bodyEl.innerHTML = buildDetailBodyHtml(m);
        wireDetailCoordsCopy(bodyEl, slot.uid);
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
    if (totalSec < 60) return totalSec + "sec ago";
    if (totalSec < 3600) {
      const min = Math.floor(totalSec / 60);
      const sec = totalSec % 60;
      return min + "m " + sec + "sec ago";
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

  function detailKvRow(label, valueHtml, ddClass) {
    const cls = ddClass ? ' class="' + ddClass + '"' : "";
    return "<dt>" + escapeHtml(label) + "</dt><dd" + cls + ">" + valueHtml + "</dd>";
  }

  function lockedMarkerCoords() {
    const m = lockedUid ? markersByUid.get(lockedUid) : null;
    if (!m || !Number.isFinite(m.lon) || !Number.isFinite(m.lat)) return null;
    return [m.lon, m.lat];
  }

  function clearLock() {
    lockedUid = null;
    updateLockButtonsUi();
    syncMapSource();
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
    const m = id ? markersByUid.get(id) : null;
    if (!m || !Number.isFinite(m.lon) || !Number.isFinite(m.lat)) return;
    if (lockedUid === m.uid) {
      clearLock();
      return;
    }
    lockedUid = m.uid;
    lockMoveFromCode = true;
    map.easeTo({ center: [m.lon, m.lat], zoom: map.getZoom(), duration: 400 });
    updateLockButtonsUi();
    syncMapSource();
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
    const id = String(uid);
    const hadSlot = detailSlots.some(function (s) {
      return s.uid === id;
    });
    const prevLen = detailSlots.length;
    const idx = ensureDetailSlotForUid(id);

    selectedUid = id;
    detailPaneUserCollapsed = false;

    if (idx >= 0) {
      if (detailSlots.length !== prevLen || !hadSlot) {
        syncDetailStackDom();
      } else {
        renderDetailPane(idx);
      }
      syncDetailStackVisibility();
    }

    renderList();
    syncMapSource();
    const m = markersByUid.get(id);
    if (m && Number.isFinite(m.lon) && Number.isFinite(m.lat)) {
      if (showPopupFlag) {
        if (isDetailPaneOpen()) closeMapPopup();
        else showPopup(m);
      }
    }
  }

  function applyBatch(msg) {
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
    if (msg.groupsCatalog) mergeGroupsCatalog(msg.groupsCatalog);
    else recomputeGroupCounts();
    syncMapSource();
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
      const locked = markersByUid.get(lockedUid);
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

  function applySnapshot(state) {
    mergeGroupsCatalog(state?.groupsCatalog || []);
    if (state && state.icons && state.icons.defaultIcons) {
      defaultIconIds = state.icons.defaultIcons;
    }
    loadMarkersFromServer()
      .then(function () {
        iconLoadPending.clear();
        syncMapSource();
        renderLayerList();
        renderList();
        maybeFitVisibleOnLoad();
        if (markerLayersReady) {
          reinstallMapIconsFromCache();
          preloadMarkerIcons().finally(function () {
            pushMarkerGeoJsonToSource();
            if (map.getLayer(ICON_LAYER)) map.triggerRepaint();
          });
        }
      })
      .catch(function () {});
    setConnStatus(!!state.connected, state.lastError);
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

  let styleRestoreTimer = null;
  let styleRestoreGen = 0;
  let styleRestoreCompleteGen = -1;

  function restoreMapAfterStyleChange() {
    const gen = styleRestoreGen;
    if (styleRestoreTimer) clearTimeout(styleRestoreTimer);

    function afterLayersReady() {
      if (gen !== styleRestoreGen || styleRestoreCompleteGen === gen) return;
      styleRestoreCompleteGen = gen;
      reinstallMapIconsFromCache();
      markerLayersReady = true;
      mapRefreshPending = false;
      pushMarkerGeoJsonToSource();
      preloadMarkerIcons().finally(function () {
        if (gen !== styleRestoreGen) return;
        pushMarkerGeoJsonToSource();
        if (map.getLayer(ICON_LAYER)) map.triggerRepaint();
        if (map.getLayer(CIRCLE_LAYER)) map.triggerRepaint();
      });
    }

    function attemptRestore(retry) {
      if (gen !== styleRestoreGen || styleRestoreCompleteGen === gen) return;
      if (!map.isStyleLoaded()) {
        if (retry < 120) {
          setTimeout(function () {
            attemptRestore(retry + 1);
          }, 50);
        }
        return;
      }
      removeMarkerLayers();
      if (!ensureMarkerLayers()) {
        if (retry < 120) {
          setTimeout(function () {
            attemptRestore(retry + 1);
          }, 50);
        }
        return;
      }
      afterLayersReady();
    }

    styleRestoreTimer = setTimeout(function () {
      styleRestoreTimer = null;
      if (gen !== styleRestoreGen) return;
      markerLayersReady = false;
      mapRefreshPending = true;
      map.once("idle", function () {
        attemptRestore(0);
      });
    }, 50);
  }

  function setBasemap(id) {
    const def = BASEMAPS[id] || BASEMAPS["dark-matter"];
    localStorage.setItem(LS_BASEMAP, id);
    styleRestoreGen++;
    styleRestoreCompleteGen = -1;
    markerLayersReady = false;
    mapRefreshPending = true;
    iconLoadPending.clear();
    map.setStyle(withMapGlyphs(def.style));
  }

  function deselectMarker() {
    if (!selectedUid) return;
    selectedUid = null;
    for (let i = detailSlots.length - 1; i >= 0; i--) {
      if (!detailSlots[i].pinned) {
        clearDetailAgeTimer(detailSlots[i].uid);
        detailSlots.splice(i, 1);
      }
    }
    syncDetailStackDom();
    syncDetailStackVisibility();
    renderList();
    syncMapSource();
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
    if (!isMapClickNotDrag(e)) return;
    const layers = [];
    if (map.getLayer(CIRCLE_LAYER)) layers.push(CIRCLE_LAYER);
    if (map.getLayer(ICON_LAYER)) layers.push(ICON_LAYER);
    if (map.getLayer(LABEL_PRIORITY_LAYER)) layers.push(LABEL_PRIORITY_LAYER);
    if (map.getLayer(LABEL_LAYER)) layers.push(LABEL_LAYER);
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
  });

  map.on("zoomend", () => {
    if (lockedUid && !lockMoveFromCode) {
      recenterLockedMarkerAtCurrentZoom();
    }
    labelDeclutterKey = "";
    if (markerLayersReady) refreshMapFromMarkers();
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

  elExpandLeft.addEventListener("click", () => {
    setPanelLeftCollapsed(false);
  });

  elExpandRight.addEventListener("click", () => {
    setDetailStackCollapsed(false);
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "/" && document.activeElement !== elSearch) {
      ev.preventDefault();
      if (activeTab === "contacts") elSearch.focus();
      else elLayerSearch.focus();
    }
    if (ev.key === "Escape") {
      closeStackPicker();
      deselectMarker();
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

  setInterval(function () {
    if (!markersByUid.size) return;
    const now = Date.now();
    let refresh = false;
    for (const m of markersByUid.values()) {
      if (!m.stale) continue;
      const t = Date.parse(m.stale);
      if (!Number.isFinite(t)) continue;
      if (now >= t - 60000 && now <= t + STALE_GRACE_MS) {
        refresh = true;
        break;
      }
    }
    if (refresh) renderList();
  }, 5000);

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
    .then((data) => {
      mergeGroupsCatalog(data.groups || []);
      renderLayerList();
    })
    .catch(() => {});
})();
