const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { getBool, setBool } = require('../lib/settings');

const router = express.Router();
router.use(requireAdmin);

router.get('/', (req, res) => {
  res.json({ trackSaleAttribution: getBool('trackSaleAttribution', true) });
});

router.post('/', (req, res) => {
  const { trackSaleAttribution } = req.body || {};
  if (typeof trackSaleAttribution === 'boolean') setBool('trackSaleAttribution', trackSaleAttribution);
  res.json({ trackSaleAttribution: getBool('trackSaleAttribution', true) });
});

module.exports = router;
