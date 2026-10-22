// Caches just enough of the static app shell (HTML/JS/CSS/icons) to let the installed PWA
// open at all with no connection. It deliberately has nothing to do with the Sell page's
// actual offline behavior — API calls, the sales queue, and sync all live in app.js/offline.js,
// which this never touches (see the /api/ exclusion below).
const CACHE_NAME = 'craftium-shell-v1';
const SHELL_PATHS = ['/', '/app.js', '/offline.js', '/styles.css', '/manifest.json', '/favicon.png', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_PATHS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
  );
  self.clients.claim();
});

// Network-first: an online visit always gets the freshest files (so an update applied via
// Settings → Software updates takes effect on the very next load, no cache-busting needed),
// updating the cache as a side effect. Only falls back to whatever was last cached when the
// network request itself fails outright — i.e. actually offline.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // Google Fonts etc. — leave to the browser as normal
  if (url.pathname.startsWith('/api/')) return; // app.js owns offline behavior for these

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || (event.request.mode === 'navigate' ? caches.match('/') : undefined)))
  );
});
