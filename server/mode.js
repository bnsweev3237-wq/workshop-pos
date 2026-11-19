// Single switch that decides which of the two runtime modes this process boots as. Unset (the
// default) keeps every existing desktop/VPS install exactly as it's always behaved — nothing
// about multi-tenant mode is reachable or even constructed unless this is explicitly set.
// Any value that isn't one of the two recognized ones refuses to boot rather than silently
// falling back to single-tenant — a typo'd env var should be loud, not quietly wrong.
const VALID_MODES = ['single-tenant', 'multi-tenant'];
const raw = process.env.CRAFTIUM_MODE;
const MODE = raw ? raw : 'single-tenant';

if (!VALID_MODES.includes(MODE)) {
  throw new Error(`Invalid CRAFTIUM_MODE "${raw}" — must be unset (single-tenant) or "multi-tenant". Refusing to boot rather than guess which was meant.`);
}

module.exports = { MODE, isMultiTenant: MODE === 'multi-tenant' };
