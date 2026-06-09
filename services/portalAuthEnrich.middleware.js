// services/portalAuthEnrich.middleware.js
const accessSvc = require("./access.service");

/**
 * After forward-auth headers are parsed, refresh agency-admin scope from Authentik
 * so multi-agency admins see all managed agencies without re-login.
 */
async function portalAuthEnrichMiddleware(req, res, next) {
  try {
    const authUser = req.authentikUser;
    if (!authUser || authUser.isGlobalAdmin) return next();

    await accessSvc.enrichAuthUserFromAuthentik(authUser);

    res.locals.authUser = authUser;
    res.locals.isAgencyAdmin = !!authUser.isAgencyAdmin;
    res.locals.allowedAgencySuffixes = authUser.allowedAgencySuffixes || [];
    res.locals.agencyPageTitleAbbrev = accessSvc.getAgencyPageTitleAbbrev(authUser);
  } catch (_) {
    // Non-fatal: fall back to header-derived scope.
  }
  return next();
}

module.exports = portalAuthEnrichMiddleware;
