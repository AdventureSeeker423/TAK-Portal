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

  async function poll() {
    try {
      var res = await fetch("/api/system/health", {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
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
      failCount += 1;
      if (failCount < FAIL_BEFORE_LOCK && !locked) return;
      setLocked(true);
    }
  }

  poll();
  setInterval(poll, 5000);
})();
