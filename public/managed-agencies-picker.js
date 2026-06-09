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

  /**
   * Compact checkbox dropdown for managed-agency selection.
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
    const inputName = opts.inputName || "managedAgencySuffix";

    let agencies = [];
    let selected = new Set();

    function sortedAgencies() {
      const source = typeof opts.getAgencies === "function" ? opts.getAgencies() : agencies;
      return (Array.isArray(source) ? source : [])
        .slice()
        .sort((a, b) => String(a?.name || "").localeCompare(String(b?.name || "")));
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
      const labels = sortedAgencies()
        .filter((a) => selected.has(String(a?.suffix || "").trim().toLowerCase()))
        .map(formatSummaryLabel)
        .filter(Boolean);
      summary.textContent = labels.length
        ? "Selected: " + labels.join(", ")
        : "No agencies selected.";
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

    function setSelected(next) {
      selected = new Set(
        (next instanceof Set ? Array.from(next) : Array.isArray(next) ? next : [])
          .map((s) => String(s || "").trim().toLowerCase())
          .filter(Boolean)
      );
      renderList();
      notifyChange();
    }

    function getSelectedArray() {
      return Array.from(selected).filter(Boolean).sort();
    }

    if (toggle && dropdown) {
      toggle.addEventListener("click", function (e) {
        e.stopPropagation();
        document.querySelectorAll(".ma-multiselect.open").forEach(function (el) {
          if (el !== dropdown) el.classList.remove("open");
        });
        dropdown.classList.toggle("open");
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

    const menu = dropdown ? dropdown.querySelector(".filter-menu") : null;
    if (menu) menu.addEventListener("click", function (e) { e.stopPropagation(); });

    return {
      setAgencies: function (arr) {
        agencies = Array.isArray(arr) ? arr : [];
        renderList();
      },
      setSelected: setSelected,
      getSelected: function () { return new Set(selected); },
      getSelectedArray: getSelectedArray,
      refresh: renderList,
    };
  }

  if (!global.__maMultiselectDocClick) {
    global.__maMultiselectDocClick = true;
    document.addEventListener("click", function () {
      document.querySelectorAll(".ma-multiselect.open").forEach(function (el) {
        el.classList.remove("open");
      });
    });
  }

  global.ManagedAgenciesPicker = { bind: bindManagedAgenciesPicker };
})(window);
