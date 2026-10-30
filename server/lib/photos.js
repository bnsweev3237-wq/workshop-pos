// Shared by items.js and materials.js — both store an optional photo the same way: a data URL
// the client has already compressed/resized (canvas, re-encoded as JPEG) before ever sending
// it, kept inline in the row itself rather than as a separate file on disk. This validation is
// a safety net against a misbehaving client or a direct API call, not the thing actually
// keeping storage small — that's the client-side compression.
const PHOTO_RE = /^data:image\/(png|jpeg|jpg|webp);base64,/i;
const MAX_PHOTO_CHARS = 700_000;

// Returns the photo string if it's valid (including '' for "no photo"), or throws with a
// message safe to send straight back to the client.
function validatePhoto(value) {
  const photo = typeof value === 'string' ? value : '';
  if (photo && (photo.length > MAX_PHOTO_CHARS || !PHOTO_RE.test(photo))) {
    throw new Error('invalid_photo');
  }
  return photo;
}

// Photos live inline in items.photo / materials.photo (data URLs), not as separate files on
// disk — so "how much space are photos using" means the stored length of those columns, not
// anything findable with `du`. LENGTH() on a TEXT column counts bytes in SQLite, which for
// these ASCII (base64) strings is the same as character count — a reasonable proxy for what
// they're actually costing in the database file, same figure a VACUUM after clearing them
// would actually reclaim. Counts both the real and test catalogs — test-side photos take up
// exactly as much real disk space as any other row.
function photoBytes(db) {
  const sum = (table) => db.prepare(`SELECT COALESCE(SUM(LENGTH(photo)), 0) AS n FROM ${table} WHERE photo IS NOT NULL AND photo != ''`).get().n;
  return sum('items') + sum('materials');
}

// Clears every photo on both items and materials (real and test), then VACUUMs so the freed
// space is actually reclaimed on disk rather than just left as free pages inside the same-size
// database file. VACUUM rewrites the whole file and can't run inside a transaction, so the two
// clears happen in their own transaction first and VACUUM runs after, standalone.
function purgeAllPhotos(db) {
  const tx = db.transaction(() => {
    db.prepare("UPDATE items SET photo = '' WHERE photo IS NOT NULL AND photo != ''").run();
    db.prepare("UPDATE materials SET photo = '' WHERE photo IS NOT NULL AND photo != ''").run();
  });
  tx();
  // The photos are gone either way once the transaction above commits. VACUUM just reclaims
  // the file space they were taking — worth trying, but if it fails (it needs roughly another
  // copy of the database's worth of free disk space to work, which may be exactly what's in
  // short supply here) that's a separate, non-fatal problem from the purge itself.
  let vacuumed = true;
  try { db.exec('VACUUM'); } catch { vacuumed = false; }
  return { vacuumed };
}

module.exports = { PHOTO_RE, MAX_PHOTO_CHARS, validatePhoto, photoBytes, purgeAllPhotos };
