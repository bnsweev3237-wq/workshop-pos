const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { getLicenseKey, setLicenseKey, clearLicense, getLicenseStatus, checkLicense } = require('../lib/license');

const router = express.Router();
router.use(requireAdmin);

const maskedKey = (key) => (key ? key.replace(/^(.{4}).*(.{4})$/, '$1••••$2') : '');

router.get('/', (req, res) => {
  res.json({ key: maskedKey(getLicenseKey()), ...getLicenseStatus() });
});

router.post('/', async (req, res) => {
  const key = String(req.body?.key || '').trim();
  if (!key) return res.status(400).json({ error: 'invalid_input', message: 'A license key is required.' });
  setLicenseKey(key);
  const status = await checkLicense();
  res.json({ key: maskedKey(key), ...status });
});

router.post('/check', async (req, res) => {
  const status = await checkLicense();
  res.json({ key: maskedKey(getLicenseKey()), ...status });
});

router.delete('/', (req, res) => {
  clearLicense();
  res.json({ key: '', ...getLicenseStatus() });
});

module.exports = router;
