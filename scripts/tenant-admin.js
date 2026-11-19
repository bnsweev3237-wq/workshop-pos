#!/usr/bin/env node
// Operator CLI for multi-tenant mode — the equivalent of licensing/scripts/manage-license.js,
// but for tenants instead of license keys. Opens the control db (and, for a few commands, one
// tenant's own db) directly; no HTTP, no auth beyond having shell access to the host. Requires
// CRAFTIUM_MODE=multi-tenant and whatever CRAFTIUM_DATA_ROOT the server itself uses.
process.env.CRAFTIUM_MODE = process.env.CRAFTIUM_MODE || 'multi-tenant';
if (process.env.CRAFTIUM_MODE !== 'multi-tenant') {
  console.error('tenant-admin only makes sense with CRAFTIUM_MODE=multi-tenant.');
  process.exit(1);
}

const controlDb = require('../server/control/db');
const { openDatabase } = require('../server/db/migrate');
const { createUserRow } = require('../server/lib/users');
const pool = require('../server/tenancy/pool');
const { provisionTenant, ProvisionError } = require('../server/tenancy/provision');
const { PLANS } = require('../server/lib/plans');

function usage() {
  console.log(`Usage: node scripts/tenant-admin.js <command> [args]

Commands:
  create <slug> <businessName> <username> <password> [ownerName]
  list [status]
  suspend <slug>
  activate <slug>
  set-plan <slug> <plan>            plans: ${Object.keys(PLANS).join(', ')}
  reset-password <slug> <username> <newPassword>
  migrate-all                       bring every tenant db up to the current schema
`);
}

async function main() {
  const [, , cmd, ...args] = process.argv;
  switch (cmd) {
    case 'create': {
      const [slug, businessName, username, password, ownerName] = args;
      if (!slug || !businessName || !username || !password) { usage(); process.exit(1); }
      try {
        const tenant = await provisionTenant({ businessName, slug, ownerName, username, password });
        console.log(`Created tenant "${tenant.business_name}" (${tenant.slug}), id ${tenant.id}`);
      } catch (err) {
        console.error(err instanceof ProvisionError ? err.message : err);
        process.exit(1);
      }
      break;
    }
    case 'list': {
      const [status] = args;
      const tenants = controlDb.listTenants(status ? { status } : {});
      if (!tenants.length) { console.log('No tenants.'); break; }
      for (const t of tenants) {
        console.log(`${t.slug}\t${t.status}\t${t.plan}\t${t.business_name}\t${t.id}`);
      }
      break;
    }
    case 'suspend': {
      const [slug] = args;
      const t = requireTenant(slug);
      controlDb.updateTenantStatus(t.id, 'suspended');
      controlDb.addAuditLog(t.id, 'tenant-admin', 'suspended', {});
      console.log(`Suspended ${slug}.`);
      break;
    }
    case 'activate': {
      const [slug] = args;
      const t = requireTenant(slug);
      controlDb.updateTenantStatus(t.id, 'active');
      controlDb.addAuditLog(t.id, 'tenant-admin', 'activated', {});
      console.log(`Activated ${slug}.`);
      break;
    }
    case 'set-plan': {
      const [slug, plan] = args;
      if (!PLANS[plan]) { console.error(`Unknown plan "${plan}". Known: ${Object.keys(PLANS).join(', ')}`); process.exit(1); }
      const t = requireTenant(slug);
      controlDb.updateTenantPlan(t.id, plan);
      controlDb.addAuditLog(t.id, 'tenant-admin', 'plan_changed', { plan });
      console.log(`${slug} is now on plan "${plan}".`);
      break;
    }
    case 'reset-password': {
      const [slug, username, newPassword] = args;
      if (!newPassword || newPassword.length < 8) { console.error('New password must be at least 8 characters.'); process.exit(1); }
      const t = requireTenant(slug);
      const tdb = openDatabase(pool.dbPathFor(t.id), { fileMustExist: true });
      try {
        const user = tdb.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
        if (!user) { console.error(`No user "${username}" on tenant ${slug}.`); process.exit(1); }
        const bcrypt = require('bcryptjs');
        tdb.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(bcrypt.hashSync(newPassword, 12), user.id);
        console.log(`Password reset for ${username} on ${slug} — they'll be asked to change it on next sign-in.`);
      } finally {
        tdb.close();
      }
      break;
    }
    case 'migrate-all': {
      const tenants = controlDb.listTenants();
      for (const t of tenants) {
        const tdb = openDatabase(pool.dbPathFor(t.id), { fileMustExist: true });
        tdb.close();
        console.log(`Migrated ${t.slug}.`);
      }
      console.log(`Done — ${tenants.length} tenant(s).`);
      break;
    }
    default:
      usage();
      process.exit(cmd ? 1 : 0);
  }
}

function requireTenant(slug) {
  if (!slug) { usage(); process.exit(1); }
  const t = controlDb.getTenantBySlug(slug);
  if (!t) { console.error(`No tenant with slug "${slug}".`); process.exit(1); }
  return t;
}

main().catch((err) => { console.error(err); process.exit(1); });
