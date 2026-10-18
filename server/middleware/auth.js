const db = require('../db');

// admin: everything. manager: everything but Settings (user management, the sales-tracking
// toggle). lead: Sell + Reports, nothing that edits pricing/materials. cashier: Sell only,
// and a restricted Sell at that — see server/routes/sales.js and server/routes/events.js for
// the specific things a cashier can't do there (custom items, event edits, tax overrides).
const ROLES = ['admin', 'manager', 'lead', 'cashier'];

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

function requireRole(...roles) {
  return (req, res, next) => {
    requireLogin(req, res, () => {
      if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'forbidden' });
      next();
    });
  };
}

const requireAdmin = requireRole('admin');
// Create/edit/delete materials, items, and saved-item stock actions — the Calculator,
// Materials, and Saved Items tabs.
const requireManageItems = requireRole('admin', 'manager');
// Read access to profit figures and full item cost/materials data — the Reports tab.
const requireReports = requireRole('admin', 'manager', 'lead');
// Create/edit/end events — not cashiers, who can sell under an event but not change it.
const requireEventManage = requireRole('admin', 'manager', 'lead');

module.exports = { ROLES, requireLogin, requireRole, requireAdmin, requireManageItems, requireReports, requireEventManage };
