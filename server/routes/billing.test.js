// Standalone test for Stripe billing groundwork (server/lib/billing.js, server/routes/
// billing.js, and the webhook route in server/routes/platform.js) — same boot-the-real-server-
// in-process pattern as the other server/routes/*.test.js files. No real Stripe account is
// involved anywhere here (there isn't one yet — see server/lib/billing.js's own comment); the
// webhook half uses the real Stripe SDK's own HMAC signing helper against a fake secret, so the
// signature-verification code path is exercised for real, just not against Stripe's servers.
//
// CRAFTIUM_STRIPE_* env vars are read once, at module load, by server/lib/billing.js — so
// "unconfigured" and "configured" can never both be exercised in the same process. This file's
// default run covers "unconfigured" (the real state of an install with no Stripe account yet,
// which is what this groundwork must behave cleanly under right now) and then re-spawns itself
// as a child process with fake Stripe credentials set for the "configured" half.
// Run with: node server/routes/billing.test.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error(`FAIL: ${msg}`); }
  else console.log(`ok: ${msg}`);
}

function request(port, { method = 'GET', path: p, host, headers = {}, body, rawBody, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = rawBody !== undefined ? rawBody : (body !== undefined ? JSON.stringify(body) : undefined);
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
}

function baseEnv(dataDir) {
  process.env.CRAFTIUM_MODE = 'multi-tenant';
  process.env.CRAFTIUM_DATA_ROOT = dataDir;
  process.env.CRAFTIUM_BASE_DOMAIN = 'localhost';
  process.env.CRAFTIUM_SESSION_SECRET = 'x'.repeat(40);
  process.env.CRAFTIUM_SMTP_HOST = 'localhost';
  process.env.CRAFTIUM_SMTP_PORT = '2525';
  process.env.CRAFTIUM_PLATFORM_FROM = 'Craftium <hello@example.com>';
}

// ===================================================================================
// "Unconfigured" — no CRAFTIUM_STRIPE_* set at all, the actual state of a real install with no
// Stripe account yet. Every billing surface must report that cleanly, never crash or 500.
// ===================================================================================
async function runUnconfigured() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'craftium-billing-'));
  baseEnv(dataDir);

  const { startServer } = require('../index');
  const controlDb = require('../control/db');
  const billing = require('../lib/billing');
  assert(billing.isBillingConfigured() === false, 'isBillingConfigured() is false with no CRAFTIUM_STRIPE_SECRET_KEY set');
  assert(billing.purchasablePlans().length === 0, 'purchasablePlans() is empty with billing unconfigured');

  const { server, port } = await startServer(0);

  const platform = new Client(port, 'localhost');
  await platform.post('/api/platform/signup', { businessName: 'Acme Crafts', slug: 'acme', ownerName: 'Al', email: 'al@example.com', username: 'al', password: 'alpassword123' });
  controlDb.markTenantEmailVerified(controlDb.getTenantBySlug('acme').id);

  const acme = new Client(port, 'acme.localhost');
  await acme.post('/api/auth/login', { username: 'al', password: 'alpassword123' });

  const status = await acme.get('/api/billing/status');
  assert(status.status === 200 && status.data.configured === false, 'GET /api/billing/status reports configured:false');
  assert(status.data.plan === 'trial', 'a fresh tenant is on the trial plan');
  assert(Array.isArray(status.data.purchasablePlans) && status.data.purchasablePlans.length === 0, 'no plans are purchasable with billing unconfigured');

  const checkout = await acme.post('/api/billing/checkout', { plan: 'basic' });
  assert(checkout.status === 503 && checkout.data.error === 'not_configured', 'POST /api/billing/checkout cleanly refuses rather than touching the (nonexistent) Stripe SDK');

  const portalRes = await acme.post('/api/billing/portal', {});
  assert(portalRes.status === 503 && portalRes.data.error === 'not_configured', 'POST /api/billing/portal cleanly refuses the same way');

  const webhook = await request(port, { method: 'POST', path: '/api/platform/stripe-webhook', host: 'localhost', rawBody: '{}', headers: { 'stripe-signature': 'fake' } });
  assert(webhook.status === 503 && webhook.data.error === 'not_configured', 'the webhook route refuses cleanly with no Stripe key set, never attempting signature verification');

  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

// ===================================================================================
// "Configured" — fake (not real) Stripe credentials, run in a child process (see main() below)
// since billing.js reads them once at module load. Covers price<->plan mapping, the webhook
// route's real signature verification (genuinely computed, just not against Stripe's servers),
// and the plan-sync policy for every subscription status — everything except an actual network
// call to Stripe (checkout/portal session creation), which would need a real account.
// ===================================================================================
async function runConfigured() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'craftium-billing-cfg-'));
  baseEnv(dataDir);

  const { startServer } = require('../index');
  const controlDb = require('../control/db');
  const billing = require('../lib/billing');
  const Stripe = require('stripe');

  assert(billing.isBillingConfigured() === true, 'isBillingConfigured() is true once CRAFTIUM_STRIPE_SECRET_KEY is set');
  assert(billing.planForPriceId('price_basic_fake') === 'basic', 'planForPriceId maps the configured basic price back to the basic plan');
  assert(billing.planForPriceId('price_pro_fake') === 'pro', 'planForPriceId maps the configured pro price back to the pro plan');
  assert(billing.planForPriceId('price_unknown') === null, 'an unrecognized price id maps to null rather than guessing');
  assert(billing.purchasablePlans().slice().sort().join(',') === 'basic,pro', 'purchasablePlans lists exactly the plans with a configured price');

  const { server, port } = await startServer(0);

  const platform = new Client(port, 'localhost');
  await platform.post('/api/platform/signup', { businessName: 'Acme Crafts', slug: 'acme', ownerName: 'Al', email: 'al@example.com', username: 'al', password: 'alpassword123' });
  controlDb.markTenantEmailVerified(controlDb.getTenantBySlug('acme').id);
  const acmeTenant = controlDb.getTenantBySlug('acme');

  const acme = new Client(port, 'acme.localhost');
  await acme.post('/api/auth/login', { username: 'al', password: 'alpassword123' });

  const status = await acme.get('/api/billing/status');
  assert(status.status === 200 && status.data.configured === true, 'GET /api/billing/status reports configured:true once Stripe env vars are set');
  assert(status.data.purchasablePlans.slice().sort().join(',') === 'basic,pro', 'status reports both purchasable plans');

  // Stand in for what a real checkout would do (attaching a Stripe customer id to the tenant) —
  // this is the one thing the webhook handler uses to match an incoming event to a tenant, and
  // it's exactly what billing.js#createCheckoutSession itself saves, just without needing a
  // live Stripe account to actually run a checkout.
  controlDb.setTenantStripeCustomer(acmeTenant.id, 'cus_fake123');

  const stripeHelper = Stripe(process.env.CRAFTIUM_STRIPE_SECRET_KEY);
  function sign(eventObj) {
    const payload = JSON.stringify(eventObj);
    const header = stripeHelper.webhooks.generateTestHeaderString({ payload, secret: process.env.CRAFTIUM_STRIPE_WEBHOOK_SECRET });
    return { payload, header };
  }
  function subEvent(type, { customer = 'cus_fake123', status, priceId, id = 'sub_fake1' } = {}) {
    return { id: 'evt_' + Math.random().toString(36).slice(2), type, data: { object: { id, customer, status, items: { data: [{ price: { id: priceId } }] } } } };
  }
  async function postWebhook(payload, header) {
    return request(port, { method: 'POST', path: '/api/platform/stripe-webhook', host: 'localhost', rawBody: payload, headers: { 'stripe-signature': header } });
  }

  // 1) A subscription goes active on the basic price -> tenant adopts the basic plan.
  {
    const { payload, header } = sign(subEvent('customer.subscription.updated', { status: 'active', priceId: 'price_basic_fake' }));
    const res = await postWebhook(payload, header);
    assert(res.status === 200 && res.data.received === true, 'a correctly-signed subscription.updated event is accepted');
    const t = controlDb.getTenantById(acmeTenant.id);
    assert(t.plan === 'basic' && t.stripe_subscription_status === 'active', `tenant adopts the basic plan on an active subscription for the basic price (got plan=${t.plan}, status=${t.stripe_subscription_status})`);
  }

  // 2) Upgrading to the pro price moves the tenant to pro on the very next event.
  {
    const { payload, header } = sign(subEvent('customer.subscription.updated', { status: 'active', priceId: 'price_pro_fake' }));
    const res = await postWebhook(payload, header);
    assert(res.status === 200, 'pro-price event accepted');
    const t = controlDb.getTenantById(acmeTenant.id);
    assert(t.plan === 'pro', `tenant moves to the pro plan on the next active-status event for the pro price (got ${t.plan})`);
  }

  // 3) A failed payment going past_due only updates the status shown — Stripe's own dunning
  // retries run on its own schedule; this is not an immediate cutoff mid-grace-period.
  {
    const { payload, header } = sign(subEvent('customer.subscription.updated', { status: 'past_due', priceId: 'price_pro_fake' }));
    const res = await postWebhook(payload, header);
    assert(res.status === 200, 'past_due event accepted');
    const t = controlDb.getTenantById(acmeTenant.id);
    assert(t.plan === 'pro' && t.stripe_subscription_status === 'past_due', `past-due only updates the shown status; plan stays pro during Stripe's own grace period (got plan=${t.plan}, status=${t.stripe_subscription_status})`);
  }

  // 4) Cancellation falls back to the free trial plan — the account and its data are untouched,
  // this is not the same thing as suspension.
  {
    const { payload, header } = sign(subEvent('customer.subscription.deleted', { status: 'canceled', priceId: 'price_pro_fake' }));
    const res = await postWebhook(payload, header);
    assert(res.status === 200, 'subscription.deleted event accepted');
    const t = controlDb.getTenantById(acmeTenant.id);
    assert(t.plan === 'trial' && t.stripe_subscription_status === 'canceled', `canceling falls back to the free trial plan (got plan=${t.plan}, status=${t.stripe_subscription_status})`);
    const stillExists = controlDb.getTenantBySlug('acme');
    assert(stillExists && stillExists.status === 'active', 'the tenant account itself is completely untouched by cancellation');
  }

  // 5) An event for a Stripe customer id with no matching tenant is a safe no-op, not a crash —
  // Stripe retries a webhook that errors, and there would be nothing to retry into.
  {
    const { payload, header } = sign(subEvent('customer.subscription.updated', { customer: 'cus_does_not_exist', status: 'active', priceId: 'price_basic_fake' }));
    const res = await postWebhook(payload, header);
    assert(res.status === 200, 'an event for an unmatched customer id is accepted (and ignored), not a 500');
  }

  // 6) A forged signature is rejected outright — the actual security boundary on this endpoint,
  // since it has no session/login of its own.
  {
    const payload = JSON.stringify(subEvent('customer.subscription.updated', { status: 'active', priceId: 'price_basic_fake' }));
    const res = await postWebhook(payload, 't=1,v1=' + '0'.repeat(64));
    assert(res.status === 400 && res.data.error === 'bad_signature', 'a forged Stripe-Signature header is rejected with 400, never processed');
    const t = controlDb.getTenantById(acmeTenant.id);
    assert(t.plan === 'trial', 'the forged event had no effect — tenant is still on trial from step 4, not reverted to basic');
  }

  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

async function main() {
  if (process.env.CRAFTIUM_BILLING_TEST_CONFIGURED === '1') {
    await runConfigured();
  } else {
    await runUnconfigured();
    try {
      execFileSync(process.execPath, [__filename], {
        stdio: 'inherit',
        env: {
          ...process.env,
          CRAFTIUM_BILLING_TEST_CONFIGURED: '1',
          CRAFTIUM_STRIPE_SECRET_KEY: 'sk_test_fake_for_tests',
          CRAFTIUM_STRIPE_WEBHOOK_SECRET: 'whsec_test_fake_for_tests',
          CRAFTIUM_STRIPE_PRICE_BASIC: 'price_basic_fake',
          CRAFTIUM_STRIPE_PRICE_PRO: 'price_pro_fake',
        },
      });
    } catch {
      failures++;
      console.error('FAIL: the "configured" sub-process reported failures (see its output above)');
    }
  }
  console.log(failures === 0 ? '\nAll assertions passed.' : `\n${failures} assertion(s) FAILED.`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
