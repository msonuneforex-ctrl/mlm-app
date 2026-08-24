const db = require('../db');

const IP_KEYS = ['admin_allowed_ip_1', 'admin_allowed_ip_2', 'admin_allowed_ip_3', 'admin_allowed_ip_4', 'admin_allowed_ip_5'];

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

function getAllowedIps() {
  return IP_KEYS.map(k => getSetting(k, '').trim()).filter(Boolean);
}

// entries: array of up to 5 strings (IPv4/IPv6). Blank slots are cleared.
function setAllowedIps(entries) {
  const clean = (entries || []).map(s => (s || '').trim()).filter(Boolean).slice(0, 5);
  for (let i = 0; i < IP_KEYS.length; i++) {
    setSetting(IP_KEYS[i], clean[i] || '');
  }
  return clean;
}

function isRestrictionEnabled() {
  return getSetting('admin_ip_restriction_enabled', 'true') === 'true';
}

function setRestrictionEnabled(enabled) {
  setSetting('admin_ip_restriction_enabled', enabled ? 'true' : 'false');
}

// req.ip already reflects the real client IP because server.js sets `trust proxy`.
// Strips the ::ffff: IPv4-mapped-IPv6 prefix Node sometimes adds so plain IPv4
// entries in the allowlist ("103.123.79.96") match as expected.
function getClientIp(req) {
  let ip = req.ip || (req.connection && req.connection.remoteAddress) || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

// Express middleware. Blocks the request unless the client IP is in the allowlist.
// Only enforced when NODE_ENV=production, so local development is never blocked,
// and only enforced while the admin-configured kill switch is on.
function adminIpRestrict(req, res, next) {
  if (process.env.NODE_ENV !== 'production') return next();
  if (!isRestrictionEnabled()) return next();

  const allowed = getAllowedIps();
  if (allowed.length === 0) return next(); // nothing configured yet — don't lock everyone out

  const clientIp = getClientIp(req);
  if (allowed.includes(clientIp)) return next();

  return res.status(403).json({ error: 'Access to the admin panel is not allowed from this network.' });
}

module.exports = { getAllowedIps, setAllowedIps, isRestrictionEnabled, setRestrictionEnabled, getClientIp, adminIpRestrict, IP_KEYS };
