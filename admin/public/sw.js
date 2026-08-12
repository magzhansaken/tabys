// Service worker мобильного кабинета (часть 28).
// Кэшируем оболочку, чтобы приложение открывалось мгновенно и показывало
// последние данные даже при плохой связи. Данные всегда тянем свежие по сети,
// но при офлайне отдаём кэш — владелец видит хотя бы последнее.
const CACHE = 'shop-m-v1';
const SHELL = ['/m', '/manifest.webmanifest', '/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API — сеть в приоритете (данные должны быть свежими), кэш как запасной
  if (url.pathname.startsWith('/api') || url.hostname !== location.hostname) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  // оболочка — кэш в приоритете (мгновенный старт)
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
