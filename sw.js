// Network-first service worker: the app always tries the network, and
// falls back to the last cached copy when offline. Bump VERSION on deploy
// to drop stale caches.
const VERSION = 'ribak-crm-v1';
const SHELL = [
  './', './index.html', './css/app.css', './manifest.webmanifest', './icons/icon.svg',
  './js/app.js', './js/model.js', './js/util.js', './js/store.js', './js/analytics.js', './js/sample.js',
  './js/charts.js', './js/ui.js', './js/lead.js', './js/views/dashboard.js', './js/views/pipeline.js', './js/views/leads.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // fonts etc. go straight to the network
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(VERSION).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
