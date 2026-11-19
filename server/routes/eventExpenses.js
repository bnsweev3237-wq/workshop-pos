const express = require('express');
const db = require('../db');
const { uid } = require('../lib/ids');
const { requireEventManage } = require('../middleware/auth');

const router = express.Router();
router.use(requireEventManage); // same roles as event management

const toPublic = (r) => ({ id: r.id, eventId: r.event_id, label: r.label, amount: r.amount, createdAt: r.created_at });

router.get('/', (req, res) => {
  const eventId = req.query.eventId;
  if (!eventId) return res.status(400).json({ error: 'missing_event_id' });
  const rows = db.prepare('SELECT * FROM event_expenses WHERE event_id = ? ORDER BY created_at').all(eventId);
  res.json(rows.map(toPublic));
});

router.post('/', (req, res) => {
  const { eventId, label, amount } = req.body || {};
  if (!eventId) return res.status(400).json({ error: 'missing_event_id' });
  const row = { id: uid(), event_id: eventId, label: (label || '').trim() || 'Expense', amount: Number(amount) || 0, created_at: Date.now() };
  db.prepare('INSERT INTO event_expenses (id, event_id, label, amount, created_at) VALUES (@id, @event_id, @label, @amount, @created_at)').run(row);
  res.json(toPublic(row));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM event_expenses WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
