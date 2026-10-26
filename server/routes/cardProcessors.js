const express = require('express');
const db = require('../db');
const { uid } = require('../lib/ids');
const { requireLogin, requireAdmin } = require('../middleware/auth');

const router = express.Router();

const toPublic = (r) => ({ id: r.id, name: r.name, feePct: r.fee_pct, feeFixed: r.fee_fixed, enabled: !!r.enabled, createdAt: r.created_at });

// Read access is any logged-in role, not just admin/manager/lead like sources/tax presets —
// the Sell page's card-processor picker needs this list for every role, cashier included.
// Managing the list itself (add/edit/delete, and the fee rates that drive Reports' "true
// profit minus fees") is Settings-only, below.
router.get('/', requireLogin, (req, res) => {
  const rows = db.prepare('SELECT * FROM card_processors ORDER BY name COLLATE NOCASE').all();
  res.json(rows.map(toPublic));
});

router.post('/', requireAdmin, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'invalid_input', message: 'A processor name is required.' });
  const feePct = Math.min(100, Math.max(0, Number(b.feePct) || 0));
  const feeFixed = Math.max(0, Number(b.feeFixed) || 0);
  const row = { id: b.id || uid(), name, fee_pct: feePct, fee_fixed: feeFixed, created_at: b.createdAt || Date.now() };
  db.prepare(`
    INSERT INTO card_processors (id, name, fee_pct, fee_fixed, created_at) VALUES (@id, @name, @fee_pct, @fee_fixed, @created_at)
    ON CONFLICT(id) DO UPDATE SET name=@name, fee_pct=@fee_pct, fee_fixed=@fee_fixed
  `).run(row);
  // Re-read rather than echo the local object — `enabled` isn't in the INSERT above (a new row
  // gets it from the column's own DEFAULT 1), so the local object doesn't actually know its value.
  res.json(toPublic(db.prepare('SELECT * FROM card_processors WHERE id = ?').get(row.id)));
});

// Available on the Sell page or not — its own narrow endpoint (same idea as a user's role,
// below in auth.js) rather than folding it into the general upsert above, which only ever
// handles the add-new-processor form and doesn't know an existing row's other current fields.
router.post('/:id/enabled', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT id FROM card_processors WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  db.prepare('UPDATE card_processors SET enabled = ? WHERE id = ?').run(req.body?.enabled ? 1 : 0, row.id);
  res.json(toPublic(db.prepare('SELECT * FROM card_processors WHERE id = ?').get(row.id)));
});

router.delete('/:id', requireAdmin, (req, res) => {
  // Sales that used this processor keep their own name/fee snapshot (sales.card_processor/
  // card_fee) regardless — deleting the processor definition never rewrites past sales, same
  // reasoning as tax presets and custom order line items.
  db.prepare('DELETE FROM card_processors WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
