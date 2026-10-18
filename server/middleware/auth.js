const db = require('../db');

// Every request re-checks the user still exists and reads their current role from the
// database, rather than trusting whatever was true when the session cookie was issued —
// a removed or demoted account loses access on its very next request, not just its next login.
function requireLogin(req, res, next) {
  const id = req.session && req.session.userId;
  if (!id) return res.status(401).json({ error: 'not_logged_in' });
  const user = db.prepare('SELECT id, name, username, role FROM users WHERE id = ?').get(id);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'not_logged_in' });
  }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  requireLogin(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    next();
  });
}

module.exports = { requireLogin, requireAdmin };
