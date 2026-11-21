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
  assert(citem.status === 200, 'consignment inventory item created (legacy free-text path, no itemId, still works)');
  // Sold is adjusted directly (no per-sale price entry) — owed is computed from the stored
  // price, so a legacy item with none (no itemId) has 0 owed regardless of qty_sold rather than
  // NaN or a leftover sale-ledger figure.
  const adjustCitem = await call('POST', `/api/consignment/items/${citem.data.id}/adjust`, { qtySold: 3 });
  assert(adjustCitem.status === 200 && adjustCitem.data.qtySold === 3, `directly adjusting Sold works, no per-sale logging needed (got ${JSON.stringify(adjustCitem.data)})`);
  const partnerItems = await call('GET', `/api/consignment/partners/${partner.data.id}/items`);
  const it = partnerItems.data.items.find((x) => x.id === citem.data.id);
  assert(it.qtyOut === 7, `qtyOut computed correctly (got ${it.qtyOut})`);
  assert(it.owed === 0, 'a legacy item (no itemId, no stored price) has 0 owed — consistent with hasPricing-gated totals, not NaN');

  // --- Consignment, linked to a real catalog item: sending inventory decrements its stock,
  // over-sending clamps both the stock change AND the recorded qty_sent (never let the ledger
  // claim more left the shelf than actually did), and removing the entry restores whatever's
  // still unsold ---
  const earringsItem = await call('POST', '/api/items', { name: 'Hoop Earrings', price: 25, cost: 8, stock: 10 });
  assert(earringsItem.status === 200, 'catalog item created');
  const linkedSend = await call('POST', '/api/consignment/items', { partnerId: partner.data.id, itemId: earringsItem.data.id, name: 'Hoop Earrings', qtySent: 4 });
  assert(linkedSend.status === 200 && linkedSend.data.had === 10 && linkedSend.data.qtySent === 4, `sending 4 of 10 in stock (got had=${linkedSend.data.had}, qtySent=${linkedSend.data.qtySent})`);
  assert(linkedSend.data.price === 25 && linkedSend.data.cost === 8, `price/cost are imported from the catalog item automatically when none is given (got price=${linkedSend.data.price}, cost=${linkedSend.data.cost})`);
  const afterSend1 = await call('GET', '/api/items/full');
  assert(afterSend1.data.find((x) => x.id === earringsItem.data.id).stock === 6, 'catalog stock actually dropped to 6');

  // "Import then modify" — an explicit price overrides the catalog default; cost is still
  // snapshotted from the catalog regardless, since it's never client-supplied. Sent and
  // immediately removed again so it doesn't complicate the shelf-totals math checked below.
  const overridePriceSend = await call('POST', '/api/consignment/items', { partnerId: partner.data.id, itemId: earringsItem.data.id, name: 'Hoop Earrings', qtySent: 1, price: 19.99 });
  assert(overridePriceSend.status === 200 && overridePriceSend.data.price === 19.99 && overridePriceSend.data.cost === 8, `an explicit price overrides the catalog default (got price=${overridePriceSend.data.price}, cost=${overridePriceSend.data.cost})`);
  const removeOverride = await call('DELETE', '/api/consignment/items/' + overridePriceSend.data.id);
  assert(removeOverride.status === 200, 'cleanup: removing the override-price test entry succeeds');

  const overSend = await call('POST', '/api/consignment/items', { partnerId: partner.data.id, itemId: earringsItem.data.id, name: 'Hoop Earrings', qtySent: 9 });
  assert(overSend.status === 200 && overSend.data.had === 6 && overSend.data.qtySent === 6, `asking to send 9 with only 6 left clamps the recorded qtySent to 6 too, not just the stock floor (got had=${overSend.data.had}, qtySent=${overSend.data.qtySent})`);
  const afterSend2 = await call('GET', '/api/items/full');
  assert(afterSend2.data.find((x) => x.id === earringsItem.data.id).stock === 0, 'catalog stock now at 0');

  const unknownItem = await call('POST', '/api/consignment/items', { partnerId: partner.data.id, itemId: 'not-a-real-item-id', name: 'Ghost Item', qtySent: 1 });
  assert(unknownItem.status === 400, 'sending a nonexistent itemId is rejected rather than silently skipping the stock change');

  await call('POST', `/api/consignment/items/${overSend.data.id}/adjust`, { qtySold: 2 }); // 6 (clamped) sent, 2 sold -> 4 still out
  const delLinked = await call('DELETE', '/api/consignment/items/' + overSend.data.id);
  assert(delLinked.status === 200, 'removing the consignment entry succeeds');
  const afterDelete = await call('GET', '/api/items/full');
  assert(afterDelete.data.find((x) => x.id === earringsItem.data.id).stock === 4, `the 4 still-unsold units came back to stock (got ${afterDelete.data.find((x) => x.id === earringsItem.data.id).stock})`);

  // A lead account can reach the rest of consignment (requireEventManage includes lead) but
  // not move real stock through it — requireManageItems (admin/manager only) gates sending,
  // removing an item, and deleting a partner outright, same stricter territory as the Items
  // tab's own manual stock adjustments (:id/make, :id/sell). :id/adjust is more nuanced: lead
  // can freely adjust Sold (never touches real stock) but is refused the moment a call would
  // also reduce Sent (restores real stock), checked inline per-request rather than by role
  // middleware since the same route serves both cases.
  const adminCookie = cookie;
  const leadSetup = await call('POST', '/api/auth/users', { name: 'Lead Hand', username: 'lead1', password: 'password123', role: 'lead' });
  assert(leadSetup.status === 200, 'lead account created');
  cookie = '';
  const leadLogin = await call('POST', '/api/auth/login', { username: 'lead1', password: 'password123' });
  assert(leadLogin.status === 200, 'lead logged in');
  const leadReadPartners = await call('GET', '/api/consignment/partners');
  assert(leadReadPartners.status === 200, 'lead can still view consignment partners/inventory');
  const leadAdjustSold = await call('POST', `/api/consignment/items/${linkedSend.data.id}/adjust`, { qtySold: 1 });
  assert(leadAdjustSold.status === 200, 'lead can adjust Sold directly (doesn\'t touch real stock)');
  const leadAdjustSent = await call('POST', `/api/consignment/items/${linkedSend.data.id}/adjust`, { qtySent: 1 });
  assert(leadAdjustSent.status === 403, 'lead is refused the moment the same route is asked to reduce Sent (would restore real stock)');
  const leadSend = await call('POST', '/api/consignment/items', { partnerId: partner.data.id, itemId: earringsItem.data.id, name: 'Hoop Earrings', qtySent: 1 });
  assert(leadSend.status === 403, 'lead cannot send inventory to consignment (requireManageItems)');
  const leadDeleteItem = await call('DELETE', '/api/consignment/items/' + linkedSend.data.id);
  assert(leadDeleteItem.status === 403, 'lead cannot remove a consignment inventory entry');
  const leadDeletePartner = await call('DELETE', '/api/consignment/partners/' + partner.data.id);
  assert(leadDeletePartner.status === 403, 'lead cannot delete a consignment partner');
  cookie = adminCookie;

  // --- Shelf totals: cost/retail on the shelf and estimated profit after commission, for
  // what's still unsold. By this point: the legacy item has no price/cost (qtyOut 7,
  // contributes 0); linkedSend has qty_sent=4, qty_sold=1 (leadSold above), so qtyOut=3 at
  // price=25/cost=8 -> costOnShelf 24, retailOnShelf 75, estProfit 75*0.7-24=28.5 ---
  const finalPartnerItems = await call('GET', `/api/consignment/partners/${partner.data.id}/items`);
  const linkedRow = finalPartnerItems.data.items.find((x) => x.id === linkedSend.data.id);
  assert(linkedRow.qtyOut === 3 && linkedRow.costOnShelf === 24 && linkedRow.retailOnShelf === 75 && Math.abs(linkedRow.estProfit - 28.5) < 0.01, `per-item shelf cost/retail/estimated-profit computed correctly (got ${JSON.stringify({ qtyOut: linkedRow.qtyOut, costOnShelf: linkedRow.costOnShelf, retailOnShelf: linkedRow.retailOnShelf, estProfit: linkedRow.estProfit })})`);
  const legacyRow = finalPartnerItems.data.items.find((x) => x.id === citem.data.id);
  assert(legacyRow.hasPricing === false && legacyRow.costOnShelf === 0 && legacyRow.retailOnShelf === 0, 'the legacy free-text item (no itemId, no price) contributes 0 to shelf totals rather than NaN');
  const t = finalPartnerItems.data.totals;
  assert(t.costOnShelf === 24 && t.retailOnShelf === 75 && Math.abs(t.estProfit - 28.5) < 0.01, `partner-level shelf totals sum correctly across every item (got ${JSON.stringify(t)})`);
  // totals.owed: citem has no stored price so contributes 0 regardless of its qty_sold, plus
  // linkedSend's 1 sold @ its stored $25 (30% commission) = 17.5 -> 17.5 total, the rolling
  // "owed" tally public/app.js sums across every partner.
  assert(Math.abs(t.owed - 17.5) < 0.01, `totals.owed sums every item's owed amount for this partner (got ${t.owed})`);

  // --- "Items are rotated" / a recount — Sent can be corrected in either direction directly.
  // A decrease restores the difference to real stock and floors at qtySold (can't un-send
  // what's already marked sold); an increase is clamped to whatever's actually on the shelf,
  // exactly like "+ Send inventory" above, and decrements it the same way. ---
  const rotateDown = await call('POST', `/api/consignment/items/${linkedSend.data.id}/adjust`, { qtySent: 0 });
  assert(rotateDown.status === 200 && rotateDown.data.qtySent === 1 && rotateDown.data.delta === -3, `reducing Sent floors at qtySold (1) rather than 0, restoring the 3-unit difference (got ${JSON.stringify(rotateDown.data)})`);
  const afterRotate = await call('GET', '/api/items/full');
  assert(afterRotate.data.find((x) => x.id === earringsItem.data.id).stock === 7, `the 3 restored units actually landed back in real stock (got ${afterRotate.data.find((x) => x.id === earringsItem.data.id).stock})`);

  const increaseSent = await call('POST', `/api/consignment/items/${linkedSend.data.id}/adjust`, { qtySent: 99 });
  assert(increaseSent.status === 200 && increaseSent.data.qtySent === 8 && increaseSent.data.delta === 7, `asking to increase Sent to 99 with only 7 in stock clamps it to the 7 actually available (1 + 7 = 8) (got ${JSON.stringify(increaseSent.data)})`);
  const afterIncrease = await call('GET', '/api/items/full');
  assert(afterIncrease.data.find((x) => x.id === earringsItem.data.id).stock === 0, `the 7 taken for that increase actually left real stock (got ${afterIncrease.data.find((x) => x.id === earringsItem.data.id).stock})`);

  // --- The real-world bug report this guards against: with real stock now at 0, trying to
  // increase Sent further is fully rejected, returning the SAME qtySent it already had (8) and
  // delta 0 — not an error, just a no-op. (The actual bug was client-side: public/app.js only
  // corrected the Sent input's displayed value when the server's answer *differed* from before,
  // so a fully-rejected increase like this one left the input showing whatever was optimistically
  // typed — e.g. "5" — while "On shelf" correctly stayed at the old, unchanged value. Fixed by
  // always writing the just-committed field's own input back, whether or not it changed.) ---
  const increaseWithNoStock = await call('POST', `/api/consignment/items/${linkedSend.data.id}/adjust`, { qtySent: 50 });
  assert(increaseWithNoStock.status === 200 && increaseWithNoStock.data.qtySent === 8 && increaseWithNoStock.data.delta === 0, `with 0 in stock, an increase is fully rejected back to the unchanged qtySent (8), not an error (got ${JSON.stringify(increaseWithNoStock.data)})`);

  // --- The bug this whole section guards against: adjusting ONE field must never read or
  // clobber the OTHER field's current value — editing Sold alone must leave Sent exactly where
  // it was, and vice versa ---
  const soldOnly = await call('POST', `/api/consignment/items/${linkedSend.data.id}/adjust`, { qtySold: 2 });
  assert(soldOnly.status === 200 && soldOnly.data.qtySent === 8 && soldOnly.data.qtySold === 2 && soldOnly.data.delta === 0, `adjusting only qtySold leaves qtySent completely untouched (got ${JSON.stringify(soldOnly.data)})`);
  const sentOnly = await call('POST', `/api/consignment/items/${linkedSend.data.id}/adjust`, { qtySent: 0 });
  assert(sentOnly.status === 200 && sentOnly.data.qtySent === 2 && sentOnly.data.qtySold === 2, `adjusting only qtySent leaves qtySold untouched — floors Sent at the existing Sold (2), not at 0 (got ${JSON.stringify(sentOnly.data)})`);

  // --- Public item lookup (QR/barcode price-tag scan target, server/routes/items.js's GET
  // /lookup/:itemNo) — no auth at all, so check it with a bare fetch, no session cookie ---
  const lookupOk = await (await fetch(`${base}/api/items/lookup/${earringsItem.data.itemNo}`)).json();
  assert(lookupOk.name === 'Hoop Earrings' && lookupOk.price === 25, `lookup returns the right name/price (got ${JSON.stringify(lookupOk)})`);
  assert(!('stock' in lookupOk) && !('cost' in lookupOk) && !('notes' in lookupOk) && !('id' in lookupOk), 'lookup never leaks stock, cost, notes, or the internal id — only what\'s already printed on the tag');
  const lookupMissing = await fetch(`${base}/api/items/lookup/000000`);
  assert(lookupMissing.status === 404, 'looking up an unknown item number 404s');
  const testItem = await call('POST', '/api/items', { name: 'Sandbox Thing', price: 9, cost: 1, stock: 1, test: true });
  const lookupTestItem = await fetch(`${base}/api/items/lookup/${testItem.data.itemNo}`);
  assert(lookupTestItem.status === 404, 'a test-catalog item is never reachable through the public lookup, even with its real item number');
  const lookupPage = await fetch(`${base}/i/${earringsItem.data.itemNo}`);
  assert(lookupPage.status === 200 && (await lookupPage.text()).includes('item-lookup.js'), 'the /i/:itemNo page itself serves the lookup shell');

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
