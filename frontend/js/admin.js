// ---------- ADMIN USERS PAGE ----------
// Powers admin-users.html: loads the members table and handles the
// single/bulk wallet balance adjustment form.
// NOTE: escapeHtml() is defined in api.js (loaded before this file).

let allAdminUsers = [];

async function loadAdminUsers() {
  const tbody = document.getElementById('usersTableBody');
  tbody.innerHTML = `<tr><td colspan="9" class="msg">Loading...</td></tr>`;

  try {
    const users = await apiRequest('/admin/users');
    allAdminUsers = users;
    renderUsersTable(users);
    populateTargetUserDropdown(users);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" class="msg error">${err.message}</td></tr>`;
  }
}

function renderUsersTable(users) {
  const tbody = document.getElementById('usersTableBody');
  if (!users.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="msg">No users found</td></tr>`;
    return;
  }

  tbody.innerHTML = users.map(u => `
    <tr>
      <td style="padding:10px">${escapeHtml(u.user_code)}<br><span style="font-size:11.5px;color:var(--muted)">#${u.id}</span></td>
      <td style="padding:10px">${escapeHtml(u.name)}<br><span style="font-size:12px;color:var(--text-dim)">${escapeHtml(u.email)}</span></td>
      <td style="padding:10px">${escapeHtml(u.sponsor_code) || '—'}</td>
      <td style="padding:10px" id="mainWallet-${u.id}">${usdt(u.main_wallet)}</td>
      <td style="padding:10px" id="referralWallet-${u.id}">${usdt(u.referral_wallet)}</td>
      <td style="padding:10px" id="totalWallet-${u.id}">${usdt(u.wallet_balance)}</td>
      <td style="padding:10px">
        ${u.is_capped
          ? `<span class="gen-status inactive" title="Cap reached (${usdt(u.cap_used)} / ${usdt(u.cap_ceiling)}) — needs a redeposit to earn more">Capped</span>`
          : `<span style="font-size:12px;color:var(--text-dim)">${usdt(u.cap_used)} / ${usdt(u.cap_ceiling)}</span>`
        }
      </td>
      <td style="padding:10px"><span class="gen-status ${u.status === 'active' ? 'active' : 'inactive'}">${escapeHtml(u.status)}</span></td>
      <td style="padding:10px">
        ${u.status === 'blocked'
          ? `<button class="btn-primary" style="padding:6px 12px;font-size:12.5px" onclick="unblockUser(${u.id})">Unblock</button>`
          : `<button class="btn-primary" style="padding:6px 12px;font-size:12.5px;background:#a33" onclick="blockUser(${u.id})">Block</button>`
        }
      </td>
    </tr>
  `).join('');

  replayMotion('#usersTableBody');
}

function populateTargetUserDropdown(users) {
  const select = document.getElementById('adjustTargetUser');
  const current = select.value;
  select.innerHTML = `<option value="all">All Non-Admin Users</option>` +
    users.map(u => `<option value="${u.id}">${escapeHtml(u.user_code)} — ${escapeHtml(u.name)}</option>`).join('');
  if (current) select.value = current;
}

async function blockUser(id) {
  if (!confirm('Block this user?')) return;
  try {
    await apiRequest(`/admin/users/${id}/block`, 'PUT');
    toast('User blocked');
    loadAdminUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function unblockUser(id) {
  try {
    await apiRequest(`/admin/users/${id}/unblock`, 'PUT');
    toast('User unblocked');
    loadAdminUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------- BALANCE ADJUSTMENT ----------
// Percentage profit only, main wallet only — fixed-amount and referral-wallet
// adjustment options were removed from this form (level income only ever
// cascades from percentage-mode profit, so this keeps the page from being
// used in a way that silently skips the level-income distribution).
async function handleBalanceAdjustment(event) {
  event.preventDefault();

  const targetUserId = document.getElementById('adjustTargetUser').value;
  const walletType = 'main';
  const mode = 'percentage';
  const value = document.getElementById('adjustValue').value;
  const msgEl = document.getElementById('adjustMsg');

  msgEl.textContent = 'Applying...';
  msgEl.className = 'msg';

  try {
    let result;

    if (targetUserId !== 'all') {
      // Single user -> use /admin/adjust-balance
      result = await apiRequest('/admin/adjust-balance', 'POST', {
        userId: Number(targetUserId),
        targetWallet: walletType,
        mode,
        value
      });
    } else {
      // Bulk (all users) -> use /admin/adjust-balances
      result = await apiRequest('/admin/adjust-balances', 'POST', {
        mode,
        value,
        walletType,
        targetUserId
      });
    }

    msgEl.textContent = result.message || 'Adjustment applied';
    msgEl.className = 'msg success';
    document.getElementById('adjustBalanceForm').reset();

    // Refresh the table so the new balances actually show up
    await loadAdminUsers();
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.className = 'msg error';
  }
}
