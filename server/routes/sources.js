const express = require('express');
const db = require('../db');
const { uid } = require('../lib/ids');
const { requireManageItems, requireAdmin } = require('../middleware/auth');

const router = express.Router();

const toPublic = (r) => ({ id: r.id, name: r.name, createdAt: r.created_at });

// Read access matches materials (admin + manager) — the Materials tab's source dropdown
// needs this list. Managing the list itself (add/rename/delete) is Settings-only, below.
router.get('/', requireManageItems, (req, res) => {
  const rows = db.prepare('SELECT * FROM sources ORDER BY name COLLATE NOCASE').all();
  res.json(rows.map(toPublic));
});

router.post('/', requireAdmin, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'invalid_input' });
  const row = { id: b.id || uid(), name, created_at: b.createdAt || Date.now() };
  db.prepare(`
    INSERT INTO sources (id, name, created_at) VALUES (@id, @name, @created_at)
    ON CONFLICT(id) DO UPDATE SET name=@name
  `).run(row);
  res.json(toPublic(row));
});

router.delete('/:id', requireAdmin, (req, res) => {
  // Materials tagged with this source go back to untagged rather than being left pointing
  // at a deleted id — source_id references sources(id) with foreign keys enforced, so this
  // has to happen before the delete below, not after (same pitfall as event_charity_rules).
  db.prepare('UPDATE materials SET source_id = NULL WHERE source_id = ?').run(req.params.id);
  db.prepare('DELETE FROM sources WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
