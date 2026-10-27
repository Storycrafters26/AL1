// Guarda la app en el teléfono para que abra sin internet. Las tasas y Claude sí necesitan conexión.

const VERSION = "al1-v3";
const SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/app.css",
  "css/print.css",
  "js/app.js",
  "js/db.js",
  "js/claude.js",
  "js/rates.js",
  "js/xlsx.js",
  "js/print.js",
  "js/files.js",
  "vendor/anthropic-sdk-0.133.0.mjs",
  "vendor/jszip-3.10.1.min.js",
  "vendor/html2canvas-1.4.1.min.js",
  "vendor/jspdf-4.2.1.umd.min.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Primero la red (para recibir actualizaciones), y si no hay conexión, la copia guardada.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request).then((r) => r || caches.match("index.html")))
  );
});
