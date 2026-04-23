(function () {
  var STORAGE_KEY = "tak-portal-theme";
  var DARK = "dark";
  var LIGHT = "light";
  var forceServerDefault = false;

  function getStoredTheme() {
    if (forceServerDefault) return null;
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      if (v === DARK || v === LIGHT) return v;
    } catch (e) {}
    return null;
  }

  function detectInitialTheme() {
    // Prefer stored value
    var stored = getStoredTheme();
    if (stored) return stored;

    // Fallback to class on body from server (theme-dark / theme-light)
    var cls = document.body.className || "";
    if (cls.indexOf("theme-light") !== -1) return LIGHT;
    return DARK;
  }

  function applyTheme(theme) {
    if (theme !== DARK && theme !== LIGHT) theme = DARK;
    document.body.classList.remove("theme-dark", "theme-light", "theme-dark-blue");
    document.body.classList.add("theme-" + theme);
    if (!forceServerDefault) {
      try {
        localStorage.setItem(STORAGE_KEY, theme);
      } catch (e) {}
    }

    var toggle = document.getElementById("themeToggle");
    if (toggle) {
      toggle.setAttribute("aria-label", theme === DARK ? "Switch to light mode" : "Switch to dark mode");
      toggle.setAttribute("title", theme === DARK ? "Switch to light mode" : "Switch to dark mode");
    }
  }

  function init() {
    forceServerDefault =
      document.body &&
      document.body.dataset &&
      document.body.dataset.themeDefaultOnly === "true";

    var initial = detectInitialTheme();
    applyTheme(initial);

    var toggle = document.getElementById("themeToggle");
    if (!toggle) return;
    toggle.addEventListener("click", function () {
      var current = getStoredTheme() || detectInitialTheme();
      var next = current === DARK ? LIGHT : DARK;
      applyTheme(next);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

