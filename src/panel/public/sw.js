/* Push-уведомления панели BlinVPN. Показывает уведомление и по клику открывает нужный раздел. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) { d = { title: 'BlinVPN', body: event.data ? event.data.text() : '' }; }
  const url = typeof d.url === 'string' && d.url.startsWith('/') && !d.url.startsWith('//') ? d.url : '/';
  event.waitUntil(self.registration.showNotification(String(d.title || 'BlinVPN').slice(0, 120), {
    body: String(d.body || '').slice(0, 400),
    tag: d.tag ? String(d.tag).slice(0, 60) : undefined,
    icon: '/assets/logo.png',
    badge: '/assets/logo.png',
    data: { url },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin);
  if (url.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === url.origin && 'focus' in c) { await c.focus(); if ('navigate' in c) await c.navigate(url.href); return; }
    }
    await self.clients.openWindow(url.href);
  })());
});
