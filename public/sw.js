// Minimal service worker: PWA installability. Network-first (feed must be fresh).
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
self.addEventListener('fetch', e => {}); // pass-through
