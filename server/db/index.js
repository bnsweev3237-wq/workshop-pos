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

module.exports = db;
