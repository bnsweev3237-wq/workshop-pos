# Craftium — standalone edition

A pricing calculator + point-of-sale app for a small workshop/craft business, built to be
installed standalone (desktop or a customer's own web host) rather than run as a hosted
multi-tenant service. Single business per install, no account signup, no cloud dependency.

Ported from an earlier prototype built as a Claude.ai artifact. The pricing math, POS flow,
and reporting logic are unchanged; the storage and auth layers are new — this version has a
real backend and a real database instead of relying on a third-party platform's capabilities.

## Status (first milestone)

Working end to end, tested:
- Calculator (materials, labor, overhead, markup/margin/multiplier pricing)
- Material library
- Saved items (make/sell stock tracking)
- Sell / point of sale — requires signing in; every role can reach it, but the base cashier
  role is restricted there (see roles below)
- Four account roles — add/remove, reset passwords, change role, all from Settings
  (admin-only). See "Roles" below for exactly what each one can do.
- Reports — core stats, revenue-by-day chart, top items, payment-type breakdown, a
  collapsible cost/profit-by-item breakdown (tap an item to see its materials drill-down),
  an events ledger with "true profit" (event sales profit minus booth/space cost, for
  splitting proceeds among partners), and PDF export via the browser's native print-to-PDF
  (no bundled PDF library, so it keeps working with no internet connection)
- A version number and "What's new" release notes viewer in the footer
- Optional per-sale attribution ("who rang this up") — a Settings toggle, on by default,
  shown on receipts and in a Reports breakdown by user; off means nothing new gets recorded,
  not just hidden
- A sign-out button in the header

Also working: an Electron desktop package — the same server and UI, running inside a native
window with its own per-install database in the OS's standard app-data folder — and a GitHub
Actions workflow that builds Windows/Mac/Linux installers automatically.

Not yet built:
- Docker packaging, licensing/update-subscription system

## Why SQLite, not Postgres

Each install is one business's own isolated instance — there's no multi-tenant scoping to
design for, so a single-file database is the right fit: no separate database server to
install or manage, and it backs up by copying a file. This also means stock updates during
checkout are protected by a real SQL transaction, not the lease-based workaround the artifact
version needed (that platform's database had no transactions at all).

## Running it

```
npm install
npm start
```

Visit http://localhost:4100. First visit prompts you to create the first admin account
(no login required to reach the Sell page itself). The SQLite database lives in `data/workshop.db`,
created automatically on first run — back it up by copying that file.

## Desktop app (Electron)

The same app, packaged as a native desktop window instead of something you open in a browser.
It runs the identical Express server internally (on `localhost`, picking a free port
automatically if 4100 is taken) and stores its database in the OS's standard per-user
app-data folder instead of a `data/` folder next to the code, so it survives reinstalls/updates
that replace the app bundle:

- macOS: `~/Library/Application Support/Craftium/data/`
- Windows: `%APPDATA%\Craftium\data\`
- Linux: `~/.config/Craftium/data/`

**Renamed from "Workshop POS":** the app-data folder name comes from the product name, so an
install made before the rename stored its database under a `Workshop POS` folder instead of
`Craftium`. A fresh install of the renamed build won't see that old data automatically — copy
`Workshop POS/data/workshop.db` into the new `Craftium/data/` folder (same filename) to carry
an existing database forward, or just start fresh if there's nothing worth keeping yet.

**Try it without building an installer:**

```
npm run electron
```

**Build installers** (`.dmg` / `.exe` / `.AppImage`) with `electron-builder`:

```
npm run dist         # current platform
npm run dist:mac
npm run dist:win
npm run dist:linux
```

Output lands in `dist/`.

`better-sqlite3` is pinned to v13+, which ships prebuilt N-API binaries for every platform
bundled directly in the npm package — no compiler, no Visual Studio/Xcode command line tools,
no separate rebuild step for Electron vs. plain Node, and no network access needed beyond the
initial `npm install`. (It does require Node.js ≥ 22, which is why Electron is pinned to a
version recent enough to bundle Node ≥ 22 internally — an older Electron with an older bundled
Node will crash on startup when it tries to load the database.)

App icon: `build/icon.png` (Linux), `build/icon.icns` (macOS), `build/icon.ico` (Windows) —
electron-builder picks these up automatically by convention, no config needed. The web app's
favicon/touch icon live in `public/favicon.png` and `public/icons/icon-192.png`. All of them
are generated from one master design — see `build/icon-source.svg` for the vector original if
it ever needs to be regenerated at a different size or color.

Code protection (obfuscation, license keys, machine-locking) hasn't been added yet — `asar`
packaging is on by default, which deters casual browsing of the source but is not real DRM.
That's planned as a later phase; for now, treat this build as "not trivially editable by a
curious user," not "can't be reverse engineered by someone determined to."

## Roles

Four account roles, each strictly a subset of the one above it, except that only admins and
managers can edit pricing/materials:

| | Sell | Reports | Calculator / Materials / Saved Items | Settings |
|---|---|---|---|---|
| **Admin** | ✓ full | ✓ | ✓ | ✓ |
| **Manager** | ✓ full | ✓ | ✓ | — |
| **Lead** | ✓ full | ✓ | — | — |
| **Cashier** | restricted | — | — | — |

A **cashier**'s Sell access is deliberately narrower than every other role's: no custom
(off-catalog) ticket items, no creating/editing/ending an event, and no overriding a ticket
line's tax rate — it always uses whatever the open event actually specifies. All three are
enforced server-side (see `server/routes/sales.js` and `server/routes/events.js`), not just
hidden in the UI — a cashier's session gets a 403 (or has the submitted value silently
corrected) even on a direct API request, not just a missing button.

## Security model

- Every page requires a login — there's no anonymous access anymore. The only unauthenticated
  route is `/api/meta/version` (just a version number and changelog).
- **Sell page**: reachable by any role — ticket, checkout, event setup, void sale, test mode —
  except that cashiers get the restricted version described above.
- **Calculator / Materials / Saved Items**: admin and manager only.
- **Reports**: admin, manager, and lead. The server never sends per-sale profit data to a role
  below that (a dedicated `/api/sales/full` endpoint is the only place profit figures are
  served from).
- **Settings**: admin only, full stop — adding/removing accounts, changing roles, resetting
  passwords, the sales-attribution toggle.
- **Item cost/materials**: the item list used by the Sell page never includes cost or materials
  data — only name, price, stock, and item number. Full item data requires Reports-level
  access or higher.
- Every one of the above is checked server-side on every request, independent of the UI — a
  role's server session is rejected with 403 on a route it can't use even if it guesses the
  URL or calls the API directly.
- Passwords are bcrypt-hashed; sessions are server-side, cookie-based, httpOnly.
- "Forgot password" recovery: any admin can reset anyone's password from Settings. There's no
  outbound email in this version, so if you're the *only* admin and get locked out, recovery
  requires direct access to the server (see below).

### Manually resetting a password (last-admin lockout)

```
node -e "
const bcrypt = require('bcryptjs');
const db = require('./server/db');
db.prepare('UPDATE users SET password_hash = ? WHERE username = ?')
  .run(bcrypt.hashSync('newpassword', 12), 'theusername');
console.log('done');
"
```
