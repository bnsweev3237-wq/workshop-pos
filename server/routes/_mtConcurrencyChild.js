// Helper spawned by multitenant.isolation.test.js as a separate process, so a different
// CRAFTIUM_POOL_MAX actually takes effect (server/tenancy/pool.js reads it into a module-level
// constant once, at require time — a second run in the same process wouldn't see a new value).
// Reuses the parent's already-provisioned alpha/beta tenants (same CRAFTIUM_DATA_ROOT, inherited
// via env), boots its own server instance, and repeats the interleaved-request stress check
// with the connection pool capped to 1 — forcing constant eviction/reopening of whichever
// tenant *isn't* currently being evicted-in. Prints CHILD_FAILURES=<n> on its last line.
const http = require('http');
const { startServer } = require('../index');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error(`FAIL: ${msg}`); }
  else console.log(`ok: ${msg}`);
}

function request(port, { method = 'GET', path: p, host, body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request({
      host: '127.0.0.1', port, path: p, method,
      headers: {
        'Content-Type': 'application/json',
        Host: host,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data !== undefined ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* not JSON */ }
        const setCookie = res.headers['set-cookie'];
        resolve({ status: res.statusCode, data: json, setCookie: setCookie ? setCookie[0].split(';')[0] : null });
      });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

async function main() {
  const { server, port } = await startServer(0);
  const pool = require('../tenancy/pool');
  assert(pool.POOL_MAX === 1, `pool cap is actually 1 in this process (got ${pool.POOL_MAX})`);

  const alphaLogin = await request(port, { method: 'POST', path: '/api/auth/login', host: 'alpha.localhost', body: { username: 'ann', password: 'alphapass123' } });
  const betaLogin = await request(port, { method: 'POST', path: '/api/auth/login', host: 'beta.localhost', body: { username: 'bo', password: 'betapass123' } });
  assert(alphaLogin.status === 200 && betaLogin.status === 200, 'child: both tenants log in against the reused data root');
  const alphaCookie = alphaLogin.setCookie;
  const betaCookie = betaLogin.setCookie;

  const N = 200;
  const alphaCalls = Array.from({ length: N }, (_, i) =>
    request(port, { method: 'POST', path: '/api/items', host: 'alpha.localhost', cookie: alphaCookie, body: { name: `ALPHA-CAPSTRESS-${i}`, price: 1, cost: 1, stock: 1 } }));
  const betaCalls = Array.from({ length: N }, (_, i) =>
    request(port, { method: 'POST', path: '/api/items', host: 'beta.localhost', cookie: betaCookie, body: { name: `BETA-CAPSTRESS-${i}`, price: 1, cost: 1, stock: 1 } }));
  const interleaved = [];
  for (let i = 0; i < N; i++) { interleaved.push(alphaCalls[i]); interleaved.push(betaCalls[i]); }
  const results = await Promise.all(interleaved);
  assert(results.every((r) => r.status === 200), 'child: every interleaved create succeeded under POOL_MAX=1 (constant evict/reopen)');
  assert(pool.openCount() <= 2, `child: pool never exceeded a couple of entries even with 2 busy tenants (openCount=${pool.openCount()})`);

  const alphaList = await request(port, { path: '/api/items', host: 'alpha.localhost', cookie: alphaCookie });
  const betaList = await request(port, { path: '/api/items', host: 'beta.localhost', cookie: betaCookie });
  const alphaCount = alphaList.data.filter((i) => i.name.startsWith('ALPHA-CAPSTRESS-')).length;
  const betaCount = betaList.data.filter((i) => i.name.startsWith('BETA-CAPSTRESS-')).length;
  assert(alphaCount === N, `child: alpha ended with exactly its own ${N} items under pool pressure (got ${alphaCount})`);
  assert(betaCount === N, `child: beta ended with exactly its own ${N} items under pool pressure (got ${betaCount})`);
  assert(!alphaList.data.some((i) => i.name.startsWith('BETA-CAPSTRESS-')), 'child: alpha has zero BETA items under pool pressure');
  assert(!betaList.data.some((i) => i.name.startsWith('ALPHA-CAPSTRESS-')), 'child: beta has zero ALPHA items under pool pressure');

  server.close();
  console.log(`CHILD_FAILURES=${failures}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); console.log('CHILD_FAILURES=1'); process.exit(1); });
