const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { findOpenSlot } = require('../utils/placement');
const { sanitizeName, sanitizeText } = require('../utils/sanitize');
require('dotenv').config();

const router = express.Router();

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
    const { name: rawName, email, phone: rawPhone, password, sponsorCode, sponsorEmail, side } = req.body;
    const sponsorLookup = (sponsorCode || sponsorEmail || '').trim();
    const name = sanitizeName(rawName);
    const phone = sanitizeText(rawPhone, 30);

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
      INSERT INTO users (user_code, name, email, phone, password, role, sponsor_id, parent_id, position, wallet_balance, status)
      VALUES (?, ?, ?, ?, ?, 'user', ?, ?, ?, 0, 'inactive')
    `).run(userCode, name, email, phone, hashed, sponsor.id, slot.parent_id, slot.position);

    res.json({
      message: 'Registration successful',
      userId: info.lastInsertRowid,
      userCode,
      placedUnder: slot.parent_id,
      position: slot.position
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during registration' });
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

    const token = jwt.sign(
      { id: user.id, userCode: user.user_code, email: user.email, role: user.role, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: { id: user.id, userCode: user.user_code, name: user.name, email: user.email, role: user.role, wallet_balance: user.wallet_balance }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during login' });
  }
});

module.exports = router;
