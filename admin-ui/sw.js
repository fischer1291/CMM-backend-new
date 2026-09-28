// Service worker of the admin console: shows pushes from the backend
// (lib/adminPush.js) and opens the right page when one is tapped. Nothing is
// cached: the console always needs the network anyway.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Wanna yap? Admin', body: event.data ? event.data.text() : '' };
  }
  const work = [
    self.registration.showNotification(data.title || 'Wanna yap? Admin', {
      body: data.body || '',
      tag: data.tag || undefined,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      data: { url: data.url || '' },
    }),
  ];
  // The number on the home-screen icon: what is waiting
  if (typeof data.badge === 'number' && self.navigator.setAppBadge) {
    work.push((data.badge ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge()).catch(() => {}));
  }
  event.waitUntil(Promise.all(work));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const hash = event.notification.data?.url || '';
  const target = new URL(`./${hash.startsWith('#') ? hash : ''}`, self.registration.scope).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => w.url.startsWith(self.registration.scope));
      if (open) {
        // The console follows the hash itself (app.js listens for this)
        open.postMessage({ type: 'open', hash });
        return open.focus();
      }
      return self.clients.openWindow(target);
    })(),
  );
});
