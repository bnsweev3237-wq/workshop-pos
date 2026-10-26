const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { uid, genItemNo } = require('../lib/ids');
const { requireAdmin } = require('../middleware/auth');
const { runBackup, listBackups, clearOldBackups, BACKUP_DIR, KEEP } = require('../lib/backup');
const { getDiskUsage } = require('../lib/diskUsage');

const router = express.Router();
router.use(requireAdmin);

router.get('/backups', (req, res) => {
  res.json({ keep: KEEP, backups: listBackups() });
});

router.post('/backups', async (req, res) => {
  const result = await runBackup();
  if (!result.ok) return res.status(502).json({ error: 'backup_failed', message: result.error });
  res.json({ ok: true, file: result.file, backups: listBackups() });
});

// Keeps only the single newest backup, freeing the rest — for an admin who wants space back
// now rather than waiting for the daily keep-5 window to age old ones out on its own.
router.post('/backups/clear-old', (req, res) => {
  const result = clearOldBackups();
  res.json({ ok: true, ...result, backups: listBackups() });
});

// Filename is never taken from the request directly — only ever matched against the real
// list of backups that already exist on disk, so there's no path to read anything else.
router.get('/backups/:file/download', (req, res) => {
  const match = listBackups().find((b) => b.file === req.params.file);
  if (!match) return res.status(404).json({ error: 'not_found' });
  res.download(path.join(BACKUP_DIR, match.file), match.file);
});

router.get('/disk', (req, res) => {
  try {
    const dataDir = path.dirname(db.name);
    const disk = getDiskUsage(dataDir);
    const backupBytes = listBackups().reduce((sum, b) => sum + b.size, 0);
    let dbBytes = 0;
    try { dbBytes = fs.statSync(db.name).size; } catch {}
    res.json({ ...disk, dbBytes, backupBytes });
  } catch (err) {
    res.status(502).json({ error: 'disk_check_failed', message: err.message });
  }
});

// Replaces whatever test data exists with a fresh, fully independent copy of the real
// (non-test) materials, items, events, and sales. Every cross-reference — an item's linked
// materials, an event's charity rules, a sale's event and line items — is remapped to point
// at the new test-side rows, never the real ones, which is what lets test mode actually
// exercise stock changes and everything else without ever touching real data.
router.post('/copy-to-test', (req, res) => {
  const tx = db.transaction(() => {
    // Replace: clear whatever test data already exists first, so repeated use doesn't pile
    // up duplicates. event_charity_rules/event_items have to go before events (both reference
    // events.id).
    db.prepare('DELETE FROM event_charity_rules WHERE event_id IN (SELECT id FROM events WHERE test = 1)').run();
    db.prepare('DELETE FROM event_items WHERE event_id IN (SELECT id FROM events WHERE test = 1)').run();
    db.prepare('DELETE FROM custom_order_items WHERE order_id IN (SELECT id FROM custom_orders WHERE test = 1)').run();
    db.prepare('UPDATE custom_orders SET sale_id = NULL WHERE test = 1').run();
    db.prepare('DELETE FROM sales WHERE test = 1').run();
    db.prepare('DELETE FROM events WHERE test = 1').run();
    db.prepare('DELETE FROM items WHERE test = 1').run();
    db.prepare('DELETE FROM materials WHERE test = 1').run();
    db.prepare('DELETE FROM custom_orders WHERE test = 1').run();

    // source_id isn't remapped — `sources` (the vendor tag list) isn't split by test/main,
    // it's shared, so the copy just keeps pointing at the same row the original did.
    const materialIdMap = new Map();
    for (const m of db.prepare('SELECT * FROM materials WHERE test = 0').all()) {
      const newId = uid();
      materialIdMap.set(m.id, newId);
      db.prepare(`
        INSERT INTO materials (id, name, price, yield, stock, low, source_id, product_url, test, created_at)
        VALUES (@id, @name, @price, @yield, @stock, @low, @source_id, @product_url, 1, @created_at)
      `).run({ id: newId, name: m.name, price: m.price, yield: m.yield, stock: m.stock, low: m.low, source_id: m.source_id, product_url: m.product_url, created_at: m.created_at });
    }

    const itemIdMap = new Map();
    for (const it of db.prepare('SELECT * FROM items WHERE test = 0').all()) {
      const newId = uid();
      itemIdMap.set(it.id, newId);
      const materials = JSON.parse(it.materials_json).map((r) => (
        r.libId && materialIdMap.has(r.libId) ? { ...r, libId: materialIdMap.get(r.libId) } : r
      ));
      db.prepare(`
        INSERT INTO items (id, name, item_no, item_type, category, materials_json, cost_mode, minutes, rate, overhead, mode, pct, round, override, stock, low, price, cost, saved_at, created_at, not_for_shows, test)
        VALUES (@id, @name, @item_no, @item_type, @category, @materials_json, @cost_mode, @minutes, @rate, @overhead, @mode, @pct, @round, @override, @stock, @low, @price, @cost, @saved_at, @created_at, @not_for_shows, 1)
      `).run({
        id: newId, name: it.name, item_no: genItemNo(db), item_type: it.item_type, category: it.category,
        materials_json: JSON.stringify(materials), cost_mode: it.cost_mode, minutes: it.minutes, rate: it.rate,
        overhead: it.overhead, mode: it.mode, pct: it.pct, round: it.round, override: it.override,
        stock: it.stock, low: it.low, price: it.price, cost: it.cost, saved_at: Date.now(), created_at: Date.now(),
        not_for_shows: it.not_for_shows,
      });
      const insertItemCategory = db.prepare('INSERT OR IGNORE INTO item_categories (item_id, category) VALUES (?, ?)');
      for (const row of db.prepare('SELECT category FROM item_categories WHERE item_id = ?').all(it.id)) {
        insertItemCategory.run(newId, row.category);
      }
    }

    const eventIdMap = new Map();
    for (const ev of db.prepare('SELECT * FROM events WHERE test = 0').all()) {
      const newId = uid();
      eventIdMap.set(ev.id, newId);
      db.prepare(`
        INSERT INTO events (id, name, start, days, cost, status, tax_rate, cash_tax_rate, state, tax_included_cash, tax_included_other, test, item_scope, created_at, ended_at)
        VALUES (@id, @name, @start, @days, @cost, @status, @tax_rate, @cash_tax_rate, @state, @tax_included_cash, @tax_included_other, 1, @item_scope, @created_at, @ended_at)
      `).run({
        id: newId, name: ev.name, start: ev.start, days: ev.days, cost: ev.cost, status: ev.status,
        tax_rate: ev.tax_rate, cash_tax_rate: ev.cash_tax_rate, state: ev.state, tax_included_cash: ev.tax_included_cash,
        tax_included_other: ev.tax_included_other, item_scope: ev.item_scope, created_at: ev.created_at, ended_at: ev.ended_at,
      });
      for (const rule of db.prepare('SELECT * FROM event_charity_rules WHERE event_id = ?').all(ev.id)) {
        db.prepare(`
          INSERT INTO event_charity_rules (id, event_id, category, charity_pct, created_at) VALUES (@id, @eventId, @category, @pct, @createdAt)
        `).run({ id: uid(), eventId: newId, category: rule.category, pct: rule.charity_pct, createdAt: rule.created_at });
      }
      // Remap through itemIdMap, same as a sale's line items above — a selected-items event
      // must point at the new test-side item copies, never the real ones.
      if (ev.item_scope === 'selected') {
        const insertEventItem = db.prepare('INSERT OR IGNORE INTO event_items (event_id, item_id, qty_brought) VALUES (?, ?, ?)');
        for (const row of db.prepare('SELECT item_id, qty_brought FROM event_items WHERE event_id = ?').all(ev.id)) {
          if (itemIdMap.has(row.item_id)) insertEventItem.run(newId, itemIdMap.get(row.item_id), row.qty_brought);
        }
      }
    }

    for (const s of db.prepare('SELECT * FROM sales WHERE test = 0').all()) {
      const newId = uid();
      const lines = JSON.parse(s.lines_json).map((l) => (
        l.itemId && itemIdMap.has(l.itemId) ? { ...l, itemId: itemIdMap.get(l.itemId) } : l
      ));
      const newEventId = s.event_id && eventIdMap.has(s.event_id) ? eventIdMap.get(s.event_id) : null;
      db.prepare(`
        INSERT INTO sales (id, event_id, test, tax_included, lines_json, subtotal, tax, total, tender, received, change, profit, charity_due, user_id, user_name, created_at)
        VALUES (@id, @eventId, 1, @taxIncluded, @linesJson, @subtotal, @tax, @total, @tender, @received, @change, @profit, @charityDue, @userId, @userName, @createdAt)
      `).run({
        id: newId, eventId: newEventId, taxIncluded: s.tax_included, linesJson: JSON.stringify(lines),
        subtotal: s.subtotal, tax: s.tax, total: s.total, tender: s.tender, received: s.received, change: s.change,
        profit: s.profit, charityDue: s.charity_due, userId: s.user_id, userName: s.user_name, createdAt: s.created_at,
      });
    }

    // Copied last — a line's item_id needs itemIdMap, built above.
    for (const o of db.prepare('SELECT * FROM custom_orders WHERE test = 0').all()) {
      const newOrderId = uid();
      db.prepare(`
        INSERT INTO custom_orders (id, item_name, customer_name, customer_contact, due_date, status, notes, fulfillment, shipping_address, shipping_cost, tracking_number, amount_paid, test, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(newOrderId, o.item_name, o.customer_name, o.customer_contact, o.due_date, o.status, o.notes, o.fulfillment, o.shipping_address, o.shipping_cost, o.tracking_number, o.amount_paid, o.created_at, o.updated_at);
      for (const li of db.prepare('SELECT * FROM custom_order_items WHERE order_id = ?').all(o.id)) {
        const newItemId = li.item_id && itemIdMap.has(li.item_id) ? itemIdMap.get(li.item_id) : null;
        db.prepare(`
          INSERT INTO custom_order_items (id, order_id, item_id, item_name, price, qty, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(uid(), newOrderId, newItemId, li.item_name, li.price, li.qty, li.created_at);
      }
    }
  });
  tx();
  res.json({ ok: true });
});

// Wipes every item, material, sale, event, and custom order — both the real side and the
// test side. Accounts, roles, and settings are untouched. The client already makes the admin type
// DELETE to confirm; this checks it again server-side, since a destructive admin action
// shouldn't rely on a client-only confirmation.
router.post('/purge', (req, res) => {
  if (req.body?.confirm !== 'DELETE') return res.status(400).json({ error: 'confirmation_required' });
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM event_charity_rules').run();
    db.prepare('DELETE FROM event_items').run();
    db.prepare('DELETE FROM item_categories').run();
    db.prepare('DELETE FROM custom_order_items').run();
    // custom_orders.sale_id references sales(id) — detach before sales are deleted below, same
    // reasoning as every other foreign key cleared ahead of its parent in this transaction.
    db.prepare('UPDATE custom_orders SET sale_id = NULL').run();
    db.prepare('DELETE FROM sales').run();
    // voided_sales/returns both reference events(id) and are deliberately kept (never deleted
    // by this purge — permanent audit trails, same as they survive the test-side purge too) —
    // detach rather than cascade, or the DELETE FROM events below fails outright the first time
    // either table actually has a row pointing at a real event.
    db.prepare('UPDATE voided_sales SET event_id = NULL').run();
    db.prepare('UPDATE returns SET event_id = NULL').run();
    db.prepare('DELETE FROM events').run();
    db.prepare('DELETE FROM items').run();
    db.prepare('DELETE FROM materials').run();
    db.prepare('DELETE FROM custom_orders').run();
  });
  tx();
  res.json({ ok: true });
});

module.exports = router;
