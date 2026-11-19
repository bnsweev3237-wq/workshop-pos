// Runs right after the session middleware, before any route. A presented session cookie might
// belong to a tenant other than the one the current host resolved to (two tabs, two
// subdomains, or a tampered/replayed cookie) — this flags that case without ever mutating or
// destroying the session itself, since it may be a perfectly valid session for whichever
// tenant it actually belongs to. Every place that would otherwise trust req.session.userId
// (requireLogin in middleware/auth.js, and the /status and /login routes) checks
// req.sessionTenantMismatch first and treats a mismatch as logged out, for this request only.
function bindSessionToTenant(req, res, next) {
  req.sessionTenantMismatch = !!(req.tenant && req.session && req.session.tenantId && req.session.tenantId !== req.tenant.id);
  next();
}

module.exports = { bindSessionToTenant };
