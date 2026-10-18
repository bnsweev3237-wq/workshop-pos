const path = require('path');
const express = require('express');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const db = require('./db');
const { getSessionSecret } = require('./lib/secret');

function createApp() {
  const app = express();
  app.use(express.json());

  app.use(session({
    store: new SqliteStore({ client: db, expired: { clear: true, intervalMs: 15 * 60 * 1000 } }),
    secret: getSessionSecret(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days — this runs on trusted local/business hardware, not a public kiosk
    },
  }));

  app.use('/api/meta', require('./routes/meta'));
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/materials', require('./routes/materials'));
  app.use('/api/items', require('./routes/items'));
  app.use('/api/events', require('./routes/events'));
  app.use('/api/sales', require('./routes/sales'));

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
    server.once('listening', () => resolve({ server, port: server.address().port }));
    server.once('error', reject);
  });
}

if (require.main === module) {
  startServer(process.env.PORT || 4100)
    .then(({ port }) => console.log(`Workshop POS listening on http://localhost:${port}`))
    .catch((err) => { console.error('Failed to start server:', err); process.exit(1); });
}

module.exports = { createApp, startServer };
