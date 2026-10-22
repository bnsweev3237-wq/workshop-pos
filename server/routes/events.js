const express = require('express');
const db = require('../db');
const { uid } = require('../lib/ids');
const { requireLogin, requireEventManage } = require('../middleware/auth');

const router = express.Router();

const selectedItemIds = (eventId) => db.prepare('SELECT item_id FROM event_items WHERE event_id = ?').all(eventId).map((r) => r.item_id);

const toPublic = (r) => ({
  id: r.id, name: r.name, start: r.start, days: r.days, cost: r.cost, status: r.status,
  taxRate: r.tax_rate, cashTaxRate: r.cash_tax_rate,
  taxIncludedCash: !!r.tax_included_cash, taxIncludedOther: !!r.tax_included_other,
  test: !!r.test, itemScope: r.item_scope || 'all',
  // Only worth the extra query when it actually matters — 'all' (the common case) doesn't
  // restrict anything, so the Sell page never needs this list for those events.
  selectedItemIds: r.item_scope === 'selected' ? selectedItemIds(r.id) : [],
  createdAt: r.created_at, endedAt: r.ended_at,
});

// Viewing events (the break-even bar, past-event history) is fine for anyone logged in,
// cashiers included — they just can't create, edit, or end one (see requireEventManage below).
// selectedItemIds travels with every event here (not a separate per-event fetch) since the
// Sell page needs it immediately, for whichever event happens to be open, to know which items
// to show at all.
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
    item_scope: b.itemScope === 'selected' ? 'selected' : 'all',
    created_at: b.createdAt || Date.now(),
    ended_at: b.endedAt || null,
  };
  db.prepare(`
    INSERT INTO events (id, name, start, days, cost, status, tax_rate, cash_tax_rate, tax_included_cash, tax_included_other, test, item_scope, created_at, ended_at)
    VALUES (@id, @name, @start, @days, @cost, @status, @tax_rate, @cash_tax_rate, @tax_included_cash, @tax_included_other, @test, @item_scope, @created_at, @ended_at)
    ON CONFLICT(id) DO UPDATE SET name=@name, start=@start, days=@days, cost=@cost, status=@status,
      tax_rate=@tax_rate, cash_tax_rate=@cash_tax_rate, tax_included_cash=@tax_included_cash,
      tax_included_other=@tax_included_other, item_scope=@item_scope, ended_at=@ended_at
  `).run(row);
  res.json(toPublic(db.prepare('SELECT * FROM events WHERE id = ?').get(row.id)));
});

// Replaces the full set of items selected for this event in one go — a checklist, not
// individually added/removed rows, so one call on save beats a network round trip per
// checkbox. Silently drops any id that isn't a real item rather than erroring, since the
// list only ever comes from the item picker in the first place.
router.post('/:id/items', requireEventManage, (req, res) => {
  const event = db.prepare('SELECT id FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'not_found' });
  const ids = Array.isArray(req.body?.itemIds) ? [...new Set(req.body.itemIds)] : [];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM event_items WHERE event_id = ?').run(event.id);
    const insert = db.prepare('INSERT OR IGNORE INTO event_items (event_id, item_id) VALUES (?, ?)');
    const itemExists = db.prepare('SELECT 1 FROM items WHERE id = ?');
    for (const itemId of ids) {
      if (itemExists.get(itemId)) insert.run(event.id, itemId);
    }
  });
  tx();
  res.json({ ok: true, itemIds: selectedItemIds(event.id) });
});

// Deletes any charity rules and item selections for this event first — both reference
// events(id) with foreign keys enforced, so deleting an event that still has either attached
// would otherwise fail outright (and silently, from the UI's point of view).
router.delete('/:id', requireEventManage, (req, res) => {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM event_charity_rules WHERE event_id = ?').run(req.params.id);
    db.prepare('DELETE FROM event_items WHERE event_id = ?').run(req.params.id);
    db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  });
  tx();
  res.json({ ok: true });
});

module.exports = router;
