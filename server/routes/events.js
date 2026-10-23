const express = require('express');
const db = require('../db');
const { uid } = require('../lib/ids');
const { requireLogin, requireEventManage } = require('../middleware/auth');

const router = express.Router();

const selectedItems = (eventId) => db.prepare('SELECT item_id, qty_brought FROM event_items WHERE event_id = ?').all(eventId)
  .map((r) => ({ itemId: r.item_id, qtyBrought: r.qty_brought }));

const toPublic = (r) => ({
  id: r.id, name: r.name, start: r.start, days: r.days, cost: r.cost, status: r.status,
  taxRate: r.tax_rate, cashTaxRate: r.cash_tax_rate,
  taxIncludedCash: !!r.tax_included_cash, taxIncludedOther: !!r.tax_included_other,
  test: !!r.test, itemScope: r.item_scope || 'all',
  // Only worth the extra query when it actually matters — 'all' (the common case) doesn't
  // restrict anything, so the Sell page never needs this list for those events.
  selectedItems: r.item_scope === 'selected' ? selectedItems(r.id) : [],
  createdAt: r.created_at, endedAt: r.ended_at,
});

// Viewing events (the break-even bar, past-event history, the Upcoming/draft list) is fine
// for anyone logged in, cashiers included — they just can't create, edit, or end one (see
// requireEventManage below). selectedItems travels with every event here (not a separate
// per-event fetch) since the Sell page needs it immediately, for whichever event happens to
// be open, to know which items — and how many of each — to show at all.
router.get('/', requireLogin, (req, res) => {
  const rows = db.prepare('SELECT * FROM events ORDER BY created_at DESC').all();
  res.json(rows.map(toPublic));
});

router.post('/', requireEventManage, (req, res) => {
  const b = req.body || {};
  const status = ['draft', 'open', 'ended'].includes(b.status) ? b.status : 'open';
  const test = b.test ? 1 : 0;
  // At most one OPEN event per test/real side at a time — everything else (the break-even
  // bar, the Sell page's item scope, charity rules) assumes there's a single current event,
  // so two at once would make that ambiguous. Draft events have no such limit; there can be
  // as many "ready to go" as you want.
  if (status === 'open') {
    const other = db.prepare("SELECT id FROM events WHERE status = 'open' AND test = ? AND id != ?").get(test, b.id || '');
    if (other) return res.status(409).json({ error: 'event_already_open', message: 'Another event is already open — end it before starting this one.' });
  }
  const row = {
    id: b.id || uid(),
    name: b.name || '',
    start: b.start,
    days: Math.max(1, Math.round(Number(b.days)) || 1),
    cost: Number(b.cost) || 0,
    status,
    tax_rate: b.taxRate === '' || b.taxRate == null ? null : Number(b.taxRate),
    cash_tax_rate: b.cashTaxRate === '' || b.cashTaxRate == null ? null : Number(b.cashTaxRate),
    tax_included_cash: b.taxIncludedCash ? 1 : 0,
    tax_included_other: b.taxIncludedOther ? 1 : 0,
    test,
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

// Replaces the full set of items selected for this event (and how many of each are being
// brought) in one go — a checklist, not individually added/removed rows, so one call on save
// beats a network round trip per checkbox. Silently drops any id that isn't a real item
// rather than erroring, since the list only ever comes from the item picker in the first place.
router.post('/:id/items', requireEventManage, (req, res) => {
  const event = db.prepare('SELECT id FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'not_found' });
  const entries = Array.isArray(req.body?.items) ? req.body.items : [];
  const byId = new Map();
  for (const e of entries) {
    if (!e || !e.itemId) continue;
    const qty = e.qtyBrought === '' || e.qtyBrought == null ? null : Number(e.qtyBrought);
    byId.set(e.itemId, qty != null && isFinite(qty) ? qty : null);
  }
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM event_items WHERE event_id = ?').run(event.id);
    const insert = db.prepare('INSERT OR IGNORE INTO event_items (event_id, item_id, qty_brought) VALUES (?, ?, ?)');
    const itemExists = db.prepare('SELECT 1 FROM items WHERE id = ?');
    for (const [itemId, qty] of byId) {
      if (itemExists.get(itemId)) insert.run(event.id, itemId, qty);
    }
  });
  tx();
  res.json({ ok: true, items: selectedItems(event.id) });
});

// Deletes any charity rules and item selections for this event first — both reference
// events(id) with foreign keys enforced, so deleting an event that still has either attached
// would otherwise fail outright (and silently, from the UI's point of view). sales and
// voided_sales also reference events(id), but those are financial/audit records worth
// keeping even once the event itself is gone — so those just get detached (event_id set to
// NULL, which the schema allows) rather than deleted.
router.delete('/:id', requireEventManage, (req, res) => {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM event_charity_rules WHERE event_id = ?').run(req.params.id);
    db.prepare('DELETE FROM event_items WHERE event_id = ?').run(req.params.id);
    db.prepare('UPDATE sales SET event_id = NULL WHERE event_id = ?').run(req.params.id);
    db.prepare('UPDATE voided_sales SET event_id = NULL WHERE event_id = ?').run(req.params.id);
    db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  });
  tx();
  res.json({ ok: true });
});

module.exports = router;
