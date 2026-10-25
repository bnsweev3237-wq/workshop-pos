// Hand-maintained changelog shown in the app's "What's new" viewer. Add a new entry at the
// top each time package.json's version is bumped — keep it short, user-facing language,
// what changed and why it matters to someone running the shop, not commit-message detail.
module.exports = [
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
