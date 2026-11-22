const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const db = require('./db');
const { getSessionSecret } = require('./lib/secret');
const { scheduleDailyBackups } = require('./lib/backup');
const { scheduleDailyLowStockCheck } = require('./lib/lowStockAlert');
const { scheduleDailyLicenseCheck } = require('./lib/license');
const { isMultiTenant } = require('./mode');

function createApp() {
  const app = express();
  // Trust the first hop only (the reverse proxy in front of it, e.g. nginx on the VPS deploy,
  // or in front of the whole multi-tenant platform) so req.ip and req.secure reflect the real
  // visitor/connection instead of the proxy's own loopback address — needed for both the login
  // rate limiter below and the cookie's `secure` flag to work correctly. A direct, un-proxied
  // install (plain `node server/index.js`, no nginx in front) is unaffected: there's no
  // X-Forwarded-* header to trust in that case, so Express just falls back to the real
  // connection either way.
  //
  // Tenant identity must NEVER be read from req.hostname with this setting on — Express
  // derives req.hostname from X-Forwarded-Host when trust proxy is enabled, which a client
  // controls. server/tenancy/resolveTenant.js reads req.headers.host directly for this reason.
  app.set('trust proxy', 1);

  // Baseline security headers. The Content-Security-Policy is spelled out explicitly to match
  // what this app actually loads — every script is same-origin (app.js, offline.js, and the
  // vendored barcode/QR libraries under public/vendor), Google Fonts is the only outside origin,
  // and the UI relies heavily on inline `style="..."` attributes throughout (hence style-src
  // needs 'unsafe-inline'; there's no inline *script*, so script-src doesn't). Using helmet's
  // defaults blind here would risk silently breaking rendering instead of actually protecting
  // anything. Unchanged between modes — the signup page (multi-tenant only) is also same-
  // origin, so it fits this same policy.
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    // HSTS is also set at the nginx layer on the documented VPS deploy; setting it here too is
    // harmless belt-and-suspenders — browsers ignore it entirely over a plain-HTTP connection,
    // so it doesn't affect a LAN-only, no-TLS install.
  }));
  // Stripe's webhook signature (server/lib/billing.js#constructWebhookEvent) covers the exact
  // raw bytes of the request body — the parsed object express.json() below would otherwise
  // produce isn't enough, the signature check needs the untouched buffer. Mounted narrowly, on
  // the exact webhook path, before the global JSON parser below so it sees the body first;
  // body-parser (which both this and express.json() are built on) skips re-parsing a request
  // whose body a previous middleware already consumed, so the global parser downstream is a
  // harmless no-op for this one path and unaffected everywhere else. Present (and harmless —
  // nothing mounts at this path) in single-tenant mode too, so this one ordering decision never
  // has to be duplicated per mode.
  app.use('/api/platform/stripe-webhook', express.raw({ type: 'application/json' }));
  // Raised from Express's 100kb default so a branding logo upload (a data URL, capped at ~2MB
  // in server/routes/branding.js) fits in the request body.
  app.use(express.json({ limit: '3mb' }));

  if (isMultiTenant) {
    return createMultiTenantApp(app);
  }
  return createSingleTenantApp(app);
}

// ---------- Single-tenant mode: desktop Electron app, or a self-hosted VPS install ----------
// Exactly as this file has always behaved — nothing in multi-tenant mode changes this path.
function createSingleTenantApp(app) {
  // Unauthenticated on purpose (see server/routes/meta.js) — the version number and changelog
  // aren't sensitive, and the login screen itself wants them before any session exists. Multi-
  // tenant mode mounts this same router too (see createMultiTenantApp below); this one's its
  // own line rather than a shared helper because it has to run before this branch's session
  // middleware, same as login itself does.
  app.use('/api/meta', require('./routes/meta'));
  app.use(session({
    store: new SqliteStore({ client: db, expired: { clear: true, intervalMs: 15 * 60 * 1000 } }),
    secret: getSessionSecret(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // 'auto': sent as Secure (HTTPS-only) when the request is actually HTTPS — e.g. behind
      // the documented nginx+Let's Encrypt deploy — but not required over plain HTTP, which
      // this app also supports (a LAN-only install at a craft fair booth with no domain/cert).
      secure: 'auto',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days — this runs on trusted local/business hardware, not a public kiosk
    },
  }));

  mountTenantScopedRoutes(app);
  app.use('/api/update', require('./routes/update'));

  // /i/:itemNo — the public, no-login item-lookup page a price tag's QR code/barcode points
  // at (see public/app.js's printPriceTags() and server/routes/items.js's GET /lookup/:itemNo,
  // which this page's own script calls). A dedicated route rather than a static file because
  // the item number lives in the path, not a query string — keeps the QR code's encoded URL
  // as short as possible, which matters for how small/dense the printed code needs to be.
  app.get('/i/:itemNo', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'item-lookup.html')));

  // index: false — the catch-all below is what decides which HTML shell to serve (it also
  // picks between index.html and signup.html by host in multi-tenant mode), so static must
  // not shortcut that decision by auto-serving public/index.html for '/' on its own.
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  return app;
}

// ---------- Multi-tenant mode: one process, many isolated tenants ----------
function createMultiTenantApp(app) {
  const { resolveTenant } = require('./tenancy/resolveTenant');
  const { bindSessionToTenant } = require('./tenancy/bindSession');
  const { tenantDbContext } = require('./tenancy/dbContext');
  const { getControlDb } = require('./control/db');
  const { isPlatformMailConfigured } = require('./lib/platformMail');

  // A warning, not a boot-time failure: platform email can be configured from the admin
  // console (/admin → Platform email settings) after boot, with no env vars or redeploy
  // required — refusing to boot without it would make that console unreachable on a fresh
  // install with nothing set yet. Account verification is load-bearing without it (POST
  // /login in routes/auth.js blocks until a tenant verifies), so this is still worth a loud
  // note in the logs rather than discovering it silently the first time a signup gets stuck.
  if (!isPlatformMailConfigured()) {
    console.warn('Platform email isn’t configured yet (no CRAFTIUM_SMTP_HOST/CRAFTIUM_PLATFORM_FROM and nothing saved in the admin console) — account verification emails won’t send until it is.');
  }

  // Runs before everything else, authenticated or not — several routes (signup, login itself,
  // the public branding GET a login screen needs, a subscriber's confirm-link) have no session
  // to resolve a tenant from.
  app.use(resolveTenant);

  // Public on either host, same as single-tenant mode.
  app.use('/api/meta', require('./routes/meta'));

  app.use(session({
    // One shared, control-plane-backed session store — see server/tenancy/bindSession.js and
    // server/middleware/auth.js for how a session that doesn't match the current host's
    // tenant is treated as logged out without ever being destroyed.
    store: new SqliteStore({ client: getControlDb(), expired: { clear: true, intervalMs: 15 * 60 * 1000 } }),
    secret: getSessionSecret(),
    name: 'craftium.sid',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  }));
  app.use(bindSessionToTenant);
  app.use(tenantDbContext); // no-op on the platform host — nothing to attach there

  // Platform-level routes (signup, the staff admin console) — both routers refuse anything
  // not on the platform host themselves, so mounting them here unconditionally is safe.
  app.use('/api/platform', require('./routes/platform'));
  app.use('/api/platform/admin', require('./routes/platformAdmin'));

  // Every router below assumes a resolved tenant (an active AsyncLocalStorage context) — a
  // request that reached here on the platform host would otherwise fall through into one of
  // them and crash on its first db access (NoTenantContextError) instead of cleanly 404ing.
  app.use('/api', (req, res, next) => {
    if (req.platformHost) return res.status(404).json({ error: 'not_found' });
    next();
  });

  mountTenantScopedRoutes(app);
  // /api/update is never mounted here: a platform-wide deploy (git pull, npm ci, a restart) is
  // an operator action now, never something one tenant's admin can trigger against a process
  // every other tenant shares. It falls through to the catch-all's /api/ 404 below.

  // Same public item-lookup page as the single-tenant branch above — see its comment. On the
  // platform host there's no tenant to look an item up against, so the page's own fetch just
  // 404s there; no special-casing needed.
  app.get('/i/:itemNo', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'item-lookup.html')));

  // index: false — see the single-tenant branch above; here it also matters for choosing
  // signup.html vs index.html by host, which static's own auto-index would bypass.
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
    if (req.platformHost) {
      if (req.path === '/admin' || req.path.startsWith('/admin/')) return res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
      return res.sendFile(path.join(__dirname, '..', 'public', 'signup.html'));
    }
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  return app;
}

// Routers every tenant (single-tenant's one install, or one tenant in multi-tenant mode)
// reaches the same way — identical mount points in both modes, so nothing in public/app.js or
// any route file needs to know which mode it's running under.
function mountTenantScopedRoutes(app) {
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/settings', require('./routes/settings'));
  app.use('/api/branding', require('./routes/branding'));
  app.use('/api/materials', require('./routes/materials'));
  app.use('/api/sources', require('./routes/sources'));
  app.use('/api/tax-presets', require('./routes/taxPresets'));
  app.use('/api/card-processors', require('./routes/cardProcessors'));
  app.use('/api/custom-orders', require('./routes/customOrders'));
  app.use('/api/items', require('./routes/items'));
  app.use('/api/events', require('./routes/events'));
  app.use('/api/event-expenses', require('./routes/eventExpenses'));
  app.use('/api/sales', require('./routes/sales'));
  app.use('/api/subscribers', require('./routes/subscribers'));
  app.use('/api/consignment', require('./routes/consignment'));
  app.use('/api/charity-rules', require('./routes/charityRules'));
  app.use('/api/maintenance', require('./routes/maintenance'));
  app.use('/api/test-data', require('./routes/testData'));
  app.use('/api/email-settings', require('./routes/email'));
  app.use('/api/license', require('./routes/license'));
  app.use('/api/billing', require('./routes/billing'));
}

// Resolves once the server is actually listening, with the real port — callers (the CLI
// entry point below, or Electron's main process) can pass 0 to let the OS pick a free port
// when the preferred one is taken.
function startServer(port) {
  return new Promise((resolve, reject) => {
    const app = createApp();
    const server = app.listen(port);
    server.once('listening', () => {
      if (isMultiTenant) {
        require('./tenancy/pool').startEvictionTimer();
        require('./tenancy/scheduler').scheduleMultiTenantJobs();
      } else {
        scheduleDailyBackups();
        scheduleDailyLowStockCheck();
        scheduleDailyLicenseCheck();
      }
      resolve({ server, port: server.address().port });
    });
    server.once('error', reject);
  });
}

if (require.main === module) {
  startServer(process.env.PORT || 4100)
    .then(({ port }) => console.log(`Craftium listening on http://localhost:${port}`))
    .catch((err) => { console.error('Failed to start server:', err); process.exit(1); });
}

module.exports = { createApp, startServer };
