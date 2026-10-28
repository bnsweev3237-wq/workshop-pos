# Craftium — standalone edition

![Craftium](docs/logo.png)

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
  target charity rules (below) and to bulk-select items for an event. An optional photo,
  automatically resized/compressed on upload, shows as a thumbnail in the Items list.
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
  these" quantity per item — that can also be bulk-set by category, and can be cloned into
  a new draft. Printable packing lists and barcoded price tags are generated from that same
  per-event item selection.
- Line discounts (% or $, admin/manager/lead only), tax rate presets by state, and an
  item-number lookup on the Sell page that doubles as a barcode-scanner input.
- Card processors (Settings, admin-only) — an editable list of who you take card payments
  through and each one's transaction fee, prepopulated with common processors. The Sell page
  asks which one took a card sale; Reports subtracts the fee from an event's "true profit"
  and breaks sales out by processor. See "Card processors" below.
- A Custom Orders tab for tracking made-to-order/custom pieces from request to pickup, with
  its own catalog-linked items, totals/payment tracking, and printable packing list and
  purchase order.
- A free-text notes field on items, for your own reference — never shown on the Sell page.
- Custom branding (Settings, admin-only) — a business name and logo that show up in the app
  header, the sign-in screen, and at the top of printed packing lists/purchase orders, plus
  an accent color that re-skins the app. See "Branding" below.
- Test mode — a full, independent sandbox (items, materials, events, sales, and custom
  orders each have their own test-side copy) for practicing or training without touching
  real data.
- Database maintenance (Settings, admin-only) — copy real data into the test sandbox, or
  purge everything.
- A Duplicates review panel (Settings) grouping same-named items/materials for cleanup.
- Every section of the Settings page can be collapsed by clicking its heading, remembered
  per browser.
- Returns — process a return against a past sale from its receipt, netted out of every Reports
  figure automatically. See "Returns" below.
- An "Export accounting CSV" button in Reports, and Export/Import CSV buttons on the Items and
  Materials tabs for bulk spreadsheet edits. See "CSV import/export" below.
- Email alerts (Settings, admin-only) — an SMTP config reused for any email this app sends,
  starting with an optional daily low-stock digest. See "Email alerts" below.
- Licensing groundwork (Settings → License, admin-only) — an instance can optionally be given
  a key and check in with a central license server. Inert with no key set, which is every
  install's default today. See "Licensing (groundwork)" below.

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

| | Sell | Reports | Custom Orders | Calculator / Materials / Items | Settings |
|---|---|---|---|---|---|
| **Admin** | ✓ full | ✓ | ✓ | ✓ | ✓ |
| **Manager** | ✓ full | ✓ | ✓ | ✓ | — |
| **Lead** | ✓ full | ✓ | ✓ | — | — |
| **Cashier** | restricted | — | — | — | — |

A **cashier**'s Sell access is deliberately narrower than every other role's: no custom
(off-catalog) ticket items, no creating/editing/ending an event, no overriding a ticket
line's tax rate (it always uses whatever the open event actually specifies), and no line
discounts. All of these are enforced server-side (see `server/routes/sales.js` and
`server/routes/events.js`), not just hidden in the UI — a cashier's session gets a 403 (or
has the submitted value silently corrected or stripped) even on a direct API request, not
just a missing button.

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
is ended first. An existing event (draft, open, or past) can also be cloned — its items/
quantities, charity rules, tax rate, and state carry over into a new draft, so a recurring
market doesn't have to be rebuilt from scratch each time. The clone always lands as a draft
regardless of the source event's own status.

## Packing lists and price tags

From an event's item picker: "Print packing list" gives a plain list of exactly what to bring
and how many of each (the per-item quantities if the event is scoped to "Selected items", or
every sellable item's current stock if it's open to the whole catalog — a "not for shows" item
never appears either way). "Print price tags" makes one tag per item in that same set, with
name, price, and — unless you uncheck "Include barcode" — a scannable Code128 barcode encoding
the item's own item number. Both use the browser's print dialog (no bundled PDF library, same
as Reports' PDF export), and a USB barcode scanner, which types out a barcode's digits like a
keyboard, reads those tags straight into the Sell page's search box: scan one there and it's
added to the ticket directly, instead of just filtering the grid the way typing normally does.

## Branding

Settings → Branding (admin-only) holds your business name, a logo, and an accent color:
- **Business name** replaces "Craftium" in the app header and on the sign-in screen, and
  heads up printed packing lists and purchase orders alongside the logo.
- **Logo** is uploaded as an image file (PNG/JPEG/WebP/SVG, under 1.5MB) and stored as a data
  URL in the database itself — no separate upload folder to back up, it travels with the
  rest of your data in the same SQLite file/backups.
- **Accent color** re-skins the app's buttons, highlights, and links — pick one of the warm
  presets or any custom color. It's the one thing a shop can make its own; everything else
  in the palette (background, text, borders) stays fixed to keep contrast and readability
  consistent regardless of what color is picked.

"Reset all branding to default" clears all three in one step — back to plain Craftium
branding everywhere, no name, no logo, default accent — for undoing a shop's customization
entirely rather than reverting one field at a time.

All three are public, even logged out, since the sign-in screen itself shows them — none of
it is sensitive information (the same name/logo a customer already sees on a receipt).

A large Craftium banner at the top of the sign-in screen, and a small footer mark (every
tab), are independent of all of the above — they always show, regardless of what a
business's own branding is set to, so it's never unclear what the app underneath a
rebranded install is.
Changing it only takes effect after "Save branding"; nothing is applied live as you type.

## Discounts

Each line on a ticket can get a discount — a % or a flat $ off that line's total, applied
before tax so tax is only ever charged on what was actually paid. Admin, manager, and lead
accounts can add one from the Sell page ticket; the cashier role can't — the control isn't
shown to it, and the server rejects a discount on a cashier's ticket even if sent directly,
so this isn't just a UI restriction.

## Returns

A customer bringing something back — distinct from voiding a sale (the Sell page's existing
"Void sale," same-session "this never happened," which deletes the sale outright). A return is
a separate, later transaction against a past sale: the original sale stays exactly as recorded,
the way real accounting treats a return (in the period it happens, not a rewrite of the period
it was sold in).

From a sale's receipt — wherever one shows up: the Sell page's recent sales, or an event's own
sales list — "Return…" opens a line-by-line picker, capped by whatever's already been returned
against that sale so far. Pick how many of each line came back, how the refund went out (cash
or card/other), an optional reason, and it's processed: stock comes back, and the refund (with
its own share of tax, and a prorated share of any discount the line had) is recorded.

Every other figure in Reports — revenue, profit, by item, by salesperson, by event — nets a
return out automatically, the same arithmetic as a line with a negative quantity on it. Reports
also has its own "Returns" tab, just the record of each one (already netted out everywhere
else). Not modeled: a return doesn't claw back a charity pledge from the original sale, and no
card-processor fee is applied to the refund (real policies on that vary too much to generalize).

## Card processors

Settings → Card processors (admin-only) holds a list of who you take card payments through —
prepopulated with Square, Venmo, PayPal, Cash App, Stripe, and Clover at common approximate
rates, but these are starting points, not quotes: check the % and fixed fee against your own
processor agreement and adjust as needed, or delete what you don't use and add your own.

Each processor has an **Available** checkbox — uncheck it to keep its history and fee rate
without offering it on the Sell page for new sales (it isn't deleted, just not offered). You
can also pick a **default processor**, preselected on the Sell page's picker instead of
"Other / unlisted" — handy if you mostly take one. A disabled processor is never used as the
default even if it's still set as one; the picker just falls back to "Other / unlisted."

On the Sell page, tendering a sale by card (instead of cash) shows a "Card processor" picker —
any available (checked) processor, or "Other / unlisted" for a card payment through something
not in the list (no fee tracked). The fee itself (`total × fee % + fixed fee`) is computed and
stored server-side at checkout, as a snapshot of that processor's rate at the time — editing,
disabling, or deleting a processor later never rewrites a past sale's recorded fee, the same
reasoning as tax presets. If no processors are available at all, card sales work exactly as
before this feature existed: a plain "Card / Other" tender with nothing to pick and no fee
recorded.

Reports subtracts total card fees from an event's "true profit" (alongside booth/space cost),
shows a "Card processing fees" figure in the overview stats when there are any, and breaks
sales out by processor — volume, sale count, and fees — in its own card next to "Payment type".

## Tax rate presets

Settings can hold a list of your own named tax rate presets by state (sales tax % and, if it
differs, cash tax %) — add them once, then on any event's form, type the state and click "Fill
tax rate from preset" to fill both rate fields instead of retyping them. It's a one-time fill,
not a live link: editing a preset later never changes an event that already used it. There's
no built-in nationwide rate table — real local rates vary by city and county well beyond what
a single per-state number could cover, so this is only ever what you've entered yourself.

## Custom Orders

A separate tab (admin/manager/lead) for tracking made-to-order or custom pieces from request
to pickup — customer name and contact, due date, status, notes, and the items actually in the
order. It's deliberately separate from the regular Sell-page flow: an order is set up and
tracked here, the way you'd work through it in the shop, and ringing up the actual sale when
it's picked up still happens as its own step on the Sell page as usual.

An order's items are picked from your catalog — picking one fills in its current price, which
you can still override just for that order (a custom order doesn't always charge catalog
price). Each line is a snapshot: a later price change, or even deleting the catalog item,
never rewrites or orphans a line that already references it. Like an event's item picker, the
items section only becomes usable once the order has been saved once (fill in at least a
customer name first); saving keeps the form open afterward so you're not stuck re-opening it.
The order totals its lines, adds shipping if it's a shipping order, and shows amount paid and
balance due. "Amount paid" can be typed in by hand (e.g. a deposit taken by some other means)
and/or built up from one or more real sales rung up via "Check out" — see below; whichever way
it got there, it's a running total, never overwritten by the other.

An order with items gets a "Check out" button in the list — it loads the order's full items
(and shipping, if any) onto the Sell page ticket, ready to tender and complete exactly like
any other sale: pick cash or card (with a processor and fee, if you use those), and finish it
on the Sell page as usual. It's a real sale — counted in Reports, decrementing stock, the works
— and completing it links back to the order and adds the sale's total to amount paid
automatically. If the order already has something recorded as paid, checking out asks first,
since it loads the order's *full* items regardless — remove or adjust ticket lines before
completing if a sale is only meant to collect the remaining balance. Voiding a sale that paid
for an order reverses that credit and unlinks it, the same as voiding reverses anything else.

From an order with items, "Print packing list" gives a plain qty list of what's in it (reusing
the same printable format as an event's packing list), and "Print purchase order" gives an
itemized, customer-facing summary — item, quantity, price, line total, shipping, and the
running total/paid/balance — to hand over or send with the order.

An order defaults to in-person pickup, with a status of New → In progress → Ready for pickup
→ Picked up (changeable inline from the list). Checking "This order ships" instead brings up
a shipping address field, a shipping & handling charge, and a tracking number (filled in once
it's gone out) — the same statuses relabel themselves to Ready to ship / Shipped for a shipped
order, so the queue reads correctly either way. A shipping order with a charge set gets an
"Add shipping to ticket" button in the list, which switches to the Sell page and drops that
charge onto the current ticket as its own custom line, instead of retyping the amount there
by hand.

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
  unable to see this report; editing/deleting a material is still admin/manager only. The
  "Needs ordering" stat tile is a drill-down, not just a count — click it to reveal the actual
  list of low items/materials underneath, collapsed again on a second click.
- **Tax**: tax collected for the range, a day-by-day chart, and a breakdown by the actual rate
  charged — useful if cash and card ever use different rates.
- **Voids**: every voided sale in the range, with who rang it up and who voided it. Voiding a
  sale has always deleted it outright (stock gets restored); this is a permanent record of
  that happening, kept in a separate table so a void stays visible here even though the
  original sale is gone.
- **Returns**: every return in the range — see "Returns" above for what a return actually is
  and how it's netted into every other sub-tab here. This one is just its own record of each.

**Export accounting CSV**, next to Export PDF, downloads the currently-filtered date range's
sales and returns as a ledger-style CSV — one row per transaction (date, type, event, tender,
card processor, subtotal/tax/fee/total/profit, sold by), returns as negative amounts — for
handing to an accountant or importing into bookkeeping software. Separate from (and simpler
than) the Items/Materials CSV export under "CSV import/export" below, which is for inventory,
not transactions.

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

## Duplicates

Settings → Duplicates (admin only) groups items and materials that share a name — ignoring
case and extra/trailing whitespace, so "Wooden Keychain" and "wooden keychain " show up as the
same group even though they're not byte-for-byte identical. Most often this is a double-
submitted save or a CSV-imported row whose name didn't quite match an existing one closely
enough for the importer's own matching to catch (see "CSV import/export" above).

Only name groups with more than one entry are shown, each with enough to tell them apart —
item number or source, price, cost, stock, and when it was added — plus its own exact name in
quotes, so a case difference between two otherwise-identical-looking rows is visible. Deleting
one from here is the exact same action as deleting it from the Items or Materials tab (the
same confirmation, the same cleanup of anything that referenced it), just found by scanning
for duplicates instead of searching for it directly. The list is purely a read of what's
already there — nothing is merged or auto-deleted on its own.

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

Each backup also has a **Restore** button, which replaces every bit of live data — items,
materials, sales, settings, everything — with that backup's, then restarts the server the
same way Software updates does (see below): a fresh backup of whatever was live is taken
automatically first, so restoring the wrong one by mistake is itself recoverable.

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

## Licensing (groundwork)

Settings → License (admin only) lets an instance be given a key and checks in once a day
against a central license server the vendor runs — see `licensing/README.md` for that side.
This is groundwork for a future tiered/licensed product, not a live feature: with no key
entered (the default for every install today, including this one), the app runs exactly as it
always has, fully unrestricted. Nothing is gated yet — no tiers have been decided — but the
plumbing (phone-home, a 30-day offline grace period, and `hasFeature()`/`checkUsageCap()`
helpers routes can opt into) is real and in place for when they are.

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

## CSV import/export

The Items and Materials tabs each have **Export CSV** / **Import CSV** buttons (admin/manager)
— a spreadsheet-friendly way to bulk-edit stock, prices, and the like in Excel/Google Sheets
and bring the changes back in, separate from the full-fidelity JSON "Export/Import backup" in
the header (which is for whole-catalog restore/migration, matched by internal id).

Items export covers the inventory-relevant fields only — name, item number, type, category,
price, cost, stock, low-stock threshold, "not for shows," and notes — not a "made" item's
materials recipe, labor time, or overhead %, which doesn't fit a flat CSV row. Materials
export covers name, source, product link, price, yield, stock, and low-stock threshold.

Importing **matches each row to an existing item or material and updates it, or creates a new
one if nothing matches** — items first by item number (if the column's filled in and it's a
real one), then by name; materials by name only. A row that matches the same item/material
another row in the same file already claimed is treated as a new entry instead of overwriting
that first row's update. **A blank cell leaves that field unchanged** on an existing row (so a
sheet that's just a stock recount doesn't need every other column filled in too), but becomes
a zero/empty default when creating something new. For materials, a Source name that doesn't
already exist in Settings is created automatically rather than rejected.

## Email alerts

Settings → Email alerts (admin only) holds one outgoing mail server (SMTP) config, reused for
any email alert this app sends — host, port, SSL/TLS on or off, username/password, a "from"
address, and where alerts go. Nothing is sent until a host, "from" address, and recipient are
all set. The password is never echoed back once saved — the field just shows "leave blank to
keep unchanged" — and "Send test email" sends one to the configured recipient right away, to
confirm the setup actually works before relying on it for something nobody's watching happen.

The first (and so far only) thing that uses it is a **daily low-stock digest**: turn on "Email
me when stock is low" and, once a day, if anything in the real catalog (never test-mode stock)
is at or below its low-stock alert level, you get a summary email listing what and how much is
left. Nothing is sent on a day nothing's low. A "Check now" button runs the same check
immediately, for trying it out without waiting for the next scheduled run.

Not modeled (yet, but the SMTP setup above is reusable for it): per-order or per-event alerts,
a digest frequency other than daily, or more than one recipient.

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
