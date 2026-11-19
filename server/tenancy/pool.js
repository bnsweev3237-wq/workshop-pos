// A small connection cache keyed by tenant id — opens a tenant's SQLite file lazily on first
// use, keeps it open across requests (better-sqlite3 connections are cheap to hold, expensive
// to reopen constantly), and closes idle ones after a while so a server with many tenants
// doesn't hold every file handle open forever. Only used in multi-tenant mode.
const path = require('path');
const { openDatabase } = require('../db/migrate');

const DATA_ROOT = process.env.CRAFTIUM_DATA_ROOT || path.join(__dirname, '..', '..', 'data');
const TENANTS_DIR = path.join(DATA_ROOT, 'tenants');
const POOL_MAX = Number(process.env.CRAFTIUM_POOL_MAX) || 100;
const IDLE_TTL_MS = Number(process.env.CRAFTIUM_POOL_IDLE_MS) || 10 * 60 * 1000;

// The tenant id is always a uid minted by server/control/db.js (newTenantId()), never user
// input — but the path it builds is used to open a file, so it's re-checked here regardless of
// who's calling. A malformed id refuses outright instead of building some other path.
const ID_RE = /^t_[a-z0-9]{20,}$/;
function dbPathFor(tenantId) {
  if (!ID_RE.test(tenantId)) throw new Error(`refusing to open a tenant db for a malformed id: ${tenantId}`);
  return path.join(TENANTS_DIR, tenantId, 'workshop.db');
}

const entries = new Map(); // tenantId -> { db, lastUsed, inflight }

// If opening a new entry would push the pool past POOL_MAX, close the single least-recently-
// used idle (inflight === 0) entry first to make room. If every open entry is currently busy,
// the pool goes over the cap temporarily rather than closing a connection mid-request — the cap
// is a soft target for memory/file-handle pressure, not a hard request limiter.
function evictOneForSpace() {
  if (entries.size < POOL_MAX) return;
  let oldestId = null, oldestUsed = Infinity;
  for (const [id, entry] of entries) {
    if (entry.inflight === 0 && entry.lastUsed < oldestUsed) { oldestId = id; oldestUsed = entry.lastUsed; }
  }
  if (oldestId) {
    try { entries.get(oldestId).db.close(); } catch { /* already closed */ }
    entries.delete(oldestId);
  }
}

function openEntry(tenantId, { fileMustExist = true } = {}) {
  evictOneForSpace();
  const db = openDatabase(dbPathFor(tenantId), { fileMustExist });
  db.pragma('busy_timeout = 5000');
  const entry = { db, lastUsed: Date.now(), inflight: 0 };
  entries.set(tenantId, entry);
  return entry;
}

// Pins the tenant's connection open and returns it — callers must call release(tenantId)
// exactly once when done, in a finally block, even on error.
function acquire(tenantId) {
  let entry = entries.get(tenantId);
  if (!entry) entry = openEntry(tenantId);
  entry.inflight++;
  entry.lastUsed = Date.now();
  return entry;
}

function release(tenantId) {
  const entry = entries.get(tenantId);
  if (entry) { entry.inflight = Math.max(0, entry.inflight - 1); entry.lastUsed = Date.now(); }
}

// Only entries with nothing in flight and idle past the TTL are closed — never a connection a
// request (or a fire-and-forget job it kicked off) might still be using.
function evictIdle() {
  const now = Date.now();
  for (const [id, entry] of entries) {
    if (entry.inflight === 0 && now - entry.lastUsed > IDLE_TTL_MS) {
      try { entry.db.close(); } catch { /* already closed */ }
      entries.delete(id);
    }
  }
}
let evictTimer = null;
function startEvictionTimer() {
  if (evictTimer) return;
  evictTimer = setInterval(evictIdle, 60 * 1000);
  evictTimer.unref();
}

// Runs fn with that tenant's connection pinned open for the duration — for background jobs
// (schedulers), which have no per-request middleware to acquire/release around them.
async function withTenant(tenantId, fn) {
  const { tenantContext } = require('./context');
  const entry = acquire(tenantId);
  try {
    return await tenantContext.run({ tenantId, db: entry.db }, fn);
  } finally {
    release(tenantId);
  }
}

function openCount() {
  return entries.size;
}

function closeAll() {
  for (const [id, entry] of entries) {
    try { entry.db.close(); } catch { /* already closed */ }
    entries.delete(id);
  }
}

module.exports = {
  acquire, release, withTenant, evictIdle, startEvictionTimer, closeAll, openCount,
  dbPathFor, POOL_MAX, TENANTS_DIR, DATA_ROOT,
};
