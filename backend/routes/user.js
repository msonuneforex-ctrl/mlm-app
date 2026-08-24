const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { splitDeposit, splitWithdrawal } = require('../utils/fees');
const { isValidForNetwork } = require('../utils/address');
const { buildWalletLedger } = require('../utils/ledger');
const { sanitizeName, sanitizeText } = require('../utils/sanitize');
const { adjustInvestedCapital, getCapInfo } = require('../utils/capLimit');
const { verifyToken } = require('../utils/totp');

const router = express.Router();
router.use(authRequired);

const NETWORKS = ['BEP20'];

// ---------- HELPER: auto-inactivate if all user wallets are non-positive ----------
function markInactiveIfNegative(userId) {
  const user = db.prepare(`
    SELECT main_wallet, referral_wallet, status 
    FROM users WHERE id = ?
  `).get(userId);
  
  if (user && ((user.main_wallet || 0) <= 0 && (user.referral_wallet || 0) <= 0) && user.status !== 'blocked') {
    db.prepare(`UPDATE users SET status = 'inactive' WHERE id = ?`).run(userId);
  }
}

// ---------- DASHBOARD SUMMARY ----------
router.get('/dashboard', (req, res) => {
  const user = db.prepare(`
    SELECT id, user_code, name, email, phone, 
           COALESCE(main_wallet, 0) AS main_wallet, 
           COALESCE(referral_wallet, 0) AS referral_wallet, 
           (COALESCE(main_wallet, 0) + COALESCE(referral_wallet, 0)) AS wallet_balance, 
           status, created_at 
    FROM users WHERE id = ?
  `).get(req.user.id);

  const leftCount = db.prepare(`
    WITH RECURSIVE downline(id) AS (
      SELECT id FROM users WHERE parent_id = (SELECT id FROM users WHERE id = ?) AND position = 'L'
      UNION ALL
      SELECT u.id FROM users u JOIN downline d ON u.parent_id = d.id
    ) SELECT COUNT(*) AS cnt FROM downline
  `).get(req.user.id).cnt;

  const rightCount = db.prepare(`
    WITH RECURSIVE downline(id) AS (
      SELECT id FROM users WHERE parent_id = (SELECT id FROM users WHERE id = ?) AND position = 'R'
      UNION ALL
      SELECT u.id FROM users u JOIN downline d ON u.parent_id = d.id
    ) SELECT COUNT(*) AS cnt FROM downline
  `).get(req.user.id).cnt;

  const directReferrals = db.prepare('SELECT COUNT(*) AS cnt FROM users WHERE sponsor_id = ?').get(req.user.id).cnt;

  const totalDeposits = db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM deposits WHERE user_id = ? AND status = 'approved'`).get(req.user.id).total;
  // NOTE: withdrawals never carry a status of 'approved' — their lifecycle is
  // pending -> processing -> processed (or rejected). Summing on 'approved'
  // meant this always evaluated to 0. Match admin.js's definition of an
  // approved/paid-out withdrawal: status IN ('processing','processed').
  const totalWithdrawals = db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM withdrawals WHERE user_id = ? AND status IN ('processing','processed')`).get(req.user.id).total;
  const totalIncome = db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM income_log WHERE user_id = ?`).get(req.user.id).total;

  const cap = getCapInfo(req.user.id);

  res.json({
    user,
    stats: { leftCount, rightCount, directReferrals, totalDeposits, totalWithdrawals, totalIncome },
    cap
  });
});

// ---------- REFERRAL LINKS (left leg / right leg) ----------
router.get('/referral', (req, res) => {
  const user = db.prepare('SELECT user_code FROM users WHERE id = ?').get(req.user.id);
  res.json({
    userCode: user.user_code,
    leftPath: `register.html?sponsor=${user.user_code}&side=L`,
    rightPath: `register.html?sponsor=${user.user_code}&side=R`
  });
});

// ---------- MY BINARY TREE ----------
const cols = 'id, user_code, name, email, COALESCE(main_wallet, 0) AS main_wallet, COALESCE(referral_wallet, 0) AS referral_wallet, (COALESCE(main_wallet, 0) + COALESCE(referral_wallet, 0)) AS wallet_balance, status, created_at';

function isInOwnDownline(myId, candidateId) {
  if (Number(myId) === Number(candidateId)) return true;
  const row = db.prepare(`
    WITH RECURSIVE downline(id) AS (
      SELECT id FROM users WHERE parent_id = ?
      UNION ALL
      SELECT u.id FROM users u JOIN downline d ON u.parent_id = d.id
    ) SELECT 1 FROM downline WHERE id = ?
  `).get(myId, candidateId);
  return !!row;
}

function legCount(userId, side) {
  const row = db.prepare(`
    WITH RECURSIVE leg(id) AS (
      SELECT id FROM users WHERE parent_id = ? AND position = ?
      UNION ALL
      SELECT u.id FROM users u JOIN leg lg ON u.parent_id = lg.id
    ) SELECT COUNT(*) AS c FROM leg
  `).get(userId, side);
  return row ? row.c : 0;
}

function withLegCounts(node) {
  if (!node) return null;
  return { ...node, left_count: legCount(node.id, 'L'), right_count: legCount(node.id, 'R') };
}

function loadTreeFrom(rootId) {
  const me = db.prepare(`SELECT ${cols} FROM users WHERE id = ?`).get(rootId);
  if (!me) return null;
  const left = db.prepare(`SELECT ${cols} FROM users WHERE parent_id = ? AND position='L'`).get(rootId);
  const right = db.prepare(`SELECT ${cols} FROM users WHERE parent_id = ? AND position='R'`).get(rootId);

  const expand = (node) => {
    if (!node) return null;
    const l = db.prepare(`SELECT ${cols} FROM users WHERE parent_id = ? AND position='L'`).get(node.id);
    const r = db.prepare(`SELECT ${cols} FROM users WHERE parent_id = ? AND position='R'`).get(node.id);
    return { ...node, left: withLegCounts(l), right: withLegCounts(r) };
  };

  const parent = me.id ? db.prepare(`SELECT id, user_code, name FROM users WHERE id = (SELECT parent_id FROM users WHERE id = ?)`).get(rootId) : null;

  return { me: withLegCounts(me), parent: parent || null, left: expand(left), right: expand(right) };
}

router.get('/tree/:rootId?', (req, res) => {
  const rootId = req.params.rootId ? Number(req.params.rootId) : req.user.id;
  if (!isInOwnDownline(req.user.id, rootId)) {
    return res.status(403).json({ error: 'You can only view your own tree' });
  }
  const tree = loadTreeFrom(rootId);
  if (!tree) return res.status(404).json({ error: 'Not found' });
  res.json(tree);
});

// ---------- DEPOSIT (USDT only — BEP20 or TRC20) ----------
router.get('/deposit-address', (req, res) => {
  const network = (req.query.network || 'BEP20').toUpperCase();
  if (!NETWORKS.includes(network)) return res.status(400).json({ error: 'Unsupported network' });
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(`deposit_address_${network}`);
  res.json({ network, address: row ? row.value : null });
});

router.post('/deposit', (req, res) => {
  const { amount, network, txn_ref } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Enter a valid amount' });
  const net = (network || '').toUpperCase();
  if (!NETWORKS.includes(net)) return res.status(400).json({ error: 'Select USDT network: BEP20' });
  if (!txn_ref) return res.status(400).json({ error: 'Enter the transaction hash' });

  const split = splitDeposit(amount);

  const info = db.prepare(`
    INSERT INTO deposits (user_id, amount, net_amount, fee_amount, method, network, txn_ref, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(req.user.id, split.amount, split.net_amount, split.fee_amount, `USDT-${net}`, net, txn_ref);

  res.json({
    message: 'Deposit request submitted. Awaiting admin approval.',
    id: info.lastInsertRowid,
    breakdown: split
  });
});

router.get('/deposit/history', (req, res) => {
  const rows = db.prepare('SELECT * FROM deposits WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
  res.json(rows);
});

// ---------- WITHDRAWAL (Dual Wallet Support) ----------
// Helper: read a settings key
function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

router.post('/withdraw', (req, res) => {
  const { amount, network, walletType, totpCode } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Enter a valid amount' });
  
  const net = (network || '').toUpperCase();
  if (!NETWORKS.includes(net)) return res.status(400).json({ error: 'Select USDT network: BEP20' });

  // Google Authenticator code is mandatory for every withdrawal. This is what
  // stops anyone with account/session access (e.g. an upline/team leader who
  // isn't the account owner) from draining a member's wallet — only the
  // member's own authenticator app can produce a valid code.
  const requester = db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(req.user.id);
  if (!requester.totp_enabled) {
    return res.status(403).json({ error: 'Enable Google Authenticator 2FA on your Profile page before withdrawing.' });
  }
  if (!verifyToken(totpCode, requester.totp_secret)) {
    return res.status(400).json({ error: 'Enter a valid 6-digit Google Authenticator code' });
  }

  const selectedWallet = walletType === 'referral' ? 'referral' : 'main';

  // ---- Withdrawal day restriction (main wallet only) ----
  if (selectedWallet === 'main') {
    const dayEnabled = getSetting('withdrawal_day_enabled', 'false') === 'true';
    if (dayEnabled) {
      const allowedDays = getSetting('withdrawal_days', '1').split(',').map(Number);
      // JS getDay(): 0=Sun,1=Mon,...,6=Sat → convert to ISO: Mon=1,...,Sun=7
      const jsDay = new Date().getDay();
      const isoDay = jsDay === 0 ? 7 : jsDay;
      if (!allowedDays.includes(isoDay)) {
        const DAY_NAMES = { 1:'Monday',2:'Tuesday',3:'Wednesday',4:'Thursday',5:'Friday',6:'Saturday',7:'Sunday' };
        const allowed = allowedDays.map(d => DAY_NAMES[d] || d).join(', ');
        return res.status(400).json({ error: `Withdrawals from main wallet are only allowed on: ${allowed}` });
      }
    }
  }
  const targetCol = selectedWallet === 'referral' ? 'referral_wallet' : 'main_wallet';

  const user = db.prepare(`
    SELECT COALESCE(main_wallet, 0) AS main_wallet, 
           COALESCE(referral_wallet, 0) AS referral_wallet, 
           withdrawal_address_bep20, withdrawal_address_trc20 
    FROM users WHERE id = ?
  `).get(req.user.id);

  const savedAddress = net === 'BEP20' ? user.withdrawal_address_bep20 : user.withdrawal_address_trc20;
  
  if (!savedAddress) {
    return res.status(400).json({ error: `No ${net} withdrawal address on file. Add one on your Profile page first.` });
  }

  const availableBalance = user[targetCol];
  if (amount > availableBalance) {
    return res.status(400).json({ error: `Insufficient ${selectedWallet} wallet balance` });
  }

  // ---- Monthly 10% limit on main wallet ----
  if (selectedWallet === 'main') {
    const limitPct = parseFloat(getSetting('withdrawal_monthly_limit_pct', '10')) / 100;
    // Sum of main-wallet withdrawals already submitted this calendar month
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const monthlyUsed = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total FROM withdrawals
      WHERE user_id = ? AND wallet_type = 'main'
        AND status NOT IN ('rejected')
        AND created_at >= ?
    `).get(req.user.id, monthStart).total;

    // Monthly limit is % of current main wallet BEFORE this withdrawal
    const monthlyLimit = Math.round(availableBalance * limitPct * 100) / 100;
    const remaining = Math.round((monthlyLimit - monthlyUsed) * 100) / 100;

    if (amount > remaining) {
      return res.status(400).json({
        error: `Monthly withdrawal limit reached. You can withdraw up to ${remaining.toFixed(2)} USDT from your main wallet this month (${limitPct * 100}% of balance).`,
        monthlyLimit,
        monthlyUsed: Math.round(monthlyUsed * 100) / 100,
        remaining: Math.max(0, remaining)
      });
    }
  }

  const split = splitWithdrawal(amount);

  const tx = db.transaction(() => {
    db.prepare(`UPDATE users SET ${targetCol} = ${targetCol} - ? WHERE id = ?`).run(split.amount, req.user.id);

    markInactiveIfNegative(req.user.id);

    // Taking money out of the main wallet reduces net-invested capital, which
    // lowers the earning-cap ceiling (2x net-invested). Referral-wallet
    // withdrawals don't touch the cap — it's main-wallet-only.
    if (selectedWallet === 'main') {
      adjustInvestedCapital(req.user.id, -split.amount);
    }

    db.prepare(`
      INSERT INTO withdrawals (user_id, wallet_type, amount, net_amount, fee_amount, method, network, account_details, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(req.user.id, selectedWallet, split.amount, split.net_amount, split.fee_amount, `USDT-${net}`, net, savedAddress);
  });
  tx();

  res.json({
    message: 'Withdrawal request submitted. Awaiting admin approval.',
    breakdown: split
  });
});

router.get('/withdraw/history', (req, res) => {
  const rows = db.prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
  res.json(rows);
});

// Returns withdrawal restriction info for the current user (main wallet)
router.get('/withdraw/limits', (req, res) => {
  const user = db.prepare('SELECT COALESCE(main_wallet,0) AS main_wallet FROM users WHERE id = ?').get(req.user.id);
  const dayEnabled = getSetting('withdrawal_day_enabled', 'false') === 'true';
  const allowedDays = getSetting('withdrawal_days', '1').split(',').map(Number);
  const limitPct = parseFloat(getSetting('withdrawal_monthly_limit_pct', '10')) / 100;
  const DAY_NAMES = { 1:'Monday',2:'Tuesday',3:'Wednesday',4:'Thursday',5:'Friday',6:'Saturday',7:'Sunday' };

  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const monthlyUsed = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total FROM withdrawals
    WHERE user_id = ? AND wallet_type = 'main' AND status NOT IN ('rejected') AND created_at >= ?
  `).get(req.user.id, monthStart).total;

  const monthlyLimit = Math.round(user.main_wallet * limitPct * 100) / 100;
  const remaining = Math.max(0, Math.round((monthlyLimit - monthlyUsed) * 100) / 100);

  const jsDay = now.getDay();
  const isoDay = jsDay === 0 ? 7 : jsDay;
  const todayAllowed = !dayEnabled || allowedDays.includes(isoDay);

  res.json({
    dayEnabled,
    allowedDays,
    allowedDayNames: allowedDays.map(d => DAY_NAMES[d] || d),
    todayAllowed,
    limitPct: limitPct * 100,
    monthlyLimit,
    monthlyUsed: Math.round(monthlyUsed * 100) / 100,
    remaining
  });
});

// ---------- DIRECT TEAM ----------
router.get('/direct-team', (req, res) => {
  const rows = db.prepare(`
    SELECT id, user_code, name, email, phone, position, 
           COALESCE(main_wallet, 0) AS main_wallet, 
           COALESCE(referral_wallet, 0) AS referral_wallet, 
           (COALESCE(main_wallet, 0) + COALESCE(referral_wallet, 0)) AS wallet_balance, 
           status, created_at
    FROM users WHERE sponsor_id = ? ORDER BY id DESC
  `).all(req.user.id);
  res.json(rows);
});

// ---------- PROFILE ----------
router.get('/profile', (req, res) => {
  const user = db.prepare(`
    SELECT id, user_code, name, email, phone, 
           COALESCE(main_wallet, 0) AS main_wallet, 
           COALESCE(referral_wallet, 0) AS referral_wallet, 
           (COALESCE(main_wallet, 0) + COALESCE(referral_wallet, 0)) AS wallet_balance, 
           created_at, withdrawal_address_bep20, withdrawal_address_trc20
    FROM users WHERE id = ?
  `).get(req.user.id);
  res.json(user);
});

router.put('/profile', (req, res) => {
  const name = sanitizeName(req.body.name);
  if (!name) return res.status(400).json({ error: 'Name is required' });
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
  res.json({ message: 'Profile updated successfully' });
});

router.put('/profile/withdrawal-address', (req, res) => {
  const { network, address, password, totpCode } = req.body;
  const net = (network || '').toUpperCase();
  if (!NETWORKS.includes(net)) return res.status(400).json({ error: 'Network must be BEP20' });
  if (!isValidForNetwork(net, address)) {
    return res.status(400).json({ error: `That doesn't look like a valid USDT ${net} address` });
  }
  if (!password) return res.status(400).json({ error: 'Enter your password to confirm this change' });

  const user = db.prepare('SELECT password, totp_secret, totp_enabled FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  // Google Authenticator code required to change the payout address too — this is
  // the step that specifically closes the "someone else redirects my payout
  // address, then withdraws" attack, since both actions need the owner's own code.
  if (!user.totp_enabled) {
    return res.status(403).json({ error: 'Enable Google Authenticator 2FA on your Profile page before changing your withdrawal address.' });
  }
  if (!verifyToken(totpCode, user.totp_secret)) {
    return res.status(400).json({ error: 'Enter a valid 6-digit Google Authenticator code' });
  }

  const column = net === 'BEP20' ? 'withdrawal_address_bep20' : 'withdrawal_address_trc20';
  db.prepare(`UPDATE users SET ${column} = ? WHERE id = ?`).run(address.trim(), req.user.id);
  res.json({ message: `${net} withdrawal address saved` });
});

// ---------- 2FA STATUS (for Profile page to know whether to show setup or not) ----------
router.get('/2fa/status', (req, res) => {
  const user = db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(req.user.id);
  res.json({ enabled: !!(user && user.totp_enabled) });
});

// ---------- INCOME HISTORY ----------
router.get('/income/history', (req, res) => {
  const rows = db.prepare('SELECT * FROM income_log WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
  res.json(rows);
});

// ---------- WALLET TRANSACTION HISTORY ----------
router.get('/wallet/history', (req, res) => {
  res.json(buildWalletLedger(req.user.id));
});

// ---------- SUPPORT TICKETS ----------
router.get('/support', (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id = t.id) AS message_count
    FROM support_tickets t WHERE t.user_id = ? ORDER BY t.id DESC
  `).all(req.user.id);
  res.json(rows);
});

// Ticket type → priority mapping (lower = more urgent)
const TICKET_TYPES = {
  access_issue:       { label: 'Account Blocked / Access Issue', priority: 1 },
  withdrawal_problem: { label: 'Withdrawal Problem',             priority: 2 },
  deposit_issue:      { label: 'Deposit Issue',                  priority: 3 },
  kyc_verification:   { label: 'KYC / Verification',            priority: 4 },
  email_profile:      { label: 'Email / Profile Change',         priority: 5 },
  level_income:       { label: 'Level Income Query',             priority: 6 },
  general_query:      { label: 'General Query',                  priority: 7 },
};

router.post('/support', (req, res) => {
  const { subject, message, ticket_type } = req.body;
  if (!subject || !message) return res.status(400).json({ error: 'Subject and message are required' });

  const type = TICKET_TYPES[ticket_type] ? ticket_type : 'general_query';
  const priority = TICKET_TYPES[type].priority;

  const ticketNo = db.generateTicketNo();
  const tx = db.transaction(() => {
    const info = db.prepare(`INSERT INTO support_tickets (ticket_no, user_id, subject, status, ticket_type, priority) VALUES (?, ?, ?, 'open', ?, ?)`)
      .run(ticketNo, req.user.id, subject.trim(), type, priority);
    db.prepare(`INSERT INTO support_messages (ticket_id, sender_role, sender_id, message) VALUES (?, 'user', ?, ?)`)
      .run(info.lastInsertRowid, req.user.id, message.trim());
    return info.lastInsertRowid;
  });
  const ticketId = tx();

  res.json({ message: 'Support ticket submitted', id: ticketId, ticketNo });
});

router.get('/support/:id', (req, res) => {
  const ticket = db.prepare(`SELECT * FROM support_tickets WHERE id = ? AND user_id = ?`).get(req.params.id, req.user.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const messages = db.prepare(`SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY id ASC`).all(ticket.id);
  res.json({ ticket, messages });
});

router.post('/support/:id/reply', (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message is required' });

  const ticket = db.prepare(`SELECT * FROM support_tickets WHERE id = ? AND user_id = ?`).get(req.params.id, req.user.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (ticket.status === 'closed') return res.status(400).json({ error: 'This ticket is closed. Please open a new ticket.' });

  db.prepare(`INSERT INTO support_messages (ticket_id, sender_role, sender_id, message) VALUES (?, 'user', ?, ?)`)
    .run(ticket.id, req.user.id, message.trim());
  db.prepare(`UPDATE support_tickets SET updated_at = datetime('now') WHERE id = ?`).run(ticket.id);

  res.json({ message: 'Reply sent' });
});

// ---------- LEVEL INCOME UNLOCK ----------

const LEVEL_UNLOCK_PRICE = 20; // USDT per level, no fee
const TOTAL_LEVELS = 25;

// GET /user/level-status — returns all 25 levels with unlocked flag and business depth
router.get('/level-status', (req, res) => {
  // How many distinct "levels" does this user's downline business reach?
  // We walk the sponsor chain downwards to count depth.
  // For level income, "level N business" means there's at least one person
  // at depth N in the user's referral chain.
  const businessDepth = db.prepare(`
    WITH RECURSIVE chain(id, depth) AS (
      SELECT id, 1 FROM users WHERE sponsor_id = ?
      UNION ALL
      SELECT u.id, c.depth + 1 FROM users u JOIN chain c ON u.sponsor_id = c.id
      WHERE c.depth < 25
    )
    SELECT COALESCE(MAX(depth), 0) AS depth FROM chain
  `).get(req.user.id).depth;

  const unlockedRows = db.prepare(
    `SELECT level FROM level_unlocks WHERE user_id = ? ORDER BY level ASC`
  ).all(req.user.id);
  const unlockedSet = new Set(unlockedRows.map(r => r.level));

  const levels = [];
  for (let i = 1; i <= TOTAL_LEVELS; i++) {
    const unlocked = unlockedSet.has(i);
    const hasBusiness = i <= businessDepth;
    // Next unlockable = the first locked level (sequential only)
    const nextToUnlock = !unlockedSet.has(i) && (i === 1 || unlockedSet.has(i - 1));
    levels.push({ level: i, unlocked, hasBusiness, nextToUnlock });
  }

  const user = db.prepare(
    `SELECT COALESCE(main_wallet,0) AS main_wallet FROM users WHERE id = ?`
  ).get(req.user.id);

  res.json({ levels, businessDepth, unlockedCount: unlockedSet.size, walletBalance: user.main_wallet, pricePerLevel: LEVEL_UNLOCK_PRICE });
});

// POST /user/level-unlock/wallet — pay from main_wallet
router.post('/level-unlock/wallet', (req, res) => {
  const userId = req.user.id;

  const tx = db.transaction(() => {
    // Find the next locked level
    const unlocked = db.prepare(
      `SELECT level FROM level_unlocks WHERE user_id = ? ORDER BY level ASC`
    ).all(userId).map(r => r.level);
    const unlockedSet = new Set(unlocked);

    let nextLevel = null;
    for (let i = 1; i <= TOTAL_LEVELS; i++) {
      if (!unlockedSet.has(i)) { nextLevel = i; break; }
    }
    if (!nextLevel) throw new Error('All 25 levels are already unlocked.');

    // Enforce sequential: can only unlock if previous level is unlocked (or it's level 1)
    if (nextLevel > 1 && !unlockedSet.has(nextLevel - 1)) {
      throw new Error(`You must unlock Level ${nextLevel - 1} first.`);
    }

    // Check wallet balance
    const user = db.prepare(
      `SELECT COALESCE(main_wallet,0) AS main_wallet FROM users WHERE id = ?`
    ).get(userId);
    if (user.main_wallet < LEVEL_UNLOCK_PRICE) {
      throw new Error(`Insufficient main wallet balance. You need ${LEVEL_UNLOCK_PRICE} USDT.`);
    }

    // Deduct from wallet
    db.prepare(`UPDATE users SET main_wallet = round(main_wallet - ?, 2) WHERE id = ?`)
      .run(LEVEL_UNLOCK_PRICE, userId);

    // Level topups spent from main wallet reduce net-invested capital, which
    // lowers the earning-cap ceiling (2x net-invested) — e.g. deposit 1000,
    // spend 100 on a level topup -> ceiling becomes 2 x 900 = 1800, not 2000.
    adjustInvestedCapital(userId, -LEVEL_UNLOCK_PRICE);

    db.prepare(`UPDATE users SET wallet_balance = round(main_wallet + referral_wallet, 2) WHERE id = ?`)
      .run(userId);

    // Log the deduction
    db.prepare(`INSERT INTO income_log (user_id, type, amount, note) VALUES (?, 'level_unlock', ?, ?)`)
      .run(userId, -LEVEL_UNLOCK_PRICE, `Level ${nextLevel} unlock payment (wallet)`);

    // Credit admin_level_wallet (separate from wallet_income / wallet_balance)
    const adminUser = db.prepare(`SELECT id FROM users WHERE role='admin' ORDER BY id ASC LIMIT 1`).get();
    if (adminUser) {
      db.prepare(`UPDATE users SET admin_level_wallet = round(COALESCE(admin_level_wallet,0) + ?, 2) WHERE id = ?`)
        .run(LEVEL_UNLOCK_PRICE, adminUser.id);
      db.prepare(`INSERT INTO income_log (user_id, type, amount, note) VALUES (?, 'level_wallet_income', ?, ?)`)
        .run(adminUser.id, LEVEL_UNLOCK_PRICE, `Level ${nextLevel} unlock fee from user #${userId} (wallet payment)`);
    }

    // Record unlock
    db.prepare(
      `INSERT INTO level_unlocks (user_id, level, unlocked_via) VALUES (?, ?, 'wallet')`
    ).run(userId, nextLevel);

    markInactiveIfNegative(userId);

    return nextLevel;
  });

  try {
    const level = tx();
    res.json({ message: `Level ${level} unlocked successfully via wallet!`, level });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


// ---------- NOTIFICATIONS ----------
// Returns notifications visible to this user: broadcasts (audience='all')
// plus anything targeted directly at them, newest first, with each row's
// read state for this user.
router.get('/notifications', (req, res) => {
  const rows = db.prepare(`
    SELECT n.id, n.title, n.message, n.audience, n.created_at,
      CASE WHEN r.id IS NULL THEN 0 ELSE 1 END AS is_read
    FROM notifications n
    LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = ?
    WHERE n.audience = 'all' OR n.user_id = ?
    ORDER BY n.id DESC
    LIMIT 50
  `).all(req.user.id, req.user.id);

  const unreadCount = rows.filter(r => !r.is_read).length;
  res.json({ notifications: rows, unreadCount });
});

router.put('/notifications/:id/read', (req, res) => {
  const notif = db.prepare(
    `SELECT * FROM notifications WHERE id = ? AND (audience = 'all' OR user_id = ?)`
  ).get(req.params.id, req.user.id);
  if (!notif) return res.status(404).json({ error: 'Notification not found' });

  db.prepare(
    `INSERT OR IGNORE INTO notification_reads (notification_id, user_id) VALUES (?, ?)`
  ).run(notif.id, req.user.id);

  res.json({ message: 'Marked as read' });
});

router.put('/notifications/read-all', (req, res) => {
  const rows = db.prepare(
    `SELECT id FROM notifications WHERE audience = 'all' OR user_id = ?`
  ).all(req.user.id);

  const insert = db.prepare(`INSERT OR IGNORE INTO notification_reads (notification_id, user_id) VALUES (?, ?)`);
  const tx = db.transaction(() => {
    for (const n of rows) insert.run(n.id, req.user.id);
  });
  tx();

  res.json({ message: 'All notifications marked as read' });
});

module.exports = router;