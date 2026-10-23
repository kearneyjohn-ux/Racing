// Offline support: the app shell is cached so it opens at a track with no signal, and map
// tiles you have already viewed (e.g. at home on Wi-Fi) are kept for later.

const VERSION = 'rcp-v10';
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/analysis.js',
  'js/formats.js',
  'manifest.webmanifest',
  'icon.svg',
  'assets/westlime-logo-wide.svg',
  'samples/demo-course.gpx',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
];
const TILE_HOSTS = ['server.arcgisonline.com', 'tile.openstreetmap.org'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'rcp-tiles').map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (TILE_HOSTS.includes(url.hostname)) {
    // Tiles: cache first, then network.
    event.respondWith(
      caches.open('rcp-tiles').then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  // App files: network first so updates arrive, falling back to the cache when offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && (url.origin === location.origin || url.hostname === 'cdnjs.cloudflare.com')) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })),
  );
});
