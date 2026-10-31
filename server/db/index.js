const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { uid } = require('../lib/ids');

// Lives in a data/ folder next to the project by default, overridable so the Electron
// packaging step later can point it at the OS's per-user app-data directory instead.
const DATA_DIR = process.env.WORKSHOP_DATA_DIR || path.join(__dirname, '..', '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'workshop.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// `CREATE TABLE IF NOT EXISTS` is a no-op on an install that already has a `users` table —
// so an older install's table still carries the CHECK constraint that used to limit role to
// 'admin'/'cashier', even after upgrading to code that knows about 'manager'/'lead'. SQLite
// can't ALTER a CHECK constraint away directly; this is the standard rebuild-and-copy
// workaround, done once, automatically, the first time the new code runs against old data.
const usersTable = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
if (usersTable && /CHECK/i.test(usersTable.sql)) {
  // Two pragmas have to be set outside the transaction (SQLite ignores changes to either made
  // inside a BEGIN): legacy_alter_table=ON stops the rename below from rewriting sales.user_id
  // to follow it (it should keep saying "REFERENCES users(id)" untouched, which then correctly
  // resolves once `users` exists again under that name), and foreign_keys=OFF avoids a
  // constraint error from the moment in between where `users` briefly doesn't exist at all.
  // Both are restored to their normal values once the rebuild-and-copy is done.
  db.pragma('foreign_keys = OFF');
  db.exec('PRAGMA legacy_alter_table = ON;');
  db.exec('BEGIN;');
  db.exec(`
    ALTER TABLE users RENAME TO users_old_checked;
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at INTEGER NOT NULL
    );
    INSERT INTO users SELECT * FROM users_old_checked;
    DROP TABLE users_old_checked;
  `);
  db.exec('COMMIT;');
  db.exec('PRAGMA legacy_alter_table = OFF;');
  db.pragma('foreign_keys = ON');
}

// Adds a column to an existing table if it's missing — for installs whose table predates a
// later feature. `CREATE TABLE IF NOT EXISTS` only helps brand-new installs; this covers the
// upgrade path for columns, the same way the block above covers it for the users.role CHECK.
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('items', 'charity_pct', 'REAL');
ensureColumn('items', 'item_type', "TEXT NOT NULL DEFAULT 'made'");
ensureColumn('items', 'category', 'TEXT');
ensureColumn('items', 'test', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('materials', 'test', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('materials', 'source', 'TEXT');
ensureColumn('materials', 'product_url', 'TEXT');
ensureColumn('materials', 'source_id', 'TEXT');
ensureColumn('sales', 'charity_due', 'REAL NOT NULL DEFAULT 0');
ensureColumn('sales', 'client_sale_id', 'TEXT');
ensureColumn('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('events', 'item_scope', "TEXT NOT NULL DEFAULT 'all'");
ensureColumn('event_items', 'qty_brought', 'REAL');
ensureColumn('items', 'created_at', 'INTEGER');
ensureColumn('items', 'not_for_shows', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('events', 'state', 'TEXT');
ensureColumn('events', 'booth_number', 'TEXT');
ensureColumn('custom_orders', 'fulfillment', "TEXT NOT NULL DEFAULT 'pickup'");
ensureColumn('custom_orders', 'shipping_address', 'TEXT');
ensureColumn('custom_orders', 'shipping_cost', 'REAL');
ensureColumn('custom_orders', 'tracking_number', 'TEXT');
ensureColumn('custom_orders', 'amount_paid', 'REAL');
ensureColumn('items', 'notes', 'TEXT');
ensureColumn('sales', 'card_processor', 'TEXT');
ensureColumn('sales', 'card_fee', 'REAL NOT NULL DEFAULT 0');
ensureColumn('voided_sales', 'card_processor', 'TEXT');
ensureColumn('voided_sales', 'card_fee', 'REAL NOT NULL DEFAULT 0');
// Defaults to enabled (1) so every existing processor stays offered on the Sell page exactly
// as before this column existed — "available" is something an admin opts a processor out of,
// not into.
ensureColumn('card_processors', 'enabled', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('custom_orders', 'sale_id', 'TEXT');
ensureColumn('items', 'photo', 'TEXT');
ensureColumn('materials', 'photo', 'TEXT');

// CREATE TABLE IF NOT EXISTS never adds an index to an existing table, so this needs its own
// unconditional (idempotent) statement to reach installs that already had a sales table before
// client_sale_id existed.
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_client_id ON sales(client_sale_id) WHERE client_sale_id IS NOT NULL');

// Seeds the sources list with common ones once, the first time this runs against a database
// that has none at all — so there's something useful immediately instead of an empty list.
// After that it's ordinary admin-editable data (Settings → Material sources); this never
// runs again once at least one source exists, even if every seeded one gets deleted later.
const DEFAULT_SOURCES = ['Amazon', 'Temu', 'Walmart', 'Home Depot', "Lowe's", 'Michaels', 'Hobby Lobby', 'Etsy', 'AliExpress', 'eBay'];
if (db.prepare('SELECT COUNT(*) AS n FROM sources').get().n === 0) {
  const insertSource = db.prepare('INSERT INTO sources (id, name, created_at) VALUES (?, ?, ?)');
  const now = Date.now();
  for (const name of DEFAULT_SOURCES) insertSource.run(uid(), name, now);
}

// Same one-time seeding as sources above, for card_processors — common processors with
// approximate in-person transaction fees, so the list (and the "true profit minus fees" math
// in Reports) is useful immediately instead of empty. These are starting points, not quotes:
// actual rates vary by account and change over time, so Settings → Card processors says to
// check them against your own processor agreement. After this, ordinary admin-editable data.
const DEFAULT_CARD_PROCESSORS = [
  { name: 'Square', feePct: 2.6, feeFixed: 0.10 },
  { name: 'Venmo', feePct: 1.9, feeFixed: 0.10 },
  { name: 'PayPal', feePct: 2.99, feeFixed: 0 },
  { name: 'Cash App', feePct: 2.75, feeFixed: 0 },
  { name: 'Stripe', feePct: 2.7, feeFixed: 0.05 },
  { name: 'Clover', feePct: 2.6, feeFixed: 0.10 },
];
if (db.prepare('SELECT COUNT(*) AS n FROM card_processors').get().n === 0) {
  const insertProcessor = db.prepare('INSERT INTO card_processors (id, name, fee_pct, fee_fixed, created_at) VALUES (?, ?, ?, ?, ?)');
  const now = Date.now();
  for (const p of DEFAULT_CARD_PROCESSORS) insertProcessor.run(uid(), p.name, p.feePct, p.feeFixed, now);
}

// One-time per-row migration: materials tagged under the old fixed source slug (temu/
// amazon/homedepot/other, from before sources were user-editable) get pointed at a matching
// `sources` row instead, so upgrading never silently drops an existing tag. Matches by name
// against whatever's in `sources` now (including the seed above), creating a row if an old
// slug doesn't match one — e.g. a renamed or deleted default. Naturally runs at most once per
// material, since it only looks at rows that don't have source_id set yet.
const OLD_SLUG_TO_NAME = { temu: 'Temu', amazon: 'Amazon', homedepot: 'Home Depot', other: 'Other' };
const untagged = db.prepare("SELECT id, source FROM materials WHERE (source_id IS NULL OR source_id = '') AND source IS NOT NULL AND source != ''").all();
if (untagged.length) {
  const findSource = db.prepare('SELECT id FROM sources WHERE name = ? COLLATE NOCASE');
  const insertSource = db.prepare('INSERT INTO sources (id, name, created_at) VALUES (?, ?, ?)');
  const updateMaterial = db.prepare('UPDATE materials SET source_id = ? WHERE id = ?');
  for (const row of untagged) {
    const name = OLD_SLUG_TO_NAME[row.source] || row.source;
    let src = findSource.get(name);
    if (!src) { src = { id: uid() }; insertSource.run(src.id, name, Date.now()); }
    updateMaterial.run(src.id, row.id);
  }
}

// One-time per-row migration: an item's old single `category` column becomes its first entry
// in item_categories, the new multi-category table. Only touches items with no
// item_categories rows yet, so it naturally runs at most once per item — re-categorizing an
// item afterward (including removing its only category) never gets silently undone by this
// running again.
const uncategorized = db.prepare(`
  SELECT id, category FROM items
  WHERE category IS NOT NULL AND category != ''
    AND id NOT IN (SELECT item_id FROM item_categories)
`).all();
if (uncategorized.length) {
  const insertCategory = db.prepare('INSERT OR IGNORE INTO item_categories (item_id, category) VALUES (?, ?)');
  for (const row of uncategorized) insertCategory.run(row.id, row.category.trim());
}

// Backfill created_at for items that existed before that column did — saved_at (last edited)
// is the closest stand-in available for them. Idempotent: only rows still missing it are
// touched, so this is a no-op once every row has one.
db.prepare('UPDATE items SET created_at = saved_at WHERE created_at IS NULL').run();

module.exports = db;
