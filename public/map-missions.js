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
    };
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
    openMissions.forEach(function (entry, name) {
      open.push(name);
      settings[name] = {
        visible: !!entry.visible,
        hiddenUids: Array.from(entry.hiddenUids || []),
        hiddenPaths: Array.from(entry.hiddenPaths || []),
        showAttachments: !!entry.showAttachments,
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
      return ["literal", true];
    }
    return ["!", ["in", ["get", "id"], ["literal", Array.from(hiddenUids)]]];
  }

  function applyMissionLayerVisibility(name) {
    if (!map) return;
    const entry = openMissions.get(name);
    if (!entry) return;
    const ids = missionLayerIds(name);
    const vis = entry.visible ? "visible" : "none";
    const hiddenFilter = hiddenUidFilter(entry.hiddenUids);
    const baseFilter = ["all", MISSION_FILTER, hiddenFilter];

    for (const layerId of [ids.fill, ids.line, ids.symbol]) {
      if (!map.getLayer(layerId)) continue;
      map.setLayoutProperty(layerId, "visibility", vis);
      map.setFilter(layerId, baseFilter);
    }
  }

  function ensureMissionLayers(name, geojson) {
    const srcId = missionSourceId(name);
    const ids = missionLayerIds(name);
    const data = geojson || { type: "FeatureCollection", features: [] };

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
          filter: ["all", MISSION_FILTER, ["==", ["get", "geometryType"], "polygon"]],
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
            MISSION_FILTER,
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
            MISSION_FILTER,
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
        bridge.getMissionBeforeLayerId()
      );
    }

    if (!map.getLayer(ids.symbol + "-dot")) {
      map.addLayer(
        {
          id: ids.symbol + "-dot",
          type: "circle",
          source: srcId,
          filter: [
            "all",
            MISSION_FILTER,
            ["==", ["get", "geometryType"], "point"],
            ["==", ["get", "iconId"], ""],
          ],
          paint: {
            "circle-radius": 6,
            "circle-color": ["coalesce", ["get", "color"], "#22d3ee"],
            "circle-stroke-width": 1.5,
            "circle-stroke-color": "#ffffff",
          },
        },
        bridge.getMissionBeforeLayerId()
      );
    }

    applyMissionLayerVisibility(name);
  }

  function removeMissionLayers(name) {
    if (!map) return;
    const srcId = missionSourceId(name);
    const ids = missionLayerIds(name);
    const allIds = [ids.fill, ids.line, ids.symbol, ids.symbol + "-dot"];
    for (const layerId of allIds) {
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
      (opts.refresh ? "1" : "0");
    if (opts.attachments) url += "&attachments=1";
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
        showAttachments: false,
        loading: false,
        error: null,
      };
      openMissions.set(name, entry);
    }

    entry.loading = true;
    renderMissionList();
    try {
      if (opts.attachments != null) entry.showAttachments = !!opts.attachments;
      const [geojson, layers] = await Promise.all([
        fetchMissionGeojson(name, {
          refresh: !!opts.refresh,
          attachments: entry.showAttachments,
        }),
        fetchMissionLayers(name).catch(function () {
          return { folders: [], orphaned: [] };
        }),
      ]);
      entry.geojson = geojson;
      entry.layers = layers;
      entry.error = null;
      ensureMissionLayers(name, geojson);
      if (bridge && geojson.meta && geojson.meta.iconManifest) {
        bridge.preloadMarkerIcons(geojson.meta.iconManifest);
      }
    } catch (err) {
      entry.error = err?.message || String(err);
    } finally {
      entry.loading = false;
      writeState();
      renderMissionList();
    }
  }

  function closeMission(name) {
    openMissions.delete(name);
    removeMissionLayers(name);
    writeState();
    renderMissionList();
  }

  function toggleMissionVisible(name) {
    const entry = openMissions.get(name);
    if (!entry) return;
    entry.visible = !entry.visible;
    applyMissionLayerVisibility(name);
    writeState();
    renderMissionList();
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
      layers.push(ids.fill, ids.line, ids.symbol, ids.symbol + "-dot");
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
      const isOpen = !!entry;
      const row = document.createElement("div");
      row.className = "map-mission-row" + (isOpen ? " is-open" : "");

      const head = document.createElement("div");
      head.className = "map-mission-row-head";

      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "map-mission-open-btn";
      openBtn.textContent = isOpen ? "−" : "+";
      openBtn.title = isOpen ? "Close mission" : "Open mission";
      openBtn.addEventListener("click", function () {
        if (isOpen) closeMission(name);
        else loadMission(name);
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

      const visBtn = document.createElement("button");
      visBtn.type = "button";
      visBtn.className = "map-mission-vis-btn";
      visBtn.textContent = entry && entry.visible ? "👁" : "👁‍🗨";
      visBtn.title = "Show/hide overlay";
      visBtn.disabled = !isOpen;
      visBtn.addEventListener("click", function () {
        toggleMissionVisible(name);
      });

      const refreshBtn = document.createElement("button");
      refreshBtn.type = "button";
      refreshBtn.className = "map-mission-refresh-btn";
      refreshBtn.textContent = "↻";
      refreshBtn.title = "Refresh mission";
      refreshBtn.disabled = !isOpen || (entry && entry.loading);
      refreshBtn.addEventListener("click", function () {
        loadMission(name, { refresh: true, attachments: entry?.showAttachments });
      });

      head.appendChild(openBtn);
      head.appendChild(title);
      head.appendChild(visBtn);
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

      if (entry && isOpen) {
        const actions = document.createElement("div");
        actions.className = "map-mission-actions";
        const attachLabel = document.createElement("label");
        attachLabel.className = "map-mission-attach-toggle";
        const attachCb = document.createElement("input");
        attachCb.type = "checkbox";
        attachCb.checked = !!entry.showAttachments;
        attachCb.addEventListener("change", function () {
          loadMission(name, { refresh: true, attachments: attachCb.checked });
        });
        attachLabel.appendChild(attachCb);
        attachLabel.appendChild(document.createTextNode(" KML attachments"));
        const adminLink = document.createElement("a");
        adminLink.href = "/data-sync";
        adminLink.className = "map-mission-admin-link";
        adminLink.textContent = "Open in Data Sync";
        actions.appendChild(attachLabel);
        actions.appendChild(adminLink);
        row.appendChild(actions);

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
          const hint = document.createElement("div");
          hint.className = "map-mission-hint";
          hint.textContent = count + " feature(s)";
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
      const entry = {
        visible: settings.visible !== false,
        geojson: null,
        layers: null,
        hiddenUids: new Set(settings.hiddenUids || []),
        hiddenPaths: new Set(settings.hiddenPaths || []),
        showAttachments: !!settings.showAttachments,
        loading: false,
        error: null,
      };
      openMissions.set(name, entry);
      loadMission(name, { attachments: entry.showAttachments });
    }
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
      if (panelChannels) panelChannels.hidden = missions;
      if (panelMissions) panelMissions.hidden = !missions;
      if (missions && !missionsCatalog.length) refreshMissionCatalog();
    }

    if (tabChannels) tabChannels.addEventListener("click", function () { setTab("channels"); });
    if (tabMissions) tabMissions.addEventListener("click", function () { setTab("missions"); });

    map.on("click", onMapClick);
    refreshMissionCatalog().then(restoreOpenMissions);
  }

  window.TakMapMissions = { init: init };
})();
