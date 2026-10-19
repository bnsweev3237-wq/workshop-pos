const express = require('express');
const db = require('../db');
const { uid } = require('../lib/ids');
const { requireEventManage } = require('../middleware/auth');

const router = express.Router();
router.use(requireEventManage); // same roles as event management: admin, manager, lead

// category '' means "all sales at this event" — see schema.sql for why it's '' and not NULL.
const toPublic = (r) => ({ id: r.id, eventId: r.event_id, category: r.category, allSales: r.category === '', charityPct: r.charity_pct });

router.get('/', (req, res) => {
  const eventId = req.query.eventId;
  if (!eventId) return res.status(400).json({ error: 'missing_event_id' });
  const rows = db.prepare('SELECT * FROM event_charity_rules WHERE event_id = ? ORDER BY category').all(eventId);
  res.json(rows.map(toPublic));
});

router.post('/', (req, res) => {
  const { eventId, category, allSales, charityPct } = req.body || {};
  const cat = allSales ? '' : String(category || '').trim();
  if (!eventId || (!allSales && !cat) || charityPct == null || charityPct === '') {
    return res.status(400).json({ error: 'invalid_input' });
  }
  const pct = Math.max(0, Math.min(100, Number(charityPct) || 0));
  db.prepare(`
    INSERT INTO event_charity_rules (id, event_id, category, charity_pct, created_at)
    VALUES (@id, @eventId, @category, @pct, @createdAt)
    ON CONFLICT(event_id, category) DO UPDATE SET charity_pct = excluded.charity_pct
  `).run({ id: uid(), eventId, category: cat, pct, createdAt: Date.now() });
  res.json(toPublic(db.prepare('SELECT * FROM event_charity_rules WHERE event_id = ? AND category = ?').get(eventId, cat)));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM event_charity_rules WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
