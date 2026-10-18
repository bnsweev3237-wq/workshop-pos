const crypto = require('crypto');

const uid = () => crypto.randomUUID();

// 6-digit numeric item numbers, same scheme as the artifact version — random but checked
// for uniqueness against what's already in the database (a real UNIQUE constraint on
// items.item_no backs this up, so a collision fails the insert cleanly rather than silently).
function genItemNo(db) {
  const exists = db.prepare('SELECT 1 FROM items WHERE item_no = ?');
  let code;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (exists.get(code));
  return code;
}

module.exports = { uid, genItemNo };
