const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Entirely separate from any tenant's own data directory — this is the vendor's own small
// database of who's licensed for what, never shipped with or accessible from a Craftium
// instance itself.
const DATA_DIR = process.env.LICENSING_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'licensing.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

module.exports = db;
