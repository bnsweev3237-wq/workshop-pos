const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { uid } = require('../lib/ids');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

const toPublic = (row) => ({ id: row.id, name: row.name, username: row.username, createdAt: row.created_at });

// Whether any admin account exists yet — a fresh install has none, so the very first
// admin is created through a one-time "setup" flow instead of a normal login.
router.get('/status', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
  const loggedIn = !!(req.session && req.session.adminId);
  let me = null;
  if (loggedIn) {
    const row = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.session.adminId);
    if (row) me = toPublic(row);
    else loggedIn && (req.session.adminId = null); // stale session pointing at a deleted admin
  }
  res.json({ needsSetup: count === 0, loggedIn: !!me, me });
});

// One-time bootstrap: only works while the admins table is empty. After the first admin
// exists, this route always rejects — every admin after that is added from Settings by
// someone already logged in.
router.post('/setup', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
  if (count > 0) return res.status(409).json({ error: 'already_set_up' });
  const { name, username, password } = req.body || {};
  if (!name || !username || !password || password.length < 8) {
    return res.status(400).json({ error: 'invalid_input', message: 'Name, username, and a password of at least 8 characters are required.' });
  }
  const row = { id: uid(), name, username: username.trim(), password_hash: bcrypt.hashSync(password, 12), created_at: Date.now() };
  db.prepare('INSERT INTO admins (id, name, username, password_hash, created_at) VALUES (@id, @name, @username, @password_hash, @created_at)').run(row);
  req.session.adminId = row.id;
  res.json({ ok: true, me: toPublic(row) });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'invalid_input' });
  const row = db.prepare('SELECT * FROM admins WHERE username = ?').get(username.trim());
  // Same response whether the username is wrong or the password is — don't leak which.
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  req.session.adminId = row.id;
  res.json({ ok: true, me: toPublic(row) });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---- Admin management (Settings page) — all require being logged in already ----

router.get('/admins', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM admins ORDER BY created_at ASC').all();
  res.json(rows.map(toPublic));
});

router.post('/admins', requireAdmin, (req, res) => {
  const { name, username, password } = req.body || {};
  if (!name || !username || !password || password.length < 8) {
    return res.status(400).json({ error: 'invalid_input', message: 'Name, username, and a password of at least 8 characters are required.' });
  }
  const existing = db.prepare('SELECT 1 FROM admins WHERE username = ?').get(username.trim());
  if (existing) return res.status(409).json({ error: 'username_taken' });
  const row = { id: uid(), name, username: username.trim(), password_hash: bcrypt.hashSync(password, 12), created_at: Date.now() };
  db.prepare('INSERT INTO admins (id, name, username, password_hash, created_at) VALUES (@id, @name, @username, @password_hash, @created_at)').run(row);
  res.json(toPublic(row));
});

// Any logged-in admin can reset another admin's password — this IS the "forgot password"
// recovery path (a teammate with access resets it for you), since a standalone install has
// no mail server to send reset links through by default.
router.post('/admins/:id/password', requireAdmin, (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 8) return res.status(400).json({ error: 'invalid_input', message: 'Password must be at least 8 characters.' });
  const result = db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 12), req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

router.delete('/admins/:id', requireAdmin, (req, res) => {
  const count = db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
  if (count <= 1) return res.status(409).json({ error: 'last_admin', message: 'Can’t remove the last admin account.' });
  const result = db.prepare('DELETE FROM admins WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  // If an admin deletes their own account, end their session too.
  if (req.session.adminId === req.params.id) req.session.destroy(() => {});
  res.json({ ok: true });
});

module.exports = router;
