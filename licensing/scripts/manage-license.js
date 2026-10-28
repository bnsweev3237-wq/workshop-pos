#!/usr/bin/env node
// Issues and manages licenses by talking directly to the licensing database — run on the
// server that hosts it, no HTTP/auth required. There's no admin UI yet; this is the whole
// admin surface for now, deliberately, since there's no real tier catalog to build one
// around yet. See licensing/README.md for examples.
const { createLicense, getLicense, listLicenses, updateLicense } = require('../lib/licenses');

function parseJsonArg(raw, label) {
  if (raw === undefined) return undefined;
  try { return JSON.parse(raw); } catch { throw new Error(`--${label} must be valid JSON, e.g. '{"emailAlerts":true}'`); }
}

function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { flags[a.slice(2)] = argv[++i]; }
    else rest.push(a);
  }
  return { flags, rest };
}

function printLicense(l) {
  console.log(`${l.key}  ${l.tenantName}  [${l.status}]  tier=${l.tier || '(none)'}`);
  console.log(`  features: ${JSON.stringify(l.featureFlags)}`);
  console.log(`  caps:     ${JSON.stringify(l.usageCaps)}`);
  if (l.notes) console.log(`  notes:    ${l.notes}`);
}

function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const { flags, rest } = parseFlags(argv);

  if (cmd === 'create') {
    const tenantName = rest.join(' ');
    const license = createLicense({
      tenantName,
      tier: flags.tier,
      featureFlags: parseJsonArg(flags.flags, 'flags'),
      usageCaps: parseJsonArg(flags.caps, 'caps'),
      notes: flags.notes,
    });
    console.log('Created:');
    printLicense(license);
    return;
  }

  if (cmd === 'list') {
    const all = listLicenses();
    if (!all.length) { console.log('No licenses yet.'); return; }
    all.forEach((l, i) => { if (i) console.log(''); printLicense(l); });
    return;
  }

  if (cmd === 'show') {
    const license = getLicense(rest[0]);
    if (!license) { console.error('No license with that key.'); process.exitCode = 1; return; }
    printLicense(license);
    return;
  }

  if (cmd === 'set-status') {
    const [key, status] = rest;
    if (!['active', 'suspended', 'revoked'].includes(status)) {
      console.error('Status must be active, suspended, or revoked.'); process.exitCode = 1; return;
    }
    printLicense(updateLicense(key, { status }));
    return;
  }

  if (cmd === 'set-flags') {
    const [key, json] = rest;
    printLicense(updateLicense(key, { featureFlags: JSON.parse(json) }));
    return;
  }

  if (cmd === 'set-caps') {
    const [key, json] = rest;
    printLicense(updateLicense(key, { usageCaps: JSON.parse(json) }));
    return;
  }

  console.log(`Usage:
  node manage-license.js create "<tenant name>" [--tier starter] [--flags '{"emailAlerts":true}'] [--caps '{"maxItems":500}'] [--notes "..."]
  node manage-license.js list
  node manage-license.js show <key>
  node manage-license.js set-status <key> <active|suspended|revoked>
  node manage-license.js set-flags <key> '<json>'
  node manage-license.js set-caps <key> '<json>'`);
}

main();
