const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { getMailConfig, setMailConfig, sendMail } = require('../lib/mail');
const { checkLowStockAndEmail } = require('../lib/lowStockAlert');

const router = express.Router();
router.use(requireAdmin);

router.get('/', (req, res) => res.json(getMailConfig()));

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
router.post('/', (req, res) => {
  const b = req.body || {};
  // Only a non-empty value has to look like an address — clearing a field back to blank (to
  // turn email alerts back off, say) is always allowed.
  if (b.from && !EMAIL_RE.test(b.from)) return res.status(400).json({ error: 'invalid_from', message: 'That "from" address doesn’t look valid.' });
  if (b.alertRecipient && !EMAIL_RE.test(b.alertRecipient)) return res.status(400).json({ error: 'invalid_recipient', message: 'That recipient address doesn’t look valid.' });
  res.json(setMailConfig(b));
});

// Sends to the currently-configured alert recipient — proves the SMTP settings actually work
// (host reachable, auth accepted) before relying on them for an unattended daily check that
// nobody's watching when it runs. Returns the raw failure reason (bad host, auth rejected, …)
// rather than a generic "failed," since that's exactly what's needed to fix a misconfigured
// self-hosted setup.
router.post('/test', async (req, res) => {
  const { alertRecipient } = getMailConfig();
  if (!alertRecipient) return res.status(400).json({ error: 'no_recipient', message: 'Set an alert recipient email first.' });
  const result = await sendMail({
    to: alertRecipient, subject: 'Craftium test email',
    text: 'If you got this, your email alert settings are working.',
    html: '<p>If you got this, your email alert settings are working.</p>',
  });
  if (!result.ok) return res.status(502).json({ error: 'send_failed', message: result.error });
  res.json({ ok: true });
});

// Runs the same check the daily scheduler does, on demand — for trying it out right after
// setting it up instead of waiting for the next scheduled run (see server/lib/lowStockAlert.js).
router.post('/check-low-stock', async (req, res) => {
  const result = await checkLowStockAndEmail();
  res.json(result);
});

module.exports = router;
