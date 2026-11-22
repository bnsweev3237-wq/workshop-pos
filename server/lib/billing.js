// Stripe billing — groundwork for self-serve subscriptions in multi-tenant mode. Deliberately
// inert with no CRAFTIUM_STRIPE_SECRET_KEY set: isBillingConfigured() is false, the Stripe SDK
// is never constructed, and server/routes/billing.js's endpoints all report "not configured"
// rather than erroring. Flipping it on later (once there's a real Stripe account) is meant to
// be an env-var change only — nothing here should need code changes to go live.
//
// Only the two paid plans in server/lib/plans.js (basic, pro) have a Stripe price behind them —
// trial is the free/default tier nobody buys a subscription for. A tenant without a configured
// price for a given CRAFTIUM_STRIPE_PRICE_* env var simply can't check out into that plan yet.
const controlDb = require('../control/db');
const { PLANS } = require('./plans');

const STRIPE_SECRET_KEY = process.env.CRAFTIUM_STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.CRAFTIUM_STRIPE_WEBHOOK_SECRET || '';

// plan name -> Stripe price id, built from one env var per paid plan. Only plans.js's own plan
// names are ever looked up here, so a typo'd env var name just leaves that plan unpurchasable
// rather than silently mapping to the wrong thing.
const PLAN_TO_PRICE = {
  basic: process.env.CRAFTIUM_STRIPE_PRICE_BASIC || '',
  pro: process.env.CRAFTIUM_STRIPE_PRICE_PRO || '',
};
const PRICE_TO_PLAN = Object.fromEntries(
  Object.entries(PLAN_TO_PRICE).filter(([, priceId]) => priceId).map(([plan, priceId]) => [priceId, plan])
);

function isBillingConfigured() {
  return !!STRIPE_SECRET_KEY;
}

// The plan names that actually have a price configured right now — what the "Upgrade" UI
// offers. Empty whenever billing isn't configured at all, same as every other call here.
function purchasablePlans() {
  if (!isBillingConfigured()) return [];
  return Object.keys(PLANS).filter((p) => PLAN_TO_PRICE[p]);
}

function planForPriceId(priceId) {
  return PRICE_TO_PLAN[priceId] || null;
}

// Lazy — the Stripe SDK is never constructed (and CRAFTIUM_STRIPE_SECRET_KEY never read into
// it) unless something actually needs to make a call, which only happens once isBillingConfigured()
// is true.
let _stripe = null;
function stripeClient() {
  if (!_stripe) _stripe = require('stripe')(STRIPE_SECRET_KEY);
  return _stripe;
}

class BillingError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Mints (or reuses) the Stripe customer behind a tenant and starts a subscription Checkout for
// one of the paid plans. The customer id is saved back to the tenant row immediately — before
// checkout even completes — both so a second attempt reuses it instead of creating a duplicate
// customer, and because it's how the webhook handler below matches an incoming event back to a
// tenant (customer id is the one identifier Stripe hands back on every subscription event).
async function createCheckoutSession({ tenant, plan, successUrl, cancelUrl }) {
  if (!isBillingConfigured()) throw new BillingError('not_configured', 'Billing isn’t set up yet.');
  const priceId = PLAN_TO_PRICE[plan];
  if (!priceId) throw new BillingError('unknown_plan', 'That plan isn’t available to purchase.');
  const stripe = stripeClient();
  let customerId = tenant.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: tenant.owner_email || undefined,
      name: tenant.business_name,
      metadata: { tenantId: tenant.id, slug: tenant.slug },
    });
    customerId = customer.id;
    controlDb.setTenantStripeCustomer(tenant.id, customerId);
  }
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    subscription_data: { metadata: { tenantId: tenant.id } },
  });
  return { url: session.url };
}

// The Stripe-hosted "manage my subscription" page (update card, see invoices, cancel) — needs
// an existing customer, i.e. at least one checkout already started.
async function createPortalSession({ tenant, returnUrl }) {
  if (!isBillingConfigured()) throw new BillingError('not_configured', 'Billing isn’t set up yet.');
  if (!tenant.stripe_customer_id) throw new BillingError('no_customer', 'Subscribe to a plan first.');
  const session = await stripeClient().billingPortal.sessions.create({
    customer: tenant.stripe_customer_id,
    return_url: returnUrl,
  });
  return { url: session.url };
}

// Verifies the raw request body actually came from Stripe (the signature covers the exact
// bytes — see server/index.js for why the webhook route gets the unparsed body) and returns the
// parsed event. Throws on a bad/missing signature; the route turns that into a 400.
function constructWebhookEvent(rawBody, signature) {
  if (!isBillingConfigured()) throw new BillingError('not_configured', 'Billing isn’t set up yet.');
  if (!STRIPE_WEBHOOK_SECRET) throw new BillingError('no_webhook_secret', 'CRAFTIUM_STRIPE_WEBHOOK_SECRET isn’t set.');
  return stripeClient().webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
}

// The actual plan-sync policy, applied to an already-verified event. Deliberately takes a plain
// event object rather than reaching into Stripe itself, so it's testable with a hand-built event
// and so a signature failure can never reach this far. Unrecognized event types are a silent
// no-op — Stripe's webhook surface is broad and this only needs to care about subscription
// lifecycle, not every event a Stripe account can emit.
//
// Policy (deliberately simple — revisit once there's a real billing history to react to):
//   - active/trialing with a recognized price -> adopt that price's plan.
//   - canceled/unpaid/incomplete_expired -> fall back to the free 'trial' plan. The tenant and
//     its data are untouched (this is not the same as suspension); it just loses whatever the
//     paid plan's feature flags/usage caps granted on top of trial's.
//   - past_due/incomplete -> keep the current plan as-is (Stripe is still retrying the charge
//     per its own dunning schedule); only the status string changes, for display.
// A subscription event for a customer id with no matching tenant is logged and ignored rather
// than thrown — Stripe retries a webhook that errors, and there's nothing to retry into.
async function applyWebhookEvent(event) {
  const obj = event.data && event.data.object;
  if (!obj) return;

  if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
    const tenant = controlDb.getTenantByStripeCustomerId(obj.customer);
    if (!tenant) { console.error(`Stripe webhook: no tenant for customer ${obj.customer}`); return; }
    const priceId = obj.items && obj.items.data && obj.items.data[0] && obj.items.data[0].price && obj.items.data[0].price.id;
    const plan = planForPriceId(priceId);
    let nextPlan = tenant.plan;
    if (obj.status === 'active' || obj.status === 'trialing') {
      if (plan) nextPlan = plan;
    } else if (obj.status === 'canceled' || obj.status === 'unpaid' || obj.status === 'incomplete_expired') {
      nextPlan = 'trial';
    }
    controlDb.updateTenantSubscription(tenant.id, { subscriptionId: obj.id, status: obj.status, plan: nextPlan });
    return;
  }

  if (event.type === 'customer.subscription.deleted') {
    const tenant = controlDb.getTenantByStripeCustomerId(obj.customer);
    if (!tenant) { console.error(`Stripe webhook: no tenant for customer ${obj.customer}`); return; }
    controlDb.updateTenantSubscription(tenant.id, { subscriptionId: obj.id, status: 'canceled', plan: 'trial' });
  }
}

module.exports = {
  isBillingConfigured, purchasablePlans, planForPriceId, createCheckoutSession, createPortalSession,
  constructWebhookEvent, applyWebhookEvent, BillingError,
};
