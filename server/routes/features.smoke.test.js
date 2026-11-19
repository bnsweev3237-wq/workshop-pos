// Standalone smoke test (no test framework in this repo) for the new backend pieces: receipt-
// email subscriber opt-in, consignment tracking (gated by requireFeature), and the event
// expense ledger (including that event delete still works with expenses attached).
// Run with: node server/routes/features.smoke.test.js

const path = require('path');
const fs = require('fs');
const os = require('os');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'craftium-smoke-'));
process.env.WORKSHOP_DATA_DIR = dataDir;

const { startServer } = require('../index');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error(`FAIL: ${msg}`); }
  else console.log(`ok: ${msg}`);
}

async function main() {
  const { server, port } = await startServer(0);
  const base = `http://localhost:${port}`;
  let cookie = '';

  async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
  }

  const setup = await call('POST', '/api/auth/setup', { name: 'Admin', username: 'admin', password: 'password123' });
  assert(setup.status === 200, 'admin account created');

  // --- Email receipt + subscriber opt-in (no SMTP configured — sendMail no-ops gracefully) ---
  const sale = await call('POST', '/api/sales', {
    test: false, tender: 'cash', taxIncluded: false, customerEmail: 'buyer@example.com',
    lines: [{ name: 'Handmade mug', price: 20, qty: 1, taxRate: 0 }],
  });
  assert(sale.status === 200, 'sale with customerEmail recorded');
  await new Promise((r) => setTimeout(r, 200)); // emailReceipt() isn't awaited into the response
  const subs0 = await call('GET', '/api/subscribers');
  assert(subs0.data.length === 0, 'subscriber not confirmed yet (no click)');
  const db = require('../db');
  const row = db.prepare('SELECT * FROM subscribers WHERE email = ?').get('buyer@example.com');
  assert(!!row && row.status === 'pending', 'a pending subscriber row was created');
  const confirm = await call('GET', '/api/subscribers/confirm/' + row.confirm_token);
  assert(confirm.status === 200, 'confirm link works');
  const subs1 = await call('GET', '/api/subscribers');
  assert(subs1.data.length === 1 && subs1.data[0].email === 'buyer@example.com', 'subscriber now confirmed and listed');

  // --- Consignment (default-allowed: no license key set, requireFeature defaults to allow) ---
  const partner = await call('POST', '/api/consignment/partners', { name: 'Maple St Gallery', commissionPct: 30 });
  assert(partner.status === 200, 'consignment partner created (unlicensed install defaults to allowed)');
  const citem = await call('POST', '/api/consignment/items', { partnerId: partner.data.id, name: 'Earrings', qtySent: 10 });
  assert(citem.status === 200, 'consignment inventory item created');
  const sold = await call('POST', `/api/consignment/items/${citem.data.id}/sold`, { qty: 3, salePrice: 20 });
  assert(sold.status === 200, 'consignment sale logged');
  const partnerItems = await call('GET', `/api/consignment/partners/${partner.data.id}/items`);
  const it = partnerItems.data[0];
  assert(it.qtyOut === 7, `qtyOut computed correctly (got ${it.qtyOut})`);
  assert(Math.abs(it.owed - 42) < 0.01, `owed computed correctly after 30% commission (got ${it.owed})`);

  // --- Event expenses + event delete with expenses attached ---
  const ev = await call('POST', '/api/events', { name: 'Spring Fair', start: '2026-05-01', days: 1, cost: 50, status: 'ended', test: false });
  const exp = await call('POST', '/api/event-expenses', { eventId: ev.data.id, label: 'Travel', amount: 25 });
  assert(exp.status === 200, 'event expense added');
  const evGet = await call('GET', '/api/events');
  const evRow = evGet.data.find((e) => e.id === ev.data.id);
  assert(evRow.expensesTotal === 25, `event carries its expensesTotal (got ${evRow.expensesTotal})`);
  const delEv = await call('DELETE', '/api/events/' + ev.data.id);
  assert(delEv.status === 200, 'event with expenses attached still deletes cleanly');

  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });

  if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1); }
  console.log('\nAll assertions passed.');
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
