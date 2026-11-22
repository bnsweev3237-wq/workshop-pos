// Standalone regression test (no test framework in this repo — same pattern as
// features.smoke.test.js) proving that everything built for hosted multi-tenant mode left
// single-tenant behavior — the desktop app and the self-hosted VPS deploy, both running with
// no CRAFTIUM_MODE set — completely unchanged. This is the guardrail multi-tenant work must
// never regress.
// Run with: node server/routes/singleTenant.regression.test.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'craftium-st-regress-'));
process.env.WORKSHOP_DATA_DIR = dataDir;
delete process.env.CRAFTIUM_MODE; // the default — single-tenant

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error(`FAIL: ${msg}`); }
  else console.log(`ok: ${msg}`);
}

async function main() {
  const { MODE, isMultiTenant } = require('../mode');
  assert(MODE === 'single-tenant', 'server/mode.js defaults to single-tenant with no CRAFTIUM_MODE set');
  assert(isMultiTenant === false, 'isMultiTenant is false by default');

  const db = require('../db');
  const Database = require('better-sqlite3');
  assert(db instanceof Database, 'require("../db") is a real better-sqlite3 Database instance, not the multi-tenant Proxy');
  assert(typeof db.name === 'string' && db.name.length > 0, 'the db instance has a real, single file path (db.name)');

  const controlDbPath = path.join(dataDir, 'control.db');
  assert(!fs.existsSync(controlDbPath), 'no control.db is ever created in single-tenant mode');

  const { startServer } = require('../index');
  const { server, port } = await startServer(0);
  const base = `http://localhost:${port}`;
  let cookie = '';
  async function call(method, p, body) {
    const res = await fetch(base + p, {
      method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch { /* not JSON, e.g. a file download */ }
    return { status: res.status, data };
  }

  const status0 = await call('GET', '/api/auth/status');
  assert(status0.data.needsSetup === true, 'a fresh single-tenant install still needs first-run setup (unchanged from before this work)');

  const setup = await call('POST', '/api/auth/setup', { name: 'Admin', username: 'admin', password: 'password123' });
  assert(setup.status === 200, '/api/auth/setup still works and creates the first admin');

  const platformSignup = await call('POST', '/api/platform/signup', { businessName: 'X', slug: 'x', ownerName: 'X', username: 'x', password: 'password123' });
  assert(platformSignup.status === 404, '/api/platform/* is never mounted in single-tenant mode');

  const updateCheck = await call('GET', '/api/update/check');
  assert(updateCheck.status !== 404, '/api/update is still mounted in single-tenant mode (status ' + updateCheck.status + ')');

  const licenseGet = await call('GET', '/api/license');
  assert(licenseGet.status === 200 && 'key' in licenseGet.data, 'GET /api/license still returns the self-hosted masked-key shape, unchanged');

  const metaGet = await call('GET', '/api/meta/version');
  assert(metaGet.status === 200 && metaGet.data.mode === 'single-tenant' && Array.isArray(metaGet.data.releaseNotes), 'GET /api/meta/version (the app footer\'s version number and "What\'s new" release notes) is mounted and working in single-tenant mode, not just multi-tenant');

  const billingGet = await call('GET', '/api/billing/status');
  assert(billingGet.status === 404, '/api/billing is mounted (same mount points in both modes) but 404s itself in single-tenant mode — no platform subscription to pay for here');

  const diskRes = await call('GET', '/api/maintenance/disk');
  assert(diskRes.status === 200 && 'total' in diskRes.data, 'disk usage in single-tenant mode still reports host-wide total/free, unchanged');

  const item = await call('POST', '/api/items', { name: 'Regular item', price: 10, cost: 5, stock: 3 });
  assert(item.status === 200, 'a normal item create still works end to end');

  // Restore still ends by closing the global db handle and exiting the process — exactly as
  // before this work. Stub process.exit so this assertion doesn't actually kill the test
  // runner; this must be the LAST thing this test does, since finishRestore() really does
  // close `db` for good.
  const backupRes = await call('POST', '/api/maintenance/backups', {});
  assert(backupRes.status === 200 && backupRes.data.file, 'a manual backup can still be created');

  let exitCode = null;
  const realExit = process.exit;
  process.exit = (code) => { exitCode = code; };
  const restoreRes = await call('POST', `/api/maintenance/backups/${backupRes.data.file}/restore`, {});
  assert(restoreRes.status === 200, 'restore still accepts the request and responds ok');
  await new Promise((r) => setTimeout(r, 500));
  assert(exitCode === 0, 'restore still ends by calling process.exit(0), exactly as before multi-tenant mode existed');
  process.exit = realExit;

  server.close();

  // features.smoke.test.js itself must keep passing, unmodified, in a fresh process.
  let smokeOk = false;
  try {
    // No custom env: features.smoke.test.js picks its own fresh WORKSHOP_DATA_DIR at the top,
    // and the parent process already has no CRAFTIUM_MODE set for it to inherit.
    execFileSync(process.execPath, [path.join(__dirname, 'features.smoke.test.js')], { encoding: 'utf8' });
    smokeOk = true;
  } catch (err) {
    console.error((err.stdout || '') + (err.stderr || ''));
  }
  assert(smokeOk, 'features.smoke.test.js (the pre-existing suite) still passes unmodified');

  // An unrecognized CRAFTIUM_MODE must refuse to boot, not silently fall back to anything.
  let badModeRejected = false;
  try {
    execFileSync(process.execPath, ['-e', "require('./server/mode.js')"], {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env, CRAFTIUM_MODE: 'something-bogus' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], // the expected throw's stack trace is noise, not a real failure
    });
  } catch {
    badModeRejected = true;
  }
  assert(badModeRejected, 'an unrecognized CRAFTIUM_MODE value throws at require time instead of silently booting');

  fs.rmSync(dataDir, { recursive: true, force: true });

  if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1); }
  console.log('\nAll assertions passed.');
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
