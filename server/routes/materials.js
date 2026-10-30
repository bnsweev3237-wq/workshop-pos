const express = require('express');
const db = require('../db');
const { uid } = require('../lib/ids');
const { requireManageItems, requireReports } = require('../middleware/auth');
const { checkPrice } = require('../lib/priceFetch');
const { toCsv, parseCsvObjects } = require('../lib/csv');
const { validatePhoto } = require('../lib/photos');

const router = express.Router();
// Reading the list is open to Reports roles too (admin/manager/lead) — the Inventory report
// needs material stock/cost, the same way it already relies on item cost data that's also
// requireReports rather than requireManageItems. Editing/deleting/checking a price stays
// admin+manager only, applied per-route below instead of router-wide.

const toPublic = (r) => ({ id: r.id, name: r.name, price: r.price, yield: r.yield, stock: r.stock, low: r.low, sourceId: r.source_id || null, productUrl: r.product_url || '', photo: r.photo || '', test: !!r.test, created: r.created_at });

// Materials are split into two fully independent catalogs by `test`, same as items —
// see schema.sql.
router.get('/', requireReports, (req, res) => {
  const testFlag = req.query.test === '1' ? 1 : 0;
  const rows = db.prepare('SELECT * FROM materials WHERE test = ? ORDER BY created_at ASC').all(testFlag);
  res.json(rows.map(toPublic));
});

const CSV_COLUMNS = ['Name', 'Source', 'Product URL', 'Price', 'Yield', 'Stock', 'Low Stock At'];
router.get('/export.csv', requireManageItems, (req, res) => {
  const testFlag = req.query.test === '1' ? 1 : 0;
  const rows = db.prepare('SELECT * FROM materials WHERE test = ? ORDER BY name COLLATE NOCASE').all(testFlag);
  const sourceNames = new Map(db.prepare('SELECT id, name FROM sources').all().map((s) => [s.id, s.name]));
  const data = rows.map((r) => ({
    Name: r.name, Source: sourceNames.get(r.source_id) || '', 'Product URL': r.product_url || '',
    Price: r.price, Yield: r.yield, Stock: r.stock, 'Low Stock At': r.low ?? '',
  }));
  const csv = toCsv(data, CSV_COLUMNS);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="craftium-materials${testFlag ? '-test' : ''}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

// Same upsert-by-row behavior as items' CSV import (see server/routes/items.js for the full
// reasoning) — matched by Name only here, materials having no item-number equivalent. A Source
// name that doesn't already exist in Settings → Material sources is created rather than
// rejected or dropped, so a sheet built from scratch doesn't need every source precreated first.
router.post('/import.csv', requireManageItems, (req, res) => {
  const text = String(req.body?.csv || '');
  const test = req.body?.test ? 1 : 0;
  if (!text.trim()) return res.status(400).json({ error: 'empty_csv' });
  let csvRows;
  try { csvRows = parseCsvObjects(text); } catch { return res.status(400).json({ error: 'invalid_csv' }); }

  const existingRows = db.prepare('SELECT * FROM materials WHERE test = ?').all(test);
  const byName = new Map();
  for (const r of existingRows) { const k = r.name.trim().toLowerCase(); if (!byName.has(k)) byName.set(k, r); }
  const claimed = new Set();
  const sourceIdByName = new Map(db.prepare('SELECT id, name FROM sources').all().map((s) => [s.name.toLowerCase(), s.id]));

  const cell = (row, key) => (row[key] === undefined || row[key] === null ? '' : String(row[key]).trim());
  const numOr = (v, fallback) => (v === '' ? fallback : (Number(v) || 0));

  let created = 0, updated = 0, skipped = 0;
  const errors = [];
  const tx = db.transaction(() => {
    const insertSource = db.prepare('INSERT INTO sources (id, name, created_at) VALUES (?, ?, ?)');
    csvRows.forEach((raw, i) => {
      const name = cell(raw, 'Name');
      if (!name) { skipped++; errors.push(`Row ${i + 2}: missing Name`); return; }
      let existing = byName.get(name.toLowerCase()) || null;
      if (existing && claimed.has(existing.id)) existing = null;

      const sourceCell = cell(raw, 'Source');
      let sourceId = existing ? existing.source_id : null;
      if (sourceCell) {
        const key = sourceCell.toLowerCase();
        if (!sourceIdByName.has(key)) { const id = uid(); insertSource.run(id, sourceCell, Date.now()); sourceIdByName.set(key, id); }
        sourceId = sourceIdByName.get(key);
      }
      const urlCell = cell(raw, 'Product URL');
      const priceCell = cell(raw, 'Price'), yieldCell = cell(raw, 'Yield'), stockCell = cell(raw, 'Stock'), lowCell = cell(raw, 'Low Stock At');

      const row = {
        id: existing ? existing.id : uid(),
        name,
        price: numOr(priceCell, existing ? existing.price : 0),
        yield: yieldCell === '' ? (existing ? existing.yield : 1) : (Number(yieldCell) || 1),
        stock: numOr(stockCell, existing ? existing.stock : 0),
        low: lowCell === '' ? (existing ? existing.low : null) : (Number(lowCell) || 0),
        source_id: sourceId,
        product_url: urlCell === '' ? (existing ? existing.product_url : null) : urlCell,
        test,
        created_at: existing ? existing.created_at : Date.now(),
      };
      db.prepare(`
        INSERT INTO materials (id, name, price, yield, stock, low, source_id, product_url, test, created_at)
        VALUES (@id, @name, @price, @yield, @stock, @low, @source_id, @product_url, @test, @created_at)
        ON CONFLICT(id) DO UPDATE SET name=@name, price=@price, yield=@yield, stock=@stock, low=@low, source_id=@source_id, product_url=@product_url
      `).run(row);
      if (existing) { claimed.add(existing.id); updated++; } else created++;
    });
  });
  tx();
  res.json({ ok: true, created, updated, skipped, errors: errors.slice(0, 20) });
});

router.post('/', requireManageItems, (req, res) => {
  const b = req.body || {};
  // A bad sourceId (stale reference to a since-deleted source) is dropped rather than
  // rejected outright — source_id references sources(id) with foreign keys enforced, so
  // inserting one that doesn't exist would otherwise throw a constraint error.
  const sourceId = b.sourceId && db.prepare('SELECT 1 FROM sources WHERE id = ?').get(b.sourceId) ? b.sourceId : null;
  let photo;
  try { photo = validatePhoto(b.photo); } catch { return res.status(400).json({ error: 'invalid_photo' }); }
  const row = {
    id: b.id || uid(),
    name: b.name || '',
    price: Number(b.price) || 0,
    yield: Number(b.yield) || 1,
    stock: Number(b.stock) || 0,
    low: b.low === '' || b.low == null ? null : Number(b.low),
    source_id: sourceId,
    product_url: b.productUrl ? String(b.productUrl).trim() || null : null,
    photo,
    test: b.test ? 1 : 0,
    created_at: b.created || Date.now(),
  };
  db.prepare(`
    INSERT INTO materials (id, name, price, yield, stock, low, source_id, product_url, photo, test, created_at)
    VALUES (@id, @name, @price, @yield, @stock, @low, @source_id, @product_url, @photo, @test, @created_at)
    ON CONFLICT(id) DO UPDATE SET name=@name, price=@price, yield=@yield, stock=@stock, low=@low, source_id=@source_id, product_url=@product_url, photo=@photo, test=@test
  `).run(row);
  res.json(toPublic(row));
});

router.delete('/:id', requireManageItems, (req, res) => {
  db.prepare('DELETE FROM materials WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Fetches the material's saved product page and tries to read off a current price, for the
// admin to review — never writes anything. See server/lib/priceFetch.js for why this is
// best-effort rather than guaranteed to work.
router.post('/:id/check-price', requireManageItems, async (req, res) => {
  const m = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'not_found' });
  if (!m.product_url) return res.status(400).json({ error: 'no_product_url' });
  let url;
  try {
    url = new URL(m.product_url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
  } catch {
    return res.status(400).json({ error: 'invalid_url' });
  }
  try {
    const price = await checkPrice(url.toString());
    res.json({ price });
  } catch (err) {
    const STATUS = { price_not_found: 422, timed_out: 504, invalid_url: 400, blocked_address: 400 };
    res.status(STATUS[err.code] || 502).json({ error: err.code || 'fetch_error' });
  }
});

module.exports = router;
