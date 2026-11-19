// Creates a new tenant end to end: a control-plane row, a fresh per-tenant database (schema +
// seeds, via the same openDatabase() a request-time pool connection uses), and its first admin
// user — reusing createUserRow(), the same insert /api/auth/setup uses for a single-tenant
// install's first account. Runs outside any request's tenant context (the tenant doesn't exist
// yet), so it opens its own connection directly rather than going through the db Proxy/pool.
const path = require('path');
const fs = require('fs');
const { openDatabase } = require('../db/migrate');
const { createUserRow } = require('../lib/users');
const pool = require('./pool');
const controlDb = require('../control/db');
const { isValidSlug } = require('./resolveTenant');

class ProvisionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function assertSlugAvailable(slug) {
  if (!isValidSlug(slug)) {
    throw new ProvisionError('invalid_slug', 'That subdomain isn’t allowed — lowercase letters, numbers, and hyphens only (3–32 characters), not starting or ending with a hyphen.');
  }
  if (controlDb.getTenantBySlug(slug)) throw new ProvisionError('slug_taken', 'That subdomain is already in use.');
}

async function provisionTenant({ businessName, slug, ownerName, username, password }) {
  businessName = String(businessName || '').trim();
  slug = String(slug || '').trim().toLowerCase();
  username = String(username || '').trim();
  if (!businessName) throw new ProvisionError('invalid_input', 'Business name is required.');
  if (!username) throw new ProvisionError('invalid_input', 'Username is required.');
  if (!password || password.length < 8) throw new ProvisionError('invalid_input', 'Password must be at least 8 characters.');
  assertSlugAvailable(slug);

  const tenantId = controlDb.newTenantId();
  const now = Date.now();
  // Inserted as 'provisioning' first — the UNIQUE(slug) constraint is what actually resolves a
  // race between two signups for the same subdomain; whichever insert loses gets a constraint
  // error here and reports slug_taken to its caller, same as the pre-check above catching the
  // common case.
  try {
    controlDb.insertTenant({ id: tenantId, slug, business_name: businessName, status: 'provisioning', plan: 'trial', created_at: now, updated_at: now });
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
  return controlDb.getTenantById(tenantId);
}

module.exports = { provisionTenant, ProvisionError, assertSlugAvailable };
