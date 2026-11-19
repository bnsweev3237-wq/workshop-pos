// Decides which tenant (if any) a request is for, from the Host header alone — before auth,
// before a session even exists, because several routes run with no session at all (signup,
// login itself, the public branding GET a login screen needs, a subscriber's confirm-link).
//
// Deliberately reads req.headers.host directly, never req.hostname or req.subdomains —
// server/index.js sets `trust proxy: 1`, which makes Express derive req.hostname from the
// client-controlled X-Forwarded-Host header when present. Tenant identity must never be
// something a request can simply assert.
const { getTenantBySlug } = require('../control/db');

const RESERVED_SLUGS = new Set([
  'www', 'app', 'api', 'admin', 'mail', 'license', 'static', 'status', 'support',
  'help', 'assets', 'cdn', 'platform', 'signup', 'login',
]);
// Lowercase letters/digits, hyphens allowed in the middle only, 3-32 characters.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;

function baseDomain() {
  return (process.env.CRAFTIUM_BASE_DOMAIN || 'localhost').toLowerCase();
}

function isValidSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug);
}

// Strips the port and at most one trailing dot (a technically-legal absolute-hostname form
// some clients send) — nothing else. No other normalization, so a host with mixed structure
// (an extra label, a second dot) fails the exact-suffix check below instead of being coerced
// into matching something.
function parseHost(rawHost) {
  let host = String(rawHost || '').toLowerCase().trim();
  host = host.replace(/:\d+$/, '');
  host = host.replace(/\.$/, '');
  return host;
}

// Runs for every request in multi-tenant mode. Sets req.platformHost = true (the bare base
// domain — signup, platform-level API) or req.tenant (the control-plane row). Never trusts
// X-Forwarded-Host, X-Tenant*, or a ?tenant= query param — only the literal Host header.
function resolveTenant(req, res, next) {
  const base = baseDomain();
  const host = parseHost(req.headers.host);
  if (!host) return res.status(400).json({ error: 'bad_host' });

  if (host === base || host === `www.${base}`) {
    req.platformHost = true;
    return next();
  }

  const suffix = `.${base}`;
  if (!host.endsWith(suffix)) return res.status(404).json({ error: 'unknown_tenant' });
  const slug = host.slice(0, -suffix.length);
  // Must be exactly one label — "x.beta.localhost" is not beta's host.
  if (!slug || slug.includes('.') || !isValidSlug(slug)) return res.status(404).json({ error: 'unknown_tenant' });

  const tenant = getTenantBySlug(slug);
  if (!tenant || tenant.status === 'deleted' || tenant.status === 'provisioning') {
    return res.status(404).json({ error: 'unknown_tenant' });
  }
  if (tenant.status === 'suspended') return res.status(403).json({ error: 'tenant_suspended' });

  req.tenant = tenant;
  next();
}

module.exports = { resolveTenant, isValidSlug, parseHost, baseDomain, RESERVED_SLUGS, SLUG_RE };
