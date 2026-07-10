/**
 * Dashboard connected-user mini map (single live marker).
 */
(function () {
  "use strict";

  const SOURCE_ID = "dashboard-user-marker";
  const CIRCLE_LAYER = "dashboard-user-marker-circle";
  const ICON_LAYER = "dashboard-user-marker-icon";
  const POLL_MS = 8000;
  const MAPLIBRE_CSS =
    "https://unpkg.com/maplibre-gl@5.13.0/dist/maplibre-gl.css";
  const MAPLIBRE_JS =
    "https://unpkg.com/maplibre-gl@5.13.0/dist/maplibre-gl.js";
  const LS_BASEMAP = "tak-portal-map-basemap";

  let map = null;
  let pollTimer = null;
  let assetsPromise = null;
  let currentClientId = null;
  let currentCallsign = null;
  let iconLoadPending = null;
  let hasLiveMarker = false;

  function isMobile() {
    return window.matchMedia("(max-width: 768px)").matches;
  }

  function mapUserKey() {
    return (
      String(window.TAK_PORTAL_MAP_USER_KEY || "").trim() ||
      String(document.body && document.body.getAttribute("data-map-user")).trim() ||
      "anonymous"
    );
  }

  function mapPrefsStorageKey() {
    return "tak-portal-map-prefs:" + mapUserKey();
  }

  function readBasemapId() {
    const basemaps = window.TAK_MAP_BASEMAPS || {};
    const normalize =
      typeof basemaps.normalizeBasemapId === "function"
        ? basemaps.normalizeBasemapId
        : function (id) {
            return String(id || "").trim() || "dark-matter";
          };
    const serverDefault = normalize(
      (window.TAK_PORTAL_MAP_DEFAULTS && window.TAK_PORTAL_MAP_DEFAULTS.basemap) ||
        basemaps.DEFAULT_BASEMAP_ID ||
        "dark-matter"
    );
    try {
      const raw = localStorage.getItem(mapPrefsStorageKey());
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.basemap) return normalize(parsed.basemap);
      }
    } catch (_) {}
    const legacy = localStorage.getItem(LS_BASEMAP);
    return normalize(legacy || serverDefault);
  }

  function getBasemapStyle() {
    const basemaps = window.TAK_MAP_BASEMAPS || {};
    const id = readBasemapId();
    if (typeof basemaps.getBasemapStyle === "function") {
      return basemaps.getBasemapStyle(id);
    }
    const entry = basemaps.BASEMAPS && basemaps.BASEMAPS[id];
    return entry ? entry.style : "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
  }

  function withMapGlyphs(style) {
    const basemaps = window.TAK_MAP_BASEMAPS || {};
    if (typeof basemaps.withMapGlyphs === "function") {
      return basemaps.withMapGlyphs(style);
    }
    return style;
  }

  function loadStylesheet(href) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('link[href="' + href + '"]')) {
        resolve();
        return;
      }
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.onload = function () {
        resolve();
      };
      link.onerror = function () {
        reject(new Error("Failed to load stylesheet"));
      };
      document.head.appendChild(link);
    });
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) {
        resolve();
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = function () {
        resolve();
      };
      script.onerror = function () {
        reject(new Error("Failed to load script"));
      };
      document.head.appendChild(script);
    });
  }

  function ensureMapLibre() {
    if (window.maplibregl) return Promise.resolve();
    if (assetsPromise) return assetsPromise;
    assetsPromise = loadStylesheet(MAPLIBRE_CSS)
      .then(function () {
        return loadScript(MAPLIBRE_JS);
      })
      .then(function () {
        if (!window.maplibregl) {
          throw new Error("MapLibre failed to load");
        }
      });
    return assetsPromise;
  }

  function emptyFeatureCollection() {
    return { type: "FeatureCollection", features: [] };
  }

  function setEmptyVisible(show) {
    const el = document.getElementById("clientMiniMapEmpty");
    if (!el) return;
    el.hidden = !show;
  }

  function base64ToBlob(b64, mime) {
    const binary = atob(b64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime || "image/png" });
  }

  function decodeIconBlob(blob) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("icon decode failed"));
      };
      img.src = url;
    });
  }

  function installMapImage(imageName, source) {
    if (!map || !source) return Promise.resolve(false);
    const addOpts = { pixelRatio: 1 };
    try {
      if (map.hasImage(imageName)) {
        map.updateImage(imageName, source);
      } else {
        map.addImage(imageName, source, addOpts);
      }
      return Promise.resolve(true);
    } catch (_) {
      return Promise.resolve(false);
    }
  }

  function loadIconManifest(manifest) {
    const list = Array.isArray(manifest) ? manifest : [];
    if (!list.length || !map) return Promise.resolve();
    if (iconLoadPending) return iconLoadPending;

    iconLoadPending = fetch("/api/map/icons/rendered/batch", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ icons: list }),
    })
      .then(function (resp) {
        if (!resp.ok) throw new Error("icon batch " + resp.status);
        return resp.json();
      })
      .then(function (data) {
        const icons = data.icons || {};
        const jobs = [];
        for (const mapImageId of Object.keys(icons)) {
          const b64 = icons[mapImageId];
          if (!b64) continue;
          jobs.push(
            decodeIconBlob(base64ToBlob(b64, "image/png")).then(function (img) {
              return installMapImage(mapImageId, img);
            })
          );
        }
        return Promise.all(jobs);
      })
      .finally(function () {
        iconLoadPending = null;
      });

    return iconLoadPending;
  }

  function addMarkerLayers() {
    if (!map || map.getSource(SOURCE_ID)) return;

    map.addSource(SOURCE_ID, {
      type: "geojson",
      data: emptyFeatureCollection(),
    });

    map.addLayer({
      id: CIRCLE_LAYER,
      type: "circle",
      source: SOURCE_ID,
      filter: ["==", ["get", "showCircle"], 1],
      paint: {
        "circle-radius": 10,
        "circle-color": ["get", "color"],
        "circle-stroke-width": 1.5,
        "circle-stroke-color": "#ffffff",
      },
    });

    map.addLayer({
      id: ICON_LAYER,
      type: "symbol",
      source: SOURCE_ID,
      filter: ["!=", ["get", "iconId"], ""],
      layout: {
        "icon-image": ["get", "iconId"],
        "icon-size": 0.88,
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
      paint: {
        "icon-opacity": ["case", ["!=", ["get", "iconId"], ""], 1, 0],
      },
    });
  }

  function updateMarkerOnMap(payload) {
    if (!map) return Promise.resolve();
    const source = map.getSource(SOURCE_ID);
    if (!source) return Promise.resolve();

    if (!payload || !payload.found || !payload.feature) {
      hasLiveMarker = false;
      source.setData(emptyFeatureCollection());
      setEmptyVisible(true);
      return Promise.resolve();
    }

    hasLiveMarker = true;
    setEmptyVisible(false);
    const feature = payload.feature;
    source.setData({
      type: "FeatureCollection",
      features: [feature],
    });

    const coords = feature.geometry && feature.geometry.coordinates;
    if (coords && coords.length >= 2) {
      map.easeTo({
        center: [coords[0], coords[1]],
        zoom: Math.max(map.getZoom(), 14),
        duration: 400,
      });
    }

    return loadIconManifest(payload.iconManifest || []);
  }

  function fetchLiveMarker(clientId, callsign) {
    const q =
      "/api/tak/clients/" +
      encodeURIComponent(clientId) +
      "/live-marker?callsign=" +
      encodeURIComponent(callsign || "");
    return fetch(q, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    }).then(function (resp) {
      return resp.json().then(function (body) {
        if (!resp.ok) throw new Error((body && body.error) || "Failed to load marker");
        return body;
      });
    });
  }

  function refreshMarker() {
    if (!currentClientId || !currentCallsign || !map) return Promise.resolve();
    return fetchLiveMarker(currentClientId, currentCallsign)
      .then(function (payload) {
        return updateMarkerOnMap(payload);
      })
      .catch(function () {
        if (!hasLiveMarker) setEmptyVisible(true);
      });
  }

  function init() {
    if (isMobile()) return Promise.resolve(false);
    const container = document.getElementById("clientMiniMap");
    if (!container) return Promise.resolve(false);
    if (map) return Promise.resolve(true);

    return ensureMapLibre().then(function () {
      const style = getBasemapStyle();
      const initialStyle =
        typeof style === "string" ? style : withMapGlyphs(style);

      map = new maplibregl.Map({
        container: container,
        style: initialStyle,
        center: [-85.25, 35.17],
        zoom: 10,
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
      });

      map.scrollZoom.enable();

      return new Promise(function (resolve) {
        map.on("load", function () {
          try {
            addMarkerLayers();
          } catch (_) {}
          requestAnimationFrame(function () {
            if (map) map.resize();
          });
          resolve(true);
        });
        map.on("error", function () {
          resolve(false);
        });
      });
    });
  }

  function loadMarker(clientId, callsign) {
    currentClientId = clientId || null;
    currentCallsign = callsign || null;
    if (!map || !currentClientId || !currentCallsign) {
      if (!hasLiveMarker) setEmptyVisible(true);
      return Promise.resolve();
    }
    return refreshMarker();
  }

  function startPolling(clientId, callsign) {
    if (clientId) currentClientId = clientId;
    if (callsign) currentCallsign = callsign;
    stopPolling();
    if (!map || isMobile()) return;
    pollTimer = setInterval(function () {
      refreshMarker();
    }, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function destroy() {
    stopPolling();
    currentClientId = null;
    currentCallsign = null;
    iconLoadPending = null;
    hasLiveMarker = false;
    if (map) {
      try {
        map.remove();
      } catch (_) {}
      map = null;
    }
    setEmptyVisible(false);
    const container = document.getElementById("clientMiniMap");
    if (container) container.innerHTML = "";
  }

  window.DashboardMiniMap = {
    init: init,
    loadMarker: loadMarker,
    startPolling: startPolling,
    stopPolling: stopPolling,
    destroy: destroy,
  };
})();
