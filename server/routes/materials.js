const express = require('express');
const db = require('../db');
const { uid } = require('../lib/ids');
const { requireManageItems } = require('../middleware/auth');
const { checkPrice } = require('../lib/priceFetch');

const router = express.Router();
router.use(requireManageItems); // Materials tab: admin and manager only.

const toPublic = (r) => ({ id: r.id, name: r.name, price: r.price, yield: r.yield, stock: r.stock, low: r.low, sourceId: r.source_id || null, productUrl: r.product_url || '', test: !!r.test, created: r.created_at });

// Materials are split into two fully independent catalogs by `test`, same as items —
// see schema.sql.
router.get('/', (req, res) => {
  const testFlag = req.query.test === '1' ? 1 : 0;
  const rows = db.prepare('SELECT * FROM materials WHERE test = ? ORDER BY created_at ASC').all(testFlag);
  res.json(rows.map(toPublic));
});

router.post('/', (req, res) => {
  const b = req.body || {};
  // A bad sourceId (stale reference to a since-deleted source) is dropped rather than
  // rejected outright — source_id references sources(id) with foreign keys enforced, so
  // inserting one that doesn't exist would otherwise throw a constraint error.
  const sourceId = b.sourceId && db.prepare('SELECT 1 FROM sources WHERE id = ?').get(b.sourceId) ? b.sourceId : null;
  const row = {
    id: b.id || uid(),
    name: b.name || '',
    price: Number(b.price) || 0,
    yield: Number(b.yield) || 1,
    stock: Number(b.stock) || 0,
    low: b.low === '' || b.low == null ? null : Number(b.low),
    source_id: sourceId,
    product_url: b.productUrl ? String(b.productUrl).trim() || null : null,
    test: b.test ? 1 : 0,
    created_at: b.created || Date.now(),
  };
  db.prepare(`
    INSERT INTO materials (id, name, price, yield, stock, low, source_id, product_url, test, created_at)
    VALUES (@id, @name, @price, @yield, @stock, @low, @source_id, @product_url, @test, @created_at)
    ON CONFLICT(id) DO UPDATE SET name=@name, price=@price, yield=@yield, stock=@stock, low=@low, source_id=@source_id, product_url=@product_url, test=@test
  `).run(row);
  res.json(toPublic(row));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM materials WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Fetches the material's saved product page and tries to read off a current price, for the
// admin to review — never writes anything. See server/lib/priceFetch.js for why this is
// best-effort rather than guaranteed to work.
router.post('/:id/check-price', async (req, res) => {
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
    res.status(err.code === 'price_not_found' ? 422 : err.code === 'timed_out' ? 504 : 502).json({ error: err.code || 'fetch_error' });
  }
});

module.exports = router;
