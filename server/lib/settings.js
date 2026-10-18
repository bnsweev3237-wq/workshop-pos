const db = require('../db');

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

const getBool = (key, fallback) => getSetting(key, fallback ? '1' : '0') === '1';
const setBool = (key, value) => setSetting(key, value ? '1' : '0');

module.exports = { getSetting, setSetting, getBool, setBool };
