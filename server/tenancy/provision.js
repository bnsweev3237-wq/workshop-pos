// Creates a new tenant end to end: a control-plane row, a fresh per-tenant database (schema +
// seeds, via the same openDatabase() a request-time pool connection uses), and its first admin
// user — reusing createUserRow(), the same insert /api/auth/setup uses for a single-tenant
// install's first account. Runs outside any request's tenant context (the tenant doesn't exist
// yet), so it opens its own connection directly rather than going through the db Proxy/pool.
const path = require('path');
const fs = require('fs');
const { openDatabase } = require('../db/migrate');
const { createUserRow } = require('../lib/users');
const { uid } = require('../lib/ids');
const pool = require('./pool');
const controlDb = require('../control/db');
const { isValidSlug, baseDomain } = require('./resolveTenant');
const { isValidEmail, sendPlatformMail } = require('../lib/platformMail');

const EMAIL_VERIFY_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours — generous; a real customer may not check email right away

class ProvisionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function assertSlugAvailable(slug) {
  if (!isValidSlug(slug)) {
    throw new ProvisionError('invalid_slug', 'That subdomain isn’t allowed — lowercase letters, numbers, and hyphens only (3–32 characters), not starting or ending with a hyphen.');
  }
  if (controlDb.getTenantBySlug(slug)) throw new ProvisionError('slug_taken', 'That subdomain is already in use.');
}

// skipVerification: true for an operator-created tenant (scripts/tenant-admin.js create) —
// already vetted out of band, so it's active and logged-in-able immediately, same as every
// tenant before this feature existed. false (the default) is the real HTTP signup path: email
// is required and unverified until the owner clicks the link sent to it.
async function provisionTenant({ businessName, slug, ownerName, username, password, email, skipVerification = false }) {
  businessName = String(businessName || '').trim();
  slug = String(slug || '').trim().toLowerCase();
  username = String(username || '').trim();
  email = String(email || '').trim();
  if (!businessName) throw new ProvisionError('invalid_input', 'Business name is required.');
  if (!username) throw new ProvisionError('invalid_input', 'Username is required.');
  if (!password || password.length < 8) throw new ProvisionError('invalid_input', 'Password must be at least 8 characters.');
  if (!isValidEmail(email)) throw new ProvisionError('invalid_input', 'A valid email address is required.');
  assertSlugAvailable(slug);

  const tenantId = controlDb.newTenantId();
  const now = Date.now();
  const verifyToken = skipVerification ? null : uid();
  // Inserted as 'provisioning' first — the UNIQUE(slug) constraint is what actually resolves a
  // race between two signups for the same subdomain; whichever insert loses gets a constraint
  // error here and reports slug_taken to its caller, same as the pre-check above catching the
  // common case.
  try {
    controlDb.insertTenant({
      id: tenantId, slug, business_name: businessName, status: 'provisioning', plan: 'trial',
      owner_email: email,
      email_verified_at: skipVerification ? now : null,
      email_verify_token: verifyToken,
      email_verify_expires_at: verifyToken ? now + EMAIL_VERIFY_TTL_MS : null,
      created_at: now, updated_at: now,
    });
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) throw new ProvisionError('slug_taken', 'That subdomain is already in use.');
    throw err;
  }

  try {
    const dbPath = pool.dbPathFor(tenantId);
    const tdb = openDatabase(dbPath, { fileMustExist: false });
    try {
      createUserRow(tdb, { name: ownerName || username, username, password, role: 'admin', mustChangePassword: false, createdAt: now });
      tdb.prepare("INSERT INTO settings (key, value) VALUES ('brandingName', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(businessName);
    } finally {
      tdb.close();
    }
  } catch (err) {
    // Roll back: a half-created tenant must never be left reachable. Remove the control-plane
    // row and any tenant directory that got created before the failure.
    controlDb.deleteTenantRow(tenantId);
    try { fs.rmSync(path.dirname(pool.dbPathFor(tenantId)), { recursive: true, force: true }); } catch { /* best effort */ }
    throw err;
  }

  controlDb.updateTenantStatus(tenantId, 'active');
  controlDb.addAuditLog(tenantId, username, 'tenant_provisioned', { slug, businessName });

  if (verifyToken) {
    const verifyUrl = `https://${slug}.${baseDomain()}/api/auth/verify-email/${verifyToken}`;
    // Fire-and-forget-ish: awaited so a real failure is visible to the caller's own logs, but
    // never thrown — a bounced/misdelivered verification email must not undo an otherwise-
    // successful signup (retrying would just hit slug_taken). The customer's path back is
    // POST /api/auth/resend-verification.
    const result = await sendPlatformMail({
      to: email,
      subject: 'Verify your email to activate your Craftium shop',
      text: `Welcome to Craftium! Click the link below to verify your email and activate "${businessName}":\n\n${verifyUrl}\n\nThis link expires in 48 hours.`,
      html: `<p>Welcome to Craftium! Click the link below to verify your email and activate <b>${businessName}</b>:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>This link expires in 48 hours.</p>`,
    });
    if (!result.ok) console.error(`Verification email failed to send for tenant ${slug}:`, result.error);
  }

  return controlDb.getTenantById(tenantId);
}

module.exports = { provisionTenant, ProvisionError, assertSlugAvailable };
