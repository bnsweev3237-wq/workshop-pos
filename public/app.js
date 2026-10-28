const $ = id => document.getElementById(id);
const money = n => { n = isFinite(n) ? n : 0; return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random());

// Shared by the Items and Materials tabs' sort dropdowns. Remembered per browser (not synced
// server-side) since it's a personal viewing preference, not shop data.
function loadSortPref(key) {
  try { return localStorage.getItem('workshopPos.' + key) || 'name-asc'; } catch { return 'name-asc'; }
}
function saveSortPref(key, value) {
  try { localStorage.setItem('workshopPos.' + key, value); } catch {}
}
function sortByPref(list, pref, getAdded) {
  const sorted = [...list];
  if (pref === 'added-asc') sorted.sort((a, b) => num(getAdded(a)) - num(getAdded(b)));
  else if (pref === 'added-desc') sorted.sort((a, b) => num(getAdded(b)) - num(getAdded(a)));
  else if (pref === 'name-desc') sorted.sort((a, b) => (b.name || '').localeCompare(a.name || ''));
  else sorted.sort((a, b) => (a.name || '').localeCompare(b.name || '')); // name-asc, and the default
  return sorted;
}

// Downscales and re-encodes an uploaded image as JPEG, via an off-DOM canvas, so a phone's
// full-resolution photo doesn't get stored and shipped around at full size. Resolves to a
// data: URL; rejects only if the file can't be decoded as an image at all.
function compressImage(file, { maxDim = 900, targetBytes = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        // JPEG has no alpha channel — flatten any transparency onto white first, rather than
        // let the browser pick (usually black, which looks broken for a product photo).
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        // Step quality down until the result is roughly under targetBytes, or we've tried
        // enough times — a simple, low-detail photo may hit the target on the first pass, a
        // busy one needs a few. *1.37 approximates base64's ~4/3 overhead so the character
        // count (what we can actually measure) tracks real byte size.
        let quality = 0.82;
        let dataUrl = canvas.toDataURL('image/jpeg', quality);
        for (let i = 0; i < 6 && dataUrl.length > targetBytes * 1.37 && quality > 0.3; i++) {
          quality -= 0.12;
          dataUrl = canvas.toDataURL('image/jpeg', quality);
        }
        resolve(dataUrl);
      };
      img.onerror = () => reject(new Error('Could not read that image'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('Could not read that image'));
    reader.readAsDataURL(file);
  });
}

// Caches the app shell so it can open at all with no connection (installable as a PWA too —
// see manifest.json). Has nothing to do with the Sell page's actual offline sale handling,
// which lives below and in offline.js.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

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
// the only thing that changes what's reachable. The server enforces this independently (see
// server/middleware/auth.js); this is just the UI following suit so an account isn't shown
// buttons that would 403. Keep in sync with the role groups there:
//   admin:   everything
//   manager: everything but Settings
//   lead:    Sell + Reports
//   cashier: Sell only (and a restricted Sell — see the POS section below)
const ROLE_TABS = {
  admin: ['pos', 'calc', 'lib', 'items', 'orders', 'reports', 'settings'],
  manager: ['pos', 'calc', 'lib', 'items', 'orders', 'reports'],
  lead: ['pos', 'orders', 'reports'],
  cashier: ['pos'],
};
const ROLE_LABEL = { admin: 'Admin', manager: 'Manager', lead: 'Lead', cashier: 'Cashier' };
// The base cashier role gets a restricted Sell page on top of being Sell-only: no custom
// items, no editing/ending an event, no overriding a ticket line's tax rate. Enforced
// server-side too (see server/routes/sales.js, events.js) — this just keeps the UI from
// showing controls that would 403 anyway.
const isRestrictedCashier = () => !!me && me.role === 'cashier';
let me = null;
let needsSetup = false;
let forceChangePassword = false;
let pendingTab = null;
let currentTab = 'pos';

function onUnauthorized() {
  me = null;
  updateAuthUI();
  openLogin(currentTab);
}

async function refreshAuthStatus() {
  const s = await api('GET', '/api/auth/status');
  needsSetup = s.needsSetup;
  me = s.me;
  if (me) Offline.saveSnapshot('me', me);
  updateAuthUI();
  return s;
}

function updateAuthUI() {
  const isAdmin = !!me && me.role === 'admin';
  const canManageItems = !!me && (me.role === 'admin' || me.role === 'manager');
  const myTabs = me ? ROLE_TABS[me.role] || ['pos'] : [];
  $('authStatus').textContent = me ? `Signed in as ${me.name}${me.role !== 'admin' ? ' · ' + ROLE_LABEL[me.role] : ''}` : '';
  $('exportBtn').hidden = !canManageItems;
  $('importBtn').hidden = !canManageItems;
  $('signOutBtn').hidden = !me;
  document.querySelectorAll('#tabs button[data-tab]').forEach(b => {
    if (b.dataset.tab === 'pos') return;
    b.hidden = !myTabs.includes(b.dataset.tab);
  });
  $('posCustomToggle').hidden = isRestrictedCashier();
  if (isRestrictedCashier()) { $('posCustomRow').hidden = true; $('posCustomAddRow').hidden = true; }
}
$('signOutBtn').onclick = () => logout();

function openLogin(forTab) {
  pendingTab = forTab || null;
  forceChangePassword = false;
  $('loginError').hidden = true;
  $('forgotPanel').hidden = true;
  $('forceChangeFields').hidden = true;
  $('loginSubmit').textContent = 'Sign in';
  if (needsSetup) {
    $('loginTitle').textContent = 'Set up the first admin';
    $('loginSub').textContent = 'No account exists yet — create the first admin to manage pricing, materials, and other accounts.';
    $('loginFields').hidden = true;
    $('setupFields').hidden = false;
    $('forgotLink').hidden = true;
  } else {
    $('loginTitle').textContent = 'Sign in';
    $('loginSub').textContent = 'Sign in to use Craftium.';
    $('loginFields').hidden = false;
    $('setupFields').hidden = true;
    $('forgotLink').hidden = false;
  }
  $('loginScreen').hidden = false;
  (needsSetup ? $('setupName') : $('loginUsername')).focus();
}
function closeLogin() { $('loginScreen').hidden = true; pendingTab = null; }

// Shown right after a fresh account's first login or an admin-reset login, instead of
// entering the app — the password that got them in was chosen by someone else, so they have
// to replace it with one only they know before going any further. No way to dismiss this
// screen except submitting a new password: no forgot-password link, no close button.
function showForceChangeScreen() {
  forceChangePassword = true;
  $('loginError').hidden = true;
  $('forgotPanel').hidden = true;
  $('forgotLink').hidden = true;
  $('loginTitle').textContent = 'Set a new password';
  $('loginSub').textContent = `Welcome, ${me.name}. For security, set a password only you know before continuing.`;
  $('loginFields').hidden = true;
  $('setupFields').hidden = true;
  $('forceChangeFields').hidden = false;
  $('forcePassword1').value = '';
  $('forcePassword2').value = '';
  $('loginSubmit').textContent = 'Set password';
  $('loginScreen').hidden = false;
  $('forcePassword1').focus();
}

$('forgotLink').onclick = () => { $('forgotPanel').hidden = !$('forgotPanel').hidden; };

$('loginSubmit').onclick = async () => {
  $('loginError').hidden = true;
  try {
    if (forceChangePassword) {
      const p1 = $('forcePassword1').value, p2 = $('forcePassword2').value;
      if (p1.length < 8) throw new Error('Password must be at least 8 characters.');
      if (p1 !== p2) throw new Error('Passwords don’t match.');
      const r = await api('POST', '/api/auth/password', { newPassword: p1 });
      me = r.me;
      forceChangePassword = false;
    } else if (needsSetup) {
      const name = $('setupName').value.trim(), username = $('setupUsername').value.trim(), password = $('setupPassword').value;
      if (!name || !username || password.length < 8) throw new Error('Name, username, and a password of at least 8 characters are required.');
      const r = await api('POST', '/api/auth/setup', { name, username, password });
      me = r.me; needsSetup = false;
    } else {
      const username = $('loginUsername').value.trim(), password = $('loginPassword').value;
      const r = await api('POST', '/api/auth/login', { username, password });
      me = r.me;
    }
    if (me.mustChangePassword) { showForceChangeScreen(); return; }
    updateAuthUI();
    const dest = (pendingTab && (ROLE_TABS[me.role] || ['pos']).includes(pendingTab)) ? pendingTab : 'pos';
    closeLogin();
    await afterLogin();
    showTab(dest);
    toast(`Welcome, ${me.name}`);
  } catch (e) {
    $('loginError').textContent = e.message === 'invalid_credentials' || e.code === 'invalid_credentials' ? 'Incorrect username or password.' : e.message;
    $('loginError').hidden = false;
  }
};
[$('loginUsername'), $('loginPassword'), $('forcePassword1'), $('forcePassword2')].forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') $('loginSubmit').click(); }));

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
  // loadSettings before loadCardProcessors, not in the same Promise.all — the latter preselects
  // the Sell page's default processor from appSettings.defaultCardProcessorId, which only the
  // former populates (it starts out as '' at boot, before either has run).
  await Promise.all([loadPosItems(), loadSales(), loadEvents(), loadSettings()]);
  await loadCardProcessors();
  trySyncQueuedSales(); // picks up anything still queued from a prior offline session, if we're online now
  if (!pollTimer) {
    pollTimer = setInterval(() => { if (!document.hidden && me) Promise.all([loadPosItems(), loadSales(), loadEvents()]).catch(() => {}); }, 20000);
  }
}

// ---------- Tabs ----------
function showTab(t) {
  if (!me) { openLogin(t); return; }
  if (!(ROLE_TABS[me.role] || ['pos']).includes(t)) t = 'pos';
  currentTab = t;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  ['calc', 'lib', 'items', 'orders', 'pos', 'reports', 'settings'].forEach(x => $('tab-' + x).hidden = x !== t);
  if (t === 'calc') calc();
  if (t === 'lib') loadMaterials();
  if (t === 'items') loadItems();
  if (t === 'orders') loadCustomOrders();
  if (t === 'reports') renderReports();
  if (t === 'settings') { loadUsers(); loadSettings(); loadSources(); loadTaxPresets(); loadCardProcessors(); loadServerBackups(); loadUpdateStatus(); loadDiskUsage(); loadDuplicates(); loadMailSettings(); loadLicenseStatus(); fillBrandingForm(); }
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
  if (s.itemType === 'resale') {
    const cost = num(s.resaleCost), price = num(s.resalePrice);
    return { mat: 0, lab: 0, ovh: 0, cost, raw: price, suggested: price, overridden: false, price };
  }
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
let itemType = 'made';
function setItemType(t) {
  itemType = t === 'resale' ? 'resale' : 'made';
  document.querySelectorAll('#itemTypeSeg button').forEach(b => b.classList.toggle('on', b.dataset.type === itemType));
  $('madeCards').hidden = itemType !== 'made';
  $('resaleCard').hidden = itemType !== 'resale';
  calc();
}
document.querySelectorAll('#itemTypeSeg button').forEach(b => b.onclick = () => setItemType(b.dataset.type));
['resaleCost', 'resalePrice'].forEach(id => $(id).addEventListener('input', calc));
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
    itemType,
    name: $('itemName').value.trim(),
    categories: [...new Set($('itemCategory').value.split(',').map(c => c.trim()).filter(Boolean))],
    notForShows: $('itemNotForShows').checked,
    notes: $('itemNotes').value.trim(),
    stock: $('stock').value, low: $('itemLow').value,
    materials: [...$('mats').children].map(tr => {
      const [n, p, y, u] = tr.querySelectorAll('input');
      const row = { name: n.value, price: p.value, yield: y.value, per: u.value };
      if (tr.dataset.lib) row.libId = tr.dataset.lib; else row.addToLib = tr.querySelector('.lib-chk').checked;
      return row;
    }),
    costMode, minutes: $('minutes').value, rate: $('rate').value, overhead: $('overhead').value,
    mode, pct: $('pct').value, round: $('round').value, override: $('override').value,
    resaleCost: $('resaleCost').value, resalePrice: $('resalePrice').value,
  };
}

function calc() {
  const s = readForm();
  const r = computeItem(s);
  [...$('mats').children].forEach((tr, i) => {
    const row = s.materials[i];
    const unit = unitCost(matSource(row));
    const detail = num(row.per) !== 1 ? `<small>${money(unit)} × ${num(row.per)}</small>` : '';
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

let currentItemPhoto = '';
function renderItemPhotoPreview() {
  $('itemPhotoPreview').innerHTML = currentItemPhoto ? `<img src="${currentItemPhoto}">` : '<span class="ph">No photo</span>';
  $('itemPhotoRemoveBtn').hidden = !currentItemPhoto;
}
$('itemPhotoPickBtn').onclick = () => $('itemPhotoFile').click();
$('itemPhotoFile').onchange = async () => {
  const file = $('itemPhotoFile').files[0];
  $('itemPhotoFile').value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('Please choose an image file'); return; }
  try {
    currentItemPhoto = await compressImage(file);
    renderItemPhotoPreview();
    toast('Photo ready — save the item to keep it');
  } catch (e) { toast(e.message || 'Could not read that image'); }
};
$('itemPhotoRemoveBtn').onclick = () => { currentItemPhoto = ''; renderItemPhotoPreview(); };

function restore(s) {
  setItemType(s.itemType || 'made');
  currentItemPhoto = s.photo || ''; renderItemPhotoPreview();
  $('itemName').value = s.name;
  $('itemCategory').value = (s.categories || []).join(', ');
  $('itemNotForShows').checked = !!s.notForShows;
  $('itemNotes').value = s.notes || '';
  $('itemNoHint').hidden = !s.itemNo;
  $('itemNoHint').textContent = s.itemNo ? `Item #${s.itemNo}` : '';
  $('stock').value = s.stock ?? 0; $('itemLow').value = s.low ?? '';
  $('mats').innerHTML = '';
  (s.materials.length ? s.materials : [{}]).forEach(m => addMaterial(m));
  $('minutes').value = s.minutes; $('rate').value = s.rate; $('overhead').value = s.overhead;
  setCostMode(s.costMode || 'none');
  $('pct').value = s.pct; $('round').value = s.round; $('override').value = s.override ?? '';
  $('resaleCost').value = s.cost ?? 0; $('resalePrice').value = s.price ?? 0;
  setMode(s.mode, true);
  currentEditId = s.id || null;
}
let currentEditId = null;

$('addMat').onclick = () => addMaterial().focus();
$('reset').onclick = () => {
  currentEditId = null;
  restore({ itemType: 'made', name: '', categories: [], override: '', stock: 0, low: '', costMode, materials: [], minutes: 0, rate: $('rate').value, overhead: $('overhead').value, mode, pct: defaults[mode], round: 'whole', cost: 0, price: 0 });
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
      entry = await api('POST', '/api/materials', { name, price: row.price, yield: row.yield || 1, stock: 0, test: testMode });
      lib.push(entry);
      added.push(name);
    }
    row.libId = entry.id; row.name = entry.name; row.price = entry.price; row.yield = entry.yield;
    const tr = $('mats').children[idx];
    if (tr) link(tr, entry);
  }
  const r = computeItem(s);
  const existing = currentEditId ? items.find(x => x.id === currentEditId) : items.find(x => x.name.toLowerCase() === s.name.toLowerCase());
  const saved = await api('POST', '/api/items', { ...s, id: existing ? existing.id : undefined, price: r.price, cost: r.cost, photo: currentItemPhoto, test: testMode });
  currentEditId = saved.id;
  $('itemNoHint').hidden = false;
  $('itemNoHint').textContent = `Item #${saved.itemNo}`;
  toast((existing ? `Updated “${s.name}”` : `Saved “${s.name}”`) + (added.length ? ` · added ${added.join(', ')} to library` : ''));
  // Also refresh the public Sell-page list — otherwise a newly saved (or price/stock-edited)
  // item wouldn't show up there until the next 20s poll tick.
  await Promise.all([loadItems(), loadPosItems()]);
  if (added.length) renderLib();
  showTab('items');
};

// ---------- Material library ----------
let sources = [];
async function loadSources() { sources = await api('GET', '/api/sources'); renderSourceRows(); }
async function loadMaterials() {
  await loadSources();
  lib = await api('GET', `/api/materials?test=${testMode ? 1 : 0}`);
  renderLib();
}
function priceCheckErrorMessage(code) {
  switch (code) {
    case 'no_product_url': return 'Add a product link first.';
    case 'invalid_url': return 'That link doesn’t look valid.';
    case 'timed_out': return 'The page took too long to respond — try again.';
    case 'price_not_found': return 'Couldn’t find a price on that page — the site may block automated checks, or render its price with JavaScript instead of including it in the page itself.';
    case 'fetch_failed': return 'Could not load that page.';
    case 'blocked_address': return 'That link points somewhere this feature isn’t allowed to check.';
    case 'too_many_redirects': return 'That link redirected too many times — try the direct product page link instead.';
    default: return 'Could not check the price — try again later.';
  }
}
let libSearch = '';
let libSort = loadSortPref('libSort');
$('libSort').value = libSort;
function renderLib() {
  $('libList').innerHTML = lib.map(m => `<option value="${esc(m.name)}">`).join('');
  $('libCount').textContent = lib.length || '';
  const q = libSearch.trim().toLowerCase();
  const visible = sortByPref(lib.filter(m => !q || m.name.toLowerCase().includes(q)), libSort, (m) => m.created);
  $('libEmpty').hidden = visible.length > 0;
  $('libEmpty').textContent = lib.length === 0 ? 'No materials yet.' : 'No materials match your search.';
  $('libTable').hidden = visible.length === 0;
  const tb = $('libRows'); tb.innerHTML = '';
  for (const m of visible) {
    const tr = document.createElement('tr'); tr.className = 'erow'; tr.dataset.id = m.id;
    const low = isLow(m.stock, m.low);
    tr.innerHTML = `
      <td><input class="in-name" placeholder="Material name"></td>
      <td data-l="Price paid ($)"><input class="in-small" type="number" min="0" step="0.01" placeholder="0.00"></td>
      <td data-l="Makes / pack of"><input class="in-small" type="number" min="1" step="any"></td>
      <td class="num" data-l="Per piece"></td>
      <td data-l="In stock"><input class="in-tiny stockIn" type="number" min="0" step="any"></td>
      <td data-l="Low at"><input class="in-tiny lowIn" type="number" min="0" step="any" placeholder="off"></td>
      <td data-l="Source"><select class="in-small sourceSelect"></select></td>
      <td class="num used" data-l="Used in"></td>
      <td class="acts">
        <button class="icon-btn link" title="Product link &amp; price check">🔗</button>
        <button class="icon-btn del" title="Delete material">×</button>
      </td>`;
    const [n, p, y, stockIn, lowIn] = tr.querySelectorAll('input');
    const sourceSelect = tr.querySelector('.sourceSelect');
    sourceSelect.innerHTML = '<option value="">—</option>' + sources.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    n.value = m.name; p.value = m.price; y.value = m.yield; stockIn.value = m.stock ?? 0; lowIn.value = m.low ?? '';
    sourceSelect.value = m.sourceId || '';
    const refresh = () => { tr.querySelector('.num').textContent = money(unitCost(m)); const u = usedIn(m.id); tr.querySelector('.used').textContent = u ? `${u} item${u > 1 ? 's' : ''}` : '—'; };
    refresh();
    stockIn.classList.toggle('low-input', low);
    let saveTimer;
    const onRowChange = () => {
      m.name = n.value; m.price = p.value; m.yield = y.value; m.stock = stockIn.value; m.low = lowIn.value; m.sourceId = sourceSelect.value || null;
      refresh(); stockIn.classList.toggle('low-input', isLow(m.stock, m.low)); refreshLowMatBanner();
      $('libList').innerHTML = lib.map(x => `<option value="${esc(x.name)}">`).join('');
      syncLinkedRows(); calc();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => api('POST', '/api/materials', m), 500);
    };
    tr.addEventListener('input', onRowChange);
    sourceSelect.addEventListener('change', onRowChange); // belt-and-suspenders for <select>'s historically inconsistent 'input' event support
    tr.querySelector('.del').onclick = () => deleteLib(m);

    // Detail row: product link + "Check price" — kept collapsed by default since a long URL
    // doesn't fit well as a permanent table column.
    const detailTr = document.createElement('tr'); detailTr.className = 'lib-detail'; detailTr.hidden = true;
    detailTr.innerHTML = `
      <td colspan="9">
        <div class="lib-detail-inner">
          <label>Product link <small style="color:var(--muted);font-weight:400">(for "Check price" below — never changes the price on its own)</small></label>
          <input class="productUrlIn" type="url" placeholder="https://www.amazon.com/...">
          <div class="btn-row"><button class="btn sm checkPriceBtn">Check price</button></div>
          <div class="checkPriceResult hint"></div>
        </div>
      </td>`;
    const urlIn = detailTr.querySelector('.productUrlIn');
    urlIn.value = m.productUrl || '';
    let urlSaveTimer;
    urlIn.addEventListener('input', () => {
      m.productUrl = urlIn.value;
      clearTimeout(urlSaveTimer);
      urlSaveTimer = setTimeout(() => api('POST', '/api/materials', m), 500);
    });
    const resultBox = detailTr.querySelector('.checkPriceResult');
    const checkBtn = detailTr.querySelector('.checkPriceBtn');
    checkBtn.onclick = async () => {
      if (!urlIn.value.trim()) { toast('Add a product link first'); urlIn.focus(); return; }
      checkBtn.disabled = true; checkBtn.textContent = 'Checking…';
      resultBox.innerHTML = '';
      try {
        const r = await api('POST', `/api/materials/${m.id}/check-price`);
        resultBox.innerHTML = `Found <b>${money(r.price)}</b> (currently ${money(num(m.price))}) <button class="btn sm acceptPriceBtn">Use this price</button>`;
        resultBox.querySelector('.acceptPriceBtn').onclick = async () => {
          m.price = r.price;
          p.value = r.price;
          await api('POST', '/api/materials', m);
          refresh(); syncLinkedRows(); calc(); refreshLowMatBanner();
          resultBox.textContent = `Price updated to ${money(r.price)}.`;
          toast(`${m.name || 'Material'} price updated to ${money(r.price)}`);
        };
      } catch (e) {
        resultBox.textContent = priceCheckErrorMessage(e.code);
      } finally {
        checkBtn.disabled = false; checkBtn.textContent = 'Check price';
      }
    };
    tr.querySelector('.link').onclick = () => { detailTr.hidden = !detailTr.hidden; };

    tb.appendChild(tr);
    tb.appendChild(detailTr);
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
  if (u && !await askConfirm(`“${m.name || 'This material'}” is used in ${u} item${u > 1 ? 's' : ''}. Those items will keep its current price as a one-off.`, 'Delete material')) return;
  const touched = items.filter(it => it.materials.some(r => r.libId === m.id));
  for (const it of touched) { for (const r of it.materials) if (r.libId === m.id) { r.name = m.name; r.price = m.price; r.yield = m.yield; delete r.libId; } await api('POST', '/api/items', it); }
  lib = lib.filter(x => x !== m);
  await api('DELETE', '/api/materials/' + m.id);
  renderLib(); if (touched.length) await loadItems();
}
$('addLib').onclick = async () => {
  const m = await api('POST', '/api/materials', { name: '', price: '', yield: 1, stock: 0, test: testMode });
  lib.push(m); renderLib();
  // Find it by id rather than assuming it's the last row — a sort other than "Date added
  // (newest)" won't put a brand-new, blank-named row last.
  $('libRows').querySelector(`tr[data-id="${m.id}"] .in-name`)?.focus();
};
$('libSearch').addEventListener('input', () => { libSearch = $('libSearch').value; renderLib(); });
$('libSort').addEventListener('change', () => { libSort = $('libSort').value; saveSortPref('libSort', libSort); renderLib(); });

$('libExportCsv').onclick = () => {
  const a = document.createElement('a');
  a.href = `/api/materials/export.csv?test=${testMode ? 1 : 0}`;
  a.click();
};
$('libImportCsv').onclick = () => $('libImportCsvFile').click();
$('libImportCsvFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  let csv;
  try { csv = await f.text(); } catch { toast('Could not read that file'); return; }
  try {
    const r = await api('POST', '/api/materials/import.csv', { csv, test: testMode });
    toast(`Imported: ${r.created} added, ${r.updated} updated${r.skipped ? `, ${r.skipped} skipped` : ''}${r.errors.length ? ` — ${r.errors[0]}` : ''}`);
    await loadMaterials();
  } catch (err) { toast(err.message || 'Import failed'); }
};

// ---------- Items ----------
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
async function loadItems() { items = await api('GET', `/api/items/full?test=${testMode ? 1 : 0}`); renderItems(); refreshCategoryList(); }
async function deleteItem(it) {
  if (!await askConfirm(`Delete “${it.name}”? This can’t be undone.`, 'Delete item')) return;
  await api('DELETE', '/api/items/' + it.id);
  await Promise.all([loadItems(), loadPosItems()]);
}
function refreshCategoryList() {
  const cats = [...new Set(items.flatMap(it => it.categories || []))].sort();
  $('categoryList').innerHTML = cats.map(c => `<option value="${esc(c)}">`).join('');
}
async function makeBatch(it, qty) {
  qty = Math.max(1, Math.round(num(qty)) || 1);
  try {
    const r = await api('POST', `/api/items/${it.id}/make`, { qty });
    toast(r.short.length ? `Made ${qty} more “${it.name}” — ran low on ${r.short.join(', ')}` : `Made ${qty} more “${it.name}”`);
  } catch (e) { toast('Could not update stock — try again.'); }
  await Promise.all([loadItems(), loadMaterials(), loadPosItems()]);
}
async function sellItem(it, qty) {
  qty = Math.max(1, Math.round(num(qty)) || 1);
  try {
    const r = await api('POST', `/api/items/${it.id}/sell`, { qty });
    toast(qty > r.had ? `Sold ${r.had} “${it.name}” (only had ${r.had} in stock)` : `Sold ${qty} “${it.name}”`);
  } catch (e) { toast('Could not update stock — try again.'); }
  await Promise.all([loadItems(), loadPosItems()]);
}
let itemsSearch = '';
let itemsSort = loadSortPref('itemsSort');
$('itemsSort').value = itemsSort;
function renderItems() {
  const tb = $('itemRows'); tb.innerHTML = ''; let changed = 0;
  const q = itemsSearch.trim().toLowerCase();
  const matchesSearch = (it) => !q || it.name.toLowerCase().includes(q) || (it.itemNo || '').includes(q) || (it.categories || []).some(c => c.toLowerCase().includes(q));
  for (const it of items) if (itemStatus(it).moved) changed++;
  const visible = sortByPref(items.filter(matchesSearch), itemsSort, (it) => it.createdAt ?? it.savedAt);
  const visibleCount = visible.length;
  for (const it of visible) {
    const { c, diff, costDiff, priceMoved, moved } = itemStatus(it);
    const low = isLow(it.stock, it.low);
    const typeLabel = it.itemType === 'resale' ? 'Resale item' : `${it.materials.length} material${it.materials.length === 1 ? '' : 's'}`;
    const catBadge = (it.categories || []).map(c => ` · <span class="cat-badge">${esc(c)}</span>`).join('');
    const notForShowsBadge = it.notForShows ? ' · <span class="cat-badge warn-badge">Custom — not for shows</span>' : '';
    const notesBadge = it.notes ? ` · <span class="cat-badge" title="${esc(it.notes)}">📝 note</span>` : '';
    const tr = document.createElement('tr'); tr.dataset.id = it.id;
    tr.innerHTML = `
      <td><div class="item-name-cell">${it.photo ? `<img class="item-thumb" src="${it.photo}">` : ''}<div><div class="iname"></div><div class="meta">${it.itemNo ? `#${it.itemNo} · ` : ''}${typeLabel} · saved ${it.savedAt ? new Date(it.savedAt).toLocaleDateString() : 'earlier'}${catBadge}${notForShowsBadge}${notesBadge}</div></div></div></td>
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
      stockTimer = setTimeout(() => api('POST', '/api/items', it).then(loadPosItems), 500);
    });
    const qtyInput = tr.querySelector('.qty');
    tr.querySelector('.make').onclick = () => makeBatch(it, qtyInput.value);
    tr.querySelector('.sell').onclick = () => sellItem(it, qtyInput.value);
    const acc = tr.querySelector('.accept');
    if (acc) acc.onclick = async () => { freshCopy(it); await api('POST', '/api/items', it); toast(`${it.name} is now ${money(it.price)}`); await Promise.all([loadItems(), loadPosItems()]); };
    tr.querySelector('.del').onclick = () => deleteItem(it);
    tb.appendChild(tr);
  }
  $('itemsEmpty').hidden = visibleCount > 0;
  $('itemsEmpty').textContent = items.length === 0 ? 'No items yet.' : 'No items match your search.';
  tb.parentElement.hidden = visibleCount === 0;
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
  await Promise.all([loadItems(), loadPosItems()]);
};
$('itemsSearch').addEventListener('input', () => { itemsSearch = $('itemsSearch').value; renderItems(); });
$('itemsSort').addEventListener('change', () => { itemsSort = $('itemsSort').value; saveSortPref('itemsSort', itemsSort); renderItems(); });

$('itemsExportCsv').onclick = () => {
  const a = document.createElement('a');
  a.href = `/api/items/export.csv?test=${testMode ? 1 : 0}`;
  a.click();
};
$('itemsImportCsv').onclick = () => $('itemsImportCsvFile').click();
$('itemsImportCsvFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  let csv;
  try { csv = await f.text(); } catch { toast('Could not read that file'); return; }
  try {
    const r = await api('POST', '/api/items/import.csv', { csv, test: testMode });
    toast(`Imported: ${r.created} added, ${r.updated} updated${r.skipped ? `, ${r.skipped} skipped` : ''}${r.errors.length ? ` — ${r.errors[0]}` : ''}`);
    await loadItems();
  } catch (err) { toast(err.message || 'Import failed'); }
};

// ---------- Custom Orders ----------
// A lightweight tracking queue for made-to-order/custom pieces, separate from the item
// catalog and event inventory — admin/manager/lead only, same as event management. itemName
// is always free text (not a link to a catalog item): most custom orders are one-offs that
// never get cataloged, and a free-text snapshot can't be orphaned by a later item edit/delete.
const ORDER_STATUS_LABEL = {
  pickup: { new: 'New', in_progress: 'In progress', ready: 'Ready for pickup', picked_up: 'Picked up' },
  ship: { new: 'New', in_progress: 'In progress', ready: 'Ready to ship', picked_up: 'Shipped' },
};
let customOrders = [];
let ordersSearch = '', ordersStatusFilter = '';
let editingOrderId = null;
// The order's most recently linked sale (total + date), as last loaded — set by fillOrderForm,
// shown by renderOrderTotalsDisplay. Null for an order that's never been checked out, or whose
// linked sale was later voided (sales.js clears sale_id/saleInfo then, same as it reverses the
// amount_paid credit that went with it).
let editingOrderSaleInfo = null;
// Staged locally while the form is open, same as the event item picker's evSelectedItems —
// only persisted (via /api/custom-orders/:id/items) when "Save order" is clicked.
let orderLineItems = [];
// A short label for the order when there's no one obvious name for it — the orders list,
// the ticket line "Add shipping to ticket" creates, and both printed documents' titles.
function orderItemsSummary(o) {
  if (o.items && o.items.length) return o.items.map((li) => `${li.itemName}${li.qty > 1 ? ` ×${li.qty}` : ''}`).join(', ');
  return o.itemName || '(no items yet)';
}
async function loadCustomOrders() {
  // Needed for the item-add picker below — loaded here too, not just on Items tab visits,
  // since a lead account can reach Custom Orders but never the Items tab at all.
  await loadItems().catch(() => {});
  customOrders = await api('GET', `/api/custom-orders?test=${testMode ? 1 : 0}`);
  $('itemNameList').innerHTML = [...new Set(items.map(it => it.name).filter(Boolean))].map(n => `<option value="${esc(n)}">`).join('');
  renderCustomOrders();
}
function renderCustomOrders() {
  const tb = $('ordersRows'); tb.innerHTML = '';
  const q = ordersSearch.trim().toLowerCase();
  const visible = customOrders.filter((o) => {
    if (ordersStatusFilter && o.status !== ordersStatusFilter) return false;
    if (!q) return true;
    return orderItemsSummary(o).toLowerCase().includes(q) || o.customerName.toLowerCase().includes(q);
  });
  for (const o of visible) {
    const tr = document.createElement('tr'); tr.dataset.id = o.id;
    tr.innerHTML = `
      <td><div class="iname"></div>${o.notes ? `<div class="meta itemMeta"></div>` : ''}</td>
      <td><div class="custName"></div><div class="meta custMeta"></div></td>
      <td class="dueCell"></td>
      <td class="fulfillCell"></td>
      <td><select class="statusSel"></select></td>
      <td class="acts">
        ${o.items && o.items.length ? '<button class="btn sm primary checkoutOrder">Check out</button>' : ''}
        ${o.fulfillment === 'ship' && num(o.shippingCost) > 0 ? '<button class="btn sm shipToTicket">Add shipping to ticket</button>' : ''}
        <button class="btn sm edit">Edit</button><button class="icon-btn del" title="Delete">×</button>
      </td>`;
    tr.querySelector('.iname').textContent = orderItemsSummary(o);
    if (o.notes) tr.querySelector('.itemMeta').textContent = o.notes;
    tr.querySelector('.custName').textContent = o.customerName || '—';
    tr.querySelector('.custMeta').textContent = o.customerContact || '';
    tr.querySelector('.dueCell').textContent = o.dueDate ? new Date(o.dueDate + 'T00:00:00').toLocaleDateString() : '—';
    const fulfillCell = tr.querySelector('.fulfillCell');
    if (o.fulfillment === 'ship') {
      fulfillCell.innerHTML = `<div>Ship${o.shippingCost != null ? ` — ${money(num(o.shippingCost))}` : ''}</div><div class="meta fulfillMeta"></div>`;
      const shipMeta = [o.shippingAddress, o.trackingNumber ? `Tracking: ${o.trackingNumber}` : ''].filter(Boolean).join(' · ');
      fulfillCell.querySelector('.fulfillMeta').textContent = shipMeta;
    } else {
      fulfillCell.textContent = 'Pickup';
    }
    const sel = tr.querySelector('.statusSel');
    const statusLabels = ORDER_STATUS_LABEL[o.fulfillment === 'ship' ? 'ship' : 'pickup'];
    sel.innerHTML = Object.entries(statusLabels).map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    sel.value = o.status;
    sel.onchange = async () => {
      try { await api('POST', `/api/custom-orders/${o.id}/status`, { status: sel.value }); o.status = sel.value; toast('Status updated'); }
      catch (e) { toast(e.message || 'Could not update status'); sel.value = o.status; }
    };
    const shipBtn = tr.querySelector('.shipToTicket');
    if (shipBtn) shipBtn.onclick = () => addShippingToTicket(o);
    const checkoutBtn = tr.querySelector('.checkoutOrder');
    if (checkoutBtn) checkoutBtn.onclick = () => checkoutOrder(o);
    tr.querySelector('.edit').onclick = () => fillOrderForm(o);
    tr.querySelector('.del').onclick = async () => {
      if (!await askConfirm(`Delete this custom order for “${o.customerName || 'this customer'}”?`, 'Delete order')) return;
      await api('DELETE', '/api/custom-orders/' + o.id);
      toast('Order deleted');
      await loadCustomOrders();
    };
    tb.appendChild(tr);
  }
  $('ordersEmpty').hidden = visible.length > 0;
  $('ordersEmpty').textContent = customOrders.length === 0 ? 'No custom orders yet.' : 'No orders match your search.';
  $('ordersCount').textContent = customOrders.filter((o) => o.status !== 'picked_up').length || '';
}
function fillOrderForm(o) {
  editingOrderId = o ? o.id : null;
  editingOrderSaleInfo = o?.saleInfo || null;
  $('orderFormTitle').textContent = o ? `Editing order — ${orderItemsSummary(o)}` : 'New custom order';
  $('orderDue').value = o?.dueDate || '';
  $('orderCustomerName').value = o?.customerName || '';
  $('orderCustomerContact').value = o?.customerContact || '';
  $('orderNotes').value = o?.notes || '';
  $('orderAmountPaid').value = o?.amountPaid ?? '';
  $('orderShips').checked = o?.fulfillment === 'ship';
  $('orderShipFields').hidden = o?.fulfillment !== 'ship';
  $('orderShipAddress').value = o?.shippingAddress || '';
  $('orderShipCost').value = o?.shippingCost ?? '';
  $('orderTracking').value = o?.trackingNumber || '';
  $('orderCancel').hidden = !o;
  // The item picker only becomes usable once the order has an id, same reason as an event's
  // item picker and charity rules — there's nowhere to attach a line to yet otherwise.
  $('orderItemsSection').hidden = !o;
  orderLineItems = (o?.items || []).map((li) => ({ itemId: li.itemId, itemName: li.itemName, price: li.price, qty: li.qty }));
  renderOrderItemLines();
  if (o) $('orderCustomerName').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function orderTotals() {
  const subtotal = orderLineItems.reduce((s, l) => s + num(l.price) * num(l.qty), 0);
  const shipping = $('orderShips').checked ? num($('orderShipCost').value) : 0;
  const total = subtotal + shipping;
  const paid = num($('orderAmountPaid').value);
  return { subtotal, shipping, total, paid, balance: total - paid };
}
function renderOrderItemLines() {
  const box = $('orderItemLines'); box.innerHTML = '';
  for (const l of orderLineItems) {
    const row = document.createElement('div'); row.className = 'tline';
    row.innerHTML = `<div class="nm"></div>
      <input type="number" class="in-tiny lineQty" min="1" step="1" title="Quantity">
      <input type="number" class="in-tiny linePrice" min="0" step="0.01" title="Price each">
      <div class="amt"></div><button class="icon-btn del" title="Remove">×</button>`;
    row.querySelector('.nm').textContent = l.itemName;
    const qtyIn = row.querySelector('.lineQty'), priceIn = row.querySelector('.linePrice');
    qtyIn.value = l.qty; priceIn.value = l.price;
    const updateAmt = () => { row.querySelector('.amt').textContent = money(num(qtyIn.value) * num(priceIn.value)); };
    updateAmt();
    qtyIn.addEventListener('input', () => { l.qty = Math.max(0, num(qtyIn.value)) || 1; updateAmt(); renderOrderTotalsDisplay(); });
    priceIn.addEventListener('input', () => { l.price = Math.max(0, num(priceIn.value)); updateAmt(); renderOrderTotalsDisplay(); });
    row.querySelector('.del').onclick = () => { orderLineItems = orderLineItems.filter((x) => x !== l); renderOrderItemLines(); };
    box.appendChild(row);
  }
  $('orderItemLinesEmpty').hidden = orderLineItems.length > 0;
  renderOrderTotalsDisplay();
}
function renderOrderTotalsDisplay() {
  const t = orderTotals();
  $('orderTotals').innerHTML = `Subtotal ${money(t.subtotal)}` +
    ($('orderShips').checked ? ` + shipping ${money(t.shipping)}` : '') +
    ` = total ${money(t.total)} · paid ${money(t.paid)} · <span class="${t.balance > 0 ? 'neg' : ''}">balance due ${money(t.balance)}</span>` +
    (editingOrderSaleInfo ? `<div class="hint">✓ ${money(editingOrderSaleInfo.total)} of that was paid via a sale rung up ${new Date(editingOrderSaleInfo.createdAt).toLocaleDateString()}.</div>` : '');
}
$('orderAddItemBtn').onclick = () => {
  const name = $('orderAddItemName').value.trim();
  const match = items.find((it) => it.name === name);
  if (!match) { $('orderAddItemName').focus(); toast('Pick an item from the list first'); return; }
  const qty = Math.max(1, Math.round(num($('orderAddItemQty').value)) || 1);
  const priceInput = $('orderAddItemPrice').value;
  const price = priceInput === '' ? num(match.price) : Math.max(0, num(priceInput));
  orderLineItems.push({ itemId: match.id, itemName: match.name, price, qty });
  renderOrderItemLines();
  $('orderAddItemName').value = ''; $('orderAddItemQty').value = '1'; $('orderAddItemPrice').value = ''; $('orderAddItemName').focus();
};
$('orderShips').addEventListener('change', () => { $('orderShipFields').hidden = !$('orderShips').checked; renderOrderTotalsDisplay(); });
$('orderShipCost').addEventListener('input', renderOrderTotalsDisplay);
$('orderAmountPaid').addEventListener('input', renderOrderTotalsDisplay);
$('orderCancel').onclick = () => fillOrderForm(null);
$('orderSave').onclick = async () => {
  const customerName = $('orderCustomerName').value.trim();
  if (!customerName) { $('orderCustomerName').focus(); toast('Give the order a customer name first'); return; }
  const existing = editingOrderId ? customOrders.find((o) => o.id === editingOrderId) : null;
  let saved;
  try {
    saved = await api('POST', '/api/custom-orders', {
      id: existing?.id, dueDate: $('orderDue').value, customerName,
      customerContact: $('orderCustomerContact').value.trim(), notes: $('orderNotes').value.trim(),
      fulfillment: $('orderShips').checked ? 'ship' : 'pickup',
      shippingAddress: $('orderShipAddress').value.trim(), shippingCost: $('orderShipCost').value,
      trackingNumber: $('orderTracking').value.trim(), amountPaid: $('orderAmountPaid').value,
      status: existing?.status, test: testMode,
    });
  } catch (e) { toast(e.message || 'Could not save order'); return; }
  if (existing) {
    await api('POST', `/api/custom-orders/${saved.id}/items`, { items: orderLineItems.map((l) => ({ itemId: l.itemId, qty: l.qty, price: l.price })) });
  }
  toast(existing ? 'Order updated' : 'Order saved');
  await loadCustomOrders();
  // Keep the form open, pointed at the saved order — a brand-new order's item picker only
  // becomes usable once it has an id, same reasoning as the event form.
  fillOrderForm(customOrders.find((o) => o.id === saved.id) || saved);
};
$('ordersSearch').addEventListener('input', () => { ordersSearch = $('ordersSearch').value; renderCustomOrders(); });
$('ordersStatusFilter').addEventListener('change', () => { ordersStatusFilter = $('ordersStatusFilter').value; renderCustomOrders(); });
// Adds the order's shipping & handling charge to the current Sell page ticket as its own
// custom (off-catalog) line, instead of having to retype the amount there by hand. Only
// offered on a 'ship' order with an actual charge set (see the button's own conditional
// above) — same admin/manager/lead-only territory as the rest of this tab, and custom lines
// are already off-limits to the cashier role at checkout regardless.
function addShippingToTicket(o) {
  showTab('pos');
  ticket.push({
    id: cid(), itemId: null, name: `Shipping & handling — ${orderItemsSummary(o)}`, price: num(o.shippingCost), qty: 1,
    taxRate: defaultLineTaxRate(tender), taxOverridden: false, discountType: null, discountValue: null,
  });
  renderTicket();
  setMobileCartOpen(true);
  toast(`Added shipping (${money(num(o.shippingCost))}) to the ticket`);
}
// Loads this order's full items (and shipping, if any) onto the Sell page ticket, ready to
// tender and complete like any other sale — a real sale, counted in Reports same as always.
// Completing it links back to this order (sales.js) and credits the amount toward amountPaid;
// see checkoutOrderId below and the checkout handler that reads it.
async function checkoutOrder(o) {
  if (!o.items || !o.items.length) { toast('No items in this order yet'); return; }
  const paid = num(o.amountPaid);
  const hasShipping = o.fulfillment === 'ship' && num(o.shippingCost) > 0;
  if (paid > 0) {
    const ok = await askConfirm(
      `“${o.customerName || 'This order'}” already has ${money(paid)} recorded as paid. Checking out loads the order's full items${hasShipping ? ' and shipping' : ''} onto the ticket — remove or adjust lines first if this sale is only for the remaining balance.`,
      'Check out this order',
    );
    if (!ok) return;
  }
  showTab('pos');
  for (const l of o.items) {
    ticket.push({
      id: cid(), itemId: l.itemId, name: l.itemName, price: num(l.price), qty: num(l.qty),
      taxRate: defaultLineTaxRate(tender), taxOverridden: false, discountType: null, discountValue: null,
    });
  }
  if (hasShipping) {
    ticket.push({
      id: cid(), itemId: null, name: `Shipping & handling — ${orderItemsSummary(o)}`, price: num(o.shippingCost), qty: 1,
      taxRate: defaultLineTaxRate(tender), taxOverridden: false, discountType: null, discountValue: null,
    });
  }
  checkoutOrderId = o.id;
  renderTicket();
  setMobileCartOpen(true);
  toast(`Loaded “${o.customerName || 'the order'}” onto the ticket — complete the sale to mark it paid`);
}
// What to pack for this order — the same "qty × name" list as an event's packing list,
// reusing the same printable card. Uses the currently staged line items, not just what's
// saved, same reasoning as the event version.
$('orderPrintPacking').onclick = () => {
  if (!orderLineItems.length) { toast('No items in this order yet'); return; }
  const existing = editingOrderId ? customOrders.find((o) => o.id === editingOrderId) : null;
  printFromCard('printing-packing-list', 'packingListCard', () => {
    $('packingListTitle').textContent = `Packing list — ${existing?.customerName || $('orderCustomerName').value.trim() || 'Custom order'}`;
    $('packingListSub').textContent = $('orderDue').value ? `Due ${new Date($('orderDue').value + 'T00:00:00').toLocaleDateString()}` : '';
    $('packingListQtyHeader').textContent = 'Qty';
    $('packingListRows').innerHTML = [...orderLineItems].sort((a, b) => a.itemName.localeCompare(b.itemName))
      .map((l) => `<tr><td>${esc(l.itemName)}</td><td class="r">${num(l.qty)}</td></tr>`).join('');
  });
};
// A customer-facing itemized order summary: what was ordered, at what price, plus shipping
// and the running total/balance — printable to hand or send with the order.
$('orderPrintPO').onclick = () => {
  if (!orderLineItems.length) { toast('No items in this order yet'); return; }
  const existing = editingOrderId ? customOrders.find((o) => o.id === editingOrderId) : null;
  const t = orderTotals();
  printFromCard('printing-purchase-order', 'purchaseOrderCard', () => {
    $('poTitle').textContent = `Purchase order — ${existing?.customerName || $('orderCustomerName').value.trim() || 'Custom order'}`;
    const ref = existing ? `Order ref: ${existing.id.slice(0, 8).toUpperCase()} · ` : '';
    $('poSub').textContent = `${ref}${new Date().toLocaleDateString()}${$('orderCustomerContact').value.trim() ? ' · ' + $('orderCustomerContact').value.trim() : ''}`;
    $('poRows').innerHTML = orderLineItems.map((l) => `<tr><td>${esc(l.itemName)}</td><td class="r">${num(l.qty)}</td><td class="r">${money(num(l.price))}</td><td class="r">${money(num(l.qty) * num(l.price))}</td></tr>`).join('');
    $('poTotals').innerHTML = `<div>Subtotal: ${money(t.subtotal)}</div>` +
      ($('orderShips').checked ? `<div>Shipping &amp; handling: ${money(t.shipping)}</div>` : '') +
      `<div><b>Total: ${money(t.total)}</b></div><div>Paid: ${money(t.paid)}</div><div><b>Balance due: ${money(t.balance)}</b></div>`;
  });
};

// ---------- Offline mode (Sell page only — see README) ----------
// A checked-out sale that failed to reach the server because the connection is actually
// down, vs. a real error the server sent back (bad input, etc.) — api() always sets .code on
// the latter (see onUnauthorized/401 and the !res.ok branch above), and never on a fetch()
// that threw before getting a response at all. That's the one reliable signal available here.
function isNetworkError(e) { return !e || !e.code; }

let isOnline = navigator.onLine;
let queuedSales = [];
let syncing = false;

function updateOfflineBanner() {
  const pending = queuedSales.length;
  const banner = $('offlineBanner');
  if (!isOnline) {
    $('offlineBannerText').textContent = `📡 You're offline. The Sell page keeps working — sales are saved on this device and sync automatically once you're reconnected.${pending ? ` (${pending} queued)` : ''} Other tabs need a connection.`;
    $('syncNowBtn').hidden = true;
    banner.hidden = false;
  } else if (pending > 0) {
    $('offlineBannerText').textContent = `Syncing ${pending} queued sale${pending === 1 ? '' : 's'}…`;
    $('syncNowBtn').hidden = false;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}
function setOnlineStatus(online) {
  const changed = isOnline !== online;
  isOnline = online;
  updateOfflineBanner();
  if (changed && online) trySyncQueuedSales();
}
window.addEventListener('online', () => setOnlineStatus(true));
window.addEventListener('offline', () => setOnlineStatus(false));
$('syncNowBtn').onclick = () => trySyncQueuedSales();

async function loadQueuedSales() {
  queuedSales = (await Offline.getQueuedSales()).map((q) => q.localSale).sort((a, b) => b.createdAt - a.createdAt);
  updateOfflineBanner();
}

function applyLocalStockDelta(lines, sign) {
  for (const l of lines) {
    if (!l.itemId) continue;
    const it = posItemsList.find((x) => x.id === l.itemId);
    if (it) it.stock = Math.max(0, num(it.stock) + sign * num(l.qty));
  }
  renderPosItems();
  Offline.saveSnapshot(`posItems:${testMode ? 1 : 0}`, posItemsList);
}

// Builds the same shape a synced sale would have (minus server-only fields like profit, which
// the client never sees anyway) so the receipt/sales-list code can render it identically.
async function completeOfflineSale(payload) {
  setOnlineStatus(false);
  const clientSaleId = cid();
  const createdAt = Date.now();
  let subtotal = 0, tax = 0;
  for (const l of payload.lines) { const s = lineTaxSplit(l, payload.taxIncluded); subtotal += s.sub; tax += s.tax; }
  const total = subtotal + tax;
  const localSale = {
    id: clientSaleId, clientSaleId, eventId: payload.eventId, test: payload.test, taxIncluded: payload.taxIncluded,
    lines: payload.lines, subtotal, tax, total, tender: payload.tender,
    received: payload.tender === 'cash' ? payload.received : total,
    change: payload.tender === 'cash' ? Math.max(0, payload.received - total) : 0,
    soldBy: me ? me.name : null, createdAt, pendingSync: true,
  };
  await Offline.queueSale({ clientSaleId, createdAt, payload: { ...payload, clientSaleId, createdAt }, localSale });
  queuedSales.unshift(localSale);
  applyLocalStockDelta(payload.lines, -1);
  toast(`Sale saved offline — ${money(localSale.total)} (will sync automatically)`);
  renderSales();
  updateOfflineBanner();
}

async function trySyncQueuedSales() {
  if (syncing || !isOnline) return;
  const queue = await Offline.getQueuedSales();
  if (!queue.length) return;
  syncing = true;
  let syncedAny = false;
  try {
    for (const q of queue.sort((a, b) => a.createdAt - b.createdAt)) {
      try {
        const synced = await api('POST', '/api/sales', q.payload);
        await Offline.removeQueuedSale(q.clientSaleId);
        queuedSales = queuedSales.filter((s) => s.clientSaleId !== q.clientSaleId);
        sales = [synced, ...sales];
        syncedAny = true;
      } catch (e) {
        if (isNetworkError(e)) { setOnlineStatus(false); break; }
        console.error('Could not sync queued sale', q.clientSaleId, e);
        toast('A queued sale failed to sync — it will stay queued. Check with an admin.');
      }
    }
  } finally {
    syncing = false;
    if (syncedAny) await loadPosItems().catch(() => {}); // reconcile optimistic local stock with the server's authoritative figures
    renderSales();
    updateOfflineBanner();
  }
}

// ---------- Point of sale ----------
let ticket = [];
let tender = 'cash';
let posSearch = '';
// Set by checkoutOrder() (Custom Orders) when the current ticket was loaded from an order's
// "Check out" button — sent as customOrderId on the next checkout so the server can link the
// resulting sale back to that order, then cleared (completed or not) so an unrelated later
// sale never accidentally gets credited to it.
let checkoutOrderId = null;
let cardProcessors = [];
const enabledCardProcessors = () => cardProcessors.filter(p => p.enabled);
async function loadCardProcessors() {
  cardProcessors = await api('GET', '/api/card-processors');
  const enabled = enabledCardProcessors();
  const sel = $('cardProcessor');
  const prev = sel.value;
  sel.innerHTML = '<option value="">Other / unlisted (no fee)</option>' +
    enabled.map(p => `<option value="${p.id}">${esc(p.name)} (${p.feePct}%${p.feeFixed > 0 ? ` + ${money(p.feeFixed)}` : ''})</option>`).join('');
  if (enabled.some(p => p.id === prev)) sel.value = prev;
  else if (appSettings.defaultCardProcessorId && enabled.some(p => p.id === appSettings.defaultCardProcessorId)) sel.value = appSettings.defaultCardProcessorId;
  renderCardProcessorRows();
  renderDefaultProcessorSelect();
}

async function loadPosItems() {
  const key = `posItems:${testMode ? 1 : 0}`;
  try {
    posItemsList = await api('GET', `/api/items?test=${testMode ? 1 : 0}`);
    setOnlineStatus(true);
    Offline.saveSnapshot(key, posItemsList);
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    setOnlineStatus(false);
    const cached = await Offline.getSnapshot(key);
    if (cached) posItemsList = cached;
  }
  renderPosItems();
}
function renderPosItems() {
  const grid = $('posItems');
  // An event scoped to "selected items" only offers the ones it was given — everything else
  // stays in the catalog, just not sellable at this particular event. Each selected item can
  // also carry a qtyBrought ("bringing X of these") — how many are left of that at this event
  // is derived from it, never stored: qtyBrought minus however many this event's sales (synced
  // or still queued offline) have sold of that item so far. That makes a void self-correcting —
  // delete the sale and the remaining count is right again with no extra bookkeeping.
  const ev = openEvent();
  const restrictedMap = ev && ev.itemScope === 'selected'
    ? new Map((ev.selectedItems || []).map(s => [s.itemId, s.qtyBrought]))
    : null;
  // A "custom — not for shows" item is left off the grid at ANY event, regardless of that
  // event's item_scope — it never needs managing per event. Outside of an event it's sellable
  // like anything else.
  let eventFiltered = ev ? posItemsList.filter((it) => !it.notForShows) : posItemsList;
  if (restrictedMap) eventFiltered = eventFiltered.filter((it) => restrictedMap.has(it.id));
  let soldAtEvent = null;
  if (restrictedMap) {
    soldAtEvent = new Map();
    for (const s of eventSales(ev)) for (const l of s.lines) {
      if (!l.itemId) continue;
      soldAtEvent.set(l.itemId, (soldAtEvent.get(l.itemId) || 0) + num(l.qty));
    }
  }
  const q = posSearch.trim().toLowerCase();
  const list = eventFiltered.filter(it => !q || it.name.toLowerCase().includes(q) || (it.itemNo || '').includes(q));
  grid.innerHTML = '';
  for (const it of list) {
    const qtyBrought = restrictedMap ? restrictedMap.get(it.id) : null;
    const remaining = qtyBrought != null ? Math.max(0, qtyBrought - (soldAtEvent.get(it.id) || 0)) : null;
    const outOfStock = (remaining != null ? remaining : num(it.stock)) <= 0;
    const low = remaining == null && isLow(it.stock, it.low);
    const stLabel = remaining != null ? `${remaining} bringing here` : `${num(it.stock)} in stock`;
    const btn = document.createElement('button'); btn.className = 'pos-item' + (outOfStock ? ' out' : '');
    btn.innerHTML = `<span class="nm"></span><span class="pr">${money(num(it.price))}</span><span class="st${low ? ' low' : ''}">${it.itemNo ? `#${it.itemNo} · ` : ''}${stLabel}</span>`;
    btn.querySelector('.nm').textContent = it.name;
    btn.onclick = () => addToTicket(it);
    grid.appendChild(btn);
  }
  $('posItemsEmpty').hidden = eventFiltered.length > 0;
  $('posItemsEmpty').textContent = eventFiltered.length === 0 && posItemsList.length > 0 ? 'No items are available at this event — check the event’s setup.' : 'No items yet.';
  grid.hidden = eventFiltered.length === 0;
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
// Discount is applied to the line's pre-tax extended total (price × qty), before splitting
// off tax — so tax is charged on what was actually paid, not the undiscounted price. 'pct' is
// capped at 100%, 'amt' at the line's own total, so a discount can never make a line negative.
function applyDiscount(l, rawAmt) {
  if (!l.discountType || !num(l.discountValue)) return 0;
  if (l.discountType === 'pct') return rawAmt * Math.min(100, Math.max(0, num(l.discountValue))) / 100;
  return Math.min(rawAmt, Math.max(0, num(l.discountValue)));
}
function lineTaxSplit(l, included) {
  const rawAmt = num(l.price) * num(l.qty);
  const discAmt = applyDiscount(l, rawAmt);
  const amt = rawAmt - discAmt, rate = num(l.taxRate) / 100;
  if (included && rate > 0) { const sub = amt / (1 + rate); return { amt, sub, tax: amt - sub, rawAmt, discAmt }; }
  return { amt, sub: amt, tax: amt * rate, rawAmt, discAmt };
}
function addToTicket(it) {
  const line = ticket.find(l => l.itemId === it.id);
  if (line) line.qty++;
  else ticket.push({ id: cid(), itemId: it.id, name: it.name, price: num(it.price), qty: 1, taxRate: defaultLineTaxRate(tender), taxOverridden: false, discountType: null, discountValue: null });
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
  const itemCount = ticket.reduce((n, l) => n + num(l.qty), 0);
  $('mobileCartCount').textContent = itemCount ? `${itemCount} item${itemCount === 1 ? '' : 's'} in ticket` : 'Ticket empty';
  $('mobileCartTotal').textContent = money(total);
}
function setMobileCartOpen(open) {
  $('posSummary').classList.toggle('open', open);
  $('mobileCartBar').classList.toggle('open', open);
  $('cartBackdrop').hidden = !open;
}
$('mobileCartBar').onclick = () => setMobileCartOpen(!$('posSummary').classList.contains('open'));
$('posSummaryClose').onclick = () => setMobileCartOpen(false);
$('cartBackdrop').onclick = () => setMobileCartOpen(false);
function renderTicket() {
  const box = $('ticketLines'); box.innerHTML = '';
  const canDiscount = !isRestrictedCashier();
  for (const l of ticket) {
    const { rawAmt, discAmt, amt } = lineTaxSplit(l, false);
    const row = document.createElement('div'); row.className = 'tline';
    row.innerHTML = `<div class="nm"></div><div class="qstep"><button class="minus">−</button><span></span><button class="plus">+</button></div>
      <div class="taxmini"><input type="number" min="0" step="0.1" inputmode="decimal" class="lineTax" title="Tax rate for this item"><span>%</span></div>
      <div class="amt"></div>
      ${canDiscount ? '<button class="icon-btn discBtn" title="Add a discount">%off</button>' : ''}
      <button class="icon-btn del" title="Remove">×</button>`;
    row.querySelector('.nm').textContent = l.name;
    row.querySelector('.qstep span').textContent = l.qty;
    row.querySelector('.amt').innerHTML = discAmt > 0 ? `<span class="old">${money(rawAmt)}</span> ${money(amt)}` : money(rawAmt);
    const taxInput = row.querySelector('.lineTax');
    taxInput.value = l.taxRate; taxInput.classList.toggle('overridden', !!l.taxOverridden);
    if (isRestrictedCashier()) { taxInput.disabled = true; taxInput.title = 'Tax rate (set by the event)'; }
    else taxInput.addEventListener('input', () => { l.taxRate = taxInput.value; l.taxOverridden = true; taxInput.classList.add('overridden'); recalcTicketTotals(); });
    row.querySelector('.minus').onclick = () => { l.qty--; if (l.qty <= 0) ticket = ticket.filter(x => x !== l); renderTicket(); };
    row.querySelector('.plus').onclick = () => { l.qty++; renderTicket(); };
    row.querySelector('.del').onclick = () => { ticket = ticket.filter(x => x !== l); renderTicket(); };
    box.appendChild(row);
    if (canDiscount) {
      const discBtn = row.querySelector('.discBtn');
      discBtn.classList.toggle('on', !!l.discountType);
      const discRow = document.createElement('div'); discRow.className = 'tline-discount'; discRow.hidden = !l.discountType;
      discRow.innerHTML = `<select class="discType"><option value="pct">% off</option><option value="amt">$ off</option></select>
        <input type="number" class="discValue" min="0" step="0.01" placeholder="0">
        <button class="icon-btn discClear" title="Remove discount">×</button>`;
      const typeSel = discRow.querySelector('.discType'), valueIn = discRow.querySelector('.discValue');
      typeSel.value = l.discountType || 'pct'; valueIn.value = l.discountValue ?? '';
      const applyFields = () => { l.discountType = typeSel.value; l.discountValue = valueIn.value; recalcTicketTotals(); updateLineAmt(row, l); };
      typeSel.addEventListener('change', applyFields);
      valueIn.addEventListener('input', applyFields);
      discBtn.onclick = () => {
        discRow.hidden = !discRow.hidden;
        if (!discRow.hidden && !l.discountType) { l.discountType = 'pct'; typeSel.value = 'pct'; }
        else if (discRow.hidden) { l.discountType = null; l.discountValue = null; }
        discBtn.classList.toggle('on', !discRow.hidden);
        recalcTicketTotals(); updateLineAmt(row, l);
      };
      discRow.querySelector('.discClear').onclick = () => {
        l.discountType = null; l.discountValue = null; discRow.hidden = true; discBtn.classList.remove('on');
        recalcTicketTotals(); updateLineAmt(row, l);
      };
      box.appendChild(discRow);
    }
  }
  $('ticketEmpty').hidden = ticket.length > 0;
  recalcTicketTotals();
}
function updateLineAmt(row, l) {
  const { rawAmt, discAmt, amt } = lineTaxSplit(l, false);
  row.querySelector('.amt').innerHTML = discAmt > 0 ? `<span class="old">${money(rawAmt)}</span> ${money(amt)}` : money(rawAmt);
}
function setTender(t) {
  tender = t;
  document.querySelectorAll('#tenderSeg button').forEach(b => b.classList.toggle('on', b.dataset.tender === t));
  $('cashRow').hidden = t !== 'cash';
  $('cardProcessorRow').hidden = t === 'cash' || enabledCardProcessors().length === 0;
  const def = defaultLineTaxRate(t);
  ticket.forEach(l => { if (!l.taxOverridden) l.taxRate = def; });
  renderTicket();
}
document.querySelectorAll('#tenderSeg button').forEach(b => b.onclick = () => setTender(b.dataset.tender));
$('posSearch').addEventListener('input', () => { posSearch = $('posSearch').value; renderPosItems(); });
// A USB barcode scanner acts just like a keyboard — it types the barcode's digits into
// whatever's focused, then sends an Enter. Since items are barcoded with their own item
// number (see the price tag printer), scanning one into this same search box while it's
// focused looks it up by exact item number and adds it straight to the ticket, instead of
// just filtering the grid the way typing normally does.
$('posSearch').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const typed = $('posSearch').value.trim();
  if (!typed) return;
  const match = posItemsList.find((it) => it.itemNo === typed);
  if (!match) return; // not a recognized item number — leave it as a plain text filter
  e.preventDefault();
  addToTicket(match);
  $('posSearch').value = ''; posSearch = ''; renderPosItems();
  toast(`Added “${match.name}”`);
});
$('received').addEventListener('input', recalcTicketTotals);
$('posCustomToggle').onclick = () => { const show = $('posCustomRow').hidden; $('posCustomRow').hidden = !show; $('posCustomAddRow').hidden = !show; if (show) $('posCustomName').focus(); };
$('posCustomAdd').onclick = () => {
  const name = $('posCustomName').value.trim(), price = num($('posCustomPrice').value), qty = Math.max(1, Math.round(num($('posCustomQty').value)) || 1);
  if (!name) { $('posCustomName').focus(); toast('Give the item a name first'); return; }
  ticket.push({ id: cid(), itemId: null, name, price, qty, taxRate: defaultLineTaxRate(tender), taxOverridden: false, discountType: null, discountValue: null });
  renderTicket();
  $('posCustomName').value = ''; $('posCustomPrice').value = ''; $('posCustomQty').value = '1'; $('posCustomName').focus();
};
$('clearTicket').onclick = async () => {
  if (!ticket.length) return;
  if (!await askConfirm('Clear the current ticket? This can’t be undone.', 'Clear ticket')) return;
  ticket = []; $('received').value = ''; checkoutOrderId = null; renderTicket();
};
$('checkout').onclick = async () => {
  if (!ticket.length) return;
  const ev = openEvent();
  const total = num($('tTotal').textContent.replace(/[^0-9.-]/g, ''));
  const received = tender === 'cash' ? num($('received').value) : total;
  const payload = {
    eventId: ev?.id || null, test: testMode, taxIncluded: eventTaxIncluded(ev, tender),
    lines: ticket.map(l => ({ itemId: l.itemId, name: l.name, price: l.price, qty: l.qty, taxRate: num(l.taxRate), discountType: l.discountType || null, discountValue: l.discountValue || null })),
    tender, received,
    cardProcessorId: tender !== 'cash' ? ($('cardProcessor').value || null) : null,
    customOrderId: checkoutOrderId,
  };
  const wasOrderCheckout = !!checkoutOrderId;
  try {
    const sale = await api('POST', '/api/sales', payload);
    ticket = []; $('received').value = ''; checkoutOrderId = null; renderTicket();
    setMobileCartOpen(false);
    setOnlineStatus(true);
    toast(wasOrderCheckout ? `Order paid — sale complete, ${money(sale.total)}` : `${testMode ? 'Test sale' : 'Sale'} complete — ${money(sale.total)}`);
    await Promise.all([loadPosItems(), loadSales(), renderEventWidget()]);
  } catch (e) {
    if (isNetworkError(e)) {
      await completeOfflineSale(payload);
      ticket = []; $('received').value = ''; checkoutOrderId = null; renderTicket();
      setMobileCartOpen(false);
      renderEventWidget();
    } else {
      toast('Checkout failed — ' + (e.message || 'try again'));
    }
  }
};

function buildSaleReceipt(sale) {
  const wrap = document.createElement('div'); wrap.className = 'receipt';
  const itemCount = sale.lines.reduce((n, l) => n + num(l.qty), 0);
  const head = document.createElement('button'); head.type = 'button'; head.className = 'receipt-head';
  head.innerHTML = `<span class="rh-time"></span><span class="rh-total"></span>`;
  head.querySelector('.rh-time').textContent = `${sale.createdAt ? new Date(sale.createdAt).toLocaleString() : ''} · ${itemCount} item${itemCount === 1 ? '' : 's'}${sale.test ? ' · test' : ''}${sale.soldBy ? ' · ' + sale.soldBy : ''}${sale.pendingSync ? ' · ⏳ not synced' : ''}`;
  head.querySelector('.rh-total').textContent = money(sale.total);
  const body = document.createElement('div'); body.className = 'receipt-body'; body.hidden = true;
  const included = !!sale.taxIncluded;
  const lineHtml = sale.lines.map(l => {
    const { rawAmt, discAmt, amt, tax: lineTax } = lineTaxSplit(l, included); const lt = num(l.taxRate);
    const item = `<div class="rline item"><span>${num(l.qty)} × ${esc(l.name)}</span><span>${money(rawAmt)}</span></div>`;
    const discLine = discAmt > 0 ? `<div class="rline sub"><span>discount${l.discountType === 'pct' ? ` (${num(l.discountValue)}%)` : ''}</span><span>−${money(discAmt)}</span></div>` : '';
    const taxLine = lt > 0 ? `<div class="rline sub"><span>tax ${lt}%${included ? ' (included)' : ''}</span><span>${money(lineTax)}</span></div>` : '';
    return item + discLine + taxLine;
  }).join('');
  body.innerHTML = `${lineHtml}
    <div class="rline subtot"><span>Subtotal</span><span>${money(sale.subtotal)}</span></div>
    <div class="rline subtot"><span>Tax${included ? ' (included in price)' : ''}</span><span>${money(sale.tax)}</span></div>
    <div class="rline grand"><span>Total</span><span>${money(sale.total)}</span></div>
    <div class="rline meta"><span>${sale.tender === 'cash' ? `Cash · received ${money(sale.received)} · change ${money(sale.change)}` : (sale.cardProcessor ? `Card — ${esc(sale.cardProcessor)}` : 'Card / Other')}</span></div>`;
  const voidBtn = document.createElement('button'); voidBtn.className = 'sale-void'; voidBtn.textContent = sale.pendingSync ? 'Remove (unsynced)' : sale.test ? 'Void test sale' : 'Void sale';
  voidBtn.onclick = e => { e.stopPropagation(); voidSale(sale); };
  body.appendChild(voidBtn);
  // A not-yet-synced sale isn't a real server record yet (its id is only a client-side
  // placeholder) — nothing to return against until it syncs, same reasoning as why it can only
  // be "removed," not voided, above.
  if (!sale.pendingSync) {
    const returnBtn = document.createElement('button'); returnBtn.className = 'sale-void'; returnBtn.textContent = 'Return…';
    returnBtn.onclick = async (e) => {
      e.stopPropagation();
      const existing = body.querySelector('.return-form');
      if (existing) { existing.remove(); return; }
      body.appendChild(await buildReturnForm(sale));
    };
    body.appendChild(returnBtn);
  }
  head.onclick = () => { body.hidden = !body.hidden; };
  wrap.appendChild(head); wrap.appendChild(body);
  return wrap;
}
// A customer bringing something back against a past sale — each line gets its own qty-to-
// return input (capped by whatever's already been returned against it, fetched fresh each time
// this opens), a reason, and how the refund went back out. Submitting re-renders this sale's
// whole receipt in place, so the qty caps reflect the new total immediately if it's reopened.
async function buildReturnForm(sale) {
  const wrap = document.createElement('div'); wrap.className = 'return-form';
  let already = [];
  try { already = await api('GET', `/api/sales/${sale.id}/returns`); } catch { /* treat as nothing returned yet */ }
  const returnedByLine = new Map(already.map((r) => [r.lineIndex, num(r.qtyReturned)]));
  const rows = sale.lines.map((l, i) => {
    const left = Math.max(0, num(l.qty) - (returnedByLine.get(i) || 0));
    return { index: i, line: l, left };
  }).filter((r) => r.left > 0);
  if (!rows.length) {
    wrap.innerHTML = `<div class="hint">Everything on this sale has already been returned.</div>`;
    return wrap;
  }
  wrap.innerHTML = `
    ${rows.map((r) => `
      <div class="return-row" data-index="${r.index}">
        <span class="return-row-name">${esc(r.line.name)}</span>
        <span class="return-row-left">${r.left} left</span>
        <input type="number" class="in-tiny returnQty" min="0" max="${r.left}" step="1" value="0">
      </div>`).join('')}
    <div class="row r2" style="margin-top:10px">
      <div><label>Refund via</label><select class="returnTender"><option value="cash"${sale.tender === 'cash' ? ' selected' : ''}>Cash</option><option value="other"${sale.tender !== 'cash' ? ' selected' : ''}>Card / Other</option></select></div>
      <div><label>Reason (optional)</label><input class="returnReason" placeholder="e.g. wrong size"></div>
    </div>
    <div class="hint returnTotal" style="margin-top:8px">Refund total: $0.00</div>
    <div class="btn-row"><button class="btn sm primary returnSubmit">Process return</button></div>`;
  const qtyInputs = [...wrap.querySelectorAll('.returnQty')];
  const updateTotal = () => {
    let total = 0;
    rows.forEach((r, i) => {
      const qty = num(qtyInputs[i].value);
      const rawAmt = num(r.line.price) * num(r.line.qty);
      const discAmt = applyDiscount(r.line, rawAmt);
      const perUnit = num(r.line.qty) > 0 ? (rawAmt - discAmt) / num(r.line.qty) : 0;
      const { sub, tax } = lineTaxSplit({ price: perUnit, qty, taxRate: r.line.taxRate }, !!sale.taxIncluded);
      total += sub + tax;
    });
    wrap.querySelector('.returnTotal').textContent = `Refund total: ${money(total)}`;
  };
  qtyInputs.forEach((inp) => inp.addEventListener('input', updateTotal));
  updateTotal();
  wrap.querySelector('.returnSubmit').onclick = async (e) => {
    e.stopPropagation();
    const lines = rows.map((r, i) => ({ lineIndex: r.index, qty: num(qtyInputs[i].value) })).filter((l) => l.qty > 0);
    if (!lines.length) { toast('Enter a quantity to return first'); return; }
    const tender = wrap.querySelector('.returnTender').value;
    const reason = wrap.querySelector('.returnReason').value.trim();
    if (!await askConfirm(`Process this return?`, 'Return')) return;
    try {
      const r = await api('POST', `/api/sales/${sale.id}/return`, { lines, tender, reason });
      toast(`Return processed — ${money(r.total)} refunded`);
      await Promise.all([loadPosItems(), loadSales()]);
    } catch (err) { toast(err.message || 'Could not process return'); }
  };
  return wrap;
}
async function loadSales() {
  try {
    sales = await api('GET', '/api/sales');
    setOnlineStatus(true);
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    setOnlineStatus(false);
    sales = sales || [];
  }
  await loadQueuedSales();
  renderSales();
  // renderPosItems() also reads `sales`/`queuedSales` now (for a per-event item's remaining
  // count) — refreshing it here too means that's always current no matter which of
  // loadSales()/loadPosItems() a caller's Promise.all happens to settle last.
  renderPosItems();
}
function renderSales() {
  const box = $('salesList');
  const ev = openEvent(); const ctxId = ev ? ev.id : null;
  $('salesHeading').textContent = ev ? `${ev.name || 'Event'} — sales` : (testMode ? 'Recent test sales' : 'Recent sales');
  const combined = [...queuedSales, ...sales].sort((a, b) => b.createdAt - a.createdAt);
  let visible = combined.filter(s => !!s.test === testMode && s.eventId === ctxId);
  if (!ctxId) visible = visible.slice(0, 30);
  box.innerHTML = '';
  for (const sale of visible) box.appendChild(buildSaleReceipt(sale));
  $('salesEmpty').hidden = visible.length > 0;
  $('salesEmpty').textContent = ev ? `No sales yet for ${ev.name || 'this event'}.` : (testMode ? 'No test sales yet.' : 'No sales yet.');
  updateTestControls();
}
async function voidSale(sale) {
  if (sale.pendingSync) {
    if (!await askConfirm(`Remove this unsynced ${money(sale.total)} sale? It never reached the server.`, 'Remove sale')) return;
    await Offline.removeQueuedSale(sale.clientSaleId);
    queuedSales = queuedSales.filter((s) => s.clientSaleId !== sale.clientSaleId);
    applyLocalStockDelta(sale.lines, 1);
    toast('Unsynced sale removed');
    renderSales();
    updateOfflineBanner();
    return;
  }
  if (!await askConfirm(sale.test ? `Void this ${money(sale.total)} test sale?` : `Void this ${money(sale.total)} sale? Any stock it used will be added back.`, 'Void sale')) return;
  try { await api('DELETE', '/api/sales/' + sale.id); toast(sale.test ? 'Test sale voided' : 'Sale voided — stock restored'); }
  catch (e) { toast('Could not void that sale — try again.'); }
  await Promise.all([loadSales(), loadPosItems(), renderEventWidget(), renderEventHistory(), renderEventUpcoming()]);
}

// ---------- Events & break-even tracker ----------
const openEvent = () => events.find(e => e.status === 'open' && !!e.test === testMode);
function eventWindow(ev) {
  const startMs = new Date(ev.start + 'T00:00:00').getTime();
  const days = Math.max(1, Math.round(num(ev.days)));
  return { startMs, endMs: startMs + days * 86400000, days };
}
const eventSales = ev => [...queuedSales, ...sales].filter(s => s.eventId === ev.id);
const eventProfit = ev => eventSales(ev).reduce((sum, s) => sum + num(s.profit || 0), 0); // public sales have no profit; see Reports for real totals
async function loadEvents() {
  try {
    events = await api('GET', '/api/events');
    setOnlineStatus(true);
    Offline.saveSnapshot('events', events);
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    setOnlineStatus(false);
    const cached = await Offline.getSnapshot('events');
    if (cached) events = cached;
  }
  renderEventWidget(); renderEventHistory(); renderEventUpcoming();
}
function renderEventWidget() {
  const bar = $('eventBar'), link = $('eventSetupLink'), gear = $('eventGear');
  const ev = openEvent();
  const restricted = isRestrictedCashier();
  // The "+ Set up an event" link stays available even while one is already open — it's also
  // how you add another draft event for later, not just the first one.
  link.hidden = restricted;
  link.textContent = ev ? '+ Add another event' : '+ Set up an event (break-even tracker)';
  if (!ev) { bar.hidden = true; return; }
  bar.hidden = false;
  gear.hidden = restricted;
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
    row.innerHTML = `<div class="ev-top"><b></b><span class="ev-net"></span></div><div class="ev-meta"></div><button class="ev-view-btn"></button><button class="ev-view-btn ev-clone">Clone as new draft</button><button class="ev-del">Delete</button><div class="ev-sales" hidden></div>`;
    row.querySelector('.ev-top b').textContent = ev.name || 'Event';
    const netEl = row.querySelector('.ev-net'); const net = revenue - num(ev.cost);
    netEl.textContent = (net >= 0 ? '+' : '−') + money(Math.abs(net)); netEl.classList.add(net >= 0 ? 'pos' : 'neg');
    row.querySelector('.ev-meta').textContent = `${new Date(ev.start + 'T00:00:00').toLocaleDateString()} · ${days} day${days > 1 ? 's' : ''} · ${evSalesList.length} sale${evSalesList.length === 1 ? '' : 's'} · ${money(revenue)} revenue − ${money(num(ev.cost))} space`;
    const viewBtn = row.querySelector('.ev-view-btn'), salesBox = row.querySelector('.ev-sales');
    viewBtn.hidden = evSalesList.length === 0; viewBtn.textContent = `View sales (${evSalesList.length})`;
    let built = false;
    viewBtn.onclick = () => { salesBox.hidden = !salesBox.hidden; viewBtn.textContent = (salesBox.hidden ? 'View' : 'Hide') + ` sales (${evSalesList.length})`; if (!salesBox.hidden && !built) { built = true; evSalesList.forEach(s => salesBox.appendChild(buildSaleReceipt(s))); } };
    row.querySelector('.ev-clone').onclick = () => cloneEvent(ev);
    row.querySelector('.ev-del').onclick = async () => { if (!await askConfirm(`Delete “${ev.name || 'Event'}” from history?`, 'Delete event')) return; await api('DELETE', '/api/events/' + ev.id); await loadEvents(); };
    box.appendChild(row);
  }
  updateTestControls();
}
// Draft events — set up in advance, sitting ready until "Start event" makes one the live
// event. As many as wanted can exist at once (unlike open events, capped at one per
// test/real side — see events.js), so this is its own list, separate from past/open.
// Shared by the Upcoming and Past events lists — always lands as a new draft (see the
// server route for why), so cloning from either one ends up in the same place: Upcoming.
async function cloneEvent(ev) {
  try {
    await api('POST', `/api/events/${ev.id}/clone`);
    toast(`Cloned “${ev.name || 'Event'}” as a new draft`);
    await loadEvents();
  } catch (e) { toast(e.message || 'Could not clone event'); }
}
function renderEventUpcoming() {
  const card = $('eventUpcomingCard'), box = $('eventUpcomingList');
  const drafts = events.filter(e => e.status === 'draft' && !!e.test === testMode)
    .sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  card.hidden = drafts.length === 0; box.innerHTML = '';
  for (const ev of drafts) {
    const { days } = eventWindow(ev);
    const row = document.createElement('div'); row.className = 'ev-row';
    row.innerHTML = `<div class="ev-top"><b></b></div><div class="ev-meta"></div><button class="btn sm ev-start">Start event</button><button class="icon-btn gear ev-edit" title="Edit">⚙</button><button class="icon-btn ev-clone" title="Clone">⧉</button><button class="ev-del">Delete</button>`;
    row.querySelector('.ev-top b').textContent = ev.name || 'Event';
    row.querySelector('.ev-meta').textContent = `${ev.start ? new Date(ev.start + 'T00:00:00').toLocaleDateString() : 'No start date set'} · ${days} day${days > 1 ? 's' : ''} · ${money(num(ev.cost))} space cost`;
    row.querySelector('.ev-start').onclick = async () => {
      try {
        await api('POST', '/api/events', { ...ev, status: 'open' });
        toast(`“${ev.name || 'Event'}” started`);
        $('eventForm').hidden = true;
        await loadEvents();
        renderPosItems();
      } catch (e) { toast(e.message || 'Could not start event'); }
    };
    row.querySelector('.ev-edit').onclick = () => { fillEventForm(ev); $('eventForm').hidden = false; };
    row.querySelector('.ev-clone').onclick = () => cloneEvent(ev);
    row.querySelector('.ev-del').onclick = async () => { if (!await askConfirm(`Delete “${ev.name || 'Event'}”?`, 'Delete event')) return; await api('DELETE', '/api/events/' + ev.id); await loadEvents(); };
    box.appendChild(row);
  }
}
let editingEventId = null;
let evWhen = 'open';
function fillEventForm(ev) {
  editingEventId = ev ? ev.id : null;
  $('evName').value = ev?.name || ''; $('evCost').value = ev?.cost || ''; $('evStart').value = ev?.start || ''; $('evDays').value = ev?.days || 1;
  $('evTax').value = ev?.taxRate ?? ''; $('evCashTax').value = ev?.cashTaxRate ?? ''; $('evState').value = ev?.state || '';
  $('evTaxIncludedCash').checked = !!ev?.taxIncludedCash; $('evTaxIncludedOther').checked = !!ev?.taxIncludedOther;
  const isOpenEvent = !!ev && ev.status === 'open';
  $('evEnd').hidden = !isOpenEvent;
  // Editing the open event has nothing to choose — it's already live. A brand-new event
  // defaults to starting now (the old one-click behavior); a draft being edited defaults to
  // staying a draft, so re-saving it doesn't accidentally start it.
  evWhen = ev ? ev.status : (openEvent() ? 'draft' : 'open');
  $('evWhenSeg').hidden = isOpenEvent;
  renderEvWhenSeg();
  loadEventFormExtras(ev).catch(() => {});
}
function renderEvWhenSeg() {
  document.querySelectorAll('#evWhenSeg button').forEach(b => b.classList.toggle('on', b.dataset.when === evWhen));
}
document.querySelectorAll('#evWhenSeg button').forEach(b => b.onclick = () => { evWhen = b.dataset.when; renderEvWhenSeg(); });

// ---------- Event charity rules + item availability (admin/manager/lead only — same as
// event management). Both need an eventId to attach to, so — like charity rules already did —
// neither section is usable until the event has been saved at least once.
let evCharityRules = [];
let evItemScope = 'all';
let evSelectedItems = new Map(); // itemId -> qtyBrought (number or null = no limit set)
let evPickerItems = [];
let evItemSearch = '';
async function loadEventFormExtras(ev) {
  // Not gated on ev existing — the "Fill tax rate from preset" button is usable on a
  // brand-new event too, before it's ever been saved.
  loadTaxPresets().catch(() => {});
  $('evCharitySection').hidden = !ev;
  $('evItemsSection').hidden = !ev;
  $('evCharityAllSales').checked = false; $('evCharityCategory').disabled = false;
  evItemScope = ev?.itemScope || 'all';
  evSelectedItems = new Map((ev?.selectedItems || []).map(s => [s.itemId, s.qtyBrought]));
  evItemSearch = ''; $('evItemSearch').value = '';
  if (!ev) {
    evCharityRules = []; $('evCharityList').innerHTML = '';
    evPickerItems = []; renderEvItemScope();
    return;
  }
  const [rules, fullItems] = await Promise.all([
    api('GET', `/api/charity-rules?eventId=${encodeURIComponent(ev.id)}`),
    api('GET', `/api/items/full?test=${ev.test ? 1 : 0}`),
  ]);
  evCharityRules = rules;
  const cats = [...new Set(fullItems.flatMap(it => it.categories || []))].sort();
  $('categoryList').innerHTML = cats.map(c => `<option value="${esc(c)}">`).join('');
  $('evItemCatSelect').innerHTML = '<option value="">Choose a category…</option>' + cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  renderEvCharityList();
  // Excludes "custom — not for shows" items — they're always left off the Sell page at any
  // event regardless of what's picked here, so listing them (as if picking them did
  // something) would just be misleading.
  evPickerItems = fullItems.filter((it) => !it.notForShows);
  renderEvItemScope();
}
function renderEvItemScope() {
  document.querySelectorAll('#evItemScopeSeg button').forEach(b => b.classList.toggle('on', b.dataset.scope === evItemScope));
  $('evItemPicker').hidden = evItemScope !== 'selected';
  if (evItemScope === 'selected') renderEvItemCheckList();
}
function renderEvItemCheckList() {
  const box = $('evItemCheckList');
  const q = evItemSearch.trim().toLowerCase();
  const list = evPickerItems.filter(it => !q || it.name.toLowerCase().includes(q) || (it.categories || []).some(c => c.toLowerCase().includes(q)));
  box.innerHTML = '';
  for (const it of list) {
    const row = document.createElement('div'); row.className = 'ev-item-row';
    row.innerHTML = `<label class="chk-field" style="margin-top:0;flex:1"><input type="checkbox"><span></span></label><input type="number" class="in-tiny ev-item-qty" min="0" step="1" placeholder="qty">`;
    const chk = row.querySelector('input[type="checkbox"]');
    const qtyIn = row.querySelector('.ev-item-qty');
    const checked = evSelectedItems.has(it.id);
    chk.checked = checked;
    const cats = (it.categories || []).join(', ');
    row.querySelector('span').textContent = it.name + (cats ? ` · ${cats}` : '');
    qtyIn.disabled = !checked;
    qtyIn.value = checked && evSelectedItems.get(it.id) != null ? evSelectedItems.get(it.id) : '';
    chk.onchange = () => {
      if (chk.checked) {
        qtyIn.disabled = false;
        if (qtyIn.value === '') qtyIn.value = it.stock;
        evSelectedItems.set(it.id, qtyIn.value === '' ? null : num(qtyIn.value));
      } else {
        evSelectedItems.delete(it.id); qtyIn.disabled = true; qtyIn.value = '';
      }
      updateEvItemPickCount();
    };
    qtyIn.oninput = () => { if (chk.checked) evSelectedItems.set(it.id, qtyIn.value === '' ? null : num(qtyIn.value)); };
    box.appendChild(row);
  }
  if (!list.length) box.innerHTML = '<div class="hint">No items match.</div>';
  updateEvItemPickCount();
}
function updateEvItemPickCount() {
  $('evItemPickCount').textContent = `${evSelectedItems.size} item${evSelectedItems.size === 1 ? '' : 's'} selected`;
}
document.querySelectorAll('#evItemScopeSeg button').forEach(b => b.onclick = () => { evItemScope = b.dataset.scope; renderEvItemScope(); });
$('evItemSearch').addEventListener('input', () => { evItemSearch = $('evItemSearch').value; renderEvItemCheckList(); });
$('evItemCatAdd').onclick = () => {
  const cat = $('evItemCatSelect').value;
  if (!cat) { toast('Pick a category first'); return; }
  let added = 0;
  for (const it of evPickerItems) {
    if ((it.categories || []).includes(cat) && !evSelectedItems.has(it.id)) { evSelectedItems.set(it.id, it.stock); added++; }
  }
  renderEvItemCheckList();
  toast(added ? `Added ${added} item${added === 1 ? '' : 's'} from “${cat}”` : `All items in “${cat}” were already selected`);
};
function renderEvCharityList() {
  const box = $('evCharityList');
  if (!evCharityRules.length) { box.innerHTML = '<div class="hint">No charity rules yet for this event.</div>'; return; }
  box.innerHTML = '';
  const sorted = [...evCharityRules].sort((a, b) => a.category.localeCompare(b.category));
  for (const r of sorted) {
    const row = document.createElement('div'); row.className = 'ev-charity-row';
    row.innerHTML = `<span class="ev-charity-name"></span><span class="ev-charity-pct"></span><button class="icon-btn del" title="Remove rule">×</button>`;
    row.querySelector('.ev-charity-name').textContent = r.allSales ? 'All sales' : r.category;
    row.querySelector('.ev-charity-pct').textContent = `${r.charityPct}%`;
    row.querySelector('.del').onclick = async () => {
      try { await api('DELETE', `/api/charity-rules/${r.id}`); evCharityRules = evCharityRules.filter(x => x !== r); renderEvCharityList(); toast('Rule removed'); }
      catch (e) { toast(e.message || 'Could not remove rule'); }
    };
    box.appendChild(row);
  }
}
$('evCharityAllSales').onchange = () => {
  $('evCharityCategory').disabled = $('evCharityAllSales').checked;
  if ($('evCharityAllSales').checked) $('evCharityCategory').value = '';
};
$('evCharityAdd').onclick = async () => {
  const ev = openEvent(); if (!ev) return;
  const allSales = $('evCharityAllSales').checked;
  const category = $('evCharityCategory').value.trim();
  const pct = $('evCharityPct').value;
  if ((!allSales && !category) || pct === '' || num(pct) < 0 || num(pct) > 100) { toast('Pick a category (or check “all sales”) and a % from 0–100'); return; }
  try {
    const saved = await api('POST', '/api/charity-rules', { eventId: ev.id, category, allSales, charityPct: num(pct) });
    evCharityRules = evCharityRules.filter(r => r.category !== saved.category);
    evCharityRules.push(saved);
    $('evCharityCategory').value = ''; $('evCharityPct').value = ''; $('evCharityAllSales').checked = false; $('evCharityCategory').disabled = false;
    renderEvCharityList();
    toast('Charity rule added');
  } catch (e) { toast(e.message || 'Could not add rule'); }
};
$('eventSetupLink').onclick = () => { fillEventForm(null); $('eventForm').hidden = false; $('evStart').focus(); };
$('eventGear').onclick = () => { fillEventForm(openEvent()); $('eventForm').hidden = !$('eventForm').hidden; };
$('evClose').onclick = () => { $('eventForm').hidden = true; };
$('evSave').onclick = async () => {
  if (!$('evStart').value || num($('evDays').value) < 1 || num($('evCost').value) <= 0) { toast('Add a start date, number of days, and space cost'); return; }
  const existing = editingEventId ? events.find(e => e.id === editingEventId) : null;
  const status = (existing && existing.status === 'open') ? 'open' : evWhen;
  let saved;
  try {
    saved = await api('POST', '/api/events', {
      id: existing?.id, name: $('evName').value.trim(), cost: $('evCost').value, start: $('evStart').value, days: $('evDays').value,
      taxRate: $('evTax').value, cashTaxRate: $('evCashTax').value, state: $('evState').value.trim(), taxIncludedCash: $('evTaxIncludedCash').checked, taxIncludedOther: $('evTaxIncludedOther').checked,
      status, test: testMode, itemScope: existing ? evItemScope : 'all',
    });
  } catch (e) { toast(e.message || 'Could not save event'); return; }
  if (existing && evItemScope === 'selected') {
    await api('POST', `/api/events/${saved.id}/items`, { items: [...evSelectedItems].map(([itemId, qtyBrought]) => ({ itemId, qtyBrought })) });
  }
  toast(status === 'draft' ? 'Saved as draft' : 'Event saved');
  await loadEvents();
  // Keep the form open, now pointed at the saved event, instead of closing it — a brand-new
  // event's item picker and charity rules only become usable once it has an id (same reason
  // charity rules always needed this), so closing here would hide the very thing someone
  // creating an event for the first time is looking for right after. "Close" dismisses it
  // once they're done.
  fillEventForm(events.find(e => e.id === saved.id) || saved);
  $('eventForm').hidden = false;
  renderPosItems();
};
$('evFillTaxPreset').onclick = () => {
  const state = $('evState').value.trim();
  if (!state) { $('evState').focus(); toast('Type a state first'); return; }
  const preset = taxPresets.find((p) => p.state.toLowerCase() === state.toLowerCase());
  if (!preset) { toast(`No saved preset for “${state}” — add one in Settings.`); return; }
  $('evTax').value = preset.salesTaxRate ?? '';
  $('evCashTax').value = preset.cashTaxRate ?? '';
  toast(`Filled tax rate from “${preset.state}”`);
};
// What to bring to this event: the explicit per-item quantities if the event is scoped to
// "selected items", or — if it's open to the whole catalog — every sellable item's current
// stock (custom "not for shows" items are already excluded from evPickerItems, so they never
// show up here either). Uses whatever the form currently has, not just what's saved, so
// a not-yet-saved change to the item picker is reflected immediately.
function buildPackingListRows() {
  const byId = new Map(evPickerItems.map((it) => [it.id, it]));
  const rows = evItemScope === 'selected'
    ? [...evSelectedItems].map(([itemId, qty]) => {
        const it = byId.get(itemId);
        return { name: it ? it.name : '(deleted item)', qty: qty != null ? qty : (it ? it.stock : '') };
      })
    : evPickerItems.map((it) => ({ name: it.name, qty: it.stock }));
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}
function printFromCard(bodyClass, cardId, fill) {
  fill();
  $(cardId).hidden = false;
  document.body.classList.add(bodyClass);
  const restore = () => {
    document.body.classList.remove(bodyClass);
    $(cardId).hidden = true;
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);
  window.print();
}
$('evPrintPacking').onclick = () => {
  const rows = buildPackingListRows();
  if (!rows.length) { toast('No items to pack for this event'); return; }
  printFromCard('printing-packing-list', 'packingListCard', () => {
    $('packingListTitle').textContent = `Packing list — ${$('evName').value.trim() || 'Event'}`;
    $('packingListSub').textContent = $('evStart').value ? new Date($('evStart').value + 'T00:00:00').toLocaleDateString() : '';
    $('packingListRows').innerHTML = rows.map((r) => `<tr><td>${esc(r.name)}</td><td class="r">${r.qty === '' || r.qty == null ? '—' : num(r.qty)}</td></tr>`).join('');
  });
};
// Same item set as the packing list (minus quantities, which tags don't need) — barcoded with
// the item's own existing number via the vendored Code128 renderer (see public/vendor), which
// a USB scanner reads back as plain keystrokes at checkout (see the posSearch lookup above).
function buildTagItems() {
  const byId = new Map(evPickerItems.map((it) => [it.id, it]));
  const chosen = evItemScope === 'selected'
    ? [...evSelectedItems.keys()].map((id) => byId.get(id)).filter(Boolean)
    : evPickerItems;
  return chosen.map((it) => ({ name: it.name, price: it.price, itemNo: it.itemNo })).sort((a, b) => a.name.localeCompare(b.name));
}
$('evPrintTags').onclick = () => {
  const tagItems = buildTagItems();
  if (!tagItems.length) { toast('No items to print tags for in this event'); return; }
  const withBarcode = $('evTagsBarcode').checked;
  printFromCard('printing-price-tags', 'priceTagsCard', () => {
    $('priceTagsGrid').innerHTML = tagItems.map((it, i) => `
      <div class="price-tag">
        <div class="tag-name">${esc(it.name)}</div>
        <div class="tag-price">${money(num(it.price))}</div>
        ${withBarcode && it.itemNo ? `<svg class="tag-barcode" id="tag-bc-${i}"></svg><div class="tag-no">${esc(it.itemNo)}</div>` : (it.itemNo ? `<div class="tag-no">#${esc(it.itemNo)}</div>` : '')}
      </div>`).join('');
    if (withBarcode && window.JsBarcode) {
      tagItems.forEach((it, i) => {
        if (!it.itemNo) return;
        try { window.JsBarcode(`#tag-bc-${i}`, it.itemNo, { format: 'CODE128', displayValue: false, height: 40, margin: 0 }); }
        catch { /* a malformed item number (shouldn't happen) just skips its barcode, not the whole print */ }
      });
    }
  });
};
$('evEnd').onclick = async () => {
  const existing = editingEventId ? events.find(e => e.id === editingEventId) : null;
  if (!existing) return;
  if (!await askConfirm(`End “${existing.name || 'this event'}”? It'll move to Past events.`, 'End event')) return;
  await api('POST', '/api/events', { ...existing, status: 'ended', endedAt: Date.now() });
  $('eventForm').hidden = true; toast('Event ended');
  await loadEvents();
  renderPosItems();
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
  renderEventWidget(); renderEventHistory(); renderEventUpcoming(); renderSales();
  // Items and materials are split into real/test catalogs too — switch every tab over to
  // whichever side matches now. Guarded by `me` since this also runs once at boot, before
  // login, when these endpoints would just 401.
  if (me) {
    Promise.all([loadPosItems(), loadMaterials(), loadItems()]).catch(() => {});
    if (currentTab === 'reports') renderReports().catch(() => {});
    if (currentTab === 'orders') loadCustomOrders().catch(() => {});
  }
}
$('testModeOnLink').onclick = () => { setTestMode(true); toast('Test mode on — practice away'); };
async function purgeTestData(askFirst) {
  if (askFirst && !await askConfirm('Permanently delete all test items, materials, events, sales, and custom orders?', 'Clear test data')) return 'cancelled';
  let counts;
  try {
    counts = (await api('POST', '/api/test-data/purge')).counts;
  } catch (e) {
    await Promise.all([loadEvents(), loadSales()]).catch(() => {});
    return 'failed';
  }
  // The purge itself already succeeded at this point — a refresh failing for a role that
  // can't read materials/items full detail (e.g. a cashier) shouldn't turn a successful
  // purge into a reported failure.
  const refreshes = [loadEvents(), loadSales(), loadMaterials(), loadItems(), loadPosItems()];
  if (currentTab === 'orders') refreshes.push(loadCustomOrders());
  await Promise.all(refreshes).catch(() => {});
  const total = (counts.sales || 0) + (counts.events || 0) + (counts.items || 0) + (counts.materials || 0) + (counts.customOrders || 0);
  return total > 0 ? 'purged' : 'empty';
}
$('purgeTestLink').onclick = async () => {
  const r = await purgeTestData(true);
  if (r === 'purged') toast('Test data cleared');
  else if (r === 'empty') toast('No test data to clear');
  else if (r === 'failed') toast('Could not clear test data — try again.');
};
$('purgeTestOffLink').onclick = async () => {
  const r = await purgeTestData(true);
  if (r === 'purged') toast('Test data purged');
  else if (r === 'empty') toast('No test data to purge');
  else if (r === 'failed') toast('Could not purge test data — try again.');
};
$('testModeOffLink').onclick = async () => {
  const r = await purgeTestData(false);
  if (r === 'failed') { toast('Could not purge test data — try again.'); return; }
  setTestMode(false);
  toast(r === 'purged' ? 'Exited test mode — test data purged' : 'Exited test mode');
};
$('testModeOffKeepLink').onclick = () => {
  setTestMode(false);
  toast('Exited test mode — test data kept for next time');
};

// ---------- Reports (core: stats, chart, top items, payment type) ----------
let rptRange = '7';
let rptTab = 'overview';
let voidedSales = [];
let rptInvItemSearch = '';
let rptInvMatSearch = '';
const dayStart = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
function rptWindow(key) {
  const now = Date.now(); const today0 = dayStart(now);
  if (key === 'today') return { start: today0, end: now };
  if (key === '7') return { start: today0 - 6 * 86400000, end: now };
  if (key === '30') return { start: today0 - 29 * 86400000, end: now };
  const all = fullSales.filter(s => !!s.test === testMode);
  const earliest = all.length ? Math.min(...all.map(s => s.createdAt || now)) : now;
  return { start: dayStart(earliest), end: now };
}
async function renderReports() {
  const [sold, returned] = await Promise.all([api('GET', '/api/sales/full'), api('GET', '/api/sales/returns')]);
  // Each return is shaped exactly like a sale but negated (server/routes/sales.js) — merging it
  // straight into fullSales means every reduce()-based figure below (and every other Reports
  // computation that reads fullSales/inRange — by item, by event, by tender…) nets returns out
  // automatically, the same arithmetic it'd already do for a line with a negative quantity.
  [fullSales, items, appSettings, lib, voidedSales] = await Promise.all([
    Promise.resolve([...sold, ...returned]),
    api('GET', `/api/items/full?test=${testMode ? 1 : 0}`),
    api('GET', '/api/settings'),
    api('GET', `/api/materials?test=${testMode ? 1 : 0}`),
    api('GET', '/api/sales/voids'),
  ]);
  const { start, end } = rptWindow(rptRange);
  const inRange = fullSales.filter(s => !!s.test === testMode && (s.createdAt || 0) >= start && (s.createdAt || 0) <= end);
  const saleCount = inRange.filter(s => !s.isReturn).length;
  const returnCount = inRange.filter(s => s.isReturn).length;
  const fmtDate = ms => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  $('rptRangeHint').textContent = `${fmtDate(start)} – ${fmtDate(end)} · ${saleCount ? `${saleCount} sale${saleCount === 1 ? '' : 's'}` : 'no sales yet'}${returnCount ? ` · ${returnCount} return${returnCount === 1 ? '' : 's'}` : ''}`;
  const revenue = inRange.reduce((n, s) => n + num(s.total), 0);
  const profit = inRange.reduce((n, s) => n + num(s.profit), 0);
  const tax = inRange.reduce((n, s) => n + num(s.tax), 0);
  const charityDue = inRange.reduce((n, s) => n + num(s.charityDue), 0);
  const cardFees = inRange.reduce((n, s) => n + num(s.cardFee), 0);
  const returnsTotal = inRange.filter(s => s.isReturn).reduce((n, s) => n - num(s.total), 0);
  const itemsSold = inRange.reduce((n, s) => n + s.lines.reduce((m, l) => m + num(l.qty), 0), 0);
  const avg = saleCount ? revenue / saleCount : 0;
  const tiles = [
    { lbl: 'Revenue', val: money(revenue) }, { lbl: 'Profit', val: money(profit), neg: profit < 0, highlight: true },
    { lbl: 'Tax collected', val: money(tax) }, { lbl: 'Sales', val: saleCount },
    { lbl: 'Items sold', val: itemsSold }, { lbl: 'Avg sale', val: money(avg) },
  ];
  if (charityDue > 0) tiles.push({ lbl: 'Owed to charity', val: money(charityDue) });
  if (cardFees > 0) tiles.push({ lbl: 'Card processing fees', val: money(cardFees) });
  if (returnsTotal > 0) tiles.push({ lbl: 'Returned', val: money(returnsTotal), neg: true });
  $('rptStats').innerHTML = tiles.map(t => `<div class="stat-tile${t.highlight ? ' highlight' : ''}"><div class="lbl">${t.lbl}</div><div class="val${t.neg ? ' neg' : ''}">${t.val}</div></div>`).join('');
  renderRptChart(inRange, start, end);
  renderRptTop(inRange);
  renderRptTender(inRange, revenue);
  renderRptCost(inRange);
  renderRptEvents();
  renderRptByUser(inRange);
  renderRptInventory();
  renderRptTax(inRange, start, end);
  renderRptVoids(start, end);
  renderRptReturns(inRange);
  showReportTab(rptTab);
}
function showReportTab(t) {
  rptTab = t;
  document.querySelectorAll('#rptTabs button').forEach(b => b.classList.toggle('on', b.dataset.rpttab === t));
  ['overview', 'byuser', 'byitem', 'events', 'inventory', 'tax', 'voids', 'returns'].forEach(x => $('rpt-tab-' + x).hidden = x !== t);
}
document.querySelectorAll('#rptTabs button').forEach(b => b.onclick = () => showReportTab(b.dataset.rpttab));
function renderRptByUser(inRange) {
  const box = $('rptByUserList'), empty = $('rptByUserEmpty'), header = $('rptByUserHeader');
  if (!appSettings.trackSaleAttribution) {
    header.hidden = true;
    box.innerHTML = ''; box.hidden = true;
    empty.hidden = false; empty.textContent = 'Off — turn on "Record which user rang up each sale" in Settings to see this.';
    return;
  }
  const map = new Map();
  for (const s of inRange) {
    const key = s.soldBy || 'Unknown';
    const entry = map.get(key) || { name: key, qty: 0, revenue: 0, profit: 0 };
    entry.qty += 1;
    entry.revenue += num(s.total);
    entry.profit += num(s.profit);
    map.set(key, entry);
  }
  const rows = [...map.values()].sort((a, b) => b.profit - a.profit);
  header.hidden = rows.length === 0;
  empty.hidden = rows.length > 0;
  empty.textContent = 'No sales in this range yet.';
  box.hidden = rows.length === 0;
  box.innerHTML = '';
  for (const r of rows) {
    const avg = r.qty ? r.revenue / r.qty : 0;
    const row = document.createElement('div'); row.className = 'rpt-cost-row';
    row.innerHTML = `<div class="rpt-cost-head" style="cursor:default">
      <span class="rpt-cost-name"></span>
      <span class="rpt-cost-qty"></span>
      <span class="rpt-cost-rev"></span>
      <span class="rpt-cost-profit"></span>
      <span class="rpt-cost-num"></span>
    </div>`;
    row.querySelector('.rpt-cost-name').textContent = r.name;
    row.querySelector('.rpt-cost-qty').textContent = r.qty;
    row.querySelector('.rpt-cost-rev').textContent = money(r.revenue);
    const profEl = row.querySelector('.rpt-cost-profit');
    profEl.textContent = money(r.profit);
    profEl.classList.toggle('neg', r.profit < 0);
    row.querySelector('.rpt-cost-num').textContent = money(avg);
    box.appendChild(row);
  }
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
// Groups a list of (full) sales' charity amounts by the rule that produced them — a matched
// item category, or '' for the event's "all sales" catch-all — for the per-event wrap-up
// report. Item-level charity no longer exists, so this replaces the old per-item display.
function buildCharityBreakdown(salesList) {
  const map = new Map();
  for (const s of salesList) {
    for (const l of s.lines) {
      if (!l.charityAmt) continue;
      const key = l.charityRule || '';
      const entry = map.get(key) || { label: key === '' ? 'All sales' : key, amt: 0 };
      entry.amt += num(l.charityAmt);
      map.set(key, entry);
    }
  }
  return [...map.values()].sort((a, b) => b.amt - a.amt);
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
      mats.map(m => `<tr><td>${esc(m.name)}</td><td class="r">${m.usedPerItem.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td><td class="r">${m.totalUsed.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td><td class="r">${money(m.unitCost)}</td><td class="r">${money(m.totalCost)}</td></tr>`).join('')
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
  const evs = events.filter(e => !!e.test === testMode).slice().sort((a, b) => (b.start || '').localeCompare(a.start || ''));
  $('rptEventsEmpty').hidden = evs.length > 0;
  box.innerHTML = '';
  for (const ev of evs) {
    const evSalesList = fullSales.filter(s => s.eventId === ev.id && !!s.test === testMode);
    const revenue = evSalesList.reduce((n, s) => n + num(s.total), 0);
    const grossProfit = evSalesList.reduce((n, s) => n + num(s.profit), 0);
    const charityDue = evSalesList.reduce((n, s) => n + num(s.charityDue), 0);
    const cardFees = evSalesList.reduce((n, s) => n + num(s.cardFee), 0);
    const cost = num(ev.cost);
    const net = grossProfit - cost - cardFees;
    const row = document.createElement('div'); row.className = 'rpt-ev-row';
    row.innerHTML = `
      <button class="rpt-ev-head" type="button">
        <span class="rpt-ev-name"></span>
        <span class="rpt-ev-meta"></span>
        <span class="rpt-ev-net"></span>
      </button>
      <div class="rpt-ev-body" hidden></div>`;
    row.querySelector('.rpt-ev-name').textContent = (ev.name || 'Event') + (ev.status === 'open' ? ' · open' : '');
    row.querySelector('.rpt-ev-meta').textContent = `${ev.start ? new Date(ev.start + 'T00:00:00').toLocaleDateString() : ''} · ${evSalesList.length} sale${evSalesList.length === 1 ? '' : 's'} · ${money(revenue)} revenue${charityDue > 0 ? ` · 🎗 ${money(charityDue)} owed` : ''}`;
    const netEl = row.querySelector('.rpt-ev-net');
    netEl.textContent = `True profit ${net >= 0 ? '+' : '−'}${money(Math.abs(net))}`;
    netEl.classList.add(net >= 0 ? 'pos' : 'neg');
    const body = row.querySelector('.rpt-ev-body');
    const charityRows = buildCharityBreakdown(evSalesList);
    body.innerHTML = `
      <div class="rpt-ev-stats">
        <div><span>Revenue</span><b>${money(revenue)}</b></div>
        <div><span>Gross profit</span><b>${money(grossProfit)}</b></div>
        <div><span>Booth / event cost</span><b>−${money(cost)}</b></div>
        ${cardFees > 0 ? `<div><span>Card processing fees</span><b style="color:var(--danger)">−${money(cardFees)}</b></div>` : ''}
        <div><span>True profit</span><b class="${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : '−'}${money(Math.abs(net))}</b></div>
        ${charityDue > 0 ? `<div><span>Owed to charity</span><b style="color:var(--warn)">${money(charityDue)}</b></div>` : ''}
      </div>
      <div class="hint">True profit is this event's sales profit minus its booth/space cost${cardFees > 0 ? ' and card processing fees' : ''} — use it when splitting proceeds among partners.${charityDue > 0 ? ' "Owed to charity" is already included in both profit figures above, not an extra deduction — it’s the share of that profit set aside to donate.' : ''}</div>
      ${charityRows.length ? `<div style="margin-top:12px"><h3 style="margin:0 0 6px;font-size:13px">Charity wrap-up</h3>${charityRows.map(r => `<div class="ev-charity-row"><span class="ev-charity-name">${esc(r.label)}</span><span class="ev-charity-pct">${money(r.amt)}</span></div>`).join('')}</div>` : ''}`;
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
// A small local CSV cell-escaper/builder — same RFC4180 rule as server/lib/csv.js (quote a
// cell that contains a comma, quote, or newline; double up any quote inside it), just kept in
// the client since this is the only place it's needed and there's nothing to share with the
// server-side CSV routes (those build files from database rows, this builds one from whatever
// Reports already has loaded and filtered to the screen's own date range).
function csvCell(v) { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function toCsvText(rows, columns) {
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}
$('rptExportAccountingCsv').onclick = () => {
  const { start, end } = rptWindow(rptRange);
  const inRange = fullSales.filter(s => !!s.test === testMode && (s.createdAt || 0) >= start && (s.createdAt || 0) <= end);
  if (!inRange.length) { toast('Nothing to export in this date range'); return; }
  const rows = inRange.slice().sort((a, b) => a.createdAt - b.createdAt).map((s) => ({
    Date: new Date(s.createdAt).toLocaleString(),
    Type: s.isReturn ? 'Return' : 'Sale',
    Event: (events.find((e) => e.id === s.eventId) || {}).name || '',
    Tender: s.tender === 'cash' ? 'Cash' : 'Card/Other',
    'Card Processor': s.cardProcessor || '',
    Subtotal: s.subtotal.toFixed(2),
    Tax: s.tax.toFixed(2),
    'Card Fee': num(s.cardFee).toFixed(2),
    Total: s.total.toFixed(2),
    Profit: num(s.profit).toFixed(2),
    'Sold By': s.soldBy || '',
    Note: s.isReturn ? (s.reason || '') : '',
  }));
  const columns = ['Date', 'Type', 'Event', 'Tender', 'Card Processor', 'Subtotal', 'Tax', 'Card Fee', 'Total', 'Profit', 'Sold By', 'Note'];
  const blob = new Blob([toCsvText(rows, columns)], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);
  a.download = `craftium-accounting-${fmt(start)}-to-${fmt(end)}${testMode ? '-test' : ''}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
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
  const tiles = [['Cash', money(cash), pct(cash)], ['Card / Other', money(other), pct(other)]];
  box.innerHTML = tiles.map(([lbl, val, sub]) => `<div class="stat-tile"><div class="lbl">${lbl}</div><div class="val">${val}</div><div class="sub">${sub} of revenue</div></div>`).join('');

  // Broken out by which processor actually took each card sale — "Unspecified" covers card
  // sales rung up with no processor picked (either none were configured yet, or the cashier
  // left it on "Other / unlisted"). Only shown once there's at least one card sale to report.
  const cardSales = inRange.filter(s => s.tender !== 'cash');
  const byProc = $('rptCardProcessors');
  if (!byProc) return;
  if (!cardSales.length) { byProc.innerHTML = ''; $('rptCardProcessorsCard').hidden = true; return; }
  $('rptCardProcessorsCard').hidden = false;
  const map = new Map();
  for (const s of cardSales) {
    const key = s.cardProcessor || 'Unspecified';
    const entry = map.get(key) || { count: 0, vol: 0, fees: 0 };
    entry.count += 1; entry.vol += num(s.total); entry.fees += num(s.cardFee);
    map.set(key, entry);
  }
  const rows = [...map.entries()].sort((a, b) => b[1].vol - a[1].vol);
  byProc.innerHTML = rows.map(([name, e]) => `
    <div class="stat-tile">
      <div class="lbl">${esc(name)}</div>
      <div class="val">${money(e.vol)}</div>
      <div class="sub">${e.count} sale${e.count === 1 ? '' : 's'}${e.fees > 0 ? ` · ${money(e.fees)} in fees` : ''}</div>
    </div>`).join('');
}

// ---------- Inventory report — a point-in-time snapshot (stock on hand right now), not
// limited by the date-range selector the other reports use. ----------
function renderRptInventory() {
  const totalPotentialRevenue = items.reduce((s, it) => s + num(it.stock) * num(it.price), 0);
  const totalItemStockValue = items.reduce((s, it) => s + num(it.stock) * num(it.cost), 0);
  const totalMaterialValue = lib.reduce((s, m) => s + num(m.stock) * unitCost(m), 0);
  const lowItems = items.filter(it => isLow(it.stock, it.low));
  const lowMats = lib.filter(m => isLow(m.stock, m.low));
  const needsOrdering = lowItems.length + lowMats.length;
  const tiles = [
    { lbl: 'Potential revenue', val: money(totalPotentialRevenue), highlight: true },
    { lbl: 'Item stock value (cost)', val: money(totalItemStockValue) },
    { lbl: 'Material value', val: money(totalMaterialValue) },
    { lbl: 'Needs ordering', val: needsOrdering, neg: needsOrdering > 0, id: 'rptInvReorderTile' },
  ];
  $('rptInvStats').innerHTML = tiles.map(t => `<div class="stat-tile${t.highlight ? ' highlight' : ''}${t.id ? ' clickable' : ''}"${t.id ? ` id="${t.id}"` : ''}><div class="lbl">${t.lbl}${t.id ? ' ▾' : ''}</div><div class="val${t.neg ? ' neg' : ''}">${t.val}</div></div>`).join('');
  // Drill-down: the tile is just a count — click it to reveal exactly which items/materials
  // are low, instead of a detail card that's always sitting there whether you asked or not.
  $('rptInvReorderTile').onclick = () => {
    const card = $('rptInvReorderCard');
    card.hidden = !card.hidden;
    if (!card.hidden) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const qi = rptInvItemSearch.trim().toLowerCase();
  const itemRows = items.filter(it => !qi || it.name.toLowerCase().includes(qi));
  $('rptInvItemHeader').hidden = itemRows.length === 0;
  $('rptInvItemEmpty').hidden = itemRows.length > 0;
  $('rptInvItemEmpty').textContent = items.length === 0 ? 'No items yet.' : 'No items match your search.';
  const itemBox = $('rptInvItemList'); itemBox.innerHTML = '';
  for (const it of itemRows) {
    const stock = num(it.stock);
    const row = document.createElement('div'); row.className = 'rpt-cost-row';
    row.innerHTML = `<div class="rpt-cost-head" style="cursor:default">
      <span class="rpt-cost-name"></span>
      <span class="rpt-cost-qty"></span>
      <span class="rpt-cost-cost"></span>
      <span class="rpt-cost-rev"></span>
      <span class="rpt-cost-num"></span>
    </div>`;
    row.querySelector('.rpt-cost-name').textContent = it.name;
    row.querySelector('.rpt-cost-qty').textContent = stock;
    row.querySelector('.rpt-cost-cost').textContent = money(num(it.price));
    row.querySelector('.rpt-cost-rev').textContent = money(stock * num(it.price));
    row.querySelector('.rpt-cost-num').textContent = money(stock * num(it.cost));
    itemBox.appendChild(row);
  }

  const qm = rptInvMatSearch.trim().toLowerCase();
  const matRows = lib.filter(m => !qm || m.name.toLowerCase().includes(qm));
  $('rptInvMatHeader').hidden = matRows.length === 0;
  $('rptInvMatEmpty').hidden = matRows.length > 0;
  $('rptInvMatEmpty').textContent = lib.length === 0 ? 'No materials yet.' : 'No materials match your search.';
  const matBox = $('rptInvMatList'); matBox.innerHTML = '';
  for (const m of matRows) {
    const stock = num(m.stock);
    const unit = unitCost(m);
    const row = document.createElement('div'); row.className = 'rpt-cost-row';
    row.innerHTML = `<div class="rpt-cost-head" style="cursor:default">
      <span class="rpt-cost-name"></span>
      <span class="rpt-cost-qty"></span>
      <span class="rpt-cost-cost"></span>
      <span class="rpt-cost-num"></span>
    </div>`;
    row.querySelector('.rpt-cost-name').textContent = m.name;
    row.querySelector('.rpt-cost-qty').textContent = stock;
    row.querySelector('.rpt-cost-cost').textContent = money(unit);
    row.querySelector('.rpt-cost-num').textContent = money(stock * unit);
    matBox.appendChild(row);
  }

  const reorderRows = [
    ...lowItems.map(it => ({ name: it.name, kind: 'Item', stock: num(it.stock), low: it.low })),
    ...lowMats.map(m => ({ name: m.name, kind: 'Material', stock: num(m.stock), low: m.low })),
  ];
  $('rptInvReorderEmpty').hidden = reorderRows.length > 0;
  const reorderBox = $('rptInvReorderList'); reorderBox.innerHTML = '';
  for (const r of reorderRows) {
    const row = document.createElement('div'); row.className = 'rpt-cost-row';
    row.innerHTML = `<div class="rpt-cost-head" style="cursor:default"><span class="rpt-cost-name"></span></div>`;
    row.querySelector('.rpt-cost-name').textContent = `${r.name} (${r.kind}) — ${r.stock} on hand, low at ${r.low}`;
    reorderBox.appendChild(row);
  }
}
$('rptInvItemSearch').addEventListener('input', () => { rptInvItemSearch = $('rptInvItemSearch').value; renderRptInventory(); });
$('rptInvMatSearch').addEventListener('input', () => { rptInvMatSearch = $('rptInvMatSearch').value; renderRptInventory(); });

// ---------- Tax report — same date range as the rest. ----------
function renderRptTax(inRange, start, end) {
  const totalTax = inRange.reduce((n, s) => n + num(s.tax), 0);
  const totalSubtotal = inRange.reduce((n, s) => n + num(s.subtotal), 0);
  const effectiveRate = totalSubtotal > 0 ? (totalTax / totalSubtotal * 100) : 0;
  const tiles = [
    { lbl: 'Tax collected', val: money(totalTax), highlight: true },
    { lbl: 'Taxable sales (subtotal)', val: money(totalSubtotal) },
    { lbl: 'Effective rate', val: effectiveRate.toFixed(1) + '%' },
  ];
  $('rptTaxStats').innerHTML = tiles.map(t => `<div class="stat-tile${t.highlight ? ' highlight' : ''}"><div class="lbl">${t.lbl}</div><div class="val">${t.val}</div></div>`).join('');

  const box = $('rptTaxChart');
  const taxed = inRange.filter(s => num(s.tax) > 0);
  $('rptTaxChartEmpty').hidden = taxed.length > 0; box.hidden = taxed.length === 0;
  if (taxed.length) {
    const spanDays = Math.max(1, Math.round((dayStart(end) - start) / 86400000) + 1);
    const bucketDays = spanDays <= 31 ? 1 : spanDays <= 180 ? 7 : 30;
    const n = Math.min(60, Math.max(1, Math.ceil(spanDays / bucketDays)));
    const buckets = Array.from({ length: n }, (_, i) => ({ startMs: start + i * bucketDays * 86400000, tax: 0 }));
    for (const s of inRange) { const idx = Math.min(n - 1, Math.max(0, Math.floor((dayStart(s.createdAt) - start) / 86400000 / bucketDays))); buckets[idx].tax += num(s.tax); }
    const max = Math.max(1, ...buckets.map(b => b.tax));
    const labelEvery = Math.max(1, Math.ceil(n / 10));
    const fmt = bucketDays === 1 ? (ms => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })) : bucketDays === 30 ? (ms => new Date(ms).toLocaleDateString(undefined, { month: 'short' })) : (ms => `wk of ${new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`);
    box.innerHTML = buckets.map((b, i) => { const h = Math.max(3, Math.round(b.tax / max * 130)); const label = i % labelEvery === 0 ? fmt(b.startMs) : ''; return `<div class="rpt-bar-col"><div class="rpt-bar-tip">${esc(fmt(b.startMs))}<br>Tax ${money(b.tax)}</div><div class="rpt-bar" style="height:${h}px"></div><div class="rpt-bar-label">${esc(label)}</div></div>`; }).join('');
  } else { box.innerHTML = ''; }

  const map = new Map();
  for (const s of inRange) {
    const included = !!s.taxIncluded;
    for (const l of s.lines) {
      const rate = num(l.taxRate);
      if (rate <= 0) continue;
      const { sub, tax } = lineTaxSplit(l, included);
      const entry = map.get(rate) || { rate, taxable: 0, tax: 0 };
      entry.taxable += sub; entry.tax += tax;
      map.set(rate, entry);
    }
  }
  const rateRows = [...map.values()].sort((a, b) => b.tax - a.tax);
  $('rptTaxRateHeader').hidden = rateRows.length === 0;
  $('rptTaxRateEmpty').hidden = rateRows.length > 0;
  const rateBox = $('rptTaxRateList'); rateBox.innerHTML = '';
  for (const r of rateRows) {
    const row = document.createElement('div'); row.className = 'rpt-cost-row';
    row.innerHTML = `<div class="rpt-cost-head" style="cursor:default">
      <span class="rpt-cost-name"></span>
      <span class="rpt-cost-cost"></span>
      <span class="rpt-cost-num"></span>
    </div>`;
    row.querySelector('.rpt-cost-name').textContent = `${r.rate}%`;
    row.querySelector('.rpt-cost-cost').textContent = money(r.taxable);
    row.querySelector('.rpt-cost-num').textContent = money(r.tax);
    rateBox.appendChild(row);
  }
}

// ---------- Voided sales — who rang it up and who voided it, same date range (by when it
// was voided, not when the original sale happened). ----------
function renderRptVoids(start, end) {
  const inRange = voidedSales.filter(v => !!v.test === testMode && (v.voidedAt || 0) >= start && (v.voidedAt || 0) <= end);
  const rows = inRange.slice().sort((a, b) => b.voidedAt - a.voidedAt);
  $('rptVoidHeader').hidden = rows.length === 0;
  $('rptVoidEmpty').hidden = rows.length > 0;
  const box = $('rptVoidList'); box.innerHTML = '';
  for (const v of rows) {
    const row = document.createElement('div'); row.className = 'rpt-cost-row';
    row.innerHTML = `<div class="rpt-cost-head" style="cursor:default">
      <span class="rpt-cost-name"></span>
      <span class="rpt-cost-cost"></span>
      <span class="rpt-cost-profit"></span>
    </div>`;
    const nameEl = row.querySelector('.rpt-cost-name');
    nameEl.innerHTML = `${esc(new Date(v.voidedAt).toLocaleString())}<br><small style="color:var(--muted);font-weight:400">Sold by ${esc(v.soldBy || 'unknown')} · voided by ${esc(v.voidedBy || 'unknown')}</small>`;
    row.querySelector('.rpt-cost-cost').textContent = money(v.total);
    const profEl = row.querySelector('.rpt-cost-profit');
    profEl.textContent = money(v.profit);
    profEl.classList.toggle('neg', v.profit < 0);
    box.appendChild(row);
  }
}

// Returns are already in `inRange` (merged into fullSales as negative-shaped entries, see
// renderReports) — this just picks them back out for their own listing instead of netting them
// into every other breakdown the way the rest of Reports does.
function renderRptReturns(inRange) {
  const rows = inRange.filter(s => s.isReturn).slice().sort((a, b) => b.createdAt - a.createdAt);
  $('rptReturnsHeader').hidden = rows.length === 0;
  $('rptReturnsEmpty').hidden = rows.length > 0;
  const box = $('rptReturnsList'); box.innerHTML = '';
  for (const r of rows) {
    const row = document.createElement('div'); row.className = 'rpt-cost-row';
    row.innerHTML = `<div class="rpt-cost-head" style="cursor:default">
      <span class="rpt-cost-name"></span>
      <span class="rpt-cost-cost"></span>
      <span class="rpt-cost-profit"></span>
    </div>`;
    const nameEl = row.querySelector('.rpt-cost-name');
    const items = r.lines.map(l => `${-num(l.qty)} × ${esc(l.name)}`).join(', ');
    nameEl.innerHTML = `${esc(new Date(r.createdAt).toLocaleString())} — ${items}<br><small style="color:var(--muted);font-weight:400">Processed by ${esc(r.soldBy || 'unknown')}${r.reason ? ` · ${esc(r.reason)}` : ''}</small>`;
    row.querySelector('.rpt-cost-cost').textContent = money(-num(r.total));
    const profEl = row.querySelector('.rpt-cost-profit');
    profEl.textContent = money(num(r.profit));
    profEl.classList.add('neg');
    box.appendChild(row);
  }
}

document.querySelectorAll('#rptRangeSeg button').forEach(b => b.onclick = () => { rptRange = b.dataset.range; document.querySelectorAll('#rptRangeSeg button').forEach(x => x.classList.toggle('on', x === b)); renderReports(); });

// ---------- Settings: sales tracking ----------
let appSettings = { trackSaleAttribution: true, defaultCardProcessorId: '' };
// ---------- Settings: duplicate items/materials ----------
// Groups by name only (trimmed, lowercased, internal whitespace collapsed) — catches the
// common accidental-duplicate causes (a double-submitted save, a re-imported CSV row whose
// name didn't quite match an existing one) without the false-positive risk of fuzzy matching.
// Deletion reuses the exact same deleteItem()/deleteLib() as each tab's own delete button —
// same confirmation, same cleanup of anything that referenced it — this is just a different
// way of finding what to delete, not a different way of deleting it.
const dupKey = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
function groupDuplicates(list, nameOf) {
  const map = new Map();
  for (const x of list) {
    const k = dupKey(nameOf(x));
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(x);
  }
  return [...map.values()].filter((g) => g.length > 1).sort((a, b) => nameOf(a[0]).localeCompare(nameOf(b[0])));
}
async function loadDuplicates() {
  await Promise.all([loadItems(), loadMaterials()]);
  renderDuplicateItems();
  renderDuplicateMaterials();
}
function buildDupGroup(name, count, rows) {
  const wrap = document.createElement('div'); wrap.className = 'dup-group';
  wrap.innerHTML = `<div class="dup-group-title">${esc(name)} <span class="count">${count} copies</span></div>`;
  for (const row of rows) wrap.appendChild(row);
  return wrap;
}
function renderDuplicateItems() {
  const box = $('dupItemsList'); if (!box) return;
  const groups = groupDuplicates(items, (it) => it.name);
  $('dupItemsEmpty').hidden = groups.length > 0;
  box.innerHTML = '';
  for (const g of groups) {
    const rows = g.map((it) => {
      const row = document.createElement('div'); row.className = 'dup-row';
      row.innerHTML = `<div class="dup-info"></div><button class="btn sm danger">Delete</button>`;
      row.querySelector('.dup-info').innerHTML =
        `“${esc(it.name)}” <span style="color:var(--ink)">· #${it.itemNo} · ${money(it.price)}, cost ${money(it.cost)} · stock ${it.stock}${it.createdAt ? ` · added ${new Date(it.createdAt).toLocaleDateString()}` : ''}</span>`;
      row.querySelector('button').onclick = async () => { await deleteItem(it); renderDuplicateItems(); };
      return row;
    });
    box.appendChild(buildDupGroup(g[0].name, g.length, rows));
  }
}
function renderDuplicateMaterials() {
  const box = $('dupMaterialsList'); if (!box) return;
  const groups = groupDuplicates(lib, (m) => m.name);
  $('dupMaterialsEmpty').hidden = groups.length > 0;
  box.innerHTML = '';
  for (const g of groups) {
    const rows = g.map((m) => {
      const row = document.createElement('div'); row.className = 'dup-row';
      row.innerHTML = `<div class="dup-info"></div><button class="btn sm danger">Delete</button>`;
      const src = sources.find((s) => s.id === m.sourceId);
      const u = usedIn(m.id);
      row.querySelector('.dup-info').innerHTML =
        `“${esc(m.name)}” <span style="color:var(--ink)">· ${money(m.price)} per ${m.yield}${src ? ` · ${src.name}` : ''} · stock ${m.stock}${u ? ` · used in ${u} item${u > 1 ? 's' : ''}` : ''}${m.created ? ` · added ${new Date(m.created).toLocaleDateString()}` : ''}</span>`;
      row.querySelector('button').onclick = async () => { await deleteLib(m); renderDuplicateMaterials(); };
      return row;
    });
    box.appendChild(buildDupGroup(g[0].name, g.length, rows));
  }
}

// ---------- Settings: email alerts ----------
async function loadMailSettings() {
  let c;
  try { c = await api('GET', '/api/email-settings'); } catch { return; }
  $('mailHost').value = c.host || '';
  $('mailPort').value = c.port || '';
  $('mailSecure').checked = !!c.secure;
  $('mailUser').value = c.user || '';
  $('mailPass').value = '';
  $('mailPass').placeholder = c.hasPassword ? 'leave blank to keep unchanged' : '';
  $('mailFrom').value = c.from || '';
  $('mailAlertRecipient').value = c.alertRecipient || '';
  $('mailLowStockChk').checked = !!c.lowStockEnabled;
  $('mailStatusHint').textContent = c.host && c.from && c.alertRecipient
    ? `Configured — sending through ${c.host}.` : 'Not fully configured yet — nothing will be emailed.';
}
$('mailSaveBtn').onclick = async () => {
  const body = {
    host: $('mailHost').value, port: $('mailPort').value, secure: $('mailSecure').checked,
    user: $('mailUser').value, password: $('mailPass').value,
    from: $('mailFrom').value, alertRecipient: $('mailAlertRecipient').value,
    lowStockEnabled: $('mailLowStockChk').checked,
  };
  try { await api('POST', '/api/email-settings', body); toast('Email settings saved'); await loadMailSettings(); }
  catch (e) { toast(e.message || 'Could not save email settings'); }
};
$('mailTestBtn').onclick = async () => {
  $('mailTestBtn').disabled = true;
  try { await api('POST', '/api/email-settings/test'); toast('Test email sent — check the alert recipient’s inbox'); }
  catch (e) { toast(e.message || 'Could not send test email'); }
  finally { $('mailTestBtn').disabled = false; }
};
$('mailCheckNowBtn').onclick = async () => {
  $('mailCheckNowBtn').disabled = true;
  try {
    const r = await api('POST', '/api/email-settings/check-low-stock');
    if (r.sent) toast(`Low-stock digest sent — ${r.count} item${r.count === 1 ? '' : 's'}/materials low`);
    else if (r.reason === 'disabled') toast('Turn on the low-stock checkbox first');
    else if (r.reason === 'no_recipient') toast('Set an alert recipient first');
    else if (r.reason === 'nothing_low') toast('Nothing is low on stock right now');
    else toast(r.error || 'Could not run the check');
  } catch (e) { toast(e.message || 'Could not run the check'); }
  finally { $('mailCheckNowBtn').disabled = false; }
};

// ---------- Branding (logo, business name, accent color) ----------
// Public (no login needed) since the login screen itself shows it — see server/routes/branding.
let branding = { name: '', accentColor: '', logo: '' };
const DEFAULT_ACCENT = '#c1623d';
const BRAND_SWATCHES = ['#c1623d', '#b5651d', '#6b7a3d', '#2f7d5b', '#3d6a73', '#7a4a6b'];
async function loadBranding() {
  try { branding = await api('GET', '/api/branding'); } catch { /* offline/unreachable — keep defaults, don't block boot */ }
  applyBranding();
}
function fillLetterhead(wrapId, imgId, nameId) {
  const has = !!(branding.name || branding.logo);
  $(wrapId).hidden = !has;
  $(imgId).hidden = !branding.logo;
  if (branding.logo) $(imgId).src = branding.logo;
  $(nameId).textContent = branding.name || '';
}
function applyBranding() {
  const root = document.documentElement.style;
  if (branding.accentColor) root.setProperty('--accent', branding.accentColor);
  else root.removeProperty('--accent');
  const name = branding.name || 'Craftium';
  $('brandName').textContent = name;
  document.title = name;
  // A shop's own uploaded logo if they've set one; otherwise fall back to the Craftium mark
  // rather than showing no logo at all — the header is the app's own UI, not a customer-facing
  // document, so defaulting to Craftium's own branding here is fine. The sign-in screen
  // doesn't need this fallback too — it already always shows the Craftium banner up top, so
  // repeating it in this smaller slot right below would just be the same logo shown twice.
  $('brandLogo').hidden = false;
  $('brandLogo').src = branding.logo || '/icons/icon-512.png';
  $('loginBrandRow').hidden = !branding.logo;
  if (branding.logo) $('loginBrandLogo').src = branding.logo;
  fillLetterhead('packingLetterhead', 'packingLetterheadLogo', 'packingLetterheadName');
  fillLetterhead('poLetterhead', 'poLetterheadLogo', 'poLetterheadName');
}
function renderBrandSwatches() {
  const cur = ($('brandAccentInput').value || '').toLowerCase();
  $('brandSwatches').innerHTML = BRAND_SWATCHES.map(c =>
    `<button type="button" class="swatch${c.toLowerCase() === cur ? ' on' : ''}" style="background:${c}" data-c="${c}" title="${c}"></button>`).join('');
  $('brandSwatches').querySelectorAll('.swatch').forEach(b => b.onclick = () => {
    $('brandAccentInput').value = b.dataset.c; $('brandAccentHex').textContent = b.dataset.c; renderBrandSwatches();
  });
}
function fillBrandingForm() {
  $('brandNameInput').value = branding.name || '';
  const accent = branding.accentColor || DEFAULT_ACCENT;
  $('brandAccentInput').value = accent; $('brandAccentHex').textContent = accent;
  renderBrandSwatches();
  const preview = $('brandLogoPreview');
  preview.innerHTML = branding.logo ? `<img src="${branding.logo}">` : '<span class="ph">No logo</span>';
  $('brandLogoRemoveBtn').hidden = !branding.logo;
}
$('brandAccentInput').oninput = () => { $('brandAccentHex').textContent = $('brandAccentInput').value; renderBrandSwatches(); };
$('brandLogoPickBtn').onclick = () => $('brandLogoFile').click();
$('brandLogoFile').onchange = () => {
  const file = $('brandLogoFile').files[0];
  $('brandLogoFile').value = '';
  if (!file) return;
  if (file.size > 1_500_000) { toast('That logo is too large — please use an image under 1.5MB'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    branding = { ...branding, logo: reader.result };
    fillBrandingForm();
    toast('Logo ready — click "Save branding" to keep it');
  };
  reader.onerror = () => toast('Could not read that image file');
  reader.readAsDataURL(file);
};
$('brandLogoRemoveBtn').onclick = () => { branding = { ...branding, logo: '' }; fillBrandingForm(); };
$('brandResetBtn').onclick = () => { $('brandAccentInput').value = DEFAULT_ACCENT; $('brandAccentHex').textContent = DEFAULT_ACCENT; renderBrandSwatches(); };
$('brandSaveBtn').onclick = async () => {
  const accentColor = $('brandAccentInput').value === DEFAULT_ACCENT ? '' : $('brandAccentInput').value;
  try {
    branding = await api('POST', '/api/branding', { name: $('brandNameInput').value, accentColor, logo: branding.logo || '' });
    applyBranding(); fillBrandingForm();
    toast('Branding saved');
  } catch (e) { toast(e.message || 'Could not save branding'); }
};
$('brandResetAllBtn').onclick = async () => {
  if (!await askConfirm('Reset branding back to default? This clears your business name, logo, and accent color — the app goes back to plain Craftium branding everywhere until you set it again.', 'Reset all branding')) return;
  try {
    branding = await api('POST', '/api/branding', { name: '', accentColor: '', logo: '' });
    applyBranding(); fillBrandingForm();
    toast('Branding reset to default');
  } catch (e) { toast(e.message || 'Could not reset branding'); }
};

// Every card directly under Settings gets a click-to-collapse header, independent of what's
// inside it — so a new card added later picks this up for free with no markup of its own.
// Collapsed state is per-browser (localStorage), keyed by the card's own title, not synced
// between devices or admins — purely a "leave it how I left it" convenience.
function initCollapsibleSettingsCards() {
  for (const card of document.querySelectorAll('#tab-settings > .card')) {
    const h2 = card.querySelector('h2');
    if (!h2) continue;
    const key = 'settingsCollapsed:' + h2.textContent.trim();
    h2.classList.add('collapsible-header');
    h2.insertAdjacentHTML('beforeend', '<span class="collapse-chevron">▾</span>');
    // Collapsed by default — only an explicit "0" (the admin expanded it themselves) opens
    // one up on load; anything else, including a browser that's never seen this card before,
    // stays collapsed.
    let collapsed = true;
    try { collapsed = localStorage.getItem(key) !== '0'; } catch {}
    card.classList.toggle('collapsed', collapsed);
    h2.onclick = () => {
      const now = card.classList.toggle('collapsed');
      try { localStorage.setItem(key, now ? '1' : '0'); } catch {}
    };
  }
}
initCollapsibleSettingsCards();

async function loadSettings() {
  appSettings = await api('GET', '/api/settings');
  $('trackAttributionChk').checked = appSettings.trackSaleAttribution;
  renderDefaultProcessorSelect();
}
$('trackAttributionChk').onchange = async () => {
  const checked = $('trackAttributionChk').checked;
  try { appSettings = await api('POST', '/api/settings', { trackSaleAttribution: checked }); toast(checked ? 'Now recording who rings up each sale' : 'No longer recording who rings up sales'); }
  catch (e) { $('trackAttributionChk').checked = !checked; toast(e.message || 'Could not update setting'); }
};

// ---------- Settings: users (admins + cashiers) ----------
async function loadUsers() { admins = await api('GET', '/api/auth/users'); renderUsers(); }
function renderUsers() {
  $('curAdminLine').textContent = `Signed in as ${me.name} (${me.username})`;
  const tb = $('adminRows'); tb.innerHTML = '';
  const adminCount = admins.filter(a => a.role === 'admin').length;
  const ROLE_ORDER = ['admin', 'manager', 'lead', 'cashier'];
  for (const a of admins) {
    const isLastAdmin = a.role === 'admin' && adminCount <= 1;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(a.name)}${a.id === me.id ? ' <small style="color:var(--muted)">(you)</small>' : ''}</td><td>${esc(a.username)}</td>
      <td><span class="role-badge ${a.role}"></span></td>
      <td>${new Date(a.createdAt).toLocaleDateString()}</td>
      <td class="acts">
        <div class="user-acts">
          <select class="roleSelect"${isLastAdmin ? ' disabled title="Can’t change the last admin’s role"' : ''}>
            ${ROLE_ORDER.map(r => `<option value="${r}"${r === a.role ? ' selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}
          </select>
          <button class="btn sm resetPw">Reset password</button>
          <button class="icon-btn del" title="Remove account"${isLastAdmin ? ' disabled title="Can’t remove the last admin"' : ''}>×</button>
        </div>
      </td>`;
    tr.querySelector('.role-badge').textContent = ROLE_LABEL[a.role] || a.role;
    tr.querySelector('.roleSelect').onchange = async (e) => {
      const newRole = e.target.value;
      try { await api('POST', `/api/auth/users/${a.id}/role`, { role: newRole }); toast(`${a.name} is now ${ROLE_LABEL[newRole]}`); await loadUsers(); }
      catch (err) { e.target.value = a.role; toast(err.message || 'Could not change role'); }
    };
    tr.querySelector('.resetPw').onclick = async () => {
      const pw = prompt(`New password for ${a.name} (min 8 characters):`);
      if (!pw) return;
      try { await api('POST', `/api/auth/users/${a.id}/password`, { password: pw }); toast('Password updated'); }
      catch (e) { toast(e.message || 'Could not update password'); }
    };
    tr.querySelector('.del').onclick = async () => {
      if (!await askConfirm(`Remove ${ROLE_LABEL[a.role]} account “${a.name}”?`, 'Remove account')) return;
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

// ---------- Settings: material sources ----------
function renderSourceRows() {
  const tb = $('sourceRows'); if (!tb) return;
  tb.innerHTML = '';
  for (const s of sources) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td></td><td class="acts"><button class="icon-btn del" title="Remove source">×</button></td>`;
    tr.querySelector('td').textContent = s.name;
    tr.querySelector('.del').onclick = async () => {
      if (!await askConfirm(`Remove “${s.name}” as a source? Materials tagged with it go back to untagged.`, 'Remove source')) return;
      try { await api('DELETE', '/api/sources/' + s.id); toast(`Removed “${s.name}”`); await loadMaterials(); }
      catch (e) { toast(e.message || 'Could not remove source'); }
    };
    tb.appendChild(tr);
  }
  $('sourcesEmpty').hidden = sources.length > 0;
}
$('newSourceAdd').onclick = async () => {
  const name = $('newSourceName').value.trim();
  if (!name) { $('newSourceName').focus(); toast('Give the source a name first'); return; }
  try {
    await api('POST', '/api/sources', { name });
    $('newSourceName').value = '';
    toast(`Added “${name}”`);
    await loadMaterials();
  } catch (e) { toast(e.message || 'Could not add source'); }
};

// ---------- Settings: tax rate presets ----------
// Also needed by the event form's "Fill tax rate from preset" button — loaded there too (see
// loadEventFormExtras), not just when Settings happens to have been visited, since a lead
// account can manage events but can't reach Settings at all.
let taxPresets = [];
function renderCardProcessorRows() {
  const tb = $('cardProcessorRows'); if (!tb) return;
  tb.innerHTML = '';
  for (const p of cardProcessors) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td></td><td class="num"></td><td class="num"></td><td><label class="lib-chk-wrap"><input type="checkbox" class="enabledChk"></label></td><td class="acts"><button class="icon-btn del" title="Remove processor">×</button></td>`;
    const [nameCell, pctCell, fixedCell] = tr.querySelectorAll('td');
    nameCell.textContent = p.name;
    pctCell.textContent = p.feePct + '%';
    fixedCell.textContent = money(p.feeFixed);
    const chk = tr.querySelector('.enabledChk');
    chk.checked = p.enabled;
    chk.onchange = async () => {
      const next = chk.checked;
      try { await api('POST', `/api/card-processors/${p.id}/enabled`, { enabled: next }); await loadCardProcessors(); }
      catch (e) { chk.checked = !next; toast(e.message || 'Could not update processor'); }
    };
    tr.querySelector('.del').onclick = async () => {
      if (!await askConfirm(`Remove “${p.name}” as a card processor? Past sales keep showing it; it just won't be offered for new ones.`, 'Remove processor')) return;
      try { await api('DELETE', '/api/card-processors/' + p.id); toast(`Removed “${p.name}”`); await loadCardProcessors(); }
      catch (e) { toast(e.message || 'Could not remove processor'); }
    };
    tb.appendChild(tr);
  }
  $('cardProcessorsEmpty').hidden = cardProcessors.length > 0;
}
function renderDefaultProcessorSelect() {
  const sel = $('defaultProcessorSelect'); if (!sel) return;
  const enabled = enabledCardProcessors();
  sel.innerHTML = '<option value="">None — starts on "Other / unlisted"</option>' +
    enabled.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  sel.value = enabled.some(p => p.id === appSettings.defaultCardProcessorId) ? appSettings.defaultCardProcessorId : '';
}
$('defaultProcessorSelect').onchange = async () => {
  const id = $('defaultProcessorSelect').value;
  try { appSettings = await api('POST', '/api/settings', { defaultCardProcessorId: id }); toast(id ? 'Default processor set' : 'Default processor cleared'); }
  catch (e) { toast(e.message || 'Could not update default processor'); renderDefaultProcessorSelect(); }
};
$('newProcessorAdd').onclick = async () => {
  const name = $('newProcessorName').value.trim();
  if (!name) { $('newProcessorName').focus(); toast('Give the processor a name first'); return; }
  try {
    await api('POST', '/api/card-processors', { name, feePct: $('newProcessorPct').value, feeFixed: $('newProcessorFixed').value });
    $('newProcessorName').value = ''; $('newProcessorPct').value = ''; $('newProcessorFixed').value = '';
    toast(`Added “${name}”`);
    await loadCardProcessors();
  } catch (e) { toast(e.message || 'Could not add processor'); }
};

async function loadTaxPresets() { taxPresets = await api('GET', '/api/tax-presets'); renderTaxPresetRows(); }
function renderTaxPresetRows() {
  const tb = $('taxPresetRows'); if (!tb) return;
  tb.innerHTML = '';
  for (const p of taxPresets) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td></td><td class="num"></td><td class="num"></td><td class="acts"><button class="icon-btn del" title="Remove preset">×</button></td>`;
    const [stateCell, salesCell, cashCell] = tr.querySelectorAll('td');
    stateCell.textContent = p.state;
    salesCell.textContent = p.salesTaxRate != null ? p.salesTaxRate + '%' : '—';
    cashCell.textContent = p.cashTaxRate != null ? p.cashTaxRate + '%' : 'same as sales';
    tr.querySelector('.del').onclick = async () => {
      if (!await askConfirm(`Remove the “${p.state}” tax preset?`, 'Remove preset')) return;
      try { await api('DELETE', '/api/tax-presets/' + p.id); toast(`Removed “${p.state}”`); await loadTaxPresets(); }
      catch (e) { toast(e.message || 'Could not remove preset'); }
    };
    tb.appendChild(tr);
  }
  $('taxPresetsEmpty').hidden = taxPresets.length > 0;
  $('taxPresetStateList').innerHTML = taxPresets.map(p => `<option value="${esc(p.state)}">`).join('');
}
$('newTaxPresetAdd').onclick = async () => {
  const state = $('newTaxPresetState').value.trim();
  if (!state) { $('newTaxPresetState').focus(); toast('Give the preset a state first'); return; }
  try {
    await api('POST', '/api/tax-presets', { state, salesTaxRate: $('newTaxPresetSales').value, cashTaxRate: $('newTaxPresetCash').value });
    $('newTaxPresetState').value = ''; $('newTaxPresetSales').value = ''; $('newTaxPresetCash').value = '';
    toast(`Added “${state}”`);
    await loadTaxPresets();
  } catch (e) { toast(e.message || 'Could not add preset'); }
};

// ---------- Settings: database maintenance ----------
$('purgeConfirmInput').addEventListener('input', () => {
  $('purgeAllBtn').disabled = $('purgeConfirmInput').value !== 'DELETE';
});
$('copyToTestBtn').onclick = async () => {
  if (!await askConfirm('Replace all test data with a fresh copy of your real items, materials, events, and sales?', 'Copy to test')) return;
  try {
    await api('POST', '/api/maintenance/copy-to-test');
    toast('Test data replaced with a copy of your main data');
    await Promise.all([loadMaterials(), loadItems(), loadEvents(), loadSales(), loadPosItems()]);
  } catch (e) { toast(e.message || 'Could not copy to test'); }
};
$('purgeAllBtn').onclick = async () => {
  if ($('purgeConfirmInput').value !== 'DELETE') return;
  if (!await askConfirm('This permanently deletes every item, material, sale, and event — real and test. This can’t be undone. Continue?', 'Purge everything')) return;
  try {
    await api('POST', '/api/maintenance/purge', { confirm: 'DELETE' });
    $('purgeConfirmInput').value = ''; $('purgeAllBtn').disabled = true;
    toast('All business data purged');
    await Promise.all([loadMaterials(), loadItems(), loadEvents(), loadSales(), loadPosItems()]);
  } catch (e) { toast(e.message || 'Could not purge data'); }
};

// ---------- Automatic server backups ----------
// Distinct from the manual export/import below: these are full-database snapshots the server
// takes on its own once a day and keeps on disk, for disaster recovery — not something you
// load back in through the UI.
function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(1) + ' GB';
}
async function loadServerBackups() {
  const { keep, backups } = await api('GET', '/api/maintenance/backups');
  $('backupKeepCount').textContent = keep;
  const tb = $('backupRows'); tb.innerHTML = '';
  for (const b of backups) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td></td><td>${formatBytes(b.size)}</td><td class="acts"><a class="btn sm" href="/api/maintenance/backups/${encodeURIComponent(b.file)}/download">Download</a><button class="btn sm danger restore-backup">Restore</button></td>`;
    tr.querySelector('td').textContent = new Date(b.createdAt).toLocaleString();
    tr.querySelector('.restore-backup').onclick = () => restoreBackup(b);
    tb.appendChild(tr);
  }
  $('backupsEmpty').hidden = backups.length > 0;
}
async function restoreBackup(b) {
  const when = new Date(b.createdAt).toLocaleString();
  if (!await askConfirm(`Replace ALL current data — items, materials, sales, settings, everything — with the backup from ${when}? A fresh backup of what's live right now is taken automatically first, so this isn't the only copy of today's data, but nothing saved after ${when} will be in the app once this finishes. The server restarts immediately after.`, 'Restore this backup')) return;
  const tb = $('backupRows'); tb.querySelectorAll('button, a').forEach((el) => el.disabled = true);
  try {
    await api('POST', `/api/maintenance/backups/${encodeURIComponent(b.file)}/restore`);
    toast('Restoring…');
    if (await waitForServerRestart()) { toast('Restored — reloading'); location.reload(); return; }
    toast('Restore applied, but the server hasn’t come back online yet — check on it directly.');
  } catch (e) {
    toast(e.message || 'Restore failed');
    await loadServerBackups();
  }
}
$('backupNowBtn').onclick = async () => {
  $('backupNowBtn').disabled = true;
  try { await api('POST', '/api/maintenance/backups'); toast('Backup created'); await Promise.all([loadServerBackups(), loadDiskUsage()]); }
  catch (e) { toast(e.message || 'Backup failed'); }
  finally { $('backupNowBtn').disabled = false; }
};

// ---------- Disk space ----------
async function loadDiskUsage() {
  try {
    const d = await api('GET', '/api/maintenance/disk');
    const pct = d.total > 0 ? Math.min(100, Math.round((d.used / d.total) * 100)) : 0;
    const fill = $('diskGaugeFill');
    fill.style.width = pct + '%';
    fill.className = 'disk-gauge-fill' + (pct >= 90 ? ' danger' : pct >= 70 ? ' warn' : '');
    $('diskStatusLine').textContent = `${formatBytes(d.used)} used of ${formatBytes(d.total)} (${pct}%) — ${formatBytes(d.free)} free`;
    $('diskBreakdownLine').textContent = `Craftium's own data: database ${formatBytes(d.dbBytes)}, backups ${formatBytes(d.backupBytes)}`;
  } catch (e) {
    $('diskStatusLine').textContent = 'Could not check disk space.';
    $('diskBreakdownLine').textContent = '';
  }
}
$('clearOldBackupsBtn').onclick = async () => {
  if (!await askConfirm('Delete all backups except the most recent one, to free up space? You can always make a fresh one afterward.', 'Clear old backups')) return;
  try {
    const r = await api('POST', '/api/maintenance/backups/clear-old');
    toast(r.removed > 0 ? `Freed ${formatBytes(r.freedBytes)} (removed ${r.removed} backup${r.removed === 1 ? '' : 's'})` : 'No old backups to clear');
    await Promise.all([loadServerBackups(), loadDiskUsage()]);
  } catch (e) { toast(e.message || 'Could not clear old backups'); }
};

// ---------- Software updates ----------
async function loadUpdateStatus() {
  $('updateCheckBtn').disabled = true;
  try {
    const s = await api('GET', '/api/update/check');
    if (!s.available && s.reason === 'not_a_git_checkout') {
      $('updateUnavailableHelp').hidden = false;
      $('updatePanel').hidden = true;
      return;
    }
    $('updateUnavailableHelp').hidden = true;
    $('updatePanel').hidden = false;
    if (s.available) {
      $('updateStatusLine').textContent = `Update available: v${s.currentVersion} → v${s.latestVersion} (${s.commitsBehind} commit${s.commitsBehind === 1 ? '' : 's'} behind).`;
      $('updateApplyBtn').hidden = false;
    } else {
      $('updateStatusLine').textContent = `Up to date (v${s.currentVersion}).`;
      $('updateApplyBtn').hidden = true;
    }
  } catch (e) {
    $('updateUnavailableHelp').hidden = true;
    $('updatePanel').hidden = false;
    $('updateStatusLine').textContent = 'Could not check for updates.';
    $('updateApplyBtn').hidden = true;
  } finally {
    $('updateCheckBtn').disabled = false;
  }
}
$('updateCheckBtn').onclick = () => loadUpdateStatus();

async function waitForServerRestart() {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try { if ((await fetch('/api/meta/version', { cache: 'no-store' })).ok) return true; } catch {}
  }
  return false;
}
$('updateApplyBtn').onclick = async () => {
  if (!await askConfirm('Pull the latest version and restart the server now? The app will be briefly unreachable while it restarts.', 'Update now')) return;
  $('updateApplyBtn').disabled = true; $('updateCheckBtn').disabled = true;
  $('updateStatusLine').textContent = 'Updating… this can take a minute.';
  try {
    await api('POST', '/api/update/apply');
    $('updateStatusLine').textContent = 'Restarting…';
    if (await waitForServerRestart()) { toast('Updated — reloading'); location.reload(); return; }
    toast('Update applied, but the server hasn’t come back online yet — check on it directly.');
  } catch (e) {
    toast(e.message || 'Update failed');
    $('updateStatusLine').textContent = 'Update failed.';
  }
  $('updateApplyBtn').disabled = false; $('updateCheckBtn').disabled = false;
};

// ---------- License (groundwork — see server/lib/license.js) ----------
function renderLicenseStatus(s) {
  $('licenseKeyInput').value = s.key || '';
  $('licenseCheckBtn').hidden = !s.configured;
  $('licenseClearBtn').hidden = !s.configured;
  const when = s.checkedAt ? new Date(s.checkedAt).toLocaleString() : null;
  const lines = {
    unlicensed: 'No license key set — running unrestricted.',
    unchecked: 'License key saved — checking…',
    invalid_key: 'This license key wasn’t recognized by the license server.',
    suspended: 'This license is suspended.',
    revoked: 'This license has been revoked.',
  };
  let line = lines[s.status] || `Active${s.tier ? ` (${s.tier})` : ''}${s.licensedTo ? ` — licensed to ${s.licensedTo}` : ''}.${when ? ` Last checked ${when}.` : ''}`;
  if (s.degraded) line += ' Hasn’t checked in successfully for over 30 days — treating as unlicensed until it can reach the license server again.';
  $('licenseStatusLine').textContent = line;
  const hasDetail = s.configured && (Object.keys(s.featureFlags || {}).length || Object.keys(s.usageCaps || {}).length);
  $('licenseDetailLine').hidden = !hasDetail;
  if (hasDetail) $('licenseDetailLine').textContent = `Features: ${JSON.stringify(s.featureFlags)}  ·  Usage caps: ${JSON.stringify(s.usageCaps)}`;
}
async function loadLicenseStatus() {
  try { renderLicenseStatus(await api('GET', '/api/license')); }
  catch (e) { $('licenseStatusLine').textContent = 'Could not load license status.'; }
}
$('licenseActivateBtn').onclick = async () => {
  const key = $('licenseKeyInput').value.trim();
  if (!key) { toast('Enter a license key first'); return; }
  $('licenseActivateBtn').disabled = true;
  try { renderLicenseStatus(await api('POST', '/api/license', { key })); toast('License activated'); }
  catch (e) { toast(e.message || 'Could not activate that license'); }
  $('licenseActivateBtn').disabled = false;
};
$('licenseCheckBtn').onclick = async () => {
  $('licenseCheckBtn').disabled = true;
  try { renderLicenseStatus(await api('POST', '/api/license/check')); toast('License re-checked'); }
  catch (e) { toast(e.message || 'Could not check license'); }
  $('licenseCheckBtn').disabled = false;
};
$('licenseClearBtn').onclick = async () => {
  if (!await askConfirm('Remove this license key? This install goes back to running unrestricted.', 'Remove license')) return;
  try { renderLicenseStatus(await api('DELETE', '/api/license')); toast('License removed'); }
  catch (e) { toast(e.message || 'Could not remove license'); }
};

// ---------- Backup ----------
$('exportBtn').onclick = async () => {
  const [allItems, allMats, allSales, allEvents, allSources] = await Promise.all([api('GET', '/api/items/full'), api('GET', '/api/materials'), api('GET', '/api/sales/full'), api('GET', '/api/events'), api('GET', '/api/sources')]);
  const data = { app: 'craftium', version: 1, exportedAt: new Date().toISOString(), sources: allSources, materials: allMats, items: allItems, sales: allSales, events: allEvents };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `craftium-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Exported ${allItems.length} items and ${allMats.length} materials`);
};
$('importBtn').onclick = () => $('importFile').click();
$('importFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  let d;
  try { d = JSON.parse(await f.text()); if (!Array.isArray(d.items) || !Array.isArray(d.materials)) throw new Error(); }
  catch { toast('That file isn’t a Craftium backup'); return; }
  if (!await askConfirm(`Import ${d.items.length} items and ${d.materials.length} materials? Existing items/materials with matching ids will be overwritten.`, 'Import backup')) return;
  for (const s of (d.sources || [])) await api('POST', '/api/sources', s); // before materials — they may reference these by id
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
  addMaterial(); setItemType('made'); setMode('markup'); setTender('cash'); setTestMode(testMode);
  $('footYear').textContent = new Date().getFullYear();
  loadVersionInfo().catch(() => {});
  await loadBranding();
  try {
    const s = await refreshAuthStatus();
    $('app').hidden = false;
    if (s.needsSetup || !s.me) { openLogin('pos'); return; }
    if (s.me.mustChangePassword) { showForceChangeScreen(); return; }
    closeLogin();
    await afterLogin();
    showTab('pos');
  } catch (e) {
    $('app').hidden = false;
    // Opening the app with no connection at all (not just losing it mid-session) — fall back
    // to the last account/data this device saw while it was last online, so the Sell page can
    // still ring up sales. There's no way to verify the session is still valid without a
    // connection; this trusts the browser's session cookie is probably still good, same as
    // any offline-first app has to.
    if (isNetworkError(e)) {
      const cachedMe = await Offline.getSnapshot('me');
      if (cachedMe) {
        me = cachedMe; needsSetup = false;
        setOnlineStatus(false);
        updateAuthUI();
        closeLogin();
        await afterLogin();
        showTab('pos');
        toast('Offline — showing the last data saved on this device');
        return;
      }
    }
    toast('Could not reach the server. Check that it’s running.');
  }
})();
