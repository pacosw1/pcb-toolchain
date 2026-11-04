// Minimal service worker: makes the viewer installable and keeps the app shell for a quick start.
// Board data always comes from the network (it changes); only same-origin static assets are cached.
const SHELL = 'pcbstudio-shell-v1'

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['./', './index.html', './manifest.webmanifest'])))
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k)))))
  self.clients.claim()
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/files') || url.pathname.startsWith('/rpc')) return
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok && url.pathname.includes('/assets/')) caches.open(SHELL).then((c) => c.put(e.request, r.clone()))
        return r
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  )
})
