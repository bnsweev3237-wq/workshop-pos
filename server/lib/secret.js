// A per-install session secret, generated once and persisted to disk — never hardcoded,
// since a secret shared across every install of a resold product would let one leaked copy
// forge session cookies for every customer's install.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.WORKSHOP_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const SECRET_PATH = path.join(DATA_DIR, 'session.secret');

function getSessionSecret() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(SECRET_PATH)) return fs.readFileSync(SECRET_PATH, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
  return secret;
}

module.exports = { getSessionSecret };
