/* Notas — service worker.
   App shell precached so the app opens offline; /api responses are kept in a
   runtime cache so anything read while online stays readable offline.
   Everything is network-first: on the tailnet the server is the source of
   truth, the cache only steps in when it's unreachable. */

const VERSION = 'v4';
const SHELL_CACHE = `notas-shell-${VERSION}`;
const DATA_CACHE = `notas-data-${VERSION}`;

const SHELL = [
  '/',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/vendor/marked.min.js',
  '/vendor/highlight.min.js',
  '/vendor/fonts/literata-400.woff2',
  '/vendor/fonts/literata-400i.woff2',
  '/vendor/fonts/literata-700.woff2',
  '/vendor/fonts/fraunces-600.woff2',
  '/vendor/fonts/fraunces-600i.woff2',
  '/vendor/fonts/plexmono-400.woff2',
  '/vendor/fonts/plexmono-500.woff2',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // e.g. mermaid CDN

  // mtime polling stays network-only — a cached answer would defeat autoreload
  if (url.pathname === '/api/stat') return;

  if (url.pathname.startsWith('/api/')) {
    e.respondWith(networkFirst(req, DATA_CACHE));
    return;
  }

  // all navigations land on the SPA shell (routes live in the hash)
  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(new Request('/'), SHELL_CACHE));
    return;
  }

  e.respondWith(networkFirst(req, SHELL_CACHE));
});
