const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const db = require('./db');
const { getSessionSecret } = require('./lib/secret');
const { scheduleDailyBackups } = require('./lib/backup');

function createApp() {
  const app = express();
  // Trust the first hop only (the reverse proxy in front of it, e.g. nginx on the VPS deploy)
  // so req.ip and req.secure reflect the real visitor/connection instead of the proxy's own
  // loopback address — needed for both the login rate limiter below and the cookie's `secure`
  // flag to work correctly. A direct, un-proxied install (plain `node server/index.js`, no
  // nginx in front) is unaffected: there's no X-Forwarded-* header to trust in that case, so
  // Express just falls back to the real connection either way.
  app.set('trust proxy', 1);

  // Baseline security headers. The Content-Security-Policy is spelled out explicitly to match
  // what this app actually loads — every script is same-origin (app.js, offline.js, and the
  // vendored barcode library under public/vendor), Google Fonts is the only outside origin,
  // and the UI relies heavily on inline `style="..."` attributes throughout (hence style-src
  // needs 'unsafe-inline'; there's no inline *script*, so script-src doesn't). Using helmet's
  // defaults blind here would risk silently breaking rendering instead of actually protecting
  // anything.
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
  // Raised from Express's 100kb default so a branding logo upload (a data URL, capped at ~2MB
  // in server/routes/branding.js) fits in the request body.
  app.use(express.json({ limit: '3mb' }));

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

  app.use('/api/meta', require('./routes/meta'));
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/settings', require('./routes/settings'));
  app.use('/api/branding', require('./routes/branding'));
  app.use('/api/materials', require('./routes/materials'));
  app.use('/api/sources', require('./routes/sources'));
  app.use('/api/tax-presets', require('./routes/taxPresets'));
  app.use('/api/custom-orders', require('./routes/customOrders'));
  app.use('/api/items', require('./routes/items'));
  app.use('/api/events', require('./routes/events'));
  app.use('/api/sales', require('./routes/sales'));
  app.use('/api/charity-rules', require('./routes/charityRules'));
  app.use('/api/maintenance', require('./routes/maintenance'));
  app.use('/api/test-data', require('./routes/testData'));
  app.use('/api/update', require('./routes/update'));

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  return app;
}

// Resolves once the server is actually listening, with the real port — callers (the CLI
// entry point below, or Electron's main process) can pass 0 to let the OS pick a free port
// when the preferred one is taken.
function startServer(port) {
  return new Promise((resolve, reject) => {
    const app = createApp();
    const server = app.listen(port);
    server.once('listening', () => { scheduleDailyBackups(); resolve({ server, port: server.address().port }); });
    server.once('error', reject);
  });
}

if (require.main === module) {
  startServer(process.env.PORT || 4100)
    .then(({ port }) => console.log(`Craftium listening on http://localhost:${port}`))
    .catch((err) => { console.error('Failed to start server:', err); process.exit(1); });
}

module.exports = { createApp, startServer };
