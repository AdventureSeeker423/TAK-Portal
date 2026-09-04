const jsonImport = require("./jsonImport.service");

const ALLOW_EXACT = new Set([
  "/migration",
  "/api/system/migration-status",
  "/api/system/health",
  "/api/system/migration-retry",
]);

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

async function migrationGate(req, res, next) {
  try {
    const p = (req.path || "").replace(/\/+$/, "") || "/";
    if (ALLOW_EXACT.has(p) || isStaticAllowed(req)) return next();

    const status = await jsonImport.readStatusJson();
    if (!status.active) return next();

    if (wantsHtml(req)) {
      return res.status(503).render("migration", { status });
    }
    res.setHeader("Retry-After", "5");
    return res.status(503).json({
      error: "migration_in_progress",
      migrating: true,
      percent: status.percent,
      etaSeconds: status.etaSeconds,
      message: status.message,
    });
  } catch (e) {
    console.warn("[migration-gate]", e?.message || e);
    return next();
  }
}

module.exports = migrationGate;
