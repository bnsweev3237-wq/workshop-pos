const express = require('express');
const { requireAdmin, requireLogin } = require('../middleware/auth');
const { getBool, setBool } = require('../lib/settings');

const router = express.Router();

// Read-only for anyone logged in — Reports (open to admin/manager/lead) needs to know
// whether to show the "Sales by user" breakdown or explain why it's off. Only the Settings
// page itself (admin-only) can change it.
router.get('/', requireLogin, (req, res) => {
  res.json({ trackSaleAttribution: getBool('trackSaleAttribution', true) });
});

router.post('/', requireAdmin, (req, res) => {
  const { trackSaleAttribution } = req.body || {};
  if (typeof trackSaleAttribution === 'boolean') setBool('trackSaleAttribution', trackSaleAttribution);
  res.json({ trackSaleAttribution: getBool('trackSaleAttribution', true) });
});

module.exports = router;
