const express = require('express');
const db = require('../db');
const { uid } = require('../lib/ids');
const { requireEventManage } = require('../middleware/auth');
const { requireFeature } = require('../lib/license');

const router = express.Router();
// Same roles as custom orders/event management, plus the 'consignment' feature flag — see
// server/lib/license.js. Default-allowed today (no tier restricts it yet), same as every
// other feature flag before any tier exists to turn one off.
router.use(requireEventManage, requireFeature('consignment'));

const toPartner = (r) => ({ id: r.id, name: r.name, contact: r.contact, commissionPct: r.commission_pct, createdAt: r.created_at });
const toItem = (r) => ({ id: r.id, partnerId: r.partner_id, itemId: r.item_id, name: r.name, qtySent: r.qty_sent, qtySold: r.qty_sold, dateSent: r.date_sent, notes: r.notes });

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

router.delete('/partners/:id', (req, res) => {
  const tx = db.transaction(() => {
    const itemIds = db.prepare('SELECT id FROM consignment_items WHERE partner_id = ?').all(req.params.id).map((r) => r.id);
    for (const itemId of itemIds) db.prepare('DELETE FROM consignment_sales WHERE consignment_item_id = ?').run(itemId);
    db.prepare('DELETE FROM consignment_items WHERE partner_id = ?').run(req.params.id);
    db.prepare('DELETE FROM consignment_partners WHERE id = ?').run(req.params.id);
  });
  tx();
  res.json({ ok: true });
});

// Items + their sold log for one partner, with the running balance computed here rather
// than trusted from the client: out = sent - sold, owed = sum(sale_price * qty) * (1 - commission%).
router.get('/partners/:id/items', (req, res) => {
  const items = db.prepare('SELECT * FROM consignment_items WHERE partner_id = ? ORDER BY date_sent DESC').all(req.params.id);
  const partner = db.prepare('SELECT * FROM consignment_partners WHERE id = ?').get(req.params.id);
  const pct = partner ? Number(partner.commission_pct) || 0 : 0;
  const out = items.map((it) => {
    const sales = db.prepare('SELECT * FROM consignment_sales WHERE consignment_item_id = ? ORDER BY date_reported DESC').all(it.id);
    const owed = sales.reduce((sum, s) => sum + Number(s.sale_price) * Number(s.qty) * (1 - pct / 100), 0);
    return {
      ...toItem(it),
      qtyOut: Math.max(0, it.qty_sent - it.qty_sold),
      owed,
      sales: sales.map((s) => ({ id: s.id, qty: s.qty, salePrice: s.sale_price, dateReported: s.date_reported, notes: s.notes })),
    };
  });
  res.json(out);
});

router.post('/items', (req, res) => {
  const b = req.body || {};
  const row = {
    id: b.id || uid(), partner_id: b.partnerId, item_id: b.itemId || null, name: b.name || '',
    qty_sent: Math.max(0, Math.round(Number(b.qtySent)) || 0), date_sent: b.dateSent || Date.now(), notes: b.notes || null,
  };
  if (!row.partner_id) return res.status(400).json({ error: 'missing_partner' });
  db.prepare(`
    INSERT INTO consignment_items (id, partner_id, item_id, name, qty_sent, date_sent, notes) VALUES (@id, @partner_id, @item_id, @name, @qty_sent, @date_sent, @notes)
    ON CONFLICT(id) DO UPDATE SET item_id=@item_id, name=@name, qty_sent=@qty_sent, date_sent=@date_sent, notes=@notes
  `).run(row);
  res.json(toItem(db.prepare('SELECT * FROM consignment_items WHERE id = ?').get(row.id)));
});

router.delete('/items/:id', (req, res) => {
  const tx = db.transaction(() => {
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
