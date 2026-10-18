// Gate: every API route except the Sell-page ones requires a logged-in admin.
// req.session.adminId is set on successful login (see routes/auth.js).
function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) return next();
  return res.status(401).json({ error: 'not_logged_in' });
}

module.exports = { requireAdmin };
