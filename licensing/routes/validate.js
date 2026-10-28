const express = require('express');
const rateLimit = require('express-rate-limit');
const { getLicense } = require('../lib/licenses');

const router = express.Router();

// A Craftium instance calls this with its own license key — no other auth, since the key
// itself is the credential (same model as an API key). Rate-limited per IP mainly to blunt
// brute-force key guessing, not because legitimate traffic is heavy: each instance only
// calls this once a day on its own schedule, plus an occasional manual "Check now".
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
});

router.post('/', limiter, (req, res) => {
  const key = String(req.body?.key || '').trim();
  if (!key) return res.status(400).json({ error: 'invalid_input', message: 'A license key is required.' });
  const license = getLicense(key);
  if (!license) return res.status(404).json({ error: 'invalid_key' });
  res.json({
    ok: true,
    status: license.status,
    tier: license.tier,
    featureFlags: license.featureFlags,
    usageCaps: license.usageCaps,
    licensedTo: license.tenantName,
    checkedAt: Date.now(),
  });
});

module.exports = router;
