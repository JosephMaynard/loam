const CACHE_NAME = "loam-poc-v2";
const SHELL_ASSETS = ["/", "/channels", "/manifest.webmanifest", "/loam.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.pathname.startsWith("/api") || url.pathname.startsWith("/ws")) {
    return;
  }

  const isNavigation = request.mode === "navigate" || request.destination === "document";

  if (isNavigation) {
    // Network-first for navigations: always try the live app shell so a deploy is picked up rather
    // than masked by a stale cached index.html; fall back to the cached shell (then /channels) only
    // when the network is unreachable — the offline-PWA guarantee (docs/15 #12).
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
          }

          return response;
        })
        .catch(() =>
          caches
            .match(request)
            .then((cached) => cached || caches.match("/channels"))
            // Guarantee respondWith always receives a Response: offline with neither the request nor
            // the /channels shell cached would otherwise resolve to undefined.
            .then((cached) => cached || Response.error()),
        ),
    );
    return;
  }

  // Cache-first for everything else: hashed build assets are immutable, so the cache is authoritative
  // and avoids a network round-trip; a miss falls through to the network and populates the cache.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        return cached;
      }

      return fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
          }

          return response;
        })
        .catch(() => Response.error());
    }),
  );
});
