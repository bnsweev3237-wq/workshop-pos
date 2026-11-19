-- The control-plane database (multi-tenant mode only) — holds nothing about any tenant's own
-- business data (items, sales, etc. live in that tenant's own file, see server/tenancy/pool.js).
-- Only what's needed to resolve "which tenant is this request for" and "what plan are they on".

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  business_name TEXT NOT NULL,
  -- 'provisioning': being created, not yet reachable. 'active': normal. 'suspended': blocked
  -- (403 on every request, session killed) but the data and row are kept. 'deleted': soft-
  -- deleted, treated as unknown by tenant resolution.
  status TEXT NOT NULL DEFAULT 'provisioning' CHECK(status IN ('provisioning', 'active', 'suspended', 'deleted')),
  -- Plan content (feature flags, usage caps) lives in code (server/lib/plans.js) — this is
  -- just which named plan applies. No billing integration in this phase; an operator sets
  -- this directly via scripts/tenant-admin.js.
  plan TEXT NOT NULL DEFAULT 'trial',
  -- Optional per-tenant overrides on top of the plan's defaults — nullable, rarely used.
  feature_flags_override_json TEXT,
  usage_caps_override_json TEXT,
  owner_contact TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  actor TEXT,
  action TEXT NOT NULL,
  detail_json TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant ON audit_log(tenant_id);

-- better-sqlite3-session-store creates its own `sessions` table here on first use (see
-- server/index.js) — nothing to declare for it up front.
