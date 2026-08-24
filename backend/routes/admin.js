const express = require('express');
const db = require('../db');
const { authRequired, adminRequired } = require('../middleware/auth');
const { round2 } = require('../utils/fees');
const { isValidForNetwork } = require('../utils/address');
const { buildWalletLedger } = require('../utils/ledger');
const { distributeLevelIncome } = require('../utils/levelIncome');
const { adjustInvestedCapital, creditCappedIncome, getCapInfo } = require('../utils/capLimit');
const { getAllowedIps, setAllowedIps, isRestrictionEnabled, setRestrictionEnabled, adminIpRestrict, getClientIp } = require('../utils/adminIp');
const { verifyToken } = require('../utils/totp');

const router = express.Router();
router.use(authRequired, adminRequired, adminIpRestrict);

// ---------- ADMIN SECURITY: IP ALLOWLIST + 2FA ----------
// Powers beeadmin-security.html. Lets an already-logged-in (and already IP-allowed,
// since this router runs adminIpRestrict above) admin manage the allowlist itself.
router.get('/security/ip-whitelist', (req, res) => {
  const slots = getAllowedIps();
  while (slots.length < 5) slots.push('');
  res.json({ ips: slots, restrictionEnabled: isRestrictionEnabled(), yourIp: getClientIp(req) });
});

router.put('/security/ip-whitelist', (req, res) => {
  const { ips, restrictionEnabled } = req.body;
  if (!Array.isArray(ips) || ips.length > 5) {
    return res.status(400).json({ error: 'Provide up to 5 IP addresses' });
  }
  const IP_RE = /^[0-9a-fA-F:.]{2,45}$/; // permissive IPv4/IPv6 sanity check
  for (const ip of ips) {
    if (ip && !IP_RE.test(ip.trim())) {
      return res.status(400).json({ error: `"${ip}" doesn't look like a valid IP address` });
    }
  }
  const saved = setAllowedIps(ips);
  if (typeof restrictionEnabled === 'boolean') setRestrictionEnabled(restrictionEnabled);
  res.json({ message: 'IP allowlist updated', ips: saved, restrictionEnabled: isRestrictionEnabled() });
});

const NETWORKS = ['BEP20', 'TRC20'];
const REFERRAL_RATE = 0.05; // 5% of net deposit to sponsor

// ---------- HELPERS ----------

/**
 * Checks and automatically deactivates a user if their wallet balance falls to 0 or below.
 * Preserves 'blocked' status if user is blocked by admin.
 */
function markInactiveIfLowBalance(userId) {
  const user = db.prepare('SELECT wallet_balance, main_wallet, referral_wallet, status, role FROM users WHERE id = ?').get(userId);
  if (user && user.role === 'user' && (user.wallet_balance <= 0 && user.main_wallet <= 0 && user.referral_wallet <= 0) && user.status !== 'blocked') {
    db.prepare(`UPDATE users SET status = 'inactive' WHERE id = ?`).run(userId);
  }
}

function getAdminUser() {
  return db.prepare(`SELECT * FROM users WHERE role='admin' ORDER BY id ASC LIMIT 1`).get();
}

/**
 * Calculates downline node count and net business volume for a specific leg (L or R).
 */
function legBusiness(userId, side) {
  const child = db.prepare(`SELECT id FROM users WHERE parent_id = ? AND position = ?`).get(userId, side);
  if (!child) return { count: 0, business: 0 };

  const row = db.prepare(`
    WITH RECURSIVE downline(id) AS (
      SELECT id FROM users WHERE id = ?
      UNION ALL
      SELECT u.id FROM users u JOIN downline d ON u.parent_id = d.id
    )
    SELECT 
      COUNT(*) AS count, 
      COALESCE(
        (SELECT SUM(COALESCE(net_amount, round(amount / 1.05, 2))) 
         FROM deposits 
         WHERE status='approved' AND user_id IN (SELECT id FROM downline)), 
      0) AS business
    FROM downline
  `).get(child.id);

  return {
    count: row ? row.count : 0,
    business: round2(row ? row.business : 0)
  };
}

// ---------- OVERVIEW STATS ----------
router.get('/stats', (req, res) => {
  const totalUsers = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role='user'`).get().c;
  const totalDepositsApproved = db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM deposits WHERE status='approved'`).get().s;
  const pendingDeposits = db.prepare(`SELECT COUNT(*) AS c FROM deposits WHERE status='pending'`).get().c;
  const totalWithdrawalsApproved = db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM withdrawals WHERE status IN ('processing','processed')`).get().s;
  const pendingWithdrawals = db.prepare(`SELECT COUNT(*) AS c FROM withdrawals WHERE status='pending'`).get().c;
  const adminUser = getAdminUser();
  const adminWallet = adminUser?.wallet_balance || 0;
  const adminLevelWallet = adminUser?.admin_level_wallet || 0;

  res.json({ totalUsers, totalDepositsApproved, pendingDeposits, totalWithdrawalsApproved, pendingWithdrawals, adminWallet, adminLevelWallet });
});

// ---------- ADMIN WALLET ----------
router.get('/wallet', (req, res) => {
  const admin = getAdminUser();
  res.json({
    wallet_balance: admin ? admin.wallet_balance : 0,
    admin_level_wallet: admin ? (admin.admin_level_wallet || 0) : 0
  });
});

// ---------- ADMIN LEVEL WALLET ----------
router.get('/level-wallet', (req, res) => {
  const admin = getAdminUser();
  res.json({ admin_level_wallet: admin ? (admin.admin_level_wallet || 0) : 0 });
});

router.get('/level-wallet/history', (req, res) => {
  const admin = getAdminUser();
  if (!admin) return res.json([]);
  const rows = db.prepare(`SELECT * FROM income_log WHERE user_id = ? AND type = 'level_wallet_income' ORDER BY id DESC`).all(admin.id);
  res.json(rows);
});

router.get('/wallet/history', (req, res) => {
  const admin = getAdminUser();
  if (!admin) return res.json([]);
  const rows = db.prepare(`SELECT * FROM income_log WHERE user_id = ? ORDER BY id DESC`).all(admin.id);
  res.json(rows);
});

// ---------- SETTINGS ----------
router.get('/settings/deposit-addresses', (req, res) => {
  const bep20 = db.prepare('SELECT value FROM settings WHERE key = ?').get('deposit_address_BEP20');
  const trc20 = db.prepare('SELECT value FROM settings WHERE key = ?').get('deposit_address_TRC20');
  res.json({ BEP20: bep20 ? bep20.value : '', TRC20: trc20 ? trc20.value : '' });
});

router.put('/settings/deposit-addresses', (req, res) => {
  const { BEP20, TRC20 } = req.body;
  if (BEP20 && !isValidForNetwork('BEP20', BEP20)) return res.status(400).json({ error: 'Invalid BEP20 address' });
  if (TRC20 && !isValidForNetwork('TRC20', TRC20)) return res.status(400).json({ error: 'Invalid TRC20 address' });

  const upsert = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  if (BEP20 !== undefined) upsert.run('deposit_address_BEP20', BEP20);
  if (TRC20 !== undefined) upsert.run('deposit_address_TRC20', TRC20);
  res.json({ message: 'Deposit addresses updated' });
});

// ---------- WITHDRAWAL SETTINGS ----------
router.get('/settings/withdrawal', (req, res) => {
  const get = (k) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? r.value : null; };
  res.json({
    withdrawal_day_enabled: get('withdrawal_day_enabled') === 'true',
    withdrawal_days: get('withdrawal_days') || '1',
    withdrawal_monthly_limit_pct: parseFloat(get('withdrawal_monthly_limit_pct') || '10')
  });
});

router.put('/settings/withdrawal', (req, res) => {
  const { withdrawal_day_enabled, withdrawal_days, withdrawal_monthly_limit_pct } = req.body;
  const upsert = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);

  if (withdrawal_day_enabled !== undefined) upsert.run('withdrawal_day_enabled', withdrawal_day_enabled ? 'true' : 'false');
  if (withdrawal_days !== undefined) {
    // Validate: comma-separated integers 1-7
    const days = String(withdrawal_days).split(',').map(d => parseInt(d.trim())).filter(d => d >= 1 && d <= 7);
    if (!days.length) return res.status(400).json({ error: 'Select at least one valid day (1=Mon to 7=Sun)' });
    upsert.run('withdrawal_days', days.join(','));
  }
  if (withdrawal_monthly_limit_pct !== undefined) {
    const pct = parseFloat(withdrawal_monthly_limit_pct);
    if (isNaN(pct) || pct <= 0 || pct > 100) return res.status(400).json({ error: 'Limit must be between 1 and 100%' });
    upsert.run('withdrawal_monthly_limit_pct', String(pct));
  }
  res.json({ message: 'Withdrawal settings updated' });
});

// ---------- ALL USERS ----------
router.get('/users', (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.user_code, u.name, u.email, u.phone, u.sponsor_id, s.user_code AS sponsor_code,
           u.parent_id, u.position, u.wallet_balance, u.main_wallet, u.referral_wallet, u.status, u.created_at,
           u.net_invested_capital, u.cap_ceiling, u.cap_used, u.is_capped
    FROM users u LEFT JOIN users s ON s.id = u.sponsor_id
    WHERE u.role='user' ORDER BY u.id DESC
  `).all();
  res.json(rows);
});

router.put('/users/:id/block', (req, res) => {
  db.prepare(`UPDATE users SET status='blocked' WHERE id = ?`).run(req.params.id);
  res.json({ message: 'User blocked' });
});

router.put('/users/:id/unblock', (req, res) => {
  const user = db.prepare('SELECT wallet_balance, main_wallet, referral_wallet FROM users WHERE id = ?').get(req.params.id);
  const newStatus = (user && (user.wallet_balance > 0 || user.main_wallet > 0 || user.referral_wallet > 0)) ? 'active' : 'inactive';
  db.prepare(`UPDATE users SET status = ? WHERE id = ?`).run(newStatus, req.params.id);
  res.json({ message: `User unblocked (status set to ${newStatus})` });
});

router.get('/users/:id/transactions', (req, res) => {
  const user = db.prepare(`
    SELECT id, user_code, name, email, role, wallet_balance, main_wallet, referral_wallet, status, created_at
    FROM users WHERE id = ?
  `).get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  res.json({ user, transactions: buildWalletLedger(user.id), cap: getCapInfo(user.id) });
});

// ---------- DUAL WALLET ADJUSTMENTS / PERCENTAGE PROFIT ----------
router.post('/adjust-balance', (req, res) => {
  const { userId, targetWallet, mode, value } = req.body;

  if (!userId || !targetWallet || !mode || value === undefined) {
    return res.status(400).json({ error: 'All fields (userId, targetWallet, mode, value) are required' });
  }

  // Only percentage-mode profit on the main wallet is supported — fixed-amount
  // and referral-wallet adjustments were removed. (Level income only ever
  // cascades from a main-wallet percentage profit, so allowing other modes
  // here would let balances change without the level-income distribution.)
  if (mode !== 'percentage') {
    return res.status(400).json({ error: 'Only percentage-mode profit adjustments are supported.' });
  }
  if (targetWallet !== 'main') {
    return res.status(400).json({ error: 'Only the main wallet can be adjusted here.' });
  }

  const walletCol = 'main_wallet';
  const val = parseFloat(value);

  if (isNaN(val)) return res.status(400).json({ error: 'Invalid numeric value' });

  const targetUser = db.prepare('SELECT id, user_code, status FROM users WHERE id = ?').get(userId);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });
  if (targetUser.status === 'inactive') {
    return res.status(400).json({ error: `${targetUser.user_code} is inactive — balance cannot be adjusted until the account is active.` });
  }

  const tx = db.transaction(() => {
    if (mode === 'percentage') {
      const before = db.prepare(`SELECT ${walletCol} AS bal FROM users WHERE id = ?`).get(userId);
      const intendedProfit = Math.round(before.bal * (val / 100) * 100) / 100;

      // The user's own credit is subject to THEIR earning cap. Losses
      // (negative val) are never capped — only gains draw against it.
      let actualProfit = intendedProfit;
      if (intendedProfit > 0) {
        const result = creditCappedIncome(userId, intendedProfit, 'profit_percentage', `Credited ${val}% profit to ${targetWallet} wallet`);
        actualProfit = result.credited;
      } else if (intendedProfit < 0) {
        db.prepare(`UPDATE users SET ${walletCol} = round(${walletCol} + ?, 2) WHERE id = ?`).run(intendedProfit, userId);
        db.prepare(`UPDATE users SET wallet_balance = round(main_wallet + referral_wallet, 2) WHERE id = ?`).run(userId);
        db.prepare(`INSERT INTO income_log (user_id, type, amount, note) VALUES (?, 'profit_percentage', ?, ?)`)
          .run(userId, intendedProfit, `Debited ${Math.abs(val)}% loss from ${targetWallet} wallet`);
      }

      // Level income: pay upline (referral/sponsor chain) a % of the profit
      // amount actually credited to this user (post-cap), per LEVEL_PERCENTAGES.
      // Inactive uplines are skipped (no adjustment), but the chain still
      // continues past them to their sponsor. Each upline's own cap applies too.
      distributeLevelIncome(userId, actualProfit);
    } else {
      db.prepare(`UPDATE users SET ${walletCol} = round(${walletCol} + ?, 2) WHERE id = ?`).run(val, userId);
      db.prepare(`INSERT INTO income_log (user_id, type, amount, note) VALUES (?, 'admin_adjustment', ?, ?)`)
        .run(userId, val, `Admin adjusted ${targetWallet} wallet by ${val}`);
    }

    // Sync total wallet_balance field
    db.prepare(`UPDATE users SET wallet_balance = round(main_wallet + referral_wallet, 2) WHERE id = ?`).run(userId);
  });
  tx();

  res.json({ message: `User ${targetWallet} wallet balance successfully updated.` });
});

// ---------- BULK / TARGETED BALANCE ADJUSTMENT (PERCENTAGE, MAIN WALLET ONLY) ----------
router.post('/adjust-balances', (req, res) => {
  const { mode, value, walletType, targetUserId } = req.body;

  // Only percentage-mode profit on the main wallet is supported — fixed-amount
  // and referral-wallet adjustments were removed. (Level income only ever
  // cascades from a main-wallet percentage profit, so allowing other modes
  // here would let balances change without the level-income distribution.)
  if (mode !== 'percentage') {
    return res.status(400).json({ error: 'Only percentage-mode profit adjustments are supported.' });
  }
  if (walletType !== 'main') {
    return res.status(400).json({ error: 'Only the main wallet can be adjusted here.' });
  }

  const val = parseFloat(value);
  if (isNaN(val) || val <= 0) {
    return res.status(400).json({ error: 'Enter a valid positive number' });
  }

  const isAll = !targetUserId || targetUserId === 'all';

  const tx = db.transaction(() => {
    // Snapshot affected users' current main_wallet BEFORE the update, so we
    // can compute each one's intended profit (percentage mode gives a
    // different USDT amount per user depending on their starting balance).
    // Inactive accounts are excluded entirely — no balance adjustment for them.
    const affected = isAll
      ? db.prepare(`SELECT id, main_wallet FROM users WHERE role = 'user' AND status = 'active'`).all()
      : db.prepare(`SELECT id, main_wallet FROM users WHERE id = ? AND role = 'user' AND status = 'active'`).all(targetUserId);

    // Pass 1: credit each user's own direct profit — subject to THEIR
    // deposit-linked earning cap. Excess beyond their headroom is forfeited
    // (not credited to them or anyone else) and they're flagged is_capped.
    const profitByUser = [];
    for (const u of affected) {
      const intendedProfit = Math.round(u.main_wallet * (val / 100) * 100) / 100;
      if (intendedProfit <= 0) continue;
      const { credited } = creditCappedIncome(u.id, intendedProfit, 'profit_percentage', `Credited ${val}% profit to main wallet`);
      if (credited > 0) profitByUser.push({ id: u.id, profit: credited });
    }

    // Pass 2: now that every direct credit is measured and logged, pay level
    // income up the binary tree for each user's (post-cap) profit. Each
    // upline's own cap is applied inside distributeLevelIncome.
    for (const { id, profit } of profitByUser) {
      distributeLevelIncome(id, profit);
    }
  });

  tx();

  const targetText = isAll ? 'all non-admin users' : `user ID ${targetUserId}`;
  res.json({
    message: `Successfully applied ${val}% boost to ${targetText}!`
  });
});

// ---------- DEPOSITS ----------
router.get('/deposits', (req, res) => {
  const rows = db.prepare(`
    SELECT d.*, u.user_code AS user_code, u.name AS user_name, u.email AS user_email
    FROM deposits d JOIN users u ON u.id = d.user_id
    ORDER BY d.id DESC
  `).all();
  res.json(rows);
});

router.put('/deposits/:id/approve', (req, res) => {
  const dep = db.prepare('SELECT * FROM deposits WHERE id = ?').get(req.params.id);
  if (!dep) return res.status(404).json({ error: 'Not found' });
  if (dep.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

  // Referral bonus = 5% of deposit amount (e.g. 50 for 1000).
  // User is credited deposit - referral (e.g. 950). Cap ceiling = 950 * 2 = 1900.
  const fullAmount = round2(dep.amount);
  const bonus = round2(fullAmount * REFERRAL_RATE); // 5% e.g. 50
  const creditAmount = round2(fullAmount - bonus);   // e.g. 950 credited to user
  const netInvestedDelta = creditAmount;             // cap = 950 * 2

  const depositUser = db.prepare('SELECT id, sponsor_id FROM users WHERE id = ?').get(dep.user_id);
  const admin = getAdminUser();

  const tx = db.transaction(() => {
    db.prepare(`UPDATE deposits SET status='approved', net_amount = ?, fee_amount = ?, updated_at = datetime('now'), remarks = ? WHERE id = ?`)
      .run(creditAmount, bonus, req.body.remarks || 'Approved by admin', dep.id);

    // Credit user's main wallet with deposit minus referral bonus (e.g. 950)
    db.prepare('UPDATE users SET main_wallet = main_wallet + ? WHERE id = ?').run(creditAmount, dep.user_id);
    db.prepare('UPDATE users SET wallet_balance = round(main_wallet + referral_wallet, 2) WHERE id = ?').run(dep.user_id);

    db.prepare(`INSERT INTO income_log (user_id, type, amount, note) VALUES (?, 'deposit_credit', ?, 'Deposit approved (referral fee deducted)')`)
      .run(dep.user_id, creditAmount);

    // Cap ceiling = (deposit - referral_bonus) * 2
    adjustInvestedCapital(dep.user_id, netInvestedDelta);

    // Activate user upon successful funded deposit
    db.prepare(`UPDATE users SET status='active' WHERE id = ? AND status='inactive'`).run(dep.user_id);

    // Referral bonus flow:
    // Step 1: Always credit the referral fee (bonus) to admin wallet as income.
    // Step 2: If sponsor is an active non-admin user, transfer bonus from admin to sponsor.
    if (bonus > 0 && admin) {
      // Step 1: Credit admin with the referral fee collected from this deposit
      db.prepare('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?').run(bonus, admin.id);
      db.prepare(`INSERT INTO income_log (user_id, type, amount, note) VALUES (?, 'referral_fee_collected', ?, ?)`)
        .run(admin.id, bonus, `Referral fee collected from deposit #${dep.id} (${dep.amount} USDT)`);

      // Step 2: If depositor has an active non-admin sponsor, pay the bonus out to them
      if (depositUser && depositUser.sponsor_id && depositUser.sponsor_id !== admin.id) {
        const sponsor = db.prepare('SELECT id, user_code, status FROM users WHERE id = ?').get(depositUser.sponsor_id);
        if (sponsor && sponsor.status === 'active') {
          db.prepare('UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?').run(bonus, admin.id);
          db.prepare('UPDATE users SET referral_wallet = referral_wallet + ? WHERE id = ?').run(bonus, sponsor.id);
          db.prepare('UPDATE users SET wallet_balance = round(main_wallet + referral_wallet, 2) WHERE id = ?').run(sponsor.id);
          markInactiveIfLowBalance(admin.id);

          db.prepare(`INSERT INTO income_log (user_id, type, amount, note) VALUES (?, 'referral_bonus_paid', ?, ?)`)
            .run(admin.id, -bonus, `Referral bonus paid to ${sponsor.user_code} from deposit #${dep.id}`);
          db.prepare(`INSERT INTO income_log (user_id, type, amount, note) VALUES (?, 'referral_bonus', ?, ?)`)
            .run(sponsor.id, bonus, `Referral bonus from deposit #${dep.id}`);
        } else {
          // Sponsor not active — admin keeps the fee (already credited in Step 1)
          db.prepare(`INSERT INTO income_log (user_id, type, amount, note) VALUES (?, 'referral_bonus_retained', ?, ?)`)
            .run(admin.id, 0, `Referral bonus retained (sponsor ${sponsor ? sponsor.user_code : '#' + depositUser.sponsor_id} not active) from deposit #${dep.id}`);
        }
      }
      // If sponsor IS the admin (dummy tree / BAV01 case), fee stays with admin — no extra action needed
    }
  });
  tx();

  res.json({ message: 'Deposit approved, user activated, wallet credited, and referral bonus paid' });
});

router.put('/deposits/:id/reject', (req, res) => {
  const dep = db.prepare('SELECT * FROM deposits WHERE id = ?').get(req.params.id);
  if (!dep) return res.status(404).json({ error: 'Not found' });
  if (dep.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

  db.prepare(`UPDATE deposits SET status='rejected', updated_at = datetime('now'), remarks = ? WHERE id = ?`)
    .run(req.body.remarks || 'Rejected by admin', dep.id);

  res.json({ message: 'Deposit rejected' });
});

// ---------- WITHDRAWALS ----------
router.get('/withdrawals', (req, res) => {
  const rows = db.prepare(`
    SELECT w.*, u.user_code, u.name AS user_name, u.email AS user_email,
           u.withdrawal_address_bep20, u.withdrawal_address_trc20
    FROM withdrawals w JOIN users u ON u.id = w.user_id
    ORDER BY CASE w.status WHEN 'pending' THEN 1 WHEN 'processing' THEN 2 ELSE 3 END ASC, w.id DESC
  `).all();
  res.json(rows);
});

router.put('/withdrawals/:id/approve', (req, res) => {
  const wd = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(req.params.id);
  if (!wd) return res.status(404).json({ error: 'Not found' });
  if (wd.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

  const feeAmount = round2(wd.amount * 0.05);
  const netAmount = round2(wd.amount - feeAmount);
  const admin = getAdminUser();

  const tx = db.transaction(() => {
    db.prepare(`UPDATE withdrawals SET status='processing', net_amount = ?, fee_amount = ?, updated_at = datetime('now'), remarks = ? WHERE id = ?`)
      .run(netAmount, feeAmount, req.body.remarks || 'Approved — queued for processing', wd.id);

    if (admin) {
      db.prepare('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?').run(feeAmount, admin.id);
      db.prepare(`INSERT INTO income_log (user_id, type, amount, note) VALUES (?, 'platform_fee', ?, ?)`)
        .run(admin.id, feeAmount, `Platform fee from withdrawal #${wd.id}`);
    }

    markInactiveIfLowBalance(wd.user_id);
  });
  tx();

  res.json({ message: `Withdrawal moved to Processing. Net payout: ${netAmount.toFixed(2)} USDT via ${wd.network || 'N/A'}.` });
});

// GET /admin/withdrawals/processing — list all withdrawals in processing state
router.get('/withdrawals/processing', (req, res) => {
  const rows = db.prepare(`
    SELECT w.*, u.user_code, u.name AS user_name, u.email AS user_email,
           u.withdrawal_address_bep20, u.withdrawal_address_trc20
    FROM withdrawals w JOIN users u ON u.id = w.user_id
    WHERE w.status = 'processing'
    ORDER BY w.updated_at ASC
  `).all();
  res.json(rows);
});

// PUT /admin/withdrawals/bulk-processed — mark selected IDs as processed
router.put('/withdrawals/bulk-processed', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0)
    return res.status(400).json({ error: 'No withdrawal IDs provided' });

  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id FROM withdrawals WHERE id IN (${placeholders}) AND status = 'processing'`).all(...ids);
  if (!rows.length) return res.status(400).json({ error: 'No matching processing withdrawals found' });

  const validIds = rows.map(r => r.id);
  const ph2 = validIds.map(() => '?').join(',');
  db.prepare(`UPDATE withdrawals SET status='processed', updated_at = datetime('now'), remarks = 'Processed via bulk action' WHERE id IN (${ph2})`).run(...validIds);

  res.json({ message: `${validIds.length} withdrawal(s) marked as Processed.`, count: validIds.length });
});

router.put('/withdrawals/:id/reject', (req, res) => {
  const wd = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(req.params.id);
  if (!wd) return res.status(404).json({ error: 'Not found' });
  if (wd.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

  const targetWalletCol = wd.wallet_type === 'referral' ? 'referral_wallet' : 'main_wallet';

  const tx = db.transaction(() => {
    db.prepare(`UPDATE withdrawals SET status='rejected', updated_at = datetime('now'), remarks = ? WHERE id = ?`)
      .run(req.body.remarks || 'Rejected by admin', wd.id);
    
    // Refund held amount to corresponding wallet
    db.prepare(`UPDATE users SET ${targetWalletCol} = ${targetWalletCol} + ? WHERE id = ?`).run(wd.amount, wd.user_id);
    db.prepare('UPDATE users SET wallet_balance = round(main_wallet + referral_wallet, 2) WHERE id = ?').run(wd.user_id);

    // Reverse the earning-cap impact this withdrawal had when it was first
    // requested (main-wallet withdrawals reduce invested capital — see user.js).
    if (targetWalletCol === 'main_wallet') {
      adjustInvestedCapital(wd.user_id, wd.amount);
    }

    // Check status in case refund moves user out of zero balance
    db.prepare(`UPDATE users SET status='active' WHERE id = ? AND (wallet_balance > 0 OR main_wallet > 0 OR referral_wallet > 0) AND status='inactive'`).run(wd.user_id);
  });
  tx();

  res.json({ message: 'Withdrawal rejected and amount refunded to user wallet' });
});

// ---------- REPORTS ----------
router.get('/reports', (req, res) => {
  const monthlyDeposits = db.prepare(`
    SELECT strftime('%Y-%m', created_at) AS month, COALESCE(SUM(amount),0) AS total
    FROM deposits WHERE status='approved'
    GROUP BY month ORDER BY month DESC LIMIT 6
  `).all().reverse();

  const monthlyWithdrawals = db.prepare(`
    SELECT strftime('%Y-%m', created_at) AS month, COALESCE(SUM(amount),0) AS total
    FROM withdrawals WHERE status IN ('processing','processed')
    GROUP BY month ORDER BY month DESC LIMIT 6
  `).all().reverse();

  const userGrowth = db.prepare(`
    SELECT strftime('%Y-%m', created_at) AS month, COUNT(*) AS count
    FROM users WHERE role='user'
    GROUP BY month ORDER BY month DESC LIMIT 6
  `).all().reverse();

  const topWallets = db.prepare(`
    SELECT id, user_code, name, email, wallet_balance, main_wallet, referral_wallet FROM users WHERE role='user'
    ORDER BY wallet_balance DESC LIMIT 5
  `).all();

  const leftRightSplit = db.prepare(`
    SELECT position, COUNT(*) AS count FROM users WHERE position IS NOT NULL GROUP BY position
  `).all();

  res.json({ monthlyDeposits, monthlyWithdrawals, userGrowth, topWallets, leftRightSplit });
});

// ---------- BUSINESS OVERVIEW & LOOKUP ----------
router.get('/business-overview', (req, res) => {
  const root = db.prepare(`
    SELECT id, user_code, name 
    FROM users 
    WHERE is_root = 1
  `).get();

  const actualRoot = root || db.prepare(`
    SELECT id, user_code, name 
    FROM users 
    WHERE role = 'user' 
    ORDER BY id ASC LIMIT 1
  `).get();

  if (!actualRoot) {
    return res.json({ 
      root: null, 
      left: { count: 0, business: 0 }, 
      right: { count: 0, business: 0 } 
    });
  }

  res.json({
    root: actualRoot,
    left: legBusiness(actualRoot.id, 'L'),
    right: legBusiness(actualRoot.id, 'R')
  });
});

router.get('/users/search', (req, res) => {
  const q = `%${(req.query.q || '').trim()}%`;
  if (!q || q === '%%') return res.json([]);
  const rows = db.prepare(`
    SELECT id, user_code, name, email, phone, status, wallet_balance, main_wallet, referral_wallet 
    FROM users
    WHERE role='user' AND (user_code LIKE ? OR name LIKE ? OR email LIKE ? OR phone LIKE ?)
    ORDER BY id DESC LIMIT 20
  `).all(q, q, q, q);
  res.json(rows);
});

router.get('/users/:id/business', (req, res) => {
  const user = db.prepare(`SELECT id, user_code, name, email, status, wallet_balance, main_wallet, referral_wallet FROM users WHERE id = ?`).get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  const ownDeposits = db.prepare(`
    SELECT COALESCE(SUM(COALESCE(net_amount, round(amount / 1.05, 2))), 0) AS s 
    FROM deposits WHERE status='approved' AND user_id = ?
  `).get(user.id).s;

  res.json({
    user,
    left: legBusiness(user.id, 'L'),
    right: legBusiness(user.id, 'R'),
    ownDeposits: round2(ownDeposits)
  });
});

// ---------- BINARY TREE VIEW ----------
router.get('/tree/:userId', (req, res) => {
  const expand = (id, depth) => {
    if (!id || depth > 4) return null;
    const node = db.prepare('SELECT id, user_code, name, email, status, wallet_balance, main_wallet, referral_wallet FROM users WHERE id = ?').get(id);
    if (!node) return null;
    
    const left = db.prepare(`SELECT id FROM users WHERE parent_id = ? AND position='L'`).get(id);
    const right = db.prepare(`SELECT id FROM users WHERE parent_id = ? AND position='R'`).get(id);
    
    return {
      ...node,
      left: left ? expand(left.id, depth + 1) : null,
      right: right ? expand(right.id, depth + 1) : null
    };
  };

  res.json(expand(req.params.userId, 0));
});

// ---------- SUPPORT TICKET MANAGEMENT ----------
router.get('/support', (req, res) => {
  const { status, ticket_type } = req.query;
  let where = [];
  let params = [];
  if (status) { where.push(`t.status = ?`); params.push(status); }
  if (ticket_type) { where.push(`t.ticket_type = ?`); params.push(ticket_type); }
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`
    SELECT t.*, u.user_code, u.name AS user_name, u.email AS user_email,
           (SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id = t.id) AS message_count
    FROM support_tickets t JOIN users u ON u.id = t.user_id
    ${whereClause}
    ORDER BY CASE t.status WHEN 'open' THEN 1 WHEN 'in_progress' THEN 2 ELSE 3 END ASC,
             t.priority ASC, t.updated_at DESC
  `).all(...params);
  res.json(rows);
});

router.get('/support/:token', (req, res) => {
  const token = req.params.token.trim();
  const ticket = db.prepare(`
    SELECT t.*, u.user_code, u.name AS user_name, u.email AS user_email
    FROM support_tickets t JOIN users u ON u.id = t.user_id
    WHERE t.ticket_no = ? COLLATE NOCASE OR t.id = ?
  `).get(token, /^\d+$/.test(token) ? Number(token) : -1);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  const messages = db.prepare(`SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY id ASC`).all(ticket.id);
  res.json({ ticket, messages });
});

router.post('/support/:token/reply', (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message is required' });

  const token = req.params.token.trim();
  const ticket = db.prepare(`SELECT * FROM support_tickets WHERE ticket_no = ? COLLATE NOCASE OR id = ?`)
    .get(token, /^\d+$/.test(token) ? Number(token) : -1);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO support_messages (ticket_id, sender_role, sender_id, message) VALUES (?, 'admin', ?, ?)`)
      .run(ticket.id, req.user.id, message.trim());
    db.prepare(`UPDATE support_tickets SET status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END, updated_at = datetime('now') WHERE id = ?`)
      .run(ticket.id);
  });
  tx();

  res.json({ message: 'Reply sent' });
});

router.put('/support/:token/status', (req, res) => {
  const { status } = req.body;
  if (!['open', 'in_progress', 'closed'].includes(status)) {
    return res.status(400).json({ error: 'Status must be open, in_progress, or closed' });
  }
  const token = req.params.token.trim();
  const ticket = db.prepare(`SELECT id FROM support_tickets WHERE ticket_no = ? COLLATE NOCASE OR id = ?`)
    .get(token, /^\d+$/.test(token) ? Number(token) : -1);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  db.prepare(`UPDATE support_tickets SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, ticket.id);
  res.json({ message: `Ticket status set to ${status}` });
});

// ---------- LEVEL UNLOCK DEPOSITS (admin) ----------

const LEVEL_UNLOCK_PRICE = 20;
const TOTAL_LEVELS = 25;

router.get('/level-unlock-deposits', (req, res) => {
  const status = req.query.status || 'pending';
  const rows = db.prepare(`
    SELECT d.*, u.user_code, u.name, u.email
    FROM level_unlock_deposits d
    JOIN users u ON u.id = d.user_id
    WHERE d.status = ?
    ORDER BY d.id DESC
  `).all(status);
  res.json(rows);
});

router.put('/level-unlock-deposits/:id/approve', (req, res) => {
  const dep = db.prepare(`SELECT * FROM level_unlock_deposits WHERE id = ?`).get(req.params.id);
  if (!dep) return res.status(404).json({ error: 'Request not found' });
  if (dep.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

  const tx = db.transaction(() => {
    // Check if level already unlocked (race guard)
    const already = db.prepare(
      `SELECT 1 FROM level_unlocks WHERE user_id = ? AND level = ?`
    ).get(dep.user_id, dep.level);
    if (already) throw new Error(`Level ${dep.level} is already unlocked for this user.`);

    // Enforce sequential unlock
    if (dep.level > 1) {
      const prevUnlocked = db.prepare(
        `SELECT 1 FROM level_unlocks WHERE user_id = ? AND level = ?`
      ).get(dep.user_id, dep.level - 1);
      if (!prevUnlocked) throw new Error(`Level ${dep.level - 1} must be unlocked first.`);
    }

    // Record unlock
    const insertResult = db.prepare(
      `INSERT INTO level_unlocks (user_id, level, unlocked_via, deposit_id) VALUES (?, ?, 'deposit', ?)`
    ).run(dep.user_id, dep.level, dep.id);

    // Mark deposit approved
    db.prepare(
      `UPDATE level_unlock_deposits SET status = 'approved', updated_at = datetime('now') WHERE id = ?`
    ).run(dep.id);

    // Log in income_log as info entry
    db.prepare(`INSERT INTO income_log (user_id, type, amount, note) VALUES (?, 'level_unlock', ?, ?)`)
      .run(dep.user_id, 0, `Level ${dep.level} unlocked via on-chain deposit (${dep.txn_ref})`);

    // Credit admin_level_wallet (separate from wallet_balance/wallet_income)
    const adminForLevel = db.prepare(`SELECT id FROM users WHERE role='admin' ORDER BY id ASC LIMIT 1`).get();
    if (adminForLevel) {
      const lvlPrice = dep.amount || 20;
      db.prepare(`UPDATE users SET admin_level_wallet = round(COALESCE(admin_level_wallet,0) + ?, 2) WHERE id = ?`)
        .run(lvlPrice, adminForLevel.id);
      db.prepare(`INSERT INTO income_log (user_id, type, amount, note) VALUES (?, 'level_wallet_income', ?, ?)`)
        .run(adminForLevel.id, lvlPrice, `Level ${dep.level} unlock fee from user #${dep.user_id} (on-chain deposit ${dep.txn_ref})`);
    }
  });

  try {
    tx();
    res.json({ message: `Level ${dep.level} unlock approved for user #${dep.user_id}` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/level-unlock-deposits/:id/reject', (req, res) => {
  const { remarks } = req.body;
  const dep = db.prepare(`SELECT * FROM level_unlock_deposits WHERE id = ?`).get(req.params.id);
  if (!dep) return res.status(404).json({ error: 'Request not found' });
  if (dep.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

  db.prepare(
    `UPDATE level_unlock_deposits SET status = 'rejected', remarks = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(remarks || null, dep.id);

  res.json({ message: `Level ${dep.level} unlock deposit rejected` });
});

// ---------- DB VIEWER (admin only) ----------

const ALLOWED_TABLES = [
  'users', 'deposits', 'withdrawals', 'income_log',
  'level_unlocks', 'level_unlock_deposits',
  'support_tickets', 'support_messages', 'settings'
];

// GET /admin/db/tables — list all table names
router.get('/db/tables', (req, res) => {
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  ).all().map(r => r.name);
  res.json(tables);
});

// GET /admin/db/query?table=users&page=1&search=john
router.get('/db/query', (req, res) => {
  const { table, page = 1, search = '' } = req.query;
  if (!table || !ALLOWED_TABLES.includes(table)) {
    return res.status(400).json({ error: 'Invalid or disallowed table name' });
  }

  const limit = 50;
  const offset = (parseInt(page) - 1) * limit;

  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);

  let where = '';
  const params = [];
  if (search.trim()) {
    const textCols = db.prepare(`PRAGMA table_info(${table})`).all()
      .filter(c => ['TEXT', 'VARCHAR', 'CHAR', ''].includes(c.type.toUpperCase().split('(')[0]))
      .map(c => c.name);
    if (textCols.length) {
      where = 'WHERE ' + textCols.map(c => `CAST(${c} AS TEXT) LIKE ?`).join(' OR ');
      textCols.forEach(() => params.push(`%${search}%`));
    }
  }

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM ${table} ${where}`).get(...params).cnt;
  const rows  = db.prepare(`SELECT * FROM ${table} ${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);

  res.json({ cols, rows, total, page: parseInt(page), limit });
});

// POST /admin/db/sql — run a raw SELECT or UPDATE statement written by the admin.
// Deliberately does NOT accept parameters from the client — the admin writes a
// complete, literal SQL string in the DB Viewer UI, same as a desktop SQL client.
router.post('/db/sql', (req, res) => {
  const raw = (req.body.sql || '').trim();
  if (!raw) return res.status(400).json({ error: 'Enter a SQL query' });

  // Only a single statement per request — strip one optional trailing semicolon,
  // then reject if another statement follows it.
  const stripped = raw.replace(/;\s*$/, '');
  if (stripped.includes(';')) {
    return res.status(400).json({ error: 'Only one statement per query is allowed' });
  }

  const firstWord = stripped.trim().split(/\s+/)[0].toUpperCase();
  if (!['SELECT', 'UPDATE'].includes(firstWord)) {
    return res.status(400).json({ error: 'Only SELECT and UPDATE statements are allowed here' });
  }

  // Block statement-smuggling via comments (e.g. "SELECT 1 -- ; DROP TABLE x")
  // and any accidental DDL/DML keywords riding along in an UPDATE (e.g. subqueries
  // calling ATTACH). This is a blunt keyword filter, not a real SQL parser.
  const forbidden = /\b(ATTACH|DETACH|DROP|DELETE|INSERT|ALTER|CREATE|PRAGMA|VACUUM|REPLACE|TRUNCATE)\b/i;
  if (forbidden.test(stripped) || stripped.includes('--') || stripped.includes('/*')) {
    return res.status(400).json({ error: 'Query contains a disallowed keyword or comment' });
  }

  try {
    if (firstWord === 'SELECT') {
      const rows = db.prepare(stripped).all();
      const cols = rows.length ? Object.keys(rows[0]) : [];
      return res.json({ type: 'select', cols, rows, count: rows.length });
    } else {
      const info = db.prepare(stripped).run();
      return res.json({ type: 'update', changes: info.changes });
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// ---------- NOTIFICATIONS (admin) ----------
// Admin can broadcast a notification to every member, or target one member
// specifically. Read state is tracked per-user in notification_reads so the
// same broadcast row can be "unread" for some users and "read" for others.

router.get('/notifications', (req, res) => {
  const rows = db.prepare(`
    SELECT n.*, u.user_code AS target_user_code, u.name AS target_user_name,
      (SELECT COUNT(*) FROM notification_reads r WHERE r.notification_id = n.id) AS read_count,
      CASE WHEN n.audience = 'all'
        THEN (SELECT COUNT(*) FROM users WHERE role = 'user')
        ELSE 1
      END AS audience_count
    FROM notifications n
    LEFT JOIN users u ON u.id = n.user_id
    ORDER BY n.id DESC
  `).all();
  res.json(rows);
});

router.post('/notifications', (req, res) => {
  const { title, message, audience, userId } = req.body;

  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });
  if (!['all', 'user'].includes(audience)) return res.status(400).json({ error: 'Audience must be "all" or "user"' });

  let targetUserId = null;
  if (audience === 'user') {
    if (!userId) return res.status(400).json({ error: 'A target user is required for a targeted notification' });
    const target = db.prepare(`SELECT id FROM users WHERE id = ? AND role = 'user'`).get(userId);
    if (!target) return res.status(404).json({ error: 'Target user not found' });
    targetUserId = target.id;
  }

  const info = db.prepare(
    `INSERT INTO notifications (title, message, audience, user_id, created_by) VALUES (?, ?, ?, ?, ?)`
  ).run(title.trim(), message.trim(), audience, targetUserId, req.user.id);

  res.json({ message: 'Notification sent', id: info.lastInsertRowid });
});

router.delete('/notifications/:id', (req, res) => {
  const notif = db.prepare(`SELECT * FROM notifications WHERE id = ?`).get(req.params.id);
  if (!notif) return res.status(404).json({ error: 'Notification not found' });

  db.prepare(`DELETE FROM notification_reads WHERE notification_id = ?`).run(notif.id);
  db.prepare(`DELETE FROM notifications WHERE id = ?`).run(notif.id);

  res.json({ message: 'Notification deleted' });
});

module.exports = router;