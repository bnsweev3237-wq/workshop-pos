const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { checkForUpdate, applyUpdate } = require('../lib/selfUpdate');

const router = express.Router();
router.use(requireAdmin);

let updating = false;

router.get('/check', async (req, res) => {
  try {
    res.json(await checkForUpdate());
  } catch (err) {
    res.status(502).json({ error: 'check_failed', message: err.message });
  }
});

router.post('/apply', async (req, res) => {
  if (updating) return res.status(409).json({ error: 'already_updating' });
  updating = true;
  try {
    await applyUpdate();
  } catch (err) {
    updating = false;
    return res.status(502).json({ error: 'update_failed', message: err.message });
  }
  res.json({ ok: true });
  // Exit after the response is flushed. A process manager (pm2, per the deploy docs) restarts
  // it running the new code; without one, the server just stops here until started by hand.
  setTimeout(() => process.exit(0), 300);
});

module.exports = router;
