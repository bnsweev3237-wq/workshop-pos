// Runs a job across every active tenant, in multi-tenant mode — the per-tenant equivalent of
// the single daily backup/low-stock runs single-tenant mode already does. Each tenant's
// connection is acquired through the pool (server/tenancy/pool.js), exactly the way a real
// request would, so the job function can just require('../db') like any route and it resolves
// to the right tenant via the AsyncLocalStorage Proxy. One tenant's failure is logged and
// skipped — a corrupted or locked tenant db must never stop every other tenant's backup.
const { listTenants } = require('../control/db');
const pool = require('./pool');
const { runBackup } = require('../lib/backup');
const { checkLowStockAndEmail } = require('../lib/lowStockAlert');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function forEachActiveTenant(job, { concurrency = 2, maxJitterMs = 5000 } = {}) {
  const tenants = listTenants({ status: 'active' });
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < tenants.length) {
      const tenant = tenants[idx++];
      if (maxJitterMs > 0) await sleep(Math.floor(Math.random() * maxJitterMs));
      try {
        const result = await pool.withTenant(tenant.id, () => job(tenant));
        results.push({ tenantId: tenant.id, slug: tenant.slug, ok: true, result });
      } catch (err) {
        console.error(`Tenant job failed for ${tenant.slug} (${tenant.id}):`, err.message);
        results.push({ tenantId: tenant.id, slug: tenant.slug, ok: false, error: err.message });
      }
    }
  }
  const workers = Array.from({ length: Math.max(1, concurrency) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function runBackupsForAllTenants(opts) {
  return forEachActiveTenant(() => runBackup(), opts);
}

async function runLowStockForAllTenants(opts) {
  return forEachActiveTenant(() => checkLowStockAndEmail(), opts);
}

// Same pattern as the single-tenant schedulers in lib/backup.js / lib/lowStockAlert.js, just
// looped across tenants. No license-check scheduler here — multi-tenant mode has nothing to
// phone home for (see server/lib/license.js).
function scheduleMultiTenantJobs() {
  const DAY_MS = 24 * 60 * 60 * 1000;
  setTimeout(function fireBackups() {
    runBackupsForAllTenants().catch((err) => console.error('Scheduled multi-tenant backup run error:', err));
    setInterval(() => runBackupsForAllTenants().catch((err) => console.error('Scheduled multi-tenant backup run error:', err)), DAY_MS);
  }, 2 * 60 * 1000);
  setTimeout(function fireLowStock() {
    runLowStockForAllTenants().catch((err) => console.error('Scheduled multi-tenant low-stock run error:', err));
    setInterval(() => runLowStockForAllTenants().catch((err) => console.error('Scheduled multi-tenant low-stock run error:', err)), DAY_MS);
  }, 5 * 60 * 1000);
}

module.exports = { forEachActiveTenant, runBackupsForAllTenants, runLowStockForAllTenants, scheduleMultiTenantJobs };
