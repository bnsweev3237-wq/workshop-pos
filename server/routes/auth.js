const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { uid } = require('../lib/ids');
const { requireAdmin, requireLogin, ROLES } = require('../middleware/auth');

const router = express.Router();

// Caps sign-in attempts per IP — without this, a password could be brute-forced with
// unlimited guesses now that this runs on the open internet. Keyed by IP (not username) so
// it also limits someone hammering many different usernames from one source.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_attempts', message: 'Too many sign-in attempts. Wait a few minutes and try again.' },
});

const toPublic = (row) => ({ id: row.id, name: row.name, username: row.username, role: row.role, mustChangePassword: !!row.must_change_password, createdAt: row.created_at });

// Whether any account exists yet — a fresh install has none, so the very first account is
// created through a one-time "setup" flow instead of a normal login, and is always an admin
// (someone has to be able to add everyone else from Settings).
router.get('/status', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const loggedIn = !!(req.session && req.session.userId);
  let me = null;
  if (loggedIn) {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (row) me = toPublic(row);
    else req.session.userId = null; // stale session pointing at a deleted user
  }
  res.json({ needsSetup: count === 0, loggedIn: !!me, me });
});

router.post('/setup', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return res.status(409).json({ error: 'already_set_up' });
  const { name, username, password } = req.body || {};
  if (!name || !username || !password || password.length < 8) {
    return res.status(400).json({ error: 'invalid_input', message: 'Name, username, and a password of at least 8 characters are required.' });
  }
  const row = { id: uid(), name, username: username.trim(), password_hash: bcrypt.hashSync(password, 12), role: 'admin', created_at: Date.now() };
  db.prepare('INSERT INTO users (id, name, username, password_hash, role, created_at) VALUES (@id, @name, @username, @password_hash, @role, @created_at)').run(row);
  req.session.userId = row.id;
  res.json({ ok: true, me: toPublic(row) });
});

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'invalid_input' });
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  // Same response whether the username is wrong or the password is — don't leak which.
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  req.session.userId = row.id;
  res.json({ ok: true, me: toPublic(row) });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Self-service password change — any logged-in user, for themselves only. This is what the
// forced "set a new password" screen calls after a fresh account or an admin reset, and
// clears must_change_password so it isn't asked again until the next reset.
router.post('/password', requireLogin, (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'invalid_input', message: 'Password must be at least 8 characters.' });
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(bcrypt.hashSync(newPassword, 12), req.user.id);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ ok: true, me: toPublic(row) });
});

// ---- User management (Settings page) — admin-only; cashiers can't reach this at all ----

router.get('/users', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY created_at ASC').all();
  res.json(rows.map(toPublic));
});

router.post('/users', requireAdmin, (req, res) => {
  const { name, username, password, role } = req.body || {};
  if (!name || !username || !password || password.length < 8) {
    return res.status(400).json({ error: 'invalid_input', message: 'Name, username, and an 8+ character password are required.' });
  }
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: 'invalid_input', message: `Role must be one of: ${ROLES.join(', ')}.` });
  }
  const existing = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username.trim());
  if (existing) return res.status(409).json({ error: 'username_taken' });
  // must_change_password = 1: the admin picked this password, not the account's owner, so
  // they're forced to set their own the moment they first sign in with it.
  const row = { id: uid(), name, username: username.trim(), password_hash: bcrypt.hashSync(password, 12), role, must_change_password: 1, created_at: Date.now() };
  db.prepare('INSERT INTO users (id, name, username, password_hash, role, must_change_password, created_at) VALUES (@id, @name, @username, @password_hash, @role, @must_change_password, @created_at)').run(row);
  res.json(toPublic(row));
});

// Any logged-in admin can reset another user's password — this IS the "forgot password"
// recovery path (a teammate with access resets it for you), since a standalone install has
// no mail server to send reset links through by default. Same as a brand-new account, the
// reset password is admin-chosen, so the user is forced to set their own on next sign-in.
router.post('/users/:id/password', requireAdmin, (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 8) return res.status(400).json({ error: 'invalid_input', message: 'Password must be at least 8 characters.' });
  const result = db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(bcrypt.hashSync(password, 12), req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

// An admin can change anyone's role (e.g. promote a cashier), but never the last admin —
// that would leave nobody able to reach Settings at all.
router.post('/users/:id/role', requireAdmin, (req, res) => {
  const { role } = req.body || {};
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'invalid_input' });
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'not_found' });
  if (target.role === 'admin' && role !== 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
    if (adminCount <= 1) return res.status(409).json({ error: 'last_admin', message: 'Can’t demote the last admin account.' });
  }
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  res.json({ ok: true });
});

router.delete('/users/:id', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'not_found' });
  if (target.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
    if (adminCount <= 1) return res.status(409).json({ error: 'last_admin', message: 'Can’t remove the last admin account.' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  // If someone deletes their own account, end their session too.
  if (req.session.userId === req.params.id) req.session.destroy(() => {});
  res.json({ ok: true });
});

module.exports = router;
