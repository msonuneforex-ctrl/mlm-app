// ---------- HTML ESCAPING ----------
// Any user-supplied text (names, emails, ticket messages, remarks, etc.) must
// go through this before being placed in innerHTML. Registration/profile/
// support-ticket fields are not fully sanitized server-side, so this is the
// last line of defense against stored XSS in anyone's browser, admin included.
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const API_BASE = '/api';

function getToken() { return localStorage.getItem('token'); }
function getUser() { return JSON.parse(localStorage.getItem('user') || 'null'); }
function saveSession(token, user) {
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(user));
}
function clearSession() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
}
function logout() {
  clearSession();
  window.location.href = 'login.html';
}

async function apiRequest(path, method = 'GET', body = null) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(API_BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// Redirect to login if not authenticated (call on protected pages)
function requireAuth() {
  if (!getToken()) window.location.href = 'login.html';
}

function requireAdmin() {
  const user = getUser();
  if (!getToken() || !user || user.role !== 'admin') window.location.href = 'login.html';
}

// ---------- USDT FORMATTING ----------
// Every dollar figure on the platform is USDT; this keeps formatting consistent site-wide.
function usdt(n) {
  const v = Number(n || 0);
  return `${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
}

// ---------- PAGE-LOAD REVEAL ANIMATION ----------
// Staggers a fade-up-in on panels/cards/tree-nodes each time a page loads, so navigation
// between pages feels alive instead of content just popping in. Call once per page.
function initPageMotion() {
  const targets = document.querySelectorAll('.panel, .stat-card, .action-card');
  targets.forEach((el, i) => {
    el.classList.add('reveal');
    el.style.setProperty('--d', `${Math.min(i * 0.06, 0.4)}s`);
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPageMotion);
} else {
  initPageMotion();
}

// Re-run the reveal on a specific container after it's re-rendered dynamically
// (e.g. a table body or the genealogy tree refreshing after a fetch).
function replayMotion(selector) {
  document.querySelectorAll(`${selector} .tree-node, ${selector} .gen-card, ${selector} tr`).forEach((el, i) => {
    el.classList.remove('reveal');
    void el.offsetWidth; // restart animation
    el.classList.add('reveal');
    el.style.setProperty('--d', `${Math.min(i * 0.04, 0.3)}s`);
  });
}

// ---------- ANIMATED NUMBER COUNTER ----------
// Eases a counter element's displayed number from its current value up/down to `to`.
function animateCounter(el, to, formatter = (n) => n.toFixed(2)) {
  if (!el) return;
  const from = parseFloat(el.dataset.raw || '0') || 0;
  const duration = 600;
  const start = performance.now();
  function tick(now) {
    const p = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    const val = from + (to - from) * eased;
    el.textContent = formatter(val);
    if (p < 1) requestAnimationFrame(tick);
    else el.dataset.raw = to;
  }
  requestAnimationFrame(tick);
}

// ---------- HTML ESCAPING ----------
// Use this before interpolating ANY user-supplied text (name, email, ticket
// subject/message, remarks, etc.) into innerHTML. Prevents stored XSS from
// data that originated as free-text input from a user or admin.
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------- TOASTS ----------
function toast(message, type = 'success') {
  let stack = document.getElementById('toastStack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'toastStack';
    document.body.appendChild(stack);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 250);
  }, 3200);
}
