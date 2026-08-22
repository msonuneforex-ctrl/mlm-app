const db = require('../db');
const { creditCappedIncome } = require('./capLimit');

// Percentage of the *profit amount* (not the resulting balance) paid to each
// upline level, walking the referral/sponsor chain (sponsor_id), when a user
// is credited a percentage-mode profit from the admin panel.
// L1 = direct sponsor .. L25 = 25th-level upline sponsor.
const LEVEL_PERCENTAGES = [
  10, 8, 6, 2,                                   // L1 - L4
  ...Array(21).fill(1),                          // L5 - L25
];

/**
 * Pays level income up the referral chain (sponsor_id), e.g. BAV05 -> BAV04
 * -> BAV03 -> ... `profitAmount` is the raw USDT profit amount just credited
 * to `userId` (e.g. 100 when a 10% profit is applied to a 1000 balance) —
 * each upline level receives LEVEL_PERCENTAGES[level]% of that same amount,
 * credited to their main_wallet.
 *
 * Inactive uplines receive NO adjustment (skipped, not credited, no log
 * entry) but the chain still continues past them to their own sponsor.
 * Stops early if the chain runs out before 25 levels.
 *
 * Must be called from inside the caller's db.transaction().
 */
function distributeLevelIncome(userId, profitAmount) {
  if (!profitAmount) return;

  const getSponsor = db.prepare('SELECT sponsor_id, status FROM users WHERE id = ?');

  // The user whose profit is generating this whole cascade — named in every
  // level's note so uplines can see exactly which downline it came from,
  // not just "downline" generically.
  const source = db.prepare('SELECT user_code FROM users WHERE id = ?').get(userId);
  const sourceLabel = source && source.user_code ? source.user_code : `#${userId}`;

  let currentId = userId;
  for (let i = 0; i < LEVEL_PERCENTAGES.length; i++) {
    const row = getSponsor.get(currentId);
    if (!row || !row.sponsor_id) break; // referral chain doesn't go this deep — stop

    const uplineId = row.sponsor_id;
    const upline = getSponsor.get(uplineId); // fetch upline's own status
    const level = i + 1;
    const pct = LEVEL_PERCENTAGES[i];

    if (upline && upline.status === 'active') {
      // Only pay this level if the upline has unlocked it.
      const unlocked = db.prepare(
        `SELECT 1 FROM level_unlocks WHERE user_id = ? AND level = ?`
      ).get(uplineId, level);

      if (unlocked) {
        const amount = Math.round(profitAmount * pct / 100 * 100) / 100;
        if (amount > 0) {
          // Subject to the upline's deposit-linked earning cap — only the
          // portion within their remaining headroom is actually credited.
          creditCappedIncome(uplineId, amount, 'level', `Level ${level} income (${pct}% of profit) from ${sourceLabel}`);
        } else if (amount < 0) {
          // Losses aren't capped — they always apply in full.
          db.prepare(`UPDATE users SET main_wallet = round(main_wallet + ?, 2) WHERE id = ?`).run(amount, uplineId);
          db.prepare(`UPDATE users SET wallet_balance = round(main_wallet + referral_wallet, 2) WHERE id = ?`).run(uplineId);
          db.prepare(`INSERT INTO income_log (user_id, type, amount, note) VALUES (?, 'level', ?, ?)`)
            .run(uplineId, amount, `Level ${level} loss (${pct}% of loss) from ${sourceLabel}`);
        }
      }
      // Level locked on upline: no credit, no log — chain continues.
    }
    // Inactive upline: no credit, no log — but chain still walks past them.

    currentId = uplineId;
  }
}

module.exports = { distributeLevelIncome, LEVEL_PERCENTAGES };
