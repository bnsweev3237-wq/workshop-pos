// The one piece of ambient per-request state multi-tenant mode relies on: which tenant (and
// which already-open Database connection) the code running right now belongs to. Set once per
// request by server/tenancy/dbContext.js, read by the db Proxy in server/db/index.js on every
// access. AsyncLocalStorage context follows async/await and Promise chains automatically —
// including a fire-and-forget call made before a response is sent (e.g. sales.js's receipt
// email) — so nothing downstream has to thread a tenant id through manually.
const { AsyncLocalStorage } = require('async_hooks');

const tenantContext = new AsyncLocalStorage();

class NoTenantContextError extends Error {
  constructor(message) {
    super(message || 'No active tenant context');
    this.name = 'NoTenantContextError';
    this.code = 'no_tenant_context';
  }
}

module.exports = { tenantContext, NoTenantContextError };
