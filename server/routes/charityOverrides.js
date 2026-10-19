const express = require('express');
const db = require('../db');
const { requireEventManage } = require('../middleware/auth');

const router = express.Router();
router.use(requireEventManage); // same roles as event management: admin, manager, lead

const toPublic = (r) => ({ eventId: r.event_id, itemId: r.item_id, charityPct: r.charity_pct });

router.get('/', (req, res) => {
  const eventId = req.query.eventId;
  if (!eventId) return res.status(400).json({ error: 'missing_event_id' });
  const rows = db.prepare('SELECT * FROM event_charity_overrides WHERE event_id = ?').all(eventId);
  res.json(rows.map(toPublic));
});

router.post('/', (req, res) => {
  const { eventId, itemId, charityPct } = req.body || {};
  if (!eventId || !itemId || charityPct == null || charityPct === '') {
    return res.status(400).json({ error: 'invalid_input' });
  }
  const pct = Math.max(0, Math.min(100, Number(charityPct) || 0));
  db.prepare(`
    INSERT INTO event_charity_overrides (event_id, item_id, charity_pct) VALUES (?, ?, ?)
    ON CONFLICT(event_id, item_id) DO UPDATE SET charity_pct = excluded.charity_pct
  `).run(eventId, itemId, pct);
  res.json({ eventId, itemId, charityPct: pct });
});

router.delete('/:eventId/:itemId', (req, res) => {
  db.prepare('DELETE FROM event_charity_overrides WHERE event_id = ? AND item_id = ?').run(req.params.eventId, req.params.itemId);
  res.json({ ok: true });
});

module.exports = router;
