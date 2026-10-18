const express = require('express');
const db = require('../db');
const { uid, genItemNo } = require('../lib/ids');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// What a cashier on the Sell page is allowed to see: enough to ring something up, nothing
// about what it costs to make or what it's priced to earn — that's the whole reason this
// split exists now that there's a real server to enforce it (the artifact version couldn't).
const toPublicItem = (r) => ({ id: r.id, name: r.name, itemNo: r.item_no, price: r.price, stock: r.stock, low: r.low });

const toFullItem = (r) => ({
  id: r.id, name: r.name, itemNo: r.item_no, materials: JSON.parse(r.materials_json),
  costMode: r.cost_mode, minutes: r.minutes, rate: r.rate, overhead: r.overhead,
  mode: r.mode, pct: r.pct, round: r.round, override: r.override,
  stock: r.stock, low: r.low, price: r.price, cost: r.cost, savedAt: r.saved_at,
});

// Public: the Sell page's item grid. No cost, no materials, no pricing formula.
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM items ORDER BY saved_at DESC').all();
  res.json(rows.map(toPublicItem));
});

// Admin: Calculator / Saved Items / Reports need the full picture.
router.get('/full', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM items ORDER BY saved_at DESC').all();
  res.json(rows.map(toFullItem));
});

router.post('/', requireAdmin, (req, res) => {
  const b = req.body || {};
  const isUpdate = !!b.id;
  const itemNo = isUpdate
    ? (db.prepare('SELECT item_no FROM items WHERE id = ?').get(b.id)?.item_no || genItemNo(db))
    : genItemNo(db);
  const row = {
    id: b.id || uid(),
    name: b.name || '',
    item_no: itemNo,
    materials_json: JSON.stringify(b.materials || []),
    cost_mode: b.costMode || 'none',
    minutes: Number(b.minutes) || 0,
    rate: Number(b.rate) || 0,
    overhead: Number(b.overhead) || 0,
    mode: b.mode || 'markup',
    pct: Number(b.pct) || 0,
    round: b.round || 'whole',
    override: b.override === '' || b.override == null ? null : Number(b.override),
    stock: Number(b.stock) || 0,
    low: b.low === '' || b.low == null ? null : Number(b.low),
    price: Number(b.price) || 0,
    cost: Number(b.cost) || 0,
    saved_at: Date.now(),
  };
  db.prepare(`
    INSERT INTO items (id, name, item_no, materials_json, cost_mode, minutes, rate, overhead, mode, pct, round, override, stock, low, price, cost, saved_at)
    VALUES (@id, @name, @item_no, @materials_json, @cost_mode, @minutes, @rate, @overhead, @mode, @pct, @round, @override, @stock, @low, @price, @cost, @saved_at)
    ON CONFLICT(id) DO UPDATE SET name=@name, materials_json=@materials_json, cost_mode=@cost_mode, minutes=@minutes,
      rate=@rate, overhead=@overhead, mode=@mode, pct=@pct, round=@round, override=@override, stock=@stock, low=@low,
      price=@price, cost=@cost, saved_at=@saved_at
  `).run(row);
  res.json(toFullItem(db.prepare('SELECT * FROM items WHERE id = ?').get(row.id)));
});

router.delete('/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Make a batch: atomically adds to this item's stock and deducts the materials it used.
// A real SQL transaction — the lease/retry dance the artifact needed (no transactions
// available there) isn't needed at all against a real database.
router.post('/:id/make', requireAdmin, (req, res) => {
  const qty = Math.max(1, Math.round(Number(req.body?.qty)) || 1);
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  const materials = JSON.parse(item.materials_json);
  const short = [];
  const tx = db.transaction(() => {
    for (const r of materials) {
      if (!r.libId) continue;
      const m = db.prepare('SELECT * FROM materials WHERE id = ?').get(r.libId);
      if (!m) continue;
      const need = (Number(r.per) || 0) * qty;
      if (m.stock < need) short.push(m.name || 'a material');
      db.prepare('UPDATE materials SET stock = MAX(0, stock - ?) WHERE id = ?').run(need, m.id);
    }
    db.prepare('UPDATE items SET stock = stock + ? WHERE id = ?').run(qty, item.id);
  });
  tx();
  res.json({ ok: true, short, item: toFullItem(db.prepare('SELECT * FROM items WHERE id = ?').get(item.id)) });
});

router.post('/:id/sell', requireAdmin, (req, res) => {
  const qty = Math.max(1, Math.round(Number(req.body?.qty)) || 1);
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  const have = Math.max(0, item.stock);
  db.prepare('UPDATE items SET stock = MAX(0, stock - ?) WHERE id = ?').run(qty, item.id);
  res.json({ ok: true, had: have, item: toFullItem(db.prepare('SELECT * FROM items WHERE id = ?').get(item.id)) });
});

module.exports = router;
