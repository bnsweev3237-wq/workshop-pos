const express = require('express');
const { version } = require('../../package.json');
const releaseNotes = require('../release-notes');

const router = express.Router();

// Deliberately the one unauthenticated route in the whole API — a version number and
// changelog aren't sensitive, and showing them even on the login screen is useful.
router.get('/version', (req, res) => {
  res.json({ version, releaseNotes });
});

module.exports = router;
