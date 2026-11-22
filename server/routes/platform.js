// Platform-level routes — signup and anything else that isn't scoped to a tenant. Only
// reachable on the base/platform host (req.platformHost, set by resolveTenant); mounted only
// in multi-tenant mode. The business this creates gets its own, separate database — nothing
// here ever touches a tenant's db directly except through provisionTenant()'s own short-lived
// connection, opened and closed before any tenant route could run.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { provisionTenant, ProvisionError, assertSlugAvailable } = require('../tenancy/provision');
const { baseDomain } = require('../tenancy/resolveTenant');
const billing = require('../lib/billing');

const router = express.Router();

// Only the platform host may reach these — a request that resolved to a real tenant (or an
// unrecognized host) 404s here the same way any other platform-only route would.
router.use((req, res, next) => {
  if (!req.platformHost) return res.status(404).json({ error: 'not_found' });
  next();
});

const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_attempts', message: 'Too many signup attempts. Wait a few minutes and try again.' },
});

router.get('/slug-available', (req, res) => {
  const slug = String(req.query.slug || '').trim().toLowerCase();
  if (!slug) return res.json({ available: false });
  try {
    assertSlugAvailable(slug);
    res.json({ available: true });
  } catch (err) {
    res.json({ available: false, reason: err.code, message: err.message });
  }
});

router.post('/signup', signupLimiter, async (req, res) => {
  const { businessName, slug, ownerName, username, password, email } = req.body || {};
  try {
    const tenant = await provisionTenant({ businessName, slug, ownerName, username, password, email });
    // Carry over whatever port the browser actually used to reach the platform host (e.g. a
    // local dev/test server on :4302) — production behind a standard 80/443 reverse proxy has
    // no port in the Host header, so this is a no-op there.
    const host = req.headers.host || '';
    const port = host.includes(':') ? host.slice(host.indexOf(':')) : '';
    res.json({ ok: true, slug: tenant.slug, loginUrl: `//${tenant.slug}.${baseDomain()}${port}/` });
  } catch (err) {
    if (err instanceof ProvisionError) {
      const status = err.code === 'slug_taken' ? 409 : 400;
      return res.status(status).json({ error: err.code, message: err.message });
    }
    console.error('Signup failed:', err);
    res.status(502).json({ error: 'signup_failed', message: 'Something went wrong setting up your account. Try again.' });
  }
});

// Stripe webhook receiver — the one fixed, platform-wide URL a Stripe account is configured to
// post subscription events to (never a tenant subdomain; there's one Stripe account for the
// whole platform, not one per tenant). No session or login here — the signature itself is the
// authentication, verified against the raw request body (see server/index.js, which special-
// cases this exact path to skip the global JSON body-parser so that raw body survives).
router.post('/stripe-webhook', async (req, res) => {
  if (!billing.isBillingConfigured()) return res.status(503).json({ error: 'not_configured' });
  let event;
  try {
    event = billing.constructWebhookEvent(req.body, req.headers['stripe-signature']);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'bad_signature' });
  }
  try {
    await billing.applyWebhookEvent(event);
    res.json({ received: true });
  } catch (err) {
    console.error('Stripe webhook handling failed:', err);
    res.status(500).json({ error: 'webhook_failed' });
  }
});

module.exports = router;
