(function () {
  var lock = document.getElementById("stackHealthLock");
  if (!lock) return;
  var titleEl = document.getElementById("stackHealthLockTitle");
  var messageEl = document.getElementById("stackHealthLockMessage");
  var app = document.querySelector(".app");
  var locked = false;
  var failCount = 0;
  var FAIL_BEFORE_LOCK = 2;

  function setLocked(on, title, message) {
    locked = !!on;
    lock.hidden = !locked;
    lock.classList.toggle("is-visible", locked);
    document.body.classList.toggle("stack-health-locked", locked);
    if (app) {
      if ("inert" in app) app.inert = locked;
      app.setAttribute("aria-hidden", locked ? "true" : "false");
    }
    if (locked) {
      if (title && titleEl) titleEl.textContent = title;
      if (message && messageEl) messageEl.textContent = message;
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
      setLocked(
        true,
        (data && data.title) || "TAK Portal is unavailable",
        (data && data.message) ||
          "The portal cannot be used until the database and background worker are running."
      );
    } catch (_) {
      failCount += 1;
      if (failCount < FAIL_BEFORE_LOCK && !locked) return;
      setLocked(
        true,
        "TAK Portal is unavailable",
        "The portal did not respond to a health check. Refresh the page, or on the server run ./takportal start."
      );
    }
  }

  poll();
  setInterval(poll, 5000);
})();
