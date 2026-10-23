const express = require('express');
const db = require('../db');
const { uid, genItemNo } = require('../lib/ids');
const { requireManageItems, requireReports, requireLogin } = require('../middleware/auth');

const router = express.Router();

// A single item can belong to several categories (item_categories, a join table — see
// schema.sql; the old single `items.category` column is deprecated and no longer written).
// Bulk-fetched once per list call rather than per row, to avoid an N+1 query.
function categoriesByItem(itemIds) {
  const map = new Map();
  if (!itemIds.length) return map;
  const placeholders = itemIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT item_id, category FROM item_categories WHERE item_id IN (${placeholders}) ORDER BY category`).all(...itemIds);
  for (const r of rows) {
    if (!map.has(r.item_id)) map.set(r.item_id, []);
    map.get(r.item_id).push(r.category);
  }
  return map;
}
const categoriesFor = (itemId) => db.prepare('SELECT category FROM item_categories WHERE item_id = ? ORDER BY category').all(itemId).map((r) => r.category);

// What a cashier on the Sell page is allowed to see: enough to ring something up, nothing
// about what it costs to make or what it's priced to earn — that's the whole reason this
// split exists now that there's a real server to enforce it (the artifact version couldn't).
// categories is included even though it's "extra" — it's not cost/profit data.
const toPublicItem = (r, categories) => ({ id: r.id, name: r.name, itemNo: r.item_no, categories: categories || [], price: r.price, stock: r.stock, low: r.low, test: !!r.test });

const toFullItem = (r, categories) => ({
  id: r.id, name: r.name, itemNo: r.item_no, itemType: r.item_type, categories: categories || [], materials: JSON.parse(r.materials_json),
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
  const cats = categoriesByItem(rows.map((r) => r.id));
  res.json(rows.map((r) => toPublicItem(r, cats.get(r.id))));
});

// Calculator / Items (admin + manager, who can edit) and Reports (+ lead, read-only there)
// all need the full picture — cost, materials, the pricing formula. Reports always wants the
// real catalog regardless of whether test mode happens to be on in the caller's UI, since a
// real sale can only ever reference a real (non-test) item.
router.get('/full', requireReports, (req, res) => {
  const rows = db.prepare('SELECT * FROM items WHERE test = ? ORDER BY saved_at DESC').all(testFlag(req));
  const cats = categoriesByItem(rows.map((r) => r.id));
  res.json(rows.map((r) => toFullItem(r, cats.get(r.id))));
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
  // Categories are a flat array of strings from the client — deduped, trimmed, empties
  // dropped. Replaces the full set for this item, same delete-then-insert pattern as
  // event_items' picker, so removing every category is just as easy as adding one.
  const categories = [...new Set((Array.isArray(b.categories) ? b.categories : []).map((c) => String(c).trim()).filter(Boolean))];
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO items (id, name, item_no, item_type, materials_json, cost_mode, minutes, rate, overhead, mode, pct, round, override, stock, low, price, cost, saved_at, test)
      VALUES (@id, @name, @item_no, @item_type, @materials_json, @cost_mode, @minutes, @rate, @overhead, @mode, @pct, @round, @override, @stock, @low, @price, @cost, @saved_at, @test)
      ON CONFLICT(id) DO UPDATE SET name=@name, item_type=@item_type, materials_json=@materials_json, cost_mode=@cost_mode, minutes=@minutes,
        rate=@rate, overhead=@overhead, mode=@mode, pct=@pct, round=@round, override=@override, stock=@stock, low=@low,
        price=@price, cost=@cost, saved_at=@saved_at, test=@test
    `).run(row);
    db.prepare('DELETE FROM item_categories WHERE item_id = ?').run(row.id);
    const insertCat = db.prepare('INSERT OR IGNORE INTO item_categories (item_id, category) VALUES (?, ?)');
    for (const c of categories) insertCat.run(row.id, c);
  });
  tx();
  res.json(toFullItem(db.prepare('SELECT * FROM items WHERE id = ?').get(row.id), categories));
});

// Clears item_categories and event_items for this item first — both reference items(id) with
// foreign keys enforced, so deleting an item that's still categorized or picked for an
// event's "selected items" would otherwise fail outright.
router.delete('/:id', requireManageItems, (req, res) => {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM item_categories WHERE item_id = ?').run(req.params.id);
    db.prepare('DELETE FROM event_items WHERE item_id = ?').run(req.params.id);
    db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  });
  tx();
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
  res.json({ ok: true, short, item: toFullItem(db.prepare('SELECT * FROM items WHERE id = ?').get(item.id), categoriesFor(item.id)) });
});

router.post('/:id/sell', requireManageItems, (req, res) => {
  const qty = Math.max(1, Math.round(Number(req.body?.qty)) || 1);
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  const have = Math.max(0, item.stock);
  db.prepare('UPDATE items SET stock = MAX(0, stock - ?) WHERE id = ?').run(qty, item.id);
  res.json({ ok: true, had: have, item: toFullItem(db.prepare('SELECT * FROM items WHERE id = ?').get(item.id), categoriesFor(item.id)) });
});

module.exports = router;
