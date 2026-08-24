// Lightweight format validation for USDT payout addresses.
// This checks shape only (not on-chain existence) — good enough to catch typos
// before an address is saved as a withdrawal destination.

const BEP20_RE = /^0x[a-fA-F0-9]{40}$/;     // USDT-BEP20 (BSC) — same format as any EVM address
const TRC20_RE = /^T[a-zA-Z0-9]{33}$/;      // USDT-TRC20 (Tron) — base58, starts with "T", 34 chars total

function isValidBep20(address) {
  return typeof address === 'string' && BEP20_RE.test(address.trim());
}

function isValidTrc20(address) {
  return typeof address === 'string' && TRC20_RE.test(address.trim());
}

function isValidForNetwork(network, address) {
  if (network === 'BEP20') return isValidBep20(address);
  if (network === 'TRC20') return isValidTrc20(address);
  return false;
}

module.exports = { isValidBep20, isValidTrc20, isValidForNetwork };
