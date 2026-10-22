-- Craftium — standalone edition schema.
-- Single-tenant by design: one business per installed instance, so no business_id
-- scoping anywhere here. If this ever grows into multi-tenant SaaS, that column
-- gets added to every table below at that point — not before.

-- Role is the only thing that distinguishes accounts — admin (everything), manager
-- (everything but Settings), lead (Sell + Reports), cashier (Sell only, and a restricted
-- Sell at that — see server/routes/sales.js and server/middleware/auth.js). Enforced
-- server-side, not just hidden in the UI. Valid roles are validated in application code
-- (server/routes/auth.js), not with a CHECK constraint here, so adding a role later never
-- requires a schema migration on existing installs.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- User-managed "where do you buy this" tags (Temu, Amazon, Home Depot, Walmart, etc.) —
-- editable from Settings (server/routes/sources.js). Seeded with common ones on first run
-- (see server/db/index.js) so there's something useful immediately, but after that it's
-- ordinary admin-editable data; nothing about any specific source is hardcoded anywhere else.
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- `test` splits the catalog into two fully independent copies, the same way events/sales
-- already split: test mode's Calculator/Materials/Items tabs and Sell page only ever see and
-- touch test = 1 rows, so practicing (including stock changes) never affects the real
-- business data in test = 0 rows. See server/routes/maintenance.js for how the test side
-- gets populated (a copy of the main side) or wiped.
-- `source_id` tags which vendor a material was bought from, from the user-managed `sources`
-- table above. `product_url` is the saved link to that listing — the "Check price" button in
-- the Materials tab fetches it and tries to read off a current price for the admin to review
-- (see server/routes/materials.js and server/lib/priceFetch.js). Neither field, nor that
-- button, ever changes `price` on its own; it's always a manual accept.
-- `source` (plain text) is unused — superseded by `source_id`, a proper reference to the
-- user-editable sources table. Left in place rather than dropped so existing rows aren't
-- disturbed by a migration; server/db/index.js migrates old values into `source_id` once.
CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  price REAL NOT NULL DEFAULT 0,
  yield REAL NOT NULL DEFAULT 1,
  stock REAL NOT NULL DEFAULT 0,
  low REAL,
  source TEXT,
  source_id TEXT REFERENCES sources(id),
  product_url TEXT,
  test INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- `materials_json` holds each item's material rows (name/price/yield/per/libId) exactly
-- as the pricing calculator already works with them — kept denormalized on purpose so
-- the ported frontend's computeItem() logic needs no changes to read it. Only meaningful
-- when item_type = 'made'; a 'resale' item skips the materials/labor/pricing formula
-- entirely and just stores the cost/price the user typed in directly.
-- `category` is free text (e.g. "Military", "Education") — used to target charity rules
-- set up on an event (see event_charity_rules below), nothing else reads it.
-- `charity_pct` is unused — charity giving moved to event-level rules keyed by category.
-- Left in place rather than dropped so existing rows aren't disturbed by a migration.
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  item_no TEXT UNIQUE,
  item_type TEXT NOT NULL DEFAULT 'made',
  category TEXT,
  materials_json TEXT NOT NULL DEFAULT '[]',
  cost_mode TEXT NOT NULL DEFAULT 'none',
  minutes REAL NOT NULL DEFAULT 0,
  rate REAL NOT NULL DEFAULT 0,
  overhead REAL NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'markup',
  pct REAL NOT NULL DEFAULT 0,
  round TEXT NOT NULL DEFAULT 'whole',
  override REAL,
  stock REAL NOT NULL DEFAULT 0,
  low REAL,
  price REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  charity_pct REAL,
  saved_at INTEGER NOT NULL,
  test INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  start TEXT NOT NULL,
  days INTEGER NOT NULL DEFAULT 1,
  cost REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  tax_rate REAL,
  cash_tax_rate REAL,
  tax_included_cash INTEGER NOT NULL DEFAULT 0,
  tax_included_other INTEGER NOT NULL DEFAULT 0,
  test INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);

-- Per-event charity rules: an event can donate a % of profit either from sales of items in
-- a specific category, or from every sale at the event. `category = ''` is the sentinel for
-- "all sales" (kept as '' rather than NULL so the unique index below works — SQLite treats
-- NULLs as distinct from each other, which would let duplicate "all sales" rows sneak in).
-- Checkout (server/routes/sales.js) matches a line's item category against these rules,
-- preferring a category-specific rule over the all-sales one when both exist.
CREATE TABLE IF NOT EXISTS event_charity_rules (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  category TEXT NOT NULL DEFAULT '',
  charity_pct REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_charity_rules_event_category ON event_charity_rules(event_id, category);

-- `lines_json` holds each sale's line items exactly as the receipt/reports code expects.
-- `user_name` is a snapshot of who rang it up at the time, kept even if that account is
-- later renamed or removed — `user_id` alone would go stale. Both are only ever written
-- when the "track who makes each sale" setting is on (see the `settings` table below); a
-- shop that doesn't want this recorded at all just leaves it off and both stay null.
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  event_id TEXT REFERENCES events(id),
  test INTEGER NOT NULL DEFAULT 0,
  tax_included INTEGER NOT NULL DEFAULT 0,
  lines_json TEXT NOT NULL DEFAULT '[]',
  subtotal REAL NOT NULL DEFAULT 0,
  tax REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  tender TEXT NOT NULL DEFAULT 'cash',
  received REAL NOT NULL DEFAULT 0,
  change REAL NOT NULL DEFAULT 0,
  profit REAL NOT NULL DEFAULT 0,
  charity_due REAL NOT NULL DEFAULT 0,
  user_id TEXT REFERENCES users(id),
  user_name TEXT,
  -- Set only by a sale completed offline on the Sell page and synced once back online — lets
  -- a retried sync (e.g. the connection drops right after the first attempt's response) land
  -- exactly once instead of recording the same sale twice. Ordinary online checkouts never
  -- send one, so this stays NULL for the vast majority of rows.
  client_sale_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_sales_event ON sales(event_id);
-- idx_sales_client_id is created in server/db/index.js, AFTER the ensureColumn migrations run,
-- not here — this file runs unconditionally on every boot, including against an existing
-- install's sales table that doesn't have client_sale_id yet, and an index on a column that
-- doesn't exist yet crashes the whole process before the migration ever gets to add it.

-- Small key/value store for app-wide preferences that don't warrant their own table.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
