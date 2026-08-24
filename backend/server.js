const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();
require('./db'); // initializes DB + seeds admin

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const adminRoutes = require('./routes/admin');
const { isRestrictionEnabled, getAllowedIps, getClientIp } = require('./utils/adminIp');

const app = express();

// Railway (and most PaaS hosts) sit behind multiple reverse proxy layers —
// setting trust proxy to `true` makes req.ip reflect the real client IP from
// the leftmost (outermost) entry in X-Forwarded-For, which is what Railway sets.
// Previously set to `1` (trust only 1 hop), but Railway's infrastructure uses
// more than one internal hop, causing req.ip to resolve to a Railway-internal
// address instead of the real visitor IP — which broke IP allowlist matching.
app.set('trust proxy', true);

// contentSecurityPolicy is off because this frontend uses plain inline
// onclick="..." handlers and inline style="..." attributes throughout
// (admin.html alone has 25+) — helmet's default CSP blocks both of those
// and would silently break buttons and layout. Every other helmet
// protection (clickjacking, MIME-sniffing, etc.) stays on.
app.use(helmet({ contentSecurityPolicy: false }));

// Lock CORS down to your real frontend origin(s) in production. Set
// FRONTEND_ORIGIN in Railway to your deployed URL (comma-separate for more
// than one, e.g. your Railway domain + a custom domain). Falls back to
// allow-all only when FRONTEND_ORIGIN isn't set, so local dev keeps working.
const allowedOrigins = (process.env.FRONTEND_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors(allowedOrigins.length ? {
  origin: allowedOrigins,
} : {}));

app.use(express.json());

// Basic brute-force / spam throttle on auth endpoints (login, register,
// placement-preview). Tune via env if needed; defaults are generous enough
// for normal use but stop rapid automated guessing.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/auth', authLimiter);

// Public IP echo endpoint — lets the admin verify exactly which IP the
// server sees for their request. Useful when debugging IP allowlist issues
// (e.g. confirming the correct IP is whitelisted after a proxy change).
// No auth required so it works even before login.
app.get('/api/my-ip', (req, res) => {
  res.json({ ip: getClientIp(req) });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/admin', adminRoutes);

// Gate the admin panel HTML pages themselves by IP, not just the API — so a
// blocked network can't even load beeadmin-*.html to try logging in.
// (Renamed off the guessable "admin.html"/"admin-*.html" pattern to beeadmin-*.)
app.get(/^\/beeadmin-[a-z0-9-]+\.html$/, (req, res, next) => {
  if (process.env.NODE_ENV !== 'production' || !isRestrictionEnabled()) return next();
  const allowed = getAllowedIps();
  if (allowed.length === 0 || allowed.includes(getClientIp(req))) return next();
  return res.status(403).send('Access denied from this network.');
});

// Serve frontend static files
app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
