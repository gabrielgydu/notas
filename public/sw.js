/* Notas — service worker.
   App shell precached so the app opens offline; /api responses are kept in a
   runtime cache so anything read while online stays readable offline.
   Everything is network-first: on the tailnet the server is the source of
   truth, the cache only steps in when it's unreachable. */

const VERSION = 'v14';
const SHELL_CACHE = `notas-shell-${VERSION}`;
const DATA_CACHE = `notas-data-${VERSION}`;

const SHELL = [
  '/',
  '/styles.css',
  '/annotations.js',
  '/app.js',
  '/dictation.js',
  '/annotate.js',
  '/pcm-worklet.js',
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

/* Everything readable is worth keeping offline; a PDF is not. One 300 MB scan
 * would eat the whole origin quota and evict every note in it — and the viewer
 * asks for it in Range slices anyway, which cache.put rejects outright (206). */
const MAX_CACHE_BYTES = 4 * 1024 * 1024;

function cacheable(res) {
  if (res.status !== 200) return false; // 206 in particular: cache.put throws on it
  if ((res.headers.get('Content-Type') || '').startsWith('application/pdf')) return false;
  return Number(res.headers.get('Content-Length') || 0) <= MAX_CACHE_BYTES;
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (cacheable(res)) cache.put(req, res.clone());
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

  // mtime polling stays network-only — a cached answer would defeat autoreload.
  // (Dictation's WebSocket never comes through here.)
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
