// Runs after resolveTenant and session/auth middleware. Acquires this tenant's pooled
// connection and runs the rest of the request inside AsyncLocalStorage, so every
// require('../db') access downstream (routes, lib helpers) transparently resolves to the right
// tenant's database via the Proxy in server/db/index.js. Skips entirely on the platform host —
// there's no per-tenant db to attach there.
const { tenantContext } = require('./context');
const pool = require('./pool');

function tenantDbContext(req, res, next) {
  if (!req.tenant) return next();
  let entry;
  try {
    entry = pool.acquire(req.tenant.id);
  } catch (err) {
    return next(err);
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    pool.release(req.tenant.id);
  };
  res.on('close', release);
  res.on('finish', release);
  tenantContext.run({ tenantId: req.tenant.id, db: entry.db }, next);
}

module.exports = { tenantDbContext };
