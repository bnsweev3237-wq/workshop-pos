const fs = require('fs');

// `bavail` (blocks available to an unprivileged process), not `bfree` (raw free blocks,
// which includes space the OS reserves for root) — bavail is the honest "how much can this
// app actually still write" number, and the two can differ a lot on a quota'd filesystem.
function getDiskUsage(targetPath) {
  const stats = fs.statfsSync(targetPath);
  const total = stats.blocks * stats.bsize;
  const free = stats.bavail * stats.bsize;
  return { total, free, used: total - free };
}

module.exports = { getDiskUsage };
