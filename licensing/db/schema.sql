-- One row per tenant instance's license. Deliberately flat — feature_flags_json and
-- usage_caps_json live directly on the license, not on a separate "tiers" template table,
-- since what each tier actually includes hasn't been decided yet. `tier` is just a label for
-- the vendor's own bookkeeping; it has no effect on enforcement — only the two JSON columns
-- do. A real tiers table can be added later to template new licenses from, without changing
-- how a Craftium instance reads or enforces its own license.
CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  tenant_name TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT '',
  feature_flags_json TEXT NOT NULL DEFAULT '{}',
  usage_caps_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
