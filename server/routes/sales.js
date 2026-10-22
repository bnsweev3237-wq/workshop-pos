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

// Each stored line carries charityRule/charityPct/charityAmt for Reports' per-event charity
// wrap-up — charityAmt is profit-derived (amt = profit × pct), so the public shape strips all
// three per line the same way the sale itself hides `profit`. Without this, a cashier could
// back-calculate a line's exact profit from its charityAmt even though toPublicSale never
// lists it directly.
const stripLineCharity = (l) => { const { charityRule, charityPct, charityAmt, ...rest } = l; return rest; };

// Public shape: everything a receipt needs, nothing about profit margins. `soldBy` is
// whatever was recorded at the time — if attribution was off then, it's null; turning the
// setting on later doesn't retroactively invent it for old sales.
const toPublicSale = (r) => ({
  id: r.id, eventId: r.event_id, test: !!r.test, taxIncluded: !!r.tax_included,
  lines: JSON.parse(r.lines_json).map(stripLineCharity), subtotal: r.subtotal, tax: r.tax, total: r.total,
  tender: r.tender, received: r.received, change: r.change, soldBy: r.user_name || null,
  clientSaleId: r.client_sale_id || null, createdAt: r.created_at,
});
const toFullSale = (r) => ({
  ...toPublicSale(r),
  lines: JSON.parse(r.lines_json), // unstripped — Reports' per-item charity breakdown needs these
  profit: r.profit, charityDue: r.charity_due,
});

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

  // A sale completed offline and now syncing carries the client-generated id it was queued
  // under. If a sale with that id already exists, this is a retried sync (the first attempt's
  // response was lost, e.g. connectivity dropped right after) — return the existing sale
  // as-is rather than recording (and double-decrementing stock for) the same sale twice.
  const clientSaleId = typeof b.clientSaleId === 'string' && b.clientSaleId ? b.clientSaleId : null;
  if (clientSaleId) {
    const existing = db.prepare('SELECT * FROM sales WHERE client_sale_id = ?').get(clientSaleId);
    if (existing) return res.json(toPublicSale(existing));
  }

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

  // This event's charity rules, loaded once rather than per line. category '' is the "all
  // sales" catch-all; any other category only applies to items tagged with that category.
  // A category-specific rule takes priority over the catch-all when an item matches both.
  const charityRules = b.eventId
    ? db.prepare('SELECT category, charity_pct FROM event_charity_rules WHERE event_id = ?').all(b.eventId)
    : [];
  const categoryRuleMap = new Map();
  let allSalesPct = null;
  for (const r of charityRules) {
    if (r.category === '') allSalesPct = r.charity_pct;
    else categoryRuleMap.set(r.category, r.charity_pct);
  }

  let subtotal = 0, tax = 0, profit = 0, charityDue = 0;
  const stockChanges = [];
  const finalLines = [];
  for (const l of lines) {
    const { sub, tax: lineTax } = lineTaxSplit(l, included);
    subtotal += sub; tax += lineTax;
    // charityRule records which rule produced charityAmt — the matched category, or '' for
    // the all-sales catch-all — so Reports can group a wrap-up report by it. Custom
    // (non-catalog) lines never get a charity figure: there's no known cost for them, so no
    // profit to take a percentage of.
    let charityRule = null, charityPct = null, charityAmt = 0;
    if (l.itemId) {
      const item = db.prepare('SELECT * FROM items WHERE id = ?').get(l.itemId);
      if (item) {
        const lineProfit = sub - item.cost * (Number(l.qty) || 0);
        profit += lineProfit;
        // Always decrement stock, test sale or not — items are split into independent real
        // and test catalogs (see schema.sql), so this only ever touches whichever side the
        // sold item itself belongs to. That's what lets a test sale actually exercise stock
        // changes, the whole point of a test item having its own stock in the first place.
        stockChanges.push({ id: l.itemId, qty: Number(l.qty) || 0 });
        const cat = (item.category || '').trim();
        let effectivePct = null;
        if (cat && categoryRuleMap.has(cat)) { effectivePct = categoryRuleMap.get(cat); charityRule = cat; }
        else if (allSalesPct != null) { effectivePct = allSalesPct; charityRule = ''; }
        if (effectivePct) {
          charityPct = effectivePct;
          charityAmt = Math.max(0, lineProfit) * effectivePct / 100;
          charityDue += charityAmt;
        }
      }
    }
    finalLines.push({ itemId: l.itemId || null, name: l.name, price: Number(l.price) || 0, qty: Number(l.qty) || 0, taxRate: Number(l.taxRate) || 0, charityRule, charityPct, charityAmt });
  }
  const total = subtotal + tax;
  const received = b.tender === 'cash' ? (Number(b.received) || 0) : total;
  const change = b.tender === 'cash' ? Math.max(0, received - total) : 0;

  const trackAttribution = getBool('trackSaleAttribution', true);
  // A synced offline sale carries the time it actually happened at the register, not when the
  // device finally reconnected — only trusted from the client for that specific path, never
  // for an ordinary online checkout, so there's no way to otherwise backdate a sale's figures
  // into a different reporting window.
  const createdAt = clientSaleId && Number(b.createdAt) > 0 ? Number(b.createdAt) : Date.now();
  const row = {
    id: uid(), event_id: b.eventId || null, test: test ? 1 : 0, tax_included: included ? 1 : 0,
    lines_json: JSON.stringify(finalLines),
    subtotal, tax, total, tender: b.tender || 'cash', received, change, profit, charity_due: charityDue,
    user_id: trackAttribution ? req.user.id : null, user_name: trackAttribution ? req.user.name : null,
    client_sale_id: clientSaleId, created_at: createdAt,
  };

  let saleId = row.id;
  const tx = db.transaction(() => {
    // Defense in depth against the UNIQUE index below — the pre-check above already covers
    // the normal case, this only matters if two syncs for the same queued sale somehow
    // overlapped. Falls back to the row that actually won, rather than erroring.
    if (clientSaleId) {
      const raced = db.prepare('SELECT id FROM sales WHERE client_sale_id = ?').get(clientSaleId);
      if (raced) { saleId = raced.id; return; }
    }
    db.prepare(`
      INSERT INTO sales (id, event_id, test, tax_included, lines_json, subtotal, tax, total, tender, received, change, profit, charity_due, user_id, user_name, client_sale_id, created_at)
      VALUES (@id, @event_id, @test, @tax_included, @lines_json, @subtotal, @tax, @total, @tender, @received, @change, @profit, @charity_due, @user_id, @user_name, @client_sale_id, @created_at)
    `).run(row);
    for (const c of stockChanges) {
      db.prepare('UPDATE items SET stock = MAX(0, stock - ?) WHERE id = ?').run(c.qty, c.id);
    }
  });
  tx();

  res.json(toPublicSale(db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId)));
});

// Void a sale (Sell page), restoring stock atomically.
router.delete('/:id', requireLogin, (req, res) => {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'not_found' });
  const lines = JSON.parse(sale.lines_json);
  const tx = db.transaction(() => {
    // Same reasoning as checkout: restoring stock is safe regardless of test or not, since
    // each item only ever belongs to one side of the real/test split.
    for (const l of lines) {
      if (!l.itemId) continue;
      db.prepare('UPDATE items SET stock = stock + ? WHERE id = ?').run(Number(l.qty) || 0, l.itemId);
    }
    db.prepare('DELETE FROM sales WHERE id = ?').run(sale.id);
  });
  tx();
  res.json({ ok: true });
});

module.exports = router;
