const express = require('express');
const db = require('../db');
const { uid } = require('../lib/ids');
const { requireEventManage, requireAdmin } = require('../middleware/auth');

const router = express.Router();

const toPublic = (r) => ({ id: r.id, state: r.state, salesTaxRate: r.sales_tax_rate, cashTaxRate: r.cash_tax_rate, createdAt: r.created_at });

// Read access matches event management (admin + manager + lead) — the event form's "fill
// from preset" button needs this list. Managing the list itself (add/edit/delete) is
// Settings-only, below, same split as the materials "sources" list.
router.get('/', requireEventManage, (req, res) => {
  const rows = db.prepare('SELECT * FROM tax_presets ORDER BY state COLLATE NOCASE').all();
  res.json(rows.map(toPublic));
});

router.post('/', requireAdmin, (req, res) => {
  const b = req.body || {};
  const state = String(b.state || '').trim();
  if (!state) return res.status(400).json({ error: 'invalid_input', message: 'A state name is required.' });
  const row = {
    id: b.id || uid(),
    state,
    sales_tax_rate: b.salesTaxRate === '' || b.salesTaxRate == null ? null : Number(b.salesTaxRate),
    cash_tax_rate: b.cashTaxRate === '' || b.cashTaxRate == null ? null : Number(b.cashTaxRate),
    created_at: b.createdAt || Date.now(),
  };
  db.prepare(`
    INSERT INTO tax_presets (id, state, sales_tax_rate, cash_tax_rate, created_at) VALUES (@id, @state, @sales_tax_rate, @cash_tax_rate, @created_at)
    ON CONFLICT(id) DO UPDATE SET state=@state, sales_tax_rate=@sales_tax_rate, cash_tax_rate=@cash_tax_rate
  `).run(row);
  res.json(toPublic(row));
});

router.delete('/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM tax_presets WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
