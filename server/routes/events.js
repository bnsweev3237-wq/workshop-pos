const express = require('express');
const db = require('../db');
const { uid } = require('../lib/ids');

const router = express.Router();
// Public: event setup (booth cost, tax rates) lives on the Sell page itself, so it stays
// reachable without login — same scoping as the rest of that page.

const toPublic = (r) => ({
  id: r.id, name: r.name, start: r.start, days: r.days, cost: r.cost, status: r.status,
  taxRate: r.tax_rate, cashTaxRate: r.cash_tax_rate,
  taxIncludedCash: !!r.tax_included_cash, taxIncludedOther: !!r.tax_included_other,
  test: !!r.test, createdAt: r.created_at, endedAt: r.ended_at,
});

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM events ORDER BY created_at DESC').all();
  res.json(rows.map(toPublic));
});

router.post('/', (req, res) => {
  const b = req.body || {};
  const row = {
    id: b.id || uid(),
    name: b.name || '',
    start: b.start,
    days: Math.max(1, Math.round(Number(b.days)) || 1),
    cost: Number(b.cost) || 0,
    status: b.status || 'open',
    tax_rate: b.taxRate === '' || b.taxRate == null ? null : Number(b.taxRate),
    cash_tax_rate: b.cashTaxRate === '' || b.cashTaxRate == null ? null : Number(b.cashTaxRate),
    tax_included_cash: b.taxIncludedCash ? 1 : 0,
    tax_included_other: b.taxIncludedOther ? 1 : 0,
    test: b.test ? 1 : 0,
    created_at: b.createdAt || Date.now(),
    ended_at: b.endedAt || null,
  };
  db.prepare(`
    INSERT INTO events (id, name, start, days, cost, status, tax_rate, cash_tax_rate, tax_included_cash, tax_included_other, test, created_at, ended_at)
    VALUES (@id, @name, @start, @days, @cost, @status, @tax_rate, @cash_tax_rate, @tax_included_cash, @tax_included_other, @test, @created_at, @ended_at)
    ON CONFLICT(id) DO UPDATE SET name=@name, start=@start, days=@days, cost=@cost, status=@status,
      tax_rate=@tax_rate, cash_tax_rate=@cash_tax_rate, tax_included_cash=@tax_included_cash,
      tax_included_other=@tax_included_other, ended_at=@ended_at
  `).run(row);
  res.json(toPublic(db.prepare('SELECT * FROM events WHERE id = ?').get(row.id)));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
