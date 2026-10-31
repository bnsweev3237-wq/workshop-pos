// Hand-maintained changelog shown in the app's "What's new" viewer. Add a new entry at the
// top each time package.json's version is bumped — keep it short, user-facing language,
// what changed and why it matters to someone running the shop, not commit-message detail.
//
// Versioning standard (semver — bump package.json's version to match):
//   - PATCH (x.y.Z+1): bug fixes, copy/polish tweaks only — nothing a user would call a new
//     capability.
//   - MINOR (x.Y+1.0): one or more new features/capabilities, still backward-compatible.
//     Everything shipped together in one release gets one minor bump and one entry below,
//     even if it bundles several unrelated features.
//   - MAJOR (X+1.0.0): reserved for an actual breaking change (removing/replacing a feature,
//     an incompatible data format) or a deliberate milestone — never bumped without calling
//     it out first; routine feature work never reaches for this on its own.
module.exports = [
  {
    version: '1.12.0',
    date: '2026-10-31',
    notes: [
      'Print a price tag for a single item straight from the Items tab — click the 🏷 next to any item for the same label sheet, barcode, and booth number options as an event\'s price tags, plus how many copies to print.',
    ],
  },
  {
    version: '1.11.0',
    date: '2026-10-31',
    notes: [
      'Two more Avery label sheets for price tags: 5167/8167 and 5195/8195. Both are too short for a barcode, so they print the item number as text instead — pick 5160, 5162, 5163, or 22806 if you need a scannable one.',
    ],
  },
  {
    version: '1.10.0',
    date: '2026-10-31',
    notes: [
      'Price tags can now print to real Avery label sheets — pick 5160, 5162, 5163, or 2" round 22806 (or stick with plain cut-out paper) from the event\'s "Items available" section, with or without a barcode.',
      'Add a booth number to an event (same section) and it prints on every price tag — handy for consignment shops and multi-vendor shows.',
    ],
  },
  {
    version: '1.9.2',
    date: '2026-10-30',
    notes: [
      'Click any item or material photo to see it bigger — the thumbnail in the Items/Materials list, the preview in the Calculator or a material\'s detail panel. Esc or clicking outside closes it.',
    ],
  },
  {
    version: '1.9.1',
    date: '2026-10-30',
    notes: [
      'Fixed: the new material photo upload was hard to find — it only lived inside a collapsed panel with no hint it was there. Each material row now has a visible "+" thumbnail that opens the photo picker directly.',
    ],
  },
  {
    version: '1.9.0',
    date: '2026-10-30',
    notes: [
      'Materials can now have a photo too, same as items — automatically resized/compressed on upload, shown as a thumbnail in the Materials tab (click the 🔗 button on a row to open the upload control, next to the product link).',
      'Settings → Disk space now breaks out how much of the database is item/material photos specifically, and has a "Purge all photos" button to clear every photo (items and materials, real and test) in one step and reclaim the space.',
    ],
  },
  {
    version: '1.8.6',
    date: '2026-10-28',
    notes: [
      'Every printed document — packing lists, price tags, purchase orders, and Reports\' PDF export — now has a small "Powered by Craftium" line at the bottom, alongside whatever business branding the document\'s own letterhead already shows.',
    ],
  },
  {
    version: '1.8.5',
    date: '2026-10-28',
    notes: [
      'The app header shows the Craftium mark when a business hasn\'t uploaded their own logo, instead of just an empty spot — upload one in Settings → Branding and it takes over there as before.',
    ],
  },
  {
    version: '1.8.4',
    date: '2026-10-28',
    notes: [
      'Fixed: the footer\'s Craftium icon was oversized relative to the small footer text, looking out of place. Sized back down to fit.',
    ],
  },
  {
    version: '1.8.3',
    date: '2026-10-28',
    notes: [
      'The sign-in screen now leads with a large Craftium banner instead of a small credit line — bigger and clearer. The in-app footer mark is also larger.',
      'Settings → Branding: a "Reset all branding to default" button clears your business name, logo, and accent color in one step, instead of reverting each field separately.',
    ],
  },
  {
    version: '1.8.2',
    date: '2026-10-28',
    notes: [
      'A small "Powered by Craftium" credit now always shows on the sign-in screen and in the app footer — independent of a business\'s own custom branding (name/logo/accent color), which still controls everything else (header, title, printed packing lists and purchase orders) exactly as before.',
    ],
  },
  {
    version: '1.8.1',
    date: '2026-10-28',
    notes: [
      'Updated logo — the browser tab icon, installed-PWA icon, and desktop app icon all use the new mark.',
    ],
  },
  {
    version: '1.8.0',
    date: '2026-10-28',
    notes: [
      'Settings → License: groundwork for a future licensed/tiered product — an instance can optionally be given a key and check in daily with a central license server. With no key set (the default, unchanged for every existing install), nothing about the app is different. No tiers exist yet and nothing is gated — this just lays the plumbing.',
    ],
  },
  {
    version: '1.7.1',
    date: '2026-10-28',
    notes: [
      'Settings sections now start collapsed by default instead of expanded — click a heading to open the ones you need. Any section you\'ve already expanded on this device stays that way.',
    ],
  },
  {
    version: '1.7.0',
    date: '2026-10-28',
    notes: [
      'Settings → Automatic backups: each backup now has a Restore button next to Download — replaces everything (items, materials, sales, settings) with that backup\'s data and restarts the server. A fresh backup of whatever\'s live is taken automatically first, so restoring the wrong one by mistake is itself recoverable.',
      'Every section on the Settings page can now be collapsed by clicking its heading — handy once there are a dozen of them. Stays how you left it on this device.',
      'Items can now have a photo — upload one from the Calculator\'s item editor and it shows as a thumbnail in the Items list. Photos are automatically resized and compressed on upload so they don\'t bloat the database.',
    ],
  },
  {
    version: '1.6.1',
    date: '2026-10-26',
    notes: [
      'Fixed: the in-app "Update now" button (Settings → Software updates) could fail with a git error — npm leaves package-lock.json locally modified after every install, which then blocked the next update\'s git pull if that update\'s own commit also touched the lockfile. It now discards that one file\'s local changes (never anything else) right before pulling, the same workaround the manual VPS update command already used.',
    ],
  },
  {
    version: '1.6.0',
    date: '2026-10-26',
    notes: [
      'Returns: process a return against a past sale right from its receipt (Sell page or an event\'s sales list) — pick which lines and how many of each came back, a reason, and how the refund went out. Stock is restored and it\'s netted out of revenue, profit, and every Reports breakdown automatically, with its own "Returns" tab for the record of each one. Distinct from voiding a sale (same-session "this never happened") — a return is a separate, later transaction that keeps the original sale intact.',
      'Reports now has an "Export accounting CSV" button next to Export PDF — the currently-filtered date range\'s sales and returns as a ledger-style CSV (one row each, returns as negative amounts) for an accountant or bookkeeping software.',
      'Settings → Email alerts: set up an outgoing mail server (SMTP) once, with a "Send test email" button to confirm it works. Its first real use is a daily low-stock digest — turn it on and get an email summary whenever anything drops to or below its low-stock alert level.',
    ],
  },
  {
    version: '1.5.0',
    date: '2026-10-26',
    notes: [
      'Settings → Duplicates: items and materials that share a name (ignoring case and extra spaces) are grouped together for review, with enough detail (price, cost, stock, when it was added) to tell copies apart, and a Delete button that works exactly like deleting from the Items/Materials tab.',
    ],
  },
  {
    version: '1.4.2',
    date: '2026-10-26',
    notes: [
      'Every remaining 4-decimal price display now rounds to 2 like the rest of the app — the Calculator\'s per-material cost breakdown and Reports\' material/item cost drill-downs, alongside the Materials tab\'s "Per piece" column from the last update.',
    ],
  },
  {
    version: '1.4.1',
    date: '2026-10-26',
    notes: [
      'The Materials tab\'s "Per piece" cost now rounds to 2 decimal places like every other price in the app, instead of showing up to 4.',
    ],
  },
  {
    version: '1.4.0',
    date: '2026-10-26',
    notes: [
      'Custom Orders got a "Check out" button — it loads the order\'s items (and shipping) onto the Sell page ticket, ready to tender and complete as a real sale. Completing it counts in Reports like any other sale, decrements stock, and automatically credits the amount toward the order\'s amount paid (and reverses it if that sale is later voided).',
      'Items and Materials tabs now have Export CSV / Import CSV buttons for bulk editing in a spreadsheet — a separate, simpler format from the full JSON backup. Importing matches rows to existing items/materials (by item number or name) and updates them, or creates new ones; a blank cell leaves that field unchanged.',
    ],
  },
  {
    version: '1.3.1',
    date: '2026-10-26',
    notes: [
      'Each card processor now has an "Available" checkbox in Settings — uncheck one to stop offering it on the Sell page without losing its fee rate or history on past sales.',
      'You can set a default card processor, preselected on the Sell page\'s picker instead of "Other / unlisted."',
    ],
  },
  {
    version: '1.3.0',
    date: '2026-10-26',
    notes: [
      'Card processors: Settings now has an editable list of your payment processors (prepopulated with Square, Venmo, PayPal, Cash App, Stripe, and Clover) with each one\'s transaction fee — a % and an optional fixed fee per sale.',
      'Tendering a sale by card on the Sell page now asks which processor took it. The fee is calculated and recorded automatically; picking "Other / unlisted" (or just not setting up any processors) works exactly as before, with no fee tracked.',
      'Reports now subtracts card processing fees from an event\'s "true profit", and breaks sales out by processor (volume, count, fees) in a new "By card processor" card.',
    ],
  },
  {
    version: '1.2.1',
    date: '2026-10-26',
    notes: [
      'Fixed: in Settings → Users, a row\'s role dropdown and buttons could run off the edge of the card instead of wrapping, especially on narrower screens.',
    ],
  },
  {
    version: '1.2.0',
    date: '2026-10-26',
    notes: [
      'A warmer, more distinctive look throughout the app — new color palette and a display font for headings, in both light and dark mode.',
      'Custom branding: set your business name and upload a logo in Settings → Branding. They show up in the app header, on the sign-in screen, and at the top of printed packing lists and purchase orders.',
      'Pick an accent color (a few warm presets, or any color you like) that re-skins buttons, highlights, and links throughout the app.',
    ],
  },
  {
    version: '1.1.0',
    date: '2026-10-26',
    notes: [
      'Custom Orders can now hold actual items picked from your catalog (with a per-order price override), instead of just a single free-text description. The order totals its items, shipping, amount paid, and balance due.',
      'An order with items can print a packing list (what to pack) and a purchase order (an itemized, customer-facing order summary with pricing and totals).',
      'Items can now have a free-text notes field, for your own reference — never shown on the Sell page.',
    ],
  },
  {
    version: '1.0.2',
    date: '2026-10-26',
    notes: [
      'A shipping custom order with a shipping & handling charge now has an "Add shipping to ticket" button — drops that charge onto the current Sell page ticket as its own line instead of retyping it there.',
    ],
  },
  {
    version: '1.0.1',
    date: '2026-10-26',
    notes: [
      'Custom Orders can now track shipping: check "This order ships" to add a shipping address, a shipping & handling charge, and a tracking number. Statuses relabel to "Ready to ship" / "Shipped" for those orders.',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-10-26',
    notes: [
      'Events can now be cloned — duplicates its items/quantities, charity rules, and tax settings into a new draft, for a recurring market instead of rebuilding it from scratch each time.',
      'An event\'s item picker can now print a packing list ("what to bring, and how many") straight from its item selection.',
      'Price tags can now be printed for an event\'s item selection too, each with a barcode (Code128, from the item\'s own item number) you can scan at checkout — or skip the barcode and print name/price only.',
      'The Sell page\'s search box now also doubles as an item-number lookup: scan or type an item\'s number and press Enter to add it straight to the ticket.',
      'Ticket lines can now get a % or $ discount — admin/manager/lead only, not the cashier role.',
      'Added tax rate presets by state (Settings) and a state field on events — type the state on an event and click "Fill tax rate from preset" instead of retyping rates you\'ve saved before.',
      'New Custom Orders tab: track made-to-order/custom pieces from request to pickup (customer, due date, status, notes), separate from the regular catalog and event inventory.',
      'The Inventory report\'s "Needs ordering" figure is now a drill-down — click it to reveal exactly which items and materials are running low, instead of a figure with no detail nearby.',
    ],
  },
  {
    version: '0.21.0',
    date: '2026-10-25',
    notes: [
      'Items can now be marked "Custom — don\'t bring to shows" on the Calculator. A marked item is automatically left off the Sell page whenever an event is open — no need to manage it per event — but still sells normally the rest of the time.',
    ],
  },
  {
    version: '0.20.1',
    date: '2026-10-25',
    notes: [
      'The Materials and Items sort dropdowns now default to alphabetical (A–Z) instead of date added.',
    ],
  },
  {
    version: '0.20.0',
    date: '2026-10-25',
    notes: [
      'Materials and Items can now be sorted by name (A–Z or Z–A) or by date added (newest or oldest first), next to the search box on each tab. Your choice is remembered.',
    ],
  },
  {
    version: '0.19.2',
    date: '2026-10-25',
    notes: [
      'Saving an item on the Calculator now takes you back to the Items tab, instead of leaving you on the Calculator.',
    ],
  },
  {
    version: '0.19.1',
    date: '2026-10-24',
    notes: [
      'Fixed: saving a newly created event used to close its setup form right away, before "Items available at this event" or "Charity giving" ever had a chance to show up (they only appear once an event has been saved at least once). Saving now keeps the form open so you can pick items or add a charity rule in the same sitting.',
    ],
  },
  {
    version: '0.19.0',
    date: '2026-10-23',
    notes: [
      'Events can now be set up in advance as drafts — create as many as you want, ready to go, then hit "Start event" on the one you\'re running right now. Only one event can be open at a time; starting another while one is still open is blocked until you end it.',
      'Items available at an event can now have a "bringing X of these" quantity set per item — handy when you\'re not taking your whole inventory. Selling one at that event counts against both that quantity and your overall stock, and voiding a sale corrects it automatically.',
      'The event\'s item picker can now check off an entire category at once, instead of only one item at a time.',
      'Items can now belong to more than one category (e.g. both "Jewelry" and "Holiday") instead of just one.',
    ],
  },
  {
    version: '0.18.0',
    date: '2026-10-22',
    notes: [
      'Reports is now organized into sub-tabs: Overview, By salesperson, By item, Events, Inventory, Tax, and Voids.',
      '"By salesperson" now shows true profit per person, not just revenue.',
      'New Inventory report: items/materials on hand and what they\'re worth, plus a reorder list of anything running low.',
      'New Tax report: tax collected by day and by the rate actually charged.',
      'New Voids report: every voided sale, who rang it up, and who voided it — voiding a sale now keeps a permanent record of that happening instead of leaving no trace.',
    ],
  },
  {
    version: '0.17.0',
    date: '2026-10-22',
    notes: [
      'Materials and Items are now searchable from their own tabs.',
      'Events can now be restricted to a chosen set of items instead of your whole catalog being sellable — useful for a smaller pop-up or a themed table. Set it from the event\'s gear icon → "Items available at this event".',
    ],
  },
  {
    version: '0.16.0',
    date: '2026-10-22',
    notes: [
      'Redesigned the Sell page for phone screens — the ticket is now a bottom sheet with a persistent total/item-count bar, instead of being buried below the entire item grid and sales history.',
      'Numeric fields on the Sell page (price, quantity, received, tax rate) now bring up a number pad on mobile instead of a full keyboard.',
    ],
  },
  {
    version: '0.15.1',
    date: '2026-10-22',
    notes: [
      'Fixed a crash on startup for existing installs introduced in 0.15.0 — the new database index for offline sale syncing was being created before the migration that adds the column it needs.',
    ],
  },
  {
    version: '0.15.0',
    date: '2026-10-22',
    notes: [
      'The Sell page now works offline — losing the connection mid-shift no longer stops you from ringing up sales. Checkouts are saved on the device and sync automatically once you\'re reconnected, with an on-screen indicator while anything is still waiting to sync.',
      'Craftium is now installable as an app on a tablet or phone (add it to your home screen) for a more native feel, separate from the offline support above.',
    ],
  },
  {
    version: '0.14.0',
    date: '2026-10-22',
    notes: [
      'Added a disk space gauge to Settings, showing how much storage this server has left and how much Craftium\'s own database and backups are using.',
      'Added a "Clear old backups" button to free space immediately — keeps the most recent backup, removes the rest.',
    ],
  },
  {
    version: '0.13.2',
    date: '2026-10-22',
    notes: [
      'Security: added baseline hardening response headers (Content-Security-Policy, clickjacking protection, HSTS) scoped specifically to what the app actually loads, so nothing had to be loosened to avoid breaking the UI.',
    ],
  },
  {
    version: '0.13.1',
    date: '2026-10-22',
    notes: [
      'Security: sign-in is now rate-limited, so a deployed install can\'t have its password brute-forced over unlimited attempts.',
      'Security: the "Check price" feature can no longer be pointed at this server\'s own internal network or a cloud metadata address — only real external product pages.',
      'Security: the session cookie is now marked HTTPS-only automatically when running behind HTTPS (e.g. the VPS deploy), without affecting a plain-HTTP LAN install.',
    ],
  },
  {
    version: '0.13.0',
    date: '2026-10-22',
    notes: [
      'Added automatic daily database backups, kept on the server (most recent 5) — viewable and downloadable from Settings, with a "Back up now" option too.',
      'Added self-update for server installs: Settings can now check for and apply the latest version directly, restarting itself when done. Not available on the desktop app.',
    ],
  },
  {
    version: '0.12.0',
    date: '2026-10-22',
    notes: [
      'New accounts and password resets now force a password change on next sign-in — when an admin sets someone\'s password (a new account, or a reset), that person has to replace it with one only they know before they can use the app at all.',
    ],
  },
  {
    version: '0.11.1',
    date: '2026-10-20',
    notes: [
      'Out-of-stock items now show up red in the Sell page\'s item grid, not just the small stock-count text.',
    ],
  },
  {
    version: '0.11.0',
    date: '2026-10-20',
    notes: [
      'Material sources are now a plain editable list in Settings instead of a fixed Temu/Amazon/Home Depot/Other set — prepopulated with common sites (Amazon, Temu, Walmart, Home Depot, Lowe\'s, Michaels, Hobby Lobby, Etsy, AliExpress, eBay), but add, rename, or remove any of them.',
    ],
  },
  {
    version: '0.10.0',
    date: '2026-10-20',
    notes: [
      'Materials can now be tagged with where they\'re bought (Temu, Amazon, Home Depot, Other) and a saved product link.',
      'Added a "Check price" button per material that tries to fetch the current price from its saved link for you to review and accept — it never changes a price on its own, and it won\'t work on every site (none of the three offer a price API for this, so it\'s best-effort).',
    ],
  },
  {
    version: '0.9.1',
    date: '2026-10-19',
    notes: [
      'Reports now shows test data while test mode is on, and real data while it\'s off — matching every other tab, instead of always showing real data regardless.',
      'The "Test mode is on" banner now shows above every tab, not just Sell.',
      'Added a way to exit test mode without deleting your test data, alongside the existing "clear" and "exit & purge" options.',
    ],
  },
  {
    version: '0.9.0',
    date: '2026-10-19',
    notes: [
      'Test mode is now a full, separate sandbox: items and materials each have their own independent test-side copy with its own stock, alongside the real catalog (test sales and events already worked this way). Switching test mode on or off now switches Calculator, Materials, and Items over too, not just Sell.',
      'Added a Database maintenance section to Settings (admin only): "Copy main → test" replaces whatever test data exists with a fresh copy of your real items, materials, events, and sales, so test mode has realistic data to try things on. "Purge everything" permanently deletes every item, material, sale, and event (real and test) — accounts and settings are kept — and requires typing DELETE to confirm.',
    ],
  },
  {
    version: '0.8.0',
    date: '2026-10-19',
    notes: [
      'Renamed "Saved items" to "Items".',
      'Items can now be added directly with a manually entered cost and sale price — for things you buy ready-made and resell, instead of only pricing things you make from materials.',
      'Added categories to items.',
      'Charity giving moved from items to events: set up one or more rules per event — a % for a specific item category, and/or a checkbox to apply a % to every sale at the event. Reports now shows a per-event charity wrap-up broken out by category.',
    ],
  },
  {
    version: '0.7.0',
    date: '2026-10-19',
    notes: [
      'Added charity giving: mark an item with a default % of its profit to donate, optionally overridden per event from the event’s setup form.',
      'Reports now shows the amount owed to charity — overall, per event, and per item.',
      'Fixed a bug where saving, editing stock, or deleting an item in Calculator/Saved Items didn’t refresh the Sell page’s item list until the next periodic refresh.',
    ],
  },
  {
    version: '0.6.0',
    date: '2026-10-18',
    notes: [
      'Added two new account roles: Manager (everything but Settings) and Lead (Sell + Reports).',
      'Cashier accounts are now more restricted on the Sell page: no custom items, no editing or ending an open event, and no overriding a ticket line’s tax rate.',
    ],
  },
  {
    version: '0.5.0',
    date: '2026-10-18',
    notes: [
      'Renamed from Workshop POS to Craftium.',
      'Added a custom app icon.',
    ],
  },
  {
    version: '0.4.0',
    date: '2026-10-18',
    notes: [
      'Added a sign-out button to the header.',
      'Added an optional "sold by" record on each sale, shown on receipts and in a new Reports breakdown by user — toggle it on or off in Settings.',
    ],
  },
  {
    version: '0.3.0',
    date: '2026-10-18',
    notes: [
      'Added cashier accounts — a lower-privilege login limited to the Sell page, separate from admin accounts.',
      'The Sell page now requires signing in (as an admin or cashier) instead of being open to anyone.',
      'Added a version number and this release notes viewer to the app.',
    ],
  },
  {
    version: '0.2.0',
    date: '2026-10-18',
    notes: [
      'Reports: added a cost/profit breakdown by item, with a tap-to-expand materials drill-down.',
      'Reports: added an events ledger showing "true profit" after deducting each event’s booth/space cost.',
      'Reports: added PDF export, using the browser’s own print-to-PDF so it keeps working offline.',
      'Added a desktop app for Windows, Mac, and Linux, built with Electron.',
      'Set up automatic builds so installers are produced for all three platforms on every release.',
    ],
  },
  {
    version: '0.1.0',
    date: '2026-10-18',
    notes: [
      'First standalone release: a real backend (Express + SQLite) replacing the earlier Claude.ai artifact prototype.',
      'Admin accounts with login; the Sell page stayed open with no login required.',
      'Core pricing calculator, material library, saved items, point of sale, and sales reports.',
    ],
  },
];
