/**
 * Dashboard connected-user mini map (single live marker).
 */
(function () {
  "use strict";

  const SOURCE_ID = "dashboard-user-marker";
  const CIRCLE_LAYER = "dashboard-user-marker-circle";
  const ICON_LAYER = "dashboard-user-marker-icon";
  const POLL_MS = 8000;
  const DEFAULT_CENTER = [-85.25, 35.17];
  const DEFAULT_ZOOM = 10;
  const LOCKED_ZOOM = 14;
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
  let centerLocked = true;
  /** @type {[number, number] | null} */
  let lockedCenter = null;
  let wheelHandler = null;
  let recenterOnIdleScheduled = false;
  /** Cached marker payload — reapplied after basemap style reloads wipe custom layers. */
  let lastMarkerPayload = null;
  /** Degrees — pan beyond this from the CoT breaks center lock. */
  const UNLOCK_CENTER_THRESHOLD = 0.00012;

  function lngLatDistanceDeg(a, b) {
    if (!a || !b) return Infinity;
    const dLng = a.lng - b[0];
    const dLat = a.lat - b[1];
    return Math.sqrt(dLng * dLng + dLat * dLat);
  }

  function applyCenterLockMode() {
    if (!map) return;
    if (centerLocked) map.scrollZoom.disable();
    else map.scrollZoom.enable();
  }

  function setMapReadyVisible(visible) {
    const pane = document.querySelector(".client-modal-map-pane");
    if (pane) pane.classList.toggle("mini-map-ready", !!visible);
  }

  function revealMap() {
    setMapReadyVisible(true);
    if (map) {
      try {
        map.resize();
      } catch (_) {}
    }
  }

  function scheduleRecenterIfLocked() {
    if (!map || !centerLocked || !lockedCenter || recenterOnIdleScheduled) return;
    recenterOnIdleScheduled = true;
    function runRecenter() {
      recenterOnIdleScheduled = false;
      if (!map || !centerLocked || !lockedCenter) return;
      map.resize();
      centerOnLockedMarker({ zoom: LOCKED_ZOOM, duration: 0 });
    }
    if (typeof map.loaded === "function" && map.loaded() && typeof map.isMoving === "function" && !map.isMoving()) {
      requestAnimationFrame(runRecenter);
      return;
    }
    map.once("idle", runRecenter);
  }

  function markerLayersComplete() {
    return !!(
      map &&
      map.getSource(SOURCE_ID) &&
      map.getLayer(CIRCLE_LAYER) &&
      map.getLayer(ICON_LAYER)
    );
  }

  function removeMarkerLayers() {
    if (!map) return;
    try {
      if (map.getLayer(ICON_LAYER)) map.removeLayer(ICON_LAYER);
      if (map.getLayer(CIRCLE_LAYER)) map.removeLayer(CIRCLE_LAYER);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    } catch (_) {}
  }

  function markerFeatureForMap(feature) {
    if (!feature) return null;
    const props = Object.assign({}, feature.properties || {}, { showCircle: 1 });
    return {
      type: "Feature",
      geometry: feature.geometry,
      properties: props,
    };
  }

  function applyPayloadToSource(payload) {
    const source = map && map.getSource(SOURCE_ID);
    if (!source) return false;

    if (!payload || !payload.found || !payload.feature) {
      hasLiveMarker = false;
      lockedCenter = null;
      source.setData(emptyFeatureCollection());
      setEmptyVisible(true);
      return true;
    }

    hasLiveMarker = true;
    setEmptyVisible(false);
    const mapped = markerFeatureForMap(payload.feature);
    source.setData({
      type: "FeatureCollection",
      features: mapped ? [mapped] : [],
    });

    const coords = payload.feature.geometry && payload.feature.geometry.coordinates;
    if (coords && coords.length >= 2) {
      if (centerLocked) {
        setLockedCenterFromCoords(coords, {
          zoom: Math.max(map.getZoom(), LOCKED_ZOOM),
          duration: 0,
        });
      } else {
        lockedCenter = [coords[0], coords[1]];
      }
    }
    return true;
  }

  function syncMarkerToMap() {
    if (!map || !map.isStyleLoaded()) return Promise.resolve(false);

    if (!markerLayersComplete()) {
      try {
        removeMarkerLayers();
        addMarkerLayers();
      } catch (_) {
        return Promise.resolve(false);
      }
    }

    if (!markerLayersComplete()) return Promise.resolve(false);

    if (!lastMarkerPayload) {
      applyPayloadToSource(null);
      return Promise.resolve(true);
    }

    applyPayloadToSource(lastMarkerPayload);
    const manifest =
      (lastMarkerPayload && lastMarkerPayload.iconManifest) || [];
    return loadIconManifest(manifest).then(function () {
      if (map) {
        try {
          map.triggerRepaint();
        } catch (_) {}
      }
      return true;
    });
  }

  function scheduleMarkerSync() {
    if (!map) return;
    let attempt = 0;
    function trySync() {
      if (!map) return;
      syncMarkerToMap().then(function (ok) {
        if (!ok && attempt < 80) {
          attempt += 1;
          setTimeout(trySync, 50);
        }
      });
    }
    trySync();
  }

  function whenMapReady() {
    return new Promise(function (resolve) {
      if (!map) {
        resolve();
        return;
      }
      function finish() {
        if (!map || !map.isStyleLoaded()) {
          map.once("styledata", finish);
          return;
        }
        try {
          map.resize();
        } catch (_) {}
        requestAnimationFrame(function () {
          if (map) map.resize();
          requestAnimationFrame(function () {
            resolve();
          });
        });
      }
      if (typeof map.loaded === "function" && map.loaded()) finish();
      else map.once("load", finish);
    });
  }

  function centerOnLockedMarker(options) {
    if (!map || !lockedCenter) return;
    const opts = options || {};
    const zoom =
      opts.zoom != null ? opts.zoom : Math.max(map.getZoom(), LOCKED_ZOOM);
    map.resize();
    const view = { center: lockedCenter, zoom: zoom };
    if (opts.duration > 0) {
      map.easeTo({
        center: lockedCenter,
        zoom: zoom,
        duration: opts.duration,
      });
      return;
    }
    map.jumpTo(view);
  }

  function setLockedCenterFromCoords(coords, options) {
    if (!coords || coords.length < 2) return;
    lockedCenter = [coords[0], coords[1]];
    if (!centerLocked) return;
    centerOnLockedMarker(options);
    scheduleRecenterIfLocked();
  }

  function onMapWheel(e) {
    if (!map || !centerLocked || !lockedCenter) return;
    e.preventDefault();
    e.stopPropagation();
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 16;
    else if (e.deltaMode === 2) delta *= 400;
    const zoom = map.getZoom();
    const step = delta > 0 ? -0.65 : 0.65;
    const minZoom = typeof map.getMinZoom === "function" ? map.getMinZoom() : 0;
    const maxZoom = typeof map.getMaxZoom === "function" ? map.getMaxZoom() : 22;
    const nextZoom = Math.max(minZoom, Math.min(maxZoom, zoom + step));
    map.jumpTo({
      center: lockedCenter,
      zoom: nextZoom,
    });
  }

  function onMapDragEnd() {
    if (!map || !centerLocked || !lockedCenter) return;
    const center = map.getCenter();
    if (lngLatDistanceDeg(center, lockedCenter) > UNLOCK_CENTER_THRESHOLD) {
      centerLocked = false;
      applyCenterLockMode();
      return;
    }
    map.easeTo({ center: lockedCenter, duration: 200 });
  }

  function bindMapInteraction() {
    if (!map || map.__dashboardMiniMapBound) return;
    map.__dashboardMiniMapBound = true;
    map.on("dragend", onMapDragEnd);
    wheelHandler = onMapWheel;
    map.getCanvas().addEventListener("wheel", wheelHandler, { passive: false });
    applyCenterLockMode();
  }

  function unbindMapInteraction() {
    if (!map) return;
    map.off("dragend", onMapDragEnd);
    if (wheelHandler) {
      try {
        map.getCanvas().removeEventListener("wheel", wheelHandler);
      } catch (_) {}
      wheelHandler = null;
    }
    map.__dashboardMiniMapBound = false;
  }

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
    if (!map || !map.isStyleLoaded()) return false;
    if (markerLayersComplete()) return true;

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
        "circle-color": ["coalesce", ["get", "color"], "#2196F3"],
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
        "icon-optional": true,
      },
      paint: {
        "icon-opacity": ["case", ["!=", ["get", "iconId"], ""], 1, 0],
      },
    });
    return true;
  }

  function updateMarkerOnMap(payload) {
    if (payload && payload.found && payload.feature) {
      lastMarkerPayload = payload;
    } else if (!hasLiveMarker) {
      lastMarkerPayload = null;
    }
    if (!map) return Promise.resolve();
    return whenMapReady().then(function () {
      return syncMarkerToMap();
    });
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

  function fetchMarkerWithRetry(attempt) {
    if (!currentClientId || !currentCallsign) {
      return Promise.resolve({ found: false });
    }
    const tryNum = attempt != null ? attempt : 0;
    return fetchLiveMarker(currentClientId, currentCallsign)
      .then(function (payload) {
        if (!payload.found && tryNum < 5) {
          return new Promise(function (resolve) {
            setTimeout(function () {
              resolve(fetchMarkerWithRetry(tryNum + 1));
            }, 400);
          });
        }
        return payload;
      })
      .catch(function () {
        return { found: false };
      });
  }

  function refreshMarker() {
    if (!currentClientId || !currentCallsign || !map) return Promise.resolve();
    return fetchLiveMarker(currentClientId, currentCallsign)
      .then(function (payload) {
        if (payload && payload.found) lastMarkerPayload = payload;
        return updateMarkerOnMap(payload);
      })
      .catch(function () {
        if (!hasLiveMarker) setEmptyVisible(true);
      });
  }

  function open(clientId, callsign) {
    if (isMobile()) return Promise.resolve(false);
    const container = document.getElementById("clientMiniMap");
    if (!container) return Promise.resolve(false);

    stopPolling();
    if (map) {
      try {
        unbindMapInteraction();
        map.remove();
      } catch (_) {}
      map = null;
    }

    currentClientId = clientId || null;
    currentCallsign = callsign || null;
    centerLocked = true;
    hasLiveMarker = false;
    lockedCenter = null;
    lastMarkerPayload = null;
    recenterOnIdleScheduled = false;
    applyCenterLockMode();

    if (!currentClientId || !currentCallsign) {
      setEmptyVisible(true);
      return Promise.resolve(false);
    }

    return Promise.all([fetchMarkerWithRetry(0), ensureMapLibre()])
      .then(function (results) {
        const payload = results[0];
        lastMarkerPayload = payload && payload.found ? payload : null;
        let center = DEFAULT_CENTER.slice();
        let zoom = DEFAULT_ZOOM;
        const feature = payload && payload.feature;
        const coords = feature && feature.geometry && feature.geometry.coordinates;
        if (payload && payload.found && coords && coords.length >= 2) {
          center = [coords[0], coords[1]];
          zoom = LOCKED_ZOOM;
          lockedCenter = center;
        } else {
          lockedCenter = null;
        }
        revealMap();
        return init({ center: center, zoom: zoom }).then(function () {
          return updateMarkerOnMap(payload);
        });
      })
      .then(function () {
        revealMap();
        scheduleMarkerSync();
        scheduleRecenterIfLocked();
        startPolling(clientId, callsign);
        return true;
      })
      .catch(function () {
        revealMap();
        if (!hasLiveMarker) setEmptyVisible(true);
        return false;
      });
  }

  function init(options) {
    if (isMobile()) return Promise.resolve(false);
    const container = document.getElementById("clientMiniMap");
    if (!container) return Promise.resolve(false);
    if (map) {
      return whenMapReady().then(function () {
        return true;
      });
    }

    const opts = options || {};
    const initialCenter =
      opts.center && opts.center.length >= 2 ? opts.center : DEFAULT_CENTER;
    const initialZoom = opts.zoom != null ? opts.zoom : DEFAULT_ZOOM;

    return ensureMapLibre().then(function () {
      const style = getBasemapStyle();
      const initialStyle =
        typeof style === "string" ? style : withMapGlyphs(style);

      map = new maplibregl.Map({
        container: container,
        style: initialStyle,
        center: initialCenter,
        zoom: initialZoom,
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
      });

      map.scrollZoom.enable();

      return new Promise(function (resolve) {
        map.on("load", function () {
          try {
            bindMapInteraction();
          } catch (_) {}
          whenMapReady().then(function () {
            if (centerLocked && lockedCenter) {
              centerOnLockedMarker({ zoom: LOCKED_ZOOM, duration: 0 });
              scheduleRecenterIfLocked();
            }
            scheduleMarkerSync();
            resolve(true);
          });
        });
        map.on("styledata", function () {
          if (!map || !map.isStyleLoaded()) return;
          scheduleMarkerSync();
          if (centerLocked && lockedCenter) scheduleRecenterIfLocked();
        });
        map.on("error", function () {
          resolve(false);
        });
      });
    });
  }

  function loadMarker(clientId, callsign) {
    return open(clientId, callsign);
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
    centerLocked = true;
    lockedCenter = null;
    recenterOnIdleScheduled = false;
    lastMarkerPayload = null;
    setMapReadyVisible(false);
    if (map) {
      try {
        unbindMapInteraction();
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
    open: open,
    loadMarker: loadMarker,
    startPolling: startPolling,
    stopPolling: stopPolling,
    destroy: destroy,
  };
})();
