(function (global) {
  "use strict";

  /** @type {Set<() => void>} */
  const openClosers = new Set();

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
    const abbr = String(a?.groupPrefix || a?.suffix || "").trim();
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

  function closeAllOpenMenus() {
    Array.from(openClosers).forEach(function (close) {
      try {
        close();
      } catch (_) {
        /* ignore */
      }
    });
  }

  /**
   * Compact checkbox dropdown for managed-agency selection.
   * Menu is portaled to document.body while open so modal overflow:hidden cannot clip it.
   * @param {HTMLElement} root - element containing .ma-multiselect
   */
  function bindManagedAgenciesPicker(root, opts) {
    opts = opts || {};
    const dropdown = root.querySelector(".ma-multiselect");
    const toggle = root.querySelector(".ma-multiselect-toggle");
    const search = root.querySelector(".ma-multiselect-search");
    const list = root.querySelector(".ma-multiselect-list");
    const selectAll = root.querySelector(".ma-multiselect-select-all");
    const clearBtn = root.querySelector(".ma-multiselect-clear");
    const summary = root.querySelector(".ma-multiselect-summary");
    const menu = dropdown ? dropdown.querySelector(".filter-menu") : null;
    const inputName = opts.inputName || "managedAgencySuffix";

    let agencies = [];
    let selected = new Set();
    let menuHomeParent = null;
    let menuHomeNext = null;
    let positionRaf = 0;
    let isOpen = false;

    function clearMenuPositionStyles() {
      if (!menu) return;
      menu.style.position = "";
      menu.style.top = "";
      menu.style.left = "";
      menu.style.right = "";
      menu.style.bottom = "";
      menu.style.width = "";
      menu.style.minWidth = "";
      menu.style.maxHeight = "";
      menu.style.zIndex = "";
    }

    function restoreMenuHome() {
      if (!menu || !menuHomeParent) return;
      if (menuHomeNext && menuHomeNext.parentNode === menuHomeParent) {
        menuHomeParent.insertBefore(menu, menuHomeNext);
      } else {
        menuHomeParent.appendChild(menu);
      }
      menuHomeParent = null;
      menuHomeNext = null;
      clearMenuPositionStyles();
    }

    function positionMenu() {
      if (!menu || !toggle || !isOpen) return;
      const rect = toggle.getBoundingClientRect();
      const gap = 4;
      const viewportPad = 8;
      const minWidth = Math.max(rect.width, 280);
      const maxWidth = Math.min(minWidth, window.innerWidth - viewportPad * 2);
      const spaceBelow = window.innerHeight - rect.bottom - gap - viewportPad;
      const spaceAbove = rect.top - gap - viewportPad;
      const preferUp = spaceBelow < 220 && spaceAbove > spaceBelow;
      const available = Math.max(120, preferUp ? spaceAbove : spaceBelow);
      let left = rect.left;
      if (left + maxWidth > window.innerWidth - viewportPad) {
        left = Math.max(viewportPad, window.innerWidth - viewportPad - maxWidth);
      }
      if (left < viewportPad) left = viewportPad;

      menu.style.position = "fixed";
      menu.style.zIndex = "50000";
      menu.style.left = left + "px";
      menu.style.width = maxWidth + "px";
      menu.style.minWidth = maxWidth + "px";
      menu.style.right = "auto";
      menu.style.maxHeight = Math.min(280, available) + "px";
      if (preferUp) {
        menu.style.top = "auto";
        menu.style.bottom = window.innerHeight - rect.top + gap + "px";
      } else {
        menu.style.bottom = "auto";
        menu.style.top = rect.bottom + gap + "px";
      }
    }

    function schedulePositionMenu() {
      if (positionRaf) cancelAnimationFrame(positionRaf);
      positionRaf = requestAnimationFrame(function () {
        positionRaf = 0;
        positionMenu();
      });
    }

    function closeMenu() {
      if (!isOpen) return;
      isOpen = false;
      openClosers.delete(closeMenu);
      if (dropdown) dropdown.classList.remove("open");
      if (menu) menu.classList.remove("is-open");
      restoreMenuHome();
      window.removeEventListener("resize", schedulePositionMenu);
      window.removeEventListener("scroll", schedulePositionMenu, true);
      if (positionRaf) {
        cancelAnimationFrame(positionRaf);
        positionRaf = 0;
      }
    }

    function openMenu() {
      if (!dropdown || !menu || !toggle) return;
      closeAllOpenMenus();
      if (!menuHomeParent) {
        menuHomeParent = menu.parentNode;
        menuHomeNext = menu.nextSibling;
      }
      document.body.appendChild(menu);
      dropdown.classList.add("open");
      menu.classList.add("is-open");
      isOpen = true;
      openClosers.add(closeMenu);
      positionMenu();
      window.addEventListener("resize", schedulePositionMenu);
      window.addEventListener("scroll", schedulePositionMenu, true);
    }

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
      toggle.addEventListener("click", function (e) {
        e.stopPropagation();
        if (isOpen) closeMenu();
        else openMenu();
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

    if (menu) {
      menu.classList.add("ma-multiselect-menu");
      menu.addEventListener("click", function (e) {
        e.stopPropagation();
      });
    }

    return {
      setAgencies: function (arr) {
        agencies = Array.isArray(arr) ? arr : [];
        renderList();
      },
      setSelected: setSelected,
      getSelected: function () {
        return new Set(selected);
      },
      getSelectedArray: getSelectedArray,
      getSelectedWithHomeArray: getSelectedWithHomeArray,
      refresh: renderList,
      close: closeMenu,
    };
  }

  if (!global.__maMultiselectDocClick) {
    global.__maMultiselectDocClick = true;
    document.addEventListener("click", function () {
      closeAllOpenMenus();
    });
  }

  global.ManagedAgenciesPicker = {
    bind: bindManagedAgenciesPicker,
    mergeWithHome: mergeWithHome,
    stripHomeFromManaged: stripHomeFromManaged,
  };
})(window);
