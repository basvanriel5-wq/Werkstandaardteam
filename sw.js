const CACHE = 'werkstandaard-team-shell-v3';
const FILES = ['./','./index.html','./style.css','./app.js','./manifest.webmanifest','./icon-192.png','./icon-180.png','./icon-512.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== self.location.origin) return;
  // Network first: voorkomt dat een oude app-versie blijft hangen na een update.
  e.respondWith(fetch(e.request).then(r => {if (r.ok) {const clone=r.clone();caches.open(CACHE).then(c=>c.put(e.request,clone));}return r;}).catch(()=>caches.match(e.request)));
});
