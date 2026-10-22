const fs = require('fs');
const path = require('path');
const db = require('../db');

// Lives next to the live database, in the same data directory (so it follows WORKSHOP_DATA_DIR
// overrides automatically) rather than inside the app's own folder, which a re-deploy (git pull,
// a fresh Electron install) could wipe or replace.
const BACKUP_DIR = path.join(path.dirname(db.name), 'backups');
const KEEP = 5;

function listBackups() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { file: f, size: stat.size, createdAt: stat.mtimeMs };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

function pruneOldBackups() {
  for (const b of listBackups().slice(KEEP)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, b.file)); } catch {}
  }
}

// Uses SQLite's own online backup API (via better-sqlite3's `.backup()`) rather than copying
// the file directly — safe to run while the database is live and being written to (WAL mode),
// which a plain file copy isn't guaranteed to be consistent under.
async function runBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUP_DIR, `craftium-${stamp}.db`);
  try {
    await db.backup(dest);
  } catch (err) {
    // Most likely cause here is running out of disk space — skip this run rather than crash
    // the server over it; it'll try again on the next scheduled run.
    console.error('Backup failed, skipping this run:', err.message);
    try { fs.unlinkSync(dest); } catch {}
    return { ok: false, error: err.message };
  }
  pruneOldBackups();
  return { ok: true, file: path.basename(dest) };
}

// Runs once a day. On startup, backs up immediately only if the most recent backup is more
// than a day old (or there isn't one yet) — so a server that restarts often (crashes, the
// self-update feature) doesn't burn through the keep-5 window with duplicate same-day backups.
function scheduleDailyBackups() {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const mostRecent = listBackups()[0];
  const sinceLast = mostRecent ? Date.now() - mostRecent.createdAt : Infinity;
  const delay = Math.max(0, Math.min(sinceLast >= DAY_MS ? 0 : DAY_MS - sinceLast, DAY_MS));
  setTimeout(function fire() {
    runBackup().catch((err) => console.error('Scheduled backup error:', err));
    setInterval(() => runBackup().catch((err) => console.error('Scheduled backup error:', err)), DAY_MS);
  }, delay);
}

module.exports = { runBackup, listBackups, pruneOldBackups, scheduleDailyBackups, BACKUP_DIR, KEEP };
