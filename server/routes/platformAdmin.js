// The platform admin console's API — staff login, the tenant list + disk usage, triggering a
// platform-wide update, and staff account management. Mounted only in multi-tenant mode, only
// reachable on the platform host (never any tenant subdomain) — same self-guard pattern as
// server/routes/platform.js. Completely separate auth from any tenant's own login: see
// server/control/adminAuth.js.
const fs = require('fs');
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { uid } = require('../lib/ids');
const { createPlatformUserRow } = require('../lib/platformUsers');
const { requirePlatformStaff, requirePlatformAdmin, loginPlatformUser } = require('../control/adminAuth');
const {
  getControlDb, listTenants, getTenantById, getPlatformUserByUsername, listPlatformUsers,
  deletePlatformUserRow, insertSupportSession, updateTenantPlan, updateTenantStatus, addAuditLog,
} = require('../control/db');
const { baseDomain } = require('../tenancy/resolveTenant');
const pool = require('../tenancy/pool');
const { checkForUpdate, applyUpdate } = require('../lib/selfUpdate');
const { PLANS } = require('../lib/plans');
const { getPlatformMailConfig, setPlatformMailConfig, sendPlatformMail, isValidEmail } = require('../lib/platformMail');
const { provisionTenant, ProvisionError } = require('../tenancy/provision');

const router = express.Router();

router.use((req, res, next) => {
  if (!req.platformHost) return res.status(404).json({ error: 'not_found' });
  next();
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_attempts', message: 'Too many sign-in attempts. Wait a few minutes and try again.' },
});

const toPublicStaff = (row) => ({ id: row.id, username: row.username, role: row.role, createdAt: row.created_at });

router.post('/login', loginLimiter, (req, res) => {
  const bcrypt = require('bcryptjs');
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'invalid_input' });
  const row = getPlatformUserByUsername(username.trim());
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  loginPlatformUser(req, row, (err) => {
    if (err) return res.status(500).json({ error: 'session_error' });
    res.json({ ok: true, me: toPublicStaff(row) });
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/status', (req, res) => {
  const id = req.session && req.session.platformUserId;
  if (!id) return res.json({ loggedIn: false, me: null });
  const row = getControlDb().prepare('SELECT id, username, role, created_at FROM platform_users WHERE id = ?').get(id);
  if (!row) return res.json({ loggedIn: false, me: null });
  res.json({ loggedIn: true, me: toPublicStaff(row) });
});

// Mirrors server/routes/maintenance.js's /disk route, just computed from outside a tenant's
// own request context for every tenant at once — fs.stat for the db file and backups
// directory (both derivable from the tenant id alone, no db connection needed), and the one
// number that genuinely requires a live query (photo bytes) via pool.withTenant, reusing
// server/lib/photos.js#photoBytes unchanged.
function fileDiskUsage(tenantId) {
  const dbPath = pool.dbPathFor(tenantId);
  let dbBytes = 0;
  try { dbBytes = fs.statSync(dbPath).size; } catch { /* not provisioned (shouldn't happen for an active tenant) */ }
  const backupsDir = path.join(path.dirname(dbPath), 'backups');
  let backupBytes = 0;
  try {
    for (const f of fs.readdirSync(backupsDir)) {
      if (!f.endsWith('.db')) continue;
      try { backupBytes += fs.statSync(path.join(backupsDir, f)).size; } catch { /* raced with a prune */ }
    }
  } catch { /* no backups yet */ }
  return { dbBytes, backupBytes };
}

router.get('/plans', requirePlatformStaff, (req, res) => {
  res.json(Object.keys(PLANS));
});

router.get('/tenants', requirePlatformStaff, async (req, res) => {
  const tenants = listTenants();
  const out = await Promise.all(tenants.map(async (t) => {
    const { dbBytes, backupBytes } = fileDiskUsage(t.id);
    let photoBytes = 0;
    try {
      photoBytes = await pool.withTenant(t.id, () => require('../lib/photos').photoBytes(require('../db')));
    } catch { /* e.g. a provisioning tenant with no db file yet */ }
    return {
      id: t.id, slug: t.slug, businessName: t.business_name, status: t.status, plan: t.plan,
      createdAt: t.created_at, dbBytes, backupBytes, photoBytes,
    };
  }));
  res.json(out);
});

// Manually provisioning a tenant from the console — for the cases the public self-serve
// /signup page doesn't cover (onboarding someone by hand, a migration, a test account).
// skipVerification: true, same as scripts/tenant-admin.js's "create" command — a staff member
// creating one by hand has already vetted the address out of band, so unlike real self-serve
// signup there's no "check your email" step and the owner can log in immediately.
router.post('/tenants', requirePlatformAdmin, async (req, res) => {
  const { businessName, slug, ownerName, username, password, email } = req.body || {};
  try {
    const tenant = await provisionTenant({ businessName, slug, ownerName, username, password, email, skipVerification: true });
    addAuditLog(tenant.id, req.platformUser.username, 'tenant_created_by_staff', {});
    res.json({ id: tenant.id, slug: tenant.slug, businessName: tenant.business_name, loginUrl: `//${tenant.slug}.${baseDomain()}/` });
  } catch (err) {
    if (err instanceof ProvisionError) {
      const status = err.code === 'slug_taken' ? 409 : 400;
      return res.status(status).json({ error: err.code, message: err.message });
    }
    console.error('Admin-console tenant creation failed:', err);
    res.status(502).json({ error: 'create_failed', message: 'Something went wrong creating that tenant. Try again.' });
  }
});

// Changing what a tenant pays for is an admin-only action — support staff can view plans
// (visible in the /tenants response) but not change them, same split as staff management
// and platform updates. See server/lib/plans.js for the actual plan content.
router.post('/tenants/:id/plan', requirePlatformAdmin, (req, res) => {
  const tenant = getTenantById(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'not_found' });
  const { plan } = req.body || {};
  if (!Object.keys(PLANS).includes(plan)) {
    return res.status(400).json({ error: 'invalid_input', message: `Plan must be one of: ${Object.keys(PLANS).join(', ')}.` });
  }
  updateTenantPlan(tenant.id, plan);
  addAuditLog(tenant.id, req.platformUser.username, 'plan_changed', { plan });
  res.json({ ok: true, plan });
});

// Suspending/reactivating a tenant is an admin-only action, same split as plan changes —
// support can see a tenant is suspended (status is in the /tenants response) but not change it.
// server/tenancy/resolveTenant.js is what actually enforces 'suspended' by rejecting the
// request before any route runs; this just flips the status.
router.post('/tenants/:id/status', requirePlatformAdmin, (req, res) => {
  const tenant = getTenantById(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'not_found' });
  const { status } = req.body || {};
  if (!['active', 'suspended'].includes(status)) {
    return res.status(400).json({ error: 'invalid_input', message: 'Status must be active or suspended.' });
  }
  updateTenantStatus(tenant.id, status);
  addAuditLog(tenant.id, req.platformUser.username, status === 'suspended' ? 'suspended' : 'activated', {});
  res.json({ ok: true, status });
});

// Support need (locked-out owner, forgot password), so support can do this too — unlike plan/
// status changes it never affects what the tenant pays for or whether they can be reached at
// all, just lets staff hand back access. Mirrors scripts/tenant-admin.js's reset-password
// command: runs against the tenant's own db via the pool (same context a real request would
// use), sets must_change_password so the new password is a one-time handoff, never silently
// permanent.
router.post('/tenants/:id/reset-password', requirePlatformStaff, async (req, res) => {
  const tenant = getTenantById(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'not_found' });
  const { username, newPassword } = req.body || {};
  if (!username) return res.status(400).json({ error: 'invalid_input', message: 'Username is required.' });
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'invalid_input', message: 'New password must be at least 8 characters.' });
  }
  try {
    const changed = await pool.withTenant(tenant.id, () => {
      const bcrypt = require('bcryptjs');
      const db = require('../db');
      const user = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
      if (!user) return false;
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(bcrypt.hashSync(newPassword, 12), user.id);
      return true;
    });
    if (!changed) return res.status(404).json({ error: 'user_not_found', message: `No user "${username}" on this tenant.` });
    addAuditLog(tenant.id, req.platformUser.username, 'password_reset', { username });
    res.json({ ok: true });
  } catch (err) {
    console.error('Admin-console password reset failed:', err);
    res.status(502).json({ error: 'reset_failed', message: 'Something went wrong resetting that password.' });
  }
});

// Mints a one-time, short-lived, single-tenant-scoped link — consumed by
// server/routes/auth.js's GET /api/auth/impersonate/:token, which is what actually logs the
// browser in. Minting alone grants nothing by itself.
router.post('/tenants/:id/impersonate', requirePlatformStaff, (req, res) => {
  const tenant = getTenantById(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'not_found' });
  const token = uid();
  const now = Date.now();
  insertSupportSession({
    id: token, tenant_id: tenant.id, platform_user_id: req.platformUser.id,
    created_at: now, expires_at: now + 5 * 60 * 1000, // 5 minutes to actually click the link
  });
  const host = req.headers.host || '';
  const port = host.includes(':') ? host.slice(host.indexOf(':')) : '';
  res.json({ ok: true, url: `//${tenant.slug}.${baseDomain()}${port}/api/auth/impersonate/${token}` });
});

router.get('/update/check', requirePlatformAdmin, async (req, res) => {
  try { res.json(await checkForUpdate()); }
  catch (err) { res.status(502).json({ error: 'check_failed', message: err.message }); }
});

let updating = false;
router.post('/update/apply', requirePlatformAdmin, async (req, res) => {
  if (updating) return res.status(409).json({ error: 'already_updating' });
  updating = true;
  try {
    await applyUpdate();
  } catch (err) {
    updating = false;
    return res.status(502).json({ error: 'update_failed', message: err.message });
  }
  res.json({ ok: true });
  // Same handoff as the single-tenant /api/update/apply route: exit and let pm2 (craftium-mt)
  // bring the process back up running the new code. Restarts the shared process — every
  // tenant briefly disconnects, same tradeoff as before, just triggered by a button now.
  setTimeout(() => process.exit(0), 300);
});

router.get('/staff', requirePlatformAdmin, (req, res) => {
  res.json(listPlatformUsers().map(toPublicStaff));
});

router.post('/staff', requirePlatformAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password || password.length < 8) {
    return res.status(400).json({ error: 'invalid_input', message: 'Username and an 8+ character password are required.' });
  }
  if (!['admin', 'support'].includes(role)) return res.status(400).json({ error: 'invalid_input', message: 'Role must be admin or support.' });
  if (getPlatformUserByUsername(username.trim())) return res.status(409).json({ error: 'username_taken' });
  const row = createPlatformUserRow(getControlDb(), { username: username.trim(), password, role });
  res.json(toPublicStaff(row));
});

router.delete('/staff/:id', requirePlatformAdmin, (req, res) => {
  const target = getControlDb().prepare('SELECT * FROM platform_users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'not_found' });
  if (target.role === 'admin') {
    const adminCount = getControlDb().prepare("SELECT COUNT(*) AS n FROM platform_users WHERE role = 'admin'").get().n;
    if (adminCount <= 1) return res.status(409).json({ error: 'last_admin', message: 'Can’t remove the last admin account.' });
  }
  deletePlatformUserRow(req.params.id);
  if (req.platformUser.id === req.params.id) req.session.destroy(() => {});
  res.json({ ok: true });
});

// ---- Platform email settings — switching providers later is a settings change here, not a
// redeploy. Admin-only, same split as staff management and platform updates above; support
// can see tenants are affected by a mail outage but can't change how mail is configured. ----
router.get('/mail-settings', requirePlatformAdmin, (req, res) => {
  res.json(getPlatformMailConfig());
});

router.post('/mail-settings', requirePlatformAdmin, (req, res) => {
  const b = req.body || {};
  if (typeof b.from === 'string' && b.from && !isValidEmail(b.from) && !isValidEmail((b.from.match(/<([^>]+)>/) || [])[1])) {
    return res.status(400).json({ error: 'invalid_input', message: 'From address doesn’t look valid — use "name@example.com" or "Display Name <name@example.com>".' });
  }
  res.json(setPlatformMailConfig(b));
});

router.post('/mail-settings/test', requirePlatformAdmin, async (req, res) => {
  const { to } = req.body || {};
  if (!isValidEmail(to)) return res.status(400).json({ error: 'invalid_input', message: 'Enter a valid test recipient address.' });
  const result = await sendPlatformMail({
    to, subject: 'Craftium platform email test',
    text: 'If you got this, the platform\'s outgoing email settings are working.',
    html: '<p>If you got this, the platform\'s outgoing email settings are working.</p>',
  });
  if (!result.ok) return res.status(502).json({ error: 'send_failed', message: result.error });
  res.json({ ok: true });
});

module.exports = router;
