const express = require('express');
const db = require('../db');
const { uid, genItemNo } = require('../lib/ids');
const { requireManageItems, requireReports, requireLogin } = require('../middleware/auth');

const router = express.Router();

// What a cashier on the Sell page is allowed to see: enough to ring something up, nothing
// about what it costs to make or what it's priced to earn — that's the whole reason this
// split exists now that there's a real server to enforce it (the artifact version couldn't).
// category is included even though it's "extra" — it's not cost/profit data.
const toPublicItem = (r) => ({ id: r.id, name: r.name, itemNo: r.item_no, category: r.category || '', price: r.price, stock: r.stock, low: r.low, test: !!r.test });

const toFullItem = (r) => ({
  id: r.id, name: r.name, itemNo: r.item_no, itemType: r.item_type, category: r.category || '', materials: JSON.parse(r.materials_json),
  costMode: r.cost_mode, minutes: r.minutes, rate: r.rate, overhead: r.overhead,
  mode: r.mode, pct: r.pct, round: r.round, override: r.override,
  stock: r.stock, low: r.low, price: r.price, cost: r.cost, savedAt: r.saved_at, test: !!r.test,
});

// Items are split into two fully independent catalogs by `test` — see schema.sql. Every
// list here is scoped to one side or the other (default: the real, non-test catalog) so
// test mode never shows, and can never accidentally touch, real stock.
const testFlag = (req) => (req.query.test === '1' ? 1 : 0);

// Any logged-in user (admin or cashier): the Sell page's item grid. No cost, no materials,
// no pricing formula — that split is enforced here regardless of who's asking.
router.get('/', requireLogin, (req, res) => {
  const rows = db.prepare('SELECT * FROM items WHERE test = ? ORDER BY saved_at DESC').all(testFlag(req));
  res.json(rows.map(toPublicItem));
});

// Calculator / Items (admin + manager, who can edit) and Reports (+ lead, read-only there)
// all need the full picture — cost, materials, the pricing formula. Reports always wants the
// real catalog regardless of whether test mode happens to be on in the caller's UI, since a
// real sale can only ever reference a real (non-test) item.
router.get('/full', requireReports, (req, res) => {
  const rows = db.prepare('SELECT * FROM items WHERE test = ? ORDER BY saved_at DESC').all(testFlag(req));
  res.json(rows.map(toFullItem));
});

router.post('/', requireManageItems, (req, res) => {
  const b = req.body || {};
  const isUpdate = !!b.id;
  const itemNo = isUpdate
    ? (db.prepare('SELECT item_no FROM items WHERE id = ?').get(b.id)?.item_no || genItemNo(db))
    : genItemNo(db);
  const row = {
    id: b.id || uid(),
    name: b.name || '',
    item_no: itemNo,
    item_type: b.itemType === 'resale' ? 'resale' : 'made',
    category: b.category ? String(b.category).trim() || null : null,
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
    test: b.test ? 1 : 0,
  };
  db.prepare(`
    INSERT INTO items (id, name, item_no, item_type, category, materials_json, cost_mode, minutes, rate, overhead, mode, pct, round, override, stock, low, price, cost, saved_at, test)
    VALUES (@id, @name, @item_no, @item_type, @category, @materials_json, @cost_mode, @minutes, @rate, @overhead, @mode, @pct, @round, @override, @stock, @low, @price, @cost, @saved_at, @test)
    ON CONFLICT(id) DO UPDATE SET name=@name, item_type=@item_type, category=@category, materials_json=@materials_json, cost_mode=@cost_mode, minutes=@minutes,
      rate=@rate, overhead=@overhead, mode=@mode, pct=@pct, round=@round, override=@override, stock=@stock, low=@low,
      price=@price, cost=@cost, saved_at=@saved_at, test=@test
  `).run(row);
  res.json(toFullItem(db.prepare('SELECT * FROM items WHERE id = ?').get(row.id)));
});

router.delete('/:id', requireManageItems, (req, res) => {
  db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Make a batch: atomically adds to this item's stock and deducts the materials it used.
// A real SQL transaction — the lease/retry dance the artifact needed (no transactions
// available there) isn't needed at all against a real database.
router.post('/:id/make', requireManageItems, (req, res) => {
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

router.post('/:id/sell', requireManageItems, (req, res) => {
  const qty = Math.max(1, Math.round(Number(req.body?.qty)) || 1);
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  const have = Math.max(0, item.stock);
  db.prepare('UPDATE items SET stock = MAX(0, stock - ?) WHERE id = ?').run(qty, item.id);
  res.json({ ok: true, had: have, item: toFullItem(db.prepare('SELECT * FROM items WHERE id = ?').get(item.id)) });
});

module.exports = router;
