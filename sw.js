/* Service Worker · Mapa de Nicaragua
   Cachea el shell de la app para uso offline.
   Los datos del usuario ya viven en localStorage.
   Los tiles del mapa requieren internet (se intentan en red).
*/

const CACHE = 'mapa-ni-v4-miembros';
const PRECACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './data/lugares.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  // Leaflet (CDN) — se cachean en la primera visita
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Solo manejar GET
  if (event.request.method !== 'GET') return;

  // Tiles de mapas: intentar red, si falla no romper (Leaflet ya maneja errores)
  if (
    url.hostname.includes('tile.openstreetmap.org') ||
    url.hostname.includes('arcgisonline.com') ||
    url.hostname.includes('opentopomap.org') ||
    url.hostname.includes('tile.opentopomap.org')
  ) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // Fuentes de Google: red primero
  if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // App shell y datos: cache-first, luego red y actualizar cache
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          if (res && res.ok && (url.origin === self.location.origin || PRECACHE.some((p) => event.request.url.includes(p.replace('./', ''))))) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(event.request, clone));
          }
          return res;
        })
        .catch(() => cached);

      return cached || network;
    })
  );
});
