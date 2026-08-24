# 2-Leg Binary MLM Platform (Starter)

Full-stack starter: Node.js + Express + SQLite backend, plain HTML/CSS/JS frontend.

**Requires Node.js 22.5+ (Node 24 recommended)** — this project uses Node's built-in
`node:sqlite` module, so there's nothing to compile and no native build tools needed.
You'll see a one-line `ExperimentalWarning: SQLite is an experimental feature` in the
console when the server starts — that's expected and harmless, not an error.

Features:
- Register / Login (JWT auth)
- 2-leg (binary) tree auto-placement under sponsor (BFS to first open Left/Right slot)
- Dark, glassmorphism UI with a collapsible left sidebar
- User side — separate pages: Home (business snapshot), Deposit + history, Withdraw + history,
  Direct Team (people you personally sponsored), Genealogy (binary tree view), Profile (edit name/phone)
- Admin side — separate pages: Overview, Users (block/unblock), Deposits (approve/reject),
  Withdrawals (approve/reject), Reports (monthly deposit/withdrawal charts, signup growth,
  left/right leg split, top wallet balances)

⚠️ **Important**: MLM/binary-referral platforms that pay members primarily for recruiting
new members (rather than for real product/service sales) can be classified as illegal
pyramid schemes in many jurisdictions. Before deploying this publicly or accepting real
money, review the laws in your country/state and consider consulting a lawyer. This code
is a technical starter only — it doesn't make any income-plan legal.

## Project Structure
```
mlm-app/
├── backend/
│   ├── server.js          # Express app entry
│   ├── db.js               # SQLite schema + admin seed
│   ├── routes/
│   │   ├── auth.js         # register/login
│   │   ├── user.js         # dashboard/tree/deposit/withdraw
│   │   └── admin.js        # admin management endpoints
│   ├── middleware/auth.js  # JWT auth + admin guard
│   ├── utils/placement.js  # binary tree placement logic
│   ├── .env.example
│   └── package.json
└── frontend/
    ├── index.html, login.html, register.html
    ├── dashboard.html (user home), deposit.html, withdraw.html
    ├── direct-team.html, genealogy.html, profile.html
    ├── admin.html (overview), admin-users.html, admin-deposits.html
    ├── admin-withdrawals.html, admin-reports.html
    ├── css/style.css
    └── js/api.js, js/sidebar.js
```

## Steps to run in VS Code

1. **Open the project**
   - Unzip the project folder.
   - In VS Code: `File > Open Folder` → select `mlm-app`.

2. **Install Node.js** (if not already installed)
   - Download from https://nodejs.org (Node 22.5+ required; Node 24 recommended) and install. Verify in VS Code terminal:
     ```
     node -v
     npm -v
     ```

3. **Install backend dependencies**
   - Open a terminal in VS Code (`Terminal > New Terminal`).
     ```
     cd backend
     npm install
     ```

4. **Configure environment variables**
   - Copy `.env.example` to `.env` inside `backend/`:
     ```
     cp .env.example .env        (Mac/Linux)
     copy .env.example .env      (Windows)
     ```
   - Open `.env` and set a strong `JWT_SECRET`, and your desired `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

5. **Run the server**
   ```
   npm start
   ```
   or for auto-reload during development:
   ```
   npm run dev
   ```
   You should see: `Server running on http://localhost:5000`
   (SQLite file `mlm.db` is created automatically in `backend/`, and the admin account is seeded.)

6. **Open the app**
   - Visit `http://localhost:5000` in your browser.
   - Login as admin using the `ADMIN_EMAIL` / `ADMIN_PASSWORD` from your `.env`.
   - Register a normal user — the **first user must give the admin's email as sponsor**
     (or any already-registered user's email) since every user needs a sponsor to be
     placed in the tree.

7. **Test the flow**
   - Register 2–3 users under the admin (or under each other) to see left/right placement.
   - Log in as a user → submit a Deposit request.
   - Log in as admin → approve the deposit → user's wallet is credited.
   - Log in as user → submit a Withdrawal request → check it appears as pending for admin.
   - Log in as admin → approve/reject withdrawal.

## Deployment

### Option A: Hostinger (VPS / Node hosting)
- Push the project to a Hostinger VPS or Node-supported hosting plan.
- Set environment variables (`JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `PORT`) in the hosting panel.
- Run `npm install && npm start` (or configure via PM2 for persistence: `pm2 start server.js`).
- Point your domain to the app's port via the hosting reverse proxy / Node app manager.
- Note: SQLite is file-based — make sure the host allows persistent disk storage (most VPS do; some serverless platforms don't).

### Option B: Netlify (frontend only) + separate backend host
- Netlify serves static sites only — it can't run this Express/SQLite backend.
- Deploy `frontend/` to Netlify as a static site, and deploy `backend/` separately to a
  Node-capable host (Railway, Render, Hostinger VPS, etc.).
- Update `API_BASE` in `frontend/js/api.js` to your deployed backend's full URL, e.g.
  `const API_BASE = 'https://your-backend-domain.com/api';`
- Enable CORS for your Netlify domain (already enabled broadly via `cors()` — restrict it
  to your domain in production for security).

## Security notes before going live
- Change `JWT_SECRET` to a long random string.
- Restrict CORS to your real frontend domain in `server.js`.
- Put the app behind HTTPS.
- Consider moving from SQLite to PostgreSQL/MySQL if you expect concurrent heavy traffic.
- Add rate-limiting on `/api/auth/login` and `/api/auth/register` to prevent abuse.
- This starter credits deposits manually via admin approval (no live payment gateway
  integration) — treat deposit proof as unverified until you check it, or integrate a real
  payment gateway (Razorpay/Stripe/etc.) for automated verification.
