// Service worker: membuat aplikasi tetap bisa dibuka tanpa internet,
// dan menerima gambar dari menu "Bagikan" Android.
// Naikkan angka versi setiap kali Anda meng-update file aplikasi.
const CACHE = 'keuanganku-v9';
const FILES = ['./', './index.html', './style.css', './app.js', './manifest.json', './icon-192.png', './icon-512.png', './icons.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== 'kk-share').map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Bagikan → Keuanganku: simpan gambar sementara, lalu buka aplikasi
  if (e.request.method === 'POST' && url.origin === self.location.origin && url.pathname.endsWith('/share')) {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const files = form.getAll('image');
      const c = await caches.open('kk-share');
      for (const k of await c.keys()) await c.delete(k);
      await Promise.all(files.map((f, i) => c.put(`./shared-${Date.now()}-${i}`, new Response(f, { headers: { 'content-type': f.type || 'image/jpeg' } }))));
      return Response.redirect(new URL('./?share=1', self.registration.scope).href, 303);
    })());
    return;
  }

  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Coba ambil versi terbaru dari internet; kalau offline, pakai cache.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
