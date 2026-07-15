/**
 * Interactive geofence drawing + config on the live map.
 * Details open in the right detail stack (same pattern as marker panes).
 */
(function () {
  "use strict";

  const SOURCE_ID = "portal-geofences";
  const FILL_LAYER = "portal-geofences-fill";
  const LINE_LAYER = "portal-geofences-line";
  const PREVIEW_SOURCE = "portal-geofences-preview";
  const PREVIEW_FILL = "portal-geofences-preview-fill";
  const PREVIEW_LINE = "portal-geofences-preview-line";
  const PANE_ID = "mapGeofenceDetailPane";
  const EARTH_RADIUS_M = 6371008.8;

  const CLOSE_ICON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M18 6 6 18"></path>' +
    '<path d="m6 6 12 12"></path>' +
    "</svg>";

  let bridge = null;
  let map = null;
  let fences = [];
  let selectedId = null;
  let drawMode = null;
  let drawState = null;
  let actionOptions = { channels: [], missions: [] };
  let saveTimer = null;
  let optionsLoaded = false;
  let detailPaneEl = null;

  function emptyFc() {
    return { type: "FeatureCollection", features: [] };
  }

  function haversineMeters(lon1, lat1, lon2, lat2) {
    const rLat1 = (lat1 * Math.PI) / 180;
    const rLat2 = (lat2 * Math.PI) / 180;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function offsetLonLat(lon, lat, bearingDeg, distanceM) {
    const br = (bearingDeg * Math.PI) / 180;
    const lat1 = (lat * Math.PI) / 180;
    const lon1 = (lon * Math.PI) / 180;
    const ang = distanceM / EARTH_RADIUS_M;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(ang) + Math.cos(lat1) * Math.sin(ang) * Math.cos(br)
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(br) * Math.sin(ang) * Math.cos(lat1),
        Math.cos(ang) - Math.sin(lat1) * Math.sin(lat2)
      );
    return [(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI];
  }

  function circleRing(centerLon, centerLat, radiusMeters, steps) {
    const n = steps || 64;
    const ring = [];
    for (let i = 0; i <= n; i++) {
      ring.push(offsetLonLat(centerLon, centerLat, (360 * i) / n, radiusMeters));
    }
    return ring;
  }

  function geometryToPolygon(geometry) {
    if (!geometry) return null;
    const type = String(geometry.type || "").toLowerCase();
    if (type === "circle") {
      const c = geometry.center;
      const r = Number(geometry.radiusMeters);
      if (!c || !Number.isFinite(r) || r <= 0) return null;
      return [circleRing(c[0], c[1], r)];
    }
    if (type === "rectangle") {
      const sw = geometry.sw;
      const ne = geometry.ne;
      if (!sw || !ne) return null;
      const minLon = Math.min(sw[0], ne[0]);
      const maxLon = Math.max(sw[0], ne[0]);
      const minLat = Math.min(sw[1], ne[1]);
      const maxLat = Math.max(sw[1], ne[1]);
      return [
        [
          [minLon, minLat],
          [maxLon, minLat],
          [maxLon, maxLat],
          [minLon, maxLat],
          [minLon, minLat],
        ],
      ];
    }
    if (type === "polygon") {
      const coords = geometry.coordinates || [];
      if (coords.length < 3) return null;
      const ring = coords.map(function (c) {
        return [c[0], c[1]];
      });
      const f = ring[0];
      const l = ring[ring.length - 1];
      if (f[0] !== l[0] || f[1] !== l[1]) ring.push([f[0], f[1]]);
      return [ring];
    }
    return null;
  }

  function fenceFeature(fence, selected) {
    const coords = geometryToPolygon(fence.geometry);
    if (!coords) return null;
    return {
      type: "Feature",
      id: fence.id,
      properties: {
        id: fence.id,
        name: fence.name || "Unnamed",
        active: fence.active === true,
        selected: selected === true,
      },
      geometry: { type: "Polygon", coordinates: coords },
    };
  }

  function buildCollection() {
    const features = [];
    for (let i = 0; i < fences.length; i++) {
      const f = fenceFeature(fences[i], fences[i].id === selectedId);
      if (f) features.push(f);
    }
    return { type: "FeatureCollection", features: features };
  }

  function beforeLayerId() {
    if (bridge && typeof bridge.getMissionBeforeLayerId === "function") {
      return bridge.getMissionBeforeLayerId();
    }
    return undefined;
  }

  function ensureLayers() {
    if (!map) return;
    if (!map.getSource(SOURCE_ID)) {
      map.addSource(SOURCE_ID, { type: "geojson", data: buildCollection(), promoteId: "id" });
    }
    if (!map.getSource(PREVIEW_SOURCE)) {
      map.addSource(PREVIEW_SOURCE, { type: "geojson", data: emptyFc() });
    }
    const before = beforeLayerId();
    if (!map.getLayer(FILL_LAYER)) {
      const fillSpec = {
        id: FILL_LAYER,
        type: "fill",
        source: SOURCE_ID,
        paint: {
          "fill-color": [
            "case",
            ["boolean", ["get", "selected"], false],
            "#f59e0b",
            ["boolean", ["get", "active"], false],
            "#22d3ee",
            "#64748b",
          ],
          "fill-opacity": 0.22,
        },
      };
      if (before) map.addLayer(fillSpec, before);
      else map.addLayer(fillSpec);
    }
    if (!map.getLayer(LINE_LAYER)) {
      const lineSpec = {
        id: LINE_LAYER,
        type: "line",
        source: SOURCE_ID,
        paint: {
          "line-color": [
            "case",
            ["boolean", ["get", "selected"], false],
            "#fbbf24",
            ["boolean", ["get", "active"], false],
            "#67e8f9",
            "#94a3b8",
          ],
          "line-width": ["case", ["boolean", ["get", "selected"], false], 3, 2],
        },
      };
      if (before && map.getLayer(before)) map.addLayer(lineSpec, before);
      else map.addLayer(lineSpec);
    }
    if (!map.getLayer(PREVIEW_FILL)) {
      map.addLayer({
        id: PREVIEW_FILL,
        type: "fill",
        source: PREVIEW_SOURCE,
        paint: { "fill-color": "#a78bfa", "fill-opacity": 0.18 },
      });
    }
    if (!map.getLayer(PREVIEW_LINE)) {
      map.addLayer({
        id: PREVIEW_LINE,
        type: "line",
        source: PREVIEW_SOURCE,
        paint: {
          "line-color": "#c4b5fd",
          "line-width": 2,
          "line-dasharray": [2, 1],
        },
      });
    }
  }

  function syncSource() {
    if (!map || !map.getSource(SOURCE_ID)) return;
    map.getSource(SOURCE_ID).setData(buildCollection());
  }

  function setPreviewGeometry(geometry) {
    if (!map || !map.getSource(PREVIEW_SOURCE)) return;
    const coords = geometryToPolygon(geometry);
    if (!coords) {
      map.getSource(PREVIEW_SOURCE).setData(emptyFc());
      return;
    }
    map.getSource(PREVIEW_SOURCE).setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "Polygon", coordinates: coords },
        },
      ],
    });
  }

  function clearPreview() {
    setPreviewGeometry(null);
  }

  function setStatus(msg) {
    const statusEl = document.getElementById("mapGeofenceStatus");
    if (statusEl) statusEl.textContent = msg || "";
  }

  function getSelected() {
    if (!selectedId) return null;
    return (
      fences.find(function (f) {
        return f.id === selectedId;
      }) || null
    );
  }

  function isDetailOpen() {
    return !!(selectedId && detailPaneEl && !detailPaneEl.hidden);
  }

  function notifyAuxDetail() {
    if (bridge && typeof bridge.setAuxDetailActive === "function") {
      bridge.setAuxDetailActive(isDetailOpen());
    }
  }

  async function api(path, options) {
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      ...(options || {}),
    });
    const data = await res.json().catch(function () {
      return {};
    });
    if (!res.ok) {
      const err = new Error(data.error || res.statusText || "Request failed");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function loadFences() {
    const data = await api("/api/map/geofences");
    fences = Array.isArray(data.fences) ? data.fences : [];
    if (selectedId && !fences.some(function (f) { return f.id === selectedId; })) {
      deselect({ keepDraw: true });
    } else {
      syncSource();
      renderInspector();
    }
  }

  async function loadActionOptions() {
    try {
      const data = await api("/api/map/geofences/action-options");
      actionOptions = {
        channels: Array.isArray(data.channels) ? data.channels : [],
        missions: Array.isArray(data.missions) ? data.missions : [],
      };
      optionsLoaded = true;
    } catch (err) {
      console.warn("[map-geofences] action-options failed:", err.message || err);
      actionOptions = { channels: [], missions: [] };
    }
    renderInspector();
  }

  function setDrawBarVisible(visible) {
    const bar = document.getElementById("mapGeofenceDrawBar");
    const createBtn = document.getElementById("mapGeofenceCreateBtn");
    if (bar) bar.hidden = !visible;
    if (createBtn) createBtn.classList.toggle("is-active", !!visible);
  }

  function setDrawMode(mode) {
    drawMode = mode;
    drawState = null;
    clearPreview();
    const buttons = document.querySelectorAll("[data-geofence-draw]");
    buttons.forEach(function (btn) {
      btn.classList.toggle("is-active", btn.getAttribute("data-geofence-draw") === mode);
    });
    if (map) {
      map.getCanvas().style.cursor = mode ? "crosshair" : "";
      if (map.doubleClickZoom) {
        if (mode === "polygon") map.doubleClickZoom.disable();
        else map.doubleClickZoom.enable();
      }
    }
    if (mode === "circle") setStatus("Click center, then click to set radius.");
    else if (mode === "rectangle") setStatus("Click first corner, then opposite corner.");
    else if (mode === "polygon") setStatus("Click vertices. Double-click or Finish to close.");
    else setStatus("");
    const finishBtn = document.getElementById("mapGeofenceFinishPoly");
    if (finishBtn) finishBtn.hidden = mode !== "polygon";
  }

  function beginCreate() {
    setDrawBarVisible(true);
    setDrawMode("circle");
  }

  function cancelCreate() {
    setDrawMode(null);
    setDrawBarVisible(false);
    setStatus("");
  }

  async function createFenceFromGeometry(geometry) {
    try {
      const data = await api("/api/map/geofences", {
        method: "POST",
        body: JSON.stringify({
          name: "",
          active: true,
          geometry: geometry,
          actions: { channels: [], missions: [] },
        }),
      });
      const fence = data.fence;
      fences.push(fence);
      cancelCreate();
      selectFence(fence.id);
      setStatus("");
    } catch (err) {
      setStatus(err.message || "Failed to create geofence");
    }
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      persistSelected();
    }, 400);
  }

  async function persistSelected() {
    const fence = getSelected();
    if (!fence || !detailPaneEl) return;
    const nameEl = detailPaneEl.querySelector("#mapGeofenceName");
    const activeEl = detailPaneEl.querySelector("#mapGeofenceActive");
    const name = nameEl ? String(nameEl.value || "").trim() : fence.name;
    const active = activeEl ? !!activeEl.checked : fence.active;

    const channels = [];
    detailPaneEl.querySelectorAll("[data-gf-channel]").forEach(function (row) {
      const groupName = row.getAttribute("data-gf-channel");
      const onEnter = row.querySelector("[data-gf-enter]");
      const onExit = row.querySelector("[data-gf-exit]");
      const enter = onEnter && onEnter.checked;
      const exit = onExit && onExit.checked;
      if (!enter && !exit) return;
      channels.push({
        groupName: groupName,
        accessMode: "BOTH",
        onEnter: !!enter,
        onExit: !!exit,
      });
    });

    const missions = [];
    detailPaneEl.querySelectorAll("[data-gf-mission]").forEach(function (row) {
      const missionName = row.getAttribute("data-gf-mission");
      const onEnter = row.querySelector("[data-gf-mission-enter]");
      if (onEnter && onEnter.checked) {
        missions.push({ missionName: missionName });
      }
    });

    try {
      const data = await api("/api/map/geofences/" + encodeURIComponent(fence.id), {
        method: "PATCH",
        body: JSON.stringify({
          name: name,
          active: active,
          actions: { channels: channels, missions: missions },
        }),
      });
      const idx = fences.findIndex(function (f) {
        return f.id === fence.id;
      });
      if (idx >= 0) fences[idx] = data.fence;
      syncSource();
      syncPaneTitle(data.fence);
    } catch (err) {
      setStatus(err.message || "Save failed");
    }
  }

  async function deleteSelected() {
    const fence = getSelected();
    if (!fence) return;
    if (!window.confirm('Delete geofence "' + (fence.name || "Unnamed") + '"?')) return;
    try {
      await api("/api/map/geofences/" + encodeURIComponent(fence.id), { method: "DELETE" });
      fences = fences.filter(function (f) {
        return f.id !== fence.id;
      });
      deselect();
      syncSource();
    } catch (err) {
      setStatus(err.message || "Delete failed");
    }
  }

  function ensureDetailPane() {
    const stack = document.getElementById("mapDetailStack");
    if (!stack) return null;
    let pane = document.getElementById(PANE_ID);
    if (pane) {
      detailPaneEl = pane;
      return pane;
    }
    pane = document.createElement("aside");
    pane.id = PANE_ID;
    pane.className = "map-detail-pane map-geofence-detail-pane";
    pane.setAttribute("aria-label", "Geofence details");
    pane.hidden = true;
    pane.innerHTML =
      '<div class="map-panel-head">' +
      '<div class="map-detail-title-wrap">' +
      '<h2 class="map-detail-title" id="mapGeofenceDetailTitle">Geofence</h2>' +
      '<div class="map-detail-platform" id="mapGeofenceDetailMeta"></div>' +
      "</div>" +
      '<button type="button" class="map-detail-close-btn" id="mapGeofenceDetailClose" title="Close details" aria-label="Close details">' +
      CLOSE_ICON +
      "</button>" +
      "</div>" +
      '<div class="map-detail-body" id="mapGeofenceDetailBody"></div>';
    stack.appendChild(pane);
    const closeBtn = pane.querySelector("#mapGeofenceDetailClose");
    if (closeBtn) {
      closeBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        deselect();
      });
    }
    detailPaneEl = pane;
    return pane;
  }

  function syncPaneTitle(fence) {
    if (!detailPaneEl || !fence) return;
    const title = detailPaneEl.querySelector("#mapGeofenceDetailTitle");
    const meta = detailPaneEl.querySelector("#mapGeofenceDetailMeta");
    if (title) title.textContent = fence.name || "Unnamed geofence";
    if (meta) {
      const type = fence.geometry && fence.geometry.type ? fence.geometry.type : "";
      meta.textContent = type + (fence.active ? " · active" : " · inactive");
      meta.hidden = !type;
    }
  }

  function channelSelectedMap(fence) {
    const mapObj = new Map();
    const list = (fence && fence.actions && fence.actions.channels) || [];
    list.forEach(function (c) {
      mapObj.set(String(c.groupName || "").toLowerCase(), c);
    });
    return mapObj;
  }

  function missionSelectedSet(fence) {
    const set = new Set();
    const list = (fence && fence.actions && fence.actions.missions) || [];
    list.forEach(function (m) {
      set.add(String(m.missionName || m.name || "").toLowerCase());
    });
    return set;
  }

  function renderInspector() {
    const pane = ensureDetailPane();
    if (!pane) return;
    const body = pane.querySelector("#mapGeofenceDetailBody");
    const fence = getSelected();
    if (!fence) {
      pane.hidden = true;
      if (body) body.innerHTML = "";
      notifyAuxDetail();
      return;
    }
    pane.hidden = false;
    syncPaneTitle(fence);
    notifyAuxDetail();
    if (!body) return;

    const chMap = channelSelectedMap(fence);
    const mSet = missionSelectedSet(fence);

    let channelsHtml = "";
    if (!actionOptions.channels.length) {
      channelsHtml = '<p class="map-geofence-hint">No channels available.</p>';
    } else {
      channelsHtml =
        '<div class="map-geofence-action-list">' +
        actionOptions.channels
          .map(function (ch) {
            const sel = chMap.get(String(ch.name).toLowerCase());
            const enter = sel ? sel.onEnter === true : false;
            const exit = sel ? sel.onExit === true : false;
            const label = ch.displayName || ch.name;
            return (
              '<div class="map-geofence-action-row" data-gf-channel="' +
              escapeAttr(ch.name) +
              '">' +
              '<span class="map-geofence-action-label" title="' +
              escapeAttr(ch.name) +
              '">' +
              escapeHtml(label) +
              "</span>" +
              '<label class="map-geofence-check"><input type="checkbox" data-gf-enter' +
              (enter ? " checked" : "") +
              " /> Enter</label>" +
              '<label class="map-geofence-check"><input type="checkbox" data-gf-exit' +
              (exit ? " checked" : "") +
              " /> Exit</label>" +
              "</div>"
            );
          })
          .join("") +
        "</div>";
    }

    let missionsHtml = "";
    if (!actionOptions.missions.length) {
      missionsHtml = '<p class="map-geofence-hint">No Data Sync missions available.</p>';
    } else {
      missionsHtml =
        '<div class="map-geofence-action-list">' +
        actionOptions.missions
          .map(function (m) {
            const on = mSet.has(String(m.name).toLowerCase());
            return (
              '<div class="map-geofence-action-row" data-gf-mission="' +
              escapeAttr(m.name) +
              '">' +
              '<span class="map-geofence-action-label" title="' +
              escapeAttr(m.name) +
              '">' +
              escapeHtml(m.name) +
              "</span>" +
              '<label class="map-geofence-check"><input type="checkbox" data-gf-mission-enter' +
              (on ? " checked" : "") +
              " /> Enter</label>" +
              "</div>"
            );
          })
          .join("") +
        "</div>";
    }

    body.innerHTML =
      '<div class="map-geofence-inspector">' +
      '<div class="map-geofence-inspector-fields">' +
      '<label class="map-geofence-field">Name (optional)' +
      '<input id="mapGeofenceName" type="text" maxlength="120" value="' +
      escapeAttr(fence.name || "") +
      '" />' +
      "</label>" +
      '<label class="map-geofence-field map-geofence-field-inline">' +
      '<input id="mapGeofenceActive" type="checkbox"' +
      (fence.active ? " checked" : "") +
      " /> Active" +
      "</label>" +
      "</div>" +
      '<div class="map-geofence-section">' +
      "<h3>Channels</h3>" +
      '<p class="map-geofence-hint">Enable on enter / disable on exit. Skipped if the EUD is not entitled.</p>' +
      channelsHtml +
      "</div>" +
      '<div class="map-geofence-section">' +
      "<h3>Data Sync missions</h3>" +
      '<p class="map-geofence-hint">Invite on enter only. Data Sync cannot be revoked remotely.</p>' +
      missionsHtml +
      "</div>" +
      '<div class="map-geofence-inspector-actions">' +
      '<button type="button" class="map-btn map-btn-danger" id="mapGeofenceDelete">Delete</button>' +
      "</div>" +
      "</div>";

    const nameEl = body.querySelector("#mapGeofenceName");
    const activeEl = body.querySelector("#mapGeofenceActive");
    if (nameEl) nameEl.addEventListener("input", scheduleSave);
    if (activeEl) activeEl.addEventListener("change", scheduleSave);
    body.querySelectorAll("input[type=checkbox]").forEach(function (cb) {
      cb.addEventListener("change", scheduleSave);
    });
    const del = body.querySelector("#mapGeofenceDelete");
    if (del) del.addEventListener("click", deleteSelected);
  }

  function selectFence(id) {
    if (!id) {
      deselect();
      return;
    }
    selectedId = id;
    if (bridge && typeof bridge.deselectMarkersForAux === "function") {
      bridge.deselectMarkersForAux();
    }
    if (bridge && typeof bridge.suppressBackgroundClick === "function") {
      bridge.suppressBackgroundClick();
    }
    syncSource();
    if (!optionsLoaded) {
      loadActionOptions().then(function () {
        renderInspector();
      });
    } else {
      renderInspector();
    }
  }

  function deselect(opts) {
    const keepDraw = opts && opts.keepDraw;
    selectedId = null;
    syncSource();
    if (detailPaneEl) {
      detailPaneEl.hidden = true;
      const body = detailPaneEl.querySelector("#mapGeofenceDetailBody");
      if (body) body.innerHTML = "";
    }
    notifyAuxDetail();
    if (!keepDraw && drawMode) {
      // leave draw alone only when explicitly requested
    }
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, "&#39;");
  }

  function eventLngLat(e) {
    if (!e || !e.lngLat) return null;
    return [e.lngLat.lng, e.lngLat.lat];
  }

  function onMapClick(e) {
    if (drawMode) {
      const ll = eventLngLat(e);
      if (!ll) return;
      if (bridge && typeof bridge.suppressBackgroundClick === "function") {
        bridge.suppressBackgroundClick();
      }

      if (drawMode === "circle") {
        if (!drawState) {
          drawState = { center: ll };
          setStatus("Click to set radius.");
          return;
        }
        const radius = haversineMeters(drawState.center[0], drawState.center[1], ll[0], ll[1]);
        if (!(radius > 1)) {
          setStatus("Radius too small — click farther from center.");
          return;
        }
        const geometry = {
          type: "circle",
          center: drawState.center,
          radiusMeters: Math.round(radius * 10) / 10,
        };
        drawState = null;
        clearPreview();
        createFenceFromGeometry(geometry);
        return;
      }

      if (drawMode === "rectangle") {
        if (!drawState) {
          drawState = { a: ll };
          setStatus("Click opposite corner.");
          return;
        }
        const geometry = {
          type: "rectangle",
          sw: [Math.min(drawState.a[0], ll[0]), Math.min(drawState.a[1], ll[1])],
          ne: [Math.max(drawState.a[0], ll[0]), Math.max(drawState.a[1], ll[1])],
        };
        drawState = null;
        clearPreview();
        createFenceFromGeometry(geometry);
        return;
      }

      if (drawMode === "polygon") {
        if (!drawState) drawState = { vertices: [] };
        drawState.vertices.push(ll);
        setPreviewGeometry({ type: "polygon", coordinates: drawState.vertices.slice() });
        setStatus(
          drawState.vertices.length < 3
            ? "Need " + (3 - drawState.vertices.length) + " more point(s)."
            : "Click more points, or Finish / double-click to close."
        );
      }
      return;
    }

    if (!map.getLayer(FILL_LAYER)) return;
    const feats = map.queryRenderedFeatures(e.point, { layers: [FILL_LAYER, LINE_LAYER] });
    if (feats && feats.length) {
      const id = feats[0].properties && feats[0].properties.id;
      if (id) {
        if (e.originalEvent) e.originalEvent.stopPropagation();
        selectFence(id);
      }
    }
  }

  function onMapDblClick(e) {
    if (drawMode !== "polygon" || !drawState || !drawState.vertices) return;
    e.preventDefault();
    finishPolygon();
  }

  function finishPolygon() {
    if (!drawState || !drawState.vertices || drawState.vertices.length < 3) {
      setStatus("Polygon needs at least 3 points.");
      return;
    }
    const geometry = {
      type: "polygon",
      coordinates: drawState.vertices.slice(),
    };
    drawState = null;
    clearPreview();
    createFenceFromGeometry(geometry);
  }

  function onMapMove(e) {
    if (!drawMode || !drawState) return;
    const ll = eventLngLat(e);
    if (!ll) return;
    if (drawMode === "circle" && drawState.center) {
      const radius = haversineMeters(drawState.center[0], drawState.center[1], ll[0], ll[1]);
      if (radius > 0) {
        setPreviewGeometry({
          type: "circle",
          center: drawState.center,
          radiusMeters: radius,
        });
      }
    } else if (drawMode === "rectangle" && drawState.a) {
      setPreviewGeometry({
        type: "rectangle",
        sw: [Math.min(drawState.a[0], ll[0]), Math.min(drawState.a[1], ll[1])],
        ne: [Math.max(drawState.a[0], ll[0]), Math.max(drawState.a[1], ll[1])],
      });
    } else if (drawMode === "polygon" && drawState.vertices && drawState.vertices.length) {
      setPreviewGeometry({
        type: "polygon",
        coordinates: drawState.vertices.concat([ll]),
      });
    }
  }

  function restoreAfterStyleChange() {
    ensureLayers();
    syncSource();
  }

  function bindUi() {
    const createBtn = document.getElementById("mapGeofenceCreateBtn");
    if (createBtn) {
      createBtn.addEventListener("click", function () {
        const bar = document.getElementById("mapGeofenceDrawBar");
        if (bar && !bar.hidden) {
          cancelCreate();
        } else {
          beginCreate();
        }
      });
    }
    document.querySelectorAll("[data-geofence-draw]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const mode = btn.getAttribute("data-geofence-draw");
        setDrawMode(mode);
      });
    });
    const finishBtn = document.getElementById("mapGeofenceFinishPoly");
    if (finishBtn) {
      finishBtn.addEventListener("click", finishPolygon);
      finishBtn.hidden = true;
    }
    const cancelBtn = document.getElementById("mapGeofenceCancelDraw");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", cancelCreate);
    }
  }

  function init(b) {
    bridge = b;
    map = bridge.getMap();
    if (!map) return;
    ensureLayers();
    ensureDetailPane();
    bindUi();
    map.on("click", onMapClick);
    map.on("dblclick", onMapDblClick);
    map.on("mousemove", onMapMove);
    loadFences().catch(function (err) {
      console.warn("[map-geofences] load failed:", err.message || err);
    });
    loadActionOptions().catch(function () {});
  }

  window.TakMapGeofences = {
    init: init,
    restoreAfterStyleChange: restoreAfterStyleChange,
    deselect: deselect,
    isDetailOpen: isDetailOpen,
    getHitLayers: function () {
      const layers = [];
      if (map && map.getLayer(FILL_LAYER)) layers.push(FILL_LAYER);
      if (map && map.getLayer(LINE_LAYER)) layers.push(LINE_LAYER);
      return layers;
    },
  };
})();
