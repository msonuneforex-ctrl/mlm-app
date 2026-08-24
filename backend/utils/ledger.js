const db = require('../db');

// Unifies deposits, withdrawals, and income/fee entries (referral bonus, deposit credit,
// platform fee, etc.) for ONE user_id into a single chronological feed with a running
// wallet balance, all in USDT. Used by /user/wallet/history (self) and
// /admin/users/:id/transactions (any user, for admin auditing "who got paid what, and why").
function buildWalletLedger(userId) {
  const deposits = db.prepare(`
    SELECT id, 'deposit' AS kind, status, net_amount AS amount, fee_amount, network, txn_ref AS ref, created_at, updated_at
    FROM deposits WHERE user_id = ?
  `).all(userId);

  const withdrawals = db.prepare(`
    SELECT id, 'withdrawal' AS kind, status, amount AS amount, fee_amount, network, account_details AS ref, created_at, updated_at
    FROM withdrawals WHERE user_id = ?
  `).all(userId);

  const income = db.prepare(`
    SELECT id, type AS kind, 'approved' AS status, amount, 0 AS fee_amount, NULL AS network, note AS ref, created_at, created_at AS updated_at
    FROM income_log WHERE user_id = ?
  `).all(userId);

  const rows = [...deposits, ...withdrawals, ...income]
    .filter(r => !(r.kind === 'deposit_credit')) // deposit_credit in income_log duplicates the 'deposit' row above
    .sort((a, b) => new Date(a.updated_at || a.created_at) - new Date(b.updated_at || b.created_at));

  // running balance, oldest -> newest, from wallet-affecting rows only
  let balance = 0;
  const withRunning = rows.map(r => {
    let delta = 0;
    if (r.kind === 'deposit' && r.status === 'approved') delta = r.amount;
    else if (r.kind === 'withdrawal' && r.status !== 'rejected') delta = -r.amount; // held on request, refunded on reject (income_log has no entry for that)
    else if (r.kind === 'referral_bonus_retained') delta = 0; // informational only — the money was already
    // counted in this same deposit's 'platform_fee' row; it never separately hit
    // the wallet, so it must NOT add to the running balance a second time.
    else if (!['deposit', 'withdrawal'].includes(r.kind)) delta = r.amount; // referral_bonus, platform_fee, etc.
    balance += delta;
    return { ...r, delta, running_balance: Math.round(balance * 100) / 100 };
  });

  return withRunning.reverse(); // newest first for display
}

module.exports = { buildWalletLedger };
