// Creates 5 demo users under the default root member (BAV01), all with password
// "123456", arranged into a small binary tree so you have something to click
// around in (Genealogy, Direct Team, Deposit/Withdraw approvals, referral bonus, etc.)
//
// Usage:
//   cd backend
//   npm install        (only needed once)
//   node seed-demo.js
//
// Safe to re-run: it skips any demo email that already exists.

const bcrypt = require('bcryptjs');
const db = require('./db');
const { findOpenSlot } = require('./utils/placement');

const DEMO_PASSWORD = '123456';

// name, email, sponsorEmail (null = sponsored by the default root member BAV01), preferredSide
const DEMO_USERS = [
  { name: 'Aarav Sharma',  email: 'aarav@beeaiverse.demo',  sponsorEmail: null,               side: 'L' },
  { name: 'Diya Patel',    email: 'diya@beeaiverse.demo',   sponsorEmail: null,               side: 'R' },
  { name: 'Kabir Singh',   email: 'kabir@beeaiverse.demo',  sponsorEmail: 'aarav@beeaiverse.demo', side: 'L' },
  { name: 'Meera Nair',    email: 'meera@beeaiverse.demo',  sponsorEmail: 'aarav@beeaiverse.demo', side: 'R' },
  { name: 'Rohan Gupta',   email: 'rohan@beeaiverse.demo',  sponsorEmail: 'diya@beeaiverse.demo',  side: 'L' },
];

const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
const admin = db.prepare('SELECT * FROM users WHERE email = ?').get(adminEmail);
if (!admin) {
  console.error('Admin account not found - start the server once first so db.js can seed it.');
  process.exit(1);
}

const root = db.prepare(`SELECT * FROM users WHERE is_root = 1`).get();
if (!root) {
  console.error('Default root member (BAV01) not found - start the server once first so db.js can seed it.');
  process.exit(1);
}

const created = [];

for (const u of DEMO_USERS) {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(u.email);
  if (existing) {
    const row = db.prepare('SELECT user_code, email, name FROM users WHERE id = ?').get(existing.id);
    created.push({ ...row, password: DEMO_PASSWORD, skipped: true });
    continue;
  }

  const sponsor = u.sponsorEmail
    ? db.prepare('SELECT * FROM users WHERE email = ?').get(u.sponsorEmail)
    : root;

  if (!sponsor) {
    console.error(`Sponsor ${u.sponsorEmail} not found yet - check DEMO_USERS ordering.`);
    process.exit(1);
  }

  const slot = findOpenSlot(sponsor.id, u.side);
  const hashed = bcrypt.hashSync(DEMO_PASSWORD, 10);
  const userCode = db.generateUserCode();

  const info = db.prepare(`
    INSERT INTO users (user_code, name, email, phone, password, role, sponsor_id, parent_id, position, wallet_balance, status)
    VALUES (?, ?, ?, ?, ?, 'user', ?, ?, ?, 0, 'active')
  `).run(userCode, u.name, u.email, '9999999999', hashed, sponsor.id, slot.parent_id, slot.position);

  created.push({
    user_code: userCode,
    name: u.name,
    email: u.email,
    password: DEMO_PASSWORD,
    sponsor_code: sponsor.user_code,
    position: slot.position,
    id: info.lastInsertRowid
  });
}

console.log('\nDemo users ready:\n');
console.table(created.map(c => ({
  ID: c.user_code,
  Name: c.name,
  Email: c.email,
  Password: c.password,
  Sponsor: c.sponsor_code || '-',
  Leg: c.position || '-'
})));

// Also write a copy-paste-friendly markdown file next to this script.
const fs = require('fs');
const path = require('path');
const lines = [
  '# Bee AI Verse - Demo Login Credentials',
  '',
  `Admin login: ${adminEmail} / ${process.env.ADMIN_PASSWORD || 'Admin@123'}`,
  '',
  '| Bee AI Verse ID | Name | Email | Password | Sponsor ID | Leg |',
  '|---|---|---|---|---|---|',
  ...created.map(c => `| ${c.user_code} | ${c.name} | ${c.email} | ${c.password} | ${c.sponsor_code || '-'} | ${c.position || '-'} |`)
];
const outPath = path.join(__dirname, 'demo-credentials.md');
fs.writeFileSync(outPath, lines.join('\n') + '\n');
console.log(`\nWritten to ${outPath}\n`);
