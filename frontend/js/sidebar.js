// Renders the sidebar (desktop) and mobile top navbar.
// Call renderSidebar('dashboard', 'user') or renderSidebar('overview', 'admin')

const USER_NAV = [
  { key: 'dashboard',      href: 'dashboard.html',      icon: '⌂', label: 'Home' },
  { key: 'deposit',        href: 'deposit.html',         icon: '⬆', label: 'Deposit' },
  { key: 'withdraw',       href: 'withdraw.html',        icon: '⬇', label: 'Withdraw' },
  { key: 'wallet-history', href: 'wallet-history.html',  icon: '≡', label: 'Wallet History' },
  { key: 'level-income',   href: 'level-income.html',    icon: '◉', label: 'Level Income' },
  { key: 'direct-team',    href: 'direct-team.html',     icon: '⬡', label: 'Direct Team' },
  { key: 'genealogy',      href: 'genealogy.html',       icon: '◈', label: 'Genealogy' },
  { key: 'profile',        href: 'profile.html',         icon: '●', label: 'Profile' },
  { key: 'support',        href: 'support.html',         icon: '✦', label: 'Support' },
];

const ADMIN_NAV = [
  { key: 'overview',    href: 'admin.html',            icon: '⌂', label: 'Overview' },
  { key: 'users',       href: 'admin-users.html',      icon: '⬡', label: 'Users' },
  { key: 'business',    href: 'admin-business.html',   icon: '⬢', label: 'Business' },
  { key: 'deposits',    href: 'admin-deposits.html',   icon: '⬆', label: 'Deposits' },
  { key: 'withdrawals',      href: 'admin-withdrawals.html',           icon: '⬇', label: 'Withdrawals' },
  { key: 'bulk-process',    href: 'admin-processing-withdrawals.html', icon: '⚡', label: 'Bulk Process' },
  { key: 'notifications', href: 'admin-notifications.html', icon: '🔔', label: 'Notifications' },
  { key: 'reports',     href: 'admin-reports.html',    icon: '◆', label: 'Reports' },
  { key: 'db-viewer',   href: 'admin-db-viewer.html',  icon: '⛁', label: 'DB Viewer' },
  { key: 'support',     href: 'admin-support.html',    icon: '✦', label: 'Support' },
];

const BEE_SVG = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="12" cy="13.5" rx="5.5" ry="6.5" stroke="currentColor" stroke-width="1.6"/>
  <path d="M6.8 11h10.4M6.5 14h11M7.2 17h9.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  <circle cx="12" cy="5.2" r="2.4" stroke="currentColor" stroke-width="1.6"/>
  <path d="M10.3 3.2 9 1.6M13.7 3.2 15 1.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
  <path d="M5.5 10c-2.4-1.4-3.6-.2-3.6 1.6 0 1.8 2 2.4 3.6.9" stroke="currentColor" stroke-width="1.3" opacity="0.7"/>
  <path d="M18.5 10c2.4-1.4 3.6-.2 3.6 1.6 0 1.8-2 2.4-3.6.9" stroke="currentColor" stroke-width="1.3" opacity="0.7"/>
</svg>`;

// Bell (outline) icon used for the notifications button — inherits currentColor.
const BELL_SVG = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M18 8.5c0-3.5-2.7-6.2-6-6.2s-6 2.7-6 6.2c0 5.4-2 7-2 7h16s-2-1.6-2-7Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
  <path d="M10 19a2 2 0 0 0 4 0" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
</svg>`;

function notifBellHTML(idSuffix) {
  return `
    <div class="notif-bell-wrap">
      <button class="notif-bell-btn" id="notifBell${idSuffix}" aria-label="Notifications" onclick="toggleNotifPanel(this)">
        ${BELL_SVG}
        <span class="notif-bell-badge" id="notifBadge${idSuffix}">0</span>
      </button>
    </div>
  `;
}

function renderSidebar(activeKey, mode) {
  const nav = mode === 'admin' ? ADMIN_NAV : USER_NAV;
  const user = getUser() || { name: 'Guest', role: mode };
  const initials = (user.name || 'U').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const brandName = 'Bee AI Verse';
  const isMobile = window.innerWidth <= 860;
  const collapsed = isMobile ? false : (localStorage.getItem('sidebar_collapsed') === 'true');
  const showBell = mode !== 'admin'; // notification bell is a member-facing feature

  // ── DESKTOP SIDEBAR ───────────────────────────────────────────────────────
  const sidebarHTML = `
    <div class="sidebar ${collapsed ? 'collapsed' : ''}" id="sidebarEl">
      <div class="sidebar-top">
        <div class="hamburger" id="hamburgerBtn"><span></span><span></span><span></span></div>
        <div class="sidebar-bot-badge">${BEE_SVG}</div>
        <div class="sidebar-brand">${brandName}</div>
      </div>
      <nav class="sidebar-nav">
        ${showBell ? `
          <a class="sidebar-link" href="#" onclick="toggleNotifPanel(this); return false;" style="position:relative">
            <span class="ic" style="position:relative">🔔<span class="notif-bell-badge" id="notifBadgeDesktop" style="position:absolute;top:-6px;right:-9px">0</span></span>
            <span class="label">Notifications</span>
          </a>
        ` : ''}
        ${nav.map(item => `
          <a class="sidebar-link ${item.key === activeKey ? 'active' : ''}" href="${item.href}">
            <span class="ic">${item.icon}</span><span class="label">${item.label}</span>
          </a>
        `).join('')}
      </nav>
      <div class="sidebar-bottom">
        <div class="sidebar-status"><span class="pulse-dot"></span> AI Network Online</div>
        <div class="sidebar-user">
          <div class="avatar">${initials}</div>
          <div class="info">
            <div class="n">${user.name || 'User'}</div>
            <div class="r">${mode === 'admin' ? 'Administrator' : 'Member'}</div>
          </div>
        </div>
        <a class="sidebar-link" href="#" onclick="logout(); return false;">
          <span class="ic">⏻</span><span class="label">Logout</span>
        </a>
      </div>
    </div>
  `;

  // ── MOBILE TOP NAVBAR ─────────────────────────────────────────────────────
  // Logout button lives here in top-right — always visible, no drawer needed.
  const mobileNavbarHTML = `
    <div class="mobile-navbar" id="mobileNavbar">
      <button class="mob-hamburger" id="mobHamburgerBtn" aria-label="Open menu">
        <span></span><span></span><span></span>
      </button>
      <div class="mob-logo-wrap">
        <span class="mob-logo-icon">${BEE_SVG}</span>
        <span class="mob-brand">${brandName}</span>
      </div>
      ${showBell ? notifBellHTML('Mobile') : ''}
      <button class="mob-logout-btn" onclick="logout(); return false;" aria-label="Logout">
        <span class="mob-logout-icon">⏻</span>
        <span class="mob-logout-label">Logout</span>
      </button>
    </div>
  `;

  // ── MOBILE DRAWER (slides in from left) ───────────────────────────────────
  // Separate from desktop sidebar; only rendered on mobile.
  const drawerHTML = `
    <div class="mob-drawer" id="mobDrawer">
      <div class="mob-drawer-head">
        <div class="mob-drawer-user">
          <div class="avatar">${initials}</div>
          <div class="info">
            <div class="n">${user.name || 'User'}</div>
            <div class="r">${mode === 'admin' ? 'Administrator' : 'Member'}</div>
          </div>
        </div>
        <button class="mob-drawer-close" id="mobDrawerClose" aria-label="Close menu">✕</button>
      </div>
      <nav class="mob-drawer-nav">
        ${nav.map(item => `
          <a class="mob-drawer-link ${item.key === activeKey ? 'active' : ''}" href="${item.href}">
            <span class="ic">${item.icon}</span><span>${item.label}</span>
          </a>
        `).join('')}
      </nav>
      <div class="mob-drawer-footer">
        <div class="sidebar-status"><span class="pulse-dot"></span> AI Network Online</div>
      </div>
    </div>
  `;

  // ── OVERLAY ───────────────────────────────────────────────────────────────
  const overlayHTML = `<div class="sidebar-overlay" id="sidebarOverlay"></div>`;

  // Replace sidebar-root with desktop sidebar
  document.getElementById('sidebar-root').outerHTML = sidebarHTML;

  // Inject mobile pieces once
  if (!document.getElementById('mobileNavbar')) {
    document.body.insertAdjacentHTML('afterbegin', mobileNavbarHTML);
  }
  if (!document.getElementById('mobDrawer')) {
    document.body.insertAdjacentHTML('afterbegin', drawerHTML);
  }
  if (!document.getElementById('sidebarOverlay')) {
    document.body.insertAdjacentHTML('afterbegin', overlayHTML);
  }

  // Shared notifications dropdown panel (single instance, anchored to
  // whichever bell button — desktop sidebar or mobile navbar — was clicked).
  if (showBell && !document.getElementById('notifPanel')) {
    document.body.insertAdjacentHTML('beforeend', `
      <div class="notif-panel" id="notifPanel">
        <div class="notif-panel-head">
          <h4>Notifications</h4>
          <button class="notif-panel-markall" id="notifMarkAllBtn" onclick="markAllNotifRead()">Mark all read</button>
        </div>
        <div class="notif-panel-list" id="notifPanelList">
          <div class="notif-panel-empty">Loading…</div>
        </div>
      </div>
    `);
    document.addEventListener('click', (e) => {
      const panel = document.getElementById('notifPanel');
      if (!panel || !panel.classList.contains('open')) return;
      const clickedBell = e.target.closest('.notif-bell-btn, .sidebar-link[onclick*="toggleNotifPanel"]');
      if (!panel.contains(e.target) && !clickedBell) panel.classList.remove('open');
    });
  }
  if (showBell) {
    loadNotifications();
    if (!window._notifPollStarted) {
      window._notifPollStarted = true;
      setInterval(loadNotifications, 30000);
    }
  }

  // ── DRAWER OPEN / CLOSE ───────────────────────────────────────────────────
  function openDrawer() {
    const drawer = document.getElementById('mobDrawer');
    const overlay = document.getElementById('sidebarOverlay');
    if (drawer)  drawer.classList.add('open');
    if (overlay) { overlay.classList.add('visible'); overlay.style.pointerEvents = 'auto'; }
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
  }

  function closeDrawer() {
    const drawer = document.getElementById('mobDrawer');
    const overlay = document.getElementById('sidebarOverlay');
    if (drawer)  drawer.classList.remove('open');
    if (overlay) { overlay.classList.remove('visible'); overlay.style.pointerEvents = 'none'; }
    document.body.style.overflow = '';
    document.documentElement.style.overflow = '';
  }

  // Mobile hamburger → opens drawer
  const mobBtn = document.getElementById('mobHamburgerBtn');
  if (mobBtn) mobBtn.addEventListener('click', openDrawer);

  // Drawer close button
  const closeBtn = document.getElementById('mobDrawerClose');
  if (closeBtn) closeBtn.addEventListener('click', closeDrawer);

  // Overlay click closes drawer
  const overlay = document.getElementById('sidebarOverlay');
  if (overlay) overlay.addEventListener('click', closeDrawer);

  // Nav link tap closes drawer before navigating
  document.querySelectorAll('#mobDrawer .mob-drawer-link').forEach(link => {
    link.addEventListener('click', closeDrawer);
  });

  // ── DESKTOP SIDEBAR TOGGLE ────────────────────────────────────────────────
  const hamburgerBtn = document.getElementById('hamburgerBtn');
  if (hamburgerBtn) {
    hamburgerBtn.addEventListener('click', () => {
      const el = document.getElementById('sidebarEl');
      if (!el) return;
      el.classList.toggle('collapsed');
      localStorage.setItem('sidebar_collapsed', el.classList.contains('collapsed'));
    });
  }

  // ── RESIZE ────────────────────────────────────────────────────────────────
  window.addEventListener('resize', () => {
    if (window.innerWidth > 860) {
      closeDrawer();
      const el = document.getElementById('sidebarEl');
      if (el) {
        const stored = localStorage.getItem('sidebar_collapsed') === 'true';
        el.classList.toggle('collapsed', stored);
      }
    }
  });
}

// ---------- NOTIFICATIONS (member bell) ----------
// NOTE: relies on apiRequest()/escapeHtml() from api.js and toast() being
// loaded before this file, which is true on every page that renders the sidebar.

let _notifCache = [];

function timeAgo(dateStr) {
  const then = new Date(dateStr.replace(' ', 'T') + 'Z').getTime();
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(dateStr.replace(' ', 'T') + 'Z').toLocaleDateString();
}

async function loadNotifications() {
  try {
    const data = await apiRequest('/user/notifications');
    _notifCache = data.notifications || [];
    updateNotifBadges(data.unreadCount || 0);
    renderNotifPanelList();
  } catch (err) {
    // Silent — the bell just stays at its last-known state (e.g. token expired,
    // page about to redirect to login anyway).
  }
}

function updateNotifBadges(count) {
  ['notifBadgeDesktop', 'notifBadgeMobile'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = count > 99 ? '99+' : String(count);
    el.classList.toggle('show', count > 0);
  });
  const markAllBtn = document.getElementById('notifMarkAllBtn');
  if (markAllBtn) markAllBtn.disabled = count === 0;
}

function renderNotifPanelList() {
  const list = document.getElementById('notifPanelList');
  if (!list) return;
  if (!_notifCache.length) {
    list.innerHTML = `<div class="notif-panel-empty">You're all caught up — no notifications yet.</div>`;
    return;
  }
  list.innerHTML = _notifCache.map(n => `
    <div class="notif-item ${n.is_read ? '' : 'unread'}" onclick="markNotifRead(${n.id})">
      <div class="notif-item-top">
        <span class="notif-dot ${n.is_read ? 'hidden' : ''}"></span>
        <span class="notif-item-title">${escapeHtml(n.title)}</span>
      </div>
      <div class="notif-item-msg">${escapeHtml(n.message)}</div>
      <div class="notif-item-time">${timeAgo(n.created_at)}</div>
    </div>
  `).join('');
}

function toggleNotifPanel(anchorEl) {
  const panel = document.getElementById('notifPanel');
  if (!panel) return;
  const isOpen = panel.classList.contains('open');
  if (isOpen) {
    panel.classList.remove('open');
    return;
  }
  // Anchor the shared panel just below whichever bell was clicked.
  const rect = anchorEl.getBoundingClientRect();
  const panelWidth = Math.min(360, window.innerWidth * 0.88);
  let left = rect.right - panelWidth;
  left = Math.max(10, Math.min(left, window.innerWidth - panelWidth - 10));
  panel.style.left = `${left}px`;
  panel.style.right = 'auto';
  panel.style.top = `${rect.bottom + 8}px`;
  panel.classList.add('open');
  loadNotifications();
}

async function markNotifRead(id) {
  const notif = _notifCache.find(n => n.id === id);
  if (notif && !notif.is_read) {
    notif.is_read = 1;
    renderNotifPanelList();
    updateNotifBadges(_notifCache.filter(n => !n.is_read).length);
    try {
      await apiRequest(`/user/notifications/${id}/read`, 'PUT');
    } catch (err) {
      // Best-effort — badge will resync on the next poll either way.
    }
  }
}

async function markAllNotifRead() {
  if (!_notifCache.some(n => !n.is_read)) return;
  _notifCache.forEach(n => (n.is_read = 1));
  renderNotifPanelList();
  updateNotifBadges(0);
  try {
    await apiRequest('/user/notifications/read-all', 'PUT');
  } catch (err) {
    toast('Could not sync read status', 'error');
  }
}
