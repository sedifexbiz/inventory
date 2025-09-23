const CACHE = 'sedifex-static-v1'
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll([
    '/', '/index.html', '/manifest.webmanifest'
  ])))
})
self.addEventListener('activate', (e) => self.clients.claim())
self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(resp => {
      const copy = resp.clone()
      caches.open(CACHE).then(c => c.put(req, copy))
      return resp
    }).catch(() => cached))
  )
})
