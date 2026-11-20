// The control-plane database itself — a single, ordinary (non-Proxied) better-sqlite3
// connection, same pattern as the old single-tenant db/index.js. It's never routed through the
// per-request tenant Proxy: control-plane code always knows exactly which db it means.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { uid } = require('../lib/ids');
const { DATA_ROOT } = require('../tenancy/pool');

const CONTROL_DB_PATH = path.join(DATA_ROOT, 'control.db');

let db = null;
function getControlDb() {
  if (db) return db;
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  db = new Database(CONTROL_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  return db;
}

function newTenantId() {
  // t_ prefix + a uid with its hyphens stripped, so it always satisfies tenancy/pool.js's
  // ID_RE (used to build a filesystem path) without that regex needing to special-case uid()'s
  // own format.
  return 't_' + uid().replace(/-/g, '');
}

function getTenantBySlug(slug) {
  return getControlDb().prepare('SELECT * FROM tenants WHERE slug = ? COLLATE NOCASE').get(slug);
}
function getTenantById(id) {
  return getControlDb().prepare('SELECT * FROM tenants WHERE id = ?').get(id);
}
function listTenants({ status } = {}) {
  const cdb = getControlDb();
  if (status) return cdb.prepare('SELECT * FROM tenants WHERE status = ? ORDER BY created_at').all(status);
  return cdb.prepare('SELECT * FROM tenants ORDER BY created_at').all();
}
function insertTenant(row) {
  getControlDb().prepare(`
    INSERT INTO tenants (id, slug, business_name, status, plan, created_at, updated_at)
    VALUES (@id, @slug, @business_name, @status, @plan, @created_at, @updated_at)
  `).run(row);
}
function updateTenantStatus(id, status) {
  getControlDb().prepare('UPDATE tenants SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
}
function updateTenantPlan(id, plan) {
  getControlDb().prepare('UPDATE tenants SET plan = ?, updated_at = ? WHERE id = ?').run(plan, Date.now(), id);
}
function deleteTenantRow(id) {
  getControlDb().prepare('DELETE FROM tenants WHERE id = ?').run(id);
}
function addAuditLog(tenantId, actor, action, detail) {
  getControlDb().prepare('INSERT INTO audit_log (id, tenant_id, actor, action, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uid(), tenantId, actor || null, action, detail ? JSON.stringify(detail) : null, Date.now());
}

// ---- Platform staff accounts (server/lib/platformUsers.js inserts rows; these just read/manage) ----
function getPlatformUserByUsername(username) {
  return getControlDb().prepare('SELECT * FROM platform_users WHERE username = ? COLLATE NOCASE').get(username);
}
function listPlatformUsers() {
  return getControlDb().prepare('SELECT id, username, role, created_at FROM platform_users ORDER BY created_at').all();
}
function deletePlatformUserRow(id) {
  return getControlDb().prepare('DELETE FROM platform_users WHERE id = ?').run(id);
}

// ---- Support sessions (the impersonation mechanism — see server/routes/auth.js's
// /impersonate/:token consume route and server/routes/platformAdmin.js's mint route) ----
function insertSupportSession(row) {
  getControlDb().prepare(`
    INSERT INTO support_sessions (id, tenant_id, platform_user_id, created_at, expires_at)
    VALUES (@id, @tenant_id, @platform_user_id, @created_at, @expires_at)
  `).run(row);
}
function getSupportSession(id) {
  return getControlDb().prepare('SELECT * FROM support_sessions WHERE id = ?').get(id);
}
function markSupportSessionConsumed(id, consumedAt = Date.now()) {
  getControlDb().prepare('UPDATE support_sessions SET consumed_at = ? WHERE id = ?').run(consumedAt, id);
}
// The "while a support session is active" banner — a safety cap (maxAgeMs) treats a consumed
// session as ended once it's old enough even if nobody explicitly ended it, so a forgotten tab
// doesn't show the banner forever.
function getActiveSupportSessionForTenant(tenantId, maxAgeMs) {
  return getControlDb().prepare(`
    SELECT * FROM support_sessions
    WHERE tenant_id = ? AND consumed_at IS NOT NULL AND ended_at IS NULL AND consumed_at > ?
    ORDER BY consumed_at DESC LIMIT 1
  `).get(tenantId, Date.now() - maxAgeMs);
}
// Either side (the support agent's own session, or the tenant's real admin) can end it —
// neither needs to know the token id, just which tenant they're on.
function endActiveSupportSessionForTenant(tenantId) {
  getControlDb().prepare('UPDATE support_sessions SET ended_at = ? WHERE tenant_id = ? AND consumed_at IS NOT NULL AND ended_at IS NULL')
    .run(Date.now(), tenantId);
}

module.exports = {
  getControlDb, CONTROL_DB_PATH, newTenantId, getTenantBySlug, getTenantById, listTenants,
  insertTenant, updateTenantStatus, updateTenantPlan, deleteTenantRow, addAuditLog,
  getPlatformUserByUsername, listPlatformUsers, deletePlatformUserRow,
  insertSupportSession, getSupportSession, markSupportSessionConsumed,
  getActiveSupportSessionForTenant, endActiveSupportSessionForTenant,
};
