// Offline support for the installed app. Bump VERSION whenever any cached file changes.
const VERSION = "pacemark-v1.2.0";
const SHELL = ["./", "index.html", "styles.css", "app.js", "layout.js", "manifest.webmanifest"];
const STATIC = [
  "icons/icon-192.png",
  "icons/icon-512.png",
  "vendor/pdf.min.js",
  "vendor/pdf.worker.min.js",
  "vendor/mammoth.browser.min.js"
];

self.addEventListener("install", event => {
  // cache: "reload" skips the browser's HTTP cache, which would otherwise hand back the previous
  // version's files for up to ten minutes and freeze the app on them.
  event.waitUntil(
    caches.open(VERSION)
      .then(cache => Promise.all([...SHELL, ...STATIC].map(url =>
        fetch(new Request(url, { cache: "reload" })).then(res => {
          if (!res.ok) throw new Error(`${url}: ${res.status}`);
          return cache.put(url, res);
        }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(request, { cache: "no-cache" });
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    return (await cache.match(request, { ignoreSearch: true })) ||
      (request.mode === "navigate" && await cache.match("index.html")) ||
      Response.error();
  }
}

async function cacheFirst(request) {
  const hit = await caches.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok || res.type === "opaque") {
    const cache = await caches.open(VERSION);
    cache.put(request, res.clone());
  }
  return res;
}

// The app's own code is fetched fresh whenever there is a connection, so updates show up on the
// next launch; the cache is the offline fallback. Large libraries, icons and fonts never change
// for a given version, so they are served from the cache.
self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    const isStatic = url.pathname.includes("/vendor/") || url.pathname.includes("/icons/");
    event.respondWith(isStatic ? cacheFirst(request) : networkFirst(request));
  } else if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(cacheFirst(request));
  }
});
