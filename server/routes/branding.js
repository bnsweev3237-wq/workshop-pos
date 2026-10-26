const express = require('express');
const { getSetting, setSetting } = require('../lib/settings');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

const HEX_RE = /^#[0-9a-f]{6}$/i;
const LOGO_RE = /^data:image\/(png|jpeg|jpg|webp|svg\+xml);base64,/i;
// ~1.5MB of actual image bytes once base64's ~33% overhead is backed out — plenty for a logo,
// small enough that it doesn't bloat every page/print load (the logo rides along as a data URL,
// not a separate request) or the sqlite backup file it lives in (see lib/settings).
const MAX_LOGO_CHARS = 2_000_000;

function toPublic() {
  return {
    name: getSetting('brandingName', ''),
    accentColor: getSetting('brandingAccent', ''),
    logo: getSetting('brandingLogo', ''),
  };
}

// Public, even logged out — the login screen itself picks up the logo/name/accent color, and
// none of this is sensitive (it's the same name/logo that ends up on printed receipts customers
// already see). Only Settings (admin-only) can change it.
router.get('/', (req, res) => res.json(toPublic()));

router.post('/', requireAdmin, (req, res) => {
  const { name, accentColor, logo } = req.body || {};
  if (typeof name === 'string') setSetting('brandingName', name.trim().slice(0, 80));
  if (typeof accentColor === 'string') {
    if (accentColor !== '' && !HEX_RE.test(accentColor)) return res.status(400).json({ error: 'invalid_color' });
    setSetting('brandingAccent', accentColor);
  }
  if (typeof logo === 'string') {
    if (logo !== '' && (logo.length > MAX_LOGO_CHARS || !LOGO_RE.test(logo))) return res.status(400).json({ error: 'invalid_logo' });
    setSetting('brandingLogo', logo);
  }
  res.json(toPublic());
});

module.exports = router;
