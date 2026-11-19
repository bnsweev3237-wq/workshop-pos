const express = require('express');
const db = require('../db');
const { requireReports } = require('../middleware/auth');
const { toCsv } = require('../lib/csv');

const router = express.Router();

const toPublic = (r) => ({ id: r.id, email: r.email, status: r.status, createdAt: r.created_at, confirmedAt: r.confirmed_at });

// Confirmed contacts only — a maker's own mailing list, never Craftium's. Same role group as
// Reports, since this is business-performance-adjacent data.
router.get('/', requireReports, (req, res) => {
  const rows = db.prepare("SELECT * FROM subscribers WHERE status = 'confirmed' ORDER BY confirmed_at DESC").all();
  res.json(rows.map(toPublic));
});

router.get('/export', requireReports, (req, res) => {
  const rows = db.prepare("SELECT * FROM subscribers WHERE status = 'confirmed' ORDER BY confirmed_at DESC").all()
    .map((r) => ({ email: r.email, confirmed_at: new Date(r.confirmed_at).toISOString() }));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="subscribers.csv"');
  res.send(toCsv(rows, ['email', 'confirmed_at']));
});

// Deliberately unauthenticated — this is the link a customer clicks from their own inbox,
// not something only a logged-in user reaches. A stray/guessed token just 404s; nothing
// sensitive is readable from it either way.
router.get('/confirm/:token', (req, res) => {
  const row = db.prepare('SELECT * FROM subscribers WHERE confirm_token = ?').get(req.params.token);
  if (!row) return res.status(404).send('<p>That link has expired or was already used.</p>');
  if (row.status !== 'confirmed') {
    db.prepare("UPDATE subscribers SET status = 'confirmed', confirmed_at = ? WHERE id = ?").run(Date.now(), row.id);
  }
  res.send('<p>You’re subscribed — thanks! You can close this tab.</p>');
});

module.exports = router;
