// Almacenamiento local en el iPhone (IndexedDB). Nada de esto sale del teléfono.

const DB_NAME = "al1";
const DB_VERSION = 1;
const STORES = ["trips", "expenses", "blobs", "settings", "rates"];

let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("trips")) db.createObjectStore("trips", { keyPath: "id" });
        if (!db.objectStoreNames.contains("expenses")) {
          const s = db.createObjectStore("expenses", { keyPath: "id" });
          s.createIndex("tripId", "tripId");
        }
        if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs", { keyPath: "id" });
        if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
        if (!db.objectStoreNames.contains("rates")) db.createObjectStore("rates", { keyPath: "date" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r) r.onsuccess = () => (result = r.result);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const db = {
  get: (store, key) => tx(store, "readonly", (s) => s.get(key)),
  all: (store) => tx(store, "readonly", (s) => s.getAll()),
  put: (store, value) => tx(store, "readwrite", (s) => s.put(value)),
  del: (store, key) => tx(store, "readwrite", (s) => s.delete(key)),
  byIndex: (store, index, value) => tx(store, "readonly", (s) => s.index(index).getAll(value)),
};

export async function getSetting(key, fallback = null) {
  const row = await db.get("settings", key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  return db.put("settings", { key, value });
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Pide al navegador que no borre los datos de la app cuando falte espacio.
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch {}
  return false;
}

export { STORES };
