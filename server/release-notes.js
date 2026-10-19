// Hand-maintained changelog shown in the app's "What's new" viewer. Add a new entry at the
// top each time package.json's version is bumped — keep it short, user-facing language,
// what changed and why it matters to someone running the shop, not commit-message detail.
module.exports = [
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
