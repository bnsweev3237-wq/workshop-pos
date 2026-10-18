const $ = id => document.getElementById(id);
const money = n => { n = isFinite(n) ? n : 0; return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
const money4 = n => { n = isFinite(n) ? n : 0; return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }); };
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random());

// ---------- API client ----------
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401) { onUnauthorized(); const e = new Error('not_logged_in'); e.code = 'not_logged_in'; throw e; }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) { const e = new Error((data && data.message) || res.statusText); e.code = data && data.error; throw e; }
  return data;
}

// ---------- Auth state ----------
// Every page requires a login now — there's no anonymous Sell-page access anymore. Role is
// the only thing that changes what's reachable: cashiers get the Sell page only, admins get
// everything. The server enforces this independently (see server/middleware/auth.js); this
// is just the UI following suit so cashiers aren't shown buttons that would 403.
let me = null;
let needsSetup = false;
let pendingTab = null;
let currentTab = 'pos';
const ADMIN_TABS = ['calc', 'lib', 'items', 'reports', 'settings'];

function onUnauthorized() {
  me = null;
  updateAuthUI();
  openLogin(currentTab);
}

async function refreshAuthStatus() {
  const s = await api('GET', '/api/auth/status');
  needsSetup = s.needsSetup;
  me = s.me;
  updateAuthUI();
  return s;
}

function updateAuthUI() {
  const isAdmin = !!me && me.role === 'admin';
  $('authStatus').textContent = me ? `Signed in as ${me.name}${me.role === 'cashier' ? ' · Cashier' : ''}` : '';
  $('exportBtn').hidden = !isAdmin;
  $('importBtn').hidden = !isAdmin;
  document.querySelectorAll('#tabs button[data-admin-only]').forEach(b => { b.hidden = !isAdmin; });
}

function openLogin(forTab) {
  pendingTab = forTab || null;
  $('loginError').hidden = true;
  $('forgotPanel').hidden = true;
  if (needsSetup) {
    $('loginTitle').textContent = 'Set up the first admin';
    $('loginSub').textContent = 'No account exists yet — create the first admin to manage pricing, materials, and other accounts.';
    $('loginFields').hidden = true;
    $('setupFields').hidden = false;
    $('forgotLink').hidden = true;
  } else {
    $('loginTitle').textContent = 'Sign in';
    $('loginSub').textContent = 'Sign in as an admin or cashier to use Workshop POS.';
    $('loginFields').hidden = false;
    $('setupFields').hidden = true;
    $('forgotLink').hidden = false;
  }
  $('loginScreen').hidden = false;
  (needsSetup ? $('setupName') : $('loginUsername')).focus();
}
function closeLogin() { $('loginScreen').hidden = true; pendingTab = null; }

$('forgotLink').onclick = () => { $('forgotPanel').hidden = !$('forgotPanel').hidden; };

$('loginSubmit').onclick = async () => {
  $('loginError').hidden = true;
  try {
    if (needsSetup) {
      const name = $('setupName').value.trim(), username = $('setupUsername').value.trim(), password = $('setupPassword').value;
      if (!name || !username || password.length < 8) throw new Error('Name, username, and a password of at least 8 characters are required.');
      const r = await api('POST', '/api/auth/setup', { name, username, password });
      me = r.me; needsSetup = false;
    } else {
      const username = $('loginUsername').value.trim(), password = $('loginPassword').value;
      const r = await api('POST', '/api/auth/login', { username, password });
      me = r.me;
    }
    updateAuthUI();
    const dest = (pendingTab && (me.role === 'admin' || !ADMIN_TABS.includes(pendingTab))) ? pendingTab : 'pos';
    closeLogin();
    await afterLogin();
    showTab(dest);
    toast(`Welcome, ${me.name}`);
  } catch (e) {
    $('loginError').textContent = e.message === 'invalid_credentials' || e.code === 'invalid_credentials' ? 'Incorrect username or password.' : e.message;
    $('loginError').hidden = false;
  }
};
[$('loginUsername'), $('loginPassword')].forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') $('loginSubmit').click(); }));

async function logout() {
  await api('POST', '/api/auth/logout');
  me = null;
  updateAuthUI();
  openLogin('pos');
  toast('Signed out');
}

// Loads the data the Sell page needs and starts light polling so a second cashier's
// sales/stock changes show up without a manual refresh — deferred until after login since
// every one of these endpoints now requires being signed in.
let pollTimer = null;
async function afterLogin() {
  await Promise.all([loadPosItems(), loadSales(), loadEvents()]);
  if (!pollTimer) {
    pollTimer = setInterval(() => { if (!document.hidden && me) Promise.all([loadPosItems(), loadSales(), loadEvents()]).catch(() => {}); }, 20000);
  }
}

// ---------- Tabs ----------
function showTab(t) {
  if (!me) { openLogin(t); return; }
  if (ADMIN_TABS.includes(t) && me.role !== 'admin') t = 'pos';
  currentTab = t;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  ['calc', 'lib', 'items', 'pos', 'reports', 'settings'].forEach(x => $('tab-' + x).hidden = x !== t);
  if (t === 'calc') calc();
  if (t === 'lib') loadMaterials();
  if (t === 'items') loadItems();
  if (t === 'reports') renderReports();
  if (t === 'settings') loadUsers();
}
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));

// ---------- Pricing math (unchanged from the original calculator) ----------
const matSource = row => libById(row.libId) || row;
const unitCost = src => num(src.yield) > 0 ? num(src.price) / num(src.yield) : 0;
function roundPrice(p, how) {
  if (p <= 0) return 0;
  switch (how) {
    case 'cent99': return Math.max(0.99, Math.ceil(p) - 0.01 >= p ? Math.ceil(p) - 0.01 : Math.ceil(p) + 0.99);
    case 'whole': return Math.ceil(p);
    case 'five': return Math.ceil(p / 5) * 5;
    default: return Math.round(p * 100) / 100;
  }
}
const laborIn = cm => cm === 'labor' || cm === 'both';
const ovhIn = cm => cm === 'overhead' || cm === 'both';
function computeItem(s) {
  const mat = s.materials.reduce((sum, r) => sum + unitCost(matSource(r)) * num(r.per), 0);
  const lab = laborIn(s.costMode) ? num(s.minutes) / 60 * num(s.rate) : 0;
  const ovh = ovhIn(s.costMode) ? (mat + lab) * num(s.overhead) / 100 : 0;
  const cost = mat + lab + ovh;
  const v = num(s.pct);
  const raw = s.mode === 'margin' ? (v >= 100 ? NaN : cost / (1 - v / 100)) : s.mode === 'multiplier' ? cost * v : cost * (1 + v / 100);
  const suggested = isFinite(raw) ? roundPrice(raw, s.round) : 0;
  const overridden = s.override != null && String(s.override).trim() !== '' && num(s.override) >= 0;
  const price = overridden ? num(s.override) : suggested;
  return { mat, lab, ovh, cost, raw, suggested, overridden, price };
}

// ---------- State ----------
let lib = [];       // materials (full, admin-only)
let items = [];     // full items (admin-only) when logged in; public items on Sell tab
let posItemsList = []; // public item list for the Sell tab (no cost/materials)
let sales = [];      // public sales (no profit) — used by Sell tab & reports stats that don't need profit
let fullSales = [];  // admin sales with profit — used by Reports
let events = [];
let admins = [];
let testMode = false;
try { testMode = localStorage.getItem('workshopPos.testMode') === '1'; } catch {}

const libById = id => id && lib.find(m => m.id === id);
const itemById = id => id && (items.find(i => i.id === id) || posItemsList.find(i => i.id === id));
const libByName = name => name.trim() && lib.find(m => m.name.trim().toLowerCase() === name.trim().toLowerCase());
const usedIn = id => items.filter(it => it.materials.some(r => r.libId === id)).length;
const isLow = (stock, low) => low !== '' && low != null && num(stock) <= num(low);

// ---------- Calculator form ----------
let mode = 'markup';
let costMode = 'none';
function setCostMode(m) {
  costMode = m;
  document.querySelectorAll('#costSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  calc();
}
document.querySelectorAll('#costSeg button').forEach(b => b.onclick = () => setCostMode(b.dataset.mode));
const hints = {
  markup: 'Price = cost + (cost × markup). 50% markup on a $10 cost = $15.',
  margin: 'Price set so profit is this % of the sale price. 50% margin on a $10 cost = $20.',
  multiplier: 'Price = cost × multiplier. Common rule of thumb is 2× (wholesale) to 4× (retail).',
};
const labels = { markup: 'Markup (%)', margin: 'Profit margin (%)', multiplier: 'Multiplier (×)' };
const defaults = { markup: 50, margin: 40, multiplier: 2 };

function link(tr, m) {
  const [n, p, y] = tr.querySelectorAll('input');
  tr.dataset.lib = m.id;
  tr.classList.add('linked');
  if (document.activeElement !== n) n.value = m.name;
  p.value = m.price; y.value = m.yield;
  p.readOnly = y.readOnly = true;
}
function unlink(tr) {
  const [, p, y] = tr.querySelectorAll('input');
  delete tr.dataset.lib;
  tr.classList.remove('linked');
  p.readOnly = y.readOnly = false;
}
function syncLinkedRows() {
  for (const tr of $('mats').children) { const m = libById(tr.dataset.lib); m ? link(tr, m) : unlink(tr); }
}
function addMaterial(m = {}) {
  m = { name: '', price: '', yield: 1, per: 1, addToLib: true, ...m };
  const tr = document.createElement('tr');
  tr.className = 'erow';
  tr.innerHTML = `
    <td><input class="in-name" list="libList" placeholder="Type or pick a material"><span class="tag">● From library · edit price there</span></td>
    <td data-l="Price paid ($)"><input class="in-small" type="number" min="0" step="0.01" placeholder="0.00"></td>
    <td data-l="Makes / pack of"><input class="in-small" type="number" min="1" step="any"></td>
    <td data-l="Used per item"><input class="in-small" type="number" min="0" step="any"></td>
    <td class="num" data-l="Per item"></td>
    <td class="acts">
      <label class="lib-chk-wrap" title="Add this material to your library when you save the item"><input type="checkbox" class="lib-chk">Library</label>
      <button class="icon-btn del" title="Remove">×</button>
    </td>`;
  const [n, p, y, u] = tr.querySelectorAll('input');
  const chk = tr.querySelector('.lib-chk');
  n.value = m.name; p.value = m.price; y.value = m.yield; u.value = m.per;
  chk.checked = m.addToLib !== false;
  const linked = libById(m.libId);
  if (linked) link(tr, linked);
  n.addEventListener('input', () => { const hit = libByName(n.value); hit ? link(tr, hit) : unlink(tr); });
  n.addEventListener('change', () => { const hit = libByName(n.value); if (hit) n.value = hit.name; });
  tr.addEventListener('input', calc);
  tr.querySelector('.del').onclick = () => { tr.remove(); calc(); };
  $('mats').appendChild(tr);
  return n;
}

function readForm() {
  return {
    name: $('itemName').value.trim(),
    stock: $('stock').value, low: $('itemLow').value,
    materials: [...$('mats').children].map(tr => {
      const [n, p, y, u] = tr.querySelectorAll('input');
      const row = { name: n.value, price: p.value, yield: y.value, per: u.value };
      if (tr.dataset.lib) row.libId = tr.dataset.lib; else row.addToLib = tr.querySelector('.lib-chk').checked;
      return row;
    }),
    costMode, minutes: $('minutes').value, rate: $('rate').value, overhead: $('overhead').value,
    mode, pct: $('pct').value, round: $('round').value, override: $('override').value,
  };
}

function calc() {
  const s = readForm();
  const r = computeItem(s);
  [...$('mats').children].forEach((tr, i) => {
    const row = s.materials[i];
    const unit = unitCost(matSource(row));
    const detail = num(row.per) !== 1 ? `<small>${money4(unit)} × ${num(row.per)}</small>` : '';
    tr.querySelector('.num').innerHTML = money(unit * num(row.per)) + detail;
  });
  const profit = r.price - r.cost;
  $('price').textContent = isFinite(r.raw) || r.overridden ? money(r.price) : '—';
  $('priceBox').classList.toggle('override', r.overridden);
  $('priceLbl').textContent = r.overridden ? 'Your price' : 'Suggested price';
  $('priceSub').innerHTML = r.overridden ? `Suggested was ${money(r.suggested)} · <button class="link" id="useSuggested">use suggested</button>` : 'per finished item';
  if (r.overridden) $('useSuggested').onclick = () => { $('override').value = ''; calc(); };
  $('override').placeholder = `Suggested: ${money(r.suggested)}`;
  $('sMat').textContent = money(r.mat);
  const laborOn = laborIn(costMode), ovhOn = ovhIn(costMode);
  $('sLab').textContent = laborOn ? money(r.lab) : 'Off';
  $('sOh').textContent = ovhOn ? money(r.ovh) : 'Off';
  document.querySelectorAll('.labor-field').forEach(el => el.classList.toggle('dim', !laborOn));
  document.querySelectorAll('.ovh-field').forEach(el => el.classList.toggle('dim', !ovhOn));
  $('minutes').disabled = $('rate').disabled = !laborOn;
  $('overhead').disabled = !ovhOn;
  $('sCost').textContent = money(r.cost);
  $('sProfit').textContent = money(profit);
  $('sProfit').style.color = profit < 0 ? 'var(--danger)' : '';
  $('sMargin').textContent = r.price > 0 ? (profit / r.price * 100).toFixed(1) + '%' : '0%';
  const parts = [[r.mat, '#c99a5b'], [r.lab, '#5b8ac9'], [r.ovh, '#9a7bc0'], [Math.max(0, profit), 'var(--accent)']];
  const sum = parts.reduce((a, [x]) => a + x, 0) || 1;
  $('bar').innerHTML = parts.map(([x, c]) => `<div style="width:${x / sum * 100}%;background:${c}"></div>`).join('');
}
function setMode(m, keepValue) {
  mode = m;
  document.querySelectorAll('#mode button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  $('pctLabel').textContent = labels[m];
  $('pct').step = m === 'multiplier' ? '0.1' : '1';
  if (!keepValue) $('pct').value = defaults[m];
  $('modeHint').textContent = hints[m];
  calc();
}
document.querySelectorAll('#mode button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
['minutes', 'rate', 'overhead', 'pct', 'round', 'override'].forEach(id => $(id).addEventListener('input', calc));

function restore(s) {
  $('itemName').value = s.name;
  $('itemNoHint').hidden = !s.itemNo;
  $('itemNoHint').textContent = s.itemNo ? `Item #${s.itemNo}` : '';
  $('stock').value = s.stock ?? 0; $('itemLow').value = s.low ?? '';
  $('mats').innerHTML = '';
  (s.materials.length ? s.materials : [{}]).forEach(m => addMaterial(m));
  $('minutes').value = s.minutes; $('rate').value = s.rate; $('overhead').value = s.overhead;
  setCostMode(s.costMode || 'none');
  $('pct').value = s.pct; $('round').value = s.round; $('override').value = s.override ?? '';
  setMode(s.mode, true);
  currentEditId = s.id || null;
}
let currentEditId = null;

$('addMat').onclick = () => addMaterial().focus();
$('reset').onclick = () => {
  currentEditId = null;
  restore({ name: '', override: '', stock: 0, low: '', costMode, materials: [], minutes: 0, rate: $('rate').value, overhead: $('overhead').value, mode, pct: defaults[mode], round: 'whole' });
  $('itemName').focus();
};
$('save').onclick = async () => {
  const s = readForm();
  if (!s.name) { $('itemName').focus(); toast('Give the item a name first'); return; }
  const added = [];
  for (let idx = 0; idx < s.materials.length; idx++) {
    const row = s.materials[idx];
    if (row.libId || !row.addToLib) { delete row.addToLib; continue; }
    const name = (row.name || '').trim();
    delete row.addToLib;
    if (!name) continue;
    let entry = libByName(name);
    if (!entry) {
      entry = await api('POST', '/api/materials', { name, price: row.price, yield: row.yield || 1, stock: 0 });
      lib.push(entry);
      added.push(name);
    }
    row.libId = entry.id; row.name = entry.name; row.price = entry.price; row.yield = entry.yield;
    const tr = $('mats').children[idx];
    if (tr) link(tr, entry);
  }
  const r = computeItem(s);
  const existing = currentEditId ? items.find(x => x.id === currentEditId) : items.find(x => x.name.toLowerCase() === s.name.toLowerCase());
  const saved = await api('POST', '/api/items', { ...s, id: existing ? existing.id : undefined, price: r.price, cost: r.cost });
  currentEditId = saved.id;
  $('itemNoHint').hidden = false;
  $('itemNoHint').textContent = `Item #${saved.itemNo}`;
  toast((existing ? `Updated “${s.name}”` : `Saved “${s.name}”`) + (added.length ? ` · added ${added.join(', ')} to library` : ''));
  await loadItems(); if (added.length) renderLib();
};

// ---------- Material library ----------
async function loadMaterials() { lib = await api('GET', '/api/materials'); renderLib(); }
function renderLib() {
  $('libList').innerHTML = lib.map(m => `<option value="${esc(m.name)}">`).join('');
  $('libCount').textContent = lib.length || '';
  $('libEmpty').hidden = lib.length > 0;
  $('libTable').hidden = lib.length === 0;
  const tb = $('libRows'); tb.innerHTML = '';
  for (const m of lib) {
    const tr = document.createElement('tr'); tr.className = 'erow'; tr.dataset.id = m.id;
    const low = isLow(m.stock, m.low);
    tr.innerHTML = `
      <td><input class="in-name" placeholder="Material name"></td>
      <td data-l="Price paid ($)"><input class="in-small" type="number" min="0" step="0.01" placeholder="0.00"></td>
      <td data-l="Makes / pack of"><input class="in-small" type="number" min="1" step="any"></td>
      <td class="num" data-l="Per piece"></td>
      <td data-l="In stock"><input class="in-tiny stockIn" type="number" min="0" step="any"></td>
      <td data-l="Low at"><input class="in-tiny lowIn" type="number" min="0" step="any" placeholder="off"></td>
      <td class="num used" data-l="Used in"></td>
      <td class="acts"><button class="icon-btn del" title="Delete material">×</button></td>`;
    const [n, p, y, stockIn, lowIn] = tr.querySelectorAll('input');
    n.value = m.name; p.value = m.price; y.value = m.yield; stockIn.value = m.stock ?? 0; lowIn.value = m.low ?? '';
    const refresh = () => { tr.querySelector('.num').textContent = money4(unitCost(m)); const u = usedIn(m.id); tr.querySelector('.used').textContent = u ? `${u} item${u > 1 ? 's' : ''}` : '—'; };
    refresh();
    stockIn.classList.toggle('low-input', low);
    let saveTimer;
    tr.addEventListener('input', () => {
      m.name = n.value; m.price = p.value; m.yield = y.value; m.stock = stockIn.value; m.low = lowIn.value;
      refresh(); stockIn.classList.toggle('low-input', isLow(m.stock, m.low)); refreshLowMatBanner();
      $('libList').innerHTML = lib.map(x => `<option value="${esc(x.name)}">`).join('');
      syncLinkedRows(); calc();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => api('POST', '/api/materials', m), 500);
    });
    tr.querySelector('.del').onclick = () => deleteLib(m);
    tb.appendChild(tr);
  }
  refreshLowMatBanner();
}
function refreshLowMatBanner() {
  const lowNames = lib.filter(m => isLow(m.stock, m.low)).map(m => m.name || 'Unnamed material');
  $('lowMatBanner').hidden = lowNames.length === 0;
  $('lowMatText').textContent = lowNames.length ? `Low on stock: ${lowNames.join(', ')}.` : '';
}
async function deleteLib(m) {
  const u = usedIn(m.id);
  if (u && !await askConfirm(`“${m.name || 'This material'}” is used in ${u} saved item${u > 1 ? 's' : ''}. Those items will keep its current price as a one-off.`, 'Delete material')) return;
  const touched = items.filter(it => it.materials.some(r => r.libId === m.id));
  for (const it of touched) { for (const r of it.materials) if (r.libId === m.id) { r.name = m.name; r.price = m.price; r.yield = m.yield; delete r.libId; } await api('POST', '/api/items', it); }
  lib = lib.filter(x => x !== m);
  await api('DELETE', '/api/materials/' + m.id);
  renderLib(); if (touched.length) await loadItems();
}
$('addLib').onclick = async () => {
  const m = await api('POST', '/api/materials', { name: '', price: '', yield: 1, stock: 0 });
  lib.push(m); renderLib();
  const names = $('libRows').querySelectorAll('.in-name'); names[names.length - 1].focus();
};

// ---------- Saved items ----------
function freshCopy(it) {
  const c = computeItem(it);
  it.materials.forEach(r => { const m = libById(r.libId); if (m) { r.name = m.name; r.price = m.price; r.yield = m.yield; } });
  it.price = c.price; it.cost = c.cost;
}
function itemStatus(it) {
  const c = computeItem(it);
  const diff = c.price - num(it.price), costDiff = c.cost - num(it.cost);
  const priceMoved = Math.abs(diff) >= 0.005;
  return { c, diff, costDiff, priceMoved, moved: priceMoved || Math.abs(costDiff) >= 0.005 };
}
async function loadItems() { items = await api('GET', '/api/items/full'); renderItems(); }
async function makeBatch(it, qty) {
  qty = Math.max(1, Math.round(num(qty)) || 1);
  try {
    const r = await api('POST', `/api/items/${it.id}/make`, { qty });
    toast(r.short.length ? `Made ${qty} more “${it.name}” — ran low on ${r.short.join(', ')}` : `Made ${qty} more “${it.name}”`);
  } catch (e) { toast('Could not update stock — try again.'); }
  await loadItems(); await loadMaterials();
}
async function sellItem(it, qty) {
  qty = Math.max(1, Math.round(num(qty)) || 1);
  try {
    const r = await api('POST', `/api/items/${it.id}/sell`, { qty });
    toast(qty > r.had ? `Sold ${r.had} “${it.name}” (only had ${r.had} in stock)` : `Sold ${qty} “${it.name}”`);
  } catch (e) { toast('Could not update stock — try again.'); }
  await loadItems();
}
function renderItems() {
  const tb = $('itemRows'); tb.innerHTML = ''; let changed = 0;
  for (const it of items) {
    const { c, diff, costDiff, priceMoved, moved } = itemStatus(it);
    if (moved) changed++;
    const low = isLow(it.stock, it.low);
    const tr = document.createElement('tr'); tr.dataset.id = it.id;
    tr.innerHTML = `
      <td><div class="iname"></div><div class="meta">${it.itemNo ? `#${it.itemNo} · ` : ''}${it.materials.length} material${it.materials.length === 1 ? '' : 's'} · saved ${it.savedAt ? new Date(it.savedAt).toLocaleDateString() : 'earlier'}</div></td>
      <td class="num" data-l="Cost now">${money(c.cost)}${moved && Math.abs(costDiff) >= 0.005 ? `<small>${costDiff > 0 ? 'up' : 'down'} ${money(Math.abs(costDiff))} from ${money(num(it.cost))}</small>` : ''}</td>
      <td class="num" data-l="Sales price">${priceMoved ? `<span class="old">${money(num(it.price))}</span> <b>${money(c.price)}</b><span class="chg">${diff > 0 ? '▲' : '▼'} ${money(Math.abs(diff))}</span>` : `<b>${money(c.price)}</b>${c.overridden ? `<small>your price · suggested ${money(c.suggested)}</small>` : moved ? '<small>price unchanged after rounding</small>' : ''}`}
        <small class="${c.price - c.cost < 0 ? 'neg' : ''}">margin ${c.price > 0 ? ((c.price - c.cost) / c.price * 100).toFixed(0) : 0}%</small></td>
      <td class="num" data-l="Stock"><div class="stock-cell${low ? ' low' : ''}"><input type="number" class="in-tiny stockIn" min="0" step="1"><span class="stock-badge"${low ? '' : ' hidden'}>LOW</span></div></td>
      <td class="acts">
        <div class="qty-ctrl"><input type="number" class="qty" min="1" step="1" value="1">
          <button class="btn sm make" title="Log a batch made — deducts materials">+ Make</button>
          <button class="btn sm sell" title="Log a sale — reduces stock">− Sell</button></div>
        ${moved ? '<button class="btn sm accept">Accept</button>' : ''}
        <button class="btn sm open">Open</button>
        <button class="icon-btn del" title="Delete item">×</button>
      </td>`;
    tr.querySelector('.iname').textContent = it.name;
    tr.querySelector('.iname').onclick = tr.querySelector('.open').onclick = () => { restore(it); showTab('calc'); window.scrollTo({ top: 0 }); };
    const stockIn = tr.querySelector('.stockIn');
    stockIn.value = num(it.stock);
    stockIn.classList.toggle('low-input', low);
    let stockTimer;
    stockIn.addEventListener('input', () => {
      it.stock = stockIn.value;
      const lowNow = isLow(it.stock, it.low);
      tr.querySelector('.stock-cell').classList.toggle('low', lowNow);
      stockIn.classList.toggle('low-input', lowNow);
      tr.querySelector('.stock-badge').hidden = !lowNow;
      clearTimeout(stockTimer);
      stockTimer = setTimeout(() => api('POST', '/api/items', it), 500);
    });
    const qtyInput = tr.querySelector('.qty');
    tr.querySelector('.make').onclick = () => makeBatch(it, qtyInput.value);
    tr.querySelector('.sell').onclick = () => sellItem(it, qtyInput.value);
    const acc = tr.querySelector('.accept');
    if (acc) acc.onclick = async () => { freshCopy(it); await api('POST', '/api/items', it); toast(`${it.name} is now ${money(it.price)}`); loadItems(); };
    tr.querySelector('.del').onclick = async () => {
      if (!await askConfirm(`Delete “${it.name}”? This can’t be undone.`, 'Delete item')) return;
      await api('DELETE', '/api/items/' + it.id);
      await loadItems();
    };
    tb.appendChild(tr);
  }
  $('itemsEmpty').hidden = items.length > 0;
  tb.parentElement.hidden = items.length === 0;
  $('changedBanner').hidden = changed === 0;
  $('changedText').textContent = `Material costs changed for ${changed} item${changed > 1 ? 's' : ''}. Review the new numbers below.`;
  refreshLowItemBanner();
  const badge = $('itemCount');
  badge.textContent = changed ? `${changed} ▲▼` : (items.length || '');
}
function refreshLowItemBanner() {
  const lowNames = items.filter(it => isLow(it.stock, it.low)).map(it => it.name || 'Unnamed item');
  $('lowItemBanner').hidden = lowNames.length === 0;
  $('lowItemText').textContent = lowNames.length ? `Low on stock: ${lowNames.join(', ')}.` : '';
}
$('acceptAll').onclick = async () => {
  const moved = items.filter(it => itemStatus(it).moved);
  for (const it of moved) { freshCopy(it); await api('POST', '/api/items', it); }
  toast('All items updated to current costs');
  await loadItems();
};

// ---------- Point of sale ----------
let ticket = [];
let tender = 'cash';
let posSearch = '';

async function loadPosItems() { posItemsList = await api('GET', '/api/items'); renderPosItems(); }
function renderPosItems() {
  const grid = $('posItems');
  const q = posSearch.trim().toLowerCase();
  const list = posItemsList.filter(it => !q || it.name.toLowerCase().includes(q) || (it.itemNo || '').includes(q));
  grid.innerHTML = '';
  for (const it of list) {
    const low = isLow(it.stock, it.low);
    const btn = document.createElement('button'); btn.className = 'pos-item';
    btn.innerHTML = `<span class="nm"></span><span class="pr">${money(num(it.price))}</span><span class="st${low ? ' low' : ''}">${it.itemNo ? `#${it.itemNo} · ` : ''}${num(it.stock)} in stock</span>`;
    btn.querySelector('.nm').textContent = it.name;
    btn.onclick = () => addToTicket(it);
    grid.appendChild(btn);
  }
  $('posItemsEmpty').hidden = posItemsList.length > 0;
  grid.hidden = posItemsList.length === 0;
}
function defaultLineTaxRate(forTender) {
  const ev = openEvent();
  if (!ev) return 0;
  if (forTender === 'cash' && String(ev.cashTaxRate ?? '').trim() !== '') return num(ev.cashTaxRate);
  return num(ev.taxRate) || 0;
}
function eventTaxIncluded(ev, forTender) {
  if (!ev) return false;
  return forTender === 'cash' ? !!ev.taxIncludedCash : !!ev.taxIncludedOther;
}
function lineTaxSplit(l, included) {
  const amt = num(l.price) * num(l.qty), rate = num(l.taxRate) / 100;
  if (included && rate > 0) { const sub = amt / (1 + rate); return { amt, sub, tax: amt - sub }; }
  return { amt, sub: amt, tax: amt * rate };
}
function addToTicket(it) {
  const line = ticket.find(l => l.itemId === it.id);
  if (line) line.qty++;
  else ticket.push({ id: cid(), itemId: it.id, name: it.name, price: num(it.price), qty: 1, taxRate: defaultLineTaxRate(tender), taxOverridden: false });
  renderTicket();
}
function recalcTicketTotals() {
  const included = eventTaxIncluded(openEvent(), tender);
  let subtotal = 0, tax = 0;
  for (const l of ticket) { const s = lineTaxSplit(l, included); subtotal += s.sub; tax += s.tax; }
  const total = subtotal + tax;
  $('tSub').textContent = money(subtotal);
  $('tTaxLabel').textContent = included ? 'Tax (included in price)' : 'Tax';
  $('tTax').textContent = money(tax);
  $('tTotal').textContent = money(total);
  $('changeDue').value = money(Math.max(0, num($('received').value) - total));
  $('checkout').disabled = ticket.length === 0;
  $('posCount') && ($('posCount').textContent = ticket.length || '');
}
function renderTicket() {
  const box = $('ticketLines'); box.innerHTML = '';
  for (const l of ticket) {
    const row = document.createElement('div'); row.className = 'tline';
    row.innerHTML = `<div class="nm"></div><div class="qstep"><button class="minus">−</button><span></span><button class="plus">+</button></div>
      <div class="taxmini"><input type="number" min="0" step="0.1" class="lineTax" title="Tax rate for this item"><span>%</span></div>
      <div class="amt"></div><button class="icon-btn del" title="Remove">×</button>`;
    row.querySelector('.nm').textContent = l.name;
    row.querySelector('.qstep span').textContent = l.qty;
    row.querySelector('.amt').textContent = money(l.price * l.qty);
    const taxInput = row.querySelector('.lineTax');
    taxInput.value = l.taxRate; taxInput.classList.toggle('overridden', !!l.taxOverridden);
    taxInput.addEventListener('input', () => { l.taxRate = taxInput.value; l.taxOverridden = true; taxInput.classList.add('overridden'); recalcTicketTotals(); });
    row.querySelector('.minus').onclick = () => { l.qty--; if (l.qty <= 0) ticket = ticket.filter(x => x !== l); renderTicket(); };
    row.querySelector('.plus').onclick = () => { l.qty++; renderTicket(); };
    row.querySelector('.del').onclick = () => { ticket = ticket.filter(x => x !== l); renderTicket(); };
    box.appendChild(row);
  }
  $('ticketEmpty').hidden = ticket.length > 0;
  recalcTicketTotals();
}
function setTender(t) {
  tender = t;
  document.querySelectorAll('#tenderSeg button').forEach(b => b.classList.toggle('on', b.dataset.tender === t));
  $('cashRow').hidden = t !== 'cash';
  const def = defaultLineTaxRate(t);
  ticket.forEach(l => { if (!l.taxOverridden) l.taxRate = def; });
  renderTicket();
}
document.querySelectorAll('#tenderSeg button').forEach(b => b.onclick = () => setTender(b.dataset.tender));
$('posSearch').addEventListener('input', () => { posSearch = $('posSearch').value; renderPosItems(); });
$('received').addEventListener('input', recalcTicketTotals);
$('posCustomToggle').onclick = () => { const show = $('posCustomRow').hidden; $('posCustomRow').hidden = !show; $('posCustomAddRow').hidden = !show; if (show) $('posCustomName').focus(); };
$('posCustomAdd').onclick = () => {
  const name = $('posCustomName').value.trim(), price = num($('posCustomPrice').value), qty = Math.max(1, Math.round(num($('posCustomQty').value)) || 1);
  if (!name) { $('posCustomName').focus(); toast('Give the item a name first'); return; }
  ticket.push({ id: cid(), itemId: null, name, price, qty, taxRate: defaultLineTaxRate(tender), taxOverridden: false });
  renderTicket();
  $('posCustomName').value = ''; $('posCustomPrice').value = ''; $('posCustomQty').value = '1'; $('posCustomName').focus();
};
$('clearTicket').onclick = async () => {
  if (!ticket.length) return;
  if (!await askConfirm('Clear the current ticket? This can’t be undone.', 'Clear ticket')) return;
  ticket = []; $('received').value = ''; renderTicket();
};
$('checkout').onclick = async () => {
  if (!ticket.length) return;
  const ev = openEvent();
  const total = num($('tTotal').textContent.replace(/[^0-9.-]/g, ''));
  const received = tender === 'cash' ? num($('received').value) : total;
  try {
    const sale = await api('POST', '/api/sales', {
      eventId: ev?.id || null, test: testMode, taxIncluded: eventTaxIncluded(ev, tender),
      lines: ticket.map(l => ({ itemId: l.itemId, name: l.name, price: l.price, qty: l.qty, taxRate: num(l.taxRate) })),
      tender, received,
    });
    ticket = []; $('received').value = ''; renderTicket();
    toast(`${testMode ? 'Test sale' : 'Sale'} complete — ${money(sale.total)}`);
    await Promise.all([loadPosItems(), loadSales(), renderEventWidget()]);
  } catch (e) { toast('Checkout failed — ' + (e.message || 'try again')); }
};

function buildSaleReceipt(sale) {
  const wrap = document.createElement('div'); wrap.className = 'receipt';
  const itemCount = sale.lines.reduce((n, l) => n + num(l.qty), 0);
  const head = document.createElement('button'); head.type = 'button'; head.className = 'receipt-head';
  head.innerHTML = `<span class="rh-time"></span><span class="rh-total"></span>`;
  head.querySelector('.rh-time').textContent = `${sale.createdAt ? new Date(sale.createdAt).toLocaleString() : ''} · ${itemCount} item${itemCount === 1 ? '' : 's'}${sale.test ? ' · test' : ''}`;
  head.querySelector('.rh-total').textContent = money(sale.total);
  const body = document.createElement('div'); body.className = 'receipt-body'; body.hidden = true;
  const included = !!sale.taxIncluded;
  const lineHtml = sale.lines.map(l => {
    const { amt, tax: lineTax } = lineTaxSplit(l, included); const lt = num(l.taxRate);
    const item = `<div class="rline item"><span>${num(l.qty)} × ${esc(l.name)}</span><span>${money(amt)}</span></div>`;
    const taxLine = lt > 0 ? `<div class="rline sub"><span>tax ${lt}%${included ? ' (included)' : ''}</span><span>${money(lineTax)}</span></div>` : '';
    return item + taxLine;
  }).join('');
  body.innerHTML = `${lineHtml}
    <div class="rline subtot"><span>Subtotal</span><span>${money(sale.subtotal)}</span></div>
    <div class="rline subtot"><span>Tax${included ? ' (included in price)' : ''}</span><span>${money(sale.tax)}</span></div>
    <div class="rline grand"><span>Total</span><span>${money(sale.total)}</span></div>
    <div class="rline meta"><span>${sale.tender === 'cash' ? `Cash · received ${money(sale.received)} · change ${money(sale.change)}` : 'Card / Other'}</span></div>`;
  const voidBtn = document.createElement('button'); voidBtn.className = 'sale-void'; voidBtn.textContent = sale.test ? 'Void test sale' : 'Void sale';
  voidBtn.onclick = e => { e.stopPropagation(); voidSale(sale); };
  body.appendChild(voidBtn);
  head.onclick = () => { body.hidden = !body.hidden; };
  wrap.appendChild(head); wrap.appendChild(body);
  return wrap;
}
async function loadSales() { sales = await api('GET', '/api/sales'); renderSales(); }
function renderSales() {
  const box = $('salesList');
  const ev = openEvent(); const ctxId = ev ? ev.id : null;
  $('salesHeading').textContent = ev ? `${ev.name || 'Event'} — sales` : (testMode ? 'Recent test sales' : 'Recent sales');
  let visible = sales.filter(s => !!s.test === testMode && s.eventId === ctxId);
  if (!ctxId) visible = visible.slice(0, 30);
  box.innerHTML = '';
  for (const sale of visible) box.appendChild(buildSaleReceipt(sale));
  $('salesEmpty').hidden = visible.length > 0;
  $('salesEmpty').textContent = ev ? `No sales yet for ${ev.name || 'this event'}.` : (testMode ? 'No test sales yet.' : 'No sales yet.');
  updateTestControls();
}
async function voidSale(sale) {
  if (!await askConfirm(sale.test ? `Void this ${money(sale.total)} test sale?` : `Void this ${money(sale.total)} sale? Any stock it used will be added back.`, 'Void sale')) return;
  try { await api('DELETE', '/api/sales/' + sale.id); toast(sale.test ? 'Test sale voided' : 'Sale voided — stock restored'); }
  catch (e) { toast('Could not void that sale — try again.'); }
  await Promise.all([loadSales(), loadPosItems(), renderEventWidget(), renderEventHistory()]);
}

// ---------- Events & break-even tracker ----------
const openEvent = () => events.find(e => e.status === 'open' && !!e.test === testMode);
function eventWindow(ev) {
  const startMs = new Date(ev.start + 'T00:00:00').getTime();
  const days = Math.max(1, Math.round(num(ev.days)));
  return { startMs, endMs: startMs + days * 86400000, days };
}
const eventSales = ev => sales.filter(s => s.eventId === ev.id);
const eventProfit = ev => eventSales(ev).reduce((sum, s) => sum + num(s.profit || 0), 0); // public sales have no profit; see Reports for real totals
async function loadEvents() { events = await api('GET', '/api/events'); renderEventWidget(); renderEventHistory(); }
function renderEventWidget() {
  const bar = $('eventBar'), link = $('eventSetupLink');
  const ev = openEvent();
  if (!ev) { bar.hidden = true; link.hidden = false; return; }
  link.hidden = true; bar.hidden = false;
  const { startMs, days } = eventWindow(ev);
  const cost = num(ev.cost);
  const evSalesList = eventSales(ev);
  const revenue = evSalesList.reduce((s, x) => s + num(x.total), 0);
  const met = revenue >= cost; // using revenue here since public sales carry no profit figure
  const pct = cost > 0 ? Math.min(100, Math.max(0, Math.round(revenue / cost * 100))) : 0;
  const dayIndex = Math.floor((Date.now() - startMs) / 86400000) + 1;
  const dayLabel = dayIndex < 1 ? `Starts ${new Date(startMs).toLocaleDateString()}` : dayIndex > days ? `Day ${days} of ${days} (last day)` : `Day ${dayIndex} of ${days}`;
  bar.classList.toggle('met', met);
  $('eventTitle').textContent = ev.name || 'Event';
  $('eventSub').textContent = `${dayLabel} · ${money(revenue)} of ${money(cost)} revenue toward space cost`;
  $('eventPct').textContent = met ? `✓ Covered` : `${pct}%`;
  $('eventFill').style.width = pct + '%';
}
function renderEventHistory() {
  const card = $('eventHistoryCard'), box = $('eventHistoryList');
  const ended = events.filter(e => e.status === 'ended' && !!e.test === testMode).sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
  card.hidden = ended.length === 0; box.innerHTML = '';
  for (const ev of ended) {
    const { days } = eventWindow(ev);
    const evSalesList = eventSales(ev).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const revenue = evSalesList.reduce((s, x) => s + num(x.total), 0);
    const row = document.createElement('div'); row.className = 'ev-row';
    row.innerHTML = `<div class="ev-top"><b></b><span class="ev-net"></span></div><div class="ev-meta"></div><button class="ev-view-btn"></button><button class="ev-del">Delete</button><div class="ev-sales" hidden></div>`;
    row.querySelector('.ev-top b').textContent = ev.name || 'Event';
    const netEl = row.querySelector('.ev-net'); const net = revenue - num(ev.cost);
    netEl.textContent = (net >= 0 ? '+' : '−') + money(Math.abs(net)); netEl.classList.add(net >= 0 ? 'pos' : 'neg');
    row.querySelector('.ev-meta').textContent = `${new Date(ev.start + 'T00:00:00').toLocaleDateString()} · ${days} day${days > 1 ? 's' : ''} · ${evSalesList.length} sale${evSalesList.length === 1 ? '' : 's'} · ${money(revenue)} revenue − ${money(num(ev.cost))} space`;
    const viewBtn = row.querySelector('.ev-view-btn'), salesBox = row.querySelector('.ev-sales');
    viewBtn.hidden = evSalesList.length === 0; viewBtn.textContent = `View sales (${evSalesList.length})`;
    let built = false;
    viewBtn.onclick = () => { salesBox.hidden = !salesBox.hidden; viewBtn.textContent = (salesBox.hidden ? 'View' : 'Hide') + ` sales (${evSalesList.length})`; if (!salesBox.hidden && !built) { built = true; evSalesList.forEach(s => salesBox.appendChild(buildSaleReceipt(s))); } };
    row.querySelector('.ev-del').onclick = async () => { if (!await askConfirm(`Delete “${ev.name || 'Event'}” from history?`, 'Delete event')) return; await api('DELETE', '/api/events/' + ev.id); await loadEvents(); };
    box.appendChild(row);
  }
  updateTestControls();
}
function fillEventForm(ev) {
  $('evName').value = ev?.name || ''; $('evCost').value = ev?.cost || ''; $('evStart').value = ev?.start || ''; $('evDays').value = ev?.days || 1;
  $('evTax').value = ev?.taxRate ?? ''; $('evCashTax').value = ev?.cashTaxRate ?? '';
  $('evTaxIncludedCash').checked = !!ev?.taxIncludedCash; $('evTaxIncludedOther').checked = !!ev?.taxIncludedOther;
  $('evEnd').hidden = !ev;
}
$('eventSetupLink').onclick = () => { fillEventForm(null); $('eventForm').hidden = false; $('evStart').focus(); };
$('eventGear').onclick = () => { fillEventForm(openEvent()); $('eventForm').hidden = !$('eventForm').hidden; };
$('evClose').onclick = () => { $('eventForm').hidden = true; };
$('evSave').onclick = async () => {
  if (!$('evStart').value || num($('evDays').value) < 1 || num($('evCost').value) <= 0) { toast('Add a start date, number of days, and space cost'); return; }
  const ev = openEvent();
  await api('POST', '/api/events', {
    id: ev?.id, name: $('evName').value.trim(), cost: $('evCost').value, start: $('evStart').value, days: $('evDays').value,
    taxRate: $('evTax').value, cashTaxRate: $('evCashTax').value, taxIncludedCash: $('evTaxIncludedCash').checked, taxIncludedOther: $('evTaxIncludedOther').checked,
    status: 'open', test: testMode,
  });
  $('eventForm').hidden = true; toast('Event saved');
  await loadEvents();
};
$('evEnd').onclick = async () => {
  const ev = openEvent(); if (!ev) return;
  if (!await askConfirm(`End “${ev.name || 'this event'}”? It'll move to Past events.`, 'End event')) return;
  await api('POST', '/api/events', { ...ev, status: 'ended', endedAt: Date.now() });
  $('eventForm').hidden = true; toast('Event ended');
  await loadEvents();
};

// ---------- Test / training mode ----------
function updateTestControls() {
  const purgeOff = $('purgeTestOffLink');
  purgeOff.hidden = testMode || !(events.some(e => e.test) || sales.some(s => s.test));
}
function setTestMode(on) {
  testMode = on;
  try { localStorage.setItem('workshopPos.testMode', on ? '1' : '0'); } catch {}
  $('testOffRow').hidden = on; $('testBanner').hidden = !on; $('testModeBadge').hidden = !on; $('eventForm').hidden = true;
  renderEventWidget(); renderEventHistory(); renderSales();
}
$('testModeOnLink').onclick = () => { setTestMode(true); toast('Test mode on — practice away'); };
async function purgeTestData(askFirst) {
  const testEvents = events.filter(e => e.test), testSales = sales.filter(s => s.test);
  if (!testEvents.length && !testSales.length) return 'empty';
  if (askFirst && !await askConfirm(`Permanently delete ${testSales.length} test sale${testSales.length === 1 ? '' : 's'} and ${testEvents.length} test event${testEvents.length === 1 ? '' : 's'}?`, 'Clear test data')) return 'cancelled';
  for (const e of testEvents) await api('DELETE', '/api/events/' + e.id);
  for (const s of testSales) await api('DELETE', '/api/sales/' + s.id);
  await Promise.all([loadEvents(), loadSales()]);
  return 'purged';
}
$('purgeTestLink').onclick = async () => { const r = await purgeTestData(true); if (r === 'purged') toast('Test data cleared'); else if (r === 'empty') toast('No test data to clear'); };
$('purgeTestOffLink').onclick = async () => { const r = await purgeTestData(true); if (r === 'purged') toast('Test data purged'); else if (r === 'empty') toast('No test data to purge'); };
$('testModeOffLink').onclick = async () => { await purgeTestData(false); setTestMode(false); toast('Exited test mode — test data purged'); };

// ---------- Reports (core: stats, chart, top items, payment type) ----------
let rptRange = '7';
const dayStart = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
function rptWindow(key) {
  const now = Date.now(); const today0 = dayStart(now);
  if (key === 'today') return { start: today0, end: now };
  if (key === '7') return { start: today0 - 6 * 86400000, end: now };
  if (key === '30') return { start: today0 - 29 * 86400000, end: now };
  const all = fullSales;
  const earliest = all.length ? Math.min(...all.map(s => s.createdAt || now)) : now;
  return { start: dayStart(earliest), end: now };
}
async function renderReports() {
  [fullSales, items] = await Promise.all([api('GET', '/api/sales/full'), api('GET', '/api/items/full')]);
  const { start, end } = rptWindow(rptRange);
  const inRange = fullSales.filter(s => !s.test && (s.createdAt || 0) >= start && (s.createdAt || 0) <= end);
  const fmtDate = ms => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  $('rptRangeHint').textContent = `${fmtDate(start)} – ${fmtDate(end)} · ${inRange.length ? `${inRange.length} sale${inRange.length === 1 ? '' : 's'}` : 'no sales yet'}`;
  const revenue = inRange.reduce((n, s) => n + num(s.total), 0);
  const profit = inRange.reduce((n, s) => n + num(s.profit), 0);
  const tax = inRange.reduce((n, s) => n + num(s.tax), 0);
  const itemsSold = inRange.reduce((n, s) => n + s.lines.reduce((m, l) => m + num(l.qty), 0), 0);
  const avg = inRange.length ? revenue / inRange.length : 0;
  const tiles = [
    { lbl: 'Revenue', val: money(revenue) }, { lbl: 'Profit', val: money(profit), neg: profit < 0, highlight: true },
    { lbl: 'Tax collected', val: money(tax) }, { lbl: 'Sales', val: inRange.length },
    { lbl: 'Items sold', val: itemsSold }, { lbl: 'Avg sale', val: money(avg) },
  ];
  $('rptStats').innerHTML = tiles.map(t => `<div class="stat-tile${t.highlight ? ' highlight' : ''}"><div class="lbl">${t.lbl}</div><div class="val${t.neg ? ' neg' : ''}">${t.val}</div></div>`).join('');
  renderRptChart(inRange, start, end);
  renderRptTop(inRange);
  renderRptTender(inRange, revenue);
  renderRptCost(inRange);
  renderRptEvents();
}

// Aggregates a list of (full, profit-bearing) sales by item, for the cost-breakdown and
// per-event drill-downs. Uses each item's CURRENT cost/recipe — fine for recent sales, but
// note the figure can drift from a sale's own recorded profit if the recipe changed since.
function buildItemBreakdown(salesList) {
  const map = new Map();
  for (const s of salesList) {
    const included = !!s.taxIncluded;
    for (const l of s.lines) {
      const { sub } = lineTaxSplit(l, included);
      const key = l.itemId || ('custom:' + l.name);
      let entry = map.get(key);
      if (!entry) entry = { itemId: l.itemId || null, name: l.name, qty: 0, revenue: 0, cost: 0, hasCost: !!l.itemId };
      entry.qty += num(l.qty);
      entry.revenue += sub;
      if (l.itemId) {
        const it = itemById(l.itemId);
        entry.cost += (it ? num(it.cost) : 0) * num(l.qty);
      }
      map.set(key, entry);
    }
  }
  return [...map.values()].sort((a, b) => b.revenue - a.revenue);
}
function materialBreakdownRows(entry) {
  if (!entry.itemId) return null;
  const it = itemById(entry.itemId);
  if (!it || !it.materials || !it.materials.length) return [];
  return it.materials.map(r => {
    const src = matSource(r);
    const unit = unitCost(src);
    const usedPerItem = num(r.per);
    const totalUsed = usedPerItem * entry.qty;
    return { name: (src && src.name) || r.name || 'Material', usedPerItem, totalUsed, unitCost: unit, totalCost: unit * totalUsed };
  });
}
function buildCostRow(entry) {
  const row = document.createElement('div'); row.className = 'rpt-cost-row';
  const profit = entry.revenue - entry.cost;
  const margin = entry.hasCost && entry.revenue > 0 ? (profit / entry.revenue * 100).toFixed(0) + '%' : '';
  row.innerHTML = `
    <button class="rpt-cost-head" type="button">
      <span class="rpt-cost-name"></span>
      <span class="rpt-cost-qty"></span>
      <span class="rpt-cost-rev"></span>
      <span class="rpt-cost-cost"></span>
      <span class="rpt-cost-profit"></span>
    </button>
    <div class="rpt-cost-body" hidden></div>`;
  row.querySelector('.rpt-cost-name').textContent = entry.name;
  row.querySelector('.rpt-cost-qty').textContent = entry.qty + '×';
  row.querySelector('.rpt-cost-rev').textContent = money(entry.revenue);
  row.querySelector('.rpt-cost-cost').textContent = entry.hasCost ? money(entry.cost) : '—';
  const profEl = row.querySelector('.rpt-cost-profit');
  profEl.textContent = entry.hasCost ? `${money(profit)}${margin ? ` (${margin})` : ''}` : 'no cost data';
  profEl.classList.toggle('neg', entry.hasCost && profit < 0);
  const body = row.querySelector('.rpt-cost-body');
  const mats = materialBreakdownRows(entry);
  if (mats === null) {
    body.innerHTML = `<div class="hint">Custom item — no recipe or cost on file.</div>`;
  } else if (!mats.length) {
    body.innerHTML = `<div class="hint">This item has no materials recorded.</div>`;
  } else {
    body.innerHTML = `<table class="rpt-mat-table"><thead><tr><th>Material</th><th class="r">Used per item</th><th class="r">Total used</th><th class="r">Unit cost</th><th class="r">Total cost</th></tr></thead><tbody>${
      mats.map(m => `<tr><td>${esc(m.name)}</td><td class="r">${m.usedPerItem.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td><td class="r">${m.totalUsed.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td><td class="r">${money4(m.unitCost)}</td><td class="r">${money(m.totalCost)}</td></tr>`).join('')
    }</tbody></table>`;
  }
  row.querySelector('.rpt-cost-head').onclick = () => { body.hidden = !body.hidden; };
  return row;
}
function renderRptCost(inRange) {
  const box = $('rptCostList');
  const rows = buildItemBreakdown(inRange);
  $('rptCostHeader').hidden = rows.length === 0;
  $('rptCostEmpty').hidden = rows.length > 0;
  box.innerHTML = '';
  rows.forEach(r => box.appendChild(buildCostRow(r)));
}
function renderRptEvents() {
  const box = $('rptEventsList');
  const evs = events.filter(e => !e.test).slice().sort((a, b) => (b.start || '').localeCompare(a.start || ''));
  $('rptEventsEmpty').hidden = evs.length > 0;
  box.innerHTML = '';
  for (const ev of evs) {
    const evSalesList = fullSales.filter(s => s.eventId === ev.id && !s.test);
    const revenue = evSalesList.reduce((n, s) => n + num(s.total), 0);
    const grossProfit = evSalesList.reduce((n, s) => n + num(s.profit), 0);
    const cost = num(ev.cost);
    const net = grossProfit - cost;
    const row = document.createElement('div'); row.className = 'rpt-ev-row';
    row.innerHTML = `
      <button class="rpt-ev-head" type="button">
        <span class="rpt-ev-name"></span>
        <span class="rpt-ev-meta"></span>
        <span class="rpt-ev-net"></span>
      </button>
      <div class="rpt-ev-body" hidden></div>`;
    row.querySelector('.rpt-ev-name').textContent = (ev.name || 'Event') + (ev.status === 'open' ? ' · open' : '');
    row.querySelector('.rpt-ev-meta').textContent = `${ev.start ? new Date(ev.start + 'T00:00:00').toLocaleDateString() : ''} · ${evSalesList.length} sale${evSalesList.length === 1 ? '' : 's'} · ${money(revenue)} revenue`;
    const netEl = row.querySelector('.rpt-ev-net');
    netEl.textContent = `True profit ${net >= 0 ? '+' : '−'}${money(Math.abs(net))}`;
    netEl.classList.add(net >= 0 ? 'pos' : 'neg');
    const body = row.querySelector('.rpt-ev-body');
    body.innerHTML = `
      <div class="rpt-ev-stats">
        <div><span>Revenue</span><b>${money(revenue)}</b></div>
        <div><span>Gross profit</span><b>${money(grossProfit)}</b></div>
        <div><span>Booth / event cost</span><b>−${money(cost)}</b></div>
        <div><span>True profit</span><b class="${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : '−'}${money(Math.abs(net))}</b></div>
      </div>
      <div class="hint">True profit is this event's sales profit minus its booth/space cost — use it when splitting proceeds among partners.</div>`;
    const itemRows = buildItemBreakdown(evSalesList);
    if (itemRows.length) {
      const list = document.createElement('div'); list.className = 'rpt-ev-items';
      itemRows.forEach(r => list.appendChild(buildCostRow(r)));
      body.appendChild(list);
    }
    row.querySelector('.rpt-ev-head').onclick = () => { body.hidden = !body.hidden; };
    box.appendChild(row);
  }
}

// PDF export: the browser's own print-to-PDF, not a bundled PDF library — this app needs to
// keep working fully offline on a standalone install, so it can't depend on a CDN script.
$('rptExportPdf').onclick = () => {
  const bodies = [...document.querySelectorAll('#tab-reports .rpt-cost-body, #tab-reports .rpt-ev-body')];
  const prevHidden = bodies.map(el => el.hidden);
  bodies.forEach(el => { el.hidden = false; });
  const restore = () => {
    bodies.forEach((el, i) => { el.hidden = prevHidden[i]; });
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);
  window.print();
};
function renderRptChart(inRange, start, end) {
  const box = $('rptChart');
  $('rptChartEmpty').hidden = inRange.length > 0; box.hidden = inRange.length === 0;
  if (!inRange.length) { box.innerHTML = ''; return; }
  const spanDays = Math.max(1, Math.round((dayStart(end) - start) / 86400000) + 1);
  const bucketDays = spanDays <= 31 ? 1 : spanDays <= 180 ? 7 : 30;
  const n = Math.min(60, Math.max(1, Math.ceil(spanDays / bucketDays)));
  const buckets = Array.from({ length: n }, (_, i) => ({ startMs: start + i * bucketDays * 86400000, revenue: 0, profit: 0 }));
  for (const s of inRange) { const idx = Math.min(n - 1, Math.max(0, Math.floor((dayStart(s.createdAt) - start) / 86400000 / bucketDays))); buckets[idx].revenue += num(s.total); buckets[idx].profit += num(s.profit); }
  const max = Math.max(1, ...buckets.map(b => b.revenue));
  const labelEvery = Math.max(1, Math.ceil(n / 10));
  const fmt = bucketDays === 1 ? (ms => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })) : bucketDays === 30 ? (ms => new Date(ms).toLocaleDateString(undefined, { month: 'short' })) : (ms => `wk of ${new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`);
  box.innerHTML = buckets.map((b, i) => { const h = Math.max(3, Math.round(b.revenue / max * 130)); const label = i % labelEvery === 0 ? fmt(b.startMs) : ''; return `<div class="rpt-bar-col"><div class="rpt-bar-tip">${esc(fmt(b.startMs))}<br>Revenue ${money(b.revenue)}<br>Profit ${money(b.profit)}</div><div class="rpt-bar" style="height:${h}px"></div><div class="rpt-bar-label">${esc(label)}</div></div>`; }).join('');
}
function renderRptTop(inRange) {
  const box = $('rptTopList'); const map = new Map();
  for (const s of inRange) for (const l of s.lines) { const key = l.itemId || ('custom:' + l.name); const entry = map.get(key) || { name: l.name, qty: 0, revenue: 0 }; entry.qty += num(l.qty); entry.revenue += num(l.price) * num(l.qty); map.set(key, entry); }
  const top = [...map.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10);
  $('rptTopEmpty').hidden = top.length > 0; box.hidden = top.length === 0;
  if (!top.length) { box.innerHTML = ''; return; }
  const max = Math.max(1, ...top.map(t => t.revenue));
  box.innerHTML = top.map(t => `<div class="rpt-top-row"><span class="rpt-top-name"></span><div class="rpt-top-track"><div class="rpt-top-fill" style="width:${t.revenue / max * 100}%"></div></div><span class="rpt-top-num">${money(t.revenue)} <small style="color:var(--muted)">· ${t.qty}×</small></span></div>`).join('');
  box.querySelectorAll('.rpt-top-name').forEach((el, i) => { el.textContent = top[i].name; });
}
function renderRptTender(inRange, revenue) {
  const box = $('rptTender');
  const cash = inRange.filter(s => s.tender === 'cash').reduce((n, s) => n + num(s.total), 0);
  const other = revenue - cash;
  const pct = v => revenue > 0 ? Math.round(v / revenue * 100) + '%' : '—';
  box.innerHTML = [['Cash', money(cash), pct(cash)], ['Card / Other', money(other), pct(other)]].map(([lbl, val, sub]) => `<div class="stat-tile"><div class="lbl">${lbl}</div><div class="val">${val}</div><div class="sub">${sub} of revenue</div></div>`).join('');
}
document.querySelectorAll('#rptRangeSeg button').forEach(b => b.onclick = () => { rptRange = b.dataset.range; document.querySelectorAll('#rptRangeSeg button').forEach(x => x.classList.toggle('on', x === b)); renderReports(); });

// ---------- Settings: users (admins + cashiers) ----------
async function loadUsers() { admins = await api('GET', '/api/auth/users'); renderUsers(); }
function renderUsers() {
  $('curAdminLine').textContent = `Signed in as ${me.name} (${me.username})`;
  const tb = $('adminRows'); tb.innerHTML = '';
  const adminCount = admins.filter(a => a.role === 'admin').length;
  for (const a of admins) {
    const isLastAdmin = a.role === 'admin' && adminCount <= 1;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(a.name)}${a.id === me.id ? ' <small style="color:var(--muted)">(you)</small>' : ''}</td><td>${esc(a.username)}</td>
      <td><span class="role-badge ${a.role}">${a.role === 'admin' ? 'Admin' : 'Cashier'}</span></td>
      <td>${new Date(a.createdAt).toLocaleDateString()}</td>
      <td class="acts">
        <button class="btn sm toggleRole"${isLastAdmin ? ' disabled title="Can’t demote the last admin"' : ''}>${a.role === 'admin' ? 'Make cashier' : 'Make admin'}</button>
        <button class="btn sm resetPw">Reset password</button>
        <button class="icon-btn del" title="Remove account"${isLastAdmin ? ' disabled title="Can’t remove the last admin"' : ''}>×</button>
      </td>`;
    tr.querySelector('.toggleRole').onclick = async () => {
      const newRole = a.role === 'admin' ? 'cashier' : 'admin';
      try { await api('POST', `/api/auth/users/${a.id}/role`, { role: newRole }); toast(`${a.name} is now ${newRole === 'admin' ? 'an admin' : 'a cashier'}`); await loadUsers(); }
      catch (e) { toast(e.message || 'Could not change role'); }
    };
    tr.querySelector('.resetPw').onclick = async () => {
      const pw = prompt(`New password for ${a.name} (min 8 characters):`);
      if (!pw) return;
      try { await api('POST', `/api/auth/users/${a.id}/password`, { password: pw }); toast('Password updated'); }
      catch (e) { toast(e.message || 'Could not update password'); }
    };
    tr.querySelector('.del').onclick = async () => {
      if (!await askConfirm(`Remove ${a.role} account “${a.name}”?`, 'Remove account')) return;
      try { await api('DELETE', '/api/auth/users/' + a.id); toast('Account removed'); if (a.id === me.id) { me = null; updateAuthUI(); openLogin('pos'); return; } await loadUsers(); }
      catch (e) { toast(e.message || 'Could not remove account'); }
    };
    tb.appendChild(tr);
  }
}
$('addAdminBtn').onclick = () => { $('addAdminForm').hidden = false; $('newAdminName').focus(); };
$('newAdminCancel').onclick = () => { $('addAdminForm').hidden = true; };
$('newAdminSave').onclick = async () => {
  const name = $('newAdminName').value.trim(), username = $('newAdminUsername').value.trim(), password = $('newAdminPassword').value;
  const role = document.querySelector('input[name="newUserRole"]:checked')?.value || 'cashier';
  if (!name || !username || password.length < 8) { toast('Name, username, and an 8+ character password are required'); return; }
  try {
    await api('POST', '/api/auth/users', { name, username, password, role });
    $('newAdminName').value = ''; $('newAdminUsername').value = ''; $('newAdminPassword').value = ''; $('addAdminForm').hidden = true;
    toast(`Added ${role} “${name}”`);
    await loadUsers();
  } catch (e) { toast(e.code === 'username_taken' ? 'That username is already taken' : (e.message || 'Could not add account')); }
};

// ---------- Backup ----------
$('exportBtn').onclick = async () => {
  const [allItems, allMats, allSales, allEvents] = await Promise.all([api('GET', '/api/items/full'), api('GET', '/api/materials'), api('GET', '/api/sales/full'), api('GET', '/api/events')]);
  const data = { app: 'workshop-pos', version: 1, exportedAt: new Date().toISOString(), materials: allMats, items: allItems, sales: allSales, events: allEvents };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `workshop-pos-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Exported ${allItems.length} items and ${allMats.length} materials`);
};
$('importBtn').onclick = () => $('importFile').click();
$('importFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  let d;
  try { d = JSON.parse(await f.text()); if (!Array.isArray(d.items) || !Array.isArray(d.materials)) throw new Error(); }
  catch { toast('That file isn’t a Workshop POS backup'); return; }
  if (!await askConfirm(`Import ${d.items.length} items and ${d.materials.length} materials? Existing items/materials with matching ids will be overwritten.`, 'Import backup')) return;
  for (const m of d.materials) await api('POST', '/api/materials', m);
  for (const it of d.items) await api('POST', '/api/items', it);
  for (const ev of (d.events || [])) await api('POST', '/api/events', ev);
  toast('Backup imported');
  await Promise.all([loadMaterials(), loadItems(), loadEvents(), loadPosItems()]);
};

// ---------- UI wiring ----------
function askConfirm(text, okLabel) {
  return new Promise(resolve => {
    const modal = $('modal');
    $('modalText').textContent = text; $('modalOk').textContent = okLabel;
    modal.hidden = false; $('modalCancel').focus();
    const onKey = e => { if (e.key === 'Escape') done(false); };
    const done = v => { modal.hidden = true; document.removeEventListener('keydown', onKey); resolve(v); };
    document.addEventListener('keydown', onKey);
    $('modalOk').onclick = () => done(true); $('modalCancel').onclick = () => done(false);
    modal.onclick = e => { if (e.target === modal) done(false); };
  });
}
let toastTimer;
function toast(msg) { $('toast').textContent = msg; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2400); }

// ---------- Version / release notes ----------
let releaseNotes = [];
async function loadVersionInfo() {
  const { version, releaseNotes: notes } = await api('GET', '/api/meta/version');
  releaseNotes = notes;
  $('appVersion').textContent = `v${version}`;
}
function renderReleaseNotes() {
  $('releaseNotesList').innerHTML = releaseNotes.map(r => `
    <div class="rn-entry">
      <div class="rn-head"><b>v${esc(r.version)}</b><span>${esc(r.date)}</span></div>
      <ul>${r.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>
    </div>`).join('');
}
$('whatsNewLink').onclick = () => { renderReleaseNotes(); $('releaseNotesModal').hidden = false; };
$('releaseNotesClose').onclick = () => { $('releaseNotesModal').hidden = true; };
$('releaseNotesModal').addEventListener('click', e => { if (e.target === $('releaseNotesModal')) $('releaseNotesModal').hidden = true; });

// ---------- Boot ----------
(async function boot() {
  addMaterial(); setMode('markup'); setTender('cash'); setTestMode(testMode);
  $('footYear').textContent = new Date().getFullYear();
  loadVersionInfo().catch(() => {});
  try {
    const s = await refreshAuthStatus();
    $('app').hidden = false;
    if (s.needsSetup || !s.me) { openLogin('pos'); return; }
    closeLogin();
    await afterLogin();
    showTab('pos');
  } catch (e) {
    $('app').hidden = false;
    toast('Could not reach the server. Check that it’s running.');
  }
})();
