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
- Sell / point of sale — **does not require login**, by design, so cashiers can use it freely
- Admin accounts — add/remove, reset passwords, all other pages gated behind login
- Reports — core stats, revenue-by-day chart, top items, payment-type breakdown, a
  collapsible cost/profit-by-item breakdown (tap an item to see its materials drill-down),
  an events ledger with "true profit" (event sales profit minus booth/space cost, for
  splitting proceeds among partners), and PDF export via the browser's native print-to-PDF
  (no bundled PDF library, so it keeps working with no internet connection)

Also working: an Electron desktop package — the same server and UI, running inside a native
window with its own per-install database in the OS's standard app-data folder.

Not yet ported from the artifact version (will follow in a later pass):
- Release notes / changelog viewer
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
npx electron-builder install-app-deps   # rebuilds better-sqlite3 for Electron's Node version
npm run electron
```

**Build installers** (`.dmg` / `.exe` / `.AppImage`) with `electron-builder`:

```
npm run dist         # current platform
npm run dist:mac
npm run dist:win
npm run dist:linux
```

Output lands in `dist/`. `npm run dist` rebuilds native dependencies automatically as part of
packaging, so you don't need `install-app-deps` before it — that command is only for running
`npm run electron` directly during development.

**One gotcha:** `better-sqlite3` is a native module, compiled separately for plain Node.js vs.
Electron's bundled Node. `install-app-deps` (or `npm run dist`) rebuilds it for Electron, which
means a plain `npm start` will then fail to load it. If you need to go back to running the
server directly with `npm start`/`npm run dev`, run `npm rebuild better-sqlite3` first to
rebuild it back for plain Node. (Keeping separate clones for web-mode dev and desktop-mode dev
avoids the back-and-forth entirely.)

No app icon is set up yet — unbuilt installers use Electron's default icon. Add
`build/icon.png` (Linux), `build/icon.icns` (macOS) and `build/icon.ico` (Windows) and
electron-builder will pick them up automatically.

Code protection (obfuscation, license keys, machine-locking) hasn't been added yet — `asar`
packaging is on by default, which deters casual browsing of the source but is not real DRM.
That's planned as a later phase; for now, treat this build as "not trivially editable by a
curious user," not "can't be reverse engineered by someone determined to."

## Security model

- **Sell page**: fully public (no login) — ticket, checkout, event setup, void sale, test mode.
- **Everything else** (Calculator, Materials, Saved Items, Settings): requires an admin login.
- **Reports**: gated in the UI; the server additionally never sends per-sale profit data to an
  unauthenticated request (a dedicated `/api/sales/full` endpoint, admin-only, is the only
  place profit figures are served from).
- **Item cost/materials**: the public item list (used by the Sell page) never includes cost or
  materials data — only name, price, stock, and item number. Full item data requires login.
- Passwords are bcrypt-hashed; sessions are server-side, cookie-based, httpOnly.
- "Forgot password" recovery: any other logged-in admin can reset a colleague's password from
  Settings. There's no outbound email in this version, so if you're the *only* admin and get
  locked out, recovery requires direct access to the server (see below).

### Manually resetting a password (last-admin lockout)

```
node -e "
const bcrypt = require('bcryptjs');
const db = require('./server/db');
db.prepare('UPDATE admins SET password_hash = ? WHERE username = ?')
  .run(bcrypt.hashSync('newpassword', 12), 'theusername');
console.log('done');
"
```
