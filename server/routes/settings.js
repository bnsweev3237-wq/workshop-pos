const express = require('express');
const db = require('../db');
const { requireAdmin, requireLogin } = require('../middleware/auth');
const { getBool, setBool, getSetting, setSetting } = require('../lib/settings');

const router = express.Router();

// Read-only for anyone logged in — Reports (open to admin/manager/lead) needs to know
// whether to show the "Sales by user" breakdown or explain why it's off, and the Sell page
// (every role) needs defaultCardProcessorId to preselect a processor when tendering by card.
// Only the Settings page itself (admin-only) can change either.
router.get('/', requireLogin, (req, res) => {
  res.json({ trackSaleAttribution: getBool('trackSaleAttribution', true), defaultCardProcessorId: getSetting('defaultCardProcessorId', '') });
});

router.post('/', requireAdmin, (req, res) => {
  const { trackSaleAttribution, defaultCardProcessorId } = req.body || {};
  if (typeof trackSaleAttribution === 'boolean') setBool('trackSaleAttribution', trackSaleAttribution);
  if (typeof defaultCardProcessorId === 'string') {
    // Normalize a stale/unknown id to "no default" instead of storing a dangling reference —
    // e.g. the processor it pointed at was deleted since the dropdown that sent this was built.
    const valid = defaultCardProcessorId === '' || db.prepare('SELECT 1 FROM card_processors WHERE id = ?').get(defaultCardProcessorId);
    setSetting('defaultCardProcessorId', valid ? defaultCardProcessorId : '');
  }
  res.json({ trackSaleAttribution: getBool('trackSaleAttribution', true), defaultCardProcessorId: getSetting('defaultCardProcessorId', '') });
});

module.exports = router;
