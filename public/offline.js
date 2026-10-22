// IndexedDB-backed storage for the Sell page's offline mode: a cached snapshot of sellable
// items (so there's something to ring up against with no connection) and a queue of sales
// completed while offline, held here until they can be synced to the server. Deliberately
// scoped to just this — Calculator, Materials, Items, Reports, and Settings all still need a
// live connection, same as before.
//
// A plain global (not an ES module) like the rest of this app's client scripts — loaded via a
// normal <script> tag before app.js.
const Offline = (() => {
  const DB_NAME = 'craftium-offline';
  const DB_VERSION = 1;
  const STORE_SNAPSHOTS = 'snapshots'; // keyPath: 'key' — cached POS items / open event, per test-mode side
  const STORE_QUEUE = 'pendingSales'; // keyPath: 'clientSaleId'

  let dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('indexeddb_unavailable')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) db.createObjectStore(STORE_SNAPSHOTS, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(STORE_QUEUE)) db.createObjectStore(STORE_QUEUE, { keyPath: 'clientSaleId' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  async function put(storeName, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, 'readwrite');
      t.objectStore(storeName).put(value);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }
  async function get(storeName, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, 'readonly');
      const req = t.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function getAll(storeName) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, 'readonly');
      const req = t.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }
  async function del(storeName, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, 'readwrite');
      t.objectStore(storeName).delete(key);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  // Every call here is wrapped so a browser without usable IndexedDB (private-mode quirks,
  // storage disabled) degrades to "offline mode just doesn't work" instead of throwing errors
  // up into the rest of the app.
  const safe = (fn, fallback) => (...args) => fn(...args).catch(() => fallback);

  return {
    saveSnapshot: safe((key, data) => put(STORE_SNAPSHOTS, { key, data, savedAt: Date.now() }), undefined),
    getSnapshot: safe(async (key) => (await get(STORE_SNAPSHOTS, key))?.data ?? null, null),
    queueSale: safe((sale) => put(STORE_QUEUE, sale), undefined),
    getQueuedSales: safe(() => getAll(STORE_QUEUE), []),
    removeQueuedSale: safe((clientSaleId) => del(STORE_QUEUE, clientSaleId), undefined),
  };
})();
