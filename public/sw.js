'use strict';

// Service worker minimal : il rend l'application installable sur l'écran d'accueil.
// Seules les pages de navigation sont interceptées : Socket.IO et les données ne passent jamais par le cache.
const CACHE = 'plateau-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET' || request.mode !== 'navigate') return;

    event.respondWith(
        fetch(request)
            .then((response) => {
                const copy = response.clone();
                caches.open(CACHE).then((cache) => cache.put('/', copy));
                return response;
            })
            .catch(() => caches.match('/'))
    );
});
