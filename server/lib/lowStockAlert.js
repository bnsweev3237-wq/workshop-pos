const db = require('../db');
const { getMailConfig, sendMail } = require('./mail');

// Real catalog only (test = 0) — test-side stock is practice data, not something worth
// emailing anyone about. Mirrors the client's own isLow(): a low threshold has to actually be
// set (not null/blank) and current stock has to be at or under it.
function findLowStock() {
  const items = db.prepare('SELECT name, stock, low FROM items WHERE test = 0 AND low IS NOT NULL AND stock <= low ORDER BY name COLLATE NOCASE').all();
  const materials = db.prepare('SELECT name, stock, low FROM materials WHERE test = 0 AND low IS NOT NULL AND stock <= low ORDER BY name COLLATE NOCASE').all();
  return { items, materials };
}

function buildDigestEmail({ items, materials }) {
  const line = (r) => `${r.name || 'Unnamed'} — ${r.stock} left (alert at ${r.low})`;
  const textParts = [];
  if (items.length) textParts.push(`Items:\n${items.map(line).join('\n')}`);
  if (materials.length) textParts.push(`Materials:\n${materials.map(line).join('\n')}`);
  const text = `The following are at or below their low-stock alert level:\n\n${textParts.join('\n\n')}`;
  const htmlList = (rows) => `<ul>${rows.map((r) => `<li>${r.name || 'Unnamed'} — ${r.stock} left (alert at ${r.low})</li>`).join('')}</ul>`;
  const html = `<p>The following are at or below their low-stock alert level:</p>${items.length ? `<p><b>Items</b></p>${htmlList(items)}` : ''}${materials.length ? `<p><b>Materials</b></p>${htmlList(materials)}` : ''}`;
  return { subject: `Craftium: ${items.length + materials.length} low on stock`, text, html };
}

// Shared by the daily scheduler and the "Check now" button in Settings — same check either
// way, just triggered differently. Silently does nothing (not an error) if alerts are off or
// email isn't configured; that's the normal, expected state for most installs, not a failure.
async function checkLowStockAndEmail() {
  const config = getMailConfig();
  if (!config.lowStockEnabled) return { ok: true, sent: false, reason: 'disabled' };
  if (!config.alertRecipient) return { ok: true, sent: false, reason: 'no_recipient' };
  const low = findLowStock();
  const count = low.items.length + low.materials.length;
  if (!count) return { ok: true, sent: false, reason: 'nothing_low', count: 0 };
  const email = buildDigestEmail(low);
  const result = await sendMail({ to: config.alertRecipient, ...email });
  return { ok: result.ok, sent: result.ok, error: result.error, count };
}

// Runs once a day, same pattern as scheduleDailyBackups (server/lib/backup.js) — fires shortly
// after boot, then every 24h. No "already sent today" tracking: this is a daily digest, not a
// one-time notification, so sending it again each day something's still low is the intended
// behavior, not a bug to dedupe.
function scheduleDailyLowStockCheck() {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const FIRST_RUN_DELAY_MS = 5 * 60 * 1000; // give the server a few minutes to settle after boot
  setTimeout(function fire() {
    checkLowStockAndEmail().catch((err) => console.error('Scheduled low-stock check error:', err));
    setInterval(() => checkLowStockAndEmail().catch((err) => console.error('Scheduled low-stock check error:', err)), DAY_MS);
  }, FIRST_RUN_DELAY_MS);
}

module.exports = { findLowStock, checkLowStockAndEmail, scheduleDailyLowStockCheck };
