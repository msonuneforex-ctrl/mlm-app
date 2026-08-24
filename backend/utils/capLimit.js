const db = require('../db');

/**
 * DEPOSIT-LINKED EARNING CAP
 * ==========================
 * Each user can earn main-wallet INCOME (level income + admin profit
 * adjustments) up to 2x their currently net-invested capital. Net-invested
 * capital is not just "total ever deposited" — it moves up and down:
 *
 *   net_invested_capital = (main-wallet deposits approved)
 *                         − (main-wallet spent on level-unlock topups)
 *                         − (main-wallet withdrawals taken out)
 *
 * cap_ceiling = 2 x net_invested_capital, recalculated every time any of the
 * three events above happens (see recalcCap below).
 *
 * cap_used is cumulative income actually credited so far. It only ever goes
 * up when income is credited, and never resets — so if a user's ceiling
 * later drops (e.g. after a withdrawal) while cap_used stays the same, they
 * can end up already at/over their new ceiling and get flagged capped
 * immediately with no further income until they deposit again.
 *
 * IMPORTANT: deposit principal itself is never capped or counted as
 * "income" — only money that wasn't already the user's own capital (level
 * income cascades, admin profit/adjustment credits) draws against the cap.
 * Referral bonuses are paid to the separate referral_wallet, which this cap
 * does not touch.
 *
 * When a credit would exceed headroom, the excess is simply NOT created —
 * it isn't paid to the user and isn't redirected to admin. It's logged as a
 * zero-amount "capped_forfeit" row for transparency, and the user is
 * flagged is_capped so they (and admin) can see they need to redeposit to
 * raise their ceiling.
 */

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Recomputes cap_ceiling from the user's current net_invested_capital and
 * re-evaluates is_capped against the (possibly changed) headroom. Does NOT
 * touch cap_used. Call this any time net_invested_capital changes (deposit
 * approved, level-unlock topup paid, main-wallet withdrawal taken/refunded).
 * Must be called from inside the caller's db.transaction().
 */
function recalcCap(userId) {
  const row = db.prepare(
    `SELECT net_invested_capital, cap_used FROM users WHERE id = ?`
  ).get(userId);
  if (!row) return;

  const netInvested = Math.max(0, round2(row.net_invested_capital || 0));
  const ceiling = round2(netInvested * 2);
  const used = round2(row.cap_used || 0);
  const capped = used >= ceiling ? 1 : 0;

  db.prepare(
    `UPDATE users SET net_invested_capital = ?, cap_ceiling = ?, is_capped = ? WHERE id = ?`
  ).run(netInvested, ceiling, capped, userId);
}

/**
 * Adjusts net_invested_capital by `delta` (positive or negative) and
 * recalculates the cap ceiling off the new total. Use positive delta for a
 * deposit being credited, negative for a level-unlock topup spent from main
 * wallet or a main-wallet withdrawal (and positive again if that withdrawal
 * is later rejected/refunded).
 * Must be called from inside the caller's db.transaction().
 */
function adjustInvestedCapital(userId, delta) {
  if (!delta) return;
  db.prepare(
    `UPDATE users SET net_invested_capital = round(COALESCE(net_invested_capital,0) + ?, 2) WHERE id = ?`
  ).run(delta, userId);
  recalcCap(userId);
}

/**
 * Credits main-wallet INCOME (level income, admin profit/adjustment — never
 * deposit principal) subject to the user's earning cap. Only the portion
 * that fits under the remaining headroom is actually credited; anything
 * beyond that is forfeited (not paid to user or admin) and the user is
 * flagged is_capped.
 *
 * `rawAmount` must be a positive number — this function is only for
 * crediting income, not for debits/losses.
 *
 * Returns { credited, forfeited, capped } — credited is the amount actually
 * added to main_wallet (may be less than rawAmount, or 0).
 * Must be called from inside the caller's db.transaction().
 */
function creditCappedIncome(userId, rawAmount, type, note) {
  const amount = round2(rawAmount);
  if (!amount || amount <= 0) return { credited: 0, forfeited: 0, capped: false };

  const user = db.prepare(
    `SELECT cap_ceiling, cap_used FROM users WHERE id = ?`
  ).get(userId);
  if (!user) return { credited: 0, forfeited: amount, capped: false };

  const ceiling = round2(user.cap_ceiling || 0);
  const used = round2(user.cap_used || 0);
  const headroom = Math.max(0, round2(ceiling - used));

  const credited = round2(Math.min(amount, headroom));
  const forfeited = round2(amount - credited);

  if (credited > 0) {
    db.prepare(
      `UPDATE users SET main_wallet = round(main_wallet + ?, 2), cap_used = round(COALESCE(cap_used,0) + ?, 2) WHERE id = ?`
    ).run(credited, credited, userId);
    db.prepare(
      `UPDATE users SET wallet_balance = round(main_wallet + referral_wallet, 2) WHERE id = ?`
    ).run(userId);
    db.prepare(
      `INSERT INTO income_log (user_id, type, amount, note) VALUES (?, ?, ?, ?)`
    ).run(userId, type, credited, note);
  }

  let capped = false;
  if (forfeited > 0) {
    capped = true;
    db.prepare(`UPDATE users SET is_capped = 1 WHERE id = ?`).run(userId);
    db.prepare(
      `INSERT INTO income_log (user_id, type, amount, note) VALUES (?, 'capped_forfeit', 0, ?)`
    ).run(userId, `Earning cap reached — ${forfeited} USDT of ${type.replace(/_/g, ' ')} not credited. Deposit again to raise your limit.`);
  } else {
    // Re-sync flag in case this credit used up exactly the remaining headroom.
    db.prepare(
      `UPDATE users SET is_capped = CASE WHEN cap_used >= cap_ceiling THEN 1 ELSE 0 END WHERE id = ?`
    ).run(userId);
  }

  return { credited, forfeited, capped };
}

/** Read-only snapshot for dashboards/admin views. */
function getCapInfo(userId) {
  const row = db.prepare(
    `SELECT net_invested_capital, cap_ceiling, cap_used, is_capped FROM users WHERE id = ?`
  ).get(userId);
  if (!row) return null;
  const ceiling = round2(row.cap_ceiling || 0);
  const used = round2(row.cap_used || 0);
  return {
    netInvestedCapital: round2(row.net_invested_capital || 0),
    ceiling,
    used,
    headroom: Math.max(0, round2(ceiling - used)),
    isCapped: !!row.is_capped
  };
}

module.exports = { recalcCap, adjustInvestedCapital, creditCappedIncome, getCapInfo };
