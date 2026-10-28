# Craftium licensing server

A small, separate service the vendor runs centrally — **not** part of Craftium itself and
never shipped to or run by a customer. Each Craftium instance (one per tenant, self-hosted the
same way the current VPS deploy works) can optionally be given a license key and the URL of
this service; it then checks in once a day to find out what it's licensed for.

This is groundwork: there's no tier catalog yet, no self-serve signup, and nothing in the
Craftium app is actually gated by a license today (see the comment at the top of
`server/lib/license.js` in the main app). What exists is the mechanism — issue a license,
have an instance check in against it, read back what it's allowed — ready for real tiers to be
defined whenever that's decided, without needing to change how either side talks to the other.

## Running it

```
cd licensing
npm install
PORT=4200 node server.js
```

Like the main app, it keeps its data in a local SQLite file — `licensing/data/licensing.db` by
default, or wherever `LICENSING_DATA_DIR` points. Deploy it the same way the main app is
deployed (a VPS + pm2 + nginx is the documented pattern in the root README), on its own
subdomain — e.g. `license.yourdomain.com` — so Craftium instances have a stable URL to call.

## Issuing a license

There's no admin UI yet — `scripts/manage-license.js` talks directly to the database and is
the whole admin surface for now:

```
node scripts/manage-license.js create "Jane's Pottery Studio" \
  --tier starter \
  --flags '{"emailAlerts":true,"csvImportExport":false}' \
  --caps '{"maxItems":200,"maxUsers":2}' \
  --notes "paid via invoice #004"
```

Prints the generated key (`CRFT-XXXX-XXXX-XXXX`) — hand that to the customer to enter in their
own instance's Settings → License.

Other commands: `list`, `show <key>`, `set-status <key> <active|suspended|revoked>`,
`set-flags <key> '<json>'`, `set-caps <key> '<json>'`.

## How a Craftium instance uses this

An instance with `LICENSE_SERVER_URL` set and a key entered in Settings → License calls
`POST /api/validate` with `{ key }` once a day (plus whenever an admin clicks "Check now") and
caches the result. If this server is unreachable, the instance keeps running on its last
successful result for 30 days before anything would be treated as unlicensed — so this
service going down briefly doesn't lock anyone out. An explicit `suspended`/`revoked` status,
or a key this server has never heard of, takes effect immediately rather than waiting out
that grace window, since those are real answers from the server, not a failure to reach it.

## What's deliberately not here yet

- No tiers table / catalog — a license's `feature_flags_json` and `usage_caps_json` are set
  directly per-license. A `tiers` table to template new licenses from can be added later
  without changing the validate endpoint's shape.
- No payment/signup flow — issuance is manual (above).
- No admin UI — the CLI script is it, intentionally, until there's enough volume to justify one.
