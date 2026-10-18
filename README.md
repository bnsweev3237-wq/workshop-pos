# Workshop POS — standalone edition

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
- Sell / point of sale — requires signing in as an admin **or cashier**; both can ring up
  sales, void, and manage events, but only admins can see or change anything else
- Admin and cashier accounts — add/remove, reset passwords, change role; everything outside
  the Sell page is admin-only
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

- macOS: `~/Library/Application Support/Workshop POS/data/`
- Windows: `%APPDATA%\Workshop POS\data\`
- Linux: `~/.config/Workshop POS/data/`

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

No app icon is set up yet — unbuilt installers use Electron's default icon. Add
`build/icon.png` (Linux), `build/icon.icns` (macOS) and `build/icon.ico` (Windows) and
electron-builder will pick them up automatically.

Code protection (obfuscation, license keys, machine-locking) hasn't been added yet — `asar`
packaging is on by default, which deters casual browsing of the source but is not real DRM.
That's planned as a later phase; for now, treat this build as "not trivially editable by a
curious user," not "can't be reverse engineered by someone determined to."

## Security model

- Every page requires a login — there's no anonymous access anymore. The only unauthenticated
  route is `/api/meta/version` (just a version number and changelog).
- **Sell page**: reachable by **admin or cashier** accounts — ticket, checkout, event setup,
  void sale, test mode.
- **Everything else** (Calculator, Materials, Saved Items, Settings, full Reports): **admin
  only**. A cashier's server session is rejected with 403 on these routes even if they guess
  the URL — this isn't just hidden in the UI.
- **Reports**: the server never sends per-sale profit data to a non-admin request (a dedicated
  `/api/sales/full` endpoint, admin-only, is the only place profit figures are served from).
- **Item cost/materials**: the item list used by the Sell page never includes cost or materials
  data — only name, price, stock, and item number. Full item data requires an admin login.
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
