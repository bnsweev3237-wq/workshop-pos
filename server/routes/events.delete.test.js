// Standalone verification script (no test framework in this repo) for the events DELETE route:
// an event with real sales recorded against it must be blocked with a clear message rather than
// throwing an unhandled FK-constraint 500 or silently no-oping; an event with no (or only test)
// sales must still delete cleanly, cascading test sales and charity rules like purgeTestData does.
//
// Run with: node server/routes/events.delete.test.js

const path = require('path');
const fs = require('fs');
const os = require('os');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'craftium-test-'));
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

  // Bootstrap the first (admin) account.
  const setup = await call('POST', '/api/auth/setup', { name: 'Admin', username: 'admin', password: 'password123' });
  assert(setup.status === 200, 'admin account created');

  // --- Scenario 1: event with a real sale against it must be blocked, not 500/no-op ---
  const ev1 = await call('POST', '/api/events', { name: 'Fall Fair', start: '2026-10-01', days: 1, cost: 50, status: 'ended', test: false });
  assert(ev1.status === 200, 'created real event');
  const sale1 = await call('POST', '/api/sales', {
    eventId: ev1.data.id, test: false, tender: 'cash', taxIncluded: false,
    lines: [{ name: 'Handmade mug', price: 20, qty: 1, taxRate: 0 }],
  });
  assert(sale1.status === 200, 'recorded a real sale against the event');

  const del1 = await call('DELETE', '/api/events/' + ev1.data.id);
  assert(del1.status === 409, 'delete blocked with 409, not a silent no-op or unhandled 500');
  assert(!!(del1.data && del1.data.message), 'blocked delete carries a clear error message');

  const stillThere = await call('GET', '/api/events');
  assert(stillThere.data.some((e) => e.id === ev1.data.id), 'event and its revenue history are preserved');

  // --- Scenario 2: event with only test sales deletes cleanly, cascading sales + charity rules ---
  const ev2 = await call('POST', '/api/events', { name: 'Practice Run', start: '2026-10-05', days: 1, cost: 0, status: 'ended', test: true });
  assert(ev2.status === 200, 'created test event');
  const rule2 = await call('POST', '/api/charity-rules', { eventId: ev2.data.id, allSales: true, charityPct: 10 });
  assert(rule2.status === 200, 'added a charity rule to the test event');
  const sale2 = await call('POST', '/api/sales', {
    eventId: ev2.data.id, test: true, tender: 'cash', taxIncluded: false,
    lines: [{ name: 'Practice item', price: 5, qty: 1, taxRate: 0 }],
  });
  assert(sale2.status === 200, 'recorded a test sale against the test event');

  const del2 = await call('DELETE', '/api/events/' + ev2.data.id);
  assert(del2.status === 200 && del2.data && del2.data.ok, 'test event (with only test sales) deletes cleanly');

  const eventsAfter = await call('GET', '/api/events');
  assert(!eventsAfter.data.some((e) => e.id === ev2.data.id), 'test event is gone');
  const salesAfter = await call('GET', '/api/sales');
  assert(!salesAfter.data.some((s) => s.id === sale2.data.id), 'its test sale was cascaded away too');

  // --- Scenario 3: event with no sales at all deletes cleanly ---
  const ev3 = await call('POST', '/api/events', { name: 'Never Happened', start: '2026-11-01', days: 1, cost: 0, status: 'ended', test: false });
  const del3 = await call('DELETE', '/api/events/' + ev3.data.id);
  assert(del3.status === 200 && del3.data && del3.data.ok, 'event with no sales deletes cleanly');

  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll assertions passed.');
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
