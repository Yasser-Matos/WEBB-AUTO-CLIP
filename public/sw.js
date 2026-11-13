// =====================================================================
// SERVICE WORKER - hace que la web se pueda instalar como app en el celular.
// Guarda solo los archivos de la pantalla (nunca videos ni datos de la cuenta).
// Siempre intenta primero internet, así los cambios que hagas se ven al instante.
// =====================================================================
const CACHE = 'videoclips-v1';
const BASICOS = ['/', '/estilos.css', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(BASICOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(claves => Promise.all(claves.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Lo de la cuenta, los clips y los pagos NUNCA se guarda: va siempre directo al servidor
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then(r => {
        if (r.ok) { const copia = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copia)); }
        return r;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('/')))
  );
});
