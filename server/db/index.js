const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

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
ensureColumn('sales', 'charity_due', 'REAL NOT NULL DEFAULT 0');

module.exports = db;
