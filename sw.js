const CACHE_NAME = "bimbo-inventory-pro-v3";
const LOCAL_ASSETS = ["./","./index.html","./styles.css","./app.js","./products.json","./manifest.json","./icon.svg","./default-product.svg"];
self.addEventListener("install", event => { event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(LOCAL_ASSETS))); self.skipWaiting(); });
self.addEventListener("activate", event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.map(key => key !== CACHE_NAME ? caches.delete(key) : null)))); self.clients.claim(); });
self.addEventListener("fetch", event => { event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request))); });
