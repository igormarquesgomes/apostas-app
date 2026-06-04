// OddLab Service Worker — sem cache, sempre busca versão mais recente
const VERSION = 'v' + new Date().toISOString().substring(0, 10);

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(key => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Backend (Render) — nunca cachear
  if (url.hostname.includes('onrender.com')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // HTML e JS — sempre buscar versão mais recente
  if (e.request.url.includes('publico.html') ||
      e.request.url.includes('oddlab-sw.js') ||
      e.request.url.includes('oddlab-manifest.json')) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Resto — network first
  e.respondWith(
    fetch(e.request, { cache: 'no-store' }).catch(() => caches.match(e.request))
  );
});
