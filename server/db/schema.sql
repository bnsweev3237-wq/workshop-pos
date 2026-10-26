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
-- `category` is deprecated and unused as of item_categories below (a single item can now
-- belong to several categories) — left in place rather than dropped so existing rows aren't
-- disturbed by a migration, same reasoning as `charity_pct` just below it.
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
  test INTEGER NOT NULL DEFAULT 0,
  -- Set once, at creation, and never touched again — unlike saved_at above, which updates on
  -- every edit. Lets "date added" and "last edited" sort by different things. Backfilled from
  -- saved_at for rows that existed before this column did (see db/index.js), since that's the
  -- closest approximation available for them.
  created_at INTEGER,
  -- A custom/one-off item that shouldn't be brought to shows — when set, this item is left off
  -- the Sell page's item grid at any event, regardless of that event's item_scope, without
  -- having to manage it per event. Still sellable normally when no event is open.
  not_for_shows INTEGER NOT NULL DEFAULT 0,
  -- Free-text, for your own reference (care instructions, a supplier quirk, whatever) —
  -- never shown on the Sell page, same visibility as cost/materials.
  notes TEXT
);

-- A single item can belong to several categories (e.g. both "Jewelry" and "Military") —
-- replaces the old single `items.category` column above, which is left in place but no
-- longer written to going forward. Category names are free text, same as before; there's no
-- separate "categories" table, just whatever distinct strings show up here.
CREATE TABLE IF NOT EXISTS item_categories (
  item_id TEXT NOT NULL REFERENCES items(id),
  category TEXT NOT NULL,
  PRIMARY KEY (item_id, category)
);

-- User-managed named tax rate presets (Settings), one-time-fill convenience for the event
-- form's state field — not a built-in nationwide rate table (real local rates vary by city/
-- county well beyond what a single per-state number could cover), and not split by test like
-- items/materials are, same reasoning as `sources` above: this is reference data, not
-- transactional.
CREATE TABLE IF NOT EXISTS tax_presets (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  sales_tax_rate REAL,
  cash_tax_rate REAL,
  created_at INTEGER NOT NULL
);

-- A shop's own card payment processors (Square, Venmo, etc.) and each one's transaction fee,
-- so a sale tendered by card can snapshot which processor took it and what that cost — see
-- sales.card_processor/card_fee below. Prepopulated once with common processors (server/db/
-- index.js), same pattern as `sources`; after that it's ordinary admin-editable data.
CREATE TABLE IF NOT EXISTS card_processors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  fee_pct REAL NOT NULL DEFAULT 0,
  fee_fixed REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  start TEXT NOT NULL,
  days INTEGER NOT NULL DEFAULT 1,
  cost REAL NOT NULL DEFAULT 0,
  -- 'draft': set up in advance, not yet running — doesn't show as the active event anywhere,
  -- just sits in the "Upcoming events" list until "Start event" flips it to 'open'. 'open':
  -- the one currently active event for this test/real side (at most one at a time, enforced
  -- in server/routes/events.js, not by a constraint here). 'ended': in Past events.
  status TEXT NOT NULL DEFAULT 'open',
  tax_rate REAL,
  cash_tax_rate REAL,
  tax_included_cash INTEGER NOT NULL DEFAULT 0,
  tax_included_other INTEGER NOT NULL DEFAULT 0,
  test INTEGER NOT NULL DEFAULT 0,
  -- 'all' (default): every item in the catalog is sellable at this event, same as before this
  -- column existed. 'selected': only items listed in event_items below show up on the Sell
  -- page's item grid while this event is open — everything else stays in the catalog, just
  -- not offered for sale at this particular event.
  item_scope TEXT NOT NULL DEFAULT 'all',
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  -- Free text (e.g. "MN") — matched against tax_presets' own `state` field (also free text,
  -- not a hard-coded list) to offer filling tax_rate/cash_tax_rate from a saved preset. A
  -- one-time convenience applied on request, not a live link back to the preset.
  state TEXT
);

CREATE TABLE IF NOT EXISTS event_items (
  event_id TEXT NOT NULL REFERENCES events(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  -- How many of this item are being brought to this event — separate from (and never changes)
  -- the item's overall stock. NULL means no specific number was set (any amount, bounded only
  -- by overall stock, same as before this column existed). "Remaining at this event" is never
  -- stored — it's always computed as qty_brought minus however much of this item has sold at
  -- this event so far, so voiding a sale naturally corrects it with no extra bookkeeping.
  qty_brought REAL,
  PRIMARY KEY (event_id, item_id)
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

-- A snapshot of a sale taken the moment it's voided, before the row in `sales` itself is
-- deleted — voiding a sale has always deleted it outright (stock gets restored, the sale is
-- gone), which meant there was never any record a void even happened. This is a brand new
-- table with no dependency on a column added to an existing one, so (unlike client_sale_id
-- above) it's safe to create unconditionally right here.
CREATE TABLE IF NOT EXISTS voided_sales (
  id TEXT PRIMARY KEY,
  original_sale_id TEXT NOT NULL,
  event_id TEXT REFERENCES events(id),
  test INTEGER NOT NULL DEFAULT 0,
  lines_json TEXT NOT NULL DEFAULT '[]',
  subtotal REAL NOT NULL DEFAULT 0,
  tax REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  tender TEXT NOT NULL DEFAULT 'cash',
  profit REAL NOT NULL DEFAULT 0,
  sold_by_user_id TEXT,
  sold_by_user_name TEXT,
  sale_created_at INTEGER NOT NULL,
  voided_by_user_id TEXT,
  voided_by_user_name TEXT,
  voided_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voided_sales_voided_at ON voided_sales(voided_at);

-- Small key/value store for app-wide preferences that don't warrant their own table.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- A made-to-order/custom piece tracked from request through pickup — its own lightweight
-- workflow, separate from the item catalog and event inventory. item_name is free text, not a
-- link to items(id): a custom order is often never cataloged at all (one-off, never resold),
-- and this way deleting or renaming a catalog item later never orphans or silently renames an
-- order referencing it. Ringing up the actual sale at pickup still goes through the normal
-- Sell page ticket; this table only tracks the request itself.
CREATE TABLE IF NOT EXISTS custom_orders (
  id TEXT PRIMARY KEY,
  -- Deprecated — a single free-text item/description, from before an order could hold
  -- several actual catalog items (see custom_order_items below). Left in place, unwritten by
  -- new orders, so an order saved before that change still shows something if it has no
  -- items of its own.
  item_name TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL DEFAULT '',
  customer_contact TEXT,
  due_date TEXT,
  -- 'new' -> 'in_progress' -> 'ready' -> 'picked_up', in the order you'd expect, but nothing
  -- enforces that order — any status can be set at any time. The client relabels 'ready'/
  -- 'picked_up' as "Ready to ship"/"Shipped" when fulfillment = 'ship', same two statuses
  -- either way.
  status TEXT NOT NULL DEFAULT 'new',
  notes TEXT,
  -- 'pickup' (default): the customer collects it in person, same as before this column
  -- existed — no address or shipping charge needed. 'ship': shipping_address and
  -- shipping_cost become relevant, and tracking_number once it's gone out.
  fulfillment TEXT NOT NULL DEFAULT 'pickup',
  shipping_address TEXT,
  shipping_cost REAL,
  tracking_number TEXT,
  -- Tracked as data on the order itself, nothing more — ringing up the actual sale (and
  -- having it count in Reports' revenue/tax/profit) still happens separately on the Sell
  -- page, same as before this column existed. Order total (items + shipping) minus this is
  -- the balance due, computed on the fly, never stored.
  amount_paid REAL,
  test INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_custom_orders_status ON custom_orders(status);

-- What's actually in a custom order — one row per line, each optionally tied to a catalog
-- item. name/price are snapshotted at the moment a line is added/saved (same reasoning as a
-- sale's line items: a later price change or deletion of the catalog item should never
-- silently rewrite an order that already references it). item_id is set NULL rather than the
-- row deleted when its catalog item is removed, so the line survives with its snapshot intact.
CREATE TABLE IF NOT EXISTS custom_order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES custom_orders(id),
  item_id TEXT REFERENCES items(id),
  item_name TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  qty REAL NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_custom_order_items_order ON custom_order_items(order_id);
