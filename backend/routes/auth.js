const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { findOpenSlot } = require('../utils/placement');
const { sanitizeName, sanitizeText } = require('../utils/sanitize');
const { generateSecret, keyUri, qrDataUrl, verifyToken } = require('../utils/totp');
const { getAllowedIps, isRestrictionEnabled, getClientIp } = require('../utils/adminIp');
require('dotenv').config();

const router = express.Router();

function issueSetupToken(userId) {
  return jwt.sign({ id: userId, scope: 'totp-setup' }, process.env.JWT_SECRET, { expiresIn: '15m' });
}

function issueMfaToken(userId) {
  return jwt.sign({ id: userId, scope: 'mfa' }, process.env.JWT_SECRET, { expiresIn: '5m' });
}

function issueLoginToken(user) {
  return jwt.sign(
    { id: user.id, userCode: user.user_code, email: user.email, role: user.role, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function loginPayload(user) {
  return { id: user.id, userCode: user.user_code, name: user.name, email: user.email, role: user.role, wallet_balance: user.wallet_balance };
}

// Shared by both the register flow and the "enable 2FA from profile" flow.
// Generates (or reuses) a not-yet-confirmed secret for this user and returns
// everything the frontend needs to render a scannable QR code.
async function buildTotpSetupResponse(user) {
  const secret = user.totp_secret || generateSecret();
  if (!user.totp_secret) {
    db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret, user.id);
  }
  const label = user.user_code || user.email;
  const otpauthUrl = keyUri(label, secret);
  const qr = await qrDataUrl(otpauthUrl);
  return { secret, otpauthUrl, qrCode: qr };
}

// ---------- PLACEMENT PREVIEW ----------
// Called by the register page to show the user WHERE they will be placed
// before they submit the form (no account is created here).
router.get('/placement-preview', (req, res) => {
  try {
    const { sponsorCode, side } = req.query;
    const lookup = (sponsorCode || '').trim().toUpperCase();
    if (!lookup) return res.status(400).json({ error: 'Sponsor ID required' });

    const sponsor = db.prepare('SELECT id, user_code, name, role FROM users WHERE user_code = ? OR email = ?').get(lookup, lookup);
    if (!sponsor) return res.status(404).json({ error: 'Sponsor not found' });
    if (sponsor.role !== 'user') return res.status(400).json({ error: 'That account cannot sponsor members. Use a BAV member ID (e.g. BAV01).' });

    const preferredSide = side === 'L' || side === 'R' ? side : null;
    const slot = findOpenSlot(sponsor.id, preferredSide);

    // Resolve the actual parent (may differ from sponsor if BFS placed deeper)
    const parent = db.prepare('SELECT user_code, name FROM users WHERE id = ?').get(slot.parent_id);

    res.json({
      sponsorCode: sponsor.user_code,
      sponsorName: sponsor.name,
      parentCode: parent ? parent.user_code : sponsor.user_code,
      parentName: parent ? parent.name : sponsor.name,
      position: slot.position  // 'L' or 'R'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------- REGISTER ----------
router.post('/register', (req, res) => {
  try {
    const { name: rawName, email, password, sponsorCode, sponsorEmail, side } = req.body;
    const sponsorLookup = (sponsorCode || sponsorEmail || '').trim();
    const name = sanitizeName(rawName);

    if (!name || !email || !password || !sponsorLookup) {
      return res.status(400).json({ error: 'Name, email, password and sponsor ID are required' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(400).json({ error: 'Email already registered' });

    // Sponsor can be identified either by their BAV user ID or, for backwards compatibility, email.
    const sponsor = db.prepare('SELECT * FROM users WHERE user_code = ? OR email = ?').get(sponsorLookup, sponsorLookup);
    if (!sponsor) return res.status(400).json({ error: 'Sponsor (referrer) ID not found' });
    if (sponsor.role !== 'user') return res.status(400).json({ error: 'That account cannot sponsor members. Use a BAV member ID (e.g. BAV01).' });

    const preferredSide = side === 'L' || side === 'R' ? side : null;
    const slot = findOpenSlot(sponsor.id, preferredSide);

    const hashed = bcrypt.hashSync(password, 10);
    const userCode = db.generateUserCode();

    // New accounts start INACTIVE (0 wallet balance) — they become ACTIVE once
    // their first deposit is approved and can log in the whole time either way.
    const info = db.prepare(`
      INSERT INTO users (user_code, name, email, password, role, sponsor_id, parent_id, position, wallet_balance, status)
      VALUES (?, ?, ?, ?, 'user', ?, ?, ?, 0, 'inactive')
    `).run(userCode, name, email, hashed, sponsor.id, slot.parent_id, slot.position);

    // Every new member must set up Google Authenticator (TOTP) before they can log
    // in for the first time — this setupToken is the only thing that lets the
    // frontend call the /totp endpoints below without already being logged in.
    const setupToken = issueSetupToken(info.lastInsertRowid);

    res.json({
      message: 'Registration successful',
      userId: info.lastInsertRowid,
      userCode,
      placedUnder: slot.parent_id,
      position: slot.position,
      setupToken
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during registration' });
  }
});

// ---------- 2FA (GOOGLE AUTHENTICATOR) SETUP ----------
// Used right after registration (setupToken, no login yet) and from the Profile
// page for existing accounts that haven't enabled 2FA yet (normal auth token).
router.post('/totp/setup-init', async (req, res) => {
  try {
    const { setupToken } = req.body;
    let userId;
    if (setupToken) {
      const decoded = jwt.verify(setupToken, process.env.JWT_SECRET);
      if (decoded.scope !== 'totp-setup') return res.status(403).json({ error: 'Invalid setup token' });
      userId = decoded.id;
    } else {
      const header = req.headers['authorization'];
      const token = header && header.split(' ')[1];
      if (!token) return res.status(401).json({ error: 'No token provided' });
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      userId = decoded.id;
    }
    const user = db.prepare('SELECT id, user_code, email, totp_secret, totp_enabled FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'Account not found' });
    if (user.totp_enabled) return res.status(400).json({ error: '2FA is already enabled on this account' });

    const setup = await buildTotpSetupResponse(user);
    res.json(setup);
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(403).json({ error: 'Setup link expired. Please log in again to retry.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Confirms the 6-digit code from the authenticator app and turns 2FA on.
router.post('/totp/setup-confirm', (req, res) => {
  try {
    const { setupToken, code } = req.body;
    let userId;
    if (setupToken) {
      const decoded = jwt.verify(setupToken, process.env.JWT_SECRET);
      if (decoded.scope !== 'totp-setup') return res.status(403).json({ error: 'Invalid setup token' });
      userId = decoded.id;
    } else {
      const header = req.headers['authorization'];
      const token = header && header.split(' ')[1];
      if (!token) return res.status(401).json({ error: 'No token provided' });
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      userId = decoded.id;
    }
    const user = db.prepare('SELECT id, totp_secret FROM users WHERE id = ?').get(userId);
    if (!user || !user.totp_secret) return res.status(400).json({ error: 'Start 2FA setup first' });
    if (!verifyToken(code, user.totp_secret)) return res.status(400).json({ error: 'Incorrect or expired code. Try again.' });

    db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(user.id);
    res.json({ message: '2FA enabled successfully. You can now log in.' });
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(403).json({ error: 'Setup link expired. Please log in again to retry.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------- LOGIN ----------
// Members log in with their Bee AI Verse User ID (e.g. BAV01). Email is still accepted
// as a fallback so the admin account (seeded with an email, no memorized User ID) keeps working.
router.post('/login', (req, res) => {
  try {
    const { loginId, email, password } = req.body;
    const identifier = (loginId || email || '').trim();
    if (!identifier || !password) return res.status(400).json({ error: 'User ID and password required' });

    const user = db.prepare('SELECT * FROM users WHERE user_code = ? COLLATE NOCASE OR email = ? COLLATE NOCASE').get(identifier, identifier);
    if (!user) return res.status(400).json({ error: 'Invalid User ID or password' });

    // Only BLOCKED accounts are refused login. INACTIVE is just a wallet/earning
    // state (new signup, or balance dropped to 0) — those members can still log
    // in, they just won't be ACTIVE (earning/referral-eligible) until they top up.
    if (user.status === 'blocked') return res.status(403).json({ error: 'Account is blocked. Contact admin.' });

    const match = bcrypt.compareSync(password, user.password);
    if (!match) return res.status(400).json({ error: 'Invalid User ID or password' });

    // Admin accounts may only sign in from an allow-listed IP (configured on the
    // Admin Security page). Checked here, before 2FA, so a blocked IP never even
    // gets to try a code.
    if (user.role === 'admin' && process.env.NODE_ENV === 'production' && isRestrictionEnabled()) {
      const allowed = getAllowedIps();
      const clientIp = getClientIp(req);
      if (allowed.length > 0 && !allowed.includes(clientIp)) {
        return res.status(403).json({ error: 'Admin login is not allowed from this network.' });
      }
    }

    // ALL accounts (admin and regular users) must complete 2FA setup before they
    // can log in. If a user registered but closed the tab before scanning the QR
    // code, we force them back through setup here. Once 2FA is enabled it cannot
    // be disabled from the UI, so any successfully logged-in user always has it.
    if (!user.totp_enabled) {
      return res.json({ force2faSetup: true, setupToken: issueSetupToken(user.id) });
    }

    // 2FA is confirmed enabled — require the TOTP code before issuing a session.
    return res.json({ mfaRequired: true, mfaToken: issueMfaToken(user.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// ---------- LOGIN STEP 2: VERIFY 2FA CODE ----------
router.post('/login/verify-2fa', (req, res) => {
  try {
    const { mfaToken, code } = req.body;
    if (!mfaToken || !code) return res.status(400).json({ error: 'Code required' });

    let decoded;
    try {
      decoded = jwt.verify(mfaToken, process.env.JWT_SECRET);
    } catch (e) {
      return res.status(403).json({ error: 'Login session expired. Please log in again.' });
    }
    if (decoded.scope !== 'mfa') return res.status(403).json({ error: 'Invalid session' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id);
    if (!user || user.status === 'blocked') return res.status(403).json({ error: 'Account unavailable' });
    if (!verifyToken(code, user.totp_secret)) return res.status(400).json({ error: 'Incorrect or expired code' });

    const token = issueLoginToken(user);
    res.json({ token, user: loginPayload(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
