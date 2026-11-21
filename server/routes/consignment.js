const express = require('express');
const db = require('../db');
const { uid } = require('../lib/ids');
const { requireEventManage, requireManageItems } = require('../middleware/auth');
const { requireFeature } = require('../lib/license');

const router = express.Router();
// Same roles as custom orders/event management (including lead), plus the 'consignment'
// feature flag — see server/lib/license.js. Default-allowed today (no tier restricts it yet),
// same as every other feature flag before any tier exists to turn one off. The three routes
// below that actually move real catalog stock (sending/removing inventory) additionally
// require requireManageItems — a silent stock adjustment with no sale record is the same
// stricter, admin/manager-only territory as server/routes/items.js's :id/make and :id/sell.
router.use(requireEventManage, requireFeature('consignment'));

const toPartner = (r) => ({ id: r.id, name: r.name, contact: r.contact, commissionPct: r.commission_pct, createdAt: r.created_at });
const toItem = (r) => ({
  id: r.id, partnerId: r.partner_id, itemId: r.item_id, name: r.name, qtySent: r.qty_sent, qtySold: r.qty_sold,
  dateSent: r.date_sent, notes: r.notes, price: r.price, cost: r.cost,
});

router.get('/partners', (req, res) => {
  const rows = db.prepare('SELECT * FROM consignment_partners ORDER BY name').all();
  res.json(rows.map(toPartner));
});

router.post('/partners', (req, res) => {
  const b = req.body || {};
  const row = {
    id: b.id || uid(), name: b.name || '', contact: b.contact || null,
    commission_pct: Math.max(0, Math.min(100, Number(b.commissionPct) || 0)),
  };
  const existing = b.id ? db.prepare('SELECT created_at FROM consignment_partners WHERE id = ?').get(b.id) : null;
  row.created_at = existing ? existing.created_at : Date.now();
  db.prepare(`
    INSERT INTO consignment_partners (id, name, contact, commission_pct, created_at) VALUES (@id, @name, @contact, @commission_pct, @created_at)
    ON CONFLICT(id) DO UPDATE SET name=@name, contact=@contact, commission_pct=@commission_pct
  `).run(row);
  res.json(toPartner(db.prepare('SELECT * FROM consignment_partners WHERE id = ?').get(row.id)));
});

// Stock-affecting (restoring whatever's still out, unsold, back to the catalog item it came
// from) — same stricter, admin/manager-only gate as the manual stock adjustments in
// server/routes/items.js (:id/make, :id/sell), not the lead-inclusive requireEventManage the
// rest of this router uses for partner/sale bookkeeping that never touches real stock.
router.delete('/partners/:id', requireManageItems, (req, res) => {
  const tx = db.transaction(() => {
    const items = db.prepare('SELECT * FROM consignment_items WHERE partner_id = ?').all(req.params.id);
    for (const it of items) {
      const qtyOut = Math.max(0, it.qty_sent - it.qty_sold);
      if (it.item_id && qtyOut > 0) db.prepare('UPDATE items SET stock = stock + ? WHERE id = ?').run(qtyOut, it.item_id);
      db.prepare('DELETE FROM consignment_sales WHERE consignment_item_id = ?').run(it.id);
    }
    db.prepare('DELETE FROM consignment_items WHERE partner_id = ?').run(req.params.id);
    db.prepare('DELETE FROM consignment_partners WHERE id = ?').run(req.params.id);
  });
  tx();
  res.json({ ok: true });
});

// Items + their sold log for one partner, with the running balance computed here rather than
// trusted from the client: out = sent - sold, owed = sum(sale_price * qty) * (1 - commission%)
// (what's ACTUALLY been reported sold so far — real money). costOnShelf/retailOnShelf/
// estProfit are a projection for what's still unsold (qtyOut) if it eventually sells at its
// listed price: retail * (1 - commission%) - cost. Both price and cost are null for the legacy
// free-text path (no item_id) or any row predating those columns, so their on-shelf figures
// are 0 rather than NaN — shown as "—" by the client rather than a misleading $0.
router.get('/partners/:id/items', (req, res) => {
  const items = db.prepare('SELECT * FROM consignment_items WHERE partner_id = ? ORDER BY date_sent DESC').all(req.params.id);
  const partner = db.prepare('SELECT * FROM consignment_partners WHERE id = ?').get(req.params.id);
  const pct = partner ? Number(partner.commission_pct) || 0 : 0;
  const totals = { costOnShelf: 0, retailOnShelf: 0, estProfit: 0 };
  const out = items.map((it) => {
    const sales = db.prepare('SELECT * FROM consignment_sales WHERE consignment_item_id = ? ORDER BY date_reported DESC').all(it.id);
    const owed = sales.reduce((sum, s) => sum + Number(s.sale_price) * Number(s.qty) * (1 - pct / 100), 0);
    const qtyOut = Math.max(0, it.qty_sent - it.qty_sold);
    const hasPricing = it.price != null && it.cost != null;
    const costOnShelf = hasPricing ? Number(it.cost) * qtyOut : 0;
    const retailOnShelf = hasPricing ? Number(it.price) * qtyOut : 0;
    const estProfit = hasPricing ? retailOnShelf * (1 - pct / 100) - costOnShelf : 0;
    totals.costOnShelf += costOnShelf;
    totals.retailOnShelf += retailOnShelf;
    totals.estProfit += estProfit;
    return {
      ...toItem(it),
      qtyOut, owed, hasPricing, costOnShelf, retailOnShelf, estProfit,
      sales: sales.map((s) => ({ id: s.id, qty: s.qty, salePrice: s.sale_price, dateReported: s.date_reported, notes: s.notes })),
    };
  });
  res.json({ items: out, totals });
});

// Sending inventory to a partner is picked from the real catalog (itemId required — the UI
// only offers a match from the item list, same convention as custom orders' item picker) and
// comes out of that item's own stock immediately, same as a sale would: it's physically off
// the shelf. A plain rename/edit of an existing row (id supplied, item unchanged) skips the
// stock change — only a genuinely new row decrements, so this can't be replayed to re-deduct.
router.post('/items', requireManageItems, (req, res) => {
  const b = req.body || {};
  const existing = b.id ? db.prepare('SELECT * FROM consignment_items WHERE id = ?').get(b.id) : null;
  if (!b.partnerId) return res.status(400).json({ error: 'missing_partner' });
  const requestedQty = Math.max(0, Math.round(Number(b.qtySent)) || 0);
  let item = null, had = null, qtySent = requestedQty;
  if (!existing && b.itemId) {
    item = db.prepare('SELECT * FROM items WHERE id = ?').get(b.itemId);
    if (!item) return res.status(400).json({ error: 'unknown_item', message: 'Pick an item from the catalog list.' });
    had = Math.max(0, item.stock);
    // Never let the ledger record sending more than was actually on the shelf — the recorded
    // qty_sent is what the UI/reports treat as truly out with the partner, not just whatever
    // was typed in.
    qtySent = Math.min(requestedQty, had);
  }
  // Price defaults to the linked item's own current price — imported automatically, but the
  // sender can override it (a consignment listing price doesn't have to match the shop's own
  // retail price). Cost is never client-supplied at all: always a snapshot of the linked item's
  // cost at this exact moment, the internal accounting figure the "estimated profit" totals
  // above are built from.
  const row = {
    id: existing ? existing.id : uid(), partner_id: b.partnerId, item_id: b.itemId || null, name: b.name || '',
    qty_sent: qtySent, date_sent: b.dateSent || Date.now(), notes: b.notes || null,
    price: b.price !== undefined && b.price !== '' ? Math.max(0, Number(b.price)) || 0 : (item ? item.price : null),
    cost: item ? item.cost : null,
  };
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO consignment_items (id, partner_id, item_id, name, qty_sent, date_sent, notes, price, cost)
      VALUES (@id, @partner_id, @item_id, @name, @qty_sent, @date_sent, @notes, @price, @cost)
      ON CONFLICT(id) DO UPDATE SET item_id=@item_id, name=@name, qty_sent=@qty_sent, date_sent=@date_sent, notes=@notes
    `).run(row);
    if (item) db.prepare('UPDATE items SET stock = MAX(0, stock - ?) WHERE id = ?').run(qtySent, item.id);
  });
  tx();
  res.json({ ...toItem(db.prepare('SELECT * FROM consignment_items WHERE id = ?').get(row.id)), had });
});

router.delete('/items/:id', requireManageItems, (req, res) => {
  const tx = db.transaction(() => {
    const it = db.prepare('SELECT * FROM consignment_items WHERE id = ?').get(req.params.id);
    if (it) {
      const qtyOut = Math.max(0, it.qty_sent - it.qty_sold);
      if (it.item_id && qtyOut > 0) db.prepare('UPDATE items SET stock = stock + ? WHERE id = ?').run(qtyOut, it.item_id);
    }
    db.prepare('DELETE FROM consignment_sales WHERE consignment_item_id = ?').run(req.params.id);
    db.prepare('DELETE FROM consignment_items WHERE id = ?').run(req.params.id);
  });
  tx();
  res.json({ ok: true });
});

// Logs a sale the shop reported back — periodic reconciliation, not a live checkout.
router.post('/items/:id/sold', (req, res) => {
  const item = db.prepare('SELECT * FROM consignment_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {};
  const qty = Math.max(1, Math.round(Number(b.qty)) || 1);
  const row = { id: uid(), partner_id: item.partner_id, consignment_item_id: item.id, qty, sale_price: Number(b.salePrice) || 0, date_reported: b.dateReported || Date.now(), notes: b.notes || null };
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO consignment_sales (id, partner_id, consignment_item_id, qty, sale_price, date_reported, notes)
      VALUES (@id, @partner_id, @consignment_item_id, @qty, @sale_price, @date_reported, @notes)
    `).run(row);
    db.prepare('UPDATE consignment_items SET qty_sold = qty_sold + ? WHERE id = ?').run(qty, item.id);
  });
  tx();
  res.json({ ok: true });
});

module.exports = router;
