// Tenant-facing self-serve billing — upgrading/downgrading a plan and managing an existing
// subscription, both via Stripe-hosted pages (Checkout, the customer billing portal) so no
// card data ever touches this server. A multi-tenant SaaS concept only: a self-hosted/desktop
// single-tenant install has no platform subscription to pay for, so this 404s there outright,
// same convention as server/routes/platform.js checking req.platformHost.
//
// Admin-only, same as the rest of account-level billing/ownership actions — not manager, lead,
// or cashier (see server/middleware/auth.js).
const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { isMultiTenant } = require('../mode');
const { baseDomain } = require('../tenancy/resolveTenant');
const controlDb = require('../control/db');
const billing = require('../lib/billing');

const router = express.Router();

router.use((req, res, next) => {
  if (!isMultiTenant) return res.status(404).json({ error: 'not_found' });
  next();
});

// The request's own Host header reflects whichever tenant subdomain the owner is actually on
// (resolveTenant already validated it) — reusing it means the Stripe redirect lands back on
// the exact host they started from, including a non-standard port in local dev/testing.
function originFor(req, tenant) {
  const host = req.headers.host || `${tenant.slug}.${baseDomain()}`;
  return `${req.secure ? 'https' : 'http'}://${host}`;
}

router.get('/status', requireAdmin, (req, res) => {
  const tenant = controlDb.getTenantById(req.tenant.id);
  res.json({
    configured: billing.isBillingConfigured(),
    plan: tenant.plan,
    subscriptionStatus: tenant.stripe_subscription_status,
    hasStripeCustomer: !!tenant.stripe_customer_id,
    purchasablePlans: billing.purchasablePlans(),
  });
});

router.post('/checkout', requireAdmin, async (req, res) => {
  const tenant = controlDb.getTenantById(req.tenant.id);
  const origin = originFor(req, tenant);
  try {
    const { url } = await billing.createCheckoutSession({
      tenant, plan: req.body && req.body.plan,
      successUrl: `${origin}/?billing=success`, cancelUrl: `${origin}/?billing=cancel`,
    });
    res.json({ url });
  } catch (err) {
    if (err instanceof billing.BillingError) return res.status(err.code === 'not_configured' ? 503 : 400).json({ error: err.code, message: err.message });
    console.error('Checkout session creation failed:', err);
    res.status(502).json({ error: 'checkout_failed', message: 'Could not start checkout — try again.' });
  }
});

router.post('/portal', requireAdmin, async (req, res) => {
  const tenant = controlDb.getTenantById(req.tenant.id);
  const origin = originFor(req, tenant);
  try {
    const { url } = await billing.createPortalSession({ tenant, returnUrl: `${origin}/` });
    res.json({ url });
  } catch (err) {
    if (err instanceof billing.BillingError) return res.status(err.code === 'not_configured' ? 503 : 400).json({ error: err.code, message: err.message });
    console.error('Billing portal session creation failed:', err);
    res.status(502).json({ error: 'portal_failed', message: 'Could not open the billing portal — try again.' });
  }
});

module.exports = router;
