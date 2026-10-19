// Best-effort price extraction from a saved product page — used by the Materials tab's
// "Check price" button. There's no price API for personal/small-business use on Temu,
// Amazon, or Home Depot, so this just fetches the page's HTML (no JS rendering) and looks
// for a price in the structured data most e-commerce sites embed for search engines. That
// means it can fail outright on pages that only render their price client-side, or that
// actively block non-browser requests — this is expected, which is why the result is always
// shown to the admin to accept or ignore, never applied automatically.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function findLdPrice(node) {
  if (Array.isArray(node)) {
    for (const n of node) { const p = findLdPrice(n); if (p != null) return p; }
    return null;
  }
  if (node && typeof node === 'object') {
    if (node.offers) { const p = findLdPrice(node.offers); if (p != null) return p; }
    if (node['@graph']) { const p = findLdPrice(node['@graph']); if (p != null) return p; }
    if (node.price != null) { const n = Number(node.price); if (isFinite(n) && n > 0) return n; }
    if (node.priceSpecification) { const p = findLdPrice(node.priceSpecification); if (p != null) return p; }
  }
  return null;
}

// Tries JSON-LD product/offer schema first (most reliable when a site includes it for SEO),
// then falls back to a few common meta tags. Returns a number, or null if nothing was found.
function extractPrice(html) {
  const ldMatches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of ldMatches) {
    try {
      const price = findLdPrice(JSON.parse(m[1].trim()));
      if (price != null) return price;
    } catch { /* not valid JSON — skip */ }
  }
  const metaPatterns = [
    /<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([\d.]+)["']/i,
    /<meta[^>]+property=["']og:price:amount["'][^>]+content=["']([\d.]+)["']/i,
    /<meta[^>]+itemprop=["']price["'][^>]+content=["']([\d.]+)["']/i,
  ];
  for (const re of metaPatterns) {
    const m = html.match(re);
    if (m) { const n = Number(m[1]); if (isFinite(n) && n > 0) return n; }
  }
  return null;
}

// Fetches `url` and extracts a price, or throws an Error with a `.code` the client can show
// a specific message for. 10s timeout — a hung request shouldn't hang the request handler.
async function checkPrice(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
  } catch (err) {
    const e = new Error(err.name === 'AbortError' ? 'timed_out' : 'fetch_error');
    e.code = err.name === 'AbortError' ? 'timed_out' : 'fetch_error';
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const e = new Error('fetch_failed');
    e.code = 'fetch_failed';
    e.status = response.status;
    throw e;
  }
  const html = await response.text();
  const price = extractPrice(html);
  if (price == null) {
    const e = new Error('price_not_found');
    e.code = 'price_not_found';
    throw e;
  }
  return price;
}

module.exports = { checkPrice, extractPrice };
