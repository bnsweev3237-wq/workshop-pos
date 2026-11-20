const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { requireAdmin, requireLogin, ROLES } = require('../middleware/auth');
const { createUserRow } = require('../lib/users');
const { isMultiTenant } = require('../mode');
const { checkUsageCap } = require('../lib/license');
const {
  getSupportSession, markSupportSessionConsumed, getActiveSupportSessionForTenant,
  endActiveSupportSessionForTenant, addAuditLog,
} = require('../control/db');

// Hard safety cap on how long a consumed support session keeps showing the banner even if
// nobody explicitly ends it — see server/control/schema.sql's support_sessions table.
const SUPPORT_SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000;

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
// (someone has to be able to add everyone else from Settings). In multi-tenant mode there is
// no first-run concept per tenant at all — signup (server/routes/platform.js) always creates
// the first admin as part of provisioning a tenant, so needsSetup is always false there and
// /setup below is disabled outright.
router.get('/status', (req, res) => {
  const needsSetup = isMultiTenant ? false : db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
  const loggedIn = !req.sessionTenantMismatch && !!(req.session && req.session.userId);
  let me = null;
  if (loggedIn) {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (row) me = toPublic(row);
    else req.session.userId = null; // stale session pointing at a deleted user
  }
  // supportSessionActive: shown to EVERY session on this tenant (the real admin's own login
  // included), not just the support agent's — visible disclosure while support is in the
  // account was the explicit design choice, not a silent backdoor. isSupportSession is true
  // only for the one session that actually consumed the impersonation link (adds an "end it
  // now" button on that side too, same as the real admin gets).
  let supportSessionActive = false;
  if (isMultiTenant && req.tenant) {
    supportSessionActive = !!getActiveSupportSessionForTenant(req.tenant.id, SUPPORT_SESSION_MAX_AGE_MS);
  }
  res.json({ needsSetup, loggedIn: !!me, me, supportSessionActive, isSupportSession: !!(req.session && req.session.isSupportSession) });
});

// Consumes a one-time link minted by a platform staff member (server/routes/platformAdmin.js's
// POST /tenants/:id/impersonate) — never reachable in single-tenant mode, since there's no
// platform host or staff concept there at all.
router.get('/impersonate/:token', (req, res) => {
  if (!isMultiTenant) return res.status(404).json({ error: 'not_found' });
  const row = getSupportSession(req.params.token);
  // The tenant check is the one that actually matters: a token minted for a different tenant
  // must never work here, even though it's a real, unexpired, platform-staff-minted token —
  // this is the one deliberate exception to tenant isolation in the whole system, so it's
  // scoped as tightly as the thing it's an exception to.
  if (!row || row.consumed_at || row.expires_at < Date.now() || row.tenant_id !== req.tenant.id) {
    return res.status(404).send('This support link is invalid or has expired.');
  }
  const admin = db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1").get();
  if (!admin) return res.status(404).send('This business has no admin account to assist.');
  markSupportSessionConsumed(row.id);
  loginAs(req, admin, (err) => {
    if (err) return res.status(500).send('Could not start the support session.');
    req.session.isSupportSession = true;
    addAuditLog(req.tenant.id, row.platform_user_id, 'support_impersonation', { targetUserId: admin.id });
    res.redirect('/');
  });
});

// Either side can end an active support session — the agent who started it, or the tenant's
// own admin who'd rather it ended now. Neither needs to know the token; just being logged in
// to this tenant (any role) is enough.
router.post('/end-support-session', requireLogin, (req, res) => {
  if (!isMultiTenant || !req.tenant) return res.status(404).json({ error: 'not_found' });
  endActiveSupportSessionForTenant(req.tenant.id);
  res.json({ ok: true });
});

// A session cookie issued before/after an id's login must stop pointing at whatever session
// existed under the old id — regenerate() swaps the store's session id while keeping express-
// session's in-memory req.session object (and whatever's already been set on it) intact, which
// is what stops a session fixation attack (an attacker who got a victim to adopt a session id
// before they logged in could otherwise reuse that same id to ride along as them afterward).
function loginAs(req, userRow, cb) {
  req.session.regenerate((err) => {
    if (err) return cb(err);
    req.session.userId = userRow.id;
    if (req.tenant) req.session.tenantId = req.tenant.id;
    cb(null);
  });
}

router.post('/setup', (req, res) => {
  if (isMultiTenant) return res.status(404).json({ error: 'not_found' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return res.status(409).json({ error: 'already_set_up' });
  const { name, username, password } = req.body || {};
  if (!name || !username || !password || password.length < 8) {
    return res.status(400).json({ error: 'invalid_input', message: 'Name, username, and a password of at least 8 characters are required.' });
  }
  const row = createUserRow(db, { name, username: username.trim(), password, role: 'admin' });
  loginAs(req, row, (err) => {
    if (err) return res.status(500).json({ error: 'session_error' });
    res.json({ ok: true, me: toPublic(row) });
  });
});

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'invalid_input' });
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  // Same response whether the username is wrong or the password is — don't leak which.
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  loginAs(req, row, (err) => {
    if (err) return res.status(500).json({ error: 'session_error' });
    res.json({ ok: true, me: toPublic(row) });
  });
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
  // Default-allow in single-tenant mode (no license configured there) — same as every other
  // checkUsageCap call site, this only actually restricts anything once a multi-tenant plan
  // sets a real limit.
  const staffCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const cap = checkUsageCap('staffAccounts', staffCount);
  if (!cap.ok) {
    return res.status(403).json({ error: 'usage_cap_reached', cap: 'staffAccounts', limit: cap.limit, message: `Your plan allows up to ${cap.limit} staff account${cap.limit === 1 ? '' : 's'}. Upgrade to add more.` });
  }
  // must_change_password: the admin picked this password, not the account's owner, so
  // they're forced to set their own the moment they first sign in with it.
  const row = createUserRow(db, { name, username: username.trim(), password, role, mustChangePassword: true });
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
