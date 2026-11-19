const express = require('express');
const { version } = require('../../package.json');
const releaseNotes = require('../release-notes');
const { MODE } = require('../mode');

const router = express.Router();

// Deliberately the one unauthenticated route in the whole API — a version number and
// changelog aren't sensitive, and showing them even on the login screen is useful. `mode`
// lets the client hide multi-tenant-irrelevant UI (self-update, license key entry, host disk
// usage) without a separate authenticated call just to find that out.
router.get('/version', (req, res) => {
  res.json({ version, releaseNotes, mode: MODE });
});

module.exports = router;
