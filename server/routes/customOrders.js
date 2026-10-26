const express = require('express');
const db = require('../db');
const { uid } = require('../lib/ids');
const { requireEventManage } = require('../middleware/auth');

const router = express.Router();
// Same roles as event management (admin/manager/lead) — a cashier rings up the pickup sale
// on the Sell page as usual, but doesn't manage the order queue itself.
router.use(requireEventManage);

const toPublicOrderItem = (r) => ({ id: r.id, itemId: r.item_id, itemName: r.item_name, price: r.price, qty: r.qty });

// Bulk-fetched once per list call rather than per row, same reasoning as items.js's
// categoriesByItem — avoids an N+1 query.
function itemsByOrder(orderIds) {
  const map = new Map();
  if (!orderIds.length) return map;
  const placeholders = orderIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM custom_order_items WHERE order_id IN (${placeholders}) ORDER BY created_at`).all(...orderIds);
  for (const r of rows) {
    if (!map.has(r.order_id)) map.set(r.order_id, []);
    map.get(r.order_id).push(toPublicOrderItem(r));
  }
  return map;
}
const orderItemsFor = (orderId) => db.prepare('SELECT * FROM custom_order_items WHERE order_id = ? ORDER BY created_at').all(orderId).map(toPublicOrderItem);

const toPublic = (r, items) => ({
  id: r.id, itemName: r.item_name, customerName: r.customer_name, customerContact: r.customer_contact || '',
  dueDate: r.due_date || '', status: r.status, notes: r.notes || '', test: !!r.test,
  fulfillment: r.fulfillment || 'pickup', shippingAddress: r.shipping_address || '',
  shippingCost: r.shipping_cost, trackingNumber: r.tracking_number || '',
  amountPaid: r.amount_paid, items: items || [],
  createdAt: r.created_at, updatedAt: r.updated_at,
});

const STATUSES = ['new', 'in_progress', 'ready', 'picked_up'];
const FULFILLMENTS = ['pickup', 'ship'];

router.get('/', (req, res) => {
  const testFlag = req.query.test === '1' ? 1 : 0;
  const rows = db.prepare('SELECT * FROM custom_orders WHERE test = ? ORDER BY (due_date IS NULL), due_date, created_at DESC').all(testFlag);
  const items = itemsByOrder(rows.map((r) => r.id));
  res.json(rows.map((r) => toPublic(r, items.get(r.id))));
});

router.post('/', (req, res) => {
  const b = req.body || {};
  const customerName = String(b.customerName || '').trim();
  if (!customerName) return res.status(400).json({ error: 'invalid_input', message: 'Give the order a customer name.' });
  const isUpdate = !!b.id;
  const existing = isUpdate ? db.prepare('SELECT created_at FROM custom_orders WHERE id = ?').get(b.id) : null;
  const now = Date.now();
  const fulfillment = FULFILLMENTS.includes(b.fulfillment) ? b.fulfillment : 'pickup';
  const row = {
    id: b.id || uid(),
    customer_name: customerName,
    customer_contact: String(b.customerContact || '').trim() || null,
    due_date: b.dueDate || null,
    status: STATUSES.includes(b.status) ? b.status : 'new',
    notes: String(b.notes || '').trim() || null,
    fulfillment,
    // Shipping fields only persist when fulfillment is actually 'ship' — switching an order
    // back to pickup clears them rather than leaving stale shipping data attached to it.
    shipping_address: fulfillment === 'ship' ? (String(b.shippingAddress || '').trim() || null) : null,
    shipping_cost: fulfillment === 'ship' && b.shippingCost !== '' && b.shippingCost != null ? Number(b.shippingCost) || 0 : null,
    tracking_number: fulfillment === 'ship' ? (String(b.trackingNumber || '').trim() || null) : null,
    amount_paid: b.amountPaid === '' || b.amountPaid == null ? null : Number(b.amountPaid) || 0,
    test: b.test ? 1 : 0,
    created_at: existing ? existing.created_at : now,
    updated_at: now,
  };
  db.prepare(`
    INSERT INTO custom_orders (id, customer_name, customer_contact, due_date, status, notes, fulfillment, shipping_address, shipping_cost, tracking_number, amount_paid, test, created_at, updated_at)
    VALUES (@id, @customer_name, @customer_contact, @due_date, @status, @notes, @fulfillment, @shipping_address, @shipping_cost, @tracking_number, @amount_paid, @test, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET customer_name=@customer_name, customer_contact=@customer_contact,
      due_date=@due_date, status=@status, notes=@notes, fulfillment=@fulfillment, shipping_address=@shipping_address,
      shipping_cost=@shipping_cost, tracking_number=@tracking_number, amount_paid=@amount_paid, updated_at=@updated_at
  `).run(row);
  res.json(toPublic(db.prepare('SELECT * FROM custom_orders WHERE id = ?').get(row.id), orderItemsFor(row.id)));
});

// Replaces the full set of items on this order in one go, same checklist-not-individual-rows
// pattern as an event's item picker. name/price are snapshotted from the catalog item at this
// moment — price can be overridden per line (a custom order may not charge catalog price),
// and stays untouched by a later catalog price change either way. Silently drops any itemId
// that isn't a real item, same as the event item picker.
router.post('/:id/items', (req, res) => {
  const order = db.prepare('SELECT id FROM custom_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'not_found' });
  const entries = Array.isArray(req.body?.items) ? req.body.items : [];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM custom_order_items WHERE order_id = ?').run(order.id);
    const insert = db.prepare('INSERT INTO custom_order_items (id, order_id, item_id, item_name, price, qty, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const getItem = db.prepare('SELECT * FROM items WHERE id = ?');
    const now = Date.now();
    let seq = 0;
    for (const e of entries) {
      if (!e || !e.itemId) continue;
      const item = getItem.get(e.itemId);
      if (!item) continue;
      const qty = Math.max(0, Number(e.qty) || 0) || 1;
      const price = e.price === '' || e.price == null ? item.price : Number(e.price) || 0;
      insert.run(uid(), order.id, item.id, item.name, price, qty, now + seq++);
    }
    db.prepare('UPDATE custom_orders SET updated_at = ? WHERE id = ?').run(now, order.id);
  });
  tx();
  res.json({ ok: true, items: orderItemsFor(order.id) });
});

// A quick status-only change (the inline dropdown in the orders list) — same permission as
// a full edit, just without needing every other field round-tripped for a one-field change.
router.post('/:id/status', (req, res) => {
  const status = STATUSES.includes(req.body?.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: 'invalid_status' });
  const existing = db.prepare('SELECT id FROM custom_orders WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  db.prepare('UPDATE custom_orders SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), req.params.id);
  res.json(toPublic(db.prepare('SELECT * FROM custom_orders WHERE id = ?').get(req.params.id), orderItemsFor(req.params.id)));
});

// Clears this order's line items first — they reference custom_orders(id) with foreign keys
// enforced, so deleting an order that still has any would otherwise fail outright.
router.delete('/:id', (req, res) => {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM custom_order_items WHERE order_id = ?').run(req.params.id);
    db.prepare('DELETE FROM custom_orders WHERE id = ?').run(req.params.id);
  });
  tx();
  res.json({ ok: true });
});

module.exports = router;
