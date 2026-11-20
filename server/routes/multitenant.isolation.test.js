// Standalone adversarial verification for hosted multi-tenant mode (no test framework in this
// repo — same pattern as features.smoke.test.js, boot the real server in-process and hit real
// HTTP). This is the actual deliverable for "multi-tenancy built and verified working": the
// goal is to make a tenant-isolation bug loud, not to confirm the feature exists.
// Run with: node server/routes/multitenant.isolation.test.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'craftium-mt-'));
process.env.CRAFTIUM_MODE = 'multi-tenant';
process.env.CRAFTIUM_DATA_ROOT = dataRoot;
process.env.CRAFTIUM_BASE_DOMAIN = 'localhost';
process.env.CRAFTIUM_SESSION_SECRET = 'x'.repeat(40);
// Required to boot at all now (server/lib/platformMail.js#assertPlatformMailConfigured) —
// nothing in this test run actually needs mail to be deliverable, since every check below
// drives verification by reading the token straight out of control.db rather than an inbox;
// sendPlatformMail failing to connect to this bogus host is expected and handled gracefully.
process.env.CRAFTIUM_SMTP_HOST = 'localhost';
process.env.CRAFTIUM_SMTP_PORT = '2525';
process.env.CRAFTIUM_PLATFORM_FROM = 'Craftium <hello@example.com>';

const { startServer } = require('../index');
const pool = require('../tenancy/pool');
const controlDb = require('../control/db');
const { forEachActiveTenant, runBackupsForAllTenants, runLowStockForAllTenants } = require('../tenancy/scheduler');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error(`FAIL: ${msg}`); }
  else console.log(`ok: ${msg}`);
}

// ---------- low-level HTTP, with a controllable Host header (fetch() ignores one) ----------
function request(port, { method = 'GET', path: p, host, headers = {}, body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request({
      host: '127.0.0.1', port, path: p, method,
      headers: {
        'Content-Type': 'application/json',
        Host: host,
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
        ...(data !== undefined ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* not JSON */ }
        const setCookie = res.headers['set-cookie'];
        resolve({ status: res.statusCode, data: json, raw, setCookie: setCookie ? setCookie[0].split(';')[0] : null });
      });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

class Client {
  constructor(port, host) { this.port = port; this.host = host; this.cookie = null; }
  async call(method, p, body) {
    const res = await request(this.port, { method, path: p, host: this.host, body, cookie: this.cookie });
    if (res.setCookie) this.cookie = res.setCookie;
    return res;
  }
  get(p) { return this.call('GET', p); }
  post(p, b) { return this.call('POST', p, b); }
  put(p, b) { return this.call('PUT', p, b); }
  del(p) { return this.call('DELETE', p); }
}

// Stands in for "the owner clicks the link in their email" — reads the token straight out of
// control.db (there's no real inbox in a test run) and consumes it the same way a real click
// would. Discards the auto-login cookie that comes back; callers that want a session still go
// through a normal POST /api/auth/login afterward, which is itself part of what's being tested.
async function verifyTenantEmail(port, slug) {
  const tenant = controlDb.getTenantBySlug(slug);
  return request(port, { path: `/api/auth/verify-email/${tenant.email_verify_token}`, host: `${slug}.localhost` });
}

// ---------- route-inventory guard: every mounted prefix must have a covering test ----------
function mountedPrefixes() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const fnMatch = src.match(/function mountTenantScopedRoutes\(app\) \{([\s\S]*?)\n\}/);
  if (!fnMatch) throw new Error('could not locate mountTenantScopedRoutes() in server/index.js to audit against');
  const prefixes = [];
  const re = /app\.use\('(\/api\/[^']+)'/g;
  let m;
  while ((m = re.exec(fnMatch[1]))) prefixes.push(m[1]);
  return prefixes;
}
const TESTED_PREFIXES = new Set();

async function main() {
  const { server, port } = await startServer(0);

  // ===================================================================================
  // Signup validation (platform host)
  // ===================================================================================
  const platform = new Client(port, 'localhost');
  const avail = await platform.get('/api/platform/slug-available?slug=alpha');
  assert(avail.status === 200 && avail.data.available === true, 'slug-available reports a fresh slug as available');

  const weakPw = await platform.post('/api/platform/signup', { businessName: 'Weak Co', slug: 'weakco', ownerName: 'W', email: 'w@example.com', username: 'w', password: 'short' });
  assert(weakPw.status === 400, 'signup rejects a password under 8 characters');

  const noEmail = await platform.post('/api/platform/signup', { businessName: 'No Email Co', slug: 'noemail', ownerName: 'W', username: 'w', password: 'longenough1' });
  assert(noEmail.status === 400 && noEmail.data.error === 'invalid_input', 'signup rejects a missing email');

  const badEmail = await platform.post('/api/platform/signup', { businessName: 'Bad Email Co', slug: 'bademail', ownerName: 'W', email: 'not-an-email', username: 'w', password: 'longenough1' });
  assert(badEmail.status === 400 && badEmail.data.error === 'invalid_input', 'signup rejects a malformed email');

  const reserved = await platform.post('/api/platform/signup', { businessName: 'WWW Co', slug: 'www', ownerName: 'W', email: 'w@example.com', username: 'w', password: 'longenough1' });
  assert(reserved.status === 400 && reserved.data.error === 'invalid_slug', 'signup rejects a reserved slug (www)');

  const malformed = await platform.post('/api/platform/signup', { businessName: 'Bad', slug: 'ab_cd', ownerName: 'W', email: 'w@example.com', username: 'w', password: 'longenough1' });
  assert(malformed.status === 400 && malformed.data.error === 'invalid_slug', 'signup rejects a malformed slug (underscore)');

  const alphaSignup = await platform.post('/api/platform/signup', { businessName: 'Alpha Crafts', slug: 'alpha', ownerName: 'Ann', email: 'ann@example.com', username: 'ann', password: 'alphapass123' });
  assert(alphaSignup.status === 200 && alphaSignup.data.ok, 'alpha tenant signed up');

  const dupSlug = await platform.post('/api/platform/signup', { businessName: 'Alpha Again', slug: 'alpha', ownerName: 'Ann2', email: 'ann2@example.com', username: 'ann2', password: 'alphapass123' });
  assert(dupSlug.status === 409 && dupSlug.data.error === 'slug_taken', 'signup rejects a duplicate slug (409)');

  const betaSignup = await platform.post('/api/platform/signup', { businessName: 'Beta Shop', slug: 'beta', ownerName: 'Bo', email: 'bo@example.com', username: 'bo', password: 'betapass123' });
  assert(betaSignup.status === 200 && betaSignup.data.ok, 'beta tenant signed up');

  const gammaSignup = await platform.post('/api/platform/signup', { businessName: 'Gamma Studio', slug: 'gamma', ownerName: 'Gia', email: 'gia@example.com', username: 'gia', password: 'gammapass123' });
  assert(gammaSignup.status === 200 && gammaSignup.data.ok, 'gamma tenant signed up (used for plan-cap enforcement + scheduler-isolation)');

  // ===================================================================================
  // Email verification — login is blocked until the owner clicks the link sent at signup
  // ===================================================================================
  const alphaTenantRow = controlDb.getTenantBySlug('alpha');
  const betaTenantRow = controlDb.getTenantBySlug('beta');
  assert(alphaTenantRow.owner_email === 'ann@example.com' && !alphaTenantRow.email_verified_at, 'alpha\'s owner_email is stored and email_verified_at is still null right after signup');

  const blockedLogin = await request(port, { method: 'POST', path: '/api/auth/login', host: 'alpha.localhost', body: { username: 'ann', password: 'alphapass123' } });
  assert(blockedLogin.status === 403 && blockedLogin.data.error === 'email_not_verified', 'login is blocked with email_not_verified before the owner verifies');

  const crossTenantVerify = await request(port, { path: `/api/auth/verify-email/${alphaTenantRow.email_verify_token}`, host: 'beta.localhost' });
  assert(crossTenantVerify.status === 404, 'a token minted for alpha is rejected on beta\'s host, even though it\'s real and unexpired');
  assert(!controlDb.getTenantBySlug('beta').email_verified_at, 'beta is completely unaffected by alpha\'s token being tried against it');

  const bogusVerify = await request(port, { path: '/api/auth/verify-email/not-a-real-token', host: 'alpha.localhost' });
  assert(bogusVerify.status === 404, 'an unknown verification token is rejected');

  // An expired (never-consumed) token.
  controlDb.getControlDb().prepare('UPDATE tenants SET email_verify_expires_at = ? WHERE slug = ?').run(Date.now() - 1000, 'alpha');
  const expiredVerify = await request(port, { path: `/api/auth/verify-email/${alphaTenantRow.email_verify_token}`, host: 'alpha.localhost' });
  assert(expiredVerify.status === 404, 'an expired (never-consumed) verification token is rejected');

  // Resend mints a fresh token — the expired one above is now moot either way, but this also
  // proves resend actually invalidates whatever token existed before.
  const resend = await request(port, { method: 'POST', path: '/api/auth/resend-verification', host: 'alpha.localhost' });
  assert(resend.status === 200 && resend.data.ok === true, 'resend-verification succeeds for an unverified tenant');
  const freshToken = controlDb.getTenantBySlug('alpha').email_verify_token;
  assert(freshToken !== alphaTenantRow.email_verify_token, 'resend minted a genuinely new token, invalidating the old one');

  const realVerify = await request(port, { path: `/api/auth/verify-email/${freshToken}`, host: 'alpha.localhost' });
  assert(realVerify.status === 302 && realVerify.setCookie, 'consuming the fresh token on alpha\'s own host auto-logs-in and redirects');
  assert(!!controlDb.getTenantBySlug('alpha').email_verified_at, 'alpha is now marked verified');

  const secondVerifyAttempt = await request(port, { path: `/api/auth/verify-email/${freshToken}`, host: 'alpha.localhost' });
  assert(secondVerifyAttempt.status === 404, 'the same verification token cannot be consumed a second time');

  const alreadyVerifiedResend = await request(port, { method: 'POST', path: '/api/auth/resend-verification', host: 'alpha.localhost' });
  assert(alreadyVerifiedResend.status === 200 && alreadyVerifiedResend.data.alreadyVerified === true, 'resend on an already-verified tenant no-ops rather than sending another email');

  const loginNowWorks = await request(port, { method: 'POST', path: '/api/auth/login', host: 'alpha.localhost', body: { username: 'ann', password: 'alphapass123' } });
  assert(loginNowWorks.status === 200, 'alpha can now log in normally after verifying');

  // beta and gamma still need verifying before their own logins below.
  await verifyTenantEmail(port, 'beta');
  await verifyTenantEmail(port, 'gamma');

  // ===================================================================================
  // Plan usage caps — gamma stays on its default 'trial' plan for this, so alpha/beta's
  // later upgrade to 'pro' (for the heavy seeding/concurrency sections below) doesn't mask it.
  // ===================================================================================
  const gamma = new Client(port, 'gamma.localhost');
  const gammaLogin = await gamma.post('/api/auth/login', { username: 'gia', password: 'gammapass123' });
  assert(gammaLogin.status === 200, 'gamma owner logs in');
  // trial's staffAccounts cap is 1 — gia's own admin account (created at signup) already uses it.
  const secondStaff = await gamma.post('/api/auth/users', { name: 'Helper', username: 'gamma-helper', password: 'password123', role: 'cashier' });
  assert(secondStaff.status === 403 && secondStaff.data.error === 'usage_cap_reached' && secondStaff.data.cap === 'staffAccounts', 'trial plan\'s 1-staff-account cap blocks a second account');
  // Tighten gamma's item cap via a per-tenant override (the same mechanism a one-off grant
  // would use) to exercise the cap without creating 100 real items.
  controlDb.getControlDb().prepare('UPDATE tenants SET usage_caps_override_json = ? WHERE slug = ?').run(JSON.stringify({ items: 1 }), 'gamma');
  const firstItem = await gamma.post('/api/items', { name: 'GAMMA-ITEM-one', price: 5, cost: 2, stock: 1 });
  assert(firstItem.status === 200, 'the first item is under the (overridden) cap of 1 and succeeds');
  const secondItem = await gamma.post('/api/items', { name: 'GAMMA-ITEM-two', price: 5, cost: 2, stock: 1 });
  assert(secondItem.status === 403 && secondItem.data.error === 'usage_cap_reached' && secondItem.data.cap === 'items', 'a second item is over the overridden cap of 1 and is rejected');
  const updateExisting = await gamma.post('/api/items', { id: firstItem.data.id, name: 'GAMMA-ITEM-one-renamed', price: 5, cost: 2, stock: 1 });
  assert(updateExisting.status === 200, 'editing the existing item (not creating a new one) is unaffected by the cap');
  controlDb.getControlDb().prepare('UPDATE tenants SET usage_caps_override_json = NULL WHERE slug = ?').run('gamma');

  // ===================================================================================
  // Login + basic session/mode guards
  // ===================================================================================
  const alpha = new Client(port, 'alpha.localhost');
  const beta = new Client(port, 'beta.localhost');

  const alphaLogin = await alpha.post('/api/auth/login', { username: 'ann', password: 'alphapass123' });
  assert(alphaLogin.status === 200, 'alpha owner logs in on alpha.localhost');
  const betaLogin = await beta.post('/api/auth/login', { username: 'bo', password: 'betapass123' });
  assert(betaLogin.status === 200, 'beta owner logs in on beta.localhost');

  // Everything below is about isolation and correctness under load, not plan-limit enforcement
  // (covered separately) — upgrade both to the uncapped 'pro' plan so the heavy seeding and
  // 400-request concurrency stress run aren't themselves throttled by server/lib/plans.js's
  // trial-plan staffAccounts/items caps.
  controlDb.updateTenantPlan(controlDb.getTenantBySlug('alpha').id, 'pro');
  controlDb.updateTenantPlan(controlDb.getTenantBySlug('beta').id, 'pro');

  const platformSetup = await platform.post('/api/auth/setup', { name: 'X', username: 'x', password: 'password123' });
  assert(platformSetup.status === 404, '/api/auth/setup 404s on the platform host (no per-tenant first-run in multi-tenant mode)');
  const tenantSetup = await alpha.post('/api/auth/setup', { name: 'X', username: 'x', password: 'password123' });
  assert(tenantSetup.status === 404, '/api/auth/setup also 404s on a real tenant host — signup is the only account-creation path');
  TESTED_PREFIXES.add('/api/auth');

  const licenseGet = await alpha.get('/api/license');
  assert(licenseGet.status === 200 && !('key' in licenseGet.data), 'GET /api/license returns platform-backed status with no key field');
  const licensePost = await alpha.post('/api/license', { key: 'whatever' });
  assert(licensePost.status === 403 && licensePost.data.error === 'managed_by_platform', 'POST /api/license refused — plan is platform-managed');
  const licenseCheck = await alpha.post('/api/license/check', {});
  assert(licenseCheck.status === 403, '/api/license/check refused in multi-tenant mode');
  const licenseDelete = await alpha.del('/api/license');
  assert(licenseDelete.status === 403, 'DELETE /api/license refused in multi-tenant mode');
  TESTED_PREFIXES.add('/api/license');

  const updateRoute = await alpha.get('/api/update/check');
  assert(updateRoute.status === 404, '/api/update is not mounted at all in multi-tenant mode');

  // ===================================================================================
  // Seed tagged data for alpha and beta across every real resource type
  // ===================================================================================
  async function seed(client, TAG) {
    const ids = {};

    const item = await client.post('/api/items', { name: `${TAG}-ITEM-widget`, price: 10, cost: 5, stock: 3 });
    assert(item.status === 200, `${TAG}: item created`);
    ids.itemId = item.data.id;
    TESTED_PREFIXES.add('/api/items');

    const material = await client.post('/api/materials', { name: `${TAG}-MATERIAL-bead`, price: 4, yield: 10, stock: 50 });
    assert(material.status === 200, `${TAG}: material created`);
    ids.materialId = material.data.id;
    TESTED_PREFIXES.add('/api/materials');

    const source = await client.post('/api/sources', { name: `${TAG}-SOURCE-supplier` });
    assert(source.status === 200, `${TAG}: source created`);
    ids.sourceId = source.data.id;
    TESTED_PREFIXES.add('/api/sources');

    const taxPreset = await client.post('/api/tax-presets', { state: `${TAG}-STATE`, salesTaxRate: 6 });
    assert(taxPreset.status === 200, `${TAG}: tax preset created`);
    ids.taxPresetId = taxPreset.data.id;
    TESTED_PREFIXES.add('/api/tax-presets');

    const processor = await client.post('/api/card-processors', { name: `${TAG}-PROCESSOR`, feePct: 2.5 });
    assert(processor.status === 200, `${TAG}: card processor created`);
    ids.processorId = processor.data.id;
    TESTED_PREFIXES.add('/api/card-processors');

    const event = await client.post('/api/events', { name: `${TAG}-EVENT-fair`, start: '2026-05-01', days: 1, cost: 50, status: 'ended', test: false });
    assert(event.status === 200, `${TAG}: event created`);
    ids.eventId = event.data.id;
    TESTED_PREFIXES.add('/api/events');

    const expense = await client.post('/api/event-expenses', { eventId: ids.eventId, label: `${TAG}-EXPENSE-travel`, amount: 25 });
    assert(expense.status === 200, `${TAG}: event expense created`);
    ids.expenseId = expense.data.id;
    TESTED_PREFIXES.add('/api/event-expenses');

    const charity = await client.post('/api/charity-rules', { eventId: ids.eventId, allSales: true, charityPct: 5 });
    assert(charity.status === 200, `${TAG}: charity rule created`);
    ids.charityRuleId = charity.data.id;
    TESTED_PREFIXES.add('/api/charity-rules');

    const order = await client.post('/api/custom-orders', { customerName: `${TAG}-CUSTOMER-jo` });
    assert(order.status === 200, `${TAG}: custom order created`);
    ids.orderId = order.data.id;
    TESTED_PREFIXES.add('/api/custom-orders');

    const sale = await client.post('/api/sales', {
      test: false, tender: 'cash', taxIncluded: false, customerEmail: `${TAG.toLowerCase()}@example.com`,
      lines: [{ name: `${TAG}-SALELINE-mug`, price: 20, qty: 1, taxRate: 0 }],
    });
    assert(sale.status === 200, `${TAG}: sale recorded`);
    ids.saleId = sale.data.id;
    TESTED_PREFIXES.add('/api/sales');

    const partner = await client.post('/api/consignment/partners', { name: `${TAG}-PARTNER-gallery`, commissionPct: 30 });
    assert(partner.status === 200, `${TAG}: consignment partner created`);
    ids.partnerId = partner.data.id;
    const citem = await client.post('/api/consignment/items', { partnerId: ids.partnerId, name: `${TAG}-CITEM-earrings`, qtySent: 10 });
    assert(citem.status === 200, `${TAG}: consignment item created`);
    ids.citemId = citem.data.id;
    TESTED_PREFIXES.add('/api/consignment');

    const branding = await client.post('/api/branding', { name: `${TAG}-BRAND-name` });
    assert(branding.status === 200, `${TAG}: branding set`);
    TESTED_PREFIXES.add('/api/branding');

    const mail = await client.post('/api/email-settings', { from: `${TAG.toLowerCase()}-from@example.com`, alertRecipient: `${TAG.toLowerCase()}-alert@example.com` });
    assert(mail.status === 200, `${TAG}: email alert settings saved`);
    TESTED_PREFIXES.add('/api/email-settings');

    const cashier = await client.post('/api/auth/users', { name: `${TAG}-Cashier`, username: `${TAG.toLowerCase()}-cashier`, password: 'password123', role: 'cashier' });
    assert(cashier.status === 200, `${TAG}: cashier account created`);

    const settingsPost = await client.post('/api/settings', { trackSaleAttribution: TAG === 'ALPHA' });
    assert(settingsPost.status === 200, `${TAG}: settings saved`);
    TESTED_PREFIXES.add('/api/settings');

    const backup = await client.post('/api/maintenance/backups', {});
    assert(backup.status === 200, `${TAG}: manual backup created`);
    TESTED_PREFIXES.add('/api/maintenance');

    const purge = await client.post('/api/test-data/purge', {});
    assert(purge.status === 200, `${TAG}: test-data purge runs (no-op here, no test rows)`);
    TESTED_PREFIXES.add('/api/test-data');

    return ids;
  }

  const aIds = await seed(alpha, 'ALPHA');
  const bIds = await seed(beta, 'BETA');

  // Confirm receipt-email subscriber opt-in flow per tenant, via pool.withTenant (the
  // background-job-style access pattern a scheduler/test uses — proves AsyncLocalStorage
  // context works outside an HTTP request too).
  await new Promise((r) => setTimeout(r, 200)); // emailReceipt() fire-and-forget
  async function confirmSubscriber(tenantSlug, client, email) {
    const tenant = controlDb.getTenantBySlug(tenantSlug);
    const row = await pool.withTenant(tenant.id, () => require('../db').prepare('SELECT * FROM subscribers WHERE email = ?').get(email));
    assert(!!row && row.status === 'pending', `${tenantSlug}: a pending subscriber row exists for its own sale`);
    const confirm = await client.get('/api/subscribers/confirm/' + row.confirm_token);
    assert(confirm.status === 200, `${tenantSlug}: subscriber confirm link works`);
  }
  await confirmSubscriber('alpha', alpha, 'alpha@example.com');
  await confirmSubscriber('beta', beta, 'beta@example.com');
  TESTED_PREFIXES.add('/api/subscribers');

  // ===================================================================================
  // Route-inventory guard
  // ===================================================================================
  const mounted = mountedPrefixes();
  assert(mounted.length > 0, 'route-inventory guard found mount points to audit');
  for (const prefix of mounted) {
    assert(TESTED_PREFIXES.has(prefix), `route-inventory: ${prefix} has an explicit isolation test case`);
  }

  // ===================================================================================
  // Read isolation — every list/read endpoint, scanned for the other tenant's marker
  // ===================================================================================
  async function assertNoLeak(client, ownTag, otherTag, p) {
    const res = await client.get(p);
    const blob = res.raw || '';
    assert(!blob.includes(otherTag), `${ownTag} reading ${p} contains no ${otherTag} marker`);
  }
  const readPaths = [
    '/api/items', '/api/materials', '/api/sources', '/api/tax-presets', '/api/card-processors',
    '/api/events', `/api/event-expenses?eventId=${aIds.eventId}`, `/api/charity-rules?eventId=${aIds.eventId}`,
    '/api/custom-orders', '/api/sales', '/api/subscribers', '/api/consignment/partners',
    '/api/branding', '/api/email-settings', '/api/auth/users', '/api/settings', '/api/maintenance/backups',
  ];
  for (const p of readPaths) {
    await assertNoLeak(alpha, 'alpha', 'BETA', p.replace(aIds.eventId, aIds.eventId));
  }
  const betaReadPaths = readPaths.map((p) => p.replace(String(aIds.eventId), String(bIds.eventId)));
  for (const p of betaReadPaths) {
    await assertNoLeak(beta, 'beta', 'ALPHA', p);
  }

  // ===================================================================================
  // Write isolation — alpha operating on beta's ids must never touch beta's data
  // ===================================================================================
  const betaItemBefore = (await beta.get('/api/items')).data.find((i) => i.id === bIds.itemId);
  await alpha.post('/api/items', { id: bIds.itemId, name: 'HIJACKED-BY-ALPHA', price: 1, cost: 1, stock: 1 });
  const betaItemAfter = (await beta.get('/api/items')).data.find((i) => i.id === bIds.itemId);
  assert(betaItemAfter && betaItemAfter.name === betaItemBefore.name, 'alpha "upserting" beta\'s item id only creates alpha\'s own row — beta\'s item is untouched');
  const alphaOwnCopy = (await alpha.get('/api/items')).data.find((i) => i.id === bIds.itemId);
  assert(alphaOwnCopy && alphaOwnCopy.name === 'HIJACKED-BY-ALPHA', 'the colliding id landed as a harmless new row in alpha\'s own file');

  const delRes = await alpha.del(`/api/items/${bIds.itemId}`);
  assert(delRes.status === 200, 'delete-by-beta-id from alpha returns ok (a no-op against alpha\'s own file)');
  const betaItemStillThere = (await beta.get('/api/items')).data.find((i) => i.id === bIds.itemId);
  assert(!!betaItemStillThere, 'beta\'s real item survived alpha\'s delete-by-id attempt');

  const expDelRes = await alpha.del(`/api/event-expenses/${bIds.expenseId}`);
  assert(expDelRes.status === 200, 'alpha deleting beta\'s expense id is accepted but scoped to alpha\'s own (empty) table');
  const betaExpenses = await beta.get(`/api/event-expenses?eventId=${bIds.eventId}`);
  assert(betaExpenses.data.some((e) => e.id === bIds.expenseId), 'beta\'s expense survived');

  // ===================================================================================
  // File-level backstop — open each tenant's raw .db file and grep for the other's marker
  // ===================================================================================
  const alphaTenant = controlDb.getTenantBySlug('alpha');
  const betaTenant = controlDb.getTenantBySlug('beta');
  // Force a WAL checkpoint so the markers are actually in the main file, not just the -wal
  // sidecar (manual exploratory testing earlier found this to matter after an abrupt stop).
  await pool.withTenant(alphaTenant.id, () => require('../db').pragma('wal_checkpoint(TRUNCATE)'));
  await pool.withTenant(betaTenant.id, () => require('../db').pragma('wal_checkpoint(TRUNCATE)'));
  const alphaFile = fs.readFileSync(pool.dbPathFor(alphaTenant.id)).toString('latin1');
  const betaFile = fs.readFileSync(pool.dbPathFor(betaTenant.id)).toString('latin1');
  assert(!alphaFile.includes('BETA-ITEM'), 'alpha\'s raw db file contains no BETA marker');
  assert(alphaFile.includes('ALPHA-ITEM'), 'alpha\'s raw db file does contain its own marker (sanity check)');
  assert(!betaFile.includes('ALPHA-ITEM'), 'beta\'s raw db file contains no ALPHA marker');
  assert(betaFile.includes('BETA-ITEM'), 'beta\'s raw db file does contain its own marker (sanity check)');

  // ===================================================================================
  // Adversarial requests
  // ===================================================================================
  const crossHost = await request(port, { path: '/api/auth/status', host: 'beta.localhost', cookie: alpha.cookie });
  assert(crossHost.data.loggedIn === false, 'alpha\'s cookie presented on beta\'s host is not logged in');
  const alphaStillWorks = await alpha.get('/api/auth/status');
  assert(alphaStillWorks.data.loggedIn === true, 'alpha\'s own session still works after being replayed at beta — it was never destroyed');

  const spoofedForwardedHost = await request(port, { path: '/api/auth/status', host: 'beta.localhost', headers: { 'X-Forwarded-Host': 'alpha.localhost' }, cookie: alpha.cookie });
  assert(spoofedForwardedHost.data.loggedIn === false, 'X-Forwarded-Host spoofing is ignored — real Host header still wins');

  const spoofedTenantHeader = await request(port, { path: '/api/auth/status', host: 'beta.localhost', headers: { 'X-Tenant': 'alpha', 'X-Tenant-Id': alphaTenant.id }, cookie: alpha.cookie });
  assert(spoofedTenantHeader.data.loggedIn === false, 'X-Tenant / X-Tenant-Id headers are ignored');

  const spoofedQueryParam = await request(port, { path: '/api/auth/status?tenant=alpha', host: 'beta.localhost', cookie: alpha.cookie });
  assert(spoofedQueryParam.data.loggedIn === false, '?tenant= query param is ignored');

  const trailingDot = await request(port, { path: '/api/auth/status', host: 'alpha.localhost.' });
  assert(trailingDot.status === 200, 'a single trailing dot on an otherwise-valid host still resolves (RFC-legal absolute hostname)');

  const subOfSub = await request(port, { path: '/api/auth/status', host: 'x.alpha.localhost' });
  assert(subOfSub.status === 404, 'a sub-subdomain (x.alpha.localhost) is rejected, not treated as alpha');

  const malformedUpper = await request(port, { path: '/api/auth/status', host: 'ALPHA.localhost' });
  assert(malformedUpper.status === 200, 'host matching is case-insensitive (lowercased before comparison)');

  // Hand-edited session row: flip the stored session's tenantId to point at the wrong tenant.
  const cdb = controlDb.getControlDb();
  const rawSid = alpha.cookie.split('=')[1].split('.')[0].replace(/^s%3A/, '');
  const sessRow = cdb.prepare('SELECT * FROM sessions WHERE sid = ?').get(rawSid);
  assert(!!sessRow, 'found alpha\'s session row in the control-plane sessions table');
  if (sessRow) {
    const sess = JSON.parse(sessRow.sess);
    const originalTenantId = sess.tenantId;
    sess.tenantId = betaTenant.id; // tamper: claim to belong to beta instead
    cdb.prepare('UPDATE sessions SET sess = ? WHERE sid = ?').run(JSON.stringify(sess), sessRow.sid);
    const tamperedOnAlphaHost = await alpha.get('/api/auth/status');
    assert(tamperedOnAlphaHost.data.loggedIn === false, 'a session hand-edited to claim a different tenantId is rejected on its original host');
    // restore, and re-log-in since the above call didn't touch the cookie itself
    sess.tenantId = originalTenantId;
    cdb.prepare('UPDATE sessions SET sess = ? WHERE sid = ?').run(JSON.stringify(sess), sessRow.sid);
    const restored = await alpha.get('/api/auth/status');
    assert(restored.data.loggedIn === true, 'restoring the session\'s real tenantId makes it work again');
  }

  // Unauthenticated branding GET returns only the requesting host's own tenant's branding.
  const alphaBrandingAnon = await request(port, { path: '/api/branding', host: 'alpha.localhost' });
  assert(alphaBrandingAnon.data.name === 'ALPHA-BRAND-name', 'unauthenticated branding GET on alpha\'s host returns only alpha\'s branding');
  const betaBrandingAnon = await request(port, { path: '/api/branding', host: 'beta.localhost' });
  assert(betaBrandingAnon.data.name === 'BETA-BRAND-name', 'unauthenticated branding GET on beta\'s host returns only beta\'s branding');

  // ===================================================================================
  // Suspend / reactivate
  // ===================================================================================
  controlDb.updateTenantStatus(alphaTenant.id, 'suspended');
  const suspended = await alpha.get('/api/auth/status');
  assert(suspended.status === 403, 'a suspended tenant 403s immediately, mid-session');
  controlDb.updateTenantStatus(alphaTenant.id, 'active');
  const reactivated = await alpha.get('/api/auth/status');
  assert(reactivated.status === 200 && reactivated.data.loggedIn === true, 'reactivating restores access with the same still-valid session');

  // ===================================================================================
  // Plan gating — flip a tenant's plan, confirm requireFeature reflects it immediately
  // ===================================================================================
  const consignmentAsTrialOrPro = await alpha.get('/api/consignment/partners');
  assert(consignmentAsTrialOrPro.status === 200, 'alpha (pro plan, upgraded above) can reach consignment');
  controlDb.updateTenantPlan(alphaTenant.id, 'basic');
  const consignmentAsBasic = await alpha.get('/api/consignment/partners');
  assert(consignmentAsBasic.status === 403, 'downgrading alpha to the basic plan immediately 403s consignment, same request cycle, no re-login');
  controlDb.updateTenantPlan(alphaTenant.id, 'pro');
  const consignmentAsPro = await alpha.get('/api/consignment/partners');
  assert(consignmentAsPro.status === 200, 'upgrading alpha to pro immediately restores consignment access');

  // ===================================================================================
  // Fail-closed: db access outside any tenant context must throw, never fall back
  // ===================================================================================
  let threw = false;
  try { require('../db').prepare('SELECT 1'); } catch (err) { threw = err.code === 'no_tenant_context' || err.name === 'NoTenantContextError'; }
  assert(threw, 'accessing the db Proxy outside any tenant context throws NoTenantContextError (fails closed)');

  // ===================================================================================
  // Dangerous ops unreachable; disk usage shape
  // ===================================================================================
  const restoreRes = await alpha.post('/api/maintenance/backups/whatever.db/restore', {});
  assert(restoreRes.status === 404, 'restore is disabled outright in multi-tenant mode');
  const diskRes = await alpha.get('/api/maintenance/disk');
  assert(diskRes.status === 200 && !('total' in diskRes.data) && !('free' in diskRes.data), 'disk usage in multi-tenant mode omits host-wide free/total');

  // ===================================================================================
  // Scheduler isolation — one tenant's failure must not stop the others
  // ===================================================================================
  const injected = await forEachActiveTenant((tenant) => {
    if (tenant.slug === 'beta') throw new Error('simulated failure for beta');
    return 'done';
  }, { maxJitterMs: 0 });
  const alphaResult = injected.find((r) => r.slug === 'alpha');
  const betaResult = injected.find((r) => r.slug === 'beta');
  const gammaResult = injected.find((r) => r.slug === 'gamma');
  assert(alphaResult && alphaResult.ok === true, 'scheduler: alpha succeeded');
  assert(betaResult && betaResult.ok === false, 'scheduler: beta\'s injected failure was caught, not thrown');
  assert(gammaResult && gammaResult.ok === true, 'scheduler: gamma still ran despite beta\'s failure (one tenant down does not stop the rest)');

  const backupResults = await runBackupsForAllTenants({ maxJitterMs: 0 });
  assert(backupResults.every((r) => r.ok), 'runBackupsForAllTenants: every active tenant backed up successfully');
  const alphaBackups = await pool.withTenant(alphaTenant.id, () => require('../lib/backup').listBackups());
  const betaBackups = await pool.withTenant(betaTenant.id, () => require('../lib/backup').listBackups());
  assert(alphaBackups.length > 0 && betaBackups.length > 0, 'both tenants have their own backup files after the scheduled run, each read from its own tenant-scoped backupDir()');

  const lowStockResults = await runLowStockForAllTenants({ maxJitterMs: 0 });
  assert(lowStockResults.length >= 3, 'runLowStockForAllTenants ran for every active tenant');

  // ===================================================================================
  // Concurrency — interleaved alpha/beta requests, default pool (no eviction pressure)
  // ===================================================================================
  console.log('\n--- concurrency pass 1/2: default pool ---');
  await concurrencyStress(port, alpha, beta);
  server.close();

  // Pass 2: same scenario, but a fresh process with CRAFTIUM_POOL_MAX=1 so connections are
  // constantly evicted and reopened — proves correctness doesn't depend on a tenant's
  // connection staying pinned in the pool. A real server restart (and therefore a fresh
  // module-level POOL_MAX constant) is required for this, hence the child process.
  console.log('\n--- concurrency pass 2/2: CRAFTIUM_POOL_MAX=1 (forces constant evict/reopen) ---');
  let childOutput;
  try {
    childOutput = execFileSync(process.execPath, [path.join(__dirname, '_mtConcurrencyChild.js')], {
      env: { ...process.env, CRAFTIUM_POOL_MAX: '1' },
      encoding: 'utf8',
    });
  } catch (err) {
    childOutput = (err.stdout || '') + (err.stderr || '');
  }
  console.log(childOutput.trim());
  const childFailures = Number((/CHILD_FAILURES=(\d+)/.exec(childOutput) || [])[1]);
  assert(Number.isFinite(childFailures) && childFailures === 0, `concurrency pass with CRAFTIUM_POOL_MAX=1 reported ${childFailures} failure(s)`);

  fs.rmSync(dataRoot, { recursive: true, force: true });

  if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1); }
  console.log('\nAll assertions passed.');
  process.exit(0);
}

async function concurrencyStress(port, alpha, beta) {
  const N = 200; // 200 alpha + 200 beta, interleaved = 400 total
  const alphaCalls = Array.from({ length: N }, (_, i) =>
    request(port, { method: 'POST', path: '/api/items', host: 'alpha.localhost', cookie: alpha.cookie, body: { name: `ALPHA-STRESS-${i}`, price: 1, cost: 1, stock: 1 } }));
  const betaCalls = Array.from({ length: N }, (_, i) =>
    request(port, { method: 'POST', path: '/api/items', host: 'beta.localhost', cookie: beta.cookie, body: { name: `BETA-STRESS-${i}`, price: 1, cost: 1, stock: 1 } }));
  const interleaved = [];
  for (let i = 0; i < N; i++) { interleaved.push(alphaCalls[i]); interleaved.push(betaCalls[i]); }
  const results = await Promise.all(interleaved);
  assert(results.every((r) => r.status === 200), 'concurrency: every interleaved create succeeded');

  const alphaList = await alpha.get('/api/items');
  const betaList = await beta.get('/api/items');
  const alphaStressCount = alphaList.data.filter((i) => i.name.startsWith('ALPHA-STRESS-')).length;
  const betaStressCount = betaList.data.filter((i) => i.name.startsWith('BETA-STRESS-')).length;
  assert(alphaStressCount === N, `concurrency: alpha ended with exactly its own ${N} stress items (got ${alphaStressCount})`);
  assert(betaStressCount === N, `concurrency: beta ended with exactly its own ${N} stress items (got ${betaStressCount})`);
  assert(!alphaList.data.some((i) => i.name.startsWith('BETA-STRESS-')), 'concurrency: alpha has zero BETA-STRESS items');
  assert(!betaList.data.some((i) => i.name.startsWith('ALPHA-STRESS-')), 'concurrency: beta has zero ALPHA-STRESS items');
}

main().catch((err) => { console.error(err); process.exit(1); });
