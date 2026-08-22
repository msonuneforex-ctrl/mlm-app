// One-time cleanup: re-runs the same sanitizer over every existing user's
// name/phone in the DB, in case malicious values were stored before the
// registration/profile routes were patched.
//
// Run from backend/: node scripts/sanitize-existing-users.js

const db = require('../db');
const { sanitizeName, sanitizeText } = require('../utils/sanitize');

const users = db.prepare('SELECT id, name, phone FROM users').all();

let changed = 0;
const update = db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?');

const tx = db.transaction(() => {
  for (const u of users) {
    const cleanName = sanitizeName(u.name);
    const cleanPhone = sanitizeText(u.phone, 30);
    if (cleanName !== u.name || cleanPhone !== u.phone) {
      update.run(cleanName, cleanPhone, u.id);
      changed++;
      console.log(`Fixed user #${u.id}: "${u.name}" -> "${cleanName}"`);
    }
  }
});

tx();

console.log(`Done. ${changed} of ${users.length} user record(s) updated.`);
