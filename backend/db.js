const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config();

// DB_PATH lets you point the database file at a mounted persistent volume
// (e.g. Railway Volume mounted at /data) instead of the app's own folder,
// which is wiped on every redeploy. Defaults to the old in-repo location
// so local/dev usage is unchanged.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'mlm.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

// ---------- SCHEMA ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_code TEXT UNIQUE,                 -- public-facing ID, e.g. BAV01
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  password TEXT NOT NULL,
  role TEXT DEFAULT 'user',              -- 'user' | 'admin'
  sponsor_id INTEGER,                    -- who referred this user
  parent_id INTEGER,                     -- placement parent in the binary tree
  position TEXT,                         -- 'L' or 'R' under parent_id
  wallet_balance REAL DEFAULT 0,
  main_wallet REAL DEFAULT 0,            -- Main wallet balance
  referral_wallet REAL DEFAULT 0,        -- Referral wallet balance
  status TEXT DEFAULT 'active',          -- active | inactive | blocked
  net_invested_capital REAL DEFAULT 0,   -- deposits credited to main wallet, minus level-topups paid from
                                          -- main wallet and main-wallet withdrawals. Drives the earning cap below.
  cap_ceiling REAL DEFAULT 0,            -- 2 x net_invested_capital — max main-wallet INCOME (not principal) this user can earn right now
  cap_used REAL DEFAULT 0,               -- cumulative main-wallet income (level income + profit adjustments) credited so far
  is_capped INTEGER DEFAULT 0,           -- 1 once cap_used has reached cap_ceiling — flagged in UI, more income withheld until user deposits again
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (sponsor_id) REFERENCES users(id),
  FOREIGN KEY (parent_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount REAL NOT NULL,                  -- total amount paid by the user
  net_amount REAL DEFAULT 0,             -- amount actually credited to user's wallet (amount - fee)
  fee_amount REAL DEFAULT 0,             -- 5% platform fee routed to the admin wallet
  method TEXT,
  txn_ref TEXT,
  status TEXT DEFAULT 'pending',         -- pending | approved | rejected
  remarks TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount REAL NOT NULL,                  -- gross amount deducted from user's wallet
  net_amount REAL DEFAULT 0,             -- amount actually payable/paid out to the user (amount - fee)
  fee_amount REAL DEFAULT 0,             -- 5% platform fee routed to the admin wallet
  wallet_type TEXT DEFAULT 'main',        -- 'main' | 'referral'
  method TEXT,
  account_details TEXT,
  status TEXT DEFAULT 'pending',         -- pending | approved | rejected
  remarks TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS income_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,                    -- 'direct' | 'binary' | 'level' | 'platform_fee' | 'admin_withdrawal' etc
  amount REAL NOT NULL,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- key/value store for admin-configured settings, e.g. the platform's receiving
-- USDT addresses that are shown to users on the Deposit page.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Support tickets, identified to both the user and admin by a short token
-- number (e.g. TCK1001) rather than the raw internal id.
CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_no TEXT UNIQUE,
  user_id INTEGER NOT NULL,
  subject TEXT NOT NULL,
  status TEXT DEFAULT 'open',            -- open | in_progress | closed
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Every message in a ticket thread, from either the user or an admin.
CREATE TABLE IF NOT EXISTS support_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  sender_role TEXT NOT NULL,             -- 'user' | 'admin'
  sender_id INTEGER,
  message TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (ticket_id) REFERENCES support_tickets(id)
);

-- Tracks which income levels (1-25) a user has unlocked.
-- A row here means the level is unlocked; absence = locked.
-- Levels must be unlocked sequentially (can't unlock L3 without L2).
CREATE TABLE IF NOT EXISTS level_unlocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  level INTEGER NOT NULL,               -- 1 to 25
  unlocked_via TEXT NOT NULL,           -- 'wallet' | 'deposit'
  deposit_id INTEGER,                   -- ref to level_unlock_deposits if unlocked via on-chain
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE(user_id, level)
);

-- On-chain deposit requests specifically for level unlocks (no 5% fee).
CREATE TABLE IF NOT EXISTS level_unlock_deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  level INTEGER NOT NULL,               -- which level this deposit is for
  amount REAL NOT NULL,                 -- always 20 USDT
  method TEXT,                          -- e.g. 'USDT-BEP20'
  network TEXT,
  txn_ref TEXT,
  status TEXT DEFAULT 'pending',        -- pending | approved | rejected
  remarks TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`);

// Separate exec call for the notifications feature (kept apart from the main
// schema block above so it's easy to find/extend).
db.exec(`
-- Admin-authored notifications. audience = 'all' broadcasts to every member;
-- audience = 'user' targets a single member via user_id.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'all',  -- 'all' | 'user'
  user_id INTEGER,                       -- set only when audience = 'user'
  created_by INTEGER,                    -- admin user id who sent it
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Per-user read state. A row here means that user has read that notification.
-- No row = unread. Works for both broadcast ('all') and targeted notifications.
CREATE TABLE IF NOT EXISTS notification_reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  read_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (notification_id) REFERENCES notifications(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE(notification_id, user_id)
);
`);

// ---------- MIGRATIONS (safe to re-run; ignores "duplicate column" errors) ----------
// Lets an already-existing mlm.db (created before these columns existed) pick them up.
const migrations = [
  `ALTER TABLE users ADD COLUMN user_code TEXT`,
  `ALTER TABLE deposits ADD COLUMN net_amount REAL DEFAULT 0`,
  `ALTER TABLE deposits ADD COLUMN fee_amount REAL DEFAULT 0`,
  `ALTER TABLE withdrawals ADD COLUMN net_amount REAL DEFAULT 0`,
  `ALTER TABLE withdrawals ADD COLUMN fee_amount REAL DEFAULT 0`,
  // USDT payout addresses saved on the user's profile. Withdrawals can only be paid to these.
  `ALTER TABLE users ADD COLUMN withdrawal_address_bep20 TEXT`,
  `ALTER TABLE users ADD COLUMN withdrawal_address_trc20 TEXT`,
  // which network (BEP20 / TRC20) a deposit or withdrawal moved on
  `ALTER TABLE deposits ADD COLUMN network TEXT`,
  `ALTER TABLE withdrawals ADD COLUMN network TEXT`,
  // Marks the single default member account that anchors the top of the binary
  // tree (BAV01). The admin account is entirely separate from the tree/numbering.
  `ALTER TABLE users ADD COLUMN is_root INTEGER DEFAULT 0`,
  // Dual Wallet Support migrations
  `ALTER TABLE users ADD COLUMN main_wallet REAL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN referral_wallet REAL DEFAULT 0`,
  `ALTER TABLE withdrawals ADD COLUMN wallet_type TEXT DEFAULT 'main'`,
  // Support ticket type and priority for triage
  `ALTER TABLE support_tickets ADD COLUMN ticket_type TEXT DEFAULT 'general_query'`,
  `ALTER TABLE support_tickets ADD COLUMN priority INTEGER DEFAULT 7`,
  // Deposit-linked earning cap (see utils/capLimit.js)
  `ALTER TABLE users ADD COLUMN net_invested_capital REAL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN cap_ceiling REAL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN cap_used REAL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN is_capped INTEGER DEFAULT 0`,
  // Google Authenticator (TOTP) 2FA. secret is set as soon as a QR is generated;
  // enabled only flips to 1 once the user proves they scanned it correctly.
  `ALTER TABLE users ADD COLUMN totp_secret TEXT`,
  `ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0`
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (e) { /* column already exists - fine */ }
}

// Seed default withdrawal settings (only if not already set)
const upsertSettingDefault = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`);
upsertSettingDefault.run('withdrawal_day_enabled', 'false');   // false=24x7; true=restrict to specific days
upsertSettingDefault.run('withdrawal_days', '1');               // ISO weekday(s): 1=Mon,...,7=Sun (comma-separated)
upsertSettingDefault.run('withdrawal_monthly_limit_pct', '10'); // % of main wallet per calendar month

// Admin-panel IP allowlist (up to 5 slots). Only requests from these IPs may reach
// /api/admin/* or any beeadmin-*.html page. Defaults to the requester's own known IP
// so this ships pre-configured instead of open to everyone on first deploy.
upsertSettingDefault.run('admin_allowed_ip_1', '103.123.79.96');
upsertSettingDefault.run('admin_allowed_ip_2', '');
upsertSettingDefault.run('admin_allowed_ip_3', '');
upsertSettingDefault.run('admin_allowed_ip_4', '');
upsertSettingDefault.run('admin_allowed_ip_5', '');
// When 'false' (default), the IP allowlist above is enforced. Kept as an emergency
// admin-only kill switch — never exposed to memberside code — in case an admin's IP
// changes and everyone gets locked out; another logged-in-from-an-allowed-IP admin,
// or direct DB access, can flip this back on.
upsertSettingDefault.run('admin_ip_restriction_enabled', 'true');
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_user_code ON users(user_code)'); } catch (e) {}

// The admin account is a pure back-office login + platform fee wallet — it is NOT
// part of the BAV member numbering or the binary tree. Any admin row left over from
// before this separation gets its user_code cleared so it stops occupying BAV01.
try { db.exec(`UPDATE users SET user_code = NULL WHERE role = 'admin' AND user_code IS NOT NULL`); } catch (e) {}

// ---------- thin compatibility helper ----------
// node:sqlite doesn't ship a transaction() helper like better-sqlite3 did,
// so we add a small wrapper with the same call signature used elsewhere
// in this project: db.transaction(fn) returns a function you call to run
// fn inside a BEGIN/COMMIT block (rolls back automatically on error).
db.transaction = function (fn) {
  return function (...args) {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
};

// ---------- USER ID GENERATOR (BAV01, BAV02, ... BAV520 ...) ----------
// Sequential, based on how many *member* user_codes already exist (the admin
// account never holds a user_code, so it never consumes a slot in this series).
// Wrapped in a small retry loop in case of a race on the unique index.
function generateUserCode() {
  const count = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'user' AND user_code IS NOT NULL`).get().c;
  let n = count + 1;
  let code = 'BAV' + String(n).padStart(2, '0');
  while (db.prepare('SELECT id FROM users WHERE user_code = ?').get(code)) {
    n += 1;
    code = 'BAV' + String(n).padStart(2, '0');
  }
  return code;
}

// ---------- SEED ADMIN (back-office only, no user_code, not part of the tree) ----------
// The admin account doubles as the platform's ADMIN WALLET: every 5% deposit/withdrawal
// fee, and every referral bonus paid out of the admin wallet, moves through admin.wallet_balance.
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const INSECURE_DEFAULTS = ['admin@example.com', 'Admin@123', 'bav01@example.com', 'Root@123'];

// In production, refuse to boot on default/example secrets — these are printed
// in this project's own README/.env.example, so anyone who has seen this
// codebase can log in as admin on a deployment that didn't override them.
function requireStrongProductionSecrets() {
  if (!IS_PRODUCTION) return;
  const problems = [];
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    problems.push('JWT_SECRET must be set to a random string of at least 32 characters.');
  }
  for (const key of ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'ROOT_EMAIL', 'ROOT_PASSWORD']) {
    if (!process.env[key]) problems.push(`${key} must be set (no default allowed in production).`);
    else if (INSECURE_DEFAULTS.includes(process.env[key])) problems.push(`${key} is still set to the example/demo value — change it.`);
  }
  if (problems.length) {
    console.error('\nRefusing to start in production with insecure configuration:\n - ' + problems.join('\n - ') + '\n');
    process.exit(1);
  }
}
requireStrongProductionSecrets();

const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@123';

const existingAdmin = db.prepare('SELECT * FROM users WHERE email = ?').get(adminEmail);
if (!existingAdmin) {
  const hashed = bcrypt.hashSync(adminPassword, 10);
  db.prepare(`
    INSERT INTO users (user_code, name, email, phone, password, role, sponsor_id, parent_id, position, wallet_balance, main_wallet, referral_wallet, status)
    VALUES (NULL, ?, ?, ?, ?, 'admin', NULL, NULL, NULL, 0, 0, 0, 'active')
  `).run('Administrator', adminEmail, '0000000000', hashed);
  console.log(`Seeded admin account -> email: ${adminEmail} password: ${adminPassword}`);
}

// ---------- SEED DEFAULT ROOT MEMBER (BAV01) ----------
// The hierarchy itself starts at a dedicated default member, BAV01 - completely
// separate from the admin login. New registrations are placed under BAV01 (or
// anyone already in its downline), so BAV01 is the true root of the binary tree.
const rootEmail = process.env.ROOT_EMAIL || 'bav01@example.com';
const rootPassword = process.env.ROOT_PASSWORD || 'Root@123';

const existingRoot = db.prepare(`SELECT * FROM users WHERE is_root = 1`).get();
if (!existingRoot) {
  const codeTaken = db.prepare(`SELECT id FROM users WHERE user_code = 'BAV01'`).get();
  const rootCode = codeTaken ? generateUserCode() : 'BAV01';
  const hashed = bcrypt.hashSync(rootPassword, 10);
  db.prepare(`
    INSERT INTO users (user_code, name, email, phone, password, role, sponsor_id, parent_id, position, wallet_balance, main_wallet, referral_wallet, status, is_root)
    VALUES (?, ?, ?, ?, ?, 'user', NULL, NULL, NULL, 0, 0, 0, 'inactive', 1)
  `).run(rootCode, 'BAV01', rootEmail, '0000000000', hashed);
  console.log(`Seeded default root member ${rootCode} -> email: ${rootEmail} password: ${rootPassword}`);
}

// Backfill user_code for any legacy MEMBER rows that predate this column (existing installs).
// The admin role is intentionally excluded — it never gets a user_code.
const missingCode = db.prepare(`SELECT id FROM users WHERE role = 'user' AND (user_code IS NULL OR user_code = '') ORDER BY id ASC`).all();
for (const row of missingCode) {
  db.prepare('UPDATE users SET user_code = ? WHERE id = ?').run(generateUserCode(), row.id);
}

// ---------- SUPPORT TICKET TOKEN GENERATOR (TCK1001, TCK1002, ...) ----------
// Sequential, human-readable "token number" members and admin both reference
// a ticket by. Wrapped in a retry loop in case of a race on the unique index.
function generateTicketNo() {
  const count = db.prepare(`SELECT COUNT(*) AS c FROM support_tickets`).get().c;
  let n = 1001 + count;
  let code = 'TCK' + n;
  while (db.prepare('SELECT id FROM support_tickets WHERE ticket_no = ?').get(code)) {
    n += 1;
    code = 'TCK' + n;
  }
  return code;
}

db.generateUserCode = generateUserCode;
db.generateTicketNo = generateTicketNo;
module.exports = db;
// Migration: Admin Level Wallet (separate from wallet_balance)
// Tracks all funds received when users pay to unlock levels (via wallet or deposit)
const levelWalletMigrations = [
  `ALTER TABLE users ADD COLUMN admin_level_wallet REAL DEFAULT 0`,
];
for (const sql of levelWalletMigrations) {
  try { db.exec(sql); } catch (e) { if (!e.message.includes('duplicate column')) throw e; }
}
