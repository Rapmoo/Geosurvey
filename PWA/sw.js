
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAMWfkAfulgOHVpp4Ek913jXs3oAmQQhys",
  authDomain: "geosurvey-update.firebaseapp.com",
  projectId: "geosurvey-update",
  storageBucket: "geosurvey-update.firebasestorage.app",
  messagingSenderId: "329449390220",
  appId: "1:329449390220:web:b8c1f77e4940016054fba9",
});

const messaging = firebase.messaging.isSupported() ? firebase.messaging() : null;

if (messaging) {
  messaging.onBackgroundMessage((payload) => {
    const data = payload.data || {};
    const title = (payload.notification && payload.notification.title) || data.title || 'GeoSurvey';
    const body  = (payload.notification && payload.notification.body)  || data.comment || '';
    self.registration.showNotification(title, {
      body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: data.notificationId || undefined,
      data, // carried through to notificationclick below
    });
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const targetUrl = './index.html' + (data.formId ? `?openForm=${data.formId}` : data.submissionId ? `?openSubmission=${data.submissionId}` : '');
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      const existing = clientsArr.find((c) => c.url.includes('index.html'));
      if (existing) {
        existing.postMessage({ type: 'NOTIFICATION_CLICK', data });
        return existing.focus();
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});

const VERSION = 'v4'; 
const SHELL_CACHE   = `geosurvey-shell-${VERSION}`;
const RUNTIME_CACHE  = `geosurvey-runtime-${VERSION}`;
const TILE_CACHE      = `geosurvey-tiles-${VERSION}`;
const TILE_CACHE_MAX  = 200; // capped so offline map tiles don't grow forever

const SHELL_URLS = [
  './',
  './index.html',
  './css/styles.css',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/favicon-16.png',
];


const CRITICAL_APP_SCRIPTS = [
  './js/app.js',
  './js/auth/firebaseAuth.js',
  './js/auth/session.js',
  './js/auth/logout.js',
  './js/auth/fileStorageClient.js',
  './js/auth/uploadQueue.js',
];

// Third-party origins we're happy to cache-first (they're either
// versioned-immutable URLs or safe to serve slightly stale).
const CACHE_FIRST_HOSTS = [
  'unpkg.com',
  'www.gstatic.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

const TILE_HOSTS = [
  'tile.openstreetmap.org',
  'a.tile.openstreetmap.org',
  'b.tile.openstreetmap.org',
  'c.tile.openstreetmap.org',
  'mt1.google.com', // Satellite layer — see satLayer in app.js (initAdminMap)
];

// Never touch these — let Firebase manage its own network/offline logic.
const NEVER_INTERCEPT_HOSTS = [
  'firestore.googleapis.com',
  'firebasestorage.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'www.googleapis.com',
  'firebaseinstallations.googleapis.com',
  'fcm.googleapis.com',
  'fcmregistrations.googleapis.com',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)),
      caches.open(RUNTIME_CACHE).then((cache) => cache.addAll(CRITICAL_APP_SCRIPTS)),
    ])
      .then(() => self.skipWaiting())
      .catch((err) => console.warn('[sw] precache failed', err))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names
        .filter((name) => ![SHELL_CACHE, RUNTIME_CACHE, TILE_CACHE].includes(name))
        .map((name) => caches.delete(name))
    )).then(() => self.clients.claim())
  );
});

// Let the page ask the waiting SW to activate immediately after an update.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxEntries) {
    await cache.delete(keys[0]);
    await trimCache(cacheName, maxEntries);
  }
}

const NETWORK_TIMEOUT_MS = 3000;

function networkTimeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('sw-network-timeout')), ms));
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  // Kick off the network request and let it keep running even if it
  // loses the race below — if it does eventually come back (the
  // connection was just slow, not dead), it still updates the cache for
  // next time, so "online users always get the latest deploy" still
  // holds. This only stops a slow/dead network from blocking app boot,
  // it doesn't change what happens once a response does arrive.
  const networkPromise = fetch(request).then((fresh) => {
    if (fresh && fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  });
  // Prevent an unhandled-rejection warning if the network attempt later
  // fails after we've already moved on to the cache fallback below.
  networkPromise.catch(() => {});

  try {
    return await Promise.race([networkPromise, networkTimeout(NETWORK_TIMEOUT_MS)]);
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    // last resort for a navigation with nothing cached yet
    if (request.mode === 'navigate') {
      const shellCache = await caches.open(SHELL_CACHE);
      const shell = await shellCache.match('./index.html');
      if (shell) return shell;
    }
    throw err;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh && fresh.ok) cache.put(request, fresh.clone());
  return fresh;
}

async function staleWhileRevalidate(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request).then((fresh) => {
    if (fresh && fresh.ok) {
      cache.put(request, fresh.clone());
      if (maxEntries) trimCache(cacheName, maxEntries);
    }
    return fresh;
  }).catch(() => undefined);
  return cached || (await networkPromise) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // writes always go straight to network

  const url = new URL(request.url);

  if (NEVER_INTERCEPT_HOSTS.includes(url.hostname)) return; // don't touch Firebase traffic

  // Navigations (loading/reloading the app itself)
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }

  if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(request, TILE_CACHE, TILE_CACHE_MAX));
    return;
  }

  if (CACHE_FIRST_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(request, RUNTIME_CACHE));
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request, RUNTIME_CACHE));
    return;
  }

  // Anything else: just let the network handle it normally.
});