-- Workshop POS — standalone edition schema.
-- Single-tenant by design: one business per installed instance, so no business_id
-- scoping anywhere here. If this ever grows into multi-tenant SaaS, that column
-- gets added to every table below at that point — not before.

-- Holds both admin and cashier accounts. Role is the only thing that distinguishes them:
-- admins can reach every page, cashiers only the Sell page (enforced server-side in
-- middleware/auth.js, not just hidden in the UI).
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'cashier')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  price REAL NOT NULL DEFAULT 0,
  yield REAL NOT NULL DEFAULT 1,
  stock REAL NOT NULL DEFAULT 0,
  low REAL,
  created_at INTEGER NOT NULL
);

-- `materials_json` holds each item's material rows (name/price/yield/per/libId) exactly
-- as the pricing calculator already works with them — kept denormalized on purpose so
-- the ported frontend's computeItem() logic needs no changes to read it.
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  item_no TEXT UNIQUE,
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
  saved_at INTEGER NOT NULL
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

-- `lines_json` holds each sale's line items exactly as the receipt/reports code expects.
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
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_sales_event ON sales(event_id);
