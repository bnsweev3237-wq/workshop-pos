// Inserts a new user row into a given tenant/install database — shared by the single-tenant
// first-run /api/auth/setup flow and multi-tenant signup provisioning, so both create a user
// exactly the same way (same bcrypt cost, same defaults) instead of two copies that could drift.
const bcrypt = require('bcryptjs');
const { uid } = require('./ids');

function createUserRow(db, { name, username, password, role = 'admin', mustChangePassword = false, createdAt = Date.now() }) {
  const row = {
    id: uid(), name: name || username, username,
    password_hash: bcrypt.hashSync(password, 12),
    role, must_change_password: mustChangePassword ? 1 : 0, created_at: createdAt,
  };
  db.prepare(`
    INSERT INTO users (id, name, username, password_hash, role, must_change_password, created_at)
    VALUES (@id, @name, @username, @password_hash, @role, @must_change_password, @created_at)
  `).run(row);
  return row;
}

module.exports = { createUserRow };
