(function () {
  var lock = document.getElementById("stackHealthLock");
  if (!lock) return;
  var app = document.querySelector(".app");
  var locked = false;
  var failCount = 0;
  var FAIL_BEFORE_LOCK = 2;

  function setLocked(on) {
    locked = !!on;
    lock.hidden = !locked;
    lock.classList.toggle("is-visible", locked);
    document.body.classList.toggle("stack-health-locked", locked);
    if (app) {
      if ("inert" in app) app.inert = locked;
      app.setAttribute("aria-hidden", locked ? "true" : "false");
    }
  }

  function isJsonResponse(res) {
    var ct = String((res && res.headers && res.headers.get("content-type")) || "");
    return ct.indexOf("application/json") !== -1;
  }

  function isAuthOrProxyBlip(res) {
    if (!res) return true;
    if (res.type === "opaqueredirect") return true;
    var status = Number(res.status || 0);
    if (status >= 300 && status < 400) return true;
    if (status === 401 || status === 403) return true;
    if (status === 502 || status === 504) return true;
    return false;
  }

  async function poll() {
    try {
      var res = await fetch("/api/system/health", {
        cache: "no-store",
        headers: { Accept: "application/json" },
        redirect: "manual",
        credentials: "same-origin",
      });
      // Caddy/Authentik 502s and login redirects are not a portal outage.
      if (isAuthOrProxyBlip(res) || !isJsonResponse(res)) return;
      var data = await res.json();
      if (data && (data.ok || data.migrating)) {
        failCount = 0;
        if (locked) {
          window.location.reload();
          return;
        }
        setLocked(false);
        return;
      }
      failCount += 1;
      if (failCount < FAIL_BEFORE_LOCK && !locked) return;
      setLocked(true);
    } catch (_) {
      // Network / CORS (Authentik authorize URL) — do not treat as stack-down.
    }
  }

  poll();
  setInterval(poll, 5000);
})();
