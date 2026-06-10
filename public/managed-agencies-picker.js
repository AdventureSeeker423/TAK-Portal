(function (global) {
  "use strict";

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/"/g, "&quot;");
  }

  function formatAgencyLabel(a) {
    const name = String(a?.name || a?.suffix || "Agency").trim();
    const abbr = String(a?.groupPrefix || a?.suffix || "").trim();
    return abbr ? name + " (" + abbr + ")" : name;
  }

  function formatSummaryLabel(a) {
    const abbr = String(a?.groupPrefix || a?.suffix || "").trim().toUpperCase();
    if (abbr) return abbr;
    return String(a?.name || "").trim();
  }

  function normalizeSuffixValue(raw) {
    return String(raw || "").trim().toLowerCase();
  }

  function resolveHomeSuffix(opts) {
    if (typeof opts.homeSuffix === "function") return normalizeSuffixValue(opts.homeSuffix());
    return normalizeSuffixValue(opts.homeSuffix);
  }

  function mergeWithHome(additional, homeSuffix) {
    const home = normalizeSuffixValue(homeSuffix);
    const out = [];
    const seen = new Set();
    function push(sfx) {
      const norm = normalizeSuffixValue(sfx);
      if (!norm || seen.has(norm)) return;
      seen.add(norm);
      out.push(norm);
    }
    if (home) push(home);
    (Array.isArray(additional) ? additional : []).forEach(push);
    return out.sort();
  }

  function stripHomeFromManaged(allSuffixes, homeSuffix) {
    const home = normalizeSuffixValue(homeSuffix);
    return (Array.isArray(allSuffixes) ? allSuffixes : [])
      .map(normalizeSuffixValue)
      .filter(Boolean)
      .filter((s) => !home || s !== home);
  }

  function findAgencyBySuffix(agencies, suffix) {
    const needle = normalizeSuffixValue(suffix);
    if (!needle) return null;
    return (Array.isArray(agencies) ? agencies : []).find(
      (a) => normalizeSuffixValue(a?.suffix) === needle
    );
  }

  /**
   * Floating menu positioning — keeps dropdown out of scrollable modal overflow.
   */
  const MA_MENU_MAX_HEIGHT = 280;
  const MA_MENU_Z_INDEX = 1200;

  function clearFloatingMenu(dropdownEl) {
    if (!dropdownEl) return;
    const menuEl = dropdownEl.querySelector(".filter-menu");
    if (menuEl) {
      menuEl.classList.remove("ma-menu-floating");
      menuEl.style.position = "";
      menuEl.style.left = "";
      menuEl.style.top = "";
      menuEl.style.bottom = "";
      menuEl.style.width = "";
      menuEl.style.maxHeight = "";
      menuEl.style.right = "";
      menuEl.style.zIndex = "";
    }
    const handler = dropdownEl.__maFloatHandler;
    if (handler) {
      window.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
      dropdownEl.__maFloatHandler = null;
    }
  }

  function positionFloatingMenu(dropdownEl) {
    const menuEl = dropdownEl && dropdownEl.querySelector(".filter-menu");
    const toggleEl =
      dropdownEl &&
      dropdownEl.querySelector(".ma-multiselect-toggle, .filter-toggle");
    if (!menuEl || !toggleEl) return;

    const rect = toggleEl.getBoundingClientRect();
    const gap = 4;
    const minWidth = 280;
    const width = Math.max(rect.width, minWidth);
    const spaceBelow = window.innerHeight - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    const openUp = spaceBelow < 180 && spaceAbove > spaceBelow;
    const maxHeight = Math.min(
      MA_MENU_MAX_HEIGHT,
      Math.max(120, openUp ? spaceAbove : spaceBelow)
    );

    let left = rect.left;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));

    menuEl.classList.add("ma-menu-floating");
    menuEl.style.position = "fixed";
    menuEl.style.left = left + "px";
    menuEl.style.width = width + "px";
    menuEl.style.maxHeight = maxHeight + "px";
    menuEl.style.zIndex = String(MA_MENU_Z_INDEX);
    menuEl.style.right = "auto";

    if (openUp) {
      menuEl.style.top = "auto";
      menuEl.style.bottom = window.innerHeight - rect.top + gap + "px";
    } else {
      menuEl.style.top = rect.bottom + gap + "px";
      menuEl.style.bottom = "auto";
    }
  }

  function bindFloatingMenuListeners(dropdownEl) {
    clearFloatingMenu(dropdownEl);
    const handler = function () {
      if (dropdownEl.classList.contains("open")) positionFloatingMenu(dropdownEl);
    };
    dropdownEl.__maFloatHandler = handler;
    window.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
  }

  function closeAllMaMultiselects(except) {
    document.querySelectorAll(".ma-multiselect.open").forEach(function (el) {
      if (except && el === except) return;
      el.classList.remove("open");
      clearFloatingMenu(el);
    });
  }
  function bindManagedAgenciesPicker(root, opts) {
    opts = opts || {};
    const dropdown = root.querySelector(".ma-multiselect");
    const toggle = root.querySelector(".ma-multiselect-toggle");
    const search = root.querySelector(".ma-multiselect-search");
    const list = root.querySelector(".ma-multiselect-list");
    const selectAll = root.querySelector(".ma-multiselect-select-all");
    const clearBtn = root.querySelector(".ma-multiselect-clear");
    const summary = root.querySelector(".ma-multiselect-summary");
    const inputName = opts.inputName || "managedAgencySuffix";

    let agencies = [];
    let selected = new Set();

    function sortedAgencies() {
      const source = typeof opts.getAgencies === "function" ? opts.getAgencies() : agencies;
      const home = resolveHomeSuffix(opts);
      return (Array.isArray(source) ? source : [])
        .filter((a) => {
          const sfx = normalizeSuffixValue(a?.suffix);
          return !home || sfx !== home;
        })
        .slice()
        .sort((a, b) => String(a?.name || "").localeCompare(String(b?.name || "")));
    }

    function allAgenciesForLookup() {
      if (typeof opts.getAllAgencies === "function") return opts.getAllAgencies();
      const source = typeof opts.getAgencies === "function" ? opts.getAgencies() : agencies;
      return Array.isArray(source) ? source.slice() : [];
    }

    function updateToggleLabel() {
      if (!toggle) return;
      const n = selected.size;
      toggle.textContent = n
        ? n + " agenc" + (n === 1 ? "y" : "ies") + " selected ▾"
        : "Select agencies ▾";
    }

    function updateSummary() {
      if (!summary) return;
      const home = resolveHomeSuffix(opts);
      const labels = sortedAgencies()
        .filter((a) => selected.has(normalizeSuffixValue(a?.suffix)))
        .map(formatSummaryLabel)
        .filter(Boolean);
      const parts = [];
      if (home) {
        const homeAgency = findAgencyBySuffix(allAgenciesForLookup(), home);
        const homeLabel = homeAgency ? formatSummaryLabel(homeAgency) : home.toUpperCase();
        parts.push("Includes home agency " + homeLabel);
      }
      if (labels.length) {
        parts.push(home ? "Additional: " + labels.join(", ") : "Selected: " + labels.join(", "));
      } else if (home) {
        parts.push("No additional agencies selected.");
      }
      summary.textContent = parts.length ? parts.join(" · ") : "No agencies selected.";
    }

    function renderList() {
      if (!list) return;
      const needle = String(search?.value || "").trim().toLowerCase();
      const visible = sortedAgencies().filter((a) => {
        if (!needle) return true;
        const name = String(a?.name || "").toLowerCase();
        const sfx = String(a?.suffix || "").toLowerCase();
        const abbr = String(a?.groupPrefix || "").toLowerCase();
        return name.includes(needle) || sfx.includes(needle) || abbr.includes(needle);
      });

      list.innerHTML =
        visible
          .map((a) => {
            const sfx = String(a?.suffix || "").trim().toLowerCase();
            const checked = selected.has(sfx) ? " checked" : "";
            return (
              '<label class="filter-option">' +
              '<input type="checkbox" class="ma-multiselect-cb" name="' +
              esc(inputName) +
              '" value="' +
              esc(sfx) +
              '"' +
              checked +
              " />" +
              "<span>" +
              esc(formatAgencyLabel(a)) +
              "</span>" +
              "</label>"
            );
          })
          .join("") || '<div class="muted" style="padding:8px 10px;">No agencies found.</div>';

      updateToggleLabel();
      updateSummary();
    }

    function notifyChange() {
      if (typeof opts.onChange === "function") opts.onChange(selected);
    }

    function setSelected(next, setOpts) {
      setOpts = setOpts || {};
      const home = resolveHomeSuffix(opts);
      selected = new Set(
        (next instanceof Set ? Array.from(next) : Array.isArray(next) ? next : [])
          .map(normalizeSuffixValue)
          .filter(Boolean)
          .filter((s) => !home || s !== home)
      );
      renderList();
      if (!setOpts.silent) notifyChange();
    }

    function getSelectedArray() {
      return Array.from(selected).filter(Boolean).sort();
    }

    function getSelectedWithHomeArray() {
      return mergeWithHome(getSelectedArray(), resolveHomeSuffix(opts));
    }

    if (toggle && dropdown) {
      const menu = dropdown.querySelector(".filter-menu");
      if (menu) menu.addEventListener("click", function (e) { e.stopPropagation(); });

      toggle.addEventListener("click", function (e) {
        e.stopPropagation();
        const willOpen = !dropdown.classList.contains("open");
        closeAllMaMultiselects();
        if (willOpen) {
          dropdown.classList.add("open");
          positionFloatingMenu(dropdown);
          bindFloatingMenuListeners(dropdown);
        }
      });
    }

    if (search) search.addEventListener("input", renderList);

    if (list) {
      list.addEventListener("change", function (e) {
        const cb = e.target;
        if (!cb || cb.type !== "checkbox" || !cb.classList.contains("ma-multiselect-cb")) return;
        const sfx = String(cb.value || "").trim().toLowerCase();
        if (!sfx) return;
        if (cb.checked) selected.add(sfx);
        else selected.delete(sfx);
        updateToggleLabel();
        updateSummary();
        notifyChange();
      });
    }

    if (selectAll) {
      selectAll.addEventListener("click", function () {
        const needle = String(search?.value || "").trim().toLowerCase();
        sortedAgencies().forEach(function (a) {
          const name = String(a?.name || "").toLowerCase();
          const sfx = String(a?.suffix || "").trim().toLowerCase();
          const abbr = String(a?.groupPrefix || "").toLowerCase();
          if (!needle || name.includes(needle) || sfx.includes(needle) || abbr.includes(needle)) {
            if (sfx) selected.add(sfx);
          }
        });
        renderList();
        notifyChange();
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        selected.clear();
        renderList();
        notifyChange();
      });
    }

    return {
      setAgencies: function (arr) {
        agencies = Array.isArray(arr) ? arr : [];
        renderList();
      },
      setSelected: setSelected,
      getSelected: function () { return new Set(selected); },
      getSelectedArray: getSelectedArray,
      getSelectedWithHomeArray: getSelectedWithHomeArray,
      refresh: renderList,
    };
  }

  if (!global.__maMultiselectDocClick) {
    global.__maMultiselectDocClick = true;
    document.addEventListener("click", function () {
      closeAllMaMultiselects();
    });
  }

  global.ManagedAgenciesPicker = {
    bind: bindManagedAgenciesPicker,
    mergeWithHome: mergeWithHome,
    stripHomeFromManaged: stripHomeFromManaged,
  };
})(window);
