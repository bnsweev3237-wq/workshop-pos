const nodemailer = require('nodemailer');
const { getSetting, setSetting, getBool, setBool } = require('./settings');
const { isMultiTenant } = require('../mode');

// All email-related config lives in the generic settings k/v table, same as branding/the
// default card processor — this is the one place it's actually assembled/used. The SMTP
// password is the one sensitive value here; it's stored as plaintext (this app has no
// encryption-at-rest for anything, including user data already in the database), but it's
// never read back out through the API — getMailConfig below only ever reports whether one is
// set, not its value, so the Settings page can show "unchanged" instead of re-displaying it.
//
// Multi-tenant mode is different on purpose: the SMTP host/port/credentials come from the
// platform's own environment variables, never from a tenant's own settings. Letting a tenant
// point the shared server at an arbitrary SMTP host would be a server-side request forgery
// surface (the platform process making outbound connections to wherever a tenant names,
// including internal/private addresses) — the same class of risk server/lib/priceFetch.js
// already guards against for "Check price" requests. A tenant still chooses its own `from`
// name/address and alert recipient; it just can't choose where the mail actually routes through.
function platformSmtpConfig() {
  return {
    host: process.env.CRAFTIUM_SMTP_HOST || '',
    port: Number(process.env.CRAFTIUM_SMTP_PORT) || 587,
    secure: process.env.CRAFTIUM_SMTP_SECURE === 'true',
    user: process.env.CRAFTIUM_SMTP_USER || '',
    pass: process.env.CRAFTIUM_SMTP_PASS || '',
  };
}

function getMailConfig() {
  if (isMultiTenant) {
    const platform = platformSmtpConfig();
    return {
      host: platform.host, port: platform.port, secure: platform.secure, user: platform.user,
      hasPassword: !!platform.pass, platformManaged: true,
      from: getSetting('mailFrom', ''),
      alertRecipient: getSetting('mailAlertRecipient', ''),
      lowStockEnabled: getBool('mailLowStockEnabled', false),
    };
  }
  return {
    host: getSetting('mailSmtpHost', ''),
    port: Number(getSetting('mailSmtpPort', '587')) || 587,
    secure: getBool('mailSmtpSecure', false),
    user: getSetting('mailSmtpUser', ''),
    hasPassword: !!getSetting('mailSmtpPass', ''),
    from: getSetting('mailFrom', ''),
    alertRecipient: getSetting('mailAlertRecipient', ''),
    lowStockEnabled: getBool('mailLowStockEnabled', false),
  };
}

// `password` is only ever written when it's a non-empty string — omitting it (or sending '')
// from the client leaves whatever's already stored untouched, so updating the other fields
// never requires re-typing a password that's already working.
//
// In multi-tenant mode, host/port/secure/user/password are silently ignored — see
// platformSmtpConfig() above for why a tenant never gets to choose the SMTP host.
function setMailConfig(b) {
  if (!isMultiTenant) {
    if (typeof b.host === 'string') setSetting('mailSmtpHost', b.host.trim());
    if (b.port !== undefined && b.port !== '') setSetting('mailSmtpPort', String(Number(b.port) || 587));
    if (typeof b.secure === 'boolean') setBool('mailSmtpSecure', b.secure);
    if (typeof b.user === 'string') setSetting('mailSmtpUser', b.user.trim());
    if (typeof b.password === 'string' && b.password !== '') setSetting('mailSmtpPass', b.password);
  }
  if (typeof b.from === 'string') setSetting('mailFrom', b.from.trim());
  if (typeof b.alertRecipient === 'string') setSetting('mailAlertRecipient', b.alertRecipient.trim());
  if (typeof b.lowStockEnabled === 'boolean') setBool('mailLowStockEnabled', b.lowStockEnabled);
  return getMailConfig();
}

function isMailConfigured() {
  const c = getMailConfig();
  return !!(c.host && c.from);
}

function buildTransport() {
  const platform = isMultiTenant ? platformSmtpConfig() : null;
  const host = platform ? platform.host : getSetting('mailSmtpHost', '');
  const port = platform ? platform.port : (Number(getSetting('mailSmtpPort', '587')) || 587);
  const secure = platform ? platform.secure : getBool('mailSmtpSecure', false);
  const user = platform ? platform.user : getSetting('mailSmtpUser', '');
  const pass = platform ? platform.pass : getSetting('mailSmtpPass', '');
  // No TLS override — nodemailer's own default (reject an invalid/self-signed certificate)
  // stays on. Most installs point this at a real provider (Gmail, Office365, a transactional
  // SMTP relay) with a properly-signed cert, where that default is exactly what you want; a
  // self-hosted mail server with its own cert is a more advanced setup this doesn't special-
  // case for.
  //
  // Nodemailer's own default timeouts run to multiple minutes — fine for a long-lived mail
  // queue, not for a "Send test email" button an admin is sitting in front of, or an unattended
  // daily check that would otherwise hang a request indefinitely against a host that's
  // unreachable (wrong address, a firewall silently dropping the connection, outbound SMTP
  // blocked entirely). 15s is generous for an actual SMTP handshake and still fails fast enough
  // to give a real answer either way.
  return nodemailer.createTransport({
    host, port, secure, auth: user ? { user, pass } : undefined,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 15000,
  });
}

// Never throws — every caller (a request handler, or the unattended low-stock scheduler) gets
// a plain {ok, error} back instead of having to wrap this in its own try/catch. `error` is the
// raw message from nodemailer/the SMTP server, worth surfacing as-is to an admin debugging a
// misconfigured host — the kind of self-hosted setup problem this tool can't know how to word
// better than the server that actually rejected it.
async function sendMail({ to, subject, text, html }) {
  if (!isMailConfigured()) return { ok: false, error: 'Email isn’t configured yet — set it up in Settings → Email alerts.' };
  if (!to) return { ok: false, error: 'No recipient address.' };
  try {
    const transport = buildTransport();
    await transport.sendMail({ from: getSetting('mailFrom', ''), to, subject, text, html });
    return { ok: true };
  } catch (err) {
    console.error('sendMail failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { getMailConfig, setMailConfig, isMailConfigured, sendMail };
