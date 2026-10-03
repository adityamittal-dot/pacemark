// Offline cache for the installed app. Bump VERSION whenever any cached file changes.
const VERSION = "pacemark-v1.1.0";
const ASSETS = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "layout.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "vendor/pdf.min.js",
  "vendor/pdf.worker.min.js",
  "vendor/mammoth.browser.min.js"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache first for our own files; fonts are cached as they are fetched.
self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  const isOwn = url.origin === self.location.origin;
  const isFont = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (!isOwn && !isFont) return;
  event.respondWith(
    caches.match(request, { ignoreSearch: isOwn }).then(hit => hit || fetch(request).then(res => {
      if (res.ok || res.type === "opaque") {
        const copy = res.clone();
        caches.open(VERSION).then(cache => cache.put(request, copy));
      }
      return res;
    }))
  );
});
