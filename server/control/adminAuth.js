// Auth for the platform admin console (/admin on the platform host) — deliberately separate
// from server/middleware/auth.js's tenant-scoped requireLogin/requireRole. Platform staff
// aren't tied to any one tenant, so this reads req.session.platformUserId/platformUserRole (a
// different session namespace from a tenant login's userId/tenantId) and queries the
// control-plane platform_users table instead of any tenant's own users table. A session can
// carry both a tenant login AND a platform-staff login at once without conflict — they're
// unrelated fields on the same session object.
const { getControlDb } = require('./db');

// A session cookie issued before/after a staff login must stop pointing at whatever session
// existed under the old id — same session-fixation fix as routes/auth.js's loginAs().
function loginPlatformUser(req, userRow, cb) {
  req.session.regenerate((err) => {
    if (err) return cb(err);
    req.session.platformUserId = userRow.id;
    req.session.platformUserRole = userRow.role;
    cb(null);
  });
}

// Every request re-checks the account still exists and reads its current role, rather than
// trusting whatever was true when the session cookie was issued — a removed staff account
// loses access on its very next request, not just its next login.
function requirePlatformStaff(req, res, next) {
  const id = req.session && req.session.platformUserId;
  if (!id) return res.status(401).json({ error: 'not_logged_in' });
  const row = getControlDb().prepare('SELECT id, username, role FROM platform_users WHERE id = ?').get(id);
  if (!row) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'not_logged_in' });
  }
  req.platformUser = row;
  next();
}

function requirePlatformAdmin(req, res, next) {
  requirePlatformStaff(req, res, () => {
    if (req.platformUser.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    next();
  });
}

module.exports = { loginPlatformUser, requirePlatformStaff, requirePlatformAdmin };
