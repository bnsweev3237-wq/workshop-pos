const express = require('express');
const db = require('../db');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();
router.use(requireLogin);

// Wipes everything on the test side only — items, materials, sales, events, and any charity
// rules on those test events. Any logged-in role can call this (not just admin/manager/lead):
// any role can enter test mode on the Sell page and should be able to reset their own
// practice data, and this never touches the real (test = 0) side regardless of who calls it.
// Done as one bulk transaction rather than the client looping per-row deletes — that both
// avoids the foreign-key-ordering pitfalls those hit (event_charity_rules/sales reference
// events) and extends cleanly to items/materials, which per-row item/material routes
// restrict to admin/manager.
router.post('/purge', (req, res) => {
  const counts = {};
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM event_charity_rules WHERE event_id IN (SELECT id FROM events WHERE test = 1)').run();
    db.prepare('DELETE FROM event_items WHERE event_id IN (SELECT id FROM events WHERE test = 1)').run();
    db.prepare('DELETE FROM item_categories WHERE item_id IN (SELECT id FROM items WHERE test = 1)').run();
    db.prepare('DELETE FROM custom_order_items WHERE order_id IN (SELECT id FROM custom_orders WHERE test = 1)').run();
    db.prepare('UPDATE custom_orders SET sale_id = NULL WHERE test = 1').run();
    counts.sales = db.prepare('DELETE FROM sales WHERE test = 1').run().changes;
    // Same detach-before-delete as events.js's own DELETE /:id — voided_sales/returns both
    // reference events(id) and are kept regardless of test/real (an audit trail, never purged).
    db.prepare('UPDATE voided_sales SET event_id = NULL WHERE event_id IN (SELECT id FROM events WHERE test = 1)').run();
    db.prepare('UPDATE returns SET event_id = NULL WHERE event_id IN (SELECT id FROM events WHERE test = 1)').run();
    counts.events = db.prepare('DELETE FROM events WHERE test = 1').run().changes;
    counts.items = db.prepare('DELETE FROM items WHERE test = 1').run().changes;
    counts.materials = db.prepare('DELETE FROM materials WHERE test = 1').run().changes;
    counts.customOrders = db.prepare('DELETE FROM custom_orders WHERE test = 1').run().changes;
  });
  tx();
  res.json({ ok: true, counts });
});

module.exports = router;
