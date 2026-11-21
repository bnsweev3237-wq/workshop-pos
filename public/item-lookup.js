(function () {
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function money(n) {
    return '$' + (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // The item number is the last path segment (/i/<itemNo>) — see server/index.js's GET
  // /i/:itemNo, which serves this page, and server/routes/items.js's GET /lookup/:itemNo,
  // which this script calls. No auth, no tenant subdomain awareness needed here: whichever
  // host this page loads on, the API call below naturally resolves to that same tenant.
  const itemNo = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
  const card = document.getElementById('lookupCard');

  async function load() {
    if (!itemNo) {
      card.innerHTML = '<p class="lookup-error">No item number given.</p>';
      return;
    }
    let res;
    try {
      res = await fetch(`/api/items/lookup/${encodeURIComponent(itemNo)}`);
    } catch {
      card.innerHTML = '<p class="lookup-error">Could not reach the shop right now. Try again in a moment.</p>';
      return;
    }
    if (res.status === 404) {
      card.innerHTML = '<p class="lookup-empty">That item couldn’t be found — it may have been removed from the catalog.</p>';
      return;
    }
    if (!res.ok) {
      card.innerHTML = '<p class="lookup-error">Something went wrong looking that up. Try again in a moment.</p>';
      return;
    }
    const it = await res.json();
    card.innerHTML = `
      ${it.photo ? `<img class="lookup-photo" src="${esc(it.photo)}" alt="">` : ''}
      <div class="lookup-name">${esc(it.name || 'Item')}</div>
      <div class="lookup-price">${money(it.price)}</div>
    `;
  }
  load();
})();
