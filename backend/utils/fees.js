const FEE_RATE = 0.05; // 5% platform fee
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * DEPOSIT: user pays a total amount which already includes the 5% platform fee.
 * e.g. pay 105 -> 100 is credited to the user's wallet, 5 goes to the admin wallet.
 *   net   = amount / 1.05
 *   fee   = amount - net
 */
function splitDeposit(amount) {
  const net = round2(amount / (1 + FEE_RATE));
  const fee = round2(amount - net);
  return { amount: round2(amount), net_amount: net, fee_amount: fee };
}

/**
 * WITHDRAWAL: the full amount is deducted from the user's wallet, a 5% platform fee
 * is retained by the admin wallet, and the remainder is what gets paid out to the user.
 *   fee = amount * 5%
 *   net (payable to user) = amount - fee
 */
function splitWithdrawal(amount) {
  const fee = round2(amount * FEE_RATE);
  const net = round2(amount - fee);
  return { amount: round2(amount), net_amount: net, fee_amount: fee };
}

module.exports = { FEE_RATE, round2, splitDeposit, splitWithdrawal };
