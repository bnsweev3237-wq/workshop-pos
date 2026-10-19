const express = require('express');
const db = require('../db');
const { uid } = require('../lib/ids');
const { requireLogin, requireEventManage } = require('../middleware/auth');

const router = express.Router();

const toPublic = (r) => ({
  id: r.id, name: r.name, start: r.start, days: r.days, cost: r.cost, status: r.status,
  taxRate: r.tax_rate, cashTaxRate: r.cash_tax_rate,
  taxIncludedCash: !!r.tax_included_cash, taxIncludedOther: !!r.tax_included_other,
  test: !!r.test, createdAt: r.created_at, endedAt: r.ended_at,
});

// Viewing events (the break-even bar, past-event history) is fine for anyone logged in,
// cashiers included — they just can't create, edit, or end one (see requireEventManage below).
router.get('/', requireLogin, (req, res) => {
  const rows = db.prepare('SELECT * FROM events ORDER BY created_at DESC').all();
  res.json(rows.map(toPublic));
});

router.post('/', requireEventManage, (req, res) => {
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

// sales.event_id also references events(id) with foreign keys enforced, so an event with any
// sales recorded against it couldn't be deleted either — same silent-failure shape the
// charity-rules fix above addressed. Real sales are revenue history, not disposable the way
// test data is, so rather than cascading through them we block the delete and say why. Test
// sales are practice data (same philosophy as purgeTestData) and get cleared along with the
// event's charity rules.
router.delete('/:id', requireEventManage, (req, res) => {
  const eventId = req.params.id;
  const realSales = db.prepare('SELECT COUNT(*) AS n FROM sales WHERE event_id = ? AND test = 0').get(eventId).n;
  if (realSales > 0) {
    return res.status(409).json({
      error: 'event_has_sales',
      message: `This event has ${realSales} recorded sale${realSales === 1 ? '' : 's'} against it — delete those first if you really want to remove the event.`,
    });
  }
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM sales WHERE event_id = ?').run(eventId);
    db.prepare('DELETE FROM event_charity_rules WHERE event_id = ?').run(eventId);
    db.prepare('DELETE FROM events WHERE id = ?').run(eventId);
  });
  tx();
  res.json({ ok: true });
});

module.exports = router;
