const express = require('express');
const db = require('../db');
const { uid } = require('../lib/ids');
const { requireReports, requireLogin } = require('../middleware/auth');
const { getBool } = require('../lib/settings');

const router = express.Router();

// Splits one ticket line's charge into its pre-tax and tax portions — ported 1:1 from the
// artifact's client-side version, just now computed authoritatively on the server instead of
// trusted from the client, since a tampered client could otherwise misreport a sale's total.
function lineTaxSplit(l, included) {
  const amt = (Number(l.price) || 0) * (Number(l.qty) || 0);
  const rate = (Number(l.taxRate) || 0) / 100;
  if (included && rate > 0) {
    const sub = amt / (1 + rate);
    return { amt, sub, tax: amt - sub };
  }
  return { amt, sub: amt, tax: amt * rate };
}

// Mirrors the client's defaultLineTaxRate() — used to force a cashier's line tax rate back
// to what the event actually specifies, ignoring whatever the client sent for that line.
function defaultLineTaxRate(event, tender) {
  if (!event) return 0;
  if (tender === 'cash' && event.cash_tax_rate != null) return Number(event.cash_tax_rate) || 0;
  return Number(event.tax_rate) || 0;
}

// Public shape: everything a receipt needs, nothing about profit margins. `soldBy` is
// whatever was recorded at the time — if attribution was off then, it's null; turning the
// setting on later doesn't retroactively invent it for old sales.
const toPublicSale = (r) => ({
  id: r.id, eventId: r.event_id, test: !!r.test, taxIncluded: !!r.tax_included,
  lines: JSON.parse(r.lines_json), subtotal: r.subtotal, tax: r.tax, total: r.total,
  tender: r.tender, received: r.received, change: r.change, soldBy: r.user_name || null, createdAt: r.created_at,
});
const toFullSale = (r) => ({ ...toPublicSale(r), profit: r.profit });

// Any logged-in user: the Sell page's recent-sales list and receipts, and Reports' non-profit figures.
router.get('/', requireLogin, (req, res) => {
  const rows = db.prepare('SELECT * FROM sales ORDER BY created_at DESC').all();
  res.json(rows.map(toPublicSale));
});

// Reports (admin/manager/lead) needs profit per sale to compute cost breakdowns and "true profit."
router.get('/full', requireReports, (req, res) => {
  const rows = db.prepare('SELECT * FROM sales ORDER BY created_at DESC').all();
  res.json(rows.map(toFullSale));
});

// Checkout. Computes totals and profit server-side from the ticket lines (never trusts
// client-sent totals), and atomically decrements stock for every real (non-test, non-custom)
// line in the same transaction as recording the sale — a real transaction, so two cashiers
// checking out the same item at once settle correctly with no special handling.
router.post('/', requireLogin, (req, res) => {
  const b = req.body || {};
  const rawLines = Array.isArray(b.lines) ? b.lines : [];
  if (!rawLines.length) return res.status(400).json({ error: 'empty_ticket' });
  const included = !!b.taxIncluded;
  const test = !!b.test;

  // Cashier restrictions, enforced here rather than trusted from the UI: no custom (non-
  // catalog) items, and no per-line tax-rate override — their ticket always uses the event's
  // actual configured rate, regardless of what the client submits.
  let lines = rawLines;
  if (req.user.role === 'cashier') {
    if (rawLines.some((l) => !l.itemId)) {
      return res.status(403).json({ error: 'custom_items_not_allowed', message: 'Custom items aren’t available on this account.' });
    }
    const event = b.eventId ? db.prepare('SELECT * FROM events WHERE id = ?').get(b.eventId) : null;
    const forcedRate = defaultLineTaxRate(event, b.tender || 'cash');
    lines = rawLines.map((l) => ({ ...l, taxRate: forcedRate }));
  }

  let subtotal = 0, tax = 0, profit = 0;
  const stockChanges = [];
  for (const l of lines) {
    const { sub, tax: lineTax } = lineTaxSplit(l, included);
    subtotal += sub; tax += lineTax;
    if (l.itemId) {
      const item = db.prepare('SELECT * FROM items WHERE id = ?').get(l.itemId);
      if (item) {
        profit += sub - item.cost * (Number(l.qty) || 0);
        if (!test) stockChanges.push({ id: l.itemId, qty: Number(l.qty) || 0 });
      }
    }
  }
  const total = subtotal + tax;
  const received = b.tender === 'cash' ? (Number(b.received) || 0) : total;
  const change = b.tender === 'cash' ? Math.max(0, received - total) : 0;

  const trackAttribution = getBool('trackSaleAttribution', true);
  const row = {
    id: uid(), event_id: b.eventId || null, test: test ? 1 : 0, tax_included: included ? 1 : 0,
    lines_json: JSON.stringify(lines.map(l => ({ itemId: l.itemId || null, name: l.name, price: Number(l.price) || 0, qty: Number(l.qty) || 0, taxRate: Number(l.taxRate) || 0 }))),
    subtotal, tax, total, tender: b.tender || 'cash', received, change, profit,
    user_id: trackAttribution ? req.user.id : null, user_name: trackAttribution ? req.user.name : null,
    created_at: Date.now(),
  };

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO sales (id, event_id, test, tax_included, lines_json, subtotal, tax, total, tender, received, change, profit, user_id, user_name, created_at)
      VALUES (@id, @event_id, @test, @tax_included, @lines_json, @subtotal, @tax, @total, @tender, @received, @change, @profit, @user_id, @user_name, @created_at)
    `).run(row);
    for (const c of stockChanges) {
      db.prepare('UPDATE items SET stock = MAX(0, stock - ?) WHERE id = ?').run(c.qty, c.id);
    }
  });
  tx();

  res.json(toPublicSale(db.prepare('SELECT * FROM sales WHERE id = ?').get(row.id)));
});

// Void a sale (Sell page), restoring stock atomically.
router.delete('/:id', requireLogin, (req, res) => {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'not_found' });
  const lines = JSON.parse(sale.lines_json);
  const tx = db.transaction(() => {
    if (!sale.test) {
      for (const l of lines) {
        if (!l.itemId) continue;
        db.prepare('UPDATE items SET stock = stock + ? WHERE id = ?').run(Number(l.qty) || 0, l.itemId);
      }
    }
    db.prepare('DELETE FROM sales WHERE id = ?').run(sale.id);
  });
  tx();
  res.json({ ok: true });
});

module.exports = router;
