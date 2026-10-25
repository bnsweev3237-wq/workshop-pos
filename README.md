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
- Material library — each material can be tagged with where it's bought from (a user-managed
  list in Settings, prepopulated with common sites) and a saved product link, with a
  "Check price" button that tries to fetch the current price from that link for you to
  review (see "Checking material prices" below)
- Items (make/sell stock tracking) — either priced from materials/labor/overhead ("made"),
  or entered directly as a cost and sale price ("resale", for things bought ready-made and
  resold as-is). An item can belong to more than one category (comma-separated), used to
  target charity rules (below) and to bulk-select items for an event.
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
- Charity giving — set up one or more rules per event (from the event's setup form on the
  Sell page): a % of profit for a specific item category, and/or a checkbox to apply a % to
  every sale at the event. Reports calculates and shows what's owed, overall, per event, and
  broken out by category in each event's wrap-up.
- Events can be set up ahead of time as drafts and started later with one click ("Upcoming
  events" on the Sell page), with a per-event item selection — down to a "bringing X of
  these" quantity per item — that can also be bulk-set by category.
- Test mode — a full, independent sandbox (items, materials, events, and sales each have
  their own test-side copy) for practicing or training without touching real data.
- Database maintenance (Settings, admin-only) — copy real data into the test sandbox, or
  purge everything.

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

| | Sell | Reports | Calculator / Materials / Items | Settings |
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

## Charity giving

Charity rules live on the **event**, not the item (Sell page → the event's gear icon →
Charity giving for this event). Each rule is either:
- a % of profit from sales of items tagged with a specific **category**, or
- a % of profit from **every** sale at the event (the "apply to all sales" checkbox).

An event can have several rules — e.g. 5% for the "Military" category and 2% for
"Education" — added one at a time with the "+ Add rule" button. Since an item can now belong
to more than one category, if more than one of an item's categories has a rule, the first
match alphabetically wins; otherwise the event's "all sales" rule (if any) applies instead.
Custom (off-catalog) ticket items never generate a charity figure, since there's no known
cost for them to take a percentage of profit from.

Each sale snapshots the matched rule, percentage, and dollar amount *at the time*, per line,
so a later change to an item's category or an event's rules never rewrites history. Reports
shows the total owed for the selected date range, a per-event figure (in the Events ledger,
alongside true profit), and — inside each event's expandable panel — a "Charity wrap-up"
broken out by category (or "All sales"). This is informational reporting only — there's no
"mark as donated" ledger/payment-tracking workflow (yet).

The dollar amounts a rule produces are profit-derived, so they're stripped from every public
(cashier-visible) response the same way profit is — both the per-sale total and the per-line
figures only appear in the admin/manager/lead Reports endpoints.

## Items available at an event

By default every item in the catalog can be sold at any event — the same as before this
existed. An event can instead be scoped to just a chosen few (Sell page → the event's gear
icon → Items available at this event → "Selected items", then check off which ones): useful
for a smaller pop-up or a themed table where you're only bringing part of your catalog. A
whole category can be checked off at once instead of one item at a time — a one-time
convenience that checks whatever currently matches, not a live rule, so items added to that
category later aren't automatically included. While a selection is set, the Sell page's item
grid only offers the chosen items; everything else stays in the catalog untouched, just not
sellable at that particular event. Switching back to "All items" reverts immediately.
Materials and Items are also now searchable from their own tabs, and the item picker here has
its own search too. Both tabs also have a sort dropdown next to the search box — name (A–Z or
Z–A) or date added (newest or oldest first) — remembered per browser.

Each selected item can also have a quantity set — how many you're bringing to this
particular event, separate from (and never changing) its overall stock. The Sell page then
shows that as "remaining" for the item at this event, counting down as it sells; selling one
there reduces both that count and the item's overall stock. There's no hard stop at zero —
same as running low on overall stock, it's shown but doesn't block the sale. The remaining
count is never stored on its own; it's always the quantity you set minus however much has
sold there so far, so voiding a sale corrects it automatically with nothing extra to fix.
Leaving the quantity blank for an item means no limit — it's available up to whatever the
overall stock allows, same as before this existed.

An item can also be marked "Custom — don't bring to shows" on the Calculator (a checkbox
under its stock fields). That's a stronger, item-level version of the above: a marked item is
left off the Sell page's item grid at *any* event, regardless of that event's own item
selection — including one scoped to "All items" — so a one-off or made-to-order item never
needs to be remembered and excluded per event. It's still fully usable everywhere else: normal
pricing/stock tracking on the Calculator and Items tab, and sellable as usual on the Sell page
whenever no event is open.

## Draft (upcoming) events

An event doesn't have to be set up the moment it starts. Saving one as a draft instead of
starting it right away (the "When" choice on the event form) puts it in an "Upcoming events"
list on the Sell page, where it just sits — ready to go, including whatever items/quantities
and charity rules you've already set on it — until you hit "Start event". As many drafts can
exist at once as you want; only one event can be *open* (the live, active one) at a time per
test/real side, so starting a draft while another is already open is refused until that one
is ended first.

## Reports

Reports is organized into sub-tabs (admin/manager/lead), sharing one date-range selector
across the ones that use it:

- **Overview**: revenue/profit/tax stat tiles, revenue by day, top items, payment type split.
- **By salesperson**: revenue, true profit, and sale count per person who rang up a sale
  (requires the "sold by" setting to be on). Needs Settings → Sales tracking turned on.
- **By item**: cost and profit per item, with a per-material drill-down.
- **Events**: every event with true profit after booth/space cost. Not date-range limited.
- **Inventory**: a point-in-time snapshot, not date-range limited — items on hand and what
  they're worth at full price ("potential revenue") and at cost ("stock value"), materials on
  hand and what they cost you, and a reorder list of anything at or below its low-stock
  threshold (the same threshold already used for the red low-stock badges elsewhere). Reading
  material cost/stock here is open to the same roles as the rest of Reports (admin/manager/
  lead) — previously materials data required admin/manager, which would have left a lead role
  unable to see this report; editing/deleting a material is still admin/manager only.
- **Tax**: tax collected for the range, a day-by-day chart, and a breakdown by the actual rate
  charged — useful if cash and card ever use different rates.
- **Voids**: every voided sale in the range, with who rang it up and who voided it. Voiding a
  sale has always deleted it outright (stock gets restored); this is a permanent record of
  that happening, kept in a separate table so a void stays visible here even though the
  original sale is gone.

## Test mode

Test mode (the Sell page → "Enter test / training mode") is a full, independent sandbox:
items, materials, events, and sales each have their own separate test-side copy, alongside
the real ones. Switching test mode on or off switches every tab — Calculator, Materials,
Items, Reports, and Sell — over to that side, so practicing (including making items,
adjusting stock, and running sales) never touches real data or real stock. Reports shows
test data while test mode is on and real data while it's off, the same split as everywhere
else — it never mixes the two.

A banner reading "Test mode is on" shows above every tab, not just Sell, so it's never
ambiguous which side you're looking at. From that banner:
- **Exit test mode (keep test data)** — leaves test mode without deleting anything, so a
  half-finished practice run (an open test event, items you were trying out) is still there
  next time you turn test mode back on.
- **Clear test data now** — wipes the test side without leaving test mode.
- **Exit & purge test data** — leaves test mode and wipes the test side in one step.

All three only ever touch the test side (items, materials, events, sales, and any charity
rules on those test events) — the real side is never affected.

## Database maintenance

Settings → Database maintenance (admin only):
- **Copy main → test** replaces whatever test data exists with a fresh, fully independent
  copy of the real items, materials, events, and sales — new ids throughout, with every
  cross-reference (an item's linked materials, a sale's event and line items) remapped to
  the new test-side copies — so test mode has realistic data to try things on without any
  risk of it ever touching the real catalog or figures.
- **Purge everything** permanently deletes every item, material, sale, and event, on both
  the real and test sides. Accounts, roles, and settings are kept. The admin has to type
  `DELETE` to enable the button, and the server checks that confirmation again independently
  rather than trusting the client. This can't be undone.

## Automatic backups

Once a day, the server takes a full backup of the live database (using SQLite's own online
backup API, so it's safe to run while the app is in use) and keeps it in `data/backups/` —
the 5 most recent are kept, older ones are removed automatically. A run is skipped (not
failed) if the server is low on disk space; it just tries again on the next scheduled run.
Settings → Automatic backups (admin only) lists current backups with download links, and has
a "Back up now" button for an on-demand one outside the daily schedule.

This is separate from the manual **Export backup** button in the header, which downloads a
portable JSON file of items/materials/sales/events you can re-import — the daily backups are
raw database snapshots meant for disaster recovery on this same install, not for moving data
between installs.

Settings → Disk space (admin only) shows a gauge of the filesystem the data directory lives
on — used/free/total, color-shifting from green to yellow at 70% used and red at 90% — plus a
breakdown of how much Craftium's own database and backups are using. A "Clear old backups"
button deletes everything except the single most recent backup, for freeing space immediately
rather than waiting for the daily keep-5 pruning to age old ones out on its own.

## Software updates

If the server is running from a git checkout (the documented VPS deploy, not the desktop
Electron build), Settings → Software updates (admin only) can check whether `origin/master`
has commits the running server doesn't, and apply them itself: `git pull --ff-only` followed
by `npm install`. After a successful update the server exits on purpose — a process manager
(the deploy guide sets this up with `pm2`) restarts it running the new code. Without one,
the server just stops and needs to be started by hand. On the desktop app, or any install
that isn't a git checkout, this section explains that and doesn't offer the button.

## Sell page on a phone

Below the same ~860px width where the rest of the app switches to a single column, the Sell
page's ticket moves out of the normal page flow into a bottom sheet: a persistent bar shows
the live item count and total, and tapping it slides the full ticket (lines, tax, tender,
checkout) up from the bottom instead of it sitting buried below the entire item grid and sales
history. Desktop and tablet keep the original side-by-side layout untouched.

## Offline mode (Sell page only)

Craftium is installable as a PWA (add it to a tablet's home screen — a service worker caches
the app shell so it opens even with no connection) and the **Sell page specifically** keeps
working when the connection drops mid-session: ringing up items, checking out, and voiding a
sale you haven't synced yet all still work, using the last-known item list and stock cached on
the device. Completed sales are queued locally (in IndexedDB) and synced to the server
automatically the moment the connection comes back — each carries a client-generated id so a
retried sync after a dropped connection can't record the same sale twice. An orange banner
shows while offline and while sales are still waiting to sync, with a manual "Sync now" option.

This is deliberately scoped to just the Sell page. Calculator, Materials, Items, Reports, and
Settings all still require a live connection — you wouldn't normally edit pricing or materials
mid-sale at a booth anyway, and giving every screen the same offline/sync treatment would be a
much bigger undertaking for little real benefit.

A couple of limitations worth knowing: stock shown while offline is whatever was last synced,
so two devices offline at once could both "sell" the last unit of something — the same risk
any offline point of sale has, there's no way around it without a connection. And opening the
app for the very first time with no connection at all won't work — it needs to have loaded
successfully at least once (e.g. at the start of the day) before it can fall back to cached
data; what it supports is losing the connection *during* a session, not never having had one.

## Material sources & checking prices

Settings → Material sources (admin only) is a plain editable list of where materials get
bought from — prepopulated on first run with common ones (Amazon, Temu, Walmart, Home Depot,
Lowe's, Michaels, Hobby Lobby, Etsy, AliExpress, eBay), but otherwise just ordinary data: add,
rename, or remove any of them. Nothing about any specific site is hardcoded — the seeded list
is only a starting point. Removing a source un-tags any material that had it, rather than
leaving it pointing at something that no longer exists.

A material in the library can be tagged with one of these sources and a saved link to its
exact product listing (admin/manager, same as the rest of the Materials tab). Click the 🔗
button on a material's row to open that link field and a **Check price** button.

"Check price" fetches that page and tries to read off a current price, then shows it next
to the material's existing price for you to accept or ignore — it never updates the price on
its own. None of these sites offer a price-lookup API for personal/small-business use, so
this works by reading whatever structured price data a page happens to include for search
engines (the same kind of data behind rich search results) — which means it can fail
outright: the site may block the request, or may only render its price with JavaScript that
a plain page fetch never runs. A failed check always says so rather than guessing, and a
successful one is always one click away from being applied, never automatic.

## Security model

- Every page requires a login — there's no anonymous access anymore. The only unauthenticated
  route is `/api/meta/version` (just a version number and changelog).
- **Sell page**: reachable by any role — ticket, checkout, event setup, void sale, test mode —
  except that cashiers get the restricted version described above.
- **Calculator / Materials / Items**: admin and manager only.
- **Reports**: admin, manager, and lead. The server never sends per-sale profit data to a role
  below that (a dedicated `/api/sales/full` endpoint is the only place profit figures are
  served from).
- **Settings**: admin only, full stop — adding/removing accounts, changing roles, resetting
  passwords, the sales-attribution toggle, managing the material sources list, database
  maintenance (copy-to-test, purge), backups, and software updates. The update feature never
  takes a repo/branch from the request — it's hardcoded to this install's own checkout and
  `origin/master`, so there's no way to point it anywhere else.
- **Item cost/materials**: the item list used by the Sell page never includes cost or materials
  data — only name, price, stock, and item number. Full item data requires Reports-level
  access or higher.
- Every one of the above is checked server-side on every request, independent of the UI — a
  role's server session is rejected with 403 on a route it can't use even if it guesses the
  URL or calls the API directly.
- Passwords are bcrypt-hashed; sessions are server-side, cookie-based, httpOnly, and marked
  `Secure` (HTTPS-only) automatically when the app detects it's being served over HTTPS —
  e.g. the documented nginx + Let's Encrypt VPS deploy — without breaking a plain-HTTP LAN
  install (a booth with no domain/cert).
- Sign-in is rate-limited (10 attempts per IP per 15 minutes) — a deployed, internet-reachable
  install isn't exposed to unlimited password guessing.
- The "Check price" feature's server-side fetch resolves the saved product link's hostname
  and refuses to request anything that resolves to a private, loopback, or link-local address
  (including a cloud provider's instance metadata address) — checked on every redirect hop,
  not just the original link, so a malicious or compromised account can't use it to probe this
  server's own internal network.
- Baseline hardening headers are set on every response (via `helmet`), including a
  Content-Security-Policy scoped to exactly what the app actually loads (its own script, its
  own stylesheet plus inline styles, and Google Fonts — nothing else), clickjacking protection
  (`X-Frame-Options: SAMEORIGIN` / `frame-ancestors 'none'`), and HSTS (which browsers ignore
  entirely over plain HTTP, so it doesn't affect a no-TLS LAN install).
- "Forgot password" recovery: any admin can reset anyone's password from Settings. There's no
  outbound email in this version, so if you're the *only* admin and get locked out, recovery
  requires direct access to the server (see below).
- A password set by someone other than the account's own owner — a brand-new account's
  initial password, or an admin's reset — must be replaced the moment that account next signs
  in. There's no way to reach the app with an admin-chosen password still in place.

### Manually resetting a password (last-admin lockout)

```
node -e "
const bcrypt = require('bcryptjs');
const db = require('./server/db');
db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE username = ?')
  .run(bcrypt.hashSync('newpassword', 12), 'theusername');
console.log('done');
"
```
