const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { getLicenseKey, setLicenseKey, clearLicense, getLicenseStatus, checkLicense } = require('../lib/license');
const { isMultiTenant } = require('../mode');

const router = express.Router();
router.use(requireAdmin);

const maskedKey = (key) => (key ? key.replace(/^(.{4}).*(.{4})$/, '$1••••$2') : '');

// Read-only in multi-tenant mode — there's no key, just this tenant's plan (see
// server/lib/license.js's getMultiTenantLicenseStatus), shown the same way a self-hosted
// install's checked license would be. No `key` field: it'd be meaningless here.
router.get('/', (req, res) => {
  if (isMultiTenant) return res.json(getLicenseStatus());
  res.json({ key: maskedKey(getLicenseKey()), ...getLicenseStatus() });
});

// Entering, re-checking, or clearing a key only makes sense for a self-hosted install phoning
// home to the vendor's own licensing service — a multi-tenant tenant's plan is managed by the
// platform operator (scripts/tenant-admin.js set-plan), not by the tenant itself.
router.post('/', async (req, res) => {
  if (isMultiTenant) return res.status(403).json({ error: 'managed_by_platform', message: 'Your plan is managed by the platform — contact support to change it.' });
  const key = String(req.body?.key || '').trim();
  if (!key) return res.status(400).json({ error: 'invalid_input', message: 'A license key is required.' });
  setLicenseKey(key);
  const status = await checkLicense();
  res.json({ key: maskedKey(key), ...status });
});

router.post('/check', async (req, res) => {
  if (isMultiTenant) return res.status(403).json({ error: 'managed_by_platform' });
  const status = await checkLicense();
  res.json({ key: maskedKey(getLicenseKey()), ...status });
});

router.delete('/', (req, res) => {
  if (isMultiTenant) return res.status(403).json({ error: 'managed_by_platform' });
  clearLicense();
  res.json({ key: '', ...getLicenseStatus() });
});

module.exports = router;
