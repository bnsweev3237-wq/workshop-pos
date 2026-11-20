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
  -- Captured at signup. email_verified_at is null until the owner clicks the link sent to
  -- owner_email (server/routes/auth.js's GET /verify-email/:token) — login is blocked until
  -- then (see that route's POST /login). email_verify_token/_expires_at back that one link;
  -- cleared once consumed. A CLI-created tenant (scripts/tenant-admin.js, operator-vetted) skips
  -- all of this and is created already verified.
  owner_email TEXT,
  email_verified_at INTEGER,
  email_verify_token TEXT,
  email_verify_expires_at INTEGER,
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

-- Platform staff (operator/support) — separate from any tenant's own `users` table, since
-- these accounts aren't tied to any one tenant. Logs into the admin console at /admin on the
-- platform host, never any tenant subdomain.
CREATE TABLE IF NOT EXISTS platform_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin', 'support')),
  created_at INTEGER NOT NULL
);

-- A support-session grant: minted when a platform staff member clicks "open tenant", consumed
-- (at most once) by server/routes/auth.js's GET /api/auth/impersonate/:token on that exact
-- tenant's own host. `id` is the one-time token itself. `consumed_at` set means the link was
-- actually used to log in; `ended_at` set (by either the agent or the tenant's own admin, via
-- /api/auth/end-support-session) or a hard age cap means the access window is over. While a row
-- exists for a tenant with consumed_at set and ended_at not set, every session on that tenant
-- (the real tenant admin's own included) sees a "support is assisting this account" banner —
-- visible disclosure was the explicit design choice here, not a silent backdoor.
CREATE TABLE IF NOT EXISTS support_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_support_sessions_tenant ON support_sessions(tenant_id);

-- Platform-level settings — a handful of configurable values, same key/value shape as a
-- tenant's own `settings` table (server/lib/settings.js), just at the control-plane level.
-- Currently just the platform's outgoing mail config (server/lib/platformMail.js), editable
-- from the admin console (/admin → Platform email settings) without redeploying or touching
-- env vars — changing providers later is meant to be a settings change, not a deploy.
CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- better-sqlite3-session-store creates its own `sessions` table here on first use (see
-- server/index.js) — nothing to declare for it up front.
