const express = require('express');
const db = require('../db');
const { uid } = require('../lib/ids');
const { requireManageItems } = require('../middleware/auth');

const router = express.Router();
router.use(requireManageItems); // Materials tab: admin and manager only.

const toPublic = (r) => ({ id: r.id, name: r.name, price: r.price, yield: r.yield, stock: r.stock, low: r.low, created: r.created_at });

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM materials ORDER BY created_at ASC').all();
  res.json(rows.map(toPublic));
});

router.post('/', (req, res) => {
  const b = req.body || {};
  const row = {
    id: b.id || uid(),
    name: b.name || '',
    price: Number(b.price) || 0,
    yield: Number(b.yield) || 1,
    stock: Number(b.stock) || 0,
    low: b.low === '' || b.low == null ? null : Number(b.low),
    created_at: b.created || Date.now(),
  };
  db.prepare(`
    INSERT INTO materials (id, name, price, yield, stock, low, created_at) VALUES (@id, @name, @price, @yield, @stock, @low, @created_at)
    ON CONFLICT(id) DO UPDATE SET name=@name, price=@price, yield=@yield, stock=@stock, low=@low
  `).run(row);
  res.json(toPublic(row));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM materials WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
