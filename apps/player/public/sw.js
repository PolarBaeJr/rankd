// Bumped to v5 with the icon artwork: caching is network-first, so an online
// install picks the new icons up on its own, but a cached copy of the old
// shuttlecock would still be handed back offline and to the push handler
// below, which names /icon-192.png directly.
//
// v4 dropped caches written before the /admin bypass below existed — an
// install that already cached admin responses would otherwise keep serving
// them offline.
const CACHE_NAME = 'sfu-badminton-v5';

// Network-first caching strategy (same-origin GETs only)
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // The admin console is now served same-origin at /admin (a separate
  // container), so it lands in this handler's lap. Leave it to the browser:
  // caching admin pages here would put another exec's console view in the
  // player app's cache on a shared phone, and hand it back whenever the network
  // drops.
  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return;
  // The OCR engine behind the e-transfer form: about 6 MB, fetched once when a
  // member picks a screenshot. Left to the browser's HTTP cache rather than
  // copied into this one on every install.
  if (url.pathname.startsWith('/tesseract/')) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, clone);
          });
        }
        return response;
      })
      // Offline with nothing cached, caches.match resolves undefined, and
      // handing respondWith undefined is itself an error (Safari reports it
      // as "FetchEvent.respondWith received an error"). Response.error() is
      // the plain network failure the page would have had with no worker.
      .catch(() => caches.match(event.request).then((cached) => cached || Response.error()))
  );
});

// Push notification handler
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'SFU Badminton', body: event.data.text() };
  }

  const options = {
    body: payload.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: payload.url || '/' },
    vibrate: [200, 100, 200],
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || 'SFU Badminton', options)
  );
});

// Notification click handler.
//
// This is the ONLY service worker on the origin, so it fields the admin
// console's notifications too. The console is served same-origin at /admin and
// registers no worker of its own — deliberately; apps/admin/src/app/layout.tsx
// has the full reasoning, the short version being that push_subscriptions has
// no scope column, so a second registration would deliver every member
// notification twice to any exec's phone.
//
// So a payload's `url` may point at either app, and the window we hand it to
// matters. Picking the first client, as this used to, meant an admin
// notification yanked whatever member's-app window happened to be open over to
// /admin — and a member notification did the reverse to an open console.
// Prefer a window already in the target's own section; only then fall back to
// any window, which is exactly the old behaviour.
function isAdminUrl(url) {
  const path = new URL(url, self.location.origin).pathname;
  return path === '/admin' || path.startsWith('/admin/');
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  const wantAdmin = isAdminUrl(url);

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      const sameOrigin = windowClients.filter(
        (c) => c.url.startsWith(self.location.origin) && 'focus' in c
      );
      const target =
        sameOrigin.find((c) => isAdminUrl(c.url) === wantAdmin) ?? sameOrigin[0];

      if (target) {
        target.navigate(url);
        return target.focus();
      }
      return clients.openWindow(url);
    })
  );
});

// Clean old caches on activate
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
});
