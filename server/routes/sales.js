const express = require('express');
const db = require('../db');
const { uid } = require('../lib/ids');
const { requireReports, requireLogin } = require('../middleware/auth');
const { getBool } = require('../lib/settings');

const router = express.Router();

// Mirrors the client's applyDiscount() — a line's discount is taken off its pre-tax extended
// total (price × qty) before tax is split out, so tax is only ever charged on what was
// actually paid. Capped so a discount can never make a line negative.
function applyDiscount(l, rawAmt) {
  const value = Number(l.discountValue) || 0;
  if (!l.discountType || !value) return 0;
  if (l.discountType === 'pct') return rawAmt * Math.min(100, Math.max(0, value)) / 100;
  return Math.min(rawAmt, Math.max(0, value));
}

// Splits one ticket line's charge into its pre-tax and tax portions — ported 1:1 from the
// artifact's client-side version, just now computed authoritatively on the server instead of
// trusted from the client, since a tampered client could otherwise misreport a sale's total.
function lineTaxSplit(l, included) {
  const rawAmt = (Number(l.price) || 0) * (Number(l.qty) || 0);
  const discAmt = applyDiscount(l, rawAmt);
  const amt = rawAmt - discAmt;
  const rate = (Number(l.taxRate) || 0) / 100;
  if (included && rate > 0) {
    const sub = amt / (1 + rate);
    return { amt, sub, tax: amt - sub, rawAmt, discAmt };
  }
  return { amt, sub: amt, tax: amt * rate, rawAmt, discAmt };
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
  // Which processor took the card payment is receipt-level info, not a profit figure — shown
  // to every role, same as tender itself. The fee it cost (card_fee) is not: that's profit
  // data, only in toFullSale below.
  cardProcessor: r.card_processor || null,
  clientSaleId: r.client_sale_id || null, createdAt: r.created_at,
});
const toFullSale = (r) => ({
  ...toPublicSale(r),
  lines: JSON.parse(r.lines_json), // unstripped — Reports' per-item charity breakdown needs these
  profit: r.profit, charityDue: r.charity_due, cardFee: r.card_fee,
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
  // catalog) items, no per-line tax-rate override — their ticket always uses the event's
  // actual configured rate regardless of what the client submits — and no discounts, which
  // the UI already doesn't offer them but a tampered request could still try to send.
  let lines = rawLines;
  if (req.user.role === 'cashier') {
    if (rawLines.some((l) => !l.itemId)) {
      return res.status(403).json({ error: 'custom_items_not_allowed', message: 'Custom items aren’t available on this account.' });
    }
    const event = b.eventId ? db.prepare('SELECT * FROM events WHERE id = ?').get(b.eventId) : null;
    const forcedRate = defaultLineTaxRate(event, b.tender || 'cash');
    lines = rawLines.map((l) => ({ ...l, taxRate: forcedRate, discountType: null, discountValue: null }));
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
    const { sub, tax: lineTax, discAmt } = lineTaxSplit(l, included);
    subtotal += sub; tax += lineTax;
    const discountType = discAmt > 0 ? (l.discountType === 'amt' ? 'amt' : 'pct') : null;
    const discountValue = discAmt > 0 ? Number(l.discountValue) || 0 : null;
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
        // An item can belong to several categories now — the first one (alphabetically, via
        // the ORDER BY below) that has a matching rule wins. Same "first match" simplicity as
        // before, just checking a list instead of one string.
        const itemCats = db.prepare('SELECT category FROM item_categories WHERE item_id = ? ORDER BY category').all(l.itemId).map((r) => r.category);
        const matchedCat = itemCats.find((c) => categoryRuleMap.has(c));
        let effectivePct = null;
        if (matchedCat) { effectivePct = categoryRuleMap.get(matchedCat); charityRule = matchedCat; }
        else if (allSalesPct != null) { effectivePct = allSalesPct; charityRule = ''; }
        if (effectivePct) {
          charityPct = effectivePct;
          charityAmt = Math.max(0, lineProfit) * effectivePct / 100;
          charityDue += charityAmt;
        }
      }
    }
    finalLines.push({ itemId: l.itemId || null, name: l.name, price: Number(l.price) || 0, qty: Number(l.qty) || 0, taxRate: Number(l.taxRate) || 0, discountType, discountValue, discountAmt: discAmt, charityRule, charityPct, charityAmt });
  }
  const total = subtotal + tax;
  const received = b.tender === 'cash' ? (Number(b.received) || 0) : total;
  const change = b.tender === 'cash' ? Math.max(0, received - total) : 0;

  // The processor and fee rate are looked up server-side from b.cardProcessorId, never trusted
  // from the client directly — same reasoning as everything else computed here. Charged on the
  // full total (what actually hits the card), the way a real processor bills it. Picking no
  // processor (or the id not resolving — e.g. deleted between page load and checkout) just
  // means no fee is recorded, same as before this feature existed.
  let cardProcessorName = null, cardFee = 0;
  if (b.tender !== 'cash' && b.cardProcessorId) {
    const proc = db.prepare('SELECT * FROM card_processors WHERE id = ?').get(b.cardProcessorId);
    if (proc) {
      cardProcessorName = proc.name;
      cardFee = Math.round((total * (proc.fee_pct / 100) + proc.fee_fixed) * 100) / 100;
    }
  }

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
    card_processor: cardProcessorName, card_fee: cardFee,
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
      INSERT INTO sales (id, event_id, test, tax_included, lines_json, subtotal, tax, total, tender, received, change, profit, charity_due, card_processor, card_fee, user_id, user_name, client_sale_id, created_at)
      VALUES (@id, @event_id, @test, @tax_included, @lines_json, @subtotal, @tax, @total, @tender, @received, @change, @profit, @charity_due, @card_processor, @card_fee, @user_id, @user_name, @client_sale_id, @created_at)
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
    // Snapshot the sale before it's gone — voiding has always deleted the row outright, which
    // otherwise leaves no trace a void ever happened (see Reports → Voids).
    db.prepare(`
      INSERT INTO voided_sales (id, original_sale_id, event_id, test, lines_json, subtotal, tax, total, tender, profit, card_processor, card_fee, sold_by_user_id, sold_by_user_name, sale_created_at, voided_by_user_id, voided_by_user_name, voided_at)
      VALUES (@id, @originalSaleId, @eventId, @test, @linesJson, @subtotal, @tax, @total, @tender, @profit, @cardProcessor, @cardFee, @soldByUserId, @soldByUserName, @saleCreatedAt, @voidedByUserId, @voidedByUserName, @voidedAt)
    `).run({
      id: uid(), originalSaleId: sale.id, eventId: sale.event_id, test: sale.test, linesJson: sale.lines_json,
      subtotal: sale.subtotal, tax: sale.tax, total: sale.total, tender: sale.tender, profit: sale.profit,
      cardProcessor: sale.card_processor, cardFee: sale.card_fee,
      soldByUserId: sale.user_id, soldByUserName: sale.user_name, saleCreatedAt: sale.created_at,
      voidedByUserId: req.user.id, voidedByUserName: req.user.name, voidedAt: Date.now(),
    });
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

// Void history for Reports — profit-bearing (same role level as /full), so it's never exposed
// to a cashier who can void their own sales but shouldn't see margin figures.
router.get('/voids', requireReports, (req, res) => {
  const rows = db.prepare('SELECT * FROM voided_sales ORDER BY voided_at DESC').all();
  res.json(rows.map((r) => ({
    id: r.id, originalSaleId: r.original_sale_id, eventId: r.event_id, test: !!r.test,
    lines: JSON.parse(r.lines_json), subtotal: r.subtotal, tax: r.tax, total: r.total, tender: r.tender,
    profit: r.profit, cardProcessor: r.card_processor || null, cardFee: r.card_fee,
    soldBy: r.sold_by_user_name || null, saleCreatedAt: r.sale_created_at,
    voidedBy: r.voided_by_user_name || null, voidedAt: r.voided_at,
  })));
});

module.exports = router;
