const { authenticator } = require('otplib');
const QRCode = require('qrcode');

const ISSUER = 'Bee AI Verse';

// otplib defaults already match Google Authenticator (30s step, 6 digits, SHA1).
// window: 1 tolerates +/-30s of clock drift between the user's phone and the server.
authenticator.options = { window: 1 };

function generateSecret() {
  return authenticator.generateSecret();
}

function keyUri(accountLabel, secret) {
  return authenticator.keyuri(accountLabel, ISSUER, secret);
}

async function qrDataUrl(otpauthUrl) {
  return QRCode.toDataURL(otpauthUrl);
}

function verifyToken(token, secret) {
  if (!token || !secret) return false;
  try {
    return authenticator.verify({ token: String(token).trim(), secret });
  } catch (e) {
    return false;
  }
}

module.exports = { generateSecret, keyUri, qrDataUrl, verifyToken };
