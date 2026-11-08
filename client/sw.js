// Precache-everything service worker. The version and asset list placeholders below are filled in at build time.
const V = "__VERSION__";
const ASSETS = __ASSETS__;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/dict/")) return;
  // app shell + hashed assets: cache first, network fallback
  e.respondWith(
    caches.match(req.mode === "navigate" ? "/" : req, { ignoreSearch: true, ignoreVary: true }).then((r) => r || fetch(req)),
  );
});
