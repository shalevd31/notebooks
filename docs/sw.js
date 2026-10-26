// Offline cache for the phone app. When you change anything in docs/, bump CACHE_VERSION.
const CACHE_VERSION = 'v4';
const CACHE = 'notebooks-' + CACHE_VERSION;
const FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'vendor/nb-ai.js',
  'fonts/fonts.css',
  'fonts/01172959a13d.woff2',
  'fonts/0ae40db16a01.woff2',
  'fonts/20c4b0858cb3.woff2',
  'fonts/22b79059b2e8.woff2',
  'fonts/2b068233af53.woff2',
  'fonts/366f4809eb39.woff2',
  'fonts/3d07152602d7.woff2',
  'fonts/576693248da5.woff2',
  'fonts/57b247f405b9.woff2',
  'fonts/6bfa8e890cb8.woff2',
  'fonts/767ea266a692.woff2',
  'fonts/7da448055237.woff2',
  'fonts/80d6d3a8797c.woff2',
  'fonts/9658d0effd10.woff2',
  'fonts/a4c1cb8859d9.woff2',
  'fonts/a9f69abe86b0.woff2',
  'fonts/ac63eab9c18c.woff2',
  'fonts/be43d988ceeb.woff2',
  'fonts/caf915bbd7b9.woff2',
  'fonts/e2af2263e01a.woff2',
  'fonts/ede495d1577b.woff2',
  'fonts/f01c3907dbfa.woff2',
  'fonts/f6e1a288679c.woff2',
  'fonts/f94f901f80ad.woff2',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('notebooks-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // pages: try the network first so new notes show up, fall back to the saved copy when offline
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req)
      .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put('index.html', copy)); return res; })
      .catch(() => caches.match('index.html')));
    return;
  }
  // fonts, icons: saved copy first
  e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
});
