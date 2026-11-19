// A per-install session secret, generated once and persisted to disk — never hardcoded,
// since a secret shared across every install of a resold product would let one leaked copy
// forge session cookies for every customer's install.
//
// Multi-tenant mode is different: one process serves every tenant's sessions (see
// server/index.js's session store, which is control-plane-backed there, not per-tenant), so
// there's one platform-wide secret rather than one per data directory — and it comes from an
// env var, not a generated-and-written file, so it survives a redeploy/container restart and
// can be rotated by the operator without touching disk.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isMultiTenant } = require('../mode');

const DATA_DIR = process.env.WORKSHOP_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const SECRET_PATH = path.join(DATA_DIR, 'session.secret');

function getSessionSecret() {
  if (isMultiTenant) {
    const secret = process.env.CRAFTIUM_SESSION_SECRET || '';
    if (secret.length < 32) {
      throw new Error('CRAFTIUM_SESSION_SECRET must be set to a random string of at least 32 characters in multi-tenant mode — refusing to boot with a weak or missing shared secret.');
    }
    return secret;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(SECRET_PATH)) return fs.readFileSync(SECRET_PATH, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
  return secret;
}

module.exports = { getSessionSecret };
