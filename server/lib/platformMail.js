// Platform-level email — account verification and the post-verification welcome message.
// Deliberately independent of any tenant's own mail settings or db context: it has to work
// during server/tenancy/provision.js's provisionTenant(), which runs before any tenant
// AsyncLocalStorage context exists, and these are system emails ("verify your account"), not
// business correspondence a tenant's own configured "from" name should be on.
//
// Configurable two ways, deliberately: env vars (CRAFTIUM_SMTP_HOST etc., CRAFTIUM_PLATFORM_FROM)
// bootstrap a fresh install with no UI step required, but anything saved via the admin console
// (server/routes/platformAdmin.js's /mail-settings, backed by server/control/db.js's
// platform_settings table) takes priority — switching providers later is meant to be a settings
// change you can make from /admin, not a redeploy.
const nodemailer = require('nodemailer');
const controlDb = require('./../control/db');
const { platformSmtpConfig } = require('./mail');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function isValidEmail(s) {
  return typeof s === 'string' && EMAIL_RE.test(s.trim());
}

// The host/port/credentials half is shared with tenant email (server/lib/mail.js's
// platformSmtpConfig — the same platform SMTP relay carries both). Only the "from" address is
// platform-specific: a tenant's receipts/alerts use that tenant's own from name, never this one.
function resolvedFromAddress() {
  return controlDb.getPlatformSetting('platformMailFrom', '') || process.env.CRAFTIUM_PLATFORM_FROM || '';
}

// The shape the admin console reads (server/routes/platformAdmin.js's GET /mail-settings) —
// never the actual password, same convention server/lib/mail.js#getMailConfig already uses
// for tenant-level mail settings.
function getPlatformMailConfig() {
  const smtp = platformSmtpConfig();
  return {
    host: smtp.host, port: smtp.port, secure: smtp.secure, user: smtp.user,
    hasPassword: !!smtp.pass, from: resolvedFromAddress(), configured: isPlatformMailConfigured(),
  };
}

// `password` is only written when it's a non-empty string — leaving it blank (the admin
// console's form does this by default) keeps whatever's already saved, same convention
// server/lib/mail.js#setMailConfig uses.
function setPlatformMailConfig(b) {
  if (typeof b.host === 'string') controlDb.setPlatformSetting('platformSmtpHost', b.host.trim());
  if (b.port !== undefined && b.port !== '') controlDb.setPlatformSetting('platformSmtpPort', String(Number(b.port) || 587));
  if (typeof b.secure === 'boolean') controlDb.setPlatformSetting('platformSmtpSecure', b.secure ? '1' : '0');
  if (typeof b.user === 'string') controlDb.setPlatformSetting('platformSmtpUser', b.user.trim());
  if (typeof b.password === 'string' && b.password !== '') controlDb.setPlatformSetting('platformSmtpPass', b.password);
  if (typeof b.from === 'string') controlDb.setPlatformSetting('platformMailFrom', b.from.trim());
  return getPlatformMailConfig();
}

function isPlatformMailConfigured() {
  const smtp = platformSmtpConfig();
  return !!(smtp.host && resolvedFromAddress());
}

function buildPlatformTransport() {
  const { host, port, secure, user, pass } = platformSmtpConfig();
  return nodemailer.createTransport({
    host, port, secure, auth: user ? { user, pass } : undefined,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 15000,
  });
}

// Never throws — same {ok, error} shape as server/lib/mail.js#sendMail, so a send failure
// (a real one, e.g. the owner's mail server rejecting the message, or nothing configured yet)
// never crashes the request that triggered it. Caller logs/handles the failure; this just
// reports it.
async function sendPlatformMail({ to, subject, text, html }) {
  if (!isPlatformMailConfigured()) return { ok: false, error: 'Platform email isn’t configured yet — set it up in the admin console under Platform email settings.' };
  if (!to) return { ok: false, error: 'No recipient address.' };
  try {
    const transport = buildPlatformTransport();
    await transport.sendMail({ from: resolvedFromAddress(), to, subject, text, html });
    return { ok: true };
  } catch (err) {
    console.error('sendPlatformMail failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  isValidEmail, isPlatformMailConfigured, getPlatformMailConfig, setPlatformMailConfig, sendPlatformMail,
};
