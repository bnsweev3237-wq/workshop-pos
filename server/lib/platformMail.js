// Platform-level email — account verification and the post-verification welcome message.
// Deliberately independent of any tenant's own mail settings or db context: it has to work
// during server/tenancy/provision.js's provisionTenant(), which runs before any tenant
// AsyncLocalStorage context exists, and these are system emails ("verify your account"), not
// business correspondence a tenant's own configured "from" name should be on.
const nodemailer = require('nodemailer');
const { platformSmtpConfig } = require('./mail');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function isValidEmail(s) {
  return typeof s === 'string' && EMAIL_RE.test(s.trim());
}

function platformFromAddress() {
  return process.env.CRAFTIUM_PLATFORM_FROM || '';
}

// Called once at boot (server/index.js's createMultiTenantApp, never in single-tenant mode,
// and deliberately not at this module's own require time — auth.js requires this module
// unconditionally in both modes, so throwing merely from requiring it would break single-
// tenant mode too). Login itself depends on this email actually arriving, so a misconfigured
// platform mail setup needs to be loud at boot, not discovered the first time a real signup
// gets stuck unable to log in — same reasoning as server/lib/secret.js's
// CRAFTIUM_SESSION_SECRET requirement.
function assertPlatformMailConfigured() {
  const smtp = platformSmtpConfig();
  if (!smtp.host) {
    throw new Error('CRAFTIUM_SMTP_HOST must be set in multi-tenant mode — account verification emails depend on it, and login is blocked until a tenant verifies.');
  }
  const from = platformFromAddress();
  // Accepts a bare address or nodemailer's "Display Name <addr@host>" form — just needs a
  // real-looking address in there somewhere.
  const addrMatch = from.match(/<([^>]+)>/);
  if (!isValidEmail(addrMatch ? addrMatch[1] : from)) {
    throw new Error('CRAFTIUM_PLATFORM_FROM must be set to a valid "from" address (e.g. "Craftium <hello@example.com>") in multi-tenant mode.');
  }
}

function buildPlatformTransport() {
  const { host, port, secure, user, pass } = platformSmtpConfig();
  return nodemailer.createTransport({
    host, port, secure, auth: user ? { user, pass } : undefined,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 15000,
  });
}

// Never throws — same {ok, error} shape as server/lib/mail.js#sendMail, so a send failure
// (a real one, e.g. the owner's mail server rejecting the message) never crashes the request
// that triggered it. Caller logs/handles the failure; this just reports it.
async function sendPlatformMail({ to, subject, text, html }) {
  if (!to) return { ok: false, error: 'No recipient address.' };
  try {
    const transport = buildPlatformTransport();
    await transport.sendMail({ from: platformFromAddress(), to, subject, text, html });
    return { ok: true };
  } catch (err) {
    console.error('sendPlatformMail failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { isValidEmail, assertPlatformMailConfigured, sendPlatformMail };
