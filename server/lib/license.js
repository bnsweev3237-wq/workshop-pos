const { getSetting, setSetting } = require('./settings');

// Groundwork for a future licensing/tiers system — see licensing/README.md for the server
// side of this. Deliberately inert today: with no key (and/or no LICENSE_SERVER_URL)
// configured, every check below resolves "allowed" exactly like the app behaved before any
// of this existed. Nothing in the shipped app calls hasFeature()/checkUsageCap() yet — no
// tiers have been decided — but the plumbing (phone-home, caching, grace period, the
// middleware) is real and ready for routes to start using once they do.
const LICENSE_SERVER_URL = process.env.LICENSE_SERVER_URL || '';
const GRACE_MS = 30 * 24 * 60 * 60 * 1000; // how long a cached license stays valid with no successful recheck
const CHECK_TIMEOUT_MS = 10_000;

function getLicenseKey() {
  return getSetting('licenseKey', '');
}

function setLicenseKey(key) {
  setSetting('licenseKey', String(key || '').trim());
  // A new key invalidates whatever was cached under the old one — rather than show stale
  // tier/flags from a previous key until the next scheduled check, go back to "unchecked"
  // immediately; the caller (the route) always triggers an immediate checkLicense() right
  // after this, so this window is normally invisible.
  setSetting('licenseCache', '');
  setSetting('licenseLastGoodAt', '');
}

function clearLicense() {
  setSetting('licenseKey', '');
  setSetting('licenseCache', '');
  setSetting('licenseLastGoodAt', '');
}

function getCachedResult() {
  const raw = getSetting('licenseCache', '');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// The one function routes/UI actually read. Normalizes "no key", "never checked yet", "a
// cached result that's aged past the grace window", etc. into one shape so callers don't
// each have to reconstruct this logic.
function getLicenseStatus() {
  const key = getLicenseKey();
  if (!key) {
    return { configured: false, status: 'unlicensed', tier: '', featureFlags: {}, usageCaps: {}, licensedTo: '', checkedAt: null, lastGoodAt: null, degraded: false };
  }
  const cached = getCachedResult();
  const lastGoodAtRaw = getSetting('licenseLastGoodAt', '');
  const lastGoodAt = lastGoodAtRaw ? Number(lastGoodAtRaw) : null;
  if (!cached) {
    return { configured: true, status: 'unchecked', tier: '', featureFlags: {}, usageCaps: {}, licensedTo: '', checkedAt: null, lastGoodAt: null, degraded: false };
  }
  const degraded = cached.status === 'active' && !!lastGoodAt && (Date.now() - lastGoodAt) > GRACE_MS;
  return { configured: true, ...cached, lastGoodAt, degraded };
}

// Shared by the daily scheduler and the "Check now" button — same check either way. Resolves
// successfully even when there's nothing to check (no key, or no server configured) since
// that's this app's normal, supported state today, not a failure.
async function checkLicense() {
  const key = getLicenseKey();
  if (!key) return getLicenseStatus();
  if (!LICENSE_SERVER_URL) return getLicenseStatus();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(`${LICENSE_SERVER_URL.replace(/\/+$/, '')}/api/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
      signal: controller.signal,
    });
    if (res.status === 404) {
      // An authoritative "this key doesn't exist" — distinct from a network failure, so it's
      // not covered by the grace period; it takes effect immediately.
      setSetting('licenseCache', JSON.stringify({ status: 'invalid_key', tier: '', featureFlags: {}, usageCaps: {}, licensedTo: '', checkedAt: Date.now() }));
      return getLicenseStatus();
    }
    if (!res.ok) throw new Error(`license server returned ${res.status}`);
    const body = await res.json();
    setSetting('licenseCache', JSON.stringify({
      status: body.status, tier: body.tier || '', featureFlags: body.featureFlags || {},
      usageCaps: body.usageCaps || {}, licensedTo: body.licensedTo || '', checkedAt: Date.now(),
    }));
    setSetting('licenseLastGoodAt', String(Date.now()));
    return getLicenseStatus();
  } catch {
    // Unreachable, timed out, bad response — keep whatever was last cached as-is (don't
    // overwrite good data with nothing) and let the grace period in getLicenseStatus() decide
    // whether that's still good enough to keep running on.
    return getLicenseStatus();
  } finally {
    clearTimeout(timer);
  }
}

// Default-allow when unlicensed (today's behavior, unchanged), default-deny for an explicitly
// restricted or degraded license, and otherwise an explicit allow-list — a flag not mentioned
// in the license's featureFlags is treated as not included, not as included-by-omission.
function hasFeature(flagName) {
  const s = getLicenseStatus();
  if (!s.configured) return true;
  if (s.status === 'invalid_key' || s.status === 'suspended' || s.status === 'revoked') return false;
  if (s.degraded) return false;
  return !!s.featureFlags[flagName];
}

// limit is null for "unlimited" (or unlicensed). ok is whether currentCount still has room.
function checkUsageCap(capName, currentCount) {
  const s = getLicenseStatus();
  if (!s.configured) return { ok: true, limit: null };
  if (s.status === 'invalid_key' || s.status === 'suspended' || s.status === 'revoked' || s.degraded) {
    return { ok: false, limit: 0, reason: 'license_restricted' };
  }
  const limit = s.usageCaps[capName];
  if (limit == null) return { ok: true, limit: null };
  return { ok: currentCount < limit, limit };
}

function requireFeature(flagName) {
  return (req, res, next) => {
    if (hasFeature(flagName)) return next();
    res.status(403).json({ error: 'feature_not_licensed', feature: flagName });
  };
}

// Runs once a day, same pattern as scheduleDailyBackups/scheduleDailyLowStockCheck — fires
// shortly after boot, then every 24h. Always scheduled regardless of whether a key is set;
// checkLicense() itself is the no-op when there's nothing to check.
function scheduleDailyLicenseCheck() {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;
  setTimeout(function fire() {
    checkLicense().catch((err) => console.error('Scheduled license check error:', err));
    setInterval(() => checkLicense().catch((err) => console.error('Scheduled license check error:', err)), DAY_MS);
  }, FIRST_RUN_DELAY_MS);
}

module.exports = {
  getLicenseKey, setLicenseKey, clearLicense, getLicenseStatus, checkLicense,
  hasFeature, checkUsageCap, requireFeature, scheduleDailyLicenseCheck,
};
