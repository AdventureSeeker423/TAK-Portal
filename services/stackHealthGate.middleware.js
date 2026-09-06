const stackHealth = require("./stackHealth.service");

const ALLOW_EXACT = new Set([
  "/migration",
  "/stack-down",
  "/api/system/migration-status",
  "/api/system/health",
  "/api/system/migration-retry",
]);

const ALLOW_PREFIX = ["/api/settings/legacy-import"];

function isAllowedPath(p) {
  if (ALLOW_EXACT.has(p)) return true;
  return ALLOW_PREFIX.some((pre) => p === pre || p.startsWith(pre + "/"));
}

function isStaticAllowed(req) {
  const p = req.path || "";
  if (p.startsWith("/branding/") || p.startsWith("/mutual-aid-logos/")) return true;
  if (p === "/favicon.ico") return true;
  return false;
}

function wantsHtml(req) {
  const accept = String(req.headers.accept || "");
  if (!accept) return true;
  return accept.includes("text/html");
}

async function stackHealthGate(req, res, next) {
  try {
    const p = (req.path || "").replace(/\/+$/, "") || "/";
    if (isAllowedPath(p) || isStaticAllowed(req)) return next();

    const health = await stackHealth.getStackHealth();
    if (health.ok || health.migrating) return next();

    if (wantsHtml(req)) {
      return res.status(503).render("stack-down", {
        health,
        unavailable: stackHealth.getUnavailablePageLocals(),
      });
    }
    res.setHeader("Retry-After", "5");
    return res.status(503).json({
      error: "stack_unavailable",
      ok: false,
      migrating: !!health.migrating,
      postgres: health.postgres,
      worker: health.worker,
      title: health.title,
      message: health.message,
    });
  } catch (e) {
    console.warn("[stack-health-gate]", e?.message || e);
    if (wantsHtml(req)) {
      const unavailable = stackHealth.getUnavailablePageLocals();
      return res.status(503).render("stack-down", {
        health: {
          ok: false,
          title: unavailable.title,
          message: unavailable.message,
        },
        unavailable,
      });
    }
    res.setHeader("Retry-After", "5");
    return res.status(503).json({ error: "stack_unavailable", ok: false });
  }
}

module.exports = stackHealthGate;
