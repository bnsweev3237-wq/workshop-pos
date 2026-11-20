// Standalone adversarial test for the platform admin console (no test framework in this repo —
// same boot-the-real-server-in-process pattern as multitenant.isolation.test.js). The point of
// this one is the impersonation mechanism: it's a deliberate, narrow exception to tenant
// isolation (a platform staff member can log into a tenant without its password), so the thing
// that actually matters is that the exception stays exactly as narrow as designed — scoped to
// the one tenant a link was minted for, single-use, visible to the real account holder.
// Run with: node server/routes/platformAdmin.test.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'craftium-admin-'));
process.env.CRAFTIUM_MODE = 'multi-tenant';
process.env.CRAFTIUM_DATA_ROOT = dataRoot;
process.env.CRAFTIUM_BASE_DOMAIN = 'localhost';
process.env.CRAFTIUM_SESSION_SECRET = 'x'.repeat(40);
// Required to boot (server/lib/platformMail.js#assertPlatformMailConfigured) — this file
// marks tenants verified directly via control.db rather than exercising the real email flow
// (that's multitenant.isolation.test.js's job), so nothing here actually needs mail to send.
process.env.CRAFTIUM_SMTP_HOST = 'localhost';
process.env.CRAFTIUM_SMTP_PORT = '2525';
process.env.CRAFTIUM_PLATFORM_FROM = 'Craftium <hello@example.com>';

const { startServer } = require('../index');
const controlDb = require('../control/db');
const { createPlatformUserRow } = require('../lib/platformUsers');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error(`FAIL: ${msg}`); }
  else console.log(`ok: ${msg}`);
}

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
        resolve({ status: res.statusCode, data: json, raw, headers: res.headers, setCookie: setCookie ? setCookie[0].split(';')[0] : null });
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
  del(p) { return this.call('DELETE', p); }
}

async function main() {
  const { server, port } = await startServer(0);

  // Seed two tenants the normal way.
  const platform = new Client(port, 'localhost');
  await platform.post('/api/platform/signup', { businessName: 'Alpha Crafts', slug: 'alpha', ownerName: 'Ann', email: 'ann@example.com', username: 'ann', password: 'alphapass123' });
  await platform.post('/api/platform/signup', { businessName: 'Beta Shop', slug: 'beta', ownerName: 'Bo', email: 'bo@example.com', username: 'bo', password: 'betapass123' });
  // This file's focus is the admin console/impersonation mechanism, not the email-verification
  // flow (that's multitenant.isolation.test.js's job) — mark both verified directly so login
  // below works without re-deriving that whole flow here.
  controlDb.markTenantEmailVerified(controlDb.getTenantBySlug('alpha').id);
  controlDb.markTenantEmailVerified(controlDb.getTenantBySlug('beta').id);
  const alphaTenant = controlDb.getTenantBySlug('alpha');
  const betaTenant = controlDb.getTenantBySlug('beta');

  // Seed staff accounts directly (CLI's job normally — exercised separately by hand).
  const cdb = controlDb.getControlDb();
  createPlatformUserRow(cdb, { username: 'opsadmin', password: 'opspass123', role: 'admin' });
  createPlatformUserRow(cdb, { username: 'opssupport', password: 'opspass123', role: 'support' });

  // ===================================================================================
  // Staff login + role gating
  // ===================================================================================
  const admin = new Client(port, 'localhost');
  const support = new Client(port, 'localhost');
  const badLogin = await admin.post('/api/platform/admin/login', { username: 'opsadmin', password: 'wrong' });
  assert(badLogin.status === 401, 'wrong password rejected');
  const adminLogin = await admin.post('/api/platform/admin/login', { username: 'opsadmin', password: 'opspass123' });
  assert(adminLogin.status === 200 && adminLogin.data.me.role === 'admin', 'admin staff login works');
  const supportLogin = await support.post('/api/platform/admin/login', { username: 'opssupport', password: 'opspass123' });
  assert(supportLogin.status === 200 && supportLogin.data.me.role === 'support', 'support staff login works');

  const supportTenants = await support.get('/api/platform/admin/tenants');
  assert(supportTenants.status === 200 && supportTenants.data.length === 2, 'support can list tenants');
  const supportUpdateCheck = await support.get('/api/platform/admin/update/check');
  assert(supportUpdateCheck.status === 403, 'support is refused /update/check');
  const supportUpdateApply = await support.post('/api/platform/admin/update/apply', {});
  assert(supportUpdateApply.status === 403, 'support is refused /update/apply');
  const supportStaffList = await support.get('/api/platform/admin/staff');
  assert(supportStaffList.status === 403, 'support is refused /staff');

  const adminUpdateCheck = await admin.get('/api/platform/admin/update/check');
  assert(adminUpdateCheck.status === 200, 'admin can reach /update/check');
  const adminStaffList = await admin.get('/api/platform/admin/staff');
  assert(adminStaffList.status === 200 && adminStaffList.data.length === 2, 'admin can list staff');

  // ===================================================================================
  // Platform email settings — admin-only, DB-saved values override the env-var fallback
  // this test process booted with (CRAFTIUM_SMTP_HOST/CRAFTIUM_PLATFORM_FROM, set above).
  // ===================================================================================
  const supportMailGet = await support.get('/api/platform/admin/mail-settings');
  assert(supportMailGet.status === 403, 'support cannot read platform mail settings');
  const supportMailSave = await support.post('/api/platform/admin/mail-settings', { host: 'evil.example.com' });
  assert(supportMailSave.status === 403, 'support cannot change platform mail settings');

  const mailBefore = await admin.get('/api/platform/admin/mail-settings');
  assert(mailBefore.status === 200 && mailBefore.data.host === 'localhost' && mailBefore.data.configured === true, 'before any save, mail settings reflect the env-var fallback this process booted with');

  const badFrom = await admin.post('/api/platform/admin/mail-settings', { from: 'not-an-email' });
  assert(badFrom.status === 400, 'saving an invalid "from" address is rejected');

  const mailSave = await admin.post('/api/platform/admin/mail-settings', {
    host: 'mail.smtp2go.com', port: 2525, secure: false, user: 'smtpuser', password: 'smtppass', from: 'Craftium <noreply@example.com>',
  });
  assert(mailSave.status === 200 && mailSave.data.host === 'mail.smtp2go.com' && mailSave.data.hasPassword === true, 'admin can save platform mail settings');
  assert(!('password' in mailSave.data) && !('pass' in mailSave.data), 'the saved password is never echoed back');

  const mailAfter = await admin.get('/api/platform/admin/mail-settings');
  assert(mailAfter.data.host === 'mail.smtp2go.com', 'the DB-saved host now wins over the env-var fallback');

  const resaveNoPassword = await admin.post('/api/platform/admin/mail-settings', { host: 'mail.smtp2go.com', port: 2525, secure: false, user: 'smtpuser', password: '', from: 'Craftium <noreply@example.com>' });
  assert(resaveNoPassword.data.hasPassword === true, 'saving again with a blank password keeps the previously-saved one, same convention as tenant mail settings');

  const badTestRecipient = await admin.post('/api/platform/admin/mail-settings/test', { to: 'not-an-email' });
  assert(badTestRecipient.status === 400, 'test-send rejects an invalid recipient address');
  const realTestSend = await admin.post('/api/platform/admin/mail-settings/test', { to: 'someone@example.com' });
  // This test process has no real SMTP server to actually deliver to — the point here is that
  // it genuinely attempted to connect (service unavailable / send_failed), not a validation
  // error, proving it reads through to a real transport rather than short-circuiting.
  assert(realTestSend.status === 502 && realTestSend.data.error === 'send_failed', 'test-send attempts a real connection (expected to fail — no real mail server in this test run)');

  const unauthTenants = await request(port, { path: '/api/platform/admin/tenants', host: 'localhost' });
  assert(unauthTenants.status === 401, 'an unauthenticated request to /tenants is rejected');

  // Disk usage reflects real seeded data.
  const alphaRow = (await admin.get('/api/platform/admin/tenants')).data.find((t) => t.slug === 'alpha');
  assert(alphaRow.dbBytes > 0, 'alpha\'s listed db size is nonzero (a real file)');

  // ===================================================================================
  // Impersonation — the critical isolation-preserving case
  // ===================================================================================
  const alphaAdminClient = new Client(port, 'alpha.localhost');
  await alphaAdminClient.post('/api/auth/login', { username: 'ann', password: 'alphapass123' });
  const beforeStatus = await alphaAdminClient.get('/api/auth/status');
  assert(beforeStatus.data.supportSessionActive === false, 'no support session active yet');

  const mint = await support.post(`/api/platform/admin/tenants/${alphaTenant.id}/impersonate`, {});
  assert(mint.status === 200 && mint.data.url.includes('/api/auth/impersonate/'), 'support can mint an impersonation link for alpha');
  const token = mint.data.url.split('/').pop();

  const wrongHost = await request(port, { path: `/api/auth/impersonate/${token}`, host: 'beta.localhost' });
  assert(wrongHost.status === 404, 'a token minted for alpha is refused on beta\'s host, even though it\'s real and unexpired');
  const betaStatusUnaffected = (await request(port, { path: '/api/auth/status', host: 'beta.localhost' })).data;
  assert(betaStatusUnaffected.supportSessionActive === false, 'beta is completely unaffected by alpha\'s token being tried against it');

  const correctHost = await request(port, { path: `/api/auth/impersonate/${token}`, host: 'alpha.localhost' });
  assert(correctHost.status === 302 && correctHost.headers['set-cookie'], 'consuming the token on alpha\'s own host logs in and redirects');
  const supportSessionCookie = correctHost.headers['set-cookie'][0].split(';')[0];

  const afterStatusRealAdmin = await alphaAdminClient.get('/api/auth/status');
  assert(afterStatusRealAdmin.data.supportSessionActive === true, 'the REAL admin\'s own, separate, already-open session now sees the banner too');
  assert(afterStatusRealAdmin.data.isSupportSession === false, 'the real admin\'s own session is not itself flagged as the support session');

  const supportOwnStatus = await request(port, { path: '/api/auth/status', host: 'alpha.localhost', cookie: supportSessionCookie });
  assert(supportOwnStatus.data.supportSessionActive === true && supportOwnStatus.data.isSupportSession === true, 'the support agent\'s own session sees both flags');

  const secondUse = await request(port, { path: `/api/auth/impersonate/${token}`, host: 'alpha.localhost' });
  assert(secondUse.status === 404, 'the same token cannot be consumed a second time');

  const bogusToken = await request(port, { path: '/api/auth/impersonate/not-a-real-token-at-all', host: 'alpha.localhost' });
  assert(bogusToken.status === 404, 'an unknown token is rejected');

  // Expired (never-consumed) token.
  const mint2 = await support.post(`/api/platform/admin/tenants/${alphaTenant.id}/impersonate`, {});
  const token2 = mint2.data.url.split('/').pop();
  cdb.prepare('UPDATE support_sessions SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, token2);
  const expired = await request(port, { path: `/api/auth/impersonate/${token2}`, host: 'alpha.localhost' });
  assert(expired.status === 404, 'an expired (never-consumed) token is rejected');

  // End it — either side can.
  const ended = await alphaAdminClient.post('/api/auth/end-support-session', {});
  assert(ended.status === 200, 'the real admin can end the active support session');
  const afterEnded = await alphaAdminClient.get('/api/auth/status');
  assert(afterEnded.data.supportSessionActive === false, 'the banner clears for everyone once ended');

  // ===================================================================================
  // Staff management
  // ===================================================================================
  const created = await admin.post('/api/platform/admin/staff', { username: 'newsupport', password: 'password123', role: 'support' });
  assert(created.status === 200, 'admin can create a new staff account');
  const dupe = await admin.post('/api/platform/admin/staff', { username: 'newsupport', password: 'password123', role: 'support' });
  assert(dupe.status === 409, 'duplicate staff username rejected');
  const lastAdminDelete = await admin.del(`/api/platform/admin/staff/${(await admin.get('/api/platform/admin/staff')).data.find((s) => s.username === 'opsadmin').id}`);
  assert(lastAdminDelete.status === 409, 'the last admin staff account cannot be removed');

  server.close();

  // ===================================================================================
  // Single-tenant regression
  // ===================================================================================
  delete process.env.CRAFTIUM_MODE;
  delete process.env.CRAFTIUM_DATA_ROOT;
  delete process.env.CRAFTIUM_BASE_DOMAIN;
  delete process.env.CRAFTIUM_SESSION_SECRET;
  const stDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'craftium-admin-st-'));
  const childEnv = { ...process.env, WORKSHOP_DATA_DIR: stDataDir };
  const out = execFileSync(process.execPath, ['-e', `
    process.env.WORKSHOP_DATA_DIR = ${JSON.stringify(stDataDir)};
    const { startServer } = require(${JSON.stringify(path.join(__dirname, '..', 'index.js'))});
    startServer(0).then(async ({ server, port }) => {
      const res1 = await fetch('http://localhost:' + port + '/api/platform/admin/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' });
      const res2 = await fetch('http://localhost:' + port + '/api/auth/impersonate/x');
      console.log('ADMIN_LOGIN_STATUS=' + res1.status);
      console.log('IMPERSONATE_STATUS=' + res2.status);
      server.close();
      process.exit(0);
    }).catch((e) => { console.error(e); process.exit(1); });
  `], { env: childEnv, encoding: 'utf8' });
  console.log(out.trim());
  assert(/ADMIN_LOGIN_STATUS=404/.test(out), 'single-tenant mode: /api/platform/admin/login is not mounted (404)');
  assert(/IMPERSONATE_STATUS=404/.test(out), 'single-tenant mode: /api/auth/impersonate/:token 404s (isMultiTenant guard)');
  fs.rmSync(stDataDir, { recursive: true, force: true });

  fs.rmSync(dataRoot, { recursive: true, force: true });

  if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1); }
  console.log('\nAll assertions passed.');
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
