// Platform staff accounts (operator/support) — control-plane only, same bcrypt-hash-and-insert
// shape as server/lib/users.js#createUserRow, just targeting platform_users instead of a
// tenant's own users table.
const bcrypt = require('bcryptjs');
const { uid } = require('./ids');

function createPlatformUserRow(controlDb, { username, password, role, createdAt = Date.now() }) {
  const row = {
    id: uid(), username,
    password_hash: bcrypt.hashSync(password, 12),
    role, created_at: createdAt,
  };
  controlDb.prepare(`
    INSERT INTO platform_users (id, username, password_hash, role, created_at)
    VALUES (@id, @username, @password_hash, @role, @created_at)
  `).run(row);
  return row;
}

module.exports = { createPlatformUserRow };
