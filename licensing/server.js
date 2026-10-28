const express = require('express');
const helmet = require('helmet');

function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use('/api/validate', require('./routes/validate'));

  app.use((req, res) => res.status(404).json({ error: 'not_found' }));

  return app;
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const app = createApp();
    const server = app.listen(port);
    server.once('listening', () => resolve({ server, port: server.address().port }));
    server.once('error', reject);
  });
}

if (require.main === module) {
  startServer(process.env.PORT || 4200)
    .then(({ port }) => console.log(`Craftium licensing server listening on http://localhost:${port}`))
    .catch((err) => { console.error('Failed to start licensing server:', err); process.exit(1); });
}

module.exports = { createApp, startServer };
