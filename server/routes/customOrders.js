const express = require('express');
const db = require('../db');
const { uid } = require('../lib/ids');
const { requireEventManage } = require('../middleware/auth');

const router = express.Router();
// Same roles as event management (admin/manager/lead) — a cashier rings up the pickup sale
// on the Sell page as usual, but doesn't manage the order queue itself.
router.use(requireEventManage);

const toPublic = (r) => ({
  id: r.id, itemName: r.item_name, customerName: r.customer_name, customerContact: r.customer_contact || '',
  dueDate: r.due_date || '', status: r.status, notes: r.notes || '', test: !!r.test,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

const STATUSES = ['new', 'in_progress', 'ready', 'picked_up'];

router.get('/', (req, res) => {
  const testFlag = req.query.test === '1' ? 1 : 0;
  const rows = db.prepare('SELECT * FROM custom_orders WHERE test = ? ORDER BY (due_date IS NULL), due_date, created_at DESC').all(testFlag);
  res.json(rows.map(toPublic));
});

router.post('/', (req, res) => {
  const b = req.body || {};
  const itemName = String(b.itemName || '').trim();
  if (!itemName) return res.status(400).json({ error: 'invalid_input', message: 'Give the order an item or description.' });
  const isUpdate = !!b.id;
  const existing = isUpdate ? db.prepare('SELECT created_at FROM custom_orders WHERE id = ?').get(b.id) : null;
  const now = Date.now();
  const row = {
    id: b.id || uid(),
    item_name: itemName,
    customer_name: String(b.customerName || '').trim(),
    customer_contact: String(b.customerContact || '').trim() || null,
    due_date: b.dueDate || null,
    status: STATUSES.includes(b.status) ? b.status : 'new',
    notes: String(b.notes || '').trim() || null,
    test: b.test ? 1 : 0,
    created_at: existing ? existing.created_at : now,
    updated_at: now,
  };
  db.prepare(`
    INSERT INTO custom_orders (id, item_name, customer_name, customer_contact, due_date, status, notes, test, created_at, updated_at)
    VALUES (@id, @item_name, @customer_name, @customer_contact, @due_date, @status, @notes, @test, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET item_name=@item_name, customer_name=@customer_name, customer_contact=@customer_contact,
      due_date=@due_date, status=@status, notes=@notes, updated_at=@updated_at
  `).run(row);
  res.json(toPublic(db.prepare('SELECT * FROM custom_orders WHERE id = ?').get(row.id)));
});

// A quick status-only change (the inline dropdown in the orders list) — same permission as
// a full edit, just without needing every other field round-tripped for a one-field change.
router.post('/:id/status', (req, res) => {
  const status = STATUSES.includes(req.body?.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: 'invalid_status' });
  const existing = db.prepare('SELECT id FROM custom_orders WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  db.prepare('UPDATE custom_orders SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), req.params.id);
  res.json(toPublic(db.prepare('SELECT * FROM custom_orders WHERE id = ?').get(req.params.id)));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM custom_orders WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
