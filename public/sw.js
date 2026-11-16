// СПБГУКА Service Worker — enables Android WebAPK, iPhone & Desktop App installation
self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

// Network-only pass-through so video streams, live sync, and catalog updates are never stale
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request));
});
