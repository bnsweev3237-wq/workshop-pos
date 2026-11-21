(function () {
  const $ = (id) => document.getElementById(id);
  let me = null;
  let availablePlans = [];

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) throw Object.assign(new Error((data && data.message) || 'Request failed'), { data, status: res.status });
    return data;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB';
    return (n / 1024 ** 3).toFixed(1) + ' GB';
  }

  function showLoginError(msg) {
    const box = $('loginError');
    box.textContent = msg;
    box.hidden = false;
  }

  $('loginSubmit').onclick = async () => {
    $('loginError').hidden = true;
    const username = $('username').value.trim();
    const password = $('password').value;
    if (!username || !password) { showLoginError('Enter a username and password.'); return; }
    try {
      const data = await api('POST', '/api/platform/admin/login', { username, password });
      me = data.me;
      afterLogin();
    } catch (e) {
      showLoginError((e.data && e.data.message) || 'Invalid username or password.');
    }
  };

  $('logoutBtn').onclick = async () => {
    try { await api('POST', '/api/platform/admin/logout'); } catch { /* reload either way */ }
    location.reload();
  };

  function afterLogin() {
    $('adminLoginScreen').hidden = true;
    $('adminApp').hidden = false;
    $('meLine').textContent = `Signed in as ${me.username} (${me.role})`;
    const isAdmin = me.role === 'admin';
    $('updateCard').hidden = !isAdmin;
    $('staffCard').hidden = !isAdmin;
    $('mailCard').hidden = !isAdmin;
    $('createTenantCard').hidden = !isAdmin;
    loadTenants();
    if (isAdmin) { loadUpdateStatus(); loadStaff(); loadMailSettings(); }
  }

  async function loadTenants() {
    if (me.role === 'admin' && !availablePlans.length) {
      try { availablePlans = await api('GET', '/api/platform/admin/plans'); } catch { /* fall back to plain text below */ }
    }
    const tenants = await api('GET', '/api/platform/admin/tenants');
    const tb = $('tenantRows');
    tb.innerHTML = '';
    for (const t of tenants) {
      const tr = document.createElement('tr');
      const planCell = (me.role === 'admin' && availablePlans.length)
        ? `<div class="plan-cell"><select class="plan-select">${availablePlans.map((p) => `<option value="${esc(p)}" ${p === t.plan ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select><button class="btn sm plan-apply">Set</button></div>`
        : esc(t.plan);
      const isSuspended = t.status === 'suspended';
      const statusBtn = me.role === 'admin'
        ? `<button class="btn sm ${isSuspended ? '' : 'danger'} toggle-status">${isSuspended ? 'Activate' : 'Suspend'}</button>`
        : '';
      tr.innerHTML = `
        <td>${esc(t.slug)}</td>
        <td>${esc(t.businessName)}</td>
        <td><span class="status${isSuspended ? ' danger' : ''}">${esc(t.status)}</span></td>
        <td>${planCell}</td>
        <td>${new Date(t.createdAt).toLocaleDateString()}</td>
        <td class="disk-usage"><div class="total">${formatBytes(t.dbBytes)} db, ${formatBytes(t.backupBytes)} backups</div><div class="hint">${formatBytes(t.photoBytes)} photos, included in db</div></td>
        <td class="acts"><button class="btn sm open-tenant">Open</button> <button class="btn sm reset-password">Reset password</button> ${statusBtn}</td>
      `;
      tr.querySelector('.open-tenant').onclick = () => openTenant(t.id, t.slug);
      tr.querySelector('.reset-password').onclick = () => resetTenantPassword(t.id, t.slug);
      const applyBtn = tr.querySelector('.plan-apply');
      if (applyBtn) {
        applyBtn.onclick = async () => {
          const plan = tr.querySelector('.plan-select').value;
          applyBtn.disabled = true;
          try { await api('POST', `/api/platform/admin/tenants/${t.id}/plan`, { plan }); }
          catch (e) { alert(e.message || 'Could not change that tenant\'s plan.'); }
          applyBtn.disabled = false;
        };
      }
      const toggleBtn = tr.querySelector('.toggle-status');
      if (toggleBtn) {
        toggleBtn.onclick = async () => {
          const next = isSuspended ? 'active' : 'suspended';
          if (next === 'suspended' && !confirm(`Suspend "${t.businessName}" (${t.slug})? They won't be able to sign in until reactivated.`)) return;
          toggleBtn.disabled = true;
          try { await api('POST', `/api/platform/admin/tenants/${t.id}/status`, { status: next }); loadTenants(); }
          catch (e) { alert(e.message || 'Could not change that tenant\'s status.'); toggleBtn.disabled = false; }
        };
      }
      tb.appendChild(tr);
    }
    $('tenantsEmpty').hidden = tenants.length > 0;
  }

  async function openTenant(id, slug) {
    try {
      const { url } = await api('POST', `/api/platform/admin/tenants/${id}/impersonate`, {});
      window.open(url, '_blank');
    } catch (e) {
      alert(e.message || `Could not open ${slug}.`);
    }
  }

  async function resetTenantPassword(id, slug) {
    const username = prompt(`Reset which account's password on "${slug}"? Enter their username:`);
    if (!username) return;
    const newPassword = prompt(`New password for "${username}" on "${slug}" (min 8 characters). They'll be asked to change it on next sign-in.`);
    if (!newPassword) return;
    try {
      await api('POST', `/api/platform/admin/tenants/${id}/reset-password`, { username, newPassword });
      alert(`Password reset for "${username}" on ${slug}.`);
    } catch (e) {
      alert(e.message || 'Could not reset that password.');
    }
  }

  async function loadUpdateStatus() {
    $('updateCheckBtn').disabled = true;
    try {
      const s = await api('GET', '/api/platform/admin/update/check');
      if (s.available) {
        $('updateStatusLine').textContent = `Update available: v${s.currentVersion} → v${s.latestVersion} (${s.commitsBehind} commit${s.commitsBehind === 1 ? '' : 's'} behind).`;
        $('updateApplyBtn').hidden = false;
      } else {
        $('updateStatusLine').textContent = `Up to date (v${s.currentVersion}).`;
        $('updateApplyBtn').hidden = true;
      }
    } catch {
      $('updateStatusLine').textContent = 'Could not check for updates.';
    } finally {
      $('updateCheckBtn').disabled = false;
    }
  }
  $('updateCheckBtn').onclick = loadUpdateStatus;
  $('updateApplyBtn').onclick = async () => {
    if (!confirm('Pull the latest code and restart the platform now? Every tenant will briefly disconnect while it restarts.')) return;
    $('updateApplyBtn').disabled = true;
    $('updateCheckBtn').disabled = true;
    $('updateStatusLine').textContent = 'Updating… this can take a minute.';
    try {
      await api('POST', '/api/platform/admin/update/apply');
      $('updateStatusLine').textContent = 'Restarting…';
    } catch (e) {
      alert(e.message || 'Update failed.');
      $('updateStatusLine').textContent = 'Update failed.';
      $('updateApplyBtn').disabled = false;
      $('updateCheckBtn').disabled = false;
    }
  };

  async function loadStaff() {
    const staff = await api('GET', '/api/platform/admin/staff');
    const tb = $('staffRows');
    tb.innerHTML = '';
    for (const s of staff) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(s.username)}</td><td>${esc(s.role)}</td><td>${new Date(s.createdAt).toLocaleDateString()}</td><td class="acts"><button class="btn sm danger remove-staff">Remove</button></td>`;
      tr.querySelector('.remove-staff').onclick = async () => {
        if (!confirm(`Remove staff account "${s.username}"?`)) return;
        try { await api('DELETE', `/api/platform/admin/staff/${s.id}`); loadStaff(); }
        catch (e) { alert(e.message || 'Could not remove that account.'); }
      };
      tb.appendChild(tr);
    }
  }
  $('addStaffBtn').onclick = async () => {
    const username = $('newStaffUsername').value.trim();
    const password = $('newStaffPassword').value;
    const role = $('newStaffRole').value;
    if (!username || !password) { alert('Enter a username and password.'); return; }
    try {
      await api('POST', '/api/platform/admin/staff', { username, password, role });
      $('newStaffUsername').value = '';
      $('newStaffPassword').value = '';
      loadStaff();
    } catch (e) { alert(e.message || 'Could not create that account.'); }
  };

  $('createTenantBtn').onclick = async () => {
    const body = {
      slug: $('ctSlug').value.trim(), businessName: $('ctBusinessName').value.trim(),
      ownerName: $('ctOwnerName').value.trim(), username: $('ctUsername').value.trim(),
      password: $('ctPassword').value, email: $('ctEmail').value.trim(),
    };
    if (!body.slug || !body.businessName || !body.username || !body.password || !body.email) {
      $('createTenantHint').textContent = 'Subdomain, business name, username, password, and email are all required.';
      return;
    }
    $('createTenantBtn').disabled = true;
    try {
      const t = await api('POST', '/api/platform/admin/tenants', body);
      $('ctSlug').value = ''; $('ctBusinessName').value = ''; $('ctOwnerName').value = '';
      $('ctUsername').value = ''; $('ctPassword').value = ''; $('ctEmail').value = '';
      $('createTenantHint').textContent = `Created "${t.slug}" — sign in at ${t.loginUrl}`;
      loadTenants();
    } catch (e) {
      $('createTenantHint').textContent = e.message || 'Could not create that tenant.';
    }
    $('createTenantBtn').disabled = false;
  };

  async function loadMailSettings() {
    try {
      const c = await api('GET', '/api/platform/admin/mail-settings');
      $('mailHost').value = c.host || '';
      $('mailPort').value = c.port || '';
      $('mailSecure').checked = !!c.secure;
      $('mailUser').value = c.user || '';
      $('mailFrom').value = c.from || '';
      $('mailNotConfiguredHint').hidden = !!c.configured;
    } catch { /* leave fields as-is */ }
  }
  $('mailSaveBtn').onclick = async () => {
    const body = {
      host: $('mailHost').value, port: $('mailPort').value, secure: $('mailSecure').checked,
      user: $('mailUser').value, password: $('mailPass').value, from: $('mailFrom').value,
    };
    try {
      const c = await api('POST', '/api/platform/admin/mail-settings', body);
      $('mailPass').value = '';
      $('mailNotConfiguredHint').hidden = !!c.configured;
      $('mailStatusHint').textContent = 'Saved.';
    } catch (e) { $('mailStatusHint').textContent = e.message || 'Could not save email settings.'; }
  };
  $('mailTestBtn').onclick = async () => {
    const to = $('mailTestTo').value.trim();
    if (!to) { alert('Enter a recipient address first.'); return; }
    $('mailTestBtn').disabled = true;
    try {
      await api('POST', '/api/platform/admin/mail-settings/test', { to });
      $('mailStatusHint').textContent = `Test email sent to ${to}.`;
    } catch (e) { $('mailStatusHint').textContent = e.message || 'Could not send the test email.'; }
    $('mailTestBtn').disabled = false;
  };

  // Already-logged-in on a return visit — pick up the existing session rather than asking again.
  (async () => {
    try {
      const data = await api('GET', '/api/platform/admin/status');
      if (data.loggedIn) { me = data.me; afterLogin(); }
    } catch { /* not logged in — show the login screen as-is */ }
  })();
})();
