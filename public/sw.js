
const CACHE = 'ig-app-v5';
const ASSETS = [
  '/app','/app/','/app/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png','/icons/icon-512.png'
];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.url.includes('/api/')) return;
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(resp => {
      const copy = resp.clone();
      caches.open(CACHE).then(c=>c.put(req, copy)).catch(()=>{});
      return resp;
    }).catch(()=>cached))
  );
});
