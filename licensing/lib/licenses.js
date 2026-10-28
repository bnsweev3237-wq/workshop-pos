const crypto = require('crypto');
const db = require('../db');

// CRFT-XXXX-XXXX-XXXX, uppercase alphanumerics minus visually ambiguous characters (0/O,
// 1/I/L) — meant to be read over the phone or typed by hand, not just copy-pasted. Checked
// for uniqueness against what's already issued, same pattern as items.item_no in the main
// app (a real UNIQUE constraint backs this up regardless).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genKey() {
  const group = () => Array.from({ length: 4 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
  const exists = db.prepare('SELECT 1 FROM licenses WHERE key = ?');
  let key;
  do { key = `CRFT-${group()}-${group()}-${group()}`; } while (exists.get(key));
  return key;
}

const toPublic = (row) => ({
  key: row.key,
  tenantName: row.tenant_name,
  tier: row.tier,
  status: row.status,
  featureFlags: JSON.parse(row.feature_flags_json),
  usageCaps: JSON.parse(row.usage_caps_json),
  notes: row.notes || '',
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function createLicense({ tenantName, tier = '', featureFlags = {}, usageCaps = {}, notes = '' }) {
  if (!tenantName || !tenantName.trim()) throw new Error('tenantName is required');
  const row = {
    id: crypto.randomUUID(),
    key: genKey(),
    tenant_name: tenantName.trim(),
    tier: tier || '',
    feature_flags_json: JSON.stringify(featureFlags || {}),
    usage_caps_json: JSON.stringify(usageCaps || {}),
    status: 'active',
    notes: notes || null,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  db.prepare(`
    INSERT INTO licenses (id, key, tenant_name, tier, feature_flags_json, usage_caps_json, status, notes, created_at, updated_at)
    VALUES (@id, @key, @tenant_name, @tier, @feature_flags_json, @usage_caps_json, @status, @notes, @created_at, @updated_at)
  `).run(row);
  return toPublic(row);
}

function getLicense(key) {
  const row = db.prepare('SELECT * FROM licenses WHERE key = ?').get(key);
  return row ? toPublic(row) : null;
}

function listLicenses() {
  return db.prepare('SELECT * FROM licenses ORDER BY created_at DESC').all().map(toPublic);
}

function updateLicense(key, patch) {
  const row = db.prepare('SELECT * FROM licenses WHERE key = ?').get(key);
  if (!row) throw new Error('No license with that key');
  const next = {
    tier: patch.tier !== undefined ? patch.tier : row.tier,
    feature_flags_json: patch.featureFlags !== undefined ? JSON.stringify(patch.featureFlags) : row.feature_flags_json,
    usage_caps_json: patch.usageCaps !== undefined ? JSON.stringify(patch.usageCaps) : row.usage_caps_json,
    status: patch.status !== undefined ? patch.status : row.status,
    notes: patch.notes !== undefined ? patch.notes : row.notes,
    updated_at: Date.now(),
    key,
  };
  db.prepare(`
    UPDATE licenses SET tier = @tier, feature_flags_json = @feature_flags_json, usage_caps_json = @usage_caps_json,
      status = @status, notes = @notes, updated_at = @updated_at
    WHERE key = @key
  `).run(next);
  return getLicense(key);
}

module.exports = { createLicense, getLicense, listLicenses, updateLicense };
