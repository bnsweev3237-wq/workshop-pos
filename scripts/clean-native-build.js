// @electron/rebuild leaves a ".forge-meta" marker next to the compiled native module recording
// which ABI it last built for, and trusts that marker on later runs instead of re-checking the
// actual binary. If something else (a plain `npm rebuild`, a fresh `npm install`) overwrites the
// binary without updating that marker, @electron/rebuild sees a marker that already matches and
// silently skips rebuilding — shipping a native module compiled for the wrong Node/Electron ABI
// with no error until someone runs the packaged app. Deleting the build output before every
// Electron dev run or packaging step forces a real rebuild every time instead of trusting it.
const fs = require('fs');
const path = require('path');

const buildDir = path.join(__dirname, '..', 'node_modules', 'better-sqlite3', 'build');
fs.rmSync(buildDir, { recursive: true, force: true });
console.log('Cleared better-sqlite3\'s native build output — it will be rebuilt fresh for the correct ABI.');
