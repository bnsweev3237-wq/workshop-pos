// Plan content for multi-tenant mode — what each named plan includes. No billing integration
// in this phase; an operator assigns a tenant's plan directly (scripts/tenant-admin.js
// set-plan). This is what server/lib/license.js reads from in multi-tenant mode, behind the
// same hasFeature()/checkUsageCap()/requireFeature() call sites every route already uses.
// usageCaps keys are read by server/lib/license.js#checkUsageCap, called with a tenant's
// current count of whatever the cap is on — a key simply absent from a plan's usageCaps means
// unlimited (checkUsageCap treats a missing/null limit as always-ok), so "pro" below just
// doesn't mention either cap at all rather than setting them to some large number.
const PLANS = {
  trial: {
    featureFlags: { consignment: true },
    usageCaps: { staffAccounts: 1, items: 100 },
  },
  basic: {
    featureFlags: {},
    usageCaps: { staffAccounts: 1, items: 150 },
  },
  pro: {
    featureFlags: { consignment: true },
    usageCaps: {},
  },
};

// Unknown plan name (e.g. a row written by an older version of this file) falls back to the
// most restrictive shape rather than throwing — a request should get "no extra features", not
// a 500, if a tenant's plan string doesn't match anything defined here.
function planContent(planName) {
  return PLANS[planName] || { featureFlags: {}, usageCaps: {} };
}

// A tenant row's nullable override columns (server/control/schema.sql) layer on top of its
// plan's defaults — e.g. a one-off feature grant without changing its plan.
function resolveEntitlements(tenant) {
  const base = planContent(tenant.plan);
  let flagOverrides = {}, capOverrides = {};
  try { if (tenant.feature_flags_override_json) flagOverrides = JSON.parse(tenant.feature_flags_override_json); } catch { /* ignore malformed override */ }
  try { if (tenant.usage_caps_override_json) capOverrides = JSON.parse(tenant.usage_caps_override_json); } catch { /* ignore malformed override */ }
  return {
    featureFlags: { ...base.featureFlags, ...flagOverrides },
    usageCaps: { ...base.usageCaps, ...capOverrides },
  };
}

module.exports = { PLANS, planContent, resolveEntitlements };
