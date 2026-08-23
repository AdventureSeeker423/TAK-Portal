/**
 * Interactive geofence drawing + config on the live map.
 * Details open in the right detail stack (same pattern as marker panes).
 */
(function () {
  "use strict";

  const SOURCE_ID = "portal-geofences";
  const FILL_LAYER = "portal-geofences-fill";
  const LINE_LAYER = "portal-geofences-line";
  const LABEL_LAYER = "portal-geofences-label";
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
    const name = String(fence.name || "").trim();
    return {
      type: "Feature",
      id: fence.id,
      properties: {
        id: fence.id,
        name: name,
        hasName: name.length > 0,
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
    if (!map.getLayer(LABEL_LAYER)) {
      const labelFont =
        bridge && typeof bridge.getLabelFont === "function"
          ? bridge.getLabelFont()
          : ["Open Sans Semibold"];
      const labelSpec = {
        id: LABEL_LAYER,
        type: "symbol",
        source: SOURCE_ID,
        filter: [">", ["length", ["to-string", ["get", "name"]]], 0],
        layout: {
          "text-field": ["get", "name"],
          "text-font": labelFont,
          "text-size": 13,
          "text-anchor": "center",
          "text-allow-overlap": false,
          "text-ignore-placement": false,
          "symbol-placement": "point",
        },
        paint: {
          "text-color": [
            "case",
            ["boolean", ["get", "selected"], false],
            "#fde68a",
            ["boolean", ["get", "active"], false],
            "#ecfeff",
            "#e2e8f0",
          ],
          "text-halo-color": "rgba(7, 11, 16, 0.85)",
          "text-halo-width": 1.5,
        },
      };
      if (before && map.getLayer(before)) map.addLayer(labelSpec, before);
      else map.addLayer(labelSpec);
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
    else     if (mode === "polygon") setStatus("Click vertices. Click start point, Finish, or double-click to close.");
    else setStatus("");
    const finishBtn = document.getElementById("mapGeofenceFinishPoly");
    if (finishBtn) finishBtn.hidden = mode !== "polygon";
    if (bridge && typeof bridge.closeStackPicker === "function") {
      bridge.closeStackPicker();
    }
  }

  function isDrawing() {
    return !!drawMode;
  }

  function beginCreate() {
    setDrawBarVisible(true);
    setDrawMode(null);
    setStatus("Choose a shape to draw.");
  }

  function cancelCreate() {
    setDrawMode(null);
    setDrawBarVisible(false);
    setStatus("");
    const morePanel = document.getElementById("mapHudMore");
    const moreBtn = document.getElementById("mapHudMoreBtn");
    if (morePanel) morePanel.classList.remove("is-open");
    if (moreBtn) moreBtn.setAttribute("aria-expanded", "false");
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
    const enforceEl = detailPaneEl.querySelector("#mapGeofenceEnforceMode");
    const name = nameEl ? String(nameEl.value || "").trim() : fence.name;
    const active = activeEl
      ? activeEl.getAttribute("aria-pressed") === "true"
      : fence.active;
    const enforceMode = enforceEl
      ? String(enforceEl.value || "one-time").trim()
      : fence.enforceMode || "one-time";

    const channels = [];
    detailPaneEl.querySelectorAll("[data-gf-channel]").forEach(function (row) {
      const groupName = row.getAttribute("data-gf-channel");
      const enterSel = row.querySelector("[data-gf-enter-action]");
      const exitSel = row.querySelector("[data-gf-exit-action]");
      const enterAction = enterSel ? String(enterSel.value || "").trim() : "";
      const exitAction = exitSel ? String(exitSel.value || "").trim() : "";
      if (!groupName) return;
      channels.push({
        groupName: groupName,
        accessMode: "BOTH",
        enterAction: enterAction,
        exitAction: exitAction,
      });
    });

    const missions = [];
    detailPaneEl.querySelectorAll("[data-gf-mission]").forEach(function (row) {
      const missionName = row.getAttribute("data-gf-mission");
      if (missionName) missions.push({ missionName: missionName });
    });

    try {
      const data = await api("/api/map/geofences/" + encodeURIComponent(fence.id), {
        method: "PATCH",
        body: JSON.stringify({
          name: name,
          active: active,
          enforceMode: enforceMode,
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
      const enabled = fence.active ? "enabled" : "disabled";
      const mode = fence.enforceMode === "force" ? " · force" : "";
      meta.textContent = type + " · " + enabled + mode;
      meta.hidden = !type;
    }
  }

  function channelPhaseAction(sel, phase) {
    if (!sel) return "";
    if (phase === "enter") {
      if (sel.enterAction === "enable" || sel.enterAction === "disable") return sel.enterAction;
      if (sel.onEnter === true) return "enable";
      return "";
    }
    if (sel.exitAction === "enable" || sel.exitAction === "disable") return sel.exitAction;
    if (sel.onExit === true) return "disable";
    return "";
  }

  function phaseActionSelectHtml(attr, current, shortLabel) {
    const cur = current || "";
    return (
      '<label class="map-geofence-action-field">' +
      '<span class="map-geofence-action-field-label">' +
      escapeHtml(shortLabel || "") +
      "</span>" +
      '<select class="map-geofence-action-select" ' +
      attr +
      ">" +
      '<option value=""' +
      (cur === "" ? " selected" : "") +
      ">None</option>" +
      '<option value="enable"' +
      (cur === "enable" ? " selected" : "") +
      ">Enable</option>" +
      '<option value="disable"' +
      (cur === "disable" ? " selected" : "") +
      ">Disable</option>" +
      "</select>" +
      "</label>"
    );
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

  function channelCatalogDisplay(name) {
    const want = String(name || "").toLowerCase();
    const hit = (actionOptions.channels || []).find(function (c) {
      return String(c.name || "").toLowerCase() === want;
    });
    return (hit && (hit.displayName || hit.name)) || name;
  }

  function patchFenceActionsLocal(nextChannels, nextMissions) {
    const fence = getSelected();
    if (!fence) return;
    fence.actions = {
      channels: Array.isArray(nextChannels) ? nextChannels : fence.actions.channels || [],
      missions: Array.isArray(nextMissions) ? nextMissions : fence.actions.missions || [],
    };
    const idx = fences.findIndex(function (f) {
      return f.id === fence.id;
    });
    if (idx >= 0) fences[idx] = fence;
  }

  function collectChannelActionsFromDom() {
    const channels = [];
    if (!detailPaneEl) return channels;
    detailPaneEl.querySelectorAll("[data-gf-channel]").forEach(function (row) {
      const groupName = row.getAttribute("data-gf-channel");
      const enterSel = row.querySelector("[data-gf-enter-action]");
      const exitSel = row.querySelector("[data-gf-exit-action]");
      const enterAction = enterSel ? String(enterSel.value || "").trim() : "";
      const exitAction = exitSel ? String(exitSel.value || "").trim() : "";
      if (!groupName) return;
      channels.push({
        groupName: groupName,
        accessMode: "BOTH",
        enterAction: enterAction,
        exitAction: exitAction,
      });
    });
    return channels;
  }

  function collectMissionActionsFromDom() {
    const missions = [];
    if (!detailPaneEl) return missions;
    detailPaneEl.querySelectorAll("[data-gf-mission]").forEach(function (row) {
      const missionName = row.getAttribute("data-gf-mission");
      if (missionName) missions.push({ missionName: missionName });
    });
    return missions;
  }

  function bindPicker(sectionEl, kind) {
    if (!sectionEl) return;
    const searchEl = sectionEl.querySelector("[data-gf-picker-search]");
    const resultsEl = sectionEl.querySelector("[data-gf-picker-results]");
    if (!searchEl || !resultsEl) return;

    function hideResults() {
      resultsEl.hidden = true;
      resultsEl.innerHTML = "";
    }

    function renderResults(q) {
      const query = String(q || "").trim().toLowerCase();
      const fence = getSelected();
      if (!fence) return hideResults();

      let items = [];
      if (kind === "channel") {
        const taken = channelSelectedMap(fence);
        items = (actionOptions.channels || [])
          .filter(function (c) {
            if (taken.has(String(c.name).toLowerCase())) return false;
            if (!query) return true;
            const label = String(c.displayName || c.name || "").toLowerCase();
            return label.indexOf(query) >= 0 || String(c.name).toLowerCase().indexOf(query) >= 0;
          })
          .slice(0, 40)
          .map(function (c) {
            return {
              value: c.name,
              label: c.displayName || c.name,
            };
          });
      } else {
        const taken = missionSelectedSet(fence);
        items = (actionOptions.missions || [])
          .filter(function (m) {
            if (taken.has(String(m.name).toLowerCase())) return false;
            if (!query) return true;
            return String(m.name || "").toLowerCase().indexOf(query) >= 0;
          })
          .slice(0, 40)
          .map(function (m) {
            return { value: m.name, label: m.name };
          });
      }

      if (!items.length) {
        resultsEl.innerHTML =
          '<div class="map-geofence-picker-empty">No matches</div>';
        resultsEl.hidden = false;
        return;
      }

      resultsEl.innerHTML = items
        .map(function (it) {
          return (
            '<button type="button" class="map-geofence-picker-item" data-gf-pick="' +
            escapeAttr(it.value) +
            '">' +
            escapeHtml(it.label) +
            "</button>"
          );
        })
        .join("");
      resultsEl.hidden = false;
    }

    searchEl.addEventListener("focus", function () {
      renderResults(searchEl.value);
    });
    searchEl.addEventListener("input", function () {
      renderResults(searchEl.value);
    });
    searchEl.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        hideResults();
        searchEl.blur();
      }
    });

    resultsEl.addEventListener("mousedown", function (e) {
      const btn = e.target.closest("[data-gf-pick]");
      if (!btn) return;
      e.preventDefault();
      const value = btn.getAttribute("data-gf-pick");
      if (!value) return;
      const fence = getSelected();
      if (!fence) return;

      if (kind === "channel") {
        const channels = (fence.actions && fence.actions.channels ? fence.actions.channels.slice() : []);
        channels.push({
          groupName: value,
          accessMode: "BOTH",
          enterAction: "",
          exitAction: "",
        });
        patchFenceActionsLocal(channels, fence.actions.missions || []);
      } else {
        const missions = (fence.actions && fence.actions.missions ? fence.actions.missions.slice() : []);
        missions.push({ missionName: value });
        patchFenceActionsLocal(fence.actions.channels || [], missions);
      }
      scheduleSave();
      renderInspector();
    });
  }

  function ensurePickerOutsideClose() {
    if (ensurePickerOutsideClose.bound) return;
    ensurePickerOutsideClose.bound = true;
    document.addEventListener(
      "mousedown",
      function (e) {
        if (!detailPaneEl) return;
        detailPaneEl.querySelectorAll(".map-geofence-picker").forEach(function (picker) {
          if (picker.contains(e.target)) return;
          const resultsEl = picker.querySelector("[data-gf-picker-results]");
          if (resultsEl) {
            resultsEl.hidden = true;
            resultsEl.innerHTML = "";
          }
        });
      },
      true
    );
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

    const addedChannels = (fence.actions && fence.actions.channels) || [];
    const addedMissions = (fence.actions && fence.actions.missions) || [];

    let channelRows = "";
    if (!addedChannels.length) {
      channelRows = '<p class="map-geofence-hint">No channels added yet.</p>';
    } else {
      channelRows =
        '<div class="map-geofence-action-list">' +
        addedChannels
          .map(function (ch) {
            const enterAct = channelPhaseAction(ch, "enter");
            const exitAct = channelPhaseAction(ch, "exit");
            const label = channelCatalogDisplay(ch.groupName);
            return (
              '<div class="map-geofence-action-row" data-gf-channel="' +
              escapeAttr(ch.groupName) +
              '">' +
              '<div class="map-geofence-action-row-top">' +
              '<span class="map-geofence-action-label" title="' +
              escapeAttr(label) +
              '">' +
              escapeHtml(label) +
              "</span>" +
              '<button type="button" class="map-geofence-remove-btn" data-gf-remove-channel title="Remove channel" aria-label="Remove channel">×</button>' +
              "</div>" +
              '<div class="map-geofence-action-row-acts">' +
              phaseActionSelectHtml("data-gf-enter-action", enterAct, "On enter") +
              phaseActionSelectHtml("data-gf-exit-action", exitAct, "On exit") +
              "</div>" +
              "</div>"
            );
          })
          .join("") +
        "</div>";
    }

    let missionRows = "";
    if (!addedMissions.length) {
      missionRows = '<p class="map-geofence-hint">No Data Sync missions added yet.</p>';
    } else {
      missionRows =
        '<div class="map-geofence-action-list">' +
        addedMissions
          .map(function (m) {
            const name = m.missionName || m.name;
            return (
              '<div class="map-geofence-mission-row" data-gf-mission="' +
              escapeAttr(name) +
              '">' +
              '<span class="map-geofence-action-label" title="' +
              escapeAttr(name) +
              '">' +
              escapeHtml(name) +
              "</span>" +
              '<span class="map-geofence-mission-meta">Invite on enter</span>' +
              '<button type="button" class="map-geofence-remove-btn" data-gf-remove-mission title="Remove mission" aria-label="Remove mission">×</button>' +
              "</div>"
            );
          })
          .join("") +
        "</div>";
    }

    const channelPicker =
      '<div class="map-geofence-picker" data-gf-channel-picker>' +
      '<input type="search" class="map-geofence-picker-search" data-gf-picker-search placeholder="Search channels to add…" autocomplete="off" />' +
      '<div class="map-geofence-picker-results" data-gf-picker-results hidden></div>' +
      "</div>";

    const missionPicker =
      '<div class="map-geofence-picker" data-gf-mission-picker>' +
      '<input type="search" class="map-geofence-picker-search" data-gf-picker-search placeholder="Search missions to add…" autocomplete="off" />' +
      '<div class="map-geofence-picker-results" data-gf-picker-results hidden></div>' +
      "</div>";

    const enforceMode = fence.enforceMode === "force" ? "force" : "one-time";
    const enabledOn = fence.active === true;

    body.innerHTML =
      '<div class="map-geofence-inspector">' +
      '<div class="map-geofence-inspector-fields">' +
      '<label class="map-geofence-field">Name (optional)' +
      '<input id="mapGeofenceName" type="text" maxlength="120" value="' +
      escapeAttr(fence.name || "") +
      '" />' +
      "</label>" +
      '<div class="map-geofence-control-row">' +
      '<div class="map-geofence-enabled-control">' +
      '<button type="button" id="mapGeofenceActive" class="map-mission-toggle ' +
      (enabledOn ? "is-on" : "is-off") +
      '" aria-pressed="' +
      (enabledOn ? "true" : "false") +
      '" title="' +
      (enabledOn ? "Enabled" : "Disabled") +
      '"></button>' +
      '<span id="mapGeofenceActiveLabel">' +
      (enabledOn ? "Enabled" : "Disabled") +
      "</span>" +
      "</div>" +
      '<label class="map-geofence-field map-geofence-enforce-field">Enforce' +
      '<select id="mapGeofenceEnforceMode" class="map-geofence-action-select">' +
      '<option value="one-time"' +
      (enforceMode === "one-time" ? " selected" : "") +
      ">One-time</option>" +
      '<option value="force"' +
      (enforceMode === "force" ? " selected" : "") +
      ">Force</option>" +
      "</select>" +
      "</label>" +
      "</div>" +
      "</div>" +
      '<div class="map-geofence-section map-geofence-section-scroll">' +
      "<h3>Channels</h3>" +
      channelPicker +
      channelRows +
      "</div>" +
      '<div class="map-geofence-section map-geofence-section-scroll">' +
      "<h3>Data Sync Missions</h3>" +
      missionPicker +
      missionRows +
      "</div>" +
      '<div class="map-geofence-inspector-actions">' +
      '<button type="button" class="map-btn map-btn-danger" id="mapGeofenceDelete">Delete</button>' +
      "</div>" +
      "</div>";

    const nameEl = body.querySelector("#mapGeofenceName");
    const activeEl = body.querySelector("#mapGeofenceActive");
    const activeLabel = body.querySelector("#mapGeofenceActiveLabel");
    const enforceEl = body.querySelector("#mapGeofenceEnforceMode");
    if (nameEl) nameEl.addEventListener("input", scheduleSave);
    if (activeEl) {
      activeEl.addEventListener("click", function () {
        const next = activeEl.getAttribute("aria-pressed") !== "true";
        activeEl.setAttribute("aria-pressed", next ? "true" : "false");
        activeEl.classList.toggle("is-on", next);
        activeEl.classList.toggle("is-off", !next);
        activeEl.title = next ? "Enabled" : "Disabled";
        if (activeLabel) activeLabel.textContent = next ? "Enabled" : "Disabled";
        scheduleSave();
      });
    }
    if (enforceEl) enforceEl.addEventListener("change", scheduleSave);
    body.querySelectorAll("select").forEach(function (el) {
      if (el.id === "mapGeofenceEnforceMode") return;
      el.addEventListener("change", function () {
        patchFenceActionsLocal(collectChannelActionsFromDom(), collectMissionActionsFromDom());
        scheduleSave();
      });
    });
    body.querySelectorAll("[data-gf-remove-channel]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const row = btn.closest("[data-gf-channel]");
        const name = row && row.getAttribute("data-gf-channel");
        if (!name) return;
        const channels = ((getSelected() && getSelected().actions.channels) || []).filter(
          function (c) {
            return String(c.groupName || "").toLowerCase() !== String(name).toLowerCase();
          }
        );
        patchFenceActionsLocal(channels, (getSelected() && getSelected().actions.missions) || []);
        scheduleSave();
        renderInspector();
      });
    });
    body.querySelectorAll("[data-gf-remove-mission]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const row = btn.closest("[data-gf-mission]");
        const name = row && row.getAttribute("data-gf-mission");
        if (!name) return;
        const missions = ((getSelected() && getSelected().actions.missions) || []).filter(
          function (m) {
            return String(m.missionName || m.name || "").toLowerCase() !== String(name).toLowerCase();
          }
        );
        patchFenceActionsLocal((getSelected() && getSelected().actions.channels) || [], missions);
        scheduleSave();
        renderInspector();
      });
    });
    bindPicker(body.querySelector("[data-gf-channel-picker]"), "channel");
    bindPicker(body.querySelector("[data-gf-mission-picker]"), "mission");
    ensurePickerOutsideClose();
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
      const title = detailPaneEl.querySelector("#mapGeofenceDetailTitle");
      if (title) title.textContent = "Geofence";
      const meta = detailPaneEl.querySelector("#mapGeofenceDetailMeta");
      if (meta) {
        meta.textContent = "";
        meta.hidden = true;
      }
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
    if (!drawMode) {
      const bar = document.getElementById("mapGeofenceDrawBar");
      const morePanel = document.getElementById("mapHudMore");
      const menuOpen = morePanel && morePanel.classList.contains("is-open");
      const barVisible = bar && !bar.hidden;
      if (menuOpen || barVisible) cancelCreate();
    }
    if (drawMode) {
      if (e.originalEvent) e.originalEvent.stopPropagation();
      if (bridge && typeof bridge.suppressBackgroundClick === "function") {
        bridge.suppressBackgroundClick();
      }
      if (bridge && typeof bridge.closeStackPicker === "function") {
        bridge.closeStackPicker();
      }
      const ll = eventLngLat(e);
      if (!ll) return;

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
        const verts = drawState.vertices;
        // Clicking near the first vertex closes the ring once we have 3+ points.
        if (verts.length >= 3 && isNearFirstVertex(e.point, verts[0])) {
          finishPolygon();
          return;
        }
        verts.push(ll);
        setPreviewGeometry({ type: "polygon", coordinates: verts.slice() });
        setStatus(
          verts.length < 3
            ? "Need " + (3 - verts.length) + " more point(s)."
            : "Click more points, or click the start point / Finish / double-click to close."
        );
      }
      return;
    }

    if (!map.getLayer(FILL_LAYER)) return;
    // Markers sit above geofences visually; never steal their clicks.
    if (bridge && typeof bridge.queryMarkersAtPoint === "function") {
      const markers = bridge.queryMarkersAtPoint(e.point);
      if (markers && markers.length) return;
    }
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

  /** Screen-space snap to first vertex (pixels). */
  function isNearFirstVertex(point, firstLonLat) {
    if (!map || !point || !firstLonLat) return false;
    const start = map.project(firstLonLat);
    const dx = point.x - start.x;
    const dy = point.y - start.y;
    return dx * dx + dy * dy <= 14 * 14;
  }

  function onKeyDown(e) {
    if (!e || e.key !== "Escape") return;
    const bar = document.getElementById("mapGeofenceDrawBar");
    const drawing = !!drawMode || (bar && !bar.hidden);
    if (!drawing) return;
    e.preventDefault();
    cancelCreate();
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
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", function (ev) {
      const bar = document.getElementById("mapGeofenceDrawBar");
      const morePanel = document.getElementById("mapHudMore");
      const moreBtn = document.getElementById("mapHudMoreBtn");
      const wrap = document.querySelector(".map-geofence-create-wrap");
      const menuOpen = morePanel && morePanel.classList.contains("is-open");
      const barVisible = bar && !bar.hidden;
      if (!menuOpen && !barVisible) return;
      if (moreBtn && moreBtn.contains(ev.target)) return;
      if (wrap && wrap.contains(ev.target)) return;
      if (morePanel && morePanel.contains(ev.target)) return;
      if (drawMode) return;
      cancelCreate();
    });
    const moreBtn = document.getElementById("mapHudMoreBtn");
    if (moreBtn) {
      moreBtn.addEventListener("click", function () {
        const morePanel = document.getElementById("mapHudMore");
        const closed = !morePanel || !morePanel.classList.contains("is-open");
        if (closed && !drawMode) cancelCreate();
      });
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
    isDrawing: isDrawing,
    getHitLayers: function () {
      const layers = [];
      if (map && map.getLayer(FILL_LAYER)) layers.push(FILL_LAYER);
      if (map && map.getLayer(LINE_LAYER)) layers.push(LINE_LAYER);
      return layers;
    },
  };
})();
