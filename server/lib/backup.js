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

// Manual, on-demand version of the above — deletes everything except the single most recent
// backup, for an admin who's short on disk space and wants it back now rather than waiting
// for backups to age past the keep-5 window on their own.
function clearOldBackups() {
  const all = listBackups();
  let freedBytes = 0, removed = 0;
  for (const b of all.slice(1)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, b.file)); freedBytes += b.size; removed++; } catch {}
  }
  return { removed, freedBytes };
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

// Restoring overwrites the live database, then exits the process — mirrors how the self-update
// feature hands control back to a process manager (pm2, per the deploy docs) rather than
// trying to safely swap out an open better-sqlite3 handle in place while the rest of the
// server keeps running against it. Under plain `node server/index.js` with no process manager
// this leaves the server stopped until started again by hand, same caveat as applyUpdate() in
// lib/selfUpdate.js.
//
// Split into two steps, deliberately not done as one function: beginRestore() only validates
// and takes a safety snapshot — nothing it does stops the database from working normally — so
// the route handler can call it, then send the request's own response, and only run
// finishRestore() (which actually closes db) afterward. Closing db any earlier breaks that
// same response: express-session touches the session's last-accessed time through this same
// connection as part of finishing the response, and a closed handle makes that throw.

// A safety net: snapshots whatever's live right now before it's overwritten, so restoring the
// wrong backup by mistake is itself just as recoverable. Resolves to the backup being restored.
async function beginRestore(file) {
  const match = listBackups().find((b) => b.file === file);
  if (!match) throw new Error('Backup not found');
  await runBackup();
  return match;
}

function finishRestore(match) {
  const dbPath = db.name;
  db.close();
  // These belong to the connection that just closed, not to the backup file about to take
  // dbPath's place — leftover WAL frames from the old data would otherwise be replayed on top
  // of the restored file the next time something opens it, corrupting it.
  for (const suffix of ['-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
  fs.copyFileSync(path.join(BACKUP_DIR, match.file), dbPath);
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

module.exports = { runBackup, beginRestore, finishRestore, listBackups, pruneOldBackups, clearOldBackups, scheduleDailyBackups, BACKUP_DIR, KEEP };
