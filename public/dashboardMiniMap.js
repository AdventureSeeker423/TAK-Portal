/**
 * Dashboard connected-user mini map (single live marker).
 * Uses the same MapLibre UMD vendor + paint patterns as /map for stability.
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
  const LS_BASEMAP = "tak-portal-map-basemap";
  const FEATURE_ID = 1;

  function mapAssets() {
    return window.TAK_PORTAL_MAP_ASSETS || {};
  }

  function maplibreCssUrl() {
    return (
      mapAssets().maplibreCssUrl ||
      "https://unpkg.com/maplibre-gl@5.13.0/dist/maplibre-gl.css"
    );
  }

  function maplibreJsUrl() {
    return (
      mapAssets().maplibreJsUrl ||
      "https://unpkg.com/maplibre-gl@5.13.0/dist/maplibre-gl.js"
    );
  }

  let map = null;
  let pollTimer = null;
  let assetsPromise = null;
  let currentClientId = null;
  let currentCallsign = null;
  let currentUsername = null;
  /** @type {Map<string, Promise<void>>} */
  const iconLoadPending = new Map();
  let hasLiveMarker = false;
  let centerLocked = true;
  /** @type {[number, number] | null} */
  let lockedCenter = null;
  let wheelHandler = null;
  let recenterOnIdleScheduled = false;
  /** Cached marker payload — reapplied after basemap style reloads wipe custom layers. */
  let lastMarkerPayload = null;
  let lastAppliedSignature = "";
  let containerResizeObserver = null;
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
    resizeMapSoon();
  }

  function resizeMapSoon() {
    if (!map) return;
    try {
      map.resize();
    } catch (_) {}
    requestAnimationFrame(function () {
      if (!map) return;
      try {
        map.resize();
      } catch (_) {}
      requestAnimationFrame(function () {
        if (!map) return;
        try {
          map.resize();
        } catch (_) {}
      });
    });
  }

  function bindContainerResizeObserver() {
    unbindContainerResizeObserver();
    const pane = document.querySelector(".client-modal-map-pane");
    if (!pane || typeof ResizeObserver === "undefined") return;
    containerResizeObserver = new ResizeObserver(function () {
      resizeMapSoon();
    });
    containerResizeObserver.observe(pane);
  }

  function unbindContainerResizeObserver() {
    if (containerResizeObserver) {
      containerResizeObserver.disconnect();
      containerResizeObserver = null;
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
    if (
      typeof map.loaded === "function" &&
      map.loaded() &&
      typeof map.isMoving === "function" &&
      !map.isMoving()
    ) {
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

  function normalizeMapImageId(mapImageId) {
    const id = String(mapImageId || "").trim();
    if (!id) return "";
    if (id.startsWith("mimg-")) return id;
    const match = /^(?:wing|rotor|vehicle|boat|ship|track|car|mimg)-([0-9a-f]{16})$/i.exec(id);
    if (match) return "mimg-" + match[1].toLowerCase();
    return id;
  }

  function isRenderedMapImageId(mapImageId) {
    return /^(?:mimg|wing|rotor|vehicle|boat|ship|track|car)-[0-9a-f]{16}$/i.test(
      String(mapImageId || "")
    );
  }

  function payloadSignature(payload) {
    if (!payload || !payload.found || !payload.feature) return "empty";
    const props = payload.feature.properties || {};
    const coords = (payload.feature.geometry && payload.feature.geometry.coordinates) || [];
    return [
      props.uid || "",
      coords[0],
      coords[1],
      props.iconId || "",
      props.color || "",
      props.callsign || "",
    ].join("|");
  }

  function markerFeatureForMap(feature) {
    if (!feature || !feature.geometry) return null;
    const coords = feature.geometry.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return null;
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const propsIn = feature.properties || {};
    const mapImageId = normalizeMapImageId(propsIn.iconId || "");
    const hasIcon = !!(mapImageId && isRenderedMapImageId(mapImageId));
    const ready = !!(hasIcon && map && map.hasImage(mapImageId));
    // Always keep a team-color circle until the icon bitmap is installed.
    const props = Object.assign({}, propsIn, {
      kind: "marker",
      iconId: hasIcon ? mapImageId : "",
      showCircle: ready ? 0 : 1,
      color: propsIn.color || propsIn.teamColor || "#2196F3",
    });
    return {
      type: "Feature",
      id: FEATURE_ID,
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: props,
    };
  }

  function applyPayloadToSource(payload) {
    if (!map || typeof map.isStyleLoaded !== "function" || !map.isStyleLoaded()) {
      return false;
    }
    const source = map.getSource(SOURCE_ID);
    if (!source) return false;

    if (!payload || !payload.found || !payload.feature) {
      hasLiveMarker = false;
      lockedCenter = null;
      lastAppliedSignature = "empty";
      source.setData(emptyFeatureCollection());
      setEmptyVisible(true);
      return true;
    }

    hasLiveMarker = true;
    setEmptyVisible(false);
    const mapped = markerFeatureForMap(payload.feature);
    if (!mapped) {
      source.setData(emptyFeatureCollection());
      setEmptyVisible(true);
      return true;
    }

    const sig = payloadSignature(payload) + "|" + mapped.properties.showCircle;
    const canPatch =
      typeof source.updateData === "function" &&
      lastAppliedSignature &&
      lastAppliedSignature !== "empty" &&
      String(lastAppliedSignature).split("|")[0] === String(mapped.properties.uid || "");

    if (canPatch) {
      try {
        source.updateData({
          update: [
            {
              id: FEATURE_ID,
              newGeometry: mapped.geometry,
              addOrUpdateProperties: [
                { key: "uid", value: mapped.properties.uid },
                { key: "callsign", value: mapped.properties.callsign },
                { key: "color", value: mapped.properties.color },
                { key: "iconId", value: mapped.properties.iconId },
                { key: "showCircle", value: mapped.properties.showCircle },
                { key: "apiIconId", value: mapped.properties.apiIconId || "" },
              ],
            },
          ],
        });
      } catch (_) {
        source.setData({ type: "FeatureCollection", features: [mapped] });
      }
    } else {
      source.setData({ type: "FeatureCollection", features: [mapped] });
    }
    lastAppliedSignature = sig;

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

  function flipShowCircleOff(mapImageId) {
    if (!map || !map.isStyleLoaded()) return;
    const source = map.getSource(SOURCE_ID);
    if (!source || typeof source.updateData !== "function") return;
    const id = normalizeMapImageId(mapImageId);
    if (!id || !map.hasImage(id)) return;
    try {
      source.updateData({
        update: [
          {
            id: FEATURE_ID,
            addOrUpdateProperties: [
              { key: "iconId", value: id },
              { key: "showCircle", value: 0 },
            ],
          },
        ],
      });
    } catch (_) {}
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
    const manifest = (lastMarkerPayload && lastMarkerPayload.iconManifest) || [];
    return loadIconManifest(manifest).then(function () {
      // Re-apply so showCircle flips once the bitmap is present.
      applyPayloadToSource(lastMarkerPayload);
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
      if (document.querySelector('link[data-tak-maplibre-css="1"]')) {
        resolve();
        return;
      }
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.setAttribute("data-tak-maplibre-css", "1");
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
      if (window.maplibregl) {
        resolve();
        return;
      }
      if (document.querySelector('script[data-tak-maplibre-js="1"]')) {
        const existing = document.querySelector('script[data-tak-maplibre-js="1"]');
        existing.addEventListener("load", function () {
          resolve();
        });
        existing.addEventListener("error", function () {
          reject(new Error("Failed to load script"));
        });
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.setAttribute("data-tak-maplibre-js", "1");
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
    assetsPromise = loadStylesheet(maplibreCssUrl())
      .then(function () {
        return loadScript(maplibreJsUrl());
      })
      .then(function () {
        if (!window.maplibregl) {
          throw new Error("MapLibre failed to load");
        }
      })
      .catch(function (err) {
        assetsPromise = null;
        throw err;
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
    if (!map || !source || !map.isStyleLoaded()) return Promise.resolve(false);
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

    const needed = [];
    const seen = new Set();
    for (let i = 0; i < list.length; i++) {
      const entry = list[i] || {};
      const mapImageId = normalizeMapImageId(entry.mapImageId || "");
      if (!mapImageId || !isRenderedMapImageId(mapImageId) || seen.has(mapImageId)) continue;
      seen.add(mapImageId);
      if (map.hasImage(mapImageId) || iconLoadPending.has(mapImageId)) continue;
      needed.push(
        Object.assign({}, entry, {
          mapImageId: mapImageId,
          apiIconId: entry.apiIconId || "",
        })
      );
    }
    if (!needed.length) {
      for (const id of seen) flipShowCircleOff(id);
      return Promise.resolve();
    }

    const batchKey = needed
      .map(function (e) {
        return e.mapImageId;
      })
      .join(",");
    if (iconLoadPending.has(batchKey)) return iconLoadPending.get(batchKey);

    const promise = fetch("/api/map/icons/rendered/batch", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ icons: needed }),
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
          const canonicalId = normalizeMapImageId(mapImageId);
          jobs.push(
            decodeIconBlob(base64ToBlob(b64, "image/png")).then(function (img) {
              return installMapImage(canonicalId, img).then(function (ok) {
                if (ok) flipShowCircleOff(canonicalId);
                return ok;
              });
            })
          );
        }
        return Promise.all(jobs);
      })
      .catch(function (err) {
        console.warn("[dashboardMiniMap] icon preload failed", err);
      })
      .finally(function () {
        iconLoadPending.delete(batchKey);
      });

    iconLoadPending.set(batchKey, promise);
    return promise;
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
      // Show team-color dot whenever showCircle is truthy (default for EUDs).
      filter: [
        "any",
        ["==", ["get", "showCircle"], 1],
        ["==", ["get", "showCircle"], true],
        ["!", ["has", "showCircle"]],
      ],
      paint: {
        "circle-radius": 10,
        "circle-color": ["coalesce", ["get", "color"], "#2196F3"],
        "circle-stroke-width": 1.5,
        "circle-stroke-color": "#ffffff",
        "circle-opacity": 1,
      },
    });

    map.addLayer({
      id: ICON_LAYER,
      type: "symbol",
      source: SOURCE_ID,
      // Show icon whenever we have an image id; circle stays until showCircle flips to 0.
      filter: ["!=", ["get", "iconId"], ""],
      layout: {
        "icon-image": ["get", "iconId"],
        "icon-size": 0.88,
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "icon-optional": true,
      },
      paint: {
        "icon-opacity": ["case", ["==", ["get", "showCircle"], 0], 1, 0.001],
        "icon-halo-color": "#ffffff",
        "icon-halo-width": 4,
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

  function fetchLiveMarker(clientId, callsign, username) {
    const params = new URLSearchParams();
    if (callsign) params.set("callsign", callsign);
    if (username) params.set("username", username);
    const q =
      "/api/tak/clients/" +
      encodeURIComponent(clientId) +
      "/live-marker?" +
      params.toString();
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
    if (!currentClientId || (!currentCallsign && !currentUsername)) {
      return Promise.resolve({ found: false });
    }
    const tryNum = attempt != null ? attempt : 0;
    return fetchLiveMarker(currentClientId, currentCallsign, currentUsername)
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
    if (!currentClientId || (!currentCallsign && !currentUsername) || !map) {
      return Promise.resolve();
    }
    return fetchLiveMarker(currentClientId, currentCallsign, currentUsername)
      .then(function (payload) {
        const nextSig = payloadSignature(payload);
        // lastAppliedSignature appends showCircle; compare the payload core only.
        const prevCore = String(lastAppliedSignature || "").replace(/\|[01]$/, "");
        if (nextSig !== "empty" && prevCore === nextSig) {
          return null;
        }
        if (payload && payload.found) lastMarkerPayload = payload;
        return updateMarkerOnMap(payload);
      })
      .catch(function () {
        if (!hasLiveMarker) setEmptyVisible(true);
      });
  }

  function open(clientId, callsign, username) {
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
    currentUsername = username || null;
    centerLocked = true;
    hasLiveMarker = false;
    lockedCenter = null;
    lastMarkerPayload = null;
    lastAppliedSignature = "";
    recenterOnIdleScheduled = false;
    applyCenterLockMode();

    if (!currentClientId || (!currentCallsign && !currentUsername)) {
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
        bindContainerResizeObserver();
        return init({ center: center, zoom: zoom }).then(function () {
          return updateMarkerOnMap(payload);
        });
      })
      .then(function () {
        revealMap();
        scheduleMarkerSync();
        scheduleRecenterIfLocked();
        startPolling(clientId, callsign, username);
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

  function loadMarker(clientId, callsign, username) {
    return open(clientId, callsign, username);
  }

  function startPolling(clientId, callsign, username) {
    if (clientId) currentClientId = clientId;
    if (callsign) currentCallsign = callsign;
    if (username) currentUsername = username;
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
    currentUsername = null;
    iconLoadPending.clear();
    hasLiveMarker = false;
    centerLocked = true;
    lockedCenter = null;
    recenterOnIdleScheduled = false;
    lastMarkerPayload = null;
    lastAppliedSignature = "";
    unbindContainerResizeObserver();
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
