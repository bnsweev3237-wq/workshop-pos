// Hand-maintained changelog shown in the app's "What's new" viewer. Add a new entry at the
// top each time package.json's version is bumped — keep it short, user-facing language,
// what changed and why it matters to someone running the shop, not commit-message detail.
module.exports = [
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
