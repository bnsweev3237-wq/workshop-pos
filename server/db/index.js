// Single-tenant mode (unset CRAFTIUM_MODE, the default — every existing desktop/VPS install):
// exports one real better-sqlite3 Database, opened once at require() time, exactly as this
// module has always behaved. Nothing below changes that path's timing or behavior.
//
// Multi-tenant mode: there is no one "the" database — which file a request should read/write
// depends on which tenant it belongs to, resolved per-request by server/tenancy middleware.
// This exports a Proxy that forwards every property access to whatever db is active in the
// current request's AsyncLocalStorage context (server/tenancy/context.js), and throws if
// there isn't one — fail closed. A thrown NoTenantContextError crashes that request instead of
// silently reading or writing some other tenant's data, which is the one failure mode this
// can never have.
const path = require('path');
const { openDatabase } = require('./migrate');
const { isMultiTenant } = require('../mode');

let exported;

if (isMultiTenant) {
  const { tenantContext, NoTenantContextError } = require('../tenancy/context');
  exported = new Proxy({}, {
    get(_target, prop, _receiver) {
      const store = tenantContext.getStore();
      if (!store) throw new NoTenantContextError(`db.${String(prop)} accessed with no active tenant context`);
      const value = Reflect.get(store.db, prop, store.db);
      return typeof value === 'function' ? value.bind(store.db) : value;
    },
    set(_target, prop, value) {
      const store = tenantContext.getStore();
      if (!store) throw new NoTenantContextError(`db.${String(prop)} assigned with no active tenant context`);
      return Reflect.set(store.db, prop, value);
    },
  });
} else {
  // Lives in a data/ folder next to the project by default, overridable so the Electron
  // packaging step later can point it at the OS's per-user app-data directory instead.
  const DATA_DIR = process.env.WORKSHOP_DATA_DIR || path.join(__dirname, '..', '..', 'data');
  const DB_PATH = path.join(DATA_DIR, 'workshop.db');
  exported = openDatabase(DB_PATH);
}

module.exports = exported;
