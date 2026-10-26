const express = require('express');
const db = require('../db');
const { uid, genItemNo } = require('../lib/ids');
const { requireManageItems, requireReports, requireLogin } = require('../middleware/auth');
const { toCsv, parseCsvObjects } = require('../lib/csv');

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
// notForShows travels with the public shape too — it's what lets the Sell page leave this
// item off the grid at any event, which a cashier's own item list has to be able to do.
const toPublicItem = (r, categories) => ({ id: r.id, name: r.name, itemNo: r.item_no, categories: categories || [], price: r.price, stock: r.stock, low: r.low, notForShows: !!r.not_for_shows, test: !!r.test });

const toFullItem = (r, categories) => ({
  id: r.id, name: r.name, itemNo: r.item_no, itemType: r.item_type, categories: categories || [], materials: JSON.parse(r.materials_json),
  costMode: r.cost_mode, minutes: r.minutes, rate: r.rate, overhead: r.overhead,
  mode: r.mode, pct: r.pct, round: r.round, override: r.override,
  stock: r.stock, low: r.low, price: r.price, cost: r.cost, savedAt: r.saved_at, createdAt: r.created_at, notForShows: !!r.not_for_shows,
  notes: r.notes || '', test: !!r.test,
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

// A flat, spreadsheet-friendly export of the inventory-relevant fields — not the full
// Calculator recipe (materials, labor, overhead), which doesn't fit a CSV row sensibly. Price
// and cost are whatever's currently stored, same figures the Sell page and Reports use,
// regardless of whether a "made" item's price came from its formula or a manual override.
const CSV_COLUMNS = ['Name', 'Item Number', 'Type', 'Category', 'Price', 'Cost', 'Stock', 'Low Stock At', 'Not For Shows', 'Notes'];
router.get('/export.csv', requireManageItems, (req, res) => {
  const rows = db.prepare('SELECT * FROM items WHERE test = ? ORDER BY name COLLATE NOCASE').all(testFlag(req));
  const cats = categoriesByItem(rows.map((r) => r.id));
  const data = rows.map((r) => ({
    Name: r.name, 'Item Number': r.item_no, Type: r.item_type,
    Category: (cats.get(r.id) || []).join('; '),
    Price: r.price, Cost: r.cost, Stock: r.stock, 'Low Stock At': r.low ?? '',
    'Not For Shows': r.not_for_shows ? 'yes' : '', Notes: r.notes || '',
  }));
  const csv = toCsv(data, CSV_COLUMNS);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="craftium-items${testFlag(req) ? '-test' : ''}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

// Upsert-by-row: a row matches an existing item first by Item Number (if given and it's a
// real one), else by Name (case-insensitive) — the first match wins and can't be matched again
// by a later row in the same file, so two rows that'd otherwise both match one item just makes
// the second a new item rather than silently overwriting the first row's update. An unmatched
// row always creates a new item. A blank cell means "leave unchanged" on an update (so a sheet
// that's just a stock recount, say, doesn't have to carry every other column too) but becomes
// a zero/empty default when creating a new item, since there's nothing existing to fall back to.
router.post('/import.csv', requireManageItems, (req, res) => {
  const text = String(req.body?.csv || '');
  const test = req.body?.test ? 1 : 0;
  if (!text.trim()) return res.status(400).json({ error: 'empty_csv' });
  let csvRows;
  try { csvRows = parseCsvObjects(text); } catch { return res.status(400).json({ error: 'invalid_csv' }); }

  const existingRows = db.prepare('SELECT * FROM items WHERE test = ?').all(test);
  const byItemNo = new Map(existingRows.map((r) => [r.item_no, r]));
  const byName = new Map();
  for (const r of existingRows) { const k = r.name.trim().toLowerCase(); if (!byName.has(k)) byName.set(k, r); }
  const claimed = new Set();

  const cell = (row, key) => (row[key] === undefined || row[key] === null ? '' : String(row[key]).trim());
  const numOr = (v, fallback) => (v === '' ? fallback : (Number(v) || 0));

  let created = 0, updated = 0, skipped = 0;
  const errors = [];
  const tx = db.transaction(() => {
    const insertCat = db.prepare('INSERT OR IGNORE INTO item_categories (item_id, category) VALUES (?, ?)');
    csvRows.forEach((raw, i) => {
      const name = cell(raw, 'Name');
      if (!name) { skipped++; errors.push(`Row ${i + 2}: missing Name`); return; }
      const itemNoCell = cell(raw, 'Item Number');
      let existing = (itemNoCell && byItemNo.get(itemNoCell)) || byName.get(name.toLowerCase()) || null;
      if (existing && claimed.has(existing.id)) existing = null;

      const priceCell = cell(raw, 'Price'), costCell = cell(raw, 'Cost'), stockCell = cell(raw, 'Stock'), lowCell = cell(raw, 'Low Stock At');
      const typeCell = cell(raw, 'Type').toLowerCase();
      const flagCell = cell(raw, 'Not For Shows');
      const notesCell = cell(raw, 'Notes');
      const catCell = raw['Category'];

      const row = {
        id: existing ? existing.id : uid(),
        name,
        item_no: existing ? existing.item_no : (itemNoCell || genItemNo(db)),
        item_type: existing ? existing.item_type : (typeCell === 'made' ? 'made' : 'resale'),
        materials_json: existing ? existing.materials_json : '[]',
        cost_mode: existing ? existing.cost_mode : 'none',
        minutes: existing ? existing.minutes : 0,
        rate: existing ? existing.rate : 0,
        overhead: existing ? existing.overhead : 0,
        mode: existing ? existing.mode : 'markup',
        pct: existing ? existing.pct : 0,
        round: existing ? existing.round : 'whole',
        override: existing ? existing.override : null,
        stock: numOr(stockCell, existing ? existing.stock : 0),
        low: lowCell === '' ? (existing ? existing.low : null) : (Number(lowCell) || 0),
        price: numOr(priceCell, existing ? existing.price : 0),
        cost: numOr(costCell, existing ? existing.cost : 0),
        saved_at: Date.now(),
        created_at: existing ? existing.created_at : Date.now(),
        not_for_shows: flagCell === '' ? (existing ? existing.not_for_shows : 0) : (/^(y|yes|true|1)$/i.test(flagCell) ? 1 : 0),
        notes: notesCell === '' && existing ? existing.notes : (notesCell || null),
        test,
      };
      db.prepare(`
        INSERT INTO items (id, name, item_no, item_type, materials_json, cost_mode, minutes, rate, overhead, mode, pct, round, override, stock, low, price, cost, saved_at, created_at, not_for_shows, notes, test)
        VALUES (@id, @name, @item_no, @item_type, @materials_json, @cost_mode, @minutes, @rate, @overhead, @mode, @pct, @round, @override, @stock, @low, @price, @cost, @saved_at, @created_at, @not_for_shows, @notes, @test)
        ON CONFLICT(id) DO UPDATE SET name=@name, item_type=@item_type, stock=@stock, low=@low,
          price=@price, cost=@cost, saved_at=@saved_at, not_for_shows=@not_for_shows, notes=@notes
      `).run(row);
      if (catCell !== undefined && String(catCell).trim() !== '') {
        db.prepare('DELETE FROM item_categories WHERE item_id = ?').run(row.id);
        for (const c of String(catCell).split(';').map((c) => c.trim()).filter(Boolean)) insertCat.run(row.id, c);
      }
      if (existing) { claimed.add(existing.id); updated++; } else created++;
    });
  });
  tx();
  res.json({ ok: true, created, updated, skipped, errors: errors.slice(0, 20) });
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
    created_at: Date.now(),
    not_for_shows: b.notForShows ? 1 : 0,
    notes: String(b.notes || '').trim() || null,
    test: b.test ? 1 : 0,
  };
  // Categories are a flat array of strings from the client — deduped, trimmed, empties
  // dropped. Replaces the full set for this item, same delete-then-insert pattern as
  // event_items' picker, so removing every category is just as easy as adding one.
  const categories = [...new Set((Array.isArray(b.categories) ? b.categories : []).map((c) => String(c).trim()).filter(Boolean))];
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO items (id, name, item_no, item_type, materials_json, cost_mode, minutes, rate, overhead, mode, pct, round, override, stock, low, price, cost, saved_at, created_at, not_for_shows, notes, test)
      VALUES (@id, @name, @item_no, @item_type, @materials_json, @cost_mode, @minutes, @rate, @overhead, @mode, @pct, @round, @override, @stock, @low, @price, @cost, @saved_at, @created_at, @not_for_shows, @notes, @test)
      ON CONFLICT(id) DO UPDATE SET name=@name, item_type=@item_type, materials_json=@materials_json, cost_mode=@cost_mode, minutes=@minutes,
        rate=@rate, overhead=@overhead, mode=@mode, pct=@pct, round=@round, override=@override, stock=@stock, low=@low,
        price=@price, cost=@cost, saved_at=@saved_at, not_for_shows=@not_for_shows, notes=@notes, test=@test
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
// event's "selected items" would otherwise fail outright. custom_order_items also references
// items(id), but a custom order line keeps its own name/price snapshot, so that line is
// detached (item_id set NULL) rather than deleted along with the item.
router.delete('/:id', requireManageItems, (req, res) => {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM item_categories WHERE item_id = ?').run(req.params.id);
    db.prepare('DELETE FROM event_items WHERE item_id = ?').run(req.params.id);
    db.prepare('UPDATE custom_order_items SET item_id = NULL WHERE item_id = ?').run(req.params.id);
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
